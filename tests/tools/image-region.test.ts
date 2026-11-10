import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	class MockTFile {
		path: string;
		stat = { size: 0 };
		constructor(path: string) {
			this.path = path;
		}
	}
	return { MockTFile };
});

vi.mock("obsidian", () => ({
	App: class App {},
	TFile: mocks.MockTFile,
	normalizePath: (path: string) => path.replace(/\\/g, "/"),
}));

import type { App } from "obsidian";
import {
	oaNormalizeHexColor,
	oaValidateRegionBounds,
	openAgentImageRegionTool,
} from "../../src/tools/image-region";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A minimal PNG prefix that carries the IHDR width and height the sniffer reads.
function pngWithHeaderDimensions(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set(PNG_BYTES, 0);
	bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

const SNIP_DESCRIPTION =
	"Crop an existing vault image to an exact pixel region and save the crop as a new PNG at the vault root. Coordinates are pixel edges: left/top are inclusive and right/bottom are exclusive. The region must be ordered and entirely inside the source image. Supports PNG, JPEG, WebP, and GIF sources; an animated GIF is processed as a still frame. desiredName must omit its extension or end in `.png`. Existing files are never overwritten.";

const BLOT_DESCRIPTION =
	"Draw an opaque filled rectangle over an exact pixel region of an existing vault image and save the full-size result as a new PNG at the vault root. Coordinates are pixel edges: left/top are inclusive and right/bottom are exclusive. The region must be ordered and entirely inside the source image. hexColor accepts six hexadecimal digits with an optional `#` and defaults to green (`#00FF00`). Supports PNG, JPEG, WebP, and GIF sources; an animated GIF is processed as a still frame. desiredName must omit its extension or end in `.png`. Existing files are never overwritten.";

class MockOffscreenCanvas {
	constructor(
		public width: number,
		public height: number,
	) {}

	context: { drawImage: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>; fillStyle: string } | null = {
		drawImage: vi.fn(),
		fillRect: vi.fn(),
		fillStyle: "",
	};

	getContext(): unknown {
		return this.context;
	}

	async convertToBlob(): Promise<Blob> {
		return new Blob([PNG_BYTES]);
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

function createApp(options?: {
	children?: string[];
	files?: Record<string, { size: number; bytes: Uint8Array }>;
}): { app: App; createBinary: ReturnType<typeof vi.fn> } {
	const children = options?.children ?? [];
	const files = options?.files ?? {};
	const createBinary = vi.fn(async () => undefined);
	const app = {
		vault: {
			getRoot: () => ({ children: children.map((name) => ({ name })) }),
			getAbstractFileByPath: (path: string) => {
				const entry = files[path];
				if (!entry) return null;
				const file = new mocks.MockTFile(path);
				file.stat = { size: entry.size };
				return file;
			},
			readBinary: async (file: { path: string }) => files[file.path].bytes.buffer,
			createBinary,
		},
		metadataCache: { getFirstLinkpathDest: () => null },
	} as unknown as App;
	return { app, createBinary };
}

function stubImageEnvironment(width = 10, height = 10): MockOffscreenCanvas {
	vi.stubGlobal("createImageBitmap", async () => ({
		width,
		height,
		close: () => undefined,
	}));
	const canvas = new MockOffscreenCanvas(width, height);
	vi.stubGlobal(
		"OffscreenCanvas",
		class {
			constructor() {
				return canvas;
			}
		},
	);
	return canvas;
}

const baseArgs = {
	sourceImagePath: "photo.png",
	left: 0,
	top: 0,
	right: 4,
	bottom: 4,
	desiredName: "crop",
};

describe("oaNormalizeHexColor", () => {
	it("defaults to green and accepts with or without a leading hash", () => {
		expect(oaNormalizeHexColor(undefined)).toBe("#00FF00");
		expect(oaNormalizeHexColor("00FF00")).toBe("#00FF00");
		expect(oaNormalizeHexColor("#00FF00")).toBe("#00FF00");
		expect(oaNormalizeHexColor("#ff0000")).toBe("#ff0000");
	});

	it("rejects malformed colours", () => {
		expect(oaNormalizeHexColor("")).toBeNull();
		expect(oaNormalizeHexColor("#fff")).toBeNull();
		expect(oaNormalizeHexColor("#gggggg")).toBeNull();
		expect(oaNormalizeHexColor("12345")).toBeNull();
	});
});

describe("oaValidateRegionBounds", () => {
	it("returns the region with derived width and height", () => {
		expect(oaValidateRegionBounds({ left: 1, top: 2, right: 5, bottom: 7 }, 10, 10)).toEqual({
			left: 1,
			top: 2,
			right: 5,
			bottom: 7,
			width: 4,
			height: 5,
		});
	});

	it("rejects non-integer and negative edges", () => {
		expect(() => oaValidateRegionBounds({ left: -1, top: 0, right: 2, bottom: 2 }, 10, 10)).toThrow(
			"InvalidCoordinates: left must be a non-negative integer",
		);
		expect(() => oaValidateRegionBounds({ left: 0.5, top: 0, right: 2, bottom: 2 }, 10, 10)).toThrow(
			"InvalidCoordinates: left must be a non-negative integer",
		);
	});

	it("rejects unordered regions and out-of-bounds regions", () => {
		expect(() => oaValidateRegionBounds({ left: 3, top: 0, right: 3, bottom: 2 }, 10, 10)).toThrow(
			"InvalidRegion: right must be greater than left and bottom must be greater than top",
		);
		expect(() => oaValidateRegionBounds({ left: 0, top: 0, right: 11, bottom: 2 }, 10, 10)).toThrow(
			"RegionOutOfBounds: region (0, 0)-(11, 2) exceeds 10x10 image bounds",
		);
	});
});

describe("image region tool schema", () => {
	it("builds image_snip with the exact description and no hexColor", () => {
		const { app } = createApp();
		const tool = openAgentImageRegionTool(app, "snip");
		expect(tool.name).toBe("image_snip");
		expect(tool.description).toBe(SNIP_DESCRIPTION);
		expect(tool.category).toBe("vault_write");
		expect(tool.mutates).toBe(true);
		expect(tool.timeoutMs).toBe(120000);
		expect(tool.schema.required).toEqual([
			"sourceImagePath",
			"left",
			"top",
			"right",
			"bottom",
			"desiredName",
		]);
		expect(tool.schema.additionalProperties).toBe(false);
		expect(tool.schema.properties).not.toHaveProperty("hexColor");
	});

	it("builds image_blot with hexColor and the exact description", () => {
		const { app } = createApp();
		const tool = openAgentImageRegionTool(app, "blot");
		expect(tool.name).toBe("image_blot");
		expect(tool.description).toBe(BLOT_DESCRIPTION);
		expect(tool.schema.properties.hexColor).toMatchObject({
			type: "string",
			pattern: "^#?[0-9A-Fa-f]{6}$",
		});
	});
});

describe("image region tool errors", () => {
	it("rejects a desiredName with a non-PNG extension", async () => {
		const { app } = createApp();
		const tool = openAgentImageRegionTool(app, "snip");
		const result = await tool.run({ ...baseArgs, desiredName: "crop.jpg" }, {});
		expect(result).toEqual({
			ok: false,
			error: "InvalidImageFilename: desiredName must omit the extension or end in .png, not .jpg",
			details: undefined,
		});
	});

	it("rejects a malformed hexColor for image_blot", async () => {
		const { app } = createApp();
		const tool = openAgentImageRegionTool(app, "blot");
		const result = await tool.run({ ...baseArgs, hexColor: "#abc" }, {});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toBe(
			"InvalidHexColor: hexColor must contain exactly six hexadecimal digits, with an optional leading #",
		);
	});

	it("reports PathError for a path that escapes the vault root", async () => {
		const { app } = createApp();
		const tool = openAgentImageRegionTool(app, "snip");
		const result = await tool.run({ ...baseArgs, sourceImagePath: "../secret.png" }, {});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("PathError:");
	});

	it("reports SourceImageNotFound for a missing file", async () => {
		const { app } = createApp();
		const tool = openAgentImageRegionTool(app, "snip");
		const result = await tool.run(baseArgs, {});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toBe("SourceImageNotFound: photo.png");
	});

	it("reports UnsupportedImage for a non-image extension", async () => {
		const { app } = createApp({ files: { "note.md": { size: 3, bytes: new Uint8Array([1, 2, 3]) } } });
		const tool = openAgentImageRegionTool(app, "snip");
		const result = await tool.run({ ...baseArgs, sourceImagePath: "note.md" }, {});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toBe("UnsupportedImage: note.md. Use PNG, JPEG, WebP, or GIF.");
	});

	it("reports ImageTooLarge for an oversized PNG", async () => {
		const { app } = createApp({
			files: { "big.png": { size: 64 * 1024 * 1024 + 1, bytes: PNG_BYTES } },
		});
		const tool = openAgentImageRegionTool(app, "snip");
		const result = await tool.run({ ...baseArgs, sourceImagePath: "big.png" }, {});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toBe("ImageTooLarge: big.png exceeds the 64 MB processing limit");
	});

	it("rejects a source header above the pixel limit before decoding and writes no file", async () => {
		const { app, createBinary } = createApp({
			files: { "huge.png": { size: 1000, bytes: pngWithHeaderDimensions(9000, 9000) } },
		});
		const decodeSpy = vi.fn(async () => ({ width: 9000, height: 9000, close: () => undefined }));
		vi.stubGlobal("createImageBitmap", decodeSpy);
		vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
		const tool = openAgentImageRegionTool(app, "snip");
		const result = await tool.run({ ...baseArgs, sourceImagePath: "huge.png" }, {});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toBe(
			"ImageProcessingError: ImageDimensionsTooLarge: 9000x9000 exceeds the 40 megapixel processing limit",
		);
		expect(decodeSpy).not.toHaveBeenCalled();
		expect(createBinary).not.toHaveBeenCalled();
	});
});

describe("image region tool rendering", () => {
	it("crops and saves a new PNG for image_snip", async () => {
		const { app, createBinary } = createApp({
			files: { "photo.png": { size: 100, bytes: PNG_BYTES } },
		});
		stubImageEnvironment(10, 10);
		const tool = openAgentImageRegionTool(app, "snip");
		const result = await tool.run({ ...baseArgs, left: 1, top: 2, right: 5, bottom: 7 }, {});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.value).toMatchObject({
			path: "crop.png",
			markdownEmbed: "![[crop.png]]",
			mimeType: "image/png",
			sourcePath: "photo.png",
			region: { left: 1, top: 2, right: 5, bottom: 7, width: 4, height: 5 },
			operation: "snip",
		});
		expect(result.value).not.toHaveProperty("hexColor");
		expect(createBinary).toHaveBeenCalledWith("crop.png", expect.anything());
	});

	it("covers a region with the default green for image_blot", async () => {
		const { app } = createApp({ files: { "photo.png": { size: 100, bytes: PNG_BYTES } } });
		const canvas = stubImageEnvironment(10, 10);
		const tool = openAgentImageRegionTool(app, "blot");
		const result = await tool.run(baseArgs, {});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.value).toMatchObject({
			operation: "blot",
			hexColor: "#00FF00",
			region: { left: 0, top: 0, right: 4, bottom: 4, width: 4, height: 4 },
		});
		expect(canvas.context?.fillRect).toHaveBeenCalledWith(0, 0, 4, 4);
	});

	it("wraps a region outside the source as an ImageProcessingError", async () => {
		const { app } = createApp({ files: { "photo.png": { size: 100, bytes: PNG_BYTES } } });
		stubImageEnvironment(10, 10);
		const tool = openAgentImageRegionTool(app, "snip");
		const result = await tool.run({ ...baseArgs, right: 20, bottom: 20 }, {});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toBe(
			"ImageProcessingError: RegionOutOfBounds: region (0, 0)-(20, 20) exceeds 10x10 image bounds",
		);
	});

	it("wraps a missing canvas context as an ImageProcessingError", async () => {
		const { app } = createApp({ files: { "photo.png": { size: 100, bytes: PNG_BYTES } } });
		vi.stubGlobal("createImageBitmap", async () => ({ width: 10, height: 10, close: () => undefined }));
		vi.stubGlobal(
			"OffscreenCanvas",
			class {
				getContext(): null {
					return null;
				}
			},
		);
		const tool = openAgentImageRegionTool(app, "snip");
		const result = await tool.run(baseArgs, {});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toBe(
			"ImageProcessingError: Image processing could not create a canvas context",
		);
	});
});
