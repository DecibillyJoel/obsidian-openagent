/** One reasoning block. Encrypted blocks carry no displayable text. */
export interface OaReasoningDetail {
	type: string;
	text?: string;
	summary?: string;
	data?: string;
}

/** One block reduced to its text and sort index. */
interface OaReasoningBlock {
	index: number;
	text: string;
}

/** The displayable text of a reasoning_details array. Encrypted blocks are skipped. */
export function oaReasoningDetailText(details: unknown): string {
	if (!Array.isArray(details)) return "";

	const blocks: OaReasoningBlock[] = [];
	for (let order = 0; order < details.length; order++) {
		const detail = details[order];
		if (typeof detail !== "object" || detail === null) continue;
		const record = detail as Record<string, unknown>;
		const index = typeof record.index === "number" ? record.index : order;
		if (record.type === "reasoning.text") {
			if (typeof record.text === "string") blocks.push({ index, text: record.text });
		} else if (record.type === "reasoning.summary") {
			if (typeof record.summary === "string") blocks.push({ index, text: record.summary });
		}
	}

	blocks.sort((a, b) => a.index - b.index);
	return blocks.map((block) => block.text).join("");
}

/**
 * Split one non-streaming assistant message into answer text and reasoning.
 * Prefers `reasoning`, then the detail blocks, then `reasoning_content`,
 * then a leading  thinking block in the answer text.
 */
export function oaSplitThinking(message: {
	content?: unknown;
	reasoning?: unknown;
	reasoning_content?: unknown;
	reasoning_details?: unknown;
}): { text: string; thinking: string } {
	const content = typeof message.content === "string" ? message.content : "";

	const reasoning = typeof message.reasoning === "string" ? message.reasoning.trim() : "";
	if (reasoning.length > 0) return { text: content, thinking: reasoning };

	const detailText = oaReasoningDetailText(message.reasoning_details).trim();
	if (detailText.length > 0) return { text: content, thinking: detailText };

	const legacy = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
	if (legacy.length > 0) return { text: content, thinking: legacy };

	const thinkMatch = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
	if (thinkMatch) {
		const thinking = thinkMatch[1].trim();
		const remainder = content.slice(thinkMatch[0].length);
		return { text: remainder, thinking };
	}

	return { text: content, thinking: "" };
}
