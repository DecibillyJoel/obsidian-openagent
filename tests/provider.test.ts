import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrlMock, fetchMock } = vi.hoisted(() => ({
	requestUrlMock: vi.fn(),
	fetchMock: vi.fn(),
}));

vi.mock("obsidian", () => ({
	requestUrl: requestUrlMock,
}));

import {
	oaFetchModelIds,
	oaModelEligibleOrUnknown,
	OpenAICompatibleProvider,
} from "../src/provider";
import { NetworkError, type ChatMessage, type ModelProvider, type StreamEvent } from "../src/types";
import { oaSseResponse } from "./setup";

function makeProvider(): ModelProvider {
	return new OpenAICompatibleProvider({
		baseUrl: "https://api.example.test/v1",
		apiKey: "key-1",
		model: "test-model",
	});
}

function makeMessages(): ChatMessage[] {
	return [{ role: "user", content: "hi" }];
}

async function collectEvents(
	provider: ModelProvider,
	messages: ChatMessage[],
	signal?: AbortSignal,
): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of provider.stream(messages, signal ? { signal } : {})) events.push(event);
	return events;
}

function completed(text: string) {
	return { choices: [{ message: { content: text }, finish_reason: "stop" }] };
}

// Node ships a real fetch. Save it before any beforeEach runs, so a test can
// prove the suite never reaches the network on it.
const platformFetch = globalThis.fetch;

