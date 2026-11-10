import { TFile, type App } from "obsidian";
import { oaDetectImageMime, oaImageMimeFromTarget } from "../images/attachments";
import { OA_MAX_IMAGE_BYTES, OA_MAX_PNG_BYTES } from "../images/constants";
import { oaGeometryMetadata } from "../images/geometry";
import { oaSniffImageDimensions } from "../images/mime";
import { oaValidateDesiredName } from "../images/png";
import type { JsonSchemaProperty, ToolDef } from "../types";
import { defineTool, fail, ok } from "./define";
import { oaUniqueRootImagePath } from "./image-generate";
import { PathError, safeVaultPath } from "./vault/path-safe";

// Pixel-count cap for both the decoded source and the rendered output.
const OA_MAX_REGION_PIXELS = 40 * 1024 * 1024;

// Omitted colour defaults to opaque green.
const OA_DEFAULT_HEX_COLOR = "#00FF00";

export interface ImageRegionArgs {
	sourceImagePath: string;
	left: number;
	top: number;
	right: number;
	bottom: number;
	desiredName: string;
	hexColor?: string;
}

export interface ImageRegionBounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

interface OaRegionSource {
	path: string;
	mimeType: string;
	bytes: ArrayBuffer;
}

interface OaDecodedRegionSource {
	image: CanvasImageSource;
	width: number;
	height: number;
	release: () => void;
}

interface OaRenderedRegion {
	bytes: ArrayBuffer;
	region: ImageRegionBounds;
	width: number;
	height: number;
}

type OaRegionRenderOptions = { kind: "snip" } | { kind: "blot"; color: string };

export function oaNormalizeHexColor(value: unknown): string | null {
	const raw = String(value ?? OA_DEFAULT_HEX_COLOR).trim();
	if (!/^#?[0-9a-f]{6}$/i.test(raw)) return null;
	return raw.startsWith("#") ? raw : `#${raw}`;
}

export function oaValidateRegionBounds(
	args: Pick<ImageRegionArgs, "left" | "top" | "right" | "bottom">,
	imageWidth: number,
	imageHeight: number,
): ImageRegionBounds {
	const edges: ReadonlyArray<readonly [string, number]> = [
		["left", args.left],
		["top", args.top],
		["right", args.right],
		["bottom", args.bottom],
	];
	for (const [name, value] of edges) {
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(`InvalidCoordinates: ${name} must be a non-negative integer`);
		}
	}
	if (args.right <= args.left || args.bottom <= args.top) {
		throw new Error("InvalidRegion: right must be greater than left and bottom must be greater than top");
	}
	if (args.right > imageWidth || args.bottom > imageHeight) {
		throw new Error(
			`RegionOutOfBounds: region (${args.left}, ${args.top})-(${args.right}, ${args.bottom}) exceeds ${imageWidth}x${imageHeight} image bounds`,
		);
	}
	return {
		left: args.left,
		top: args.top,
		right: args.right,
		bottom: args.bottom,
		width: args.right - args.left,
		height: args.bottom - args.top,
	};
}

async function oaResolveRegionSource(app: App, target: string): Promise<OaRegionSource> {
	let path = String(target ?? "")
		.trim()
		.replace(/^!??\[\[|\]\]$/g, "")
		.split("|")[0]
		.trim();
	try {
		path = safeVaultPath(path);
	} catch (err) {
		throw err instanceof PathError ? new Error(`PathError: ${err.message}`) : err;
	}
	let file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		file = app.metadataCache.getFirstLinkpathDest(path, "");
	}
	if (!(file instanceof TFile)) throw new Error(`SourceImageNotFound: ${path}`);
	const mimeType = oaImageMimeFromTarget(file.path);
	if (!mimeType) throw new Error(`UnsupportedImage: ${file.path}. Use PNG, JPEG, WebP, or GIF.`);
	const size = file.stat?.size ?? 0;
	const limit = mimeType === "image/png" ? OA_MAX_PNG_BYTES : OA_MAX_IMAGE_BYTES;
	if (size <= 0 || size > limit) {
		throw new Error(
			`ImageTooLarge: ${file.path} exceeds the ${mimeType === "image/png" ? "64" : "10"} MB processing limit`,
		);
	}
	const bytes = await app.vault.readBinary(file);
	if (bytes.byteLength <= 0 || bytes.byteLength > limit || oaDetectImageMime(bytes) !== mimeType) {
		throw new Error(`InvalidImage: ${file.path}`);
	}
	return { path: file.path, mimeType, bytes };
}

