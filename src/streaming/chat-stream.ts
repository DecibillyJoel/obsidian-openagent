import type { AssembledToolCall } from "../types";

/** One streaming tool-call fragment. Vendors split a call across records. */
export interface OaToolCallFragment {
	index?: number;
	id?: string;
	name?: string;
	arguments?: string;
}

/** One reasoning block. Task 2 owns the display parser for these blocks. */
export interface OaReasoningDetail {
	type: string;
	text?: string;
	summary?: string;
	data?: string;
}

/** One stream record reduced to the fields the chat loop consumes. */
export interface OaStreamDelta {
	content?: string;
	reasoning?: string;
	reasoningDetails?: OaReasoningDetail[];
	toolCalls?: AssembledToolCall[];
	finishReason?: string;
	images?: string[];
}

interface OaToolCallBuffer {
	id: string;
	name: string;
	rawArguments: string;
}

function oaIsRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oaParseArguments(raw: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	return oaIsRecord(parsed) ? parsed : {};
}

function oaNextFreeIndex(buffers: Map<number, OaToolCallBuffer>): number {
	let index = 0;
	while (buffers.has(index)) index += 1;
	return index;
}

function oaMergeToolCallFragment(buffers: Map<number, OaToolCallBuffer>, fragment: OaToolCallFragment): void {
	const index = typeof fragment.index === "number" && fragment.index >= 0 ? fragment.index : oaNextFreeIndex(buffers);
	let buffer = buffers.get(index);
	if (!buffer) {
		buffer = { id: "", name: "", rawArguments: "" };
		buffers.set(index, buffer);
	}
	if (typeof fragment.id === "string" && fragment.id.length > 0) buffer.id = fragment.id;
	if (typeof fragment.name === "string" && fragment.name.length > 0) buffer.name = fragment.name;
	if (typeof fragment.arguments === "string") buffer.rawArguments += fragment.arguments;
}

function oaToolCallFragment(value: unknown): OaToolCallFragment {
	const record = oaIsRecord(value) ? value : {};
	const fn = oaIsRecord(record.function) ? record.function : {};
	return {
		index: typeof record.index === "number" ? record.index : undefined,
		id: typeof record.id === "string" ? record.id : undefined,
		name: typeof fn.name === "string" ? fn.name : undefined,
		arguments: typeof fn.arguments === "string" ? fn.arguments : undefined,
	};
}

function oaAssembledCalls(buffers: Map<number, OaToolCallBuffer>): AssembledToolCall[] {
	return [...buffers.keys()]
		.sort((left, right) => left - right)
		.map((index) => {
			const buffer = buffers.get(index) as OaToolCallBuffer;
			return {
				id: buffer.id,
				name: buffer.name,
				arguments: oaParseArguments(buffer.rawArguments),
				rawArguments: buffer.rawArguments,
			};
		});
}

export function oaAssembleToolCallFragments(fragments: OaToolCallFragment[]): AssembledToolCall[] {
	const buffers = new Map<number, OaToolCallBuffer>();
	for (const fragment of fragments) oaMergeToolCallFragment(buffers, fragment);
	return oaAssembledCalls(buffers);
}

const OA_IMAGE_URL = /^(?:data:image\/|https:\/\/)/i;

function oaDeltaImageUrls(delta: Record<string, unknown>): string[] {
	const urls = new Set<string>();
	const push = (value: unknown): void => {
		if (typeof value === "string" && OA_IMAGE_URL.test(value)) urls.add(value);
	};
	const collect = (part: Record<string, unknown>): void => {
		push(part.url);
		push(part.image_url);
		if (oaIsRecord(part.image_url)) push(part.image_url.url);
		if (oaIsRecord(part.source)) {
			push(part.source.url);
			if (typeof part.source.data === "string") {
				const mediaType = typeof part.source.media_type === "string" ? part.source.media_type : "image/png";
				push(`data:${mediaType};base64,${part.source.data}`);
			}
		}
		if (typeof part.b64_json === "string") {
			const mediaType = typeof part.media_type === "string" ? part.media_type : "image/png";
			push(`data:${mediaType};base64,${part.b64_json}`);
		}
		if (typeof part.data === "string" && typeof part.media_type === "string") {
			push(`data:${part.media_type};base64,${part.data}`);
		}
	};
	if (Array.isArray(delta.images)) for (const part of delta.images) if (oaIsRecord(part)) collect(part);
	if (Array.isArray(delta.content)) {
		for (const part of delta.content) if (oaIsRecord(part) && /image/i.test(String(part.type ?? ""))) collect(part);
	}
	return [...urls];
}

/** Return the payload text of one SSE line. Return null for blank and comment lines. */
function oaDataPayload(line: string): string | null {
	if (line.length === 0 || line.startsWith(":") || !line.startsWith("data:")) return null;
	const payload = line.slice(5).trim();
	return payload.length > 0 ? payload : null;
}

function oaRecordDelta(record: unknown, buffers: Map<number, OaToolCallBuffer>): OaStreamDelta | null {
	if (!oaIsRecord(record)) return null;
	const choice = Array.isArray(record.choices) ? record.choices[0] : null;
	if (!oaIsRecord(choice)) return null;
	const delta = oaIsRecord(choice.delta) ? choice.delta : {};

	if (Array.isArray(delta.tool_calls)) {
		for (const raw of delta.tool_calls) oaMergeToolCallFragment(buffers, oaToolCallFragment(raw));
	}

	const out: OaStreamDelta = {};
	if (typeof delta.content === "string" && delta.content.length > 0) out.content = delta.content;
	if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) out.reasoning = delta.reasoning;
	if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
		out.reasoningDetails = delta.reasoning_details as OaReasoningDetail[];
	}
	const images = oaDeltaImageUrls(delta);
	if (images.length > 0) out.images = images;
	if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
		const calls = oaAssembledCalls(buffers);
		if (calls.length > 0) out.toolCalls = calls;
		out.finishReason = choice.finish_reason;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * Read the response body of a streaming chat request.
 * Yield one delta per SSE record that carries text, reasoning, images, or the finish reason.
 */
export async function* oaStreamChatDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<OaStreamDelta> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const buffers = new Map<number, OaToolCallBuffer>();
	let pending = "";
	let stopped = false;
	try {
		while (!stopped) {
			const chunk = await reader.read();
			if (chunk.done) break;
			pending += decoder.decode(chunk.value, { stream: true });
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline < 0) break;
				const line = pending.slice(0, newline).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				const payload = oaDataPayload(line);
				if (payload === null) continue;
				if (payload === "[DONE]") {
					stopped = true;
					break;
				}
				let record: unknown;
				try {
					record = JSON.parse(payload);
				} catch {
					continue;
				}
				const delta = oaRecordDelta(record, buffers);
				if (delta) yield delta;
			}
		}
	} finally {
		reader.releaseLock();
	}
}
