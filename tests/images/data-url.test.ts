import { describe, expect, it } from "vitest";
import {
	oaBase64ByteSize,
	oaBase64ToBuffer,
	oaBufferToDataUrl,
	oaDataUrlToBytes,
} from "../../src/images/data-url";

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("oaBufferToDataUrl", () => {
	it("encodes bytes as a base64 data URL", () => {
		expect(oaBufferToDataUrl(PNG_HEADER, "image/png")).toBe(
			"data:image/png;base64,iVBORw0KGgo=",
		);
	});

	it("accepts an ArrayBuffer as well as a Uint8Array", () => {
		const view = new Uint8Array([1, 2, 3]);
		expect(oaBufferToDataUrl(view.buffer, "image/png")).toBe("data:image/png;base64,AQID");
	});

	it("chunks payloads larger than the 32 KiB string-building block", () => {
		const bytes = new Uint8Array(32768 * 2 + 10).fill(0x41);
		const url = oaBufferToDataUrl(bytes, "image/jpeg");
		const decoded = oaDataUrlToBytes(url);
		expect(decoded?.length).toBe(bytes.length);
		expect(decoded?.[0]).toBe(0x41);
		expect(decoded?.[bytes.length - 1]).toBe(0x41);
	});

	it("round-trips through oaDataUrlToBytes", () => {
		const url = oaBufferToDataUrl(PNG_HEADER, "image/png");
		expect(Array.from(oaDataUrlToBytes(url) ?? [])).toEqual(Array.from(PNG_HEADER));
	});

	it("returns null for a value that is not a base64 data URL", () => {
		expect(oaDataUrlToBytes("https://example.com/a.png")).toBeNull();
		expect(oaDataUrlToBytes("data:image/png,notbase64")).toBeNull();
	});
});

describe("oaBase64ByteSize", () => {
	it("estimates decoded size and accounts for padding", () => {
		expect(oaBase64ByteSize("AQID")).toBe(3);
		expect(oaBase64ByteSize("AQI=")).toBe(2);
		expect(oaBase64ByteSize("AQ==")).toBe(1);
		expect(oaBase64ByteSize("")).toBe(0);
	});

	it("decodes base64 back into an ArrayBuffer", () => {
		expect(Array.from(new Uint8Array(oaBase64ToBuffer("AQID")))).toEqual([1, 2, 3]);
	});
});