describe("OpenAICompatibleProvider", () => {
	beforeEach(() => {
		requestUrlMock.mockReset();
		globalThis.fetch = vi.fn(async () => {
			throw new TypeError("fetch blocked in tests");
		}) as unknown as typeof fetch;
	});

	it("never runs on the platform fetch", () => {
		expect(globalThis.fetch).not.toBe(platformFetch);
	});

	it("emits assistant text from non-streaming completions", async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({
				choices: [
					{
						message: { content: "hello" },
						finish_reason: "stop",
					},
				],
			}),
		});

		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://api.example.com",
			apiKey: "secret",
			model: "test-model",
		});

		const events = [];
		for await (const event of provider.stream([{ role: "user", content: "hi" }])) {
			events.push(event);
		}

		expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
			url: "https://api.example.com/chat/completions",
			method: "POST",
			throw: false,
		}));
		expect(events).toEqual([
			{ kind: "text", text: "hello" },
			{ kind: "done", finishReason: "stop" },
		]);
	});

	it("reads the reasoning field from a non-streaming reply", async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({
				choices: [{ message: { content: "391", reasoning: "17 * 23 = 391" }, finish_reason: "stop" }],
			}),
		});
		expect(await collectEvents(makeProvider(), makeMessages())).toEqual([
			{ kind: "thinking_text", text: "17 * 23 = 391" },
			{ kind: "text", text: "391" },
			{ kind: "done", finishReason: "stop" },
		]);
	});

	it("includes response_format when provided", async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({
				choices: [
					{
						message: { content: '{"summary":"ok","claims":[]}' },
						finish_reason: "stop",
					},
				],
			}),
		});

		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://api.example.com",
			apiKey: "secret",
			model: "test-model",
		});

		const events = [];
		for await (const event of provider.stream(
			[{ role: "user", content: "hi" }],
			{
				responseFormat: {
					type: "json_schema",
					json_schema: {
						name: "claims_v1",
						strict: true,
						schema: {
							type: "object",
							properties: {
								summary: { type: "string" },
								claims: { type: "array", items: { type: "string" } },
							},
							required: ["summary", "claims"],
							additionalProperties: false,
						},
					},
				},
			},
		)) {
			events.push(event);
		}

		expect(JSON.parse(requestUrlMock.mock.calls[0][0].body)).toEqual(expect.objectContaining({
			model: "test-model",
			response_format: {
				type: "json_schema",
				json_schema: expect.objectContaining({
					name: "claims_v1",
					strict: true,
				}),
			},
		}));
		expect(events).toEqual([
			{ kind: "text", text: '{"summary":"ok","claims":[]}' },
			{ kind: "done", finishReason: "stop" },
		]);
	});

	it("assembles tool calls from non-streaming completions", async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({
				choices: [
					{
						message: {
							tool_calls: [
								{
									id: "call_1",
									function: {
										name: "vault_read",
										arguments: '{"path":"Notes/test.md"}',
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
		});

		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://api.example.com",
			apiKey: "secret",
			model: "test-model",
		});

		const events = [];
		for await (const event of provider.stream([{ role: "user", content: "hi" }])) {
			events.push(event);
		}

		expect(events).toEqual([
			{
				kind: "tool_call_assembled",
				calls: [
					{
						id: "call_1",
						name: "vault_read",
						arguments: { path: "Notes/test.md" },
						rawArguments: '{"path":"Notes/test.md"}',
					},
				],
			},
			{ kind: "done", finishReason: "tool_calls" },
		]);
	});

	it("lists sorted models", async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({
				data: [
					{ id: "z-model" },
					{ id: "a-model" },
					{ nope: true },
				],
			}),
		});

		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://api.example.com/",
			apiKey: "secret",
			model: "test-model",
		});

		await expect(provider.listModels()).resolves.toEqual(["a-model", "z-model"]);
		expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
			url: "https://api.example.com/models",
			method: "GET",
			throw: false,
		}));
	});

	it("discovers image-capable models from the /images/models endpoint", async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({
				data: [
					{ id: "text-only", architecture: { output_modalities: ["text"] } },
					{ id: "img-ok", architecture: { output_modalities: ["text", "image"] } },
					{ id: "img-batch:batch", architecture: { output_modalities: ["image"] } },
					{ id: "no-arch" },
				],
			}),
		});

		await expect(oaFetchModelIds("https://api.example.com/", "secret", "image")).resolves.toEqual([
			"img-ok",
		]);
		expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
			url: "https://api.example.com/images/models",
			method: "GET",
			throw: false,
		}));
		expect(oaModelEligibleOrUnknown("img-ok", "image")).toBe(true);
		expect(oaModelEligibleOrUnknown("img-ok", "audio")).toBe(false);
		expect(oaModelEligibleOrUnknown("no-arch", "audio")).toBe(true);
		expect(oaModelEligibleOrUnknown("img-batch:batch", "image")).toBe(false);
	});

	it("treats every listed model as eligible when no modalities are reported", async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({ data: [{ id: "open-model" }] }),
		});

		await expect(oaFetchModelIds("https://api.example.com", "secret", "text")).resolves.toEqual([
			"open-model",
		]);
		expect(oaModelEligibleOrUnknown("open-model", "text")).toBe(true);
	});

	it("yields an images event when the completion returns inline images", async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({
				choices: [
					{
						message: {
							content: "hello",
							images: [{ url: "data:image/png;base64,iVBORw0KGgo=" }],
						},
						finish_reason: "stop",
					},
				],
			}),
		});

		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://api.example.com",
			apiKey: "secret",
			model: "test-model",
		});

		const events = [];
		for await (const event of provider.stream([{ role: "user", content: "hi" }])) {
			events.push(event);
		}

		expect(events).toEqual([
			{ kind: "text", text: "hello" },
			{ kind: "images", urls: ["data:image/png;base64,iVBORw0KGgo="] },
			{ kind: "done", finishReason: "stop" },
		]);
	});

	it("falls back when the endpoint rejects response_format", async () => {
		requestUrlMock
			.mockResolvedValueOnce({
				status: 400,
				text: JSON.stringify({
					error: {
						message: "response_format json_schema is not supported",
					},
				}),
			})
			.mockResolvedValueOnce({
				status: 200,
				text: JSON.stringify({
					choices: [
						{
							message: { content: '{"summary":"fallback","claims":[]}' },
							finish_reason: "stop",
						},
					],
				}),
			});

		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://api.example.com",
			apiKey: "secret",
			model: "test-model",
		});

		const events = [];
		for await (const event of provider.stream(
			[{ role: "user", content: "hi" }],
			{
				responseFormat: {
					type: "json_schema",
					json_schema: {
						name: "claims_v1",
						strict: true,
						schema: {
							type: "object",
							properties: {
								summary: { type: "string" },
								claims: { type: "array", items: { type: "string" } },
							},
							required: ["summary", "claims"],
							additionalProperties: false,
						},
					},
				},
			},
		)) {
			events.push(event);
		}

		expect(requestUrlMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(requestUrlMock.mock.calls[0][0].body)).toHaveProperty("response_format");
		expect(JSON.parse(requestUrlMock.mock.calls[1][0].body)).not.toHaveProperty("response_format");
		expect(events).toEqual([
			{ kind: "text", text: '{"summary":"fallback","claims":[]}', degraded: true },
			{ kind: "done", finishReason: "stop" },
		]);
	});
});

