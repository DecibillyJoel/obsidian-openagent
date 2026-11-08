import { describe, expect, it } from "vitest";
import { validateArgs } from "../../src/tools/validate";
import type { JsonSchema } from "../../src/types";

function schema(overrides: Partial<JsonSchema> = {}): JsonSchema {
	return {
		type: "object",
		properties: {
			name: { type: "string" },
			count: { type: "integer" },
		},
		...overrides,
	};
}

describe("validateArgs unknown fields", () => {
	it("silently ignores unknown fields when additionalProperties is not declared", () => {
		expect(validateArgs({ name: "cat", extra: true }, schema())).toEqual({
			ok: true,
			value: { name: "cat", extra: true },
		});
	});

	it("silently ignores unknown fields when additionalProperties is true", () => {
		expect(validateArgs({ name: "cat", extra: true }, schema({ additionalProperties: true }))).toEqual({
			ok: true,
			value: { name: "cat", extra: true },
		});
	});

	it("rejects a root unknown field when additionalProperties is false", () => {
		expect(validateArgs({ name: "cat", extra: true }, schema({ additionalProperties: false }))).toEqual({
			ok: false,
			error: "unexpected field 'extra'",
		});
	});

	it("rejects a nested unknown field with a dotted path when additionalProperties is false", () => {
		const nested: JsonSchema = {
			type: "object",
			properties: {
				config: {
					type: "object",
					properties: { name: { type: "string" } },
					additionalProperties: false,
				},
			},
		};
		expect(validateArgs({ config: { name: "cat", extra: true } }, nested)).toEqual({
			ok: false,
			error: "unexpected field 'config.extra'",
		});
	});

	it("ignores nested unknown fields when the nested schema does not declare additionalProperties", () => {
		const nested: JsonSchema = {
			type: "object",
			properties: {
				config: {
					type: "object",
					properties: { name: { type: "string" } },
				},
			},
		};
		expect(validateArgs({ config: { name: "cat", extra: true } }, nested)).toEqual({
			ok: true,
			value: { config: { name: "cat", extra: true } },
		});
	});
});
