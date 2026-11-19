import type { OpenAiToolSpec, ToolDef } from "../types";

function isToolAvailable(tool: ToolDef): boolean {
	try {
		return tool.isAvailable?.() ?? true;
	} catch {
		// One throwing predicate hides one tool. It must not abort the whole spec.
		return false;
	}
}

export class ToolRegistry {
	private readonly tools = new Map<string, ToolDef>();

	register(tool: ToolDef): void {
		this.tools.set(tool.name, tool);
	}

	registerAll(tools: ToolDef[]): void {
		for (const t of tools) this.register(t);
	}

	get(name: string): ToolDef | undefined {
		const tool = this.tools.get(name);
		return tool && isToolAvailable(tool) ? tool : undefined;
	}

	list(): ToolDef[] {
		return [...this.tools.values()].filter(isToolAvailable);
	}

	size(): number {
		return this.tools.size;
	}

	toApiSpec(): OpenAiToolSpec[] {
		return this.list().map((t) => ({
			type: "function",
			function: {
				name: t.name,
				description: t.description,
				parameters: t.schema,
			},
		}));
	}
}
