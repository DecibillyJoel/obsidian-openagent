export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCallSpec {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ChatContentTextPart {
	type: "text";
	text: string;
}

export interface ChatContentImagePart {
	type: "image_url";
	image_url: { url: string };
}

export type ChatContentPart = ChatContentTextPart | ChatContentImagePart;

// The resolved source images for an `image_generate` call plus one display name per
// reference, in the same order.
export interface GenerationReferenceResult {
	references: ChatContentImagePart[];
	names: string[];
}

export interface ChatMessage {
	role: Role;
	content: string | ChatContentPart[];
	tool_calls?: ToolCallSpec[];
	tool_call_id?: string;
	name?: string;
}

// A generated image persisted at the vault root and shown in the transcript.
export interface GeneratedImage {
	path: string;
	prompt: string;
	model: string;
	source?: "vault";
	referenceImageNames?: string[];
}

// A reference to an image already present in the conversation. Attached images use
// `url`; generated images use `path`.
export interface ConversationImageReference {
	url?: string;
	path?: string;
	name?: string;
}

export type GetConversationImages = () =>
	| ConversationImageReference[]
	| Promise<ConversationImageReference[]>;

export type GetImageModel = () => string | Promise<string>;

export interface AssembledToolCall {
	id: string;
	name: string;
	arguments: unknown;
	rawArguments: string;
}

export type StreamEvent =
	| { kind: "text"; text: string; degraded?: boolean }
	| { kind: "images"; urls: string[] }
	| { kind: "thinking_text"; text: string }
	| { kind: "tool_call_assembled"; calls: AssembledToolCall[]; degraded?: boolean }
	| { kind: "done"; finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "unknown" };

export interface ResponseFormatJsonSchemaConfig {
	name: string;
	schema: JsonSchema;
	strict?: boolean;
}

export interface ResponseFormatConfig {
	type: "json_schema";
	json_schema: ResponseFormatJsonSchemaConfig;
}

export interface StreamOptions {
	signal?: AbortSignal;
	tools?: OpenAiToolSpec[];
	responseFormat?: ResponseFormatConfig;
}

export interface OpenAiToolSpec {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: JsonSchema;
	};
}

export interface ModelProvider {
	stream(messages: ChatMessage[], opts?: StreamOptions): AsyncIterable<StreamEvent>;
	listModels?(): Promise<string[]>;
}

// JSON Schema (subset we support)
export interface JsonSchemaProperty {
	type: "string" | "number" | "integer" | "boolean" | "object" | "array";
	description?: string;
	enum?: readonly unknown[];
	items?: JsonSchemaProperty;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
	additionalProperties?: boolean;
	default?: unknown;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
}

export interface JsonSchema {
	type: "object";
	properties: Record<string, JsonSchemaProperty>;
	required?: string[];
	additionalProperties?: boolean;
}

// Tool definitions
export type ToolCategory = "vault_read" | "vault_write";

export type ToolResult =
	| { ok: true; value: unknown }
	| { ok: false; error: string; details?: unknown };

export interface ToolContext {
	signal?: AbortSignal;
	getConversationImages?: GetConversationImages;
	getImageModel?: GetImageModel;
}

export interface ToolDef<TArgs = unknown> {
	name: string;
	description: string;
	schema: JsonSchema;
	category: ToolCategory;
	mutates: boolean;
	requiresApproval?: boolean; // default true — set false to skip the consent prompt
	stopOnFailure?: boolean; // default false — when true, a failed call ends the run
	timeoutMs?: number;
	run(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

// Consent
export type ConsentMode = "always" | "ask" | "never";

export interface ConsentDecision {
	approved: boolean;
	approveAllSession?: boolean;
}

// Loop events
export type LoopEvent =
	| { kind: "text"; text: string; degraded?: boolean }
	| { kind: "images"; urls: string[] }
	| { kind: "thinking_text"; text: string }
	| { kind: "tool_call_started"; id: string; name: string; args: unknown; mutates: boolean }
	| { kind: "consent_requested"; id: string; name: string }
	| { kind: "tool_call_finished"; id: string; result: ToolResult }
	| { kind: "cap_hit" }
	| { kind: "done" };

// Errors
export class AuthError extends Error {
	constructor(message = "Authentication failed") {
		super(message);
		this.name = "AuthError";
	}
}

export class RateLimitError extends Error {
	constructor(message = "Rate limit exceeded") {
		super(message);
		this.name = "RateLimitError";
	}
}

export class NetworkError extends Error {
	constructor(message = "Network error") {
		super(message);
		this.name = "NetworkError";
	}
}

export class ProviderError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "ProviderError";
		this.status = status;
	}
}

export class ToolCallParseError extends Error {
	readonly toolCallId: string;
	constructor(toolCallId: string, message = "Failed to parse tool call arguments") {
		super(message);
		this.name = "ToolCallParseError";
		this.toolCallId = toolCallId;
	}
}
