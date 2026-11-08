import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import {
	oaBytesToPng,
	oaDecodeImageToPng,
	oaImageUrlToPngDataUrl,
	oaMimeFromBytes,
	oaToImageUrlPart,
	oaValidateDesiredName,
} from "../../src/images/png";
import { oaBufferToDataUrl } from "../../src/images/data-url";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA_URL = `data:image/png;base64,${oaBufferToDataUrl(PNG_BYTES, "image/png").split(",")[1]}`;
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

const requestUrlMock = requestUrl as unknown as ReturnType<typeof vi.fn>;

class MockOffscreenCanvas {
	constructor(
		public width: number,
		public height: number,
	) {}

	getContext(): { drawImage: () => void } {
		return { drawImage: () => undefined };
	}

	async convertToBlob(): Promise<Blob> {
		return new Blob([PNG_BYTES]);
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("oaMimeFromBytes", () => {
	it("sniffs PNG, JPEG, WebP and GIF signatures", () => {
		expect(oaMimeFromBytes(PNG_BYTES)).toBe("image/png");
		expect(oaMimeFromBytes(JPEG_BYTES)).toBe("image/jpeg");
		const webp = new Uint8Array(12);
		webp.set([0x52, 0x49, 0x46, 0x46], 0);
		webp.set([0x57, 0x45, 0x42, 0x50], 8);
		expect(oaMimeFromBytes(webp)).toBe("image/webp");
		expect(oaMimeFromBytes(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
		expect(oaMimeFromBytes(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(oaMimeFromBytes(new Uint8Array(0))).toBeNull();
	});

	it("accepts an ArrayBuffer as well as a Uint8Array", () => {
		expect(oaMimeFromBytes(PNG_BYTES.buffer)).toBe("image/png");
	});
});

describe("oaValidateDesiredName", () => {
	it("accepts names without an extension or with a PNG extension", () => {
		expect(oaValidateDesiredName("photo")).toBeNull();
		expect(oaValidateDesiredName("photo.png")).toBeNull();
		expect(oaValidateDesiredName("photo.PNG")).toBeNull();
		expect(oaValidateDesiredName("photo.")).toBeNull();
		expect(oaValidateDesiredName("photo.verylongext")).toBeNull();
	});

	it("rejects names with a non-PNG extension", () => {
		expect(oaValidateDesiredName("photo.jpg")).toBe(
			"InvalidImageFilename: desiredName must omit the extension or end in .png, not .jpg",
		);
		expect(oaValidateDesiredName("photo.jpeg")).toContain(".jpeg");
	});
});

describe("oaBytesToPng", () => {
	it("draws the bitmap and returns the canvas PNG bytes", async () => {
		vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
		const png = await oaBytesToPng({} as CanvasImageSource, 4, 4);
		expect(oaMimeFromBytes(png)).toBe("image/png");
	});

	it("throws when the canvas context cannot be created", async () => {
		vi.stubGlobal(
			"OffscreenCanvas",
			class {
				getContext(): null {
					return null;
				}
			},
		);
		await expect(oaBytesToPng({} as CanvasImageSource, 1, 1)).rejects.toThrow(
			"PNG conversion could not create a canvas context",
		);
	});

	it("throws when the canvas does not produce PNG data", async () => {
		vi.stubGlobal(
			"OffscreenCanvas",
			class {
				getContext(): { drawImage: () => void } {
					return { drawImage: () => undefined };
				}
				async convertToBlob(): Promise<null> {
					return null;
				}
			},
		);
		await expect(oaBytesToPng({} as CanvasImageSource, 1, 1)).rejects.toThrow(
			"Canvas did not produce PNG data",
		);
	});
});

describe("oaDecodeImageToPng", () => {
	it("returns PNG bytes unchanged", async () => {
		expect(await oaDecodeImageToPng(PNG_BYTES)).toBe(PNG_BYTES);
	});

	it("converts a decoded JPEG to PNG", async () => {
		vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(async () => ({ width: 2, height: 3 })),
		);
		const png = await oaDecodeImageToPng(JPEG_BYTES);
		expect(oaMimeFromBytes(png)).toBe("image/png");
	});

	it("rejects unsupported bytes", async () => {
		await expect(oaDecodeImageToPng(new Uint8Array([1, 2, 3]))).rejects.toThrow(
			"Unsupported image bytes; expected PNG, JPEG, WebP, or GIF",
		);
	});

	it("throws when the bytes cannot be decoded", async () => {
		vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(async () => {
				throw new Error("bad bitmap");
			}),
		);
		await expect(oaDecodeImageToPng(JPEG_BYTES)).rejects.toThrow(
			"Could not decode image for PNG conversion",
		);
	});
});

describe("oaImageUrlToPngDataUrl", () => {
	it("passes a PNG data URL through as a PNG", async () => {
		expect(await oaImageUrlToPngDataUrl(PNG_DATA_URL)).toBe(PNG_DATA_URL);
	});

	it("downloads an HTTPS image and returns a PNG data URL", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 200, arrayBuffer: PNG_BYTES.buffer });
		expect(await oaImageUrlToPngDataUrl("https://example.com/a.png")).toBe(PNG_DATA_URL);
	});

	it("reports a failed HTTPS download", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 404, arrayBuffer: new ArrayBuffer(0) });
		await expect(oaImageUrlToPngDataUrl("https://example.com/a.png")).rejects.toThrow(
			"Could not download image: HTTP 404",
		);
	});

	it("rejects unsupported URLs and invalid data URLs", async () => {
		await expect(oaImageUrlToPngDataUrl("file:///a.png")).rejects.toThrow("Unsupported image URL");
		await expect(oaImageUrlToPngDataUrl("data:image/png;base64,=")).rejects.toThrow(
			"Invalid image data URL",
		);
	});

	it("rejects a non-PNG source above the 10 MB input limit", async () => {
		const jpeg = new Uint8Array(10 * 1024 * 1024 + 1);
		jpeg.set(JPEG_BYTES, 0);
		await expect(oaImageUrlToPngDataUrl(oaBufferToDataUrl(jpeg, "image/jpeg"))).rejects.toThrow(
			"Source image exceeds the 10 MB input limit",
		);
	});
});

describe("oaToImageUrlPart", () => {
	it("wraps a converted PNG data URL in an image_url part", async () => {
		expect(await oaToImageUrlPart(PNG_DATA_URL)).toEqual({
			type: "image_url",
			image_url: { url: PNG_DATA_URL },
		});
	});

	it("returns null for anything that cannot be converted", async () => {
		expect(await oaToImageUrlPart("file:///a.png")).toBeNull();
		expect(await oaToImageUrlPart("data:image/png;base64,=")).toBeNull();
	});
});
