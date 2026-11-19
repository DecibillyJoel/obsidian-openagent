import type { JsonSchema, ToolCategory, ToolContext, ToolDef, ToolResult } from "../types";

interface ToolSpec<TArgs> {
	name: string;
	description: string;
	schema: JsonSchema;
	category: ToolCategory;
	mutates: boolean;
	requiresApproval?: boolean; // default true — set false to skip the consent prompt
	isAvailable?: () => boolean; // default true — return false to hide the tool from the model
	stopOnFailure?: boolean; // default false — when true, a failed call ends the run
	timeoutMs?: number;
	run(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<TArgs = Record<string, unknown>>(spec: ToolSpec<TArgs>): ToolDef<TArgs> {
	return spec;
}

export function ok(value: unknown): ToolResult {
	return { ok: true, value };
}

export function fail(error: string, details?: unknown): ToolResult {
	return { ok: false, error, details };
}
