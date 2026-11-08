import { describe, expect, it, vi } from "vitest";

interface MockCache {
	tags?: Array<{ tag: string }>;
	headings?: Array<{ level: number; heading: string; position: { start: { line: number } } }>;
	links?: Array<{ link: string }>;
	embeds?: Array<{ link: string }>;
	frontmatter?: Record<string, unknown>;
}

const mocks = vi.hoisted(() => {
	class MockTFile {
		path: string;
		stat = { size: 0 };
		constructor(path: string) {
			this.path = path;
		}
	}
	class MockTFolder {
		path: string;
		children: unknown[] = [];
		constructor(path: string) {
			this.path = path;
		}
	}
	return { MockTFile, MockTFolder };
});

vi.mock("obsidian", () => ({
	TFile: mocks.MockTFile,
	TFolder: mocks.MockTFolder,
	normalizePath: (path: string) => path,
	getAllTags: (cache: MockCache | null) => cache?.tags?.map((t) => t.tag) ?? [],
	parseYaml: (text: string) => {
		const out: Record<string, unknown> = {};
		for (const line of text.split("\n")) {
			const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
			if (!match) continue;
			const raw = match[2].trim();
			if (raw.startsWith("[") && raw.endsWith("]")) {
				out[match[1]] = raw
					.slice(1, -1)
					.split(",")
					.map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
					.filter((value) => value.length > 0);
			} else {
				out[match[1]] = raw.replace(/^['"]|['"]$/g, "");
			}
		}
		return out;
	},
	stringifyYaml: () => "",
}));

import { oaMarkdownTarget, oaParseMetadataFallback, oaUnique, oaWikiTarget } from "../../src/tools/vault/metadata-fallback";
import { metadataTool } from "../../src/tools/vault/metadata";

function makeApp(file: unknown, text: string, cache: MockCache | null) {
	return {
		vault: {
			getAbstractFileByPath: (path: string) => (path === (file as { path: string }).path ? file : null),
			cachedRead: async () => text,
		},
		metadataCache: {
			getFileCache: () => cache,
		},
	};
}

async function runTool(file: unknown, text: string, cache: MockCache | null) {
	const result = await metadataTool(makeApp(file, text, cache) as never).run(
		{ path: (file as { path: string }).path },
		{} as never,
	);
	expect(result.ok).toBe(true);
	return result.value as {
		frontmatter: Record<string, unknown> | null;
		tags: string[];
		headings: Array<{ level: number; text: string; line: number }>;
		outboundLinks: string[];
		embeds: string[];
	};
}

describe("oaParseMetadataFallback", () => {
	it("parses tags, headings, links, and embeds from a note with no frontmatter", () => {
		const parsed = oaParseMetadataFallback(
			"\n# Title\n\nSee [[Note A|alias]] and [Other](other.md).\n\n![[Embed]] and ![img](image.png)\n\nBody #alpha #beta\n",
		);
		expect(parsed.frontmatter).toBe(null);
		expect(parsed.headings).toEqual([{ level: 1, text: "Title", line: 1 }]);
		expect(parsed.tags).toEqual(["#alpha", "#beta"]);
		expect(parsed.outboundLinks).toEqual(["Note A", "other.md"]);
		expect(parsed.embeds).toEqual(["Embed", "image.png"]);
	});

	it("reads frontmatter tags and deduplicates them with inline tags", () => {
		const parsed = oaParseMetadataFallback("---\ntags: [alpha, beta]\n---\n# Body\n\n#alpha #gamma\n");
		expect(parsed.frontmatter).toEqual({ tags: ["alpha", "beta"] });
		expect(parsed.tags).toEqual(["#alpha", "#beta", "#gamma"]);
		expect(parsed.headings).toEqual([{ level: 1, text: "Body", line: 0 }]);
	});

	it("counts heading lines from the body and strips closing hashes", () => {
		const parsed = oaParseMetadataFallback("---\ntitle: t\n---\n## Deep ##\n\ntext\n");
		expect(parsed.headings).toEqual([{ level: 2, text: "Deep", line: 0 }]);
	});

	it("ignores tags and links inside code fences and inline code", () => {
		const parsed = oaParseMetadataFallback(
			"Issue #2024\n\n```\n#notatag [[hidden]]\n```\n\ninline `#nope` end #real\n",
		);
		expect(parsed.tags).toEqual(["#real"]);
		expect(parsed.outboundLinks).toEqual([]);
	});

	it("returns empty metadata for a note with no metadata", () => {
		const parsed = oaParseMetadataFallback("Just prose.\n");
		expect(parsed).toEqual({
			frontmatter: null,
			tags: [],
			headings: [],
			outboundLinks: [],
			embeds: [],
		});
	});
});

describe("target helpers", () => {
	it("resolves wiki targets and aliases", () => {
		expect(oaWikiTarget("Note|Alias")).toBe("Note");
		expect(oaWikiTarget("  Note  ")).toBe("Note");
	});

	it("resolves markdown targets and angle bracket form", () => {
		expect(oaMarkdownTarget("url.md \"title\"")).toBe("url.md");
		expect(oaMarkdownTarget("<url with space>")).toBe("url with space");
	});

	it("deduplicates and drops empty values", () => {
		expect(oaUnique(["a", "b", "a", ""])).toEqual(["a", "b"]);
	});
});

describe("metadataTool fallback", () => {
	const text = "---\ntags: [alpha]\n---\n# Heading\n\n[[Link A]] ![[Embed A]] #inline\n";

	it("falls back to note text when the metadata cache is empty", async () => {
		const value = await runTool(new mocks.MockTFile("Notes/idea.md"), text, null);
		expect(value.frontmatter).toEqual({ tags: ["alpha"] });
		expect(value.tags).toEqual(["#alpha", "#inline"]);
		expect(value.headings).toEqual([{ level: 1, text: "Heading", line: 0 }]);
		expect(value.outboundLinks).toEqual(["Link A"]);
		expect(value.embeds).toEqual(["Embed A"]);
	});

	it("uses fallback fields when the cache is incomplete", async () => {
		const cache: MockCache = { frontmatter: { title: "Cached Title" }, tags: [] };
		const value = await runTool(new mocks.MockTFile("Notes/idea.md"), text, cache);
		expect(value.frontmatter).toEqual({ title: "Cached Title" });
		expect(value.tags).toEqual(["#alpha", "#inline"]);
		expect(value.outboundLinks).toEqual(["Link A"]);
	});

	it("prefers complete cache data over note text", async () => {
		const cache: MockCache = {
			frontmatter: { title: "Cached Title" },
			tags: [{ tag: "#cached" }],
			headings: [{ level: 2, heading: "Cached", position: { start: { line: 5 } } }],
			links: [{ link: "cache-link" }],
			embeds: [{ link: "cache-embed" }],
		};
		const value = await runTool(new mocks.MockTFile("Notes/idea.md"), text, cache);
		expect(value.tags).toEqual(["#cached"]);
		expect(value.headings).toEqual([{ level: 2, text: "Cached", line: 5 }]);
		expect(value.outboundLinks).toEqual(["cache-link"]);
		expect(value.embeds).toEqual(["cache-embed"]);
	});
});
