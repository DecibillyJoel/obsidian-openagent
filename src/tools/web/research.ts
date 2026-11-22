import { requestUrl } from "obsidian";
import { oaGeminiSettings, type PluginSettings } from "../../settings";
import type { ToolDef } from "../../types";
import { defineTool, fail, ok } from "../define";

interface WebResearchArgs {
	query: string;
}

interface GeminiPart {
	text?: string;
}

interface GeminiChunk {
	web?: { title?: string; uri?: string } | null;
}

interface GeminiCandidate {
	content?: { parts?: GeminiPart[] };
	groundingMetadata?: { groundingChunks?: GeminiChunk[] };
}

interface GeminiAnswer {
	candidates?: GeminiCandidate[];
}

/** Parse a response body, and return `null` unless it is a JSON object that is not an array. */
function oaParseGeminiAnswer(body: string): GeminiAnswer | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as GeminiAnswer;
	} catch {
		return null;
	}
}

/** Read the text of a transport rejection, and hide the API key when the text holds it. */
function oaCauseText(error: unknown, apiKey: string): string {
	const text = error instanceof Error ? error.message : String(error);
	return apiKey.length === 0 ? text : text.split(apiKey).join("[redacted]");
}

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const REQUEST_REJECTED = "GeminiRequestRejected";
const RATE_LIMITED = "GeminiRateLimited";
const NO_ANSWER = "GeminiNoAnswer";
const NETWORK_ERROR = "GeminiNetworkError: the request to Gemini did not complete";

export interface ResearchSource {
	title: string;
	uri: string;
}

export interface ResearchAnswer {
	text: string;
	sources: ResearchSource[];
	model: string;
}

export function webResearchTool(getSettings: () => PluginSettings): ToolDef<WebResearchArgs> {
	return defineTool<WebResearchArgs>({
		name: "research",
		description:
			"Answer one research question with Google Search grounding and return the answer text with its source links. Use short, self-contained queries.",
		category: "web",
		mutates: false,
		timeoutMs: 60_000,
		isAvailable: () => oaGeminiSettings(getSettings()).apiKey.length > 0,
		schema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Research question to answer." },
			},
			required: ["query"],
		},
		async run(args) {
			const { apiKey, model } = oaGeminiSettings(getSettings());
			if (apiKey.length === 0) return fail(`${REQUEST_REJECTED}: no Gemini API key is set`);

			let transportError: unknown = null;
			const response = await requestUrl({
				url: `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
				method: "POST",
				headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ role: "user", parts: [{ text: args.query }] }],
					tools: [{ googleSearch: {} }],
				}),
				throw: false,
			}).catch((error: unknown) => {
				transportError = error;
				return null;
			});
			if (!response) return fail(NETWORK_ERROR, { cause: oaCauseText(transportError, apiKey) });

			if (response.status === 400 || response.status === 403) {
				return fail(`${REQUEST_REJECTED}: Gemini refused the request with HTTP ${response.status}`);
			}
			if (response.status === 429) {
				return fail(`${RATE_LIMITED}: Gemini returned HTTP 429, retry later`);
			}
			if (response.status < 200 || response.status >= 300) {
				return fail(`${REQUEST_REJECTED}: Gemini returned HTTP ${response.status}`);
			}

			const answer = oaParseGeminiAnswer(response.text ?? "");
			if (!answer) {
				return fail(`${REQUEST_REJECTED}: Gemini returned HTTP ${response.status} with a body that is not JSON`);
			}

			const candidate = answer.candidates?.[0];
			if (!candidate) return fail(`${NO_ANSWER}: Gemini returned no answer candidate, HTTP ${response.status}`);

			const text = (candidate.content?.parts ?? []).map((part) => part.text ?? "").join("");
			const sources: ResearchSource[] = (candidate.groundingMetadata?.groundingChunks ?? [])
				.map((chunk) => chunk.web)
				.filter((web): web is { title?: string; uri?: string } => web != null)
				.map((web) => ({ title: web.title ?? "", uri: web.uri ?? "" }));

			const value: ResearchAnswer = { text, sources, model };
			return ok(value);
		},
	});
}
