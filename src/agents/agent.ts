import type { ConsentManager } from "../consent/manager";
import { oaMultimodalContent, type PendingImage } from "../images/attachments";
import { ToolTimeoutError, runWithTimeout, DEFAULT_TOOL_TIMEOUT_MS } from "../tools/timeout";
import type { ToolRegistry } from "../tools/registry";
import { validateArgs } from "../tools/validate";
import type {
	AgentDefinition,
	AgentEvent,
	AgentRunOptions,
} from "./types";
import type { ResolveToolImages } from "../images/attachments";
import type {
	AssembledToolCall,
	ChatMessage,
	GetConversationImages,
	GetImageModel,
	ModelProvider,
	OpenAiToolSpec,
	ResponseFormatConfig,
	ToolCallSpec,
	ToolDef,
	ToolResult,
} from "../types";

const DEFAULT_MAX_STEPS = 9999;

interface BoundTools {
	get(name: string): ToolDef | undefined;
	toApiSpec(): OpenAiToolSpec[];
}

export class Agent {
	private readonly definition: AgentDefinition;

	constructor(definition: AgentDefinition) {
		this.definition = definition;
	}

	getDefinition(): AgentDefinition {
		return this.definition;
	}

	async *run(opts: AgentRunOptions & { getConversationImages?: GetConversationImages }): AsyncIterable<AgentEvent> {
		yield* executeAgentLoop(this.definition, opts);
	}
}

export interface ExecuteAgentLoopOptions {
	messages: ChatMessage[];
	provider: ModelProvider;
	signal?: AbortSignal;
	systemPrompt?: string;
	tools?: ToolRegistry;
	consent?: ConsentManager;
	maxSteps?: number;
	responseFormat?: ResponseFormatConfig;
	resolveToolImages?: ResolveToolImages;
	getConversationImages?: GetConversationImages;
	getImageModel?: GetImageModel;
}

