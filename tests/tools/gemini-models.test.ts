import { describe, expect, it } from "vitest";
import {
	GEMINI_MODELS_ENDPOINT,
	oaGeminiTextModelIds,
	oaIsGeminiTextModelId,
	oaParseGeminiModelIds,
} from "../../src/tools/web/gemini-models";
import { requestUrlMock } from "../setup";

const ALL_METHODS = ["generateContent", "countTokens"];

function modelsReply(entries: Array<{ name: string; methods?: string[] }>): string {
	return JSON.stringify({
		models: entries.map((entry) => ({
			name: entry.name,
			supportedGenerationMethods: entry.methods ?? ALL_METHODS,
		})),
	});
}

describe("oaIsGeminiTextModelId", () => {
	it("keeps a Gemini text model", () => {
		expect(oaIsGeminiTextModelId("gemini-3.8-flash", ALL_METHODS)).toBe(true);
		expect(oaIsGeminiTextModelId("gemini-flash-latest", ALL_METHODS)).toBe(true);
		expect(oaIsGeminiTextModelId("gemini-pro-latest", ALL_METHODS)).toBe(true);
	});

	it("drops a model from another family", () => {
		expect(oaIsGeminiTextModelId("gemma-4-31b-it", ALL_METHODS)).toBe(false);
		expect(oaIsGeminiTextModelId("deep-research-preview-04-2026", ALL_METHODS)).toBe(false);
		expect(oaIsGeminiTextModelId("antigravity-preview-latest", ALL_METHODS)).toBe(false);
	});

	it("drops a Gemini model that is not text", () => {
		const ids = [
			"gemini-3.1-flash-image",
			"gemini-2.5-flash-preview-tts",
			"gemini-3.8-flash-tts",
			"gemini-3.8-live",
			"gemini-2.5-flash-native-audio-latest",
			"gemini-3.5-transcribe",
			"gemini-robotics-er-2-preview",
			"gemini-2.5-computer-use-preview-10-2025",
			"gemini-nano-banana-2.1",
			"gemini-embedding-2",
		];
		for (const id of ids) expect(oaIsGeminiTextModelId(id, ALL_METHODS)).toBe(false);
	});

	it("drops a record that cannot generate content", () => {
		expect(oaIsGeminiTextModelId("gemini-3.8-flash", [])).toBe(false);
		expect(oaIsGeminiTextModelId("gemini-3.8-flash", ["countTokens"])).toBe(false);
		expect(oaIsGeminiTextModelId("gemini-3.8-flash", ["embedContent", "generateContent"])).toBe(true);
	});
});

describe("oaParseGeminiModelIds", () => {
	it("reads the id from the name field and strips the models prefix", () => {
		expect(oaParseGeminiModelIds(modelsReply([{ name: "models/gemini-3.8-flash" }]))).toEqual([
			"gemini-3.8-flash",
		]);
	});

	it("returns the kept ids sorted", () => {
		const text = modelsReply([
			{ name: "models/gemini-3.8-flash" },
			{ name: "models/gemini-flash-latest" },
			{ name: "models/gemini-2.5-flash" },
		]);
		expect(oaParseGeminiModelIds(text)).toEqual(["gemini-2.5-flash", "gemini-3.8-flash", "gemini-flash-latest"]);
	});

	it("returns an empty list for a body that is not JSON", () => {
		expect(oaParseGeminiModelIds("not json at all")).toEqual([]);
	});

	it("returns an empty list when the body holds no models array", () => {
		expect(oaParseGeminiModelIds(JSON.stringify({ error: { code: 400 } }))).toEqual([]);
		expect(oaParseGeminiModelIds(JSON.stringify(["gemini-3.8-flash"]))).toEqual([]);
	});

	it("skips a record whose name is not a string", () => {
		const text = JSON.stringify({
			models: [{ name: 42 }, { name: "models/gemini-3.8-flash", supportedGenerationMethods: ALL_METHODS }],
		});
		expect(oaParseGeminiModelIds(text)).toEqual(["gemini-3.8-flash"]);
	});
});

describe("oaGeminiTextModelIds", () => {
	it("sends one GET with the key header and the largest page", async () => {
		requestUrlMock.mockResolvedValue({ status: 200, text: modelsReply([{ name: "models/gemini-3.8-flash" }]) });
		await expect(oaGeminiTextModelIds("gem-key")).resolves.toEqual(["gemini-3.8-flash"]);
		const call = requestUrlMock.mock.calls.at(-1) as unknown[] | undefined;
		const request = call?.[0] as {
			url: string;
			method: string;
			headers: Record<string, string>;
			throw: boolean;
		};
		expect(request.url).toBe(`${GEMINI_MODELS_ENDPOINT}?pageSize=1000`);
		expect(request.method).toBe("GET");
		expect(request.headers["x-goog-api-key"]).toBe("gem-key");
		expect(request.throw).toBe(false);
	});

	it("sends nothing when the key is blank", async () => {
		await expect(oaGeminiTextModelIds("   ")).resolves.toEqual([]);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("returns an empty list for a rejected status", async () => {
		requestUrlMock.mockResolvedValue({ status: 401, text: modelsReply([{ name: "models/gemini-3.8-flash" }]) });
		await expect(oaGeminiTextModelIds("gem-key")).resolves.toEqual([]);
	});

	it("returns an empty list when the request rejects", async () => {
		requestUrlMock.mockRejectedValue(new Error("offline"));
		await expect(oaGeminiTextModelIds("gem-key")).resolves.toEqual([]);
	});
});
