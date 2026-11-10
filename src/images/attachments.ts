import { TFile, type App } from "obsidian";
import type { ChatContentPart, ToolResult } from "../types";
import {
	OA_IMAGE_MIMES,
	OA_MAX_IMAGE_BYTES,
	OA_MAX_IMAGES,
	OA_MAX_PNG_BYTES,
	OA_MAX_TOTAL_IMAGE_BYTES,
} from "./constants";
import { oaDataUrlLength } from "./data-url";
import {
	oaBytesToDataUrl,
	oaDecodeImageToPng,
	oaImageUrlToPngDataUrl,
	oaMimeFromBytes,
} from "./png";

export {
	OA_IMAGE_MIMES,
	OA_MAX_IMAGE_BYTES,
	OA_MAX_IMAGES,
	OA_MAX_PNG_BYTES,
	OA_MAX_TOTAL_IMAGE_BYTES,
} from "./constants";

export const OA_MAX_DATA_URL_BYTES = 24 * 1024 * 1024;
// This cap measures base64 text length, not raw PNG bytes.
// 24 MiB of base64 text holds about 18 MiB of PNG bytes.
// That is about a third less than the 64 MiB in OA_MAX_PNG_BYTES.
// Raising either constant alone does not raise the effective per-image limit.

export interface PendingImage {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	url: string;
}

export type ResolveToolImages = (name: string, result: ToolResult) => Promise<PendingImage[]>;

export interface ToolImageTarget {
	target: string;
	sourcePath: string;
}

export function oaDetectImageMime(bytes: Uint8Array | ArrayBuffer): string | null {
	return oaMimeFromBytes(bytes);
}

export function oaMultimodalContent(
	text: string,
	images?: PendingImage[] | null,
): string | ChatContentPart[] {
	const usable = (images ?? []).filter((image) => typeof image?.url === "string" && image.url.length > 0);
	if (usable.length === 0) return text;
	return [
		{ type: "text", text: text || "Please analyze the attached image(s)." },
		...usable.map((image) => ({ type: "image_url" as const, image_url: { url: image.url } })),
	];
}

export function oaSanitizeImages(value: unknown): PendingImage[] {
	if (!Array.isArray(value)) return [];
	const images: PendingImage[] = [];
	let total = 0;
	for (const item of value) {
		if (images.length >= OA_MAX_IMAGES) break;
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (typeof record.name !== "string") continue;
		const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
		const url = typeof record.url === "string" ? record.url : "";
		const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0;
		if (!OA_IMAGE_MIMES.has(mimeType)) continue;
		if (!url.startsWith(`data:${mimeType};base64,`)) continue;
		if (url.length > OA_MAX_DATA_URL_BYTES) continue;
		const limit = mimeType === "image/png" ? OA_MAX_PNG_BYTES : OA_MAX_IMAGE_BYTES;
		if (size <= 0 || size > limit) continue;
		if (total + size > OA_MAX_TOTAL_IMAGE_BYTES) continue;
		const id = typeof record.id === "string" && record.id.length > 0 ? record.id : crypto.randomUUID();
		images.push({ id, name: record.name, mimeType, size, url });
		total += size;
	}
	return images;
}

