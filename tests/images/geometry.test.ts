import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
	OA_IMAGE_GEOMETRY_CACHE_LIMIT,
	oaAnnotateImageGeometry,
	oaAnnotateTools,
	oaDeriveAspectRatio,
	oaGeometryMetadata,
	oaImageGeometryCache,
	oaImageRatioTable,
	oaRatioForSize,
	oaReferenceGeometry,
	oaResolutionForSize,
	oaResolutionTierTable,
} from "../../src/images/geometry";
import { ok } from "../../src/tools/define";
import type { ChatContentImagePart, ToolDef } from "../../src/types";
import { MockTFile } from "../setup";

function pngReference(width: number, height: number): ChatContentImagePart {
	const bytes = new Uint8Array(24);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
	bytes.set([0, 0, 0, 13], 8);
	bytes.set([73, 72, 68, 82], 12);
	bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16);
	bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20);
	const url = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
	return { type: "image_url", image_url: { url } };
}

function pngBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
	bytes.set([0, 0, 0, 13], 8);
	bytes.set([73, 72, 68, 82], 12);
	bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16);
	bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20);
	return bytes;
}

function mockApp(routes: ReadonlyArray<MockTFile>, readBinary: (file: MockTFile) => Promise<ArrayBuffer>): App {
	const byPath = new Map(routes.map((file) => [file.path, file]));
	return {
		vault: {
			getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
			readBinary,
		},
	} as unknown as App;
}

describe("oaRatioForSize", () => {
	it("returns 1:1 for square and invalid dimensions", () => {
		expect(oaRatioForSize(512, 512)).toBe("1:1");
		expect(oaRatioForSize(0, 100)).toBe("1:1");
		expect(oaRatioForSize(100, 0)).toBe("1:1");
		expect(oaRatioForSize(-5, 10)).toBe("1:1");
	});

	it("picks the nearest supported ratio", () => {
		expect(oaRatioForSize(1920, 1080)).toBe("16:9");
		expect(oaRatioForSize(1080, 1920)).toBe("9:16");
		expect(oaRatioForSize(400, 300)).toBe("4:3");
		expect(oaRatioForSize(300, 400)).toBe("3:4");
	});

	it("prefers the nearest ratio over the smallest containing ratio", () => {
		expect(oaRatioForSize(1050, 1000)).toBe("1:1");
		expect(oaRatioForSize(2000, 1000)).toBe("16:9");
	});

	it("keeps ratios wider than the last tier at the last tier", () => {
		expect(oaRatioForSize(4000, 1000)).toBe("21:9");
	});
});

describe("oaImageRatioTable", () => {
	it("keeps the supported labels in ascending order", () => {
		expect(oaImageRatioTable.map(([label]) => label)).toEqual([
			"9:16",
			"2:3",
			"3:4",
			"1:1",
			"4:3",
			"3:2",
			"16:9",
			"21:9",
		]);
	});
});

describe("oaResolutionForSize", () => {
	it("picks the tier closest to the longest side", () => {
		expect(oaResolutionForSize(512, 512)).toBe("512");
		expect(oaResolutionForSize(1000, 800)).toBe("1K");
		expect(oaResolutionForSize(1920, 1080)).toBe("2K");
		expect(oaResolutionForSize(4000, 3000)).toBe("4K");
	});

	it("returns 1K for invalid dimensions", () => {
		expect(oaResolutionForSize(0, 100)).toBe("1K");
		expect(oaResolutionForSize(100, 0)).toBe("1K");
		expect(oaResolutionForSize(-5, 10)).toBe("1K");
	});
});

describe("oaResolutionTierTable", () => {
	it("keeps the supported tiers in ascending order", () => {
		expect(oaResolutionTierTable.map(([label]) => label)).toEqual(["512", "1K", "2K", "4K"]);
	});
});

describe("oaReferenceGeometry", () => {
	it("derives the ratio and resolution from the first reference image", () => {
		expect(oaReferenceGeometry([pngReference(1920, 1080)])).toEqual({
			aspectRatio: "16:9",
			resolution: "2K",
		});
		expect(oaReferenceGeometry([pngReference(400, 300), pngReference(1920, 1080)])).toEqual({
			aspectRatio: "4:3",
			resolution: "512",
		});
	});

	it("returns conservative defaults without a usable first reference", () => {
		expect(oaReferenceGeometry([])).toEqual({ aspectRatio: "1:1", resolution: "1K" });
		expect(
			oaReferenceGeometry([{ type: "image_url", image_url: { url: "https://example.com/a.png" } }]),
		).toEqual({ aspectRatio: "1:1", resolution: "1K" });
	});
});

describe("oaDeriveAspectRatio", () => {
	it("derives the ratio from the first reference image", () => {
		expect(oaDeriveAspectRatio([pngReference(400, 300)])).toBe("4:3");
		expect(oaDeriveAspectRatio([pngReference(400, 300), pngReference(1920, 1080)])).toBe("4:3");
	});

	it("returns 1:1 without a usable first reference", () => {
		expect(oaDeriveAspectRatio([])).toBe("1:1");
		expect(
			oaDeriveAspectRatio([{ type: "image_url", image_url: { url: "https://example.com/a.png" } }]),
		).toBe("1:1");
		expect(oaDeriveAspectRatio([pngReference(0, 0)])).toBe("1:1");
	});
});

