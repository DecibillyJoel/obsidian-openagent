import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	parseYaml: (text: string): unknown => {
		const result: Record<string, unknown> = {};
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (line === "" || line.startsWith("#")) continue;
			if (/^[ \t]/.test(raw)) continue;
			const match = /^([^:#]+):(?:\s+(.*))?$/.exec(line);
			if (!match) throw new Error(`Invalid frontmatter YAML: ${raw}`);
			result[(match[1] ?? "").trim()] = (match[2] ?? "").trim();
		}
		return result;
	},
	stringifyYaml: (value: unknown): string => {
		const entries = Object.entries(value as Record<string, unknown>);
		return entries
			.map(([key, item]) => {
				if (item === null || item === undefined) return `${key}: null`;
				if (typeof item === "object") return `${key}: ${JSON.stringify(item)}`;
				return `${key}: ${String(item)}`;
			})
			.join("\n");
	},
}));

import { mergeFrontmatter, stitchFrontmatter } from "../../src/tools/vault/frontmatter";

const BLOCK_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function splitBlock(text: string): { block: string; body: string } {
	const match = BLOCK_PATTERN.exec(text);
	if (!match) return { block: "", body: text };
	return { block: match[1] ?? "", body: text.slice(match[0].length) };
}

/** Run the vault_write frontmatter path over a file text. */
function writeFrontmatter(before: string, incoming: Record<string, unknown>): string {
	const { block, body } = splitBlock(before);
	const merged = mergeFrontmatter(block, incoming);
	return stitchFrontmatter(merged, body);
}

describe("vault_write frontmatter", () => {
	it("keeps comments and ordering when only one key changes", () => {
		const before = "---\n# my note\ntags: [a]\ndate: 2020-01-01\n---\nbody\n";
		const after = writeFrontmatter(before, { date: "2021-02-02" });
		expect(after).toContain("# my note");
		expect(after.indexOf("tags")).toBeLessThan(after.indexOf("date"));
		expect(after).toContain("date: 2021-02-02");
	});

	it("keeps the block when the existing YAML cannot be parsed", () => {
		const before = "---\n: : broken\n---\nbody\n";
		const after = writeFrontmatter(before, { tags: ["x"] });
		expect(after).toContain(": : broken");
	});

	it("adds a key that the file does not have", () => {
		expect(writeFrontmatter("---\ntags: [a]\n---\nbody\n", { star: true })).toContain("star: true");
	});
});