async function* executeAgentLoop(
	definition: AgentDefinition,
	opts: ExecuteAgentLoopOptions,
): AsyncIterable<AgentEvent> {
	const messages: ChatMessage[] = [];
	const parts = [definition.systemPrompt, opts.systemPrompt].filter((p) => p && p.trim().length > 0);
	const systemPrompt = parts.join("\n\n");
	if (systemPrompt.length > 0) {
		messages.push({ role: "system", content: systemPrompt });
	}
	messages.push(...opts.messages);

	const maxSteps = opts.maxSteps ?? definition.maxSteps ?? DEFAULT_MAX_STEPS;
	const toolsApi = bindTools(opts.tools, definition.toolAllowlist);
	const useTools = toolsApi && toolsApi.toApiSpec().length > 0;

	for (let step = 0; step < maxSteps; step++) {
		const assembled: AssembledToolCall[] = [];
		let assistantText = "";

		for await (const ev of opts.provider.stream(messages, {
			signal: opts.signal,
			tools: useTools ? toolsApi?.toApiSpec() : undefined,
			responseFormat: opts.responseFormat,
		})) {
			if (opts.signal?.aborted) return;
			if (ev.kind === "text") {
				assistantText += ev.text;
				yield { kind: "text", text: ev.text, degraded: ev.degraded };
			} else if (ev.kind === "thinking_text") {
				yield { kind: "thinking_text", text: ev.text };
			} else if (ev.kind === "images") {
				yield { kind: "images", urls: ev.urls };
			} else if (ev.kind === "tool_call_assembled") {
				assembled.push(...ev.calls);
			}
		}

		if (assembled.length === 0) {
			// If we processed tool results but the model returned nothing, emit a fallback.
			if (step > 0 && assistantText.trim() === "") {
				yield { kind: "text", text: "*(No response from the model after tool use.)*", degraded: true };
			}
			yield { kind: "done" };
			return;
		}

		const toolCallSpecs: ToolCallSpec[] = assembled.map((call) => ({
			id: call.id,
			type: "function",
			function: { name: call.name, arguments: call.rawArguments || JSON.stringify(call.arguments) },
		}));
		messages.push({ role: "assistant", content: assistantText, tool_calls: toolCallSpecs });

		let consentDenied = false;
		const toolImages: PendingImage[] = [];
		const seenToolImageUrls = new Set<string>();
		for (const call of assembled) {
			if (opts.signal?.aborted) return;
			const toolDef = toolsApi?.get(call.name);
			if (!toolDef) {
				yield { kind: "tool_call_started", id: call.id, name: call.name, args: call.arguments, mutates: false };
				const result: ToolResult = { ok: false, error: `UnknownToolError: ${call.name}` };
				yield { kind: "tool_call_finished", id: call.id, result };
				messages.push(toolMessage(call, result));
				continue;
			}

			yield {
				kind: "tool_call_started",
				id: call.id,
				name: call.name,
				args: call.arguments,
				mutates: toolDef.mutates,
			};

			const validated = validateArgs(call.arguments, toolDef.schema);
			if (!validated.ok) {
				const result: ToolResult = { ok: false, error: `ToolArgError: ${validated.error}` };
				yield { kind: "tool_call_finished", id: call.id, result };
				messages.push(toolMessage(call, result));
				if (toolDef.stopOnFailure === true) {
					yield { kind: "done" };
					return;
				}
				continue;
			}

			if (toolDef.mutates && toolDef.requiresApproval !== false) {
				if (!opts.consent) {
					const result: ToolResult = { ok: false, error: "ConsentDeniedError: no consent manager" };
					yield { kind: "tool_call_finished", id: call.id, result };
					messages.push(toolMessage(call, result));
					continue;
				}
				yield { kind: "consent_requested", id: call.id, name: call.name };
				const approved = await opts.consent.requestApproval(toolDef, validated.value);
				if (!approved) {
					const result: ToolResult = {
						ok: false,
						error: "ConsentDeniedError",
						details: "User rejected this operation.",
					};
					yield { kind: "tool_call_finished", id: call.id, result };
					messages.push(toolMessage(call, result));
					consentDenied = true;
					continue;
				}
			}

			let result: ToolResult;
			try {
				result = await runWithTimeout(
					toolDef.run(validated.value, {
						signal: opts.signal,
						getConversationImages: opts.getConversationImages,
						getImageModel: opts.getImageModel,
					}),
					toolDef.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
					toolDef.name,
					opts.signal,
				);
			} catch (err) {
				if (err instanceof ToolTimeoutError) {
					result = { ok: false, error: "ToolTimeoutError", details: err.message };
				} else if (err instanceof Error) {
					result = { ok: false, error: err.name || "ToolError", details: err.message };
				} else {
					result = { ok: false, error: "ToolError", details: String(err) };
				}
			}

			yield { kind: "tool_call_finished", id: call.id, result };
			messages.push(toolMessage(call, result));

			if (toolDef.stopOnFailure === true && !result.ok) {
				yield { kind: "done" };
				return;
			}

			if (
				opts.resolveToolImages &&
				call.name.startsWith("vault_") &&
				result.ok
			) {
				try {
					const resolved = await opts.resolveToolImages(call.name, result);
					for (const image of resolved) {
						if (!image || typeof image.url !== "string" || seenToolImageUrls.has(image.url)) continue;
						seenToolImageUrls.add(image.url);
						toolImages.push(image);
					}
				} catch {
					// Image resolution is best-effort and must not fail the tool call.
				}
			}
		}

		if (toolImages.length > 0) {
			const n = toolImages.length;
			const list = toolImages.map((image) => `- ${image.name}`).join("\n");
			messages.push({
				role: "user",
				content: oaMultimodalContent(
					`Images referenced by the preceding vault tool result${n === 1 ? "" : "s"}. Use them as visual context:\n${list}`,
					toolImages,
				),
			});
		}

		if (consentDenied) {
			yield { kind: "done" };
			return;
		}
	}

	yield { kind: "cap_hit" };
	yield { kind: "done" };
}

function bindTools(registry?: ToolRegistry, allowlist?: string[]): BoundTools | undefined {
	if (!registry) return undefined;
	const allowedNames = allowlist && allowlist.length > 0 ? new Set(allowlist) : null;
	const tools = registry.list().filter((tool) => !allowedNames || allowedNames.has(tool.name));
	return {
		get(name: string): ToolDef | undefined {
			if (allowedNames && !allowedNames.has(name)) return undefined;
			return registry.get(name);
		},
		toApiSpec(): OpenAiToolSpec[] {
			return tools.map((tool) => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.schema,
				},
			}));
		},
	};
}

function toolMessage(call: AssembledToolCall, result: ToolResult): ChatMessage {
	return {
		role: "tool",
		tool_call_id: call.id,
		name: call.name,
		content: JSON.stringify(result),
	};
}