describe("streaming transport", () => {
	beforeEach(() => {
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(oaSseResponse([]));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	it("streams content deltas and never calls requestUrl", async () => {
		fetchMock.mockResolvedValue(
			oaSseResponse([
				'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const events = await collectEvents(makeProvider(), makeMessages());
		expect(events).toEqual([
			{ kind: "text", text: "Hel" },
			{ kind: "text", text: "lo" },
			{ kind: "done", finishReason: "stop" },
		]);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("sends stream true and the Authorization header", async () => {
		fetchMock.mockResolvedValue(oaSseResponse(["data: [DONE]\n\n"]));
		await collectEvents(makeProvider(), makeMessages());
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.example.test/v1/chat/completions");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key-1");
		expect(JSON.parse(String(init.body)).stream).toBe(true);
	});

	it("emits reasoning deltas once and drops the duplicate detail block", async () => {
		fetchMock.mockResolvedValue(
			oaSseResponse([
				'data: {"choices":[{"delta":{"reasoning":"17 * 23"}}]}\n\n',
				'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"17 * 23","index":0}]}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"391"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		expect(await collectEvents(makeProvider(), makeMessages())).toEqual([
			{ kind: "thinking_text", text: "17 * 23" },
			{ kind: "text", text: "391" },
			{ kind: "done", finishReason: "stop" },
		]);
	});

	it("emits a detail block that carries different text after a reasoning delta", async () => {
		fetchMock.mockResolvedValue(
			oaSseResponse([
				'data: {"choices":[{"delta":{"reasoning":"17 * 23"}}]}\n\n',
				'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":" = 391","index":0}]}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"391"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		expect(await collectEvents(makeProvider(), makeMessages())).toEqual([
			{ kind: "thinking_text", text: "17 * 23" },
			{ kind: "thinking_text", text: " = 391" },
			{ kind: "text", text: "391" },
			{ kind: "done", finishReason: "stop" },
		]);
	});

	it("emits the detail block when no reasoning delta arrived", async () => {
		fetchMock.mockResolvedValue(
			oaSseResponse([
				'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","summary":"short","index":0}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		expect(await collectEvents(makeProvider(), makeMessages())).toEqual([
			{ kind: "thinking_text", text: "short" },
			{ kind: "done", finishReason: "stop" },
		]);
	});

	it("assembles a streamed tool call", async () => {
		fetchMock.mockResolvedValue(
			oaSseResponse([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"vault_read","arguments":"{\\"path\\":"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Notes/test.md\\"}"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		expect(await collectEvents(makeProvider(), makeMessages())).toEqual([
			{
				kind: "tool_call_assembled",
				calls: [
					{
						id: "call_1",
						name: "vault_read",
						arguments: { path: "Notes/test.md" },
						rawArguments: '{"path":"Notes/test.md"}',
					},
				],
			},
			{ kind: "done", finishReason: "tool_calls" },
		]);
	});

	it("falls back to requestUrl when fetch is unavailable", async () => {
		const original = globalThis.fetch;
		// @ts-expect-error deliberately removing a global for the test
		delete globalThis.fetch;
		requestUrlMock.mockResolvedValue({ status: 200, text: JSON.stringify(completed("hello")) });
		expect(await collectEvents(makeProvider(), makeMessages())).toEqual([
			{ kind: "text", text: "hello" },
			{ kind: "done", finishReason: "stop" },
		]);
		globalThis.fetch = original;
	});

	it("falls back to requestUrl when the content type is not event-stream", async () => {
		fetchMock.mockResolvedValue(oaSseResponse(['{"choices":[]}'], { contentType: "application/json" }));
		requestUrlMock.mockResolvedValue({ status: 200, text: JSON.stringify(completed("hello")) });
		expect(await collectEvents(makeProvider(), makeMessages())).toEqual([
			{ kind: "text", text: "hello" },
			{ kind: "done", finishReason: "stop" },
		]);
	});

	it("reports the error and does not re-request when the stream dies after bytes arrived", async () => {
		fetchMock.mockResolvedValue(
			oaSseResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'], {
				error: new Error("socket closed"),
			}),
		);
		await expect(collectEvents(makeProvider(), makeMessages())).rejects.toThrow(NetworkError);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("returns quietly when the signal aborts mid-stream", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | null | undefined;
		fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
			seenSignal = init.signal as AbortSignal;
			const encoder = new TextEncoder();
			let sent = false;
			const body = new ReadableStream<Uint8Array>({
				pull(streamController) {
					if (!sent) {
						sent = true;
						streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
						return;
					}
					controller.abort();
					streamController.error(new DOMException("Aborted", "AbortError"));
				},
			});
			return { ok: true, body, headers: { get: () => "text/event-stream" } } as unknown as Response;
		});
		const events = await collectEvents(makeProvider(), makeMessages(), controller.signal);
		expect(seenSignal).toBe(controller.signal);
		expect(seenSignal?.aborted).toBe(true);
		expect(events).toEqual([{ kind: "text", text: "par" }]);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});
});
