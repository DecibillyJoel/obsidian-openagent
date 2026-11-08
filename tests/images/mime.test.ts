import { describe, expect, it } from "vitest";
import { oaSniffImageDimensions } from "../../src/images/mime";

function pngBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
	bytes.set([0, 0, 0, 13], 8);
	bytes.set([73, 72, 68, 82], 12);
	bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16);
	bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20);
	return bytes;
}

function gifBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(10);
	bytes.set([71, 73, 70, 56, 57, 97], 0);
	bytes[6] = width & 0xff;
	bytes[7] = (width >>> 8) & 0xff;
	bytes[8] = height & 0xff;
	bytes[9] = (height >>> 8) & 0xff;
	return bytes;
}

function webpBytes(fourCC: string, offset: number, payload: number[]): Uint8Array {
	const bytes = new Uint8Array(30);
	bytes.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80], 0);
	bytes.set([fourCC.charCodeAt(0), fourCC.charCodeAt(1), fourCC.charCodeAt(2), fourCC.charCodeAt(3)], 12);
	payload.forEach((value, index) => {
		bytes[offset + index] = value;
	});
	return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(31);
	bytes.set([0xff, 0xd8], 0);
	bytes.set([0xff, 0xe0, 0x00, 0x10], 2);
	bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
	bytes[25] = (height >>> 8) & 0xff;
	bytes[26] = height & 0xff;
	bytes[27] = (width >>> 8) & 0xff;
	bytes[28] = width & 0xff;
	return bytes;
}

describe("oaSniffImageDimensions", () => {
	it("reads PNG dimensions from the IHDR chunk", () => {
		expect(oaSniffImageDimensions(pngBytes(400, 300))).toEqual({ width: 400, height: 300 });
	});

	it("reads GIF dimensions from the logical screen descriptor", () => {
		expect(oaSniffImageDimensions(gifBytes(320, 240))).toEqual({ width: 320, height: 240 });
	});

	it("reads WebP VP8X dimensions", () => {
		const bytes = webpBytes("VP8X", 24, [0xf3, 0x01, 0x00, 0x8f, 0x01, 0x00]);
		expect(oaSniffImageDimensions(bytes)).toEqual({ width: 500, height: 400 });
	});

	it("reads WebP VP8 lossy dimensions", () => {
		const bytes = webpBytes("VP8 ", 26, [0x80, 0x02, 0x68, 0x01]);
		expect(oaSniffImageDimensions(bytes)).toEqual({ width: 640, height: 360 });
	});

	it("reads WebP VP8L lossless dimensions", () => {
		const bytes = webpBytes("VP8L", 21, [0x03, 0x40, 0x00, 0x00]);
		expect(oaSniffImageDimensions(bytes)).toEqual({ width: 4, height: 2 });
	});

	it("reads JPEG dimensions from the start-of-frame segment", () => {
		expect(oaSniffImageDimensions(jpegBytes(400, 300))).toEqual({ width: 400, height: 300 });
	});

	it("returns null for empty, short, or unknown payloads", () => {
		expect(oaSniffImageDimensions(new Uint8Array(0))).toBeNull();
		expect(oaSniffImageDimensions(new Uint8Array([137, 80, 78]))).toBeNull();
		expect(oaSniffImageDimensions(new Uint8Array(20))).toBeNull();
	});

	it("returns null for a PNG signature without an IHDR chunk", () => {
		const bytes = pngBytes(400, 300);
		bytes.set([0, 0, 0, 0], 12);
		expect(oaSniffImageDimensions(bytes)).toBeNull();
	});

	it("returns null for a truncated WebP chunk", () => {
		const bytes = webpBytes("VP8X", 24, [0xf3, 0x01]).slice(0, 25);
		expect(oaSniffImageDimensions(bytes)).toBeNull();
	});
});
