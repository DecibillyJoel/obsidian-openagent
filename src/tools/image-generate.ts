import { normalizePath, requestUrl, TFile, type App } from "obsidian";
import {
	oaDetectImageMime,
	oaImageMimeFromTarget,
	OA_MAX_IMAGE_BYTES,
	OA_MAX_IMAGES,
	OA_MAX_TOTAL_IMAGE_BYTES,
} from "../images/attachments";
import { OA_MAX_PNG_BYTES } from "../images/constants";
import {
	oaBytesToDataUrl,
	oaDecodeImageToPng,
	oaToImageUrlPart,
	oaValidateDesiredName,
} from "../images/png";
import { oaGeometryMetadata, oaImageRatioTable, oaReferenceGeometry } from "../images/geometry";
import { oaSniffImageDimensions } from "../images/mime";
import { oaSanitizeImagePrompt } from "../images/prompt";
import type { PluginSettings } from "../settings";
import type {
	ChatContentImagePart,
	ConversationImageReference,
	GeneratedImage,
	GenerationReferenceResult,
	GetConversationImages,
	ToolDef,
} from "../types";
import { defineTool, fail, ok } from "./define";

// Base64 payload cap for a generated image. This is intentionally separate from
// OA_MAX_IMAGE_BYTES (the vault image cap). The bundle accepts a larger base64
// string than the stored image cap; keep the two constants independent (Q19).
// The cap is 96 MB so that a 64 MB PNG survives base64 round-tripping.
const OA_MAX_GENERATED_BASE64_BYTES = 96 * 1024 * 1024;

// The single timeout value for this tool. It caps the tool definition and it
// aborts the images POST, so the enforced limit and the declared limit agree.
export const OA_IMAGE_GENERATION_TIMEOUT_MS = 330_000;

export interface ImageGenerateArgs {
	operation: "generate" | "edit";
	prompt: string;
	desiredName: string;
	sourceImagePaths?: string[];
	useConversationImages?: boolean;
	userRequestedAspectRatio?: string;
	userRequestedResolution?: string;
	userRequestedQuality?: string;
}

