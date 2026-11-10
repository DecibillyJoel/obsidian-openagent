import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	class MockTFile {
		path: string;
		stat = { size: 0 };
		constructor(path: string) {
			this.path = path;
		}
	}
	return {
		MockTFile,
		requestUrlMock: vi.fn(),
	};
});

vi.mock("obsidian", () => ({
	App: class App {},
	TFile: mocks.MockTFile,
	normalizePath: (path: string) => path.replace(/\\/g, "/"),
	requestUrl: mocks.requestUrlMock,
}));

import { type App } from "obsidian";
import {
	oaBase64ToBuffer,
	oaCollectGenerationReferences,
	oaExtensionForMime,
	oaReferenceFromVaultPath,
	oaSafeGeneratedStem,
	oaSanitizeGeneratedImages,
	oaUniqueRootImagePath,
	openAgentImageGenerateTool,
	OA_IMAGE_GENERATION_TIMEOUT_MS,
} from "../../src/tools/image-generate";
import { oaBufferToDataUrl } from "../../src/images/data-url";
import type { PluginSettings } from "../../src/settings";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = "iVBORw0KGgo=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	mocks.requestUrlMock.mockReset();
});

function stubGenerationResponse(
	text = JSON.stringify({ data: [{ b64_json: PNG_B64 }] }),
	status = 200,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => ({ status, text: async () => text }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function pngReferenceBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16);
	bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20);
	return bytes;
}

function createApp(options?: {
	children?: string[];
	files?: Record<string, { size: number; bytes: Uint8Array }>;
}): App {
	const children = options?.children ?? [];
	const files = options?.files ?? {};
	return {
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
			createBinary: vi.fn(async () => undefined),
		},
	} as unknown as App;
}

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return {
		provider: "openai-compatible",
		baseUrl: "https://gateway.example/v1",
		apiKey: "key",
		model: "gpt-4o-mini",
		imageModel: "google/gemini-3.1-flash-image-preview",
		systemPrompt: "",
		consent: {} as PluginSettings["consent"],
		packProviderOverrides: {},
		...overrides,
	};
}

describe("oaBase64ToBuffer", () => {
	it("decodes base64 and strips whitespace", () => {
		const bytes = new Uint8Array(oaBase64ToBuffer("iVBO\nRw0K\nGgo="));
		expect([...bytes]).toEqual([...PNG_BYTES]);
	});

	it("throws on empty, non-string or oversized payloads", () => {
		expect(() => oaBase64ToBuffer("")).toThrow("Generated image data is empty or too large");
		expect(() => oaBase64ToBuffer(null)).toThrow("Generated image data is empty or too large");
		expect(() => oaBase64ToBuffer("A".repeat(96 * 1024 * 1024 + 1))).toThrow(
			"Generated image data is empty or too large",
		);
	});
});

describe("oaExtensionForMime", () => {
	it("maps supported MIME types", () => {
		expect(oaExtensionForMime("image/jpeg")).toBe("jpg");
		expect(oaExtensionForMime("image/webp")).toBe("webp");
		expect(oaExtensionForMime("image/gif")).toBe("gif");
		expect(oaExtensionForMime("image/png")).toBe("png");
		expect(oaExtensionForMime("application/pdf")).toBeNull();
		expect(oaExtensionForMime(null)).toBeNull();
	});
});

describe("oaSafeGeneratedStem", () => {
	it("strips paths and extensions and normalizes separators", () => {
		expect(oaSafeGeneratedStem("folder/Nora portrait.png")).toBe("Nora portrait");
		expect(oaSafeGeneratedStem("a:b?c*.webp")).toBe("a-b-c-");
	});

	it("falls back and prefixes reserved device names", () => {
		expect(oaSafeGeneratedStem("")).toBe("generated-image");
		expect(oaSafeGeneratedStem("CON")).toBe("image-CON");
		expect(oaSafeGeneratedStem("lpt3.png")).toBe("image-lpt3");
	});

	it("caps length at 100 characters", () => {
		expect(oaSafeGeneratedStem("x".repeat(500))).toHaveLength(100);
	});
});

describe("oaUniqueRootImagePath", () => {
	it("returns the first free root name", () => {
		expect(oaUniqueRootImagePath(createApp(), "Nora portrait", "png")).toBe("Nora portrait.png");
		expect(oaUniqueRootImagePath(createApp({ children: ["Nora portrait.png"] }), "Nora portrait", "png")).toBe(
			"Nora portrait-2.png",
		);
		expect(
			oaUniqueRootImagePath(
				createApp({ children: ["nora.png", "nora-2.png"] }),
				"nora",
				"png",
			),
		).toBe("nora-3.png");
	});
});

