import { describe, expect, it, vi } from "vitest";
import { runTurn } from "../../src/loop";
import { ToolRegistry } from "../../src/tools/registry";
import type { ChatMessage, ModelProvider, ToolDef, ToolResult } from "../../src/types";
import type { PendingImage } from "../../src/images/attachments";

function makeRegistry(run: () => Promise<ToolResult>): ToolRegistry {
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
		run,
	} satisfies ToolDef<{ path: string }>);
	return registry;
}

describe("runTurn image passthrough", () => {
	it("injects resolved vault tool images as multimodal user content", async () => {
		const registry = makeRegistry(async () => ({ ok: true as const, value: { path: "Notes/a.md" } }));
		const resolved: PendingImage = {
			id: "img-1",
			name: "Attachments/a.png",
			mimeType: "image/png",
			size: 8,
			url: "data:image/png;base64,iVBORw0KGgo=",
		};
		const resolveToolImages = vi.fn(async (_name: string, _result: ToolResult) => [resolved]);
		const seenMessages: ChatMessage[][] = [];
		let streamCount = 0;
		const provider: ModelProvider = {
			stream: async function* (messages) {
				seenMessages.push(messages.map((message) => ({ ...message })));
				if (streamCount++ === 0) {
					yield {
						kind: "tool_call_assembled" as const,
						calls: [
							{
								id: "call-1",
								name: "vault_read",
								arguments: { path: "Notes/a.md" },
								rawArguments: '{"path":"Notes/a.md"}',
							},
						],
					};
					yield { kind: "done" as const, finishReason: "tool_calls" as const };
					return;
				}
				yield { kind: "text" as const, text: "done" };
				yield { kind: "done" as const, finishReason: "stop" as const };
			},
		};

		for await (const event of runTurn([{ role: "user", content: "hi" }], provider, {
			tools: registry,
			resolveToolImages,
		})) {
			void event;
		}

		expect(resolveToolImages).toHaveBeenCalledTimes(1);
		expect(resolveToolImages.mock.calls[0][0]).toBe("vault_read");
		expect(seenMessages).toHaveLength(2);
		const secondCall = seenMessages[1];
		const injected = secondCall[secondCall.length - 1];
		expect(injected.role).toBe("user");
		expect(injected.content).toEqual([
			{ type: "text", text: "Images referenced by the preceding vault tool result. Use them as visual context:\n- Attachments/a.png" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
		]);
	});

	it("leaves the message history alone when no images resolve", async () => {
		const registry = makeRegistry(async () => ({ ok: true as const, value: {} }));
		const resolveToolImages = vi.fn(async () => []);
		const seenMessages: ChatMessage[][] = [];
		let streamCount = 0;
		const provider: ModelProvider = {
			stream: async function* (messages) {
				seenMessages.push(messages.map((message) => ({ ...message })));
				if (streamCount++ === 0) {
					yield {
						kind: "tool_call_assembled" as const,
						calls: [
							{
								id: "call-1",
								name: "vault_read",
								arguments: { path: "Notes/a.md" },
								rawArguments: '{"path":"Notes/a.md"}',
							},
						],
					};
					yield { kind: "done" as const, finishReason: "tool_calls" as const };
					return;
				}
				yield { kind: "done" as const, finishReason: "stop" as const };
			},
		};

		for await (const event of runTurn([{ role: "user", content: "hi" }], provider, {
			tools: registry,
			resolveToolImages,
		})) {
			void event;
		}

		expect(resolveToolImages).toHaveBeenCalledTimes(1);
		const secondCall = seenMessages[1];
		expect(secondCall[secondCall.length - 1].role).toBe("tool");
		expect(secondCall.some((message) => Array.isArray(message.content))).toBe(false);
	});
});