describe("oaGeometryMetadata", () => {
	it("reports exact dimensions, reduced ratio, nearest ratio, and resolution", () => {
		expect(oaGeometryMetadata({ width: 1920, height: 1080 })).toEqual({
			dimensions: { width: 1920, height: 1080, formatted: "1920x1080" },
			aspectRatio: "16:9",
			nearestSupportedAspectRatio: "16:9",
			resolution: "2K",
		});
	});

	it("reduces the aspect ratio by the greatest common divisor", () => {
		expect(oaGeometryMetadata({ width: 800, height: 600 })?.aspectRatio).toBe("4:3");
		expect(oaGeometryMetadata({ width: 1918, height: 1080 })?.aspectRatio).toBe("959:540");
	});

	it("includes the mime type only when it is supplied", () => {
		expect(oaGeometryMetadata({ width: 20, height: 10 })?.mimeType).toBeUndefined();
		expect(oaGeometryMetadata({ width: 20, height: 10 }, "image/png")?.mimeType).toBe("image/png");
	});

	it("returns null for unusable dimensions", () => {
		expect(oaGeometryMetadata(null)).toBeNull();
		expect(oaGeometryMetadata({ width: 0, height: 100 })).toBeNull();
		expect(oaGeometryMetadata({ width: 100, height: -1 })).toBeNull();
	});
});

describe("oaAnnotateImageGeometry", () => {
	beforeEach(() => {
		oaImageGeometryCache.clear();
	});

	it("annotates nested image entries and leaves other entries alone", async () => {
		const app = mockApp([new MockTFile("a.png"), new MockTFile("note.md")], async () =>
			pngBytes(20, 10).buffer as ArrayBuffer,
		);
		const value = {
			entries: [
				{ path: "a.png", type: "file" },
				{ path: "note.md", type: "file" },
			],
		};
		await oaAnnotateImageGeometry(app, value);
		expect(value.entries[0]).toEqual({
			path: "a.png",
			type: "file",
			dimensions: { width: 20, height: 10, formatted: "20x10" },
			aspectRatio: "2:1",
			nearestSupportedAspectRatio: "16:9",
			resolution: "512",
			mimeType: "image/png",
		});
		expect(value.entries[1]).toEqual({ path: "note.md", type: "file" });
	});

	it("reuses the cached geometry for the same path and size", async () => {
		const readBinary = vi.fn(async () => pngBytes(20, 10).buffer as ArrayBuffer);
		const app = mockApp([new MockTFile("a.png")], readBinary);
		await oaAnnotateImageGeometry(app, { path: "a.png" });
		await oaAnnotateImageGeometry(app, { path: "a.png" });
		expect(readBinary).toHaveBeenCalledTimes(1);
	});

	it("keeps the result unchanged when the read fails", async () => {
		const app = mockApp([new MockTFile("a.png")], async () => {
			throw new Error("read failed");
		});
		const value: Record<string, unknown> = { path: "a.png", type: "file" };
		await oaAnnotateImageGeometry(app, value);
		expect(value).toEqual({ path: "a.png", type: "file" });
	});
});

describe("oaAnnotateTools", () => {
	beforeEach(() => {
		oaImageGeometryCache.clear();
	});

	it("annotates only successful results", async () => {
		const app = mockApp([new MockTFile("a.png")], async () =>
			pngBytes(20, 10).buffer as ArrayBuffer,
		);
		const tools = [
			{
				name: "vault_read",
				description: "",
				schema: {},
				category: "vault_read",
				mutates: false,
				run: async () => ({ ok: true, value: { path: "a.png" } }),
			},
			{
				name: "vault_write",
				description: "",
				schema: {},
				category: "vault_write",
				mutates: true,
				run: async () => ({ ok: false, error: "no" }),
			},
		] as unknown as ToolDef[];
		const [read, write] = oaAnnotateTools(app, tools);
		expect(await read.run({}, {} as never)).toEqual({
			ok: true,
			value: {
				path: "a.png",
				dimensions: { width: 20, height: 10, formatted: "20x10" },
				aspectRatio: "2:1",
				nearestSupportedAspectRatio: "16:9",
				resolution: "512",
				mimeType: "image/png",
			},
		});
		expect(await write.run({}, {} as never)).toEqual({ ok: false, error: "no" });
	});

	it("adds the annotation budget to the tool's own timeout", () => {
		const app = mockApp([], async () => new ArrayBuffer(0));
		const [wrapped] = oaAnnotateTools(app, [
			{ name: "image_snip", timeoutMs: 1000, run: async () => ok({}) },
		] as unknown as ToolDef[]);
		expect(wrapped.timeoutMs).toBe(11_000);
	});

	it("uses the default timeout when the tool sets none", () => {
		const app = mockApp([], async () => new ArrayBuffer(0));
		const [wrapped] = oaAnnotateTools(app, [
			{ name: "image_snip", run: async () => ok({}) },
		] as unknown as ToolDef[]);
		expect(wrapped.timeoutMs).toBe(40_000);
	});
});

describe("oaImageGeometryCache", () => {
	beforeEach(() => {
		oaImageGeometryCache.clear();
	});

	it("caps the cache at 512 entries", async () => {
		expect(OA_IMAGE_GEOMETRY_CACHE_LIMIT).toBe(512);
		const files = Array.from({ length: OA_IMAGE_GEOMETRY_CACHE_LIMIT + 1 }, (_, index) =>
			new MockTFile(`image-${index}.png`),
		);
		const app = mockApp(files, async () => pngBytes(20, 10).buffer as ArrayBuffer);
		for (const file of files) {
			await oaAnnotateImageGeometry(app, { path: file.path });
			expect(oaImageGeometryCache.size).toBeLessThanOrEqual(OA_IMAGE_GEOMETRY_CACHE_LIMIT);
		}
		expect(oaImageGeometryCache.size).toBe(1);
	});
});
