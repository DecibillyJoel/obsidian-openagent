import { describe, expect, it, vi } from "vitest";
import { ConsentManager } from "../src/consent/manager";
import { runTurn } from "../src/loop";
import { ToolRegistry } from "../src/tools/registry";
import type { ChatMessage, ModelProvider, ToolDef } from "../src/types";

describe("runTurn", () => {
	it("keeps the classic wrapper behavior-safe while delegating through Agent", async () => {
		const toolRun = vi.fn(async () => ({ ok: true as const, value: "Alpha body" }));
		const registry = new ToolRegistry();
		registry.register({
			name: "vault_read",
			description: "Read a note",
			schema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
			category: "vault_read",
			mutates: false,
			run: toolRun,
		} satisfies ToolDef<{ path: string }>);

		const seenMessages: ChatMessage[][] = [];
		let streamCount = 0;
		const provider: ModelProvider = {
			stream: async function* (messages, opts) {
				seenMessages.push(messages.map((message) => ({ ...message })));
				if (streamCount === 0) {
					expect(opts?.tools?.map((tool) => tool.function.name)).toEqual(["vault_read"]);
					yield {
						kind: "tool_call_assembled" as const,
						calls: [
							{
								id: "call-1",
								name: "vault_read",
								arguments: { path: "Notes/alpha.md" },
								rawArguments: '{"path":"Notes/alpha.md"}',
							},
						],
					};
					yield { kind: "done" as const, finishReason: "tool_calls" as const };
				} else {
					expect(messages.at(-1)).toEqual({
						role: "tool",
						tool_call_id: "call-1",
						name: "vault_read",
						content: JSON.stringify({ ok: true, value: "Alpha body" }),
					});
					yield { kind: "text" as const, text: "Answer from classic mode" };
					yield { kind: "done" as const, finishReason: "stop" as const };
				}
				streamCount += 1;
			},
		};

		const consent = new ConsentManager(() => ({ vault_read: "always", vault_write: "ask", web: "always" }));
		const events = [];
		for await (const event of runTurn(
			[{ role: "user", content: "Tell me about Alpha" }],
			provider,
			{ systemPrompt: "Be concise", tools: registry, consent },
		)) {
			events.push(event);
		}

		expect(toolRun).toHaveBeenCalledWith({ path: "Notes/alpha.md" }, { signal: undefined });
		// The classic agent always sends its built-in prompt, and a caller's own prompt
		// is appended after it, which the settings text calls "prepended to every
		// conversation". Only the order and the seam are asserted here, so a change to
		// the built-in wording does not break this test.
		const systemMessage = seenMessages[0]?.[0];
		const systemContent = typeof systemMessage?.content === "string" ? systemMessage.content : "";
		expect(systemMessage?.role).toBe("system");
		expect(systemContent.endsWith("Be concise")).toBe(true);
		expect(seenMessages[0]?.[1]).toEqual({ role: "user", content: "Tell me about Alpha" });
		expect(events).toEqual([
			{
				kind: "tool_call_started",
				id: "call-1",
				name: "vault_read",
				args: { path: "Notes/alpha.md" },
				mutates: false,
			},
			{
				kind: "tool_call_finished",
				id: "call-1",
				result: { ok: true, value: "Alpha body" },
			},
			{ kind: "text", text: "Answer from classic mode", degraded: undefined },
			{ kind: "done", finishReason: "stop" },
		]);
	});

	it("preserves classic consent-denial behavior for mutating tools", async () => {
		const registry = new ToolRegistry();
		registry.register({
			name: "vault_write",
			description: "Write a note",
			schema: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
				additionalProperties: false,
			},
			category: "vault_write",
			mutates: true,
			run: vi.fn(async () => ({ ok: true as const, value: null })),
		} satisfies ToolDef<{ path: string; content: string }>);
		const consent = new ConsentManager(() => ({ vault_read: "always", vault_write: "ask", web: "always" }));
		let streamCount = 0;
		const provider: ModelProvider = {
			stream: async function* () {
				if (streamCount === 0) {
					yield {
						kind: "tool_call_assembled" as const,
						calls: [
							{
								id: "call-1",
								name: "vault_write",
								arguments: { path: "Notes/a.md", content: "Alpha" },
								rawArguments: '{"path":"Notes/a.md","content":"Alpha"}',
							},
						],
					};
					yield { kind: "done" as const, finishReason: "tool_calls" as const };
				}
				streamCount += 1;
			},
		};

		const events = [];
		for await (const event of runTurn([{ role: "user", content: "Write this down" }], provider, { tools: registry, consent })) {
			events.push(event);
			if (event.kind === "consent_requested") {
				setTimeout(() => consent.resolveConsent("reject"), 0);
			}
		}

		expect(events).toEqual([
			{
				kind: "tool_call_started",
				id: "call-1",
				name: "vault_write",
				args: { path: "Notes/a.md", content: "Alpha" },
				mutates: true,
			},
			{ kind: "consent_requested", id: "call-1", name: "vault_write" },
			{
				kind: "tool_call_finished",
				id: "call-1",
				result: {
					ok: false,
					error: "ConsentDeniedError",
					details: "User rejected this operation.",
				},
			},
			{ kind: "done" },
		]);
	});

	it("runs a non-mutating tool at consent mode ask without a prompt", async () => {
		const toolRun = vi.fn(async () => ({ ok: true as const, value: "Alpha body" }));
		const registry = new ToolRegistry();
		registry.register({
			name: "vault_read",
			description: "Read a note",
			schema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
			category: "vault_read",
			mutates: false,
			run: toolRun,
		} satisfies ToolDef<{ path: string }>);
		const consent = new ConsentManager(() => ({ vault_read: "ask", vault_write: "ask", web: "ask" }));
		let streamCount = 0;
		const provider: ModelProvider = {
			stream: async function* () {
				if (streamCount++ === 0) {
					yield {
						kind: "tool_call_assembled" as const,
						calls: [
							{
								id: "call-1",
								name: "vault_read",
								arguments: { path: "Notes/alpha.md" },
								rawArguments: '{"path":"Notes/alpha.md"}',
							},
						],
					};
					yield { kind: "done" as const, finishReason: "tool_calls" as const };
					return;
				}
				yield { kind: "text" as const, text: "Alpha body retrieved" };
				yield { kind: "done" as const, finishReason: "stop" as const };
			},
		};

		const events = [];
		for await (const event of runTurn(
			[{ role: "user", content: "Tell me about Alpha" }],
			provider,
			{ tools: registry, consent },
		)) {
			events.push(event);
		}

		expect(toolRun).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.kind === "consent_requested")).toBe(false);
		expect(events.some((event) => event.kind === "tool_call_finished" && event.result.ok === false)).toBe(false);
		expect(events.at(-1)).toEqual({ kind: "done", finishReason: "stop" });
	});
});