describe("oaReferenceFromVaultPath", () => {
	it("reads a supported vault image into a data URL reference", async () => {
		const app = createApp({
			files: { "img/a.png": { size: 8, bytes: PNG_BYTES } },
		});
		const reference = await oaReferenceFromVaultPath(app, "img/a.png");
		expect(reference).toEqual({ type: "image_url", image_url: { url: PNG_DATA_URL } });
	});

	it("returns null for missing, unsupported or invalid files", async () => {
		const app = createApp({
			files: {
				"notes.md": { size: 8, bytes: PNG_BYTES },
				"bad.png": { size: 8, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
			},
		});
		expect(await oaReferenceFromVaultPath(app, "missing.png")).toBeNull();
		expect(await oaReferenceFromVaultPath(app, "notes.md")).toBeNull();
		expect(await oaReferenceFromVaultPath(app, "bad.png")).toBeNull();
	});
});

describe("oaCollectGenerationReferences", () => {
	it("resolves source paths into references and names", async () => {
		const app = createApp({ files: { "a.png": { size: 8, bytes: PNG_BYTES } } });
		const result = await oaCollectGenerationReferences(app, {
			operation: "edit",
			sourceImagePaths: ["a.png"],
		});
		expect(result.references).toHaveLength(1);
		expect(result.names).toEqual(["a.png"]);
	});

	it("throws for unsupported source paths", async () => {
		const app = createApp();
		await expect(
			oaCollectGenerationReferences(app, { operation: "edit", sourceImagePaths: ["missing.png"] }),
		).rejects.toThrow("SourceImageNotFoundOrUnsupported: missing.png");
	});

	it("collects and de-duplicates conversation images", async () => {
		const app = createApp();
		const result = await oaCollectGenerationReferences(
			app,
			{ operation: "generate", useConversationImages: true },
			async () => [
				{ url: PNG_DATA_URL, name: "a" },
				{ url: PNG_DATA_URL, name: "dup" },
			],
		);
		expect(result.references).toHaveLength(1);
		expect(result.names).toEqual(["a"]);
	});

	it("auto-attaches only the newest conversation image for an edit", async () => {
		const app = createApp({
			files: { "old.png": { size: 8, bytes: PNG_BYTES }, "new.png": { size: 8, bytes: PNG_BYTES } },
		});
		const result = await oaCollectGenerationReferences(app, { operation: "edit" }, async () => [
			{ path: "old.png" },
			{ path: "new.png" },
		]);
		expect(result.names).toEqual(["new.png"]);
		expect(result.references).toHaveLength(1);
	});

	it("throws SourceImageRequired for an edit with no usable source", async () => {
		const app = createApp();
		await expect(
			oaCollectGenerationReferences(app, { operation: "edit" }, async () => []),
		).rejects.toThrow(
			"SourceImageRequired: editing requires sourceImagePaths or a usable image already shown/attached in this conversation",
		);
	});

	it("does not require a source for a generate without any conversation image", async () => {
		const app = createApp();
		const result = await oaCollectGenerationReferences(app, {
			operation: "generate",
			useConversationImages: false,
		});
		expect(result).toEqual({ references: [], names: [] });
	});

	it("throws when reference images exceed the total limit", async () => {
		const app = createApp();
		const bytes = new Uint8Array(33 * 1024 * 1024);
		bytes.set(PNG_BYTES, 0);
		const first = oaBufferToDataUrl(bytes, "image/png");
		bytes[bytes.length - 1] = 1;
		const second = oaBufferToDataUrl(bytes, "image/png");
		await expect(
			oaCollectGenerationReferences(app, { operation: "generate", useConversationImages: true }, async () => [
				{ url: first },
				{ url: second },
			]),
		).rejects.toThrow("SourceImagesTooLarge: converted PNG references exceed the 64 MB limit");
	});
});

describe("oaSanitizeGeneratedImages", () => {
	it("keeps root-level image paths and drops invalid entries", () => {
		const result = oaSanitizeGeneratedImages([
			{ path: "a.png", prompt: "p", model: "m" },
			{ path: "dir/b.png" },
			{ path: "c.txt" },
			{ path: 3 },
			"nope",
		]);
		expect(result).toEqual([{ path: "a.png", prompt: "p", model: "m" }]);
	});

	it("defaults missing prompt and model and returns [] for non-arrays", () => {
		expect(oaSanitizeGeneratedImages([{ path: "a.png" }])).toEqual([
			{ path: "a.png", prompt: "", model: "" },
		]);
		expect(oaSanitizeGeneratedImages(null)).toEqual([]);
	});

	it("preserves the vault source and omits it for generated images", () => {
		expect(oaSanitizeGeneratedImages([{ path: "a.png", source: "vault" }])).toEqual([
			{ path: "a.png", prompt: "", model: "", source: "vault" },
		]);
		expect(oaSanitizeGeneratedImages([{ path: "a.png", source: "other" }])).toEqual([
			{ path: "a.png", prompt: "", model: "" },
		]);
	});

	it("caps the list at 32 entries", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ path: `img-${i}.png` }));
		expect(oaSanitizeGeneratedImages(many)).toHaveLength(32);
	});

	it("keeps valid reference names and drops data URLs and non-strings", () => {
		expect(
			oaSanitizeGeneratedImages([
				{
					path: "a.png",
					referenceImageNames: ["img/a.png", "data:image/png;base64,AAAA", 7, "img/b.png"],
				},
			]),
		).toEqual([
			{
				path: "a.png",
				prompt: "",
				model: "",
				referenceImageNames: ["img/a.png", "img/b.png"],
			},
		]);
	});

	it("omits empty reference names", () => {
		expect(oaSanitizeGeneratedImages([{ path: "a.png", referenceImageNames: [] }])).toEqual([
			{ path: "a.png", prompt: "", model: "" },
		]);
	});
});

