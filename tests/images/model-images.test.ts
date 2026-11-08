import { describe, expect, it, vi } from "vitest";
import { oaPersistInlineModelImage } from "../../src/images/model-images";
import { requestUrlMock } from "../setup";

function mockApp() {
	return {
		vault: {
			getRoot: vi.fn(() => ({ children: [] })),
			createBinary: vi.fn(async () => undefined),
		},
	};
}

describe("oaPersistInlineModelImage", () => {
	it("writes an inline data URL image to the vault root", async () => {
		const app = mockApp();

		const image = await oaPersistInlineModelImage(
			app as never,
			"data:image/png;base64,iVBORw0KGgo=",
			"draw a cat",
			"gpt-4o-mini",
		);

		expect(image).toEqual({
			path: "model-response.png",
			prompt: "draw a cat",
			model: "gpt-4o-mini",
		});
		expect(app.vault.createBinary).toHaveBeenCalledTimes(1);
		const [path, bytes] = app.vault.createBinary.mock.calls[0];
		expect(path).toBe("model-response.png");
		expect(bytes).toBeInstanceOf(ArrayBuffer);
	});

	it("rejects unsupported URL schemes", async () => {
		const app = mockApp();

		await expect(
			oaPersistInlineModelImage(app as never, "ftp://example.com/a.png", "p", "m"),
		).rejects.toThrow("Unsupported inline image URL");
		expect(app.vault.createBinary).not.toHaveBeenCalled();
	});

	it("rejects malformed data URLs", async () => {
		const app = mockApp();

		await expect(
			oaPersistInlineModelImage(app as never, "data:image/png;base64,", "p", "m"),
		).rejects.toThrow("Invalid inline image data URL");
	});

	it("rejects bytes that are not a supported image", async () => {
		const app = mockApp();

		await expect(
			oaPersistInlineModelImage(
				app as never,
				"data:image/png;base64,aGVsbG8=",
				"p",
				"m",
			),
		).rejects.toThrow("Inline image bytes are not PNG, JPEG, WebP, or GIF");
	});

	it("downloads an https image and reports HTTP failures", async () => {
		const app = mockApp();
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			arrayBuffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
		});

		const image = await oaPersistInlineModelImage(
			app as never,
			"https://cdn.example.com/a.png",
			"p",
			"m",
		);
		expect(image.path).toBe("model-response.png");

		requestUrlMock.mockResolvedValueOnce({ status: 404 });
		await expect(
			oaPersistInlineModelImage(app as never, "https://cdn.example.com/b.png", "p", "m"),
		).rejects.toThrow("Could not download inline image: HTTP 404");
	});

	it("rejects an empty downloaded body", async () => {
		const app = mockApp();
		requestUrlMock.mockResolvedValueOnce({ status: 200, arrayBuffer: new ArrayBuffer(0) });

		await expect(
			oaPersistInlineModelImage(app as never, "https://cdn.example.com/a.png", "p", "m"),
		).rejects.toThrow("Inline image is empty or exceeds 32 MB");
	});
});