async function oaDecodeRegionSource(bytes: ArrayBuffer, mimeType: string): Promise<OaDecodedRegionSource> {
	const blob = new Blob([bytes], { type: mimeType });
	if (typeof createImageBitmap !== "undefined") {
		const bitmap = await createImageBitmap(blob);
		return {
			image: bitmap,
			width: bitmap.width,
			height: bitmap.height,
			release: () => bitmap.close?.(),
		};
	}
	if (typeof document === "undefined" || typeof URL === "undefined") {
		throw new Error("Image processing is unavailable in this environment");
	}
	const url = URL.createObjectURL(blob);
	try {
		const image = await new Promise<HTMLImageElement>((resolve, reject) => {
			const element = document.createElement("img");
			element.onload = () => resolve(element);
			element.onerror = () => reject(new Error("Could not decode the source image"));
			element.src = url;
		});
		return {
			image,
			width: image.naturalWidth || image.width,
			height: image.naturalHeight || image.height,
			release: () => URL.revokeObjectURL(url),
		};
	} catch (err) {
		URL.revokeObjectURL(url);
		throw err;
	}
}

function oaCreateCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
	if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
	if (typeof document === "undefined") {
		throw new Error("Image processing is unavailable in this environment");
	}
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

async function oaEncodeCanvasPng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<ArrayBuffer> {
	if (typeof (canvas as OffscreenCanvas).convertToBlob === "function") {
		const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: "image/png" });
		return blob.arrayBuffer();
	}
	if (typeof (canvas as HTMLCanvasElement).toBlob !== "function") {
		throw new Error("Canvas cannot encode PNG output");
	}
	const blob = await new Promise<Blob>((resolve, reject) => {
		(canvas as HTMLCanvasElement).toBlob(
			(result) => (result ? resolve(result) : reject(new Error("Canvas did not produce PNG data"))),
			"image/png",
		);
	});
	return blob.arrayBuffer();
}

async function oaRenderRegion(
	source: OaRegionSource,
	args: Pick<ImageRegionArgs, "left" | "top" | "right" | "bottom">,
	options: OaRegionRenderOptions,
): Promise<OaRenderedRegion> {
	// Refuse a decompression bomb from the header, before the decoder allocates pixels.
	// An unsniffable source falls back to the post-decode check below.
	const sniffed = oaSniffImageDimensions(new Uint8Array(source.bytes));
	if (sniffed && sniffed.width * sniffed.height > OA_MAX_REGION_PIXELS) {
		throw new Error(
			`ImageDimensionsTooLarge: ${sniffed.width}x${sniffed.height} exceeds the 40 megapixel processing limit`,
		);
	}
	const decoded = await oaDecodeRegionSource(source.bytes, source.mimeType);
	try {
		if (decoded.width <= 0 || decoded.height <= 0 || decoded.width * decoded.height > OA_MAX_REGION_PIXELS) {
			throw new Error(
				`ImageDimensionsTooLarge: ${decoded.width}x${decoded.height} exceeds the 40 megapixel processing limit`,
			);
		}
		const region = oaValidateRegionBounds(args, decoded.width, decoded.height);
		const width = options.kind === "snip" ? region.width : decoded.width;
		const height = options.kind === "snip" ? region.height : decoded.height;
		if (width * height > OA_MAX_REGION_PIXELS) {
			throw new Error(
				`OutputDimensionsTooLarge: ${width}x${height} exceeds the 40 megapixel processing limit`,
			);
		}
		const canvas = oaCreateCanvas(width, height);
		const context = (canvas as OffscreenCanvas).getContext("2d") as
			| OffscreenCanvasRenderingContext2D
			| CanvasRenderingContext2D
			| null;
		if (!context) throw new Error("Image processing could not create a canvas context");
		const ctx = context as CanvasRenderingContext2D;
		if (options.kind === "snip") {
			ctx.drawImage(
				decoded.image,
				region.left,
				region.top,
				region.width,
				region.height,
				0,
				0,
				region.width,
				region.height,
			);
		} else {
			ctx.drawImage(decoded.image, 0, 0);
			ctx.fillStyle = options.color;
			ctx.fillRect(region.left, region.top, region.width, region.height);
		}
		const bytes = await oaEncodeCanvasPng(canvas);
		if (bytes.byteLength <= 0 || bytes.byteLength > OA_MAX_PNG_BYTES || oaDetectImageMime(bytes) !== "image/png") {
			throw new Error("Image processing returned invalid or oversized PNG data");
		}
		return { bytes, region, width, height };
	} finally {
		decoded.release();
	}
}

const IMAGE_SNIP_DESCRIPTION =
	"Crop an existing vault image to an exact pixel region and save the crop as a new PNG at the vault root. Coordinates are pixel edges: left/top are inclusive and right/bottom are exclusive. The region must be ordered and entirely inside the source image. Supports PNG, JPEG, WebP, and GIF sources; an animated GIF is processed as a still frame. desiredName must omit its extension or end in `.png`. Existing files are never overwritten.";

