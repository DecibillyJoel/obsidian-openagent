import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import {
	getConversationImages,
	OA_IMAGE_MIMES,
	OA_MAX_DATA_URL_BYTES,
	OA_MAX_IMAGE_BYTES,
	OA_MAX_IMAGES,
	OA_MAX_PNG_BYTES,
	OA_MAX_TOTAL_IMAGE_BYTES,
	oaCapConversationImages,
	oaCollectToolImageTargets,
	oaDetectImageMime,
	oaExtractImageTargets,
	oaImageMimeFromTarget,
	oaMultimodalContent,
	oaResolveToolImages,
	oaSanitizeImages,
	type PendingImage,
} from "../../src/images/attachments";
import { MockTFile } from "../setup";
import { oaBufferToDataUrl } from "../../src/images/data-url";

function pngBytes(padding = 4): Uint8Array {
	const bytes = new Uint8Array(8 + padding);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	return bytes;
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const requestUrlMock = requestUrl as unknown as ReturnType<typeof vi.fn>;

class MockOffscreenCanvas {
	static png: Uint8Array = pngBytes();

	constructor(
		public width: number,
		public height: number,
	) {}

	getContext(): { drawImage: () => void } {
		return { drawImage: () => undefined };
	}

	async convertToBlob(): Promise<Blob> {
		return new Blob([MockOffscreenCanvas.png]);
	}
}

function stubPngConversion(png: Uint8Array = pngBytes()): void {
	MockOffscreenCanvas.png = png;
	vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
	vi.stubGlobal(
		"createImageBitmap",
		vi.fn(async () => ({ width: 2, height: 2 })),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

function image(overrides: Partial<PendingImage> = {}): PendingImage {
	return {
		id: "img-1",
		name: "a.png",
		mimeType: "image/png",
		size: 8,
		url: "data:image/png;base64,iVBORw0KGgo=",
		...overrides,
	};
}

describe("oaDetectImageMime", () => {
	it("sniffs PNG, JPEG, WebP and GIF signatures", () => {
		expect(oaDetectImageMime(pngBytes())).toBe("image/png");
		expect(oaDetectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		const webp = new Uint8Array(12);
		webp.set([0x52, 0x49, 0x46, 0x46], 0);
		webp.set([0x57, 0x45, 0x42, 0x50], 8);
		expect(oaDetectImageMime(webp)).toBe("image/webp");
		expect(oaDetectImageMime(new TextEncoder().encode("GIF89a...."))).toBe("image/gif");
		expect(oaDetectImageMime(new TextEncoder().encode("GIF87a...."))).toBe("image/gif");
	});

	it("returns null for unknown or truncated payloads", () => {
		expect(oaDetectImageMime(new Uint8Array([]))).toBeNull();
		expect(oaDetectImageMime(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
		expect(oaDetectImageMime(new TextEncoder().encode("hello world"))).toBeNull();
		expect(oaDetectImageMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
	});

	it("accepts an ArrayBuffer", () => {
		expect(oaDetectImageMime(pngBytes().buffer)).toBe("image/png");
	});
});

describe("oaImageMimeFromTarget", () => {
	it("maps known extensions and ignores query strings and case", () => {
		expect(oaImageMimeFromTarget("a.PNG")).toBe("image/png");
		expect(oaImageMimeFromTarget("a.jpg?v=2")).toBe("image/jpeg");
		expect(oaImageMimeFromTarget("a.jpeg#frag")).toBe("image/jpeg");
		expect(oaImageMimeFromTarget("a.webp")).toBe("image/webp");
		expect(oaImageMimeFromTarget("a.gif")).toBe("image/gif");
		expect(oaImageMimeFromTarget("a.md")).toBeNull();
	});
});

describe("oaExtractImageTargets", () => {
	it("finds wikilink, markdown and absolute URL image targets", () => {
		const text = [
			"![[Attachments/a.png|alias]]",
			"[[b.jpeg#heading]]",
			"![c](Attachments/c.webp \"title\")",
			"https://example.com/d.gif?size=2",
		].join("\n");
		expect(oaExtractImageTargets(text)).toEqual([
			"Attachments/a.png",
			"b.jpeg",
			"Attachments/c.webp",
			"https://example.com/d.gif?size=2",
		]);
	});

	it("decodes percent-encoded targets and deduplicates", () => {
		expect(oaExtractImageTargets("![[Attachments/a%20b.png]] [[Attachments/a%20b.png]]")).toEqual([
			"Attachments/a b.png",
		]);
	});

	it("returns nothing for plain text unless bare scanning is enabled", () => {
		expect(oaExtractImageTargets("see Attachments/a.png")).toEqual([]);
		expect(oaExtractImageTargets("Attachments/a.png", true)).toEqual(["Attachments/a.png"]);
	});
});

describe("oaCollectToolImageTargets", () => {
	it("collects targets and remembers the source note path", () => {
		const targets = oaCollectToolImageTargets({
			path: "Notes/source.md",
			links: ["![[Attachments/a.png]]"],
			nested: { embed: "Attachments/b.jpg" },
		});
		expect(targets).toEqual([
			{ target: "Attachments/a.png", sourcePath: "Notes/source.md" },
			{ target: "Attachments/b.jpg", sourcePath: "Notes/source.md" },
		]);
	});

	it("handles non-object input", () => {
		expect(oaCollectToolImageTargets(42)).toEqual([]);
	});
});

describe("oaMultimodalContent", () => {
	it("returns plain text when there are no usable images", () => {
		expect(oaMultimodalContent("hello")).toBe("hello");
		expect(oaMultimodalContent("hello", [])).toBe("hello");
		expect(oaMultimodalContent("hello", [image({ url: "" })])).toBe("hello");
	});

	it("builds a text part plus image_url parts", () => {
		expect(oaMultimodalContent("hi", [image()])).toEqual([
			{ type: "text", text: "hi" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
		]);
	});

	it("uses the default prompt when text is empty", () => {
		const parts = oaMultimodalContent("", [image()]);
		expect(parts).toEqual([
			{ type: "text", text: "Please analyze the attached image(s)." },
			{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
		]);
	});
});

describe("oaSanitizeImages", () => {
	it("keeps only valid, size-bounded data URLs", () => {
		const valid = image();
		const result = oaSanitizeImages([
			valid,
			image({ mimeType: "image/tiff" }),
			image({ url: "https://example.com/a.png" }),
			image({ size: 0 }),
			image({ size: OA_MAX_PNG_BYTES + 1 }),
			"nope",
			null,
		]);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(valid);
	});

	it("stops at the image cap", () => {
		const many = Array.from({ length: OA_MAX_IMAGES + 4 }, (_value, index) =>
			image({ id: `img-${index}`, name: `a${index}.png` }),
		);
		expect(oaSanitizeImages(many)).toHaveLength(OA_MAX_IMAGES);
	});

	it("rejects a total payload above the aggregate cap", () => {
		const chunk = image({ size: Math.floor(OA_MAX_TOTAL_IMAGE_BYTES / 3) + 1 });
		expect(oaSanitizeImages([chunk, chunk, chunk])).toHaveLength(2);
	});

	it("applies the PNG cap to PNG data URLs and the source cap to other formats", () => {
		expect(oaSanitizeImages([image({ size: OA_MAX_PNG_BYTES })])).toHaveLength(1);
		expect(oaSanitizeImages([image({ size: OA_MAX_PNG_BYTES + 1 })])).toHaveLength(0);
		const jpeg = image({
			mimeType: "image/jpeg",
			name: "a.jpg",
			size: OA_MAX_IMAGE_BYTES + 1,
			url: "data:image/jpeg;base64,AAAA",
		});
		expect(oaSanitizeImages([jpeg])).toHaveLength(0);
	});

	it("drops an image whose data URL exceeds the per-image payload limit", () => {
		const prefix = "data:image/png;base64,";
		const atLimit = image({ url: prefix + "A".repeat(OA_MAX_DATA_URL_BYTES - prefix.length) });
		expect(atLimit.url.length).toBe(OA_MAX_DATA_URL_BYTES);
		expect(oaSanitizeImages([atLimit])).toHaveLength(1);
		expect(oaSanitizeImages([image({ url: `${atLimit.url}A` })])).toEqual([]);
	});

	it("generates an id when one is missing and returns an empty list for non-arrays", () => {
		const withoutId = { ...image(), id: undefined } as unknown as PendingImage;
		const result = oaSanitizeImages([withoutId]);
		expect(result).toHaveLength(1);
		expect(typeof result[0].id).toBe("string");
		expect(oaSanitizeImages("not-an-array")).toEqual([]);
	});

	it("advertises exactly the four supported MIME types", () => {
		expect([...OA_IMAGE_MIMES].sort()).toEqual([
			"image/gif",
			"image/jpeg",
			"image/png",
			"image/webp",
		]);
	});
});

describe("getConversationImages", () => {
	it("flattens user-turn images and keeps the most recent cap", () => {
		const turns = [
			{ images: [image({ id: "a", url: "data:image/png;base64,aa==" })] },
			{ images: [image({ id: "b", url: "data:image/png;base64,bb==" })] },
		];
		expect(getConversationImages(turns).map((entry) => entry.id)).toEqual(["a", "b"]);
		const many = Array.from({ length: OA_MAX_IMAGES + 2 }, (_value, index) => ({
			images: [image({ id: `i${index}`, url: `data:image/png;base64,i${index}==` })],
		}));
		expect(getConversationImages(many)).toHaveLength(OA_MAX_IMAGES);
		expect(getConversationImages().length).toBe(0);
	});

	it("takes at most OA_MAX_IMAGES images across twelve turns", () => {
		const turns = Array.from({ length: 12 }, (_value, index) => ({
			images: [image({ id: `i${index}`, url: `data:image/png;base64,i${index}==` })],
		}));
		expect(getConversationImages(turns)).toHaveLength(OA_MAX_IMAGES);
	});

	it("skips an image whose data URL exceeds the per-image payload limit", () => {
		const prefix = "data:image/png;base64,";
		const turns = [
			{ images: [image({ id: "small", url: "data:image/png;base64,aa==" })] },
			{ images: [image({ id: "huge", url: prefix + "A".repeat(OA_MAX_DATA_URL_BYTES) })] },
			{ images: [image({ id: "small-2", url: "data:image/png;base64,bb==" })] },
		];
		expect(getConversationImages(turns).map((entry) => entry.id)).toEqual(["small", "small-2"]);
	});
});

describe("oaCapConversationImages", () => {
	it("keeps the newest images and drops the rest", () => {
		const images = Array.from({ length: OA_MAX_IMAGES + 3 }, (_value, index) => ({
			id: String(index),
			name: `i${index}.png`,
			mimeType: "image/png",
			size: 10,
			url: `data:image/png;base64,${"A".repeat(10)}`,
		}));
		const kept = oaCapConversationImages(images);
		expect(kept).toHaveLength(OA_MAX_IMAGES);
		expect(kept[kept.length - 1].name).toBe(`i${OA_MAX_IMAGES + 2}.png`);
	});

	it("drops an image whose data URL alone exceeds the cap", () => {
		const big = {
			id: "b",
			name: "big.png",
			mimeType: "image/png",
			size: 1,
			url: `data:image/png;base64,${"A".repeat(OA_MAX_DATA_URL_BYTES + 1)}`,
		};
		expect(oaCapConversationImages([big])).toEqual([]);
	});

	it("stops adding images once the running total exceeds the cap", () => {
		const half = `data:image/png;base64,${"A".repeat(OA_MAX_TOTAL_IMAGE_BYTES / 3)}`;
		const one = { id: "1", name: "one.png", mimeType: "image/png", size: 1, url: half };
		expect(oaCapConversationImages([one, one, one])).toHaveLength(2);
	});
});

describe("oaResolveToolImages", () => {
	function makeApp(bytes: Uint8Array, size = bytes.length, filePath = "Attachments/a.png") {
		const file = Object.assign(new MockTFile(filePath), { stat: { size } });
		return {
			metadataCache: {
				getFirstLinkpathDest: (target: string, _sourcePath: string) =>
					target === filePath || target === file.basename ? file : null,
			},
			vault: {
				readBinary: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			},
		};
	}

	it("reads a vault image into a data URL", async () => {
		const bytes = pngBytes();
		const app = makeApp(bytes);
		const images = await oaResolveToolImages(app as never, {
			ok: true,
			value: { path: "Notes/source.md", links: ["![[Attachments/a.png]]"] },
		});
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({
			name: "Attachments/a.png",
			mimeType: "image/png",
			size: bytes.length,
			url: oaBufferToDataUrl(bytes, "image/png"),
		});
	});

	it("skips images whose bytes do not match the extension", async () => {
		const app = makeApp(new TextEncoder().encode("not an image at all"));
		const images = await oaResolveToolImages(app as never, {
			ok: true,
			value: { path: "Notes/source.md", links: ["![[Attachments/a.png]]"] },
		});
		expect(images).toEqual([]);
	});

	it("skips data URLs, unknown schemes and unrelated results", async () => {
		const app = makeApp(pngBytes());
		expect(
			await oaResolveToolImages(app as never, {
				ok: true,
				value: "data:image/png;base64,iVBORw0KGgo=",
			}),
		).toEqual([]);
		expect(await oaResolveToolImages(app as never, { ok: true, value: "file:///tmp/a.png" })).toEqual([]);
		expect(await oaResolveToolImages(app as never, { ok: false, error: "boom" })).toEqual([]);
		expect(await oaResolveToolImages(app as never, null)).toEqual([]);
	});

	it("converts a vault image with a non-PNG source to a PNG data URL", async () => {
		stubPngConversion();
		const app = makeApp(JPEG_BYTES, JPEG_BYTES.length, "Attachments/a.jpg");
		const images = await oaResolveToolImages(app as never, {
			ok: true,
			value: { path: "Notes/source.md", links: ["![[Attachments/a.jpg]]"] },
		});
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({
			name: "Attachments/a.jpg",
			mimeType: "image/png",
			url: oaBufferToDataUrl(pngBytes(), "image/png"),
		});
	});

	it("converts an https target to a PNG data URL", async () => {
		stubPngConversion();
		requestUrlMock.mockResolvedValueOnce({ status: 200, arrayBuffer: JPEG_BYTES.buffer });
		const app = makeApp(JPEG_BYTES, JPEG_BYTES.length, "Attachments/a.jpg");
		const images = await oaResolveToolImages(app as never, {
			ok: true,
			value: { path: "Notes/source.md", links: ["https://example.com/a.jpg"] },
		});
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({
			name: "https://example.com/a.jpg",
			mimeType: "image/png",
			url: oaBufferToDataUrl(pngBytes(), "image/png"),
		});
	});

	it("skips an https target that cannot be converted", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 404, arrayBuffer: new ArrayBuffer(0) });
		const app = makeApp(pngBytes());
		const images = await oaResolveToolImages(app as never, {
			ok: true,
			value: { path: "Notes/source.md", links: ["https://example.com/a.png"] },
		});
		expect(images).toEqual([]);
	});

	it("skips files that are too large", async () => {
		const app = makeApp(pngBytes(), OA_MAX_IMAGE_BYTES + 1);
		const images = await oaResolveToolImages(app as never, {
			ok: true,
			value: { path: "Notes/source.md", links: ["![[Attachments/a.png]]"] },
		});
		expect(images).toEqual([]);
	});

	it("rejects an over-limit PNG before the base64 encode", async () => {
		const prefix = "data:image/png;base64,";
		const ceilingBytes = Math.floor((OA_MAX_DATA_URL_BYTES - prefix.length) / 4) * 3;
		const fits = new Uint8Array(ceilingBytes);
		const over = new Uint8Array(ceilingBytes + 1);
		const links = ["![[Attachments/a.jpg]]"];

		stubPngConversion(fits);
		const keepApp = makeApp(JPEG_BYTES, JPEG_BYTES.length, "Attachments/a.jpg");
		const kept = await oaResolveToolImages(keepApp as never, {
			ok: true,
			value: { path: "Notes/source.md", links },
		});
		expect(kept).toHaveLength(1);
		expect(kept[0]?.url.length).toBe(prefix.length + (ceilingBytes / 3) * 4);
		expect(kept[0]?.url.length).toBeLessThanOrEqual(OA_MAX_DATA_URL_BYTES);

		const btoaSpy = vi.spyOn(globalThis, "btoa");
		stubPngConversion(over);
		const dropApp = makeApp(JPEG_BYTES, JPEG_BYTES.length, "Attachments/a.jpg");
		const dropped = await oaResolveToolImages(dropApp as never, {
			ok: true,
			value: { path: "Notes/source.md", links },
		});
		expect(dropped).toEqual([]);
		expect(btoaSpy).not.toHaveBeenCalled();
		btoaSpy.mockRestore();
	});

	it("drops a converted image whose data URL exceeds the per-image payload limit", async () => {
		const oversized = new Uint8Array(Math.ceil((OA_MAX_DATA_URL_BYTES * 3) / 4) + 3);
		oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
		stubPngConversion(oversized);
		const app = makeApp(JPEG_BYTES, JPEG_BYTES.length, "Attachments/a.jpg");
		const images = await oaResolveToolImages(app as never, {
			ok: true,
			value: { path: "Notes/source.md", links: ["![[Attachments/a.jpg]]"] },
		});
		expect(images).toEqual([]);
	});
});
