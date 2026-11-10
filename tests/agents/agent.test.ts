import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/agents/agent";
import { ConsentManager } from "../../src/consent/manager";
import { ToolRegistry } from "../../src/tools/registry";
import type { LoopEvent, ModelProvider, ToolDef } from "../../src/types";

const definition = { id: "test", name: "Test", systemPrompt: "Test" };

function toolCallThenText(
	toolName: string,
	args: Record<string, unknown>,
): { provider: ModelProvider; streamCount: () => number } {
	let calls = 0;
	const provider: ModelProvider = {
		stream: async function* () {
			if (calls === 0) {
				yield {
					kind: "tool_call_assembled" as const,
					calls: [
						{
							id: "call-1",
							name: toolName,
							arguments: args,
							rawArguments: JSON.stringify(args),
						},
					],
				};
				yield { kind: "done" as const, finishReason: "tool_calls" as const };
			} else {
				yield { kind: "text" as const, text: "after tool" };
				yield { kind: "done" as const, finishReason: "stop" as const };
			}
			calls += 1;
		},
	};
	return { provider, streamCount: () => calls };
}

function providerThatAlwaysCallsATool(toolName: string): { provider: ModelProvider; streamCount: () => number } {
	let calls = 0;
	const provider: ModelProvider = {
		stream: async function* () {
			calls += 1;
			yield {
				kind: "tool_call_assembled" as const,
				calls: [
					{
						id: `call-${calls}`,
						name: toolName,
						arguments: {},
						rawArguments: "{}",
					},
				],
			};
			yield { kind: "done" as const, finishReason: "tool_calls" as const };
		},
	};
	return { provider, streamCount: () => calls };
}

function providerThatReturns(
	text: string,
	finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "unknown",
): ModelProvider {
	return {
		stream: async function* () {
			yield { kind: "text" as const, text };
			yield { kind: "done" as const, finishReason };
		},
	};
}

async function collect(
	agent: Agent,
	provider: ModelProvider,
	opts: { tools?: ToolRegistry; consent?: ConsentManager } = {},
): Promise<LoopEvent[]> {
	const events: LoopEvent[] = [];
	for await (const event of agent.run({
		messages: [{ role: "user", content: "go" }],
		provider,
		tools: opts.tools,
		consent: opts.consent,
	})) {
		events.push(event);
	}
	return events;
}

describe("Agent runtime guards", () => {
	it("skips the consent prompt for a mutating tool with requiresApproval=false", async () => {
		const run = vi.fn(async () => ({ ok: true as const, value: "saved" }));
		const registry = new ToolRegistry();
		registry.register({
			name: "image_generate",
			description: "Generate",
			schema: { type: "object", properties: {}, additionalProperties: false },
			category: "vault_write",
			mutates: true,
			requiresApproval: false,
			run,
		} satisfies ToolDef);
		const consent = new ConsentManager(() => ({ vault_read: "always", vault_write: "never" }));
		const { provider, streamCount } = toolCallThenText("image_generate", {});

		const events = await collect(new Agent(definition), provider, { tools: registry, consent });

		expect(events.some((event) => event.kind === "consent_requested")).toBe(false);
		expect(run).toHaveBeenCalledTimes(1);
		expect(streamCount()).toBe(2);
		expect(events.at(-1)).toEqual({ kind: "done", finishReason: "stop" });
	});

	it("still requests consent for a mutating tool when requiresApproval is omitted", async () => {
		const run = vi.fn(async () => ({ ok: true as const, value: "saved" }));
		const registry = new ToolRegistry();
		registry.register({
			name: "vault_write",
			description: "Write",
			schema: { type: "object", properties: {}, additionalProperties: false },
			category: "vault_write",
			mutates: true,
			run,
		} satisfies ToolDef);
		const consent = new ConsentManager(() => ({ vault_read: "always", vault_write: "ask" }));
		const { provider } = toolCallThenText("vault_write", {});

		const events: LoopEvent[] = [];
		for await (const event of new Agent(definition).run({
			messages: [{ role: "user", content: "go" }],
			provider,
			tools: registry,
			consent,
		})) {
			events.push(event);
			if (event.kind === "consent_requested") setTimeout(() => consent.resolveConsent("approve"), 0);
		}

		expect(events.some((event) => event.kind === "consent_requested")).toBe(true);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("ends the run after a failed tool call when stopOnFailure=true", async () => {
		const registry = new ToolRegistry();
		registry.register({
			name: "image_generate",
			description: "Generate",
			schema: { type: "object", properties: {}, additionalProperties: false },
			category: "vault_write",
			mutates: true,
			requiresApproval: false,
			stopOnFailure: true,
			run: vi.fn(async () => ({ ok: false as const, error: "ImageGenerationProviderError: boom" })),
		} satisfies ToolDef);
		const { provider, streamCount } = toolCallThenText("image_generate", {});

		const events = await collect(new Agent(definition), provider, { tools: registry });

		expect(streamCount()).toBe(1);
		expect(events.some((event) => event.kind === "text")).toBe(false);
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("ends the run after an argument-validation failure when stopOnFailure=true", async () => {
		const run = vi.fn(async () => ({ ok: true as const, value: null }));
		const registry = new ToolRegistry();
		registry.register({
			name: "image_generate",
			description: "Generate",
			schema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
			category: "vault_write",
			mutates: true,
			requiresApproval: false,
			stopOnFailure: true,
			run,
		} satisfies ToolDef<{ path: string }>);
		const { provider, streamCount } = toolCallThenText("image_generate", {});

		const events = await collect(new Agent(definition), provider, { tools: registry });

		expect(run).not.toHaveBeenCalled();
		expect(streamCount()).toBe(1);
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("continues after a failed tool call when stopOnFailure is omitted", async () => {
		const registry = new ToolRegistry();
		registry.register({
			name: "vault_read",
			description: "Read",
			schema: { type: "object", properties: {}, additionalProperties: false },
			category: "vault_read",
			mutates: false,
			run: vi.fn(async () => ({ ok: false as const, error: "Boom" })),
		} satisfies ToolDef);
		const { provider, streamCount } = toolCallThenText("vault_read", {});

		const events = await collect(new Agent(definition), provider, { tools: registry });

		expect(streamCount()).toBe(2);
		expect(events.some((event) => event.kind === "text")).toBe(true);
		expect(events.at(-1)).toEqual({ kind: "done", finishReason: "stop" });
	});

	it("stops after 8 steps when the model keeps calling tools", async () => {
		const registry = new ToolRegistry();
		registry.register({
			name: "vault_read",
			description: "Read",
			schema: { type: "object", properties: {}, additionalProperties: false },
			category: "vault_read",
			mutates: false,
			run: vi.fn(async () => ({ ok: true as const, value: null })),
		} satisfies ToolDef);
		const { provider, streamCount } = providerThatAlwaysCallsATool("vault_read");

		const events = await collect(new Agent(definition), provider, { tools: registry });

		expect(events.filter((event) => event.kind === "tool_call_started")).toHaveLength(8);
		expect(streamCount()).toBe(8);
	});

	it("reports the provider finish reason on the final done event", async () => {
		const provider = providerThatReturns("hello", "length");

		const events = await collect(new Agent(definition), provider);

		expect(events.at(-1)).toEqual({ kind: "done", finishReason: "length" });
	});
});
