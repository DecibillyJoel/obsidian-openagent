import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/settings";
import { ToolRegistry } from "../../src/tools/registry";
import { webTools } from "../../src/tools/web";
import type { ToolDef, ToolResult } from "../../src/types";
import { requestUrlMock } from "../setup";

const KEY = "fake-gemini-key-not-a-real-secret";
const DEFAULT_MODEL = "gemini-flash-latest";
const QUERY = "What changed in Obsidian 1.9?";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const NETWORK_ERROR = "GeminiNetworkError: the request to Gemini did not complete";
const REDACTED = "[redacted]";

const SUCCESS_JSON = {
	candidates: [
		{
			content: { role: "model", parts: [{ text: "Obsidian 1.9 added " }, { text: "a new settings search." }] },
			groundingMetadata: {
				groundingChunks: [
					{ web: { title: "Obsidian changelog", uri: "https://obsidian.md/changelog/" } },
					{ web: { title: "Obsidian help", uri: "https://help.obsidian.md/" } },
				],
			},
		},
	],
};

function jsonResponse(status: number, json: unknown): { status: number; json: unknown; text: string } {
	return { status, json, text: JSON.stringify(json) };
}

/** A response with a body that is not JSON, and no parsed `json` field at all. */
function rawResponse(status: number, text: string): { status: number; text: string } {
	return { status, text };
}

function settingsWith(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return { ...DEFAULT_SETTINGS, geminiApiKey: KEY, ...overrides };
}

function researchTool(settings: PluginSettings = settingsWith()): ToolDef {
	const tool = webTools(() => settings).find((candidate) => candidate.name === "research");
	if (!tool) throw new Error("Missing tool: research");
	return tool;
}

function runResearch(settings: PluginSettings = settingsWith()): Promise<ToolResult> {
	return researchTool(settings).run({ query: QUERY }, {});
}

function errorOf(result: ToolResult): string {
	if (result.ok) throw new Error("Expected a failure result");
	return result.error;
}

function requestAt(index = 0): {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
} {
	const call = recordedRequest(index) as
		| { url: string; method?: string; headers?: Record<string, string>; body?: string }
		| undefined;
	if (!call) throw new Error("No request was made");
	return { url: call.url, method: call.method ?? "GET", headers: call.headers ?? {}, body: call.body ?? "" };
}

/** The argument of the recorded `requestUrl` call at `index`, with no type of its own. */
function recordedRequest(index: number): unknown {
	const call = requestUrlMock.mock.calls[index] as unknown[] | undefined;
	return call?.[0];
}

