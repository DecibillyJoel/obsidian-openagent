import { requestUrl } from "obsidian";
import {
	type AssembledToolCall,
	AuthError,
	type ChatMessage,
	type ModelProvider,
	NetworkError,
	type OpenAiToolSpec,
	ProviderError,
	RateLimitError,
	type StreamEvent,
	type StreamOptions,
} from "./types";
import type { OpenAICompatibleConfig } from "./provider-config";
import { oaStreamChatDeltas } from "./streaming/chat-stream";
import { oaReasoningDetailText, oaSplitThinking } from "./streaming/reasoning";

interface ToolCallBuffer {
	id: string;
	index: number;
	name: string;
	args: string;
}

export class OpenAICompatibleProvider implements ModelProvider {
	private readonly config: OpenAICompatibleConfig;

	constructor(config: OpenAICompatibleConfig) {
		this.config = config;
	}

	async *stream(messages: ChatMessage[], opts: StreamOptions = {}): AsyncIterable<StreamEvent> {
		if (opts.signal?.aborted) return;

		const url = this.endpoint();
		const tools = opts.tools && opts.tools.length > 0 ? opts.tools : undefined;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.config.apiKey}`,
		};
		const imageMode = oaImageOutputModels.has(this.config.model);

		let responseText = "";
		let responseStatus = 0;
		let degraded = false;
		// After the first streamed delta the requestUrl fallback must not run.
		// A second request would bill the user twice.
		let sawDelta = false;
		try {
			if (typeof fetch === "function") {
				try {
					const response = await fetch(url, {
						method: "POST",
						headers,
						body: completionBody(this.config.model, messages, tools, opts.responseFormat, imageMode, true),
						signal: opts.signal,
					});
					if (opts.signal?.aborted) return;
					const contentType = response.headers.get("content-type") ?? "";
					if (response.ok && response.body && contentType.includes("text/event-stream")) {
						let emittedReasoning = "";
						let finishReason: string | undefined;
						for await (const delta of oaStreamChatDeltas(response.body)) {
							sawDelta = true;
							if (delta.reasoning !== undefined) {
								emittedReasoning += delta.reasoning;
								yield { kind: "thinking_text", text: delta.reasoning };
							}
							if (delta.reasoningDetails) {
								const detailText = oaReasoningDetailText(delta.reasoningDetails);
								if (detailText.length > 0 && !emittedReasoning.includes(detailText)) {
									emittedReasoning += detailText;
									yield { kind: "thinking_text", text: detailText };
								}
							}
							if (delta.content !== undefined) {
								yield { kind: "text", text: delta.content };
							}
							if (delta.images && delta.images.length > 0) {
								yield { kind: "images", urls: delta.images };
							}
							if (delta.toolCalls && delta.toolCalls.length > 0) {
								yield { kind: "tool_call_assembled", calls: delta.toolCalls };
							}
							if (delta.finishReason !== undefined) finishReason = delta.finishReason;
						}
						if (opts.signal?.aborted) return;
						yield { kind: "done", finishReason: mapFinishReason(finishReason) };
						return;
					}
				} catch (err) {
					if (isAbortError(err) || opts.signal?.aborted) return;
					// Bytes already arrived: report the error instead of billing a second request.
					if (sawDelta) throw err;
				}
			}

			const primary = await requestCompletion(
				url,
				headers,
				this.config.model,
				messages,
				tools,
				opts.responseFormat,
				imageMode,
			);
			responseText = primary.text;
			responseStatus = primary.status;
			if (opts.responseFormat && shouldRetryWithoutResponseFormat(primary.status, primary.text)) {
				const fallback = await requestCompletion(url, headers, this.config.model, messages, tools, undefined, imageMode);
				responseText = fallback.text;
				responseStatus = fallback.status;
				degraded = true;
			}
		} catch (err) {
			if (isAbortError(err) || opts.signal?.aborted) return;
			throw new NetworkError(redactNetworkError(err));
		}

		if (opts.signal?.aborted) return;

		if (responseStatus >= 400) {
			throw mapHttpError(responseStatus, responseText);
		}

		const choice = parseChatCompletionChoice(responseText);
		if (!choice) throw new ProviderError("Malformed response from completion endpoint");

		const { text, thinking } = extractThinking(choice.message);
		if (thinking.length > 0) {
			yield { kind: "thinking_text", text: thinking };
		}
		if (text.length > 0) {
			yield { kind: "text", text, degraded: degraded || undefined };
		}

		const urls = oaResponseImageUrls(choice.message);
		if (urls.length > 0) {
			yield { kind: "images", urls };
		}

		const calls = parseCompletionToolCalls(choice.message?.tool_calls);
		if (calls.length > 0) {
			yield { kind: "tool_call_assembled", calls, degraded: degraded || undefined };
			yield { kind: "done", finishReason: "tool_calls" };
		} else {
			yield { kind: "done", finishReason: mapFinishReason(choice.finish_reason ?? undefined) };
		}
	}

	async listModels(): Promise<string[]> {
		try {
			const base = this.config.baseUrl.replace(/\/$/, "");
			const res = await requestUrl({
				url: `${base}/models`,
				method: "GET",
				headers: { Authorization: `Bearer ${this.config.apiKey}` },
				throw: false,
			});
			if (res.status >= 400) return [];
			oaRememberImageOutputModels(res.text);
			return oaFilterModelIds(res.text, "text").sort();
		} catch {
			return [];
		}
	}

	private endpoint(): string {
		const base = this.config.baseUrl.replace(/\/$/, "");
		return `${base}/chat/completions`;
	}
}

export type { OpenAiToolSpec };
export type { OpenAICompatibleConfig } from "./provider-config";

async function requestCompletion(
	url: string,
	headers: Record<string, string>,
	model: string,
	messages: ChatMessage[],
	tools?: OpenAiToolSpec[],
	responseFormat?: StreamOptions["responseFormat"],
	imageMode = false,
): Promise<{ status: number; text: string }> {
	const body = completionBody(model, messages, tools, responseFormat, imageMode, false);
	const response = await requestUrl({
		url,
		method: "POST",
		contentType: "application/json",
		headers,
		body,
		throw: false,
	});
	return { status: response.status, text: response.text };
}

function completionBody(
	model: string,
	messages: ChatMessage[],
	tools: OpenAiToolSpec[] | undefined,
	responseFormat: StreamOptions["responseFormat"],
	imageMode: boolean,
	stream: boolean,
): string {
	return JSON.stringify({
		model,
		messages,
		stream,
		...(tools ? { tools, tool_choice: "auto" } : {}),
		...(responseFormat ? { response_format: responseFormat } : {}),
		...(imageMode ? { modalities: ["text", "image"] } : {}),
	});
}

function mapHttpError(status: number, text: string): Error {
	if (status === 401 || status === 403) return new AuthError(`HTTP ${status}`);
	if (status === 429) return new RateLimitError(`HTTP ${status}`);
	const snippet = text.slice(0, 200);
	return new ProviderError(`HTTP ${status}: ${snippet}`, status);
}

function mapFinishReason(reason: string | undefined): "stop" | "tool_calls" | "length" | "content_filter" | "unknown" {
	if (reason === "stop" || reason === "tool_calls" || reason === "length" || reason === "content_filter") return reason;
	return "unknown";
}

function parseAssembled(buf: ToolCallBuffer): AssembledToolCall {
	let parsed: unknown;
	try {
		parsed = buf.args.length > 0 ? JSON.parse(buf.args) : {};
	} catch {
		parsed = { __parse_error: true, raw: buf.args };
	}
	return { id: buf.id, name: buf.name, arguments: parsed, rawArguments: buf.args };
}

function redactNetworkError(err: unknown): string {
	if (err instanceof Error) return err.message.replace(/Bearer [^\s]+/g, "Bearer ***");
	return "Network error";
}

function shouldRetryWithoutResponseFormat(status: number, text: string): boolean {
	if (![400, 404, 415, 422].includes(status)) return false;
	const lowered = text.toLowerCase();
	return lowered.includes("response_format") || lowered.includes("json_schema");
}

function parseChatCompletionChoice(responseText: string): {
	message?: {
		content?: unknown;
		tool_calls?: unknown;
		reasoning?: unknown;
		reasoning_content?: unknown;
		reasoning_details?: unknown;
		images?: unknown;
	};
	finish_reason?: string | null;
} | null {
	const parsed = parseJsonResponse(responseText);
	if (!isRecord(parsed) || !Array.isArray(parsed.choices) || parsed.choices.length === 0) return null;
	const choice = parsed.choices[0];
	if (!isRecord(choice)) return null;
	return {
		message: isRecord(choice.message)
			? {
				content: choice.message.content,
				tool_calls: choice.message.tool_calls,
				reasoning: choice.message.reasoning,
				reasoning_content: choice.message.reasoning_content,
				reasoning_details: choice.message.reasoning_details,
				images: choice.message.images,
			}
			: undefined,
		finish_reason:
			typeof choice.finish_reason === "string" || choice.finish_reason === null
				? choice.finish_reason
				: undefined,
	};
}

// EOS tokens that some local/open-source models leak into their output
const EOS_TOKENS = ["<|endoftext|>", "<|eot_id|>", "<|im_end|>", "<eos>", "</s>"];

function stripEosTokens(text: string): string {
	let result = text;
	for (const token of EOS_TOKENS) {
		result = result.replaceAll(token, "");
	}
	return result.trim();
}

function extractThinking(
	message: {
		content?: unknown;
		reasoning?: unknown;
		reasoning_content?: unknown;
		reasoning_details?: unknown;
	} | undefined,
): { text: string; thinking: string } {
	const split = oaSplitThinking({
		content: extractMessageText(message?.content),
		reasoning: message?.reasoning,
		reasoning_content: message?.reasoning_content,
		reasoning_details: message?.reasoning_details,
	});
	return { text: stripEosTokens(split.text), thinking: split.thinking };
}

function parseCompletionToolCalls(value: unknown): AssembledToolCall[] {
	if (!Array.isArray(value)) return [];
	const calls: AssembledToolCall[] = [];
	for (let index = 0; index < value.length; index++) {
		const toolCall = parseResponseToolCall(value[index], index);
		if (toolCall) calls.push(toolCall);
	}
	return calls;
}

function parseResponseToolCall(value: unknown, index: number): AssembledToolCall | null {
	if (!isRecord(value)) return null;
	const fn = isRecord(value.function) ? value.function : null;
	const name = typeof fn?.name === "string" ? fn.name : "";
	if (name.length === 0) return null;
	const args = typeof fn?.arguments === "string" ? fn.arguments : "";
	const id = typeof value.id === "string" && value.id.length > 0 ? value.id : `call-${index}`;
	return parseAssembled({ id, index, name, args });
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(extractMessagePartText).join("");
}

function extractMessagePartText(part: unknown): string {
	if (typeof part === "string") return part;
	if (!isRecord(part)) return "";
	if (typeof part.text === "string") return part.text;
	if (isRecord(part.text) && typeof part.text.value === "string") return part.text.value;
	return "";
}

// Some endpoints return no architecture metadata. In that case treat every
// non-batch model id as usable for both text and image output.
const oaImageOutputModels = new Set<string>();
const oaKnownModelOutputs = new Map<string, Set<string>>();

function oaResponseImageUrls(message: unknown): string[] {
	const urls: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === "string" && /^(?:data:image\/|https:\/\/)/i.test(value)) urls.push(value);
	};
	const collect = (part: Record<string, unknown>): void => {
		push(part.url);
		push(part.image_url);
		if (isRecord(part.image_url)) push(part.image_url.url);
		if (isRecord(part.source)) push(part.source.url);
		if (typeof part.b64_json === "string") {
			const mediaType = typeof part.media_type === "string" ? part.media_type : "image/png";
			push(`data:${mediaType};base64,${part.b64_json}`);
		}
		if (typeof part.data === "string" && typeof part.media_type === "string") {
			push(`data:${part.media_type};base64,${part.data}`);
		}
		if (isRecord(part.source) && typeof part.source.data === "string") {
			const mediaType = typeof part.source.media_type === "string" ? part.source.media_type : "image/png";
			push(`data:${mediaType};base64,${part.source.data}`);
		}
	};
	if (!isRecord(message)) return urls;
	if (Array.isArray(message.images)) for (const part of message.images) if (isRecord(part)) collect(part);
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (isRecord(part) && /image/i.test(String(part.type ?? ""))) collect(part);
		}
	}
	return [...new Set(urls)];
}

function oaIsBatchModel(id: string): boolean {
	return /:batch(?:$|:)/i.test(id);
}

function oaModelRecords(responseText: string): Record<string, unknown>[] {
	const parsed = parseJsonResponse(responseText);
	if (!isRecord(parsed)) return [];
	const data = parsed.data;
	if (!Array.isArray(data)) return [];
	return data.filter(isRecord);
}

function oaOutputModalities(record: Record<string, unknown>): string[] {
	const architecture = isRecord(record.architecture) ? record.architecture : null;
	if (!architecture || !Array.isArray(architecture.output_modalities)) return [];
	return architecture.output_modalities.filter((value): value is string => typeof value === "string");
}

function oaFilterModelIds(responseText: string, kind: string, imageMode = false): string[] {
	const ids: string[] = [];
	for (const record of oaModelRecords(responseText)) {
		if (typeof record.id !== "string" || !record.id || oaIsBatchModel(record.id)) continue;
		const modalities = oaOutputModalities(record);
		if ((!imageMode && modalities.length === 0) || modalities.includes(kind)) ids.push(record.id);
	}
	return [...new Set(ids)].sort();
}

function oaRememberImageOutputModels(responseText: string): void {
	for (const record of oaModelRecords(responseText)) {
		if (typeof record.id !== "string" || oaIsBatchModel(record.id)) continue;
		const modalities = oaOutputModalities(record);
		if (modalities.length > 0) oaKnownModelOutputs.set(record.id, new Set(modalities));
		if (modalities.includes("image")) oaImageOutputModels.add(record.id);
	}
}

export function oaModelEligibleOrUnknown(id: string, kind: string): boolean {
	if (!id || oaIsBatchModel(id)) return false;
	const known = oaKnownModelOutputs.get(id);
	return !known || known.has(kind);
}

export async function oaFetchModelIds(baseUrl: string, apiKey: string, kind = "text"): Promise<string[]> {
	if (!baseUrl.trim()) return [];
	try {
		const base = baseUrl.replace(/\/$/, "");
		const res = await requestUrl({
			url: kind === "image" ? `${base}/images/models` : `${base}/models`,
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			throw: false,
		});
		if (res.status >= 400) return [];
		oaRememberImageOutputModels(res.text);
		return oaFilterModelIds(res.text, kind, kind === "image");
	} catch {
		return [];
	}
}

function parseJsonResponse(text: string): unknown | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}
