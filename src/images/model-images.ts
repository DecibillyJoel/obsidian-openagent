import { requestUrl, type App } from "obsidian";
import type { GeneratedImage } from "../types";
import { oaBase64ToBuffer, oaUniqueRootImagePath } from "../tools/image-generate";
import { oaDetectImageMime } from "./attachments";
import { oaDecodeImageToPng } from "./png";

const OA_MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;

// Save an image the chat model returned inline, either as a data URL or an https link.
export async function oaPersistInlineModelImage(
	app: App,
	url: string,
	prompt: string,
	model: string,
): Promise<GeneratedImage> {
	let bytes: ArrayBuffer;
	if (url.startsWith("data:image/")) {
		const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(url);
		if (!match) throw new Error("Invalid inline image data URL");
		bytes = oaBase64ToBuffer(match[2]);
	} else if (url.startsWith("https://")) {
		const res = await requestUrl({ url, method: "GET", throw: false });
		if (res.status >= 400) throw new Error(`Could not download inline image: HTTP ${res.status}`);
		bytes = res.arrayBuffer;
	} else {
		throw new Error("Unsupported inline image URL");
	}
	if (!(bytes instanceof ArrayBuffer) || bytes.byteLength <= 0 || bytes.byteLength > OA_MAX_INLINE_IMAGE_BYTES) {
		throw new Error("Inline image is empty or exceeds 32 MB");
	}
	const mime = oaDetectImageMime(bytes);
	if (!mime) throw new Error("Inline image bytes are not PNG, JPEG, WebP, or GIF");
	// The recovered build always stores the inline image as a PNG, converting other formats first.
	const png = await oaDecodeImageToPng(new Uint8Array(bytes));
	if (oaDetectImageMime(png) !== "image/png") throw new Error("PNG conversion returned invalid bytes");
	const path = oaUniqueRootImagePath(app, "model-response", "png");
	await app.vault.createBinary(path, png.buffer as ArrayBuffer);
	return { path, prompt, model };
}
