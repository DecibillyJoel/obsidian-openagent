import { describe, expect, it, vi } from "vitest";

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
}));

import { searchTool } from "../../src/tools/vault/search";

interface AppOptions {
	/** Markdown file paths visible to the vault. */
	files: string[];
	/** Folder paths that resolve through getAbstractFileByPath. */
	folders?: string[];
	/** Wikilink target -> resolved file path. An absent target stays unresolved. */
	links?: Record<string, string>;
	/** File path -> note content for full-text scanning. */
	contents?: Record<string, string>;
}

function makeApp(options: AppOptions) {
	const { files, folders = [], links = {}, contents = {} } = options;
	const tfiles = files.map((path) => new mocks.MockTFile(path));
	const tfolderByPath = new Map(folders.map((path) => [path, new mocks.MockTFolder(path)]));
	const tfileByPath = new Map(tfiles.map((file) => [file.path, file]));
	return {
		vault: {
			getAbstractFileByPath: (path: string) => tfolderByPath.get(path) ?? tfileByPath.get(path) ?? null,
			getMarkdownFiles: () => tfiles,
			cachedRead: async (file: { path: string }) => contents[file.path] ?? "",
		},
		metadataCache: {
			getFirstLinkpathDest: (target: string) => tfileByPath.get(links[target] ?? "") ?? null,
			getFileCache: () => null,
		},
	};
}

async function runSearch(app: unknown, query: string, scope?: { folder?: string; tag?: string; limit?: number }) {
	return searchTool(app as never).run({ query, scope }, {} as never);
}

describe("vault_search folder scope ordering", () => {
	it("validates the folder scope before it resolves a wikilink path", async () => {
		// The wikilink would resolve, but the missing folder scope must fail first.
		const app = makeApp({ files: ["Docs/Inside.md"], links: { Inside: "Docs/Inside.md" } });
		const result = await runSearch(app, "[[Inside]]", { folder: "Missing" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("NotFound: Missing");
	});

	it("rejects a folder scope that points at a file instead of a folder", async () => {
		const app = makeApp({ files: ["Docs/Inside.md"], links: { Inside: "Docs/Inside.md" } });
		const result = await runSearch(app, "[[Inside]]", { folder: "Docs/Inside.md" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("NotAFolder: Docs/Inside.md");
	});

	it("does not return a linkpath match that sits outside the folder scope", async () => {
		const app = makeApp({
			files: ["Docs/Note.md", "Other/Outside.md"],
			folders: ["Docs"],
			links: { Outside: "Other/Outside.md" },
			contents: { "Docs/Note.md": "nothing here", "Other/Outside.md": "nothing here" },
		});
		const result = await runSearch(app, "[[Outside]]", { folder: "Docs" });
		expect(result.ok).toBe(true);
		const value = result.value as { matches: Array<{ path: string }>; strategy: string };
		expect(value.strategy).toBe("fulltext");
		expect(value.matches.map((match) => match.path)).not.toContain("Other/Outside.md");
	});

	it("still returns a linkpath match that sits inside the folder scope", async () => {
		const app = makeApp({
			files: ["Docs/Inside.md"],
			folders: ["Docs"],
			links: { Inside: "Docs/Inside.md" },
		});
		const result = await runSearch(app, "[[Inside]]", { folder: "Docs" });
		expect(result.ok).toBe(true);
		const value = result.value as { matches: Array<{ path: string }>; strategy: string };
		expect(value.strategy).toBe("linkpath");
		expect(value.matches[0].path).toBe("Docs/Inside.md");
	});

	it("keeps resolving linkpaths when no folder scope is set", async () => {
		const app = makeApp({ files: ["Other/Outside.md"], links: { Outside: "Other/Outside.md" } });
		const result = await runSearch(app, "[[Outside]]");
		expect(result.ok).toBe(true);
		const value = result.value as { strategy: string };
		expect(value.strategy).toBe("linkpath");
	});
});
