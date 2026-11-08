import type { ConsentManager } from "../consent/manager";
import type { ResolveToolImages } from "../images/attachments";
import type { ToolRegistry } from "../tools/registry";
import type { ChatMessage, GetImageModel, JsonSchema, LoopEvent, ModelProvider, ResponseFormatConfig } from "../types";
import type { Agent } from "./agent";

export interface AgentDefinition {
	id: string;
	name: string;
	systemPrompt?: string;
	toolAllowlist?: string[];
	maxSteps?: number;
}

export interface AgentRunOptions {
	messages: ChatMessage[];
	provider: ModelProvider;
	signal?: AbortSignal;
	tools?: ToolRegistry;
	consent?: ConsentManager;
	systemPrompt?: string;
	maxSteps?: number;
	responseFormat?: ResponseFormatConfig;
	resolveToolImages?: ResolveToolImages;
	getImageModel?: GetImageModel;
}

export type AgentEvent = LoopEvent;

export interface StructuredOutputSchema<TValue = unknown> {
	name: string;
	schema: JsonSchema;
	readonly __output?: TValue;
}

export interface StructuredOutputAttemptFailure {
	attempt: number;
	reason: string;
	rawText: string;
	validationErrors?: string[];
}

export interface StructuredOutputSuccess<TData> {
	ok: true;
	attempts: number;
	rawText: string;
	value: TData;
}

export interface StructuredOutputFailure {
	ok: false;
	attempts: number;
	rawText: string;
	reason: string;
	validationErrors?: string[];
}

export type StructuredOutputResult<TValue> = StructuredOutputSuccess<TValue> | StructuredOutputFailure;

export interface RunStructuredStepOptions<TValue = unknown> {
	agent: Agent;
	provider: ModelProvider;
	messages: ChatMessage[];
	schema: StructuredOutputSchema<TValue>;
	signal?: AbortSignal;
	tools?: ToolRegistry;
	consent?: ConsentManager;
	onAgentEvent?: (event: AgentEvent) => void | Promise<void>;
	onRetry?: (failure: StructuredOutputAttemptFailure) => void | Promise<void>;
}

export type PipelineStepState = "pending" | "running" | "complete" | "failed";

export interface PipelineStepStatusEvent {
	kind: "step";
	stepId: string;
	label: string;
	state: PipelineStepState;
	message?: string;
}

export interface PipelineStructuredRetryEvent {
	kind: "structured_retry";
	stepId: string;
	label: string;
	attempt: number;
	maxAttempts: number;
	reason: string;
}

export type PipelineEvent = PipelineStepStatusEvent | PipelineStructuredRetryEvent;

export type PipelineHelpers = Record<string, never>;

export interface PipelineTaskStep<TContext, TOutput> {
	id: string;
	label: string;
	kind?: "task";
	run: (context: TContext, helpers: PipelineHelpers) => Promise<TOutput>;
	apply: (context: TContext, output: TOutput) => TContext | Promise<TContext>;
}

export interface PipelineStructuredStep<TContext, TOutput> {
	id: string;
	label: string;
	kind: "structured";
	prepare: (context: TContext, helpers: PipelineHelpers) => Promise<Omit<RunStructuredStepOptions<TOutput>, "onRetry">>;
	apply: (context: TContext, output: TOutput) => TContext | Promise<TContext>;
}

export type PipelineStep<TContext> =
	| PipelineTaskStep<TContext, unknown>
	| PipelineStructuredStep<TContext, unknown>;

export interface PipelineFailureResult<TContext> {
	ok: false;
	context: TContext;
	failedStepId: string;
	error: StructuredOutputFailure | Error;
}

export interface PipelineSuccessResult<TContext> {
	ok: true;
	context: TContext;
}

export type PipelineResult<TContext> = PipelineSuccessResult<TContext> | PipelineFailureResult<TContext>;