export function oaImageMimeFromTarget(target: string): string | null {
	const path = target.split(/[?#]/, 1)[0].toLowerCase();
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
	if (path.endsWith(".webp")) return "image/webp";
	if (path.endsWith(".gif")) return "image/gif";
	return null;
}

function oaNormalizeImageTarget(raw: string): string | null {
	let candidate = raw.trim();
	if (candidate.startsWith("<")) candidate = candidate.slice(1);
	if (candidate.endsWith(">")) candidate = candidate.slice(0, -1);
	try {
		candidate = decodeURIComponent(candidate);
	} catch {
		// Keep the raw candidate when it is not percent-encoded.
	}
	return oaImageMimeFromTarget(candidate) ? candidate : null;
}

export function oaExtractImageTargets(text: string, includeBare = false): string[] {
	if (typeof text !== "string" || text.length === 0) return [];
	const found: string[] = [];
	const push = (raw: string): void => {
		const target = oaNormalizeImageTarget(raw);
		if (target) found.push(target);
	};
	for (const match of text.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
		const inner = match[1] ?? "";
		const alias = inner.split("|")[0] ?? "";
		push(alias.split("#")[0] ?? "");
	}
	for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
		push((match[1] ?? "").replace(/\s+["'][^"']*["']\s*$/, ""));
	}
	for (const match of text.matchAll(/https:\/\/[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s<>"')\]]*)?/gi)) {
		push(match[0] ?? "");
	}
	if (includeBare) {
		push(text);
		for (const token of text.split(/\s+/)) push(token);
	}
	return [...new Set(found)];
}

export function oaCollectToolImageTargets(
	value: unknown,
	sourcePath = "",
	path = "",
	out: ToolImageTarget[] = [],
): ToolImageTarget[] {
	if (typeof value === "string") {
		const includeBare = /embed|link|target/i.test(path);
		for (const target of oaExtractImageTargets(value, includeBare)) {
			out.push({ target, sourcePath });
		}
		return out;
	}
	if (Array.isArray(value)) {
		for (const entry of value) oaCollectToolImageTargets(entry, sourcePath, path, out);
		return out;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		let nextSourcePath = sourcePath;
		if (typeof record.path === "string" && record.path.endsWith(".md")) nextSourcePath = record.path;
		for (const [key, entry] of Object.entries(record)) {
			if (key === "path") continue;
			const nextPath = path.length > 0 ? `${path}.${key}` : key;
			oaCollectToolImageTargets(entry, nextSourcePath, nextPath, out);
		}
	}
	return out;
}

export async function oaResolveToolImages(app: App, ctx: unknown): Promise<PendingImage[]> {
	const targets = oaCollectToolImageTargets((ctx as { value?: unknown } | null | undefined)?.value);
	const images: PendingImage[] = [];
	const seen = new Set<string>();
	let total = 0;
	for (const { target, sourcePath } of targets) {
		if (images.length >= OA_MAX_IMAGES) break;
		if (seen.has(target)) continue;
		if (target.startsWith("https://")) {
			const mimeType = oaImageMimeFromTarget(target);
			if (!mimeType) continue;
			let url: string;
			try {
				url = await oaImageUrlToPngDataUrl(target);
			} catch {
				continue;
			}
			const pngSize = Math.ceil((url.length * 3) / 4);
			if (url.length > OA_MAX_DATA_URL_BYTES) continue;
			if (total + pngSize > OA_MAX_TOTAL_IMAGE_BYTES) continue;
			seen.add(target);
			images.push({
				id: crypto.randomUUID(),
				name: target,
				mimeType: "image/png",
				size: pngSize,
				url,
			});
			total += pngSize;
			continue;
		}
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
		const file = app.metadataCache.getFirstLinkpathDest(target, sourcePath || "");
		if (!(file instanceof TFile)) continue;
		if (seen.has(file.path)) continue;
		const mimeType = oaImageMimeFromTarget(file.path);
		const size = file.stat?.size ?? 0;
		if (!mimeType) continue;
		if (size <= 0 || size > OA_MAX_IMAGE_BYTES) continue;
		if (total + size > OA_MAX_TOTAL_IMAGE_BYTES) continue;
		let bytes: ArrayBuffer;
		try {
			bytes = await app.vault.readBinary(file);
		} catch {
			continue;
		}
		if (oaDetectImageMime(bytes) !== mimeType) continue;
		let png: Uint8Array;
		try {
			png = await oaDecodeImageToPng(new Uint8Array(bytes));
		} catch {
			continue;
		}
		if (oaDataUrlLength(png.byteLength, "image/png") > OA_MAX_DATA_URL_BYTES) continue;
		if (total + png.byteLength > OA_MAX_TOTAL_IMAGE_BYTES) continue;
		const url = oaBytesToDataUrl(png, "image/png");
		seen.add(file.path);
		images.push({
			id: crypto.randomUUID(),
			name: file.path,
			mimeType: "image/png",
			size: png.byteLength,
			url,
		});
		total += png.byteLength;
	}
	return images;
}

export function getConversationImages(
	turns: ReadonlyArray<{ images?: PendingImage[] | null }> = [],
): PendingImage[] {
	const images: PendingImage[] = [];
	for (const turn of turns) {
		for (const image of turn.images ?? []) {
			if (!image || typeof image.url !== "string" || image.url.length === 0) continue;
			if (image.url.length > OA_MAX_DATA_URL_BYTES) continue;
			images.push(image);
		}
	}
	return images.slice(-OA_MAX_IMAGES);
}
