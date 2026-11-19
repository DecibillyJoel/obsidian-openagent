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
	web?: { title?: string; uri?: string };
}

interface GeminiCandidate {
	content?: { parts?: GeminiPart[] };
	groundingMetadata?: { groundingChunks?: GeminiChunk[] };
}

interface GeminiAnswer {
	candidates?: GeminiCandidate[];
}

/** Parse a response body, and return `null` when the body is not a JSON object. */
function oaParseGeminiAnswer(body: string): GeminiAnswer | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as GeminiAnswer;
	} catch {
		return null;
	}
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

			const response = await requestUrl({
				url: `${ENDPOINT}/${model}:generateContent`,
				method: "POST",
				headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ role: "user", parts: [{ text: args.query }] }],
					tools: [{ googleSearch: {} }],
				}),
				throw: false,
			}).catch(() => null);
			if (!response) return fail(NETWORK_ERROR);

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
				.filter((web): web is { title?: string; uri?: string } => web !== undefined)
				.map((web) => ({ title: web.title ?? "", uri: web.uri ?? "" }));

			const value: ResearchAnswer = { text, sources, model };
			return ok(value);
		},
	});
}