describe("research tool", () => {
	it("calls generateContent on the configured model with the key header and the Google Search tool", async () => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(200, SUCCESS_JSON));

		await runResearch();

		expect(requestUrlMock).toHaveBeenCalledTimes(1);
		const request = requestAt();
		expect(request.url).toBe(`${ENDPOINT}/${DEFAULT_MODEL}:generateContent`);
		expect(request.method).toBe("POST");
		expect(request.headers).toEqual({
			"x-goog-api-key": KEY,
			"Content-Type": "application/json",
		});
		expect(JSON.parse(request.body)).toEqual({
			contents: [{ role: "user", parts: [{ text: QUERY }] }],
			tools: [{ googleSearch: {} }],
		});
	});

	it("sends exactly the stated request options, with the throw of requestUrl off", async () => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(200, SUCCESS_JSON));

		await runResearch();

		expect(recordedRequest(0)).toEqual({
			url: `${ENDPOINT}/${DEFAULT_MODEL}:generateContent`,
			method: "POST",
			headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text: QUERY }] }],
				tools: [{ googleSearch: {} }],
			}),
			throw: false,
		});
	});

	it("sends the model from settings in the URL", async () => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(200, SUCCESS_JSON));

		await runResearch(settingsWith({ geminiModel: "gemini-2.5-pro" }));

		expect(requestAt().url).toBe(`${ENDPOINT}/gemini-2.5-pro:generateContent`);
	});

	it("URL-encodes the model name", async () => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(200, SUCCESS_JSON));

		await runResearch(settingsWith({ geminiModel: "gemini/2.5 flash" }));

		expect(requestAt().url).toBe(`${ENDPOINT}/gemini%2F2.5%20flash:generateContent`);
	});

	it("joins the candidate text parts and maps the grounding chunks to sources", async () => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(200, SUCCESS_JSON));

		const result = await runResearch();

		expect(result).toEqual({
			ok: true,
			value: {
				text: "Obsidian 1.9 added a new settings search.",
				sources: [
					{ title: "Obsidian changelog", uri: "https://obsidian.md/changelog/" },
					{ title: "Obsidian help", uri: "https://help.obsidian.md/" },
				],
				model: DEFAULT_MODEL,
			},
		});
	});

	it("returns the model from settings in the result", async () => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(200, SUCCESS_JSON));

		const result = await runResearch(settingsWith({ geminiModel: "gemini-2.5-pro" }));

		expect(result.ok && (result.value as { model: string }).model).toBe("gemini-2.5-pro");
	});

	it("returns no sources when the answer has no grounding metadata", async () => {
		requestUrlMock.mockResolvedValueOnce(
			jsonResponse(200, { candidates: [{ content: { parts: [{ text: "Plain answer." }] } }] }),
		);

		const result = await runResearch();

		expect(result).toEqual({ ok: true, value: { text: "Plain answer.", sources: [], model: DEFAULT_MODEL } });
	});

	it("skips a grounding chunk that has no web field, including a null web field", async () => {
		requestUrlMock.mockResolvedValueOnce(
			jsonResponse(200, {
				candidates: [
					{
						content: { parts: [{ text: "Kept answer." }] },
						groundingMetadata: {
							groundingChunks: [
								{},
								{ web: null },
								{ web: { title: "Kept source", uri: "https://example.com/kept" } },
							],
						},
					},
				],
			}),
		);

		const result = await runResearch();

		expect(result).toEqual({
			ok: true,
			value: {
				text: "Kept answer.",
				sources: [{ title: "Kept source", uri: "https://example.com/kept" }],
				model: DEFAULT_MODEL,
			},
		});
	});

	it("maps a chunk with a missing title or uri to an empty string", async () => {
		requestUrlMock.mockResolvedValueOnce(
			jsonResponse(200, {
				candidates: [
					{
						content: { parts: [{ text: "Answer." }] },
						groundingMetadata: {
							groundingChunks: [
								{ web: { uri: "https://example.com/no-title" } },
								{ web: { title: "No uri" } },
							],
						},
					},
				],
			}),
		);

		const result = await runResearch();

		expect(result).toEqual({
			ok: true,
			value: {
				text: "Answer.",
				sources: [
					{ title: "", uri: "https://example.com/no-title" },
					{ title: "No uri", uri: "" },
				],
				model: DEFAULT_MODEL,
			},
		});
	});

	it("is unavailable without a key and is then absent from the registry list", () => {
		const settings = settingsWith({ geminiApiKey: "" });
		expect(researchTool(settings).isAvailable?.()).toBe(false);

		const registry = new ToolRegistry();
		registry.registerAll(webTools(() => settings));

		expect(registry.list().map((tool) => tool.name)).toEqual(["web_fetch", "web_read"]);
		expect(registry.get("research")).toBeUndefined();
	});

	it("is unavailable when the key holds only spaces", () => {
		expect(researchTool(settingsWith({ geminiApiKey: "   " })).isAvailable?.()).toBe(false);
	});

	it("is available with a key and is then listed by the registry", () => {
		const settings = settingsWith();
		expect(researchTool(settings).isAvailable?.()).toBe(true);

		const registry = new ToolRegistry();
		registry.registerAll(webTools(() => settings));

		expect(registry.list().map((tool) => tool.name)).toEqual(["web_fetch", "web_read", "research"]);
	});

	it("states that it is read-only, web-categorised, and time-limited", () => {
		const tool = researchTool();
		expect(tool.category).toBe("web");
		expect(tool.mutates).toBe(false);
		expect(tool.timeoutMs).toBe(60_000);
		expect(tool.schema.required).toEqual(["query"]);
		expect(tool.schema.properties.query.type).toBe("string");
	});

	it.each([
		{ label: "HTTP 400", status: 400, json: { error: { code: 400 } }, error: "GeminiRequestRejected" },
		{ label: "HTTP 403", status: 403, json: { error: { code: 403 } }, error: "GeminiRequestRejected" },
		{ label: "HTTP 429", status: 429, json: { error: { code: 429 } }, error: "GeminiRateLimited" },
		{ label: "an empty candidate list", status: 200, json: { candidates: [] }, error: "GeminiNoAnswer" },
		{ label: "a body without candidates", status: 200, json: {}, error: "GeminiNoAnswer" },
	])("maps $label to $error", async ({ status, json, error }) => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(status, json));

		const result = await runResearch();

		expect(result.ok).toBe(false);
		expect(errorOf(result).startsWith(error)).toBe(true);
		expect(errorOf(result)).toContain(String(status));
	});

	it("maps a rejected transport call to GeminiNetworkError", async () => {
		requestUrlMock.mockRejectedValueOnce(new Error("socket hang up"));

		const result = await runResearch();

		expect(result.ok).toBe(false);
		expect(errorOf(result).startsWith("GeminiNetworkError")).toBe(true);
	});

	it("keeps the transport cause in the details of the failure", async () => {
		requestUrlMock.mockRejectedValueOnce(new Error("socket hang up"));

		const result = await runResearch();

		expect(result).toEqual({ ok: false, error: NETWORK_ERROR, details: { cause: "socket hang up" } });
	});

	it("keeps a non-Error transport rejection as its text in the details", async () => {
		requestUrlMock.mockRejectedValueOnce("socket hung up");

		const result = await runResearch();

		expect(result).toEqual({ ok: false, error: NETWORK_ERROR, details: { cause: "socket hung up" } });
	});

	it("hides the key inside the transport cause", async () => {
		requestUrlMock.mockRejectedValueOnce(new Error(`rejected while sending ${KEY}`));

		const result = await runResearch();

		expect(JSON.stringify(result)).not.toContain(KEY);
		expect(JSON.stringify(result)).toContain(REDACTED);
	});

	it("never returns the key in a success or a failure result", async () => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(200, SUCCESS_JSON));
		const success = await runResearch();
		expect(JSON.stringify(success)).not.toContain(KEY);

		for (const [status, json] of [
			[403, { error: { code: 403 } }],
			[429, { error: { code: 429 } }],
			[200, {}],
		] as const) {
			requestUrlMock.mockResolvedValueOnce(jsonResponse(status, json));
			const failure = await runResearch();
			expect(JSON.stringify(failure)).not.toContain(KEY);
		}

		requestUrlMock.mockRejectedValueOnce(new Error(`rejected while sending ${KEY}`));
		const network = await runResearch();
		expect(JSON.stringify(network)).not.toContain(KEY);
	});

	it("maps a 404 for an unknown model to GeminiRequestRejected with the status", async () => {
		requestUrlMock.mockResolvedValueOnce(
			jsonResponse(404, { error: { code: 404, message: "models/gemini-9.9 is not found for API version v1beta" } }),
		);

		const result = await runResearch();

		expect(result.ok).toBe(false);
		expect(errorOf(result).startsWith("GeminiRequestRejected")).toBe(true);
		expect(errorOf(result)).toContain("HTTP 404");
		expect(errorOf(result)).not.toContain("GeminiNoAnswer");
	});

	it("maps a 500 HTML error page to GeminiRequestRejected and not to GeminiNoAnswer", async () => {
		requestUrlMock.mockResolvedValueOnce(
			rawResponse(500, "<!DOCTYPE html><html><body><h1>Internal Server Error</h1></body></html>"),
		);

		const result = await runResearch();

		expect(result.ok).toBe(false);
		expect(errorOf(result).startsWith("GeminiRequestRejected")).toBe(true);
		expect(errorOf(result)).toContain("HTTP 500");
		expect(errorOf(result)).not.toContain("GeminiNoAnswer");
	});

	it("does not throw for a 502 with a non-JSON body and returns GeminiRequestRejected", async () => {
		requestUrlMock.mockResolvedValueOnce(rawResponse(502, "upstream connect error or disconnect/reset before headers"));

		const result = await runResearch();

		expect(result.ok).toBe(false);
		expect(errorOf(result).startsWith("GeminiRequestRejected")).toBe(true);
		expect(errorOf(result)).toContain("HTTP 502");
	});

	it("maps a 200 with a non-JSON body to GeminiRequestRejected instead of throwing", async () => {
		requestUrlMock.mockResolvedValueOnce(rawResponse(200, "<html><body>not a candidate list</body></html>"));

		const result = await runResearch();

		expect(result.ok).toBe(false);
		expect(errorOf(result).startsWith("GeminiRequestRejected")).toBe(true);
		expect(errorOf(result)).toContain("HTTP 200");
		expect(errorOf(result)).not.toContain("GeminiNoAnswer");
	});

	it("rejects a JSON array body, because it is not a JSON object", async () => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(200, []));

		const result = await runResearch();

		expect(result.ok).toBe(false);
		expect(errorOf(result).startsWith("GeminiRequestRejected")).toBe(true);
		expect(errorOf(result)).toContain("HTTP 200");
		expect(errorOf(result)).not.toContain("GeminiNoAnswer");
	});
});
