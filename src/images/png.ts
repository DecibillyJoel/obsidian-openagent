import { requestUrl } from "obsidian";
import type { ChatContentImagePart } from "../types";
import {
	OA_IMAGE_MIMES,
	OA_MAX_IMAGE_BYTES,
	OA_MAX_PNG_BYTES,
} from "./constants";
import { oaBufferToDataUrl, oaDataUrlToBytes } from "./data-url";
import { oaSniffImageDimensions } from "./mime";

const DATA_URL_IMAGE_PATTERN = /^data:image\/[^;,]+;base64,([\s\S]+)$/i;
const DESIRED_NAME_PATTERN = /\.([A-Za-z0-9]{1,8})$/;

// Pixel-count cap applied from the header, before any decoder allocates a buffer.
// The value matches the region tool limit, so one image is never decodable in one
// path and refused in the other.
export const OA_MAX_DECODE_PIXELS = 40 * 1024 * 1024;

/** Thrown when an image declares more pixels than the pre-decode limit allows. */
export class PixelLimitError extends Error {
	constructor(width: number, height: number) {
		super(`ImageDimensionsTooLarge: ${width}x${height} exceeds the 40 megapixel processing limit`);
		this.name = "PixelLimitError";
	}
}

function oaAssertPixelLimit(width: number, height: number): void {
	if (width * height > OA_MAX_DECODE_PIXELS) throw new PixelLimitError(width, height);
}

const CANVAS_CONTEXT_ERROR = "PNG conversion could not create a canvas context";
const CANVAS_BLOB_ERROR = "Canvas did not produce PNG data";
const CONVERSION_UNAVAILABLE_ERROR = "PNG conversion is unavailable in this environment";
const UNSUPPORTED_BYTES_ERROR = "Unsupported image bytes; expected PNG, JPEG, WebP, or GIF";
const DECODE_FAILED_ERROR = "Could not decode image for PNG conversion";

export function oaMimeFromBytes(bytes: Uint8Array | ArrayBuffer): string | null {
	const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (
		data.length >= 8 &&
		data[0] === 0x89 &&
		data[1] === 0x50 &&
		data[2] === 0x4e &&
		data[3] === 0x47 &&
		data[4] === 0x0d &&
		data[5] === 0x0a &&
		data[6] === 0x1a &&
		data[7] === 0x0a
	) {
		return "image/png";
	}
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		data.length >= 12 &&
		data[0] === 0x52 &&
		data[1] === 0x49 &&
		data[2] === 0x46 &&
		data[3] === 0x46 &&
		data[8] === 0x57 &&
		data[9] === 0x45 &&
		data[10] === 0x42 &&
		data[11] === 0x50
	) {
		return "image/webp";
	}
	if (data.length >= 6) {
		const header = String.fromCharCode(data[0], data[1], data[2], data[3], data[4], data[5]);
		if (header === "GIF87a" || header === "GIF89a") return "image/gif";
	}
	return null;
}

export function oaBytesToDataUrl(bytes: Uint8Array, mime: string): string {
	return oaBufferToDataUrl(bytes, mime);
}

export async function oaBytesToPng(
	bitmap: CanvasImageSource,
	width: number,
	height: number,
): Promise<Uint8Array> {
	oaAssertPixelLimit(width, height);
	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error(CANVAS_CONTEXT_ERROR);
		context.drawImage(bitmap, 0, 0);
		const blob = await canvas.convertToBlob({ type: "image/png" });
		if (!blob) throw new Error(CANVAS_BLOB_ERROR);
		return new Uint8Array(await blob.arrayBuffer());
	}
	if (typeof document === "undefined") throw new Error(CONVERSION_UNAVAILABLE_ERROR);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error(CANVAS_CONTEXT_ERROR);
	context.drawImage(bitmap, 0, 0);
	const blob = await new Promise<Blob | null>((resolve) => {
		canvas.toBlob(resolve, "image/png");
	});
	if (!blob) throw new Error(CANVAS_BLOB_ERROR);
	return new Uint8Array(await blob.arrayBuffer());
}

