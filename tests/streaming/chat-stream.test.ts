import { describe, expect, it } from "vitest";
import { oaAssembleToolCallFragments, oaStreamChatDeltas } from "../../src/streaming/chat-stream";
import { oaSseResponse } from "../setup";

async function collect(payloads: string[], opts?: { chunkSize?: number }): Promise<unknown[]> {
	const body = (oaSseResponse(payloads, opts) as { body: ReadableStream<Uint8Array> }).body;
	const seen: unknown[] = [];
	for await (const delta of oaStreamChatDeltas(body)) seen.push(delta);
	return seen;
}

describe("oaStreamChatDeltas", () => {
	it("reads content deltas and the finish reason", async () => {
		const seen = await collect([
			'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		expect(seen).toEqual([{ content: "Hel" }, { content: "lo" }, { finishReason: "stop" }]);
	});

	it("reads a reasoning delta separately from content", async () => {
		const seen = await collect([
			'data: {"choices":[{"delta":{"reasoning":"17 * 23"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"391"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		expect(seen).toEqual([{ reasoning: "17 * 23" }, { content: "391" }, { finishReason: "stop" }]);
	});

	it("reads a data line split across chunks, with CRLF endings", async () => {
		const seen = await collect(
			['data: {"choices":[{"delta":{"content":"split"}}]}\r\n\r\n', "data: [DONE]\r\n\r\n"],
			{ chunkSize: 7 },
		);
		expect(seen).toEqual([{ content: "split" }]);
	});

	it("reads a multi-byte character split across chunks", async () => {
		const seen = await collect(
			['data: {"choices":[{"delta":{"content":"caf\\u00e9"}}]}\n\n', "data: [DONE]\n\n"],
			{ chunkSize: 3 },
		);
		expect(seen).toEqual([{ content: "café" }]);
	});

	it("ignores empty lines, comments, and unknown vendor keys", async () => {
		const seen = await collect([
			": ping\n\n",
			'\ndata: {"choices":[{"delta":{},"x_nanogpt_tool_progress":{"status":"preparing"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
			"data: [DONE]\n\n",
		]);
		expect(seen).toEqual([{ content: "ok" }]);
	});

	it("passes reasoning details through unchanged", async () => {
		const seen = await collect([
			'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"let me think"},{"type":"reasoning.encrypted","data":"abc"}]}}]}\n\n',
			"data: [DONE]\n\n",
		]);
		expect(seen).toEqual([
			{
				reasoningDetails: [
					{ type: "reasoning.text", text: "let me think" },
					{ type: "reasoning.encrypted", data: "abc" },
				],
			},
		]);
	});

	it("assembles a tool call split across two argument fragments", async () => {
		const seen = await collect([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"vault_read","arguments":"{\\"path\\":"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Notes/test.md\\"}"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		expect(seen).toEqual([
			{
				toolCalls: [
					{
						id: "call_1",
						name: "vault_read",
						arguments: { path: "Notes/test.md" },
						rawArguments: '{"path":"Notes/test.md"}',
					},
				],
				finishReason: "tool_calls",
			},
		]);
	});

	it("returns no deltas for an empty body", async () => {
		expect(await collect([])).toEqual([]);
	});
});

describe("oaAssembleToolCallFragments", () => {
	it("keeps a fragment that has no arguments", () => {
		expect(oaAssembleToolCallFragments([{ index: 0, id: "call_9", name: "vault_list" }])).toEqual([
			{ id: "call_9", name: "vault_list", arguments: {}, rawArguments: "" },
		]);
	});
});
