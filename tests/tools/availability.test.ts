import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolDef } from "../../src/types";

function makeTool(name: string, isAvailable?: () => boolean): ToolDef {
	return {
		name,
		description: `${name} tool`,
		schema: { type: "object", properties: {} },
		category: "vault_read",
		mutates: false,
		isAvailable,
		run: async () => ({ ok: true, value: name }),
	};
}

describe("ToolRegistry availability gating", () => {
	it("lists and gets a tool that has no isAvailable", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool("always_on"));

		expect(registry.list().map((t) => t.name)).toEqual(["always_on"]);
		expect(registry.get("always_on")?.name).toBe("always_on");
	});

	it("hides an unavailable tool from list() and get()", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool("shown", () => true));
		registry.register(makeTool("hidden", () => false));

		expect(registry.list().map((t) => t.name)).toEqual(["shown"]);
		expect(registry.get("hidden")).toBeUndefined();
		expect(registry.get("shown")?.name).toBe("shown");
	});

	it("omits an unavailable tool from toApiSpec()", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool("shown", () => true));
		registry.register(makeTool("hidden", () => false));

		const names = registry.toApiSpec().map((spec) => spec.function.name);
		expect(names).toEqual(["shown"]);
	});

	it("follows the predicate when its result changes at runtime", () => {
		const registry = new ToolRegistry();
		let configured = false;
		registry.register(makeTool("gated", () => configured));

		expect(registry.list()).toEqual([]);
		expect(registry.get("gated")).toBeUndefined();
		expect(registry.toApiSpec()).toEqual([]);

		configured = true;

		expect(registry.list().map((t) => t.name)).toEqual(["gated"]);
		expect(registry.get("gated")?.name).toBe("gated");
		expect(registry.toApiSpec().map((spec) => spec.function.name)).toEqual(["gated"]);

		configured = false;

		expect(registry.list()).toEqual([]);
		expect(registry.get("gated")).toBeUndefined();
	});

	it("hides only the tool whose predicate throws", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool("shown", () => true));
		registry.register(makeTool("broken", () => {
			throw new Error("predicate failed");
		}));

		expect(registry.list().map((t) => t.name)).toEqual(["shown"]);
	});

	it("keeps size() reporting every registered tool", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool("shown", () => true));
		registry.register(makeTool("hidden", () => false));

		expect(registry.size()).toBe(2);
	});
});
