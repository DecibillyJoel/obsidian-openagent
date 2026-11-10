import type { JsonSchema, JsonSchemaProperty } from "../types";

export type ValidationResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

export function validateArgs(args: unknown, schema: JsonSchema): ValidationResult {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return { ok: false, error: "expected object arguments" };
	}
	const obj = args as Record<string, unknown>;

	for (const key of schema.required ?? []) {
		if (!(key in obj)) return { ok: false, error: `missing required field '${key}'` };
	}

	for (const [key, value] of Object.entries(obj)) {
		const propSchema = schema.properties[key];
		if (!propSchema) {
			if (schema.additionalProperties === false) {
				return { ok: false, error: `unexpected field '${key}'` };
			}
			continue;
		}
		const r = validateProp(value, propSchema, key);
		if (!r.ok) return r;
	}

	return { ok: true, value: obj };
}

function validateProp(value: unknown, schema: JsonSchemaProperty, path: string): ValidationResult {
	const t = schema.type;
	const actualType = jsType(value);

	if (t === "integer") {
		if (typeof value !== "number" || !Number.isInteger(value)) {
			return { ok: false, error: `field '${path}' expected integer, got ${actualType}` };
		}
	} else if (t === "array") {
		if (!Array.isArray(value)) return { ok: false, error: `field '${path}' expected array, got ${actualType}` };
		if (schema.items) {
			for (let i = 0; i < value.length; i++) {
				const r = validateProp(value[i], schema.items, `${path}[${i}]`);
				if (!r.ok) return r;
			}
		}
	} else if (t === "object") {
		if (actualType !== "object") {
			return { ok: false, error: `field '${path}' expected object, got ${actualType}` };
		}
		if (schema.properties) {
			const obj = value as Record<string, unknown>;
			for (const k of schema.required ?? []) {
				if (!(k in obj)) return { ok: false, error: `field '${path}.${k}' is required` };
			}
			for (const [k, v] of Object.entries(obj)) {
				const sub = schema.properties[k];
				if (!sub) {
					if (schema.additionalProperties === false) {
						return { ok: false, error: `unexpected field '${path}.${k}'` };
					}
					continue;
				}
				const r = validateProp(v, sub, `${path}.${k}`);
				if (!r.ok) return r;
			}
		}
	} else {
		if (actualType !== t) return { ok: false, error: `field '${path}' expected ${t}, got ${actualType}` };
	}

	if (schema.enum && !schema.enum.includes(value)) {
		return { ok: false, error: `field '${path}' must be one of ${JSON.stringify(schema.enum)}` };
	}

	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) {
			return { ok: false, error: `field '${path}' must be >= ${schema.minimum}` };
		}
		if (schema.maximum !== undefined && value > schema.maximum) {
			return { ok: false, error: `field '${path}' must be <= ${schema.maximum}` };
		}
	}
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			return { ok: false, error: `field '${path}' must be at least ${schema.minLength} chars` };
		}
		if (schema.maxLength !== undefined && value.length > schema.maxLength) {
			return { ok: false, error: `field '${path}' must be at most ${schema.maxLength} chars` };
		}
		if (schema.pattern !== undefined) {
			let re: RegExp | undefined = undefined;
			try {
				re = new RegExp(schema.pattern);
			} catch {
				re = undefined;
			}
			if (re !== undefined && !re.test(value)) {
				return { ok: false, error: `field '${path}' must match pattern '${schema.pattern}'` };
			}
		}
	}

	return { ok: true, value: value as Record<string, unknown> };
}

function jsType(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}
