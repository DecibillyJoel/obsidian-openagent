import { requestUrl } from "obsidian";

export const GEMINI_MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Markers that name a Gemini model Google does not publish for text answers.
 * The list endpoint carries no field for this, so the id is the only signal.
 */
const NON_TEXT_MARKERS = [
	"image",
	"tts",
	"live",
	"audio",
	"embedding",
	"transcribe",
	"robotics",
	"computer-use",
	"nano-banana",
];

interface GeminiModelRecord {
	name?: unknown;
	supportedGenerationMethods?: unknown;
}

interface GeminiModelsBody {
	models?: unknown;
}

/**
 * True when the record names a Gemini model that can answer a text prompt.
 *
 * Three conditions hold: the id is a Gemini id, the record supports
 * `generateContent`, and the id holds no non-text marker.
 */
export function oaIsGeminiTextModelId(id: string, methods: readonly string[]): boolean {
	if (!id.startsWith("gemini-")) return false;
	if (!methods.includes("generateContent")) return false;
	const low = id.toLowerCase();
	return !NON_TEXT_MARKERS.some((marker) => low.includes(marker));
}

/**
 * Read the Gemini model list body and return the text model ids, sorted.
 *
 * A body that is not a JSON object with a `models` array gives an empty list,
 * as does a record without a readable name.
 */
export function oaParseGeminiModelIds(text: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
	const models = (parsed as GeminiModelsBody).models;
	if (!Array.isArray(models)) return [];

	const ids: string[] = [];
	for (const raw of models) {
		if (typeof raw !== "object" || raw === null) continue;
		const record = raw as GeminiModelRecord;
		if (typeof record.name !== "string") continue;
		const id = record.name.replace(/^models\//, "");
		const methods = Array.isArray(record.supportedGenerationMethods)
			? record.supportedGenerationMethods.filter((method): method is string => typeof method === "string")
			: [];
		if (oaIsGeminiTextModelId(id, methods)) ids.push(id);
	}
	return ids.sort((a, b) => a.localeCompare(b));
}

/**
 * Fetch the Gemini text model ids.
 *
 * A blank key sends nothing. A rejected call, a status outside 2xx, and a body
 * that is not a model list all give an empty list, so the caller can fall back
 * to the stored model without an error path of its own.
 */
export async function oaGeminiTextModelIds(apiKey: string): Promise<string[]> {
	const key = apiKey.trim();
	if (key.length === 0) return [];

	let response: { status: number; text: string } | null = null;
	try {
		response = await requestUrl({
			url: `${GEMINI_MODELS_ENDPOINT}?pageSize=1000`,
			method: "GET",
			headers: { "x-goog-api-key": key },
			throw: false,
		});
	} catch {
		return [];
	}
	if (response.status < 200 || response.status >= 300) return [];
	return oaParseGeminiModelIds(response.text ?? "");
}