describe("openAgentImageGenerateTool", () => {
	it("declares the spec metadata and schema", () => {
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		expect(tool.name).toBe("image_generate");
		expect(tool.category).toBe("vault_write");
		expect(tool.mutates).toBe(true);
		expect(tool.requiresApproval).toBe(false);
		expect(tool.stopOnFailure).toBe(true);
		expect(tool.timeoutMs).toBe(330000);
		expect(tool.schema.required).toEqual(["operation", "prompt", "desiredName"]);
		expect(tool.schema.additionalProperties).toBe(false);
	});

	it("rejects a desiredName with a non-PNG extension", async () => {
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		const result = await tool.run({ operation: "generate", prompt: "a cat", desiredName: "cat.jpg" }, {});
		expect(result).toEqual({
			ok: false,
			error: "InvalidImageFilename: desiredName must omit the extension or end in .png, not .jpg",
		});
	});

	it("always requests PNG output and saves the generated image as PNG", async () => {
		const fetchMock = stubGenerationResponse();
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		const result = await tool.run({ operation: "generate", prompt: "a cat", desiredName: "cat" }, {});
		const body = JSON.parse(
			(fetchMock.mock.calls.at(-1)?.[1] as { body: string }).body,
		) as { output_format?: string };
		expect(body.output_format).toBe("png");
		expect(result).toEqual({
			ok: true,
			value: expect.objectContaining({ path: "cat.png", mimeType: "image/png" }),
		});
	});

	it("derives the aspect ratio and resolution tier from the first source", async () => {
		const fetchMock = stubGenerationResponse();
		const app = createApp({ files: { "img/a.png": { size: 24, bytes: pngReferenceBytes(1920, 1080) } } });
		const tool = openAgentImageGenerateTool(app, () => settings());
		await tool.run(
			{ operation: "edit", prompt: "a cat in a hat", desiredName: "cat", sourceImagePaths: ["img/a.png"] },
			{},
		);
		const body = JSON.parse(
			(fetchMock.mock.calls.at(-1)?.[1] as { body: string }).body,
		) as { aspect_ratio?: string; resolution?: string };
		expect(body.aspect_ratio).toBe("16:9");
		expect(body.resolution).toBe("2K");
	});

	it("sends conservative geometry defaults without a source", async () => {
		const fetchMock = stubGenerationResponse();
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		await tool.run({ operation: "generate", prompt: "a cat", desiredName: "cat" }, {});
		const body = JSON.parse(
			(fetchMock.mock.calls.at(-1)?.[1] as { body: string }).body,
		) as { aspect_ratio?: string; resolution?: string };
		expect(body.aspect_ratio).toBe("1:1");
		expect(body.resolution).toBe("1K");
	});

	it("honors explicit userRequested overrides exactly", async () => {
		const fetchMock = stubGenerationResponse();
		const app = createApp({ files: { "img/a.png": { size: 24, bytes: pngReferenceBytes(1920, 1080) } } });
		const tool = openAgentImageGenerateTool(app, () => settings());
		await tool.run(
			{
				operation: "edit",
				prompt: "a cat in a hat",
				desiredName: "cat",
				sourceImagePaths: ["img/a.png"],
				userRequestedAspectRatio: "1:1",
				userRequestedResolution: "4K",
				userRequestedQuality: "low",
			},
			{},
		);
		const body = JSON.parse(
			(fetchMock.mock.calls.at(-1)?.[1] as { body: string }).body,
		) as { aspect_ratio?: string; resolution?: string; quality?: string };
		expect(body.aspect_ratio).toBe("1:1");
		expect(body.resolution).toBe("4K");
		expect(body.quality).toBe("low");
	});

	it("declares only the strict userRequested override fields", () => {
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		expect(Object.keys(tool.schema.properties)).toEqual([
			"operation",
			"prompt",
			"desiredName",
			"sourceImagePaths",
			"useConversationImages",
			"userRequestedAspectRatio",
			"userRequestedResolution",
			"userRequestedQuality",
		]);
	});

	it("rejects the legacy geometry and quality field names", async () => {
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		const legacyArgs: Record<string, unknown> = {
			operation: "generate",
			prompt: "a cat",
			desiredName: "cat",
			aspectRatio: "1:1",
			resolution: "4K",
			quality: "high",
		};
		const result = await tool.run(legacyArgs as Parameters<typeof tool.run>[0], {});
		expect(result).toEqual({
			ok: false,
			error:
				"InvalidTechnicalParameter: aspectRatio, resolution, quality are not valid. Use the corresponding userRequested* field only for an explicit user request; otherwise omit it for automatic source preservation.",
		});
	});

	it("rejects a single legacy field with a singular message", async () => {
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		const legacyArgs: Record<string, unknown> = {
			operation: "generate",
			prompt: "a cat",
			desiredName: "cat",
			quality: "high",
		};
		const result = await tool.run(legacyArgs as Parameters<typeof tool.run>[0], {});
		expect(result).toEqual({
			ok: false,
			error:
				"InvalidTechnicalParameter: quality is not valid. Use the corresponding userRequested* field only for an explicit user request; otherwise omit it for automatic source preservation.",
		});
	});

	it("fails when no image model is configured", async () => {
		const tool = openAgentImageGenerateTool(createApp(), () => settings({ imageModel: "" }));
		const result = await tool.run({ operation: "generate", prompt: "a cat", desiredName: "cat" }, {});
		expect(result).toEqual({
			ok: false,
			error: "ImageModelNotConfigured: choose an Image generation model in OpenAgent settings.",
		});
	});

	it("fails when the signal is already aborted", async () => {
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		const ctrl = new AbortController();
		ctrl.abort();
		const result = await tool.run(
			{ operation: "generate", prompt: "a cat", desiredName: "cat" },
			{ signal: ctrl.signal },
		);
		expect(result).toEqual({ ok: false, error: "ImageGenerationAborted" });
	});

	it("saves the generated image at the vault root and returns its path", async () => {
		const fetchMock = stubGenerationResponse();
		const app = createApp();
		const tool = openAgentImageGenerateTool(app, () => settings());
		const result = await tool.run({ operation: "generate", prompt: "a cat", desiredName: "cat" }, {});
		expect(result).toEqual({
			ok: true,
			value: {
				path: "cat.png",
				markdownEmbed: "![[cat.png]]",
				mimeType: "image/png",
				size: 8,
				model: "google/gemini-3.1-flash-image-preview",
				referenceImagesUsed: 0,
				referenceImageNames: [],
				operation: "generate",
				prompt: "a cat",
			},
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://gateway.example/v1/images",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("sends an edit source image and reports the reference names", async () => {
		const fetchMock = stubGenerationResponse();
		const app = createApp({ files: { "img/a.png": { size: 8, bytes: PNG_BYTES } } });
		const tool = openAgentImageGenerateTool(app, () => settings());
		const result = await tool.run(
			{ operation: "edit", prompt: "a cat in a hat", desiredName: "cat", sourceImagePaths: ["img/a.png"] },
			{},
		);
		expect(result).toEqual({
			ok: true,
			value: {
				path: "cat.png",
				markdownEmbed: "![[cat.png]]",
				mimeType: "image/png",
				size: 8,
				model: "google/gemini-3.1-flash-image-preview",
				referenceImagesUsed: 1,
				referenceImageNames: ["img/a.png"],
				operation: "edit",
				prompt: "a cat in a hat",
			},
		});
		const body = JSON.parse(
			(fetchMock.mock.calls.at(-1)?.[1] as { body: string }).body,
		) as { input_references?: unknown[] };
		expect(body.input_references).toHaveLength(1);
	});

	it("fails an edit when no source image is available", async () => {
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		const result = await tool.run(
			{ operation: "edit", prompt: "a cat in a hat", desiredName: "cat" },
			{ getConversationImages: async () => [] },
		);
		expect(result).toEqual({
			ok: false,
			error:
				"SourceImageRequired: editing requires sourceImagePaths or a usable image already shown/attached in this conversation",
		});
	});

	it("reports a provider error for HTTP failures", async () => {
		stubGenerationResponse("boom", 500);
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		const result = await tool.run({ operation: "generate", prompt: "a cat", desiredName: "cat" }, {});
		expect(result).toEqual({
			ok: false,
			error: "ImageGenerationProviderError: HTTP 500: boom",
		});
	});
});

describe("openAgentImageGenerateTool cancellation", () => {
	function createBinarySpy(app: App): ReturnType<typeof vi.fn> {
		return (app.vault as unknown as { createBinary: ReturnType<typeof vi.fn> }).createBinary;
	}

	it("passes the signal to the image-generation request and stops on abort", async () => {
		const fetchMock = stubGenerationResponse();
		const controller = new AbortController();
		const app = createApp();
		const createBinary = createBinarySpy(app);
		const tool = openAgentImageGenerateTool(app, () => settings());
		const promise = tool.run(
			{ operation: "generate", prompt: "a cat", desiredName: "cat" },
			{ signal: controller.signal },
		);
		controller.abort();
		expect(await promise).toMatchObject({ ok: false, error: "ImageGenerationAborted" });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(createBinary).not.toHaveBeenCalled();
	});

	it("links the caller signal to a controller and detaches the listener", async () => {
		const fetchMock = stubGenerationResponse();
		const controller = new AbortController();
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
		const tool = openAgentImageGenerateTool(createApp(), () => settings());
		await tool.run(
			{ operation: "generate", prompt: "a cat", desiredName: "cat" },
			{ signal: controller.signal },
		);
		const init = fetchMock.mock.calls.at(-1)?.[1] as { signal?: AbortSignal };
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init.signal).not.toBe(controller.signal);
		expect(init.signal?.aborted).toBe(false);
		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("times out the pending request and never writes a file", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(
			(_url: string, init: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const app = createApp();
		const createBinary = createBinarySpy(app);
		const tool = openAgentImageGenerateTool(app, () => settings());
		const promise = tool.run({ operation: "generate", prompt: "a cat", desiredName: "cat" }, {});
		await vi.advanceTimersByTimeAsync(OA_IMAGE_GENERATION_TIMEOUT_MS);
		const result = await promise;
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toBe(
			`ImageGenerationTimeout: image generation exceeded ${OA_IMAGE_GENERATION_TIMEOUT_MS / 1000} seconds`,
		);
		expect(createBinary).not.toHaveBeenCalled();
	});

	it("fails a late requestUrl response without writing a file", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", undefined);
		let resolveRequest: (value: { status: number; text: string }) => void = () => undefined;
		mocks.requestUrlMock.mockReturnValue(
			new Promise((resolve) => {
				resolveRequest = resolve;
			}),
		);
		const app = createApp();
		const createBinary = createBinarySpy(app);
		const tool = openAgentImageGenerateTool(app, () => settings());
		const promise = tool.run({ operation: "generate", prompt: "a cat", desiredName: "cat" }, {});
		await vi.advanceTimersByTimeAsync(OA_IMAGE_GENERATION_TIMEOUT_MS);
		resolveRequest({ status: 200, text: JSON.stringify({ data: [{ b64_json: PNG_B64 }] }) });
		const result = await promise;
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toBe(
			`ImageGenerationTimeout: image generation exceeded ${OA_IMAGE_GENERATION_TIMEOUT_MS / 1000} seconds`,
		);
		expect(createBinary).not.toHaveBeenCalled();
	});

	it("falls back to requestUrl when fetch is unavailable", async () => {
		vi.stubGlobal("fetch", undefined);
		mocks.requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({ data: [{ b64_json: PNG_B64 }] }),
		});
		const app = createApp();
		const createBinary = createBinarySpy(app);
		const tool = openAgentImageGenerateTool(app, () => settings());
		const result = await tool.run({ operation: "generate", prompt: "a cat", desiredName: "cat" }, {});
		expect(result.ok).toBe(true);
		expect(mocks.requestUrlMock).toHaveBeenCalledTimes(1);
		const request = mocks.requestUrlMock.mock.calls[0][0] as {
			url: string;
			method: string;
			body: string;
		};
		expect(request.url).toBe("https://gateway.example/v1/images");
		expect(request.method).toBe("POST");
		expect(JSON.parse(request.body)).toMatchObject({ prompt: "a cat", output_format: "png" });
		expect(createBinary).toHaveBeenCalledTimes(1);
	});
});
