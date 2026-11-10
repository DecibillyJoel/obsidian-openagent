import { describe, expect, it } from "vitest";
import { oaReasoningDetailText, oaSplitThinking } from "../../src/streaming/reasoning";

describe("oaReasoningDetailText", () => {
	it("joins reasoning.text blocks in index order", () => {
		expect(
			oaReasoningDetailText([
				{ type: "reasoning.text", text: " second", index: 1, format: "anthropic-claude-v1", signature: "sig" },
				{ type: "reasoning.text", text: "first", index: 0 },
			]),
		).toBe("first second");
	});

	it("reads a reasoning.summary block", () => {
		expect(
			oaReasoningDetailText([{ type: "reasoning.summary", summary: "17 * 23 = 391", format: "meta-responses-v1", index: 0 }]),
		).toBe("17 * 23 = 391");
	});

	it("skips an encrypted block", () => {
		expect(oaReasoningDetailText([{ type: "reasoning.encrypted", data: "b3BhcXVl" }])).toBe("");
	});

	it("returns an empty string for a missing or malformed array", () => {
		expect(oaReasoningDetailText(undefined)).toBe("");
		expect(oaReasoningDetailText("nope")).toBe("");
		expect(oaReasoningDetailText([null, 7, { type: 5 }])).toBe("");
	});
});

describe("oaSplitThinking", () => {
	it("prefers the reasoning field", () => {
		expect(
			oaSplitThinking({
				content: "391",
				reasoning: "17 * 23 = 391",
				reasoning_details: [{ type: "reasoning.text", text: "17 * 23 = 391" }],
			}),
		).toEqual({ text: "391", thinking: "17 * 23 = 391" });
	});

	it("falls back to the detail blocks when there is no reasoning field", () => {
		expect(
			oaSplitThinking({ content: "391", reasoning_details: [{ type: "reasoning.text", text: "17 * 23 = 391" }] }),
		).toEqual({ text: "391", thinking: "17 * 23 = 391" });
	});

	it("keeps the legacy reasoning_content field", () => {
		expect(oaSplitThinking({ content: "hi", reasoning_content: " think" })).toEqual({ text: "hi", thinking: "think" });
	});

	it("strips a leading think block from the answer text", () => {
		expect(oaSplitThinking({ content: "<think>thinking hard</think>Answer" })).toEqual({
			text: "Answer",
			thinking: "thinking hard",
		});
	});

	it("reports no reasoning for a plain answer", () => {
		expect(oaSplitThinking({ content: "hello" })).toEqual({ text: "hello", thinking: "" });
	});
});