export function oaBase64ToBuffer(b64: unknown): ArrayBuffer {
	if (typeof b64 !== "string" || b64.length === 0 || b64.length > OA_MAX_GENERATED_BASE64_BYTES) {
		throw new Error("Generated image data is empty or too large");
	}
	const binary = atob(b64.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
}

export function oaExtensionForMime(mime: string | null): string | null {
	if (mime === "image/jpeg") return "jpg";
	if (mime === "image/webp") return "webp";
	if (mime === "image/gif") return "gif";
	if (mime === "image/png") return "png";
	return null;
}

export function oaSafeGeneratedStem(name: unknown): string {
	let stem = String(name ?? "").normalize("NFKC");
	stem = stem.replace(/^.*[\\/]/, "");
	stem = stem.replace(/\.[A-Za-z0-9]{1,8}$/, "");
	// eslint-disable-next-line no-control-regex -- strip Windows-invalid C0 control characters from the filename
	stem = stem.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-");
	stem = stem.replace(/[. ]+$/, "");
	stem = stem.replace(/\s+/g, " ");
	stem = stem.trim().slice(0, 100);
	if (stem.length === 0) stem = "generated-image";
	if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `image-${stem}`;
	return stem;
}

export function oaUniqueRootImagePath(app: App, desiredName: string, ext: string): string {
	const stem = oaSafeGeneratedStem(desiredName);
	const taken = new Set(app.vault.getRoot().children.map((child) => child.name.toLowerCase()));
	const candidate = `${stem}.${ext}`;
	if (!taken.has(candidate.toLowerCase())) return candidate;
	let n = 2;
	while (taken.has(`${stem}-${n}.${ext}`.toLowerCase())) n++;
	return `${stem}-${n}.${ext}`;
}

export async function oaReferenceFromVaultPath(
	app: App,
	path: string,
): Promise<ChatContentImagePart | null> {
	let normalized: string;
	try {
		normalized = normalizePath(path);
	} catch {
		return null;
	}
	const file = app.vault.getAbstractFileByPath(normalized);
	if (!(file instanceof TFile)) return null;
	const mime = oaImageMimeFromTarget(file.path);
	if (!mime) return null;
	const size = file.stat?.size ?? 0;
	const limit = mime === "image/png" ? OA_MAX_PNG_BYTES : OA_MAX_IMAGE_BYTES;
	if (size <= 0 || size > limit) return null;
	let bytes: ArrayBuffer;
	try {
		bytes = await app.vault.readBinary(file);
	} catch {
		return null;
	}
	if (oaDetectImageMime(bytes) !== mime) return null;
	let png: Uint8Array;
	try {
		png = await oaDecodeImageToPng(new Uint8Array(bytes));
	} catch {
		return null;
	}
	if (png.length === 0 || png.length > OA_MAX_PNG_BYTES) return null;
	return { type: "image_url", image_url: { url: oaBytesToDataUrl(png, "image/png") } };
}

export async function oaCollectGenerationReferences(
	app: App,
	args: Pick<ImageGenerateArgs, "sourceImagePaths" | "useConversationImages" | "operation">,
	getConversationImages?: GetConversationImages,
): Promise<GenerationReferenceResult> {
	const references: ChatContentImagePart[] = [];
	const names: string[] = [];
	const seen = new Set<string>();
	let total = 0;
	const push = (reference: ChatContentImagePart | null, name: string): void => {
		if (!reference) return;
		const url = reference.image_url.url;
		if (seen.has(url)) return;
		const size = Math.ceil((url.length * 3) / 4);
		if (total + size > OA_MAX_TOTAL_IMAGE_BYTES) {
			throw new Error("SourceImagesTooLarge: converted PNG references exceed the 64 MB limit");
		}
		seen.add(url);
		total += size;
		references.push(reference);
		names.push(name);
	};

	for (const path of args.sourceImagePaths ?? []) {
		const reference = await oaReferenceFromVaultPath(app, path);
		if (!reference) throw new Error(`SourceImageNotFoundOrUnsupported: ${path}`);
		push(reference, path);
	}

	const conversationImages = (await getConversationImages?.()) ?? [];
	const conversationName = (image: ConversationImageReference): string =>
		image.path || image.name || "conversation image";
	const addConversationImage = async (image: ConversationImageReference): Promise<void> => {
		const name = conversationName(image);
		if (typeof image.url === "string" && image.url.length > 0) {
			const part = await oaToImageUrlPart(image.url);
			if (part.error) throw new Error(part.error);
			push({ type: "image_url", image_url: { url: part.url } }, name);
		} else if (typeof image.path === "string" && image.path.length > 0) {
			push(await oaReferenceFromVaultPath(app, image.path), name);
		}
	};

	if (args.useConversationImages === true) {
		for (const image of conversationImages) await addConversationImage(image);
	} else if (
		args.operation === "edit" &&
		args.useConversationImages !== false &&
		references.length === 0
	) {
		// Automatic edit source: newest usable conversation image only.
		for (const image of [...conversationImages].reverse()) {
			await addConversationImage(image);
			if (references.length > 0) break;
		}
	}

	const trimmedReferences = references.slice(0, OA_MAX_IMAGES);
	const trimmedNames = names.slice(0, OA_MAX_IMAGES);
	if (args.operation === "edit" && trimmedReferences.length === 0) {
		throw new Error(
			"SourceImageRequired: editing requires sourceImagePaths or a usable image already shown/attached in this conversation",
		);
	}
	return { references: trimmedReferences, names: trimmedNames };
}

export function oaSanitizeGeneratedImages(value: unknown): GeneratedImage[] {
	if (!Array.isArray(value)) return [];
	const images: GeneratedImage[] = [];
	for (const item of value) {
		if (images.length >= 32) break;
		if (!item || typeof item !== "object") continue;
		const record = item as {
			path?: unknown;
			prompt?: unknown;
			model?: unknown;
			source?: unknown;
			referenceImageNames?: unknown;
		};
		const path = typeof record.path === "string" ? record.path : "";
		if (path.length === 0 || path.includes("/") || path.includes("\\")) continue;
		if (!oaImageMimeFromTarget(path)) continue;
		const referenceImageNames = Array.isArray(record.referenceImageNames)
			? record.referenceImageNames
					.filter((name): name is string => typeof name === "string" && !name.startsWith("data:"))
					.slice(0, OA_MAX_IMAGES)
			: [];
		images.push({
			path,
			prompt: typeof record.prompt === "string" ? record.prompt : "",
			model: typeof record.model === "string" ? record.model : "",
			...(record.source === "vault" ? { source: "vault" as const } : {}),
			...(referenceImageNames.length > 0 ? { referenceImageNames } : {}),
		});
	}
	return images;
}

export function openAgentImageGenerateTool(
	app: App,
	getSettings: () => PluginSettings,
): ToolDef<ImageGenerateArgs> {
	return defineTool<ImageGenerateArgs>({
		name: "image_generate",
		description:
			"Generate or edit one PNG image, save it at the vault root, and attach it to this chat. Quality defaults to `high`. For edits, preserve source geometry by OMITTING the geometry override fields. The tool automatically chooses the closest supported ratio and resolution to the first source image; without a source it uses 1:1 and 1K. `userRequestedAspectRatio`, `userRequestedResolution`, and `userRequestedQuality` are strict overrides: include one only when the USER EXPLICITLY requested that exact technical change. Omit userRequestedQuality for the default high quality. Never populate geometry overrides merely to improve quality or completeness. Supplied overrides are honored exactly. The result reports exact dimensions, exact reduced aspectRatio, nearestSupportedAspectRatio, and resolution tier. The prompt must contain only concise visual instructions. All source and output images are normalized to PNG. desiredName must omit its extension or end in `.png`. Refer to sources only by order (`the first image`, `the second image`). This tool runs without approval; a failure ends the current agent run.",
		category: "vault_write",
		mutates: true,
		requiresApproval: false,
		stopOnFailure: true,
		timeoutMs: OA_IMAGE_GENERATION_TIMEOUT_MS,
		schema: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					enum: ["generate", "edit"],
					description:
						"Validate this before calling: use `edit` when modifying, restyling, reframing, or deriving from an existing image; use `generate` only for a new image that needs no source.",
				},
				prompt: {
					type: "string",
					description:
						"Concise visual instructions only. Say what to create or change and what visible qualities to preserve. Do not include lore, rationale, filenames, image titles, or long descriptions of what the supplied images already show. Refer to sources numerically, such as `the first image` or `the second image`.",
					minLength: 1,
					maxLength: 4000,
				},
				desiredName: {
					type: "string",
						description:
							"Desired PNG filename, for example `Nora mountain portrait.png`, or a filename without an extension. Any explicit non-PNG extension is invalid.",
					minLength: 1,
					maxLength: 160,
				},
				sourceImagePaths: {
					type: "array",
					items: { type: "string" },
					description:
						"Ordered vault-relative source paths. This order defines `the first image`, `the second image`, etc. Paths identify attachments but must never be repeated inside prompt.",
				},
				useConversationImages: {
					type: "boolean",
					description:
						"True sends all recent conversation images; false forbids automatic selection. When omitted for operation=edit with no explicit sourceImagePaths, the most recent usable conversation image is attached automatically. Before relying on conversation images, inspect them yourself and verify that the selected image(s) are the intended sources.",
				},
				userRequestedAspectRatio: {
					type: "string",
					enum: oaImageRatioTable.map(([label]) => label),
					description:
						"STRICT USER OVERRIDE. Include only if the user's message explicitly requests this ratio or an explicit crop to it. Otherwise omit so source geometry is preserved. The tool honors a supplied value exactly.",
				},
				userRequestedResolution: {
					type: "string",
					enum: ["512", "1K", "2K", "4K"],
					description:
						"STRICT USER OVERRIDE. Include only if the user's message explicitly requests this resolution tier or corresponding pixel dimensions. Otherwise omit so the closest source resolution is preserved. Never select 4K merely for quality. The tool honors a supplied value exactly.",
				},
				userRequestedQuality: {
					type: "string",
					enum: ["auto", "low", "medium", "high"],
					description:
						"Optional strict user override for the named quality setting. The default is `high`, so omit this field unless the user explicitly requests `auto`, `low`, or `medium`. The tool honors a supplied value exactly.",
				},
			},
			required: ["operation", "prompt", "desiredName"],
			// Kept as inferred from the bundle: the tool rejects unknown arguments (Q16).
			additionalProperties: false,
		},
		async run(args, ctx) {
			if (ctx.signal?.aborted) return fail("ImageGenerationAborted");
			const rejected = ["aspectRatio", "resolution", "quality"].filter((key) =>
				Object.prototype.hasOwnProperty.call(args, key),
			);
			if (rejected.length > 0) {
				return fail(
					`InvalidTechnicalParameter: ${rejected.join(", ")} ${rejected.length === 1 ? "is" : "are"} not valid. Use the corresponding userRequested* field only for an explicit user request; otherwise omit it for automatic source preservation.`,
				);
			}
			const nameError = oaValidateDesiredName(args.desiredName);
			if (nameError) return fail(nameError);

			const settings = getSettings();
			const model = (await ctx.getImageModel?.())?.trim() || settings.imageModel?.trim();
			if (!model) {
				return fail("ImageModelNotConfigured: choose an Image generation model in OpenAgent settings.");
			}

			let references: ChatContentImagePart[];
			let referenceImageNames: string[];
			try {
				({ references, names: referenceImageNames } = await oaCollectGenerationReferences(
					app,
					args,
					ctx.getConversationImages,
				));
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}

			const prompt = oaSanitizeImagePrompt(args.prompt, referenceImageNames).trim();
			const geometry = oaReferenceGeometry(references);
			const ratio = args.userRequestedAspectRatio || geometry.aspectRatio;
			const resolution = args.userRequestedResolution || geometry.resolution;

			const baseUrl = settings.baseUrl.replace(/\/$/, "");
			const body: Record<string, unknown> = {
				model,
				prompt,
				aspect_ratio: ratio,
				resolution,
				output_format: "png",
			};
			// `input_references` is a gateway-specific extension, not an OpenAI Images API field (Q17).
			if (references.length > 0) body.input_references = references;
			body.quality = args.userRequestedQuality || "high";

			let response: { status: number; text: string };
			if (ctx.signal?.aborted) return fail("ImageGenerationAborted");
			// The bundle always posts to `${baseUrl}/images` with no query parameters and no
			// provider-specific branch. This assumes an OpenAI-compatible gateway (Q18).
			const url = `${baseUrl}/images`;
			const headers = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${settings.apiKey}`,
			};
			const requestBody = JSON.stringify(body);
			// The harness timeout only rejects its race; it never aborts the caller signal.
			// This controller links the caller signal to the request and enforces the same
			// limit, so a timed-out request stops instead of writing a stray file later.
			const controller = new AbortController();
			let timedOut = false;
			const timeoutFailure = `ImageGenerationTimeout: image generation exceeded ${OA_IMAGE_GENERATION_TIMEOUT_MS / 1000} seconds`;
			const onCallerAbort = () => controller.abort();
			ctx.signal?.addEventListener("abort", onCallerAbort);
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, OA_IMAGE_GENERATION_TIMEOUT_MS);
			try {
				if (typeof fetch === "function") {
					const res = await fetch(url, {
						method: "POST",
						headers,
						body: requestBody,
						signal: controller.signal,
					});
					response = { status: res.status, text: await res.text() };
				} else {
					// `requestUrl` accepts no signal, so this branch cannot cancel the in-flight
					// request. A response that arrives after the deadline is rejected below.
					const res = await requestUrl({ url, method: "POST", headers, body: requestBody, throw: false });
					response = { status: res.status, text: res.text };
				}
			} catch (err) {
				if (ctx.signal?.aborted) return fail("ImageGenerationAborted");
				if (timedOut) return fail(timeoutFailure);
				return fail(`ImageGenerationNetworkError: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				clearTimeout(timer);
				ctx.signal?.removeEventListener("abort", onCallerAbort);
			}

			if (response.status >= 400) {
				return fail(`ImageGenerationProviderError: HTTP ${response.status}: ${response.text.slice(0, 500)}`);
			}
			if (ctx.signal?.aborted) return fail("ImageGenerationAborted");
			if (timedOut) return fail(timeoutFailure);

			let parsed: { data?: unknown };
			try {
				parsed = JSON.parse(response.text) as { data?: unknown };
			} catch {
				return fail("ImageGenerationProviderError: malformed JSON response");
			}
			const data = Array.isArray(parsed?.data) ? parsed.data : [];
			const first = data[0] as { b64_json?: unknown } | undefined;
			const b64 = first && typeof first.b64_json === "string" ? first.b64_json : "";

			let bytes: Uint8Array;
			try {
				bytes = new Uint8Array(oaBase64ToBuffer(b64));
			} catch (err) {
				return fail(`ImageGenerationProviderError: ${err instanceof Error ? err.message : String(err)}`);
			}

			const mime = oaDetectImageMime(bytes);
			if (!mime) return fail("ImageGenerationProviderError: unsupported or invalid generated image bytes");

			let png: Uint8Array;
			try {
				png = await oaDecodeImageToPng(bytes);
			} catch (err) {
				return fail(
					`ImageGenerationProviderError: could not convert returned ${mime} image to PNG: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			if (oaDetectImageMime(png) !== "image/png") {
				return fail("ImageGenerationProviderError: PNG conversion returned invalid bytes");
			}
			if (png.length === 0 || png.length > OA_MAX_PNG_BYTES) {
				return fail("ImageGenerationProviderError: converted PNG exceeds the 64 MB image limit");
			}

			if (ctx.signal?.aborted) return fail("ImageGenerationAborted");

			let path = oaUniqueRootImagePath(app, args.desiredName, "png");
			try {
				await app.vault.createBinary(path, png.buffer as ArrayBuffer);
			} catch (err) {
				if (app.vault.getAbstractFileByPath(path)) {
					path = oaUniqueRootImagePath(app, args.desiredName, "png");
					try {
						await app.vault.createBinary(path, png.buffer as ArrayBuffer);
					} catch (retryErr) {
						return fail(`ImageSaveError: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
					}
				} else {
					return fail(`ImageSaveError: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			return ok({
				path,
				markdownEmbed: `![[${path}]]`,
				mimeType: "image/png",
				size: png.byteLength,
				model,
				operation: args.operation,
				referenceImageNames,
				referenceImagesUsed: references.length,
				prompt,
				...oaGeometryMetadata(oaSniffImageDimensions(png), "image/png"),
			});
		},
	});
}
