import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrlMock } = vi.hoisted(() => ({
	requestUrlMock: vi.fn(),
}));

vi.mock("obsidian", () => ({
	requestUrl: requestUrlMock,
}));

import {
	oaFetchModelIds,
	oaModelEligibleOrUnknown,
	OpenAICompatibleProvider,
} from "../src/provider";

describe("OpenAICompatibleProvider", () => {
	beforeEach(() => {
		requestUrlMock.mockReset();
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
