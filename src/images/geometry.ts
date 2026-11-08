import { TFile, type App } from "obsidian";
import type { ChatContentImagePart, ToolDef } from "../types";
import { oaDetectImageMime, oaImageMimeFromTarget } from "./attachments";
import { oaDataUrlToBytes } from "./data-url";
import { oaSniffImageDimensions, type OaImageDimensions } from "./mime";

// Ascending order. The chooser keeps the supported ratio nearest the image ratio.
export const oaImageRatioTable: ReadonlyArray<readonly [string, number]> = [
	["9:16", 9 / 16],
	["2:3", 2 / 3],
	["3:4", 3 / 4],
	["1:1", 1],
	["4:3", 4 / 3],
	["3:2", 3 / 2],
	["16:9", 16 / 9],
	["21:9", 21 / 9],
];

// Ascending order. The chooser keeps the tier nearest in logarithmic distance.
export const oaResolutionTierTable: ReadonlyArray<readonly [string, number]> = [
	["512", 512],
	["1K", 1024],
	["2K", 2048],
	["4K", 4096],
];

export function oaRatioForSize(width: number, height: number): string {
	if (!width || !height || width <= 0 || height <= 0) return "1:1";
	const ratio = width / height;
	let best = oaImageRatioTable[0];
	for (const candidate of oaImageRatioTable) {
		if (Math.abs(candidate[1] - ratio) < Math.abs(best[1] - ratio) - 1e-9) best = candidate;
	}
	return best[0];
}

export function oaResolutionForSize(width: number, height: number): string {
	if (!width || !height || width <= 0 || height <= 0) return "1K";
	const target = Math.max(width, height);
	let best = oaResolutionTierTable[0];
	for (const candidate of oaResolutionTierTable) {
		if (Math.abs(Math.log(candidate[1] / target)) < Math.abs(Math.log(best[1] / target))) best = candidate;
	}
	return best[0];
}

function oaFirstReferenceDimensions(
	references: ReadonlyArray<ChatContentImagePart>,
): OaImageDimensions | null {
	const url = references[0]?.image_url?.url;
	if (typeof url !== "string" || url.length === 0) return null;
	const bytes = oaDataUrlToBytes(url);
	if (!bytes) return null;
	return oaSniffImageDimensions(bytes);
}

/** Derives the output ratio from the first reference image, defaulting to 1:1. */
export function oaDeriveAspectRatio(references: ReadonlyArray<ChatContentImagePart>): string {
	const dimensions = oaFirstReferenceDimensions(references);
	return dimensions ? oaRatioForSize(dimensions.width, dimensions.height) : "1:1";
}

export interface OaReferenceGeometry {
	aspectRatio: string;
	resolution: string;
}

/** Derives the nearest supported ratio and resolution tier from the first reference image. */
export function oaReferenceGeometry(references: ReadonlyArray<ChatContentImagePart>): OaReferenceGeometry {
	const dimensions = oaFirstReferenceDimensions(references);
	return {
		aspectRatio: dimensions ? oaRatioForSize(dimensions.width, dimensions.height) : "1:1",
		resolution: dimensions ? oaResolutionForSize(dimensions.width, dimensions.height) : "1K",
	};
}

function oaGreatestCommonDivisor(a: number, b: number): number {
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a;
}

export interface OaImageGeometry {
	dimensions: { width: number; height: number; formatted: string };
	aspectRatio: string;
	nearestSupportedAspectRatio: string;
	resolution: string;
	mimeType?: string;
}

/** Builds exact image geometry from pixel dimensions, or null when the dimensions are unusable. */
export function oaGeometryMetadata(
	dimensions: OaImageDimensions | null,
	mimeType?: string | null,
): OaImageGeometry | null {
	if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null;
	const divisor = oaGreatestCommonDivisor(dimensions.width, dimensions.height);
	return {
		dimensions: {
			width: dimensions.width,
			height: dimensions.height,
			formatted: `${dimensions.width}x${dimensions.height}`,
		},
		aspectRatio: `${dimensions.width / divisor}:${dimensions.height / divisor}`,
		nearestSupportedAspectRatio: oaRatioForSize(dimensions.width, dimensions.height),
		resolution: oaResolutionForSize(dimensions.width, dimensions.height),
		...(mimeType ? { mimeType } : {}),
	};
}

export const OA_IMAGE_GEOMETRY_CACHE_LIMIT = 512;

/** Module-level geometry cache keyed `path:mtime:size`, cleared once the cap is reached. */
export const oaImageGeometryCache = new Map<string, OaImageGeometry>();

/**
 * Adds image geometry to every image-bearing result, including nested entries.
 * Annotation is best-effort: a read error leaves the result unchanged.
 */
export async function oaAnnotateImageGeometry(
	app: App,
	value: unknown,
	seen: Set<unknown> = new Set(),
): Promise<void> {
	if (!value || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) await oaAnnotateImageGeometry(app, item, seen);
		return;
	}
	const record = value as Record<string, unknown>;
	const candidates = [record.path, record.to, record.trashPath].filter(
		(target): target is string => typeof target === "string" && oaImageMimeFromTarget(target) !== null,
	);
	if (candidates.length > 0 && !record.dimensions) {
		try {
			const file = candidates
				.map((target) => app.vault.getAbstractFileByPath(target))
				.find((item): item is TFile => item instanceof TFile);
			if (file) {
				const key = `${file.path}:${file.stat?.mtime ?? 0}:${file.stat?.size ?? 0}`;
				let geometry = oaImageGeometryCache.get(key);
				if (!geometry) {
					const bytes = new Uint8Array(await app.vault.readBinary(file));
					geometry =
						oaGeometryMetadata(oaSniffImageDimensions(bytes), oaDetectImageMime(bytes)) ?? undefined;
					if (geometry) {
						if (oaImageGeometryCache.size >= OA_IMAGE_GEOMETRY_CACHE_LIMIT) oaImageGeometryCache.clear();
						oaImageGeometryCache.set(key, geometry);
					}
				}
				if (geometry) Object.assign(record, geometry);
			}
		} catch {
			// Geometry annotation never fails the tool call.
		}
	}
	for (const item of Object.values(record)) await oaAnnotateImageGeometry(app, item, seen);
}

/** Wraps every tool so a successful result is annotated with image geometry. */
export function oaAnnotateTools(app: App, tools: ToolDef[]): ToolDef[] {
	return tools.map((tool): ToolDef => {
		const run = tool.run;
		return {
			...tool,
			async run(args, ctx) {
				const result = await run(args, ctx);
				if (result.ok) await oaAnnotateImageGeometry(app, result.value);
				return result;
			},
		};
	});
}