interface OaDecodedImage {
	source: CanvasImageSource;
	width: number;
	height: number;
}

// TypeScript 5.7 types Uint8Array over ArrayBufferLike; a Blob accepts the
// concrete view at runtime, so narrow the part without copying the payload.
function oaBlobPart(bytes: Uint8Array): BlobPart {
	return bytes as unknown as BlobPart;
}

function oaLoadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(DECODE_FAILED_ERROR));
		image.src = url;
	});
}

async function oaDecodeImageSource(bytes: Uint8Array): Promise<OaDecodedImage | null> {
	if (typeof createImageBitmap === "function") {
		try {
			const bitmap = await createImageBitmap(new Blob([oaBlobPart(bytes)]));
			return { source: bitmap, width: bitmap.width, height: bitmap.height };
		} catch {
			// Fall through to the Image element path.
		}
	}
	if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
		return null;
	}
	const objectUrl = URL.createObjectURL(new Blob([oaBlobPart(bytes)]));
	try {
		const image = await oaLoadImage(objectUrl);
		return { source: image, width: image.naturalWidth, height: image.naturalHeight };
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

export async function oaDecodeImageToPng(bytes: Uint8Array): Promise<Uint8Array> {
	// Refuse a decompression bomb from the header, before the decoder allocates pixels.
	// An unsniffable format yields no dimensions, so it decodes as before.
	const dimensions = oaSniffImageDimensions(bytes);
	if (dimensions) oaAssertPixelLimit(dimensions.width, dimensions.height);
	const mime = oaMimeFromBytes(bytes);
	if (mime === "image/png") return bytes;
	if (!mime || !OA_IMAGE_MIMES.has(mime)) throw new Error(UNSUPPORTED_BYTES_ERROR);
	const decoded = await oaDecodeImageSource(bytes);
	if (!decoded) throw new Error(DECODE_FAILED_ERROR);
	return oaBytesToPng(decoded.source, decoded.width, decoded.height);
}

export async function oaImageUrlToPngDataUrl(url: string): Promise<string> {
	let bytes: Uint8Array;
	if (typeof url === "string" && DATA_URL_IMAGE_PATTERN.test(url)) {
		const decoded = oaDataUrlToBytes(url);
		if (!decoded || decoded.length === 0) throw new Error("Invalid image data URL");
		bytes = decoded;
	} else if (typeof url === "string" && url.startsWith("https://")) {
		const response = await requestUrl({ url, method: "GET", throw: false });
		if (response.status >= 400) throw new Error(`Could not download image: HTTP ${response.status}`);
		bytes = new Uint8Array(response.arrayBuffer);
	} else {
		throw new Error("Unsupported image URL");
	}
	if (bytes.length === 0) throw new Error("Image is empty");
	const mime = oaMimeFromBytes(bytes);
	if (mime === "image/png") {
		if (bytes.length > OA_MAX_PNG_BYTES) {
			throw new Error("PNG image exceeds the 64 MB internal image limit");
		}
	} else if (bytes.length > OA_MAX_IMAGE_BYTES) {
		throw new Error("Source image exceeds the 10 MB input limit");
	}
	const png = await oaDecodeImageToPng(bytes);
	if (png.length === 0 || png.length > OA_MAX_PNG_BYTES) {
		throw new Error("Converted PNG is empty or exceeds the 64 MB total image limit");
	}
	return oaBytesToDataUrl(png, "image/png");
}

export async function oaToImageUrlPart(url: string): Promise<ChatContentImagePart | null> {
	try {
		return { type: "image_url", image_url: { url: await oaImageUrlToPngDataUrl(url) } };
	} catch {
		return null;
	}
}

export function oaValidateDesiredName(name: string): string | null {
	const match = DESIRED_NAME_PATTERN.exec(String(name ?? ""));
	if (!match) return null;
	if ((match[1] ?? "").toLowerCase() === "png") return null;
	return `InvalidImageFilename: desiredName must omit the extension or end in .png, not .${match[1]}`;
}