const IMAGE_BLOT_DESCRIPTION =
	"Draw an opaque filled rectangle over an exact pixel region of an existing vault image and save the full-size result as a new PNG at the vault root. Coordinates are pixel edges: left/top are inclusive and right/bottom are exclusive. The region must be ordered and entirely inside the source image. hexColor accepts six hexadecimal digits with an optional `#` and defaults to green (`#00FF00`). Supports PNG, JPEG, WebP, and GIF sources; an animated GIF is processed as a still frame. desiredName must omit its extension or end in `.png`. Existing files are never overwritten.";

export function openAgentImageRegionTool(app: App, kind: "snip" | "blot"): ToolDef<ImageRegionArgs> {
	const isSnip = kind === "snip";
	const hexColorProperty = {
		type: "string",
		pattern: "^#?[0-9A-Fa-f]{6}$",
		description:
			"Optional opaque rectangle color as six hex digits, with or without `#`. Default: `#00FF00` (green).",
	} as JsonSchemaProperty & { pattern: string };
	return defineTool<ImageRegionArgs>({
		name: isSnip ? "image_snip" : "image_blot",
		description: isSnip ? IMAGE_SNIP_DESCRIPTION : IMAGE_BLOT_DESCRIPTION,
		category: "vault_write",
		mutates: true,
		timeoutMs: 120000,
		schema: {
			type: "object",
			properties: {
				sourceImagePath: {
					type: "string",
					minLength: 1,
					description:
						"Exact vault-relative source image path, including its extension. Obsidian wikilink syntax is also accepted.",
				},
				left: {
					type: "integer",
					minimum: 0,
					description: "Left pixel edge of the region (inclusive).",
				},
				top: {
					type: "integer",
					minimum: 0,
					description: "Top pixel edge of the region (inclusive).",
				},
				right: {
					type: "integer",
					minimum: 1,
					description: "Right pixel edge of the region (exclusive).",
				},
				bottom: {
					type: "integer",
					minimum: 1,
					description: "Bottom pixel edge of the region (exclusive).",
				},
				desiredName: {
					type: "string",
					minLength: 1,
					maxLength: 120,
					description:
						"Filename stem for the new vault-root PNG. Omit the extension or use `.png`; a numeric suffix is added on collision.",
				},
				...(isSnip ? {} : { hexColor: hexColorProperty }),
			},
			required: ["sourceImagePath", "left", "top", "right", "bottom", "desiredName"],
			additionalProperties: false,
		},
		async run(args, ctx) {
			const nameError = oaValidateDesiredName(args.desiredName);
			if (nameError) return fail(nameError);
			const color = isSnip ? null : oaNormalizeHexColor(args.hexColor);
			if (!isSnip && !color) {
				return fail("InvalidHexColor: hexColor must contain exactly six hexadecimal digits, with an optional leading #");
			}

			// Abort before source resolution and rendering: a cancelled call must not read,
			// render, or encode the source, and must report the abort rather than a path error.
			if (ctx.signal?.aborted) return fail("ImageRegionAborted");

			let source: OaRegionSource;
			try {
				source = await oaResolveRegionSource(app, args.sourceImagePath);
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}

			let rendered: OaRenderedRegion;
			try {
				rendered = await oaRenderRegion(
					source,
					args,
					isSnip ? { kind: "snip" } : { kind: "blot", color: color as string },
				);
			} catch (err) {
				return fail(`ImageProcessingError: ${err instanceof Error ? err.message : String(err)}`);
			}

			if (ctx.signal?.aborted) return fail("ImageRegionAborted");

			let path = oaUniqueRootImagePath(app, args.desiredName, "png");
			try {
				await app.vault.createBinary(path, rendered.bytes);
			} catch (err) {
				if (!app.vault.getAbstractFileByPath(path)) {
					return fail(`ImageSaveError: ${err instanceof Error ? err.message : String(err)}`);
				}
				path = oaUniqueRootImagePath(app, args.desiredName, "png");
				try {
					await app.vault.createBinary(path, rendered.bytes);
				} catch (retryErr) {
					return fail(`ImageSaveError: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
				}
			}

			return ok({
				path,
				markdownEmbed: `![[${path}]]`,
				mimeType: "image/png",
				size: rendered.bytes.byteLength,
				...oaGeometryMetadata(oaSniffImageDimensions(new Uint8Array(rendered.bytes)), "image/png"),
				sourcePath: source.path,
				region: rendered.region,
				operation: isSnip ? "snip" : "blot",
				...(isSnip ? {} : { hexColor: color as string }),
			});
		},
	});
}
