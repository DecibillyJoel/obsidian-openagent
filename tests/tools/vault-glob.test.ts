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
		constructor(path: string, children: unknown[] = []) {
			this.path = path;
			this.children = children;
		}
	}
	return { MockTFile, MockTFolder };
});

vi.mock("obsidian", () => ({
	TFile: mocks.MockTFile,
	TFolder: mocks.MockTFolder,
}));

import { globToRegex, listTool } from "../../src/tools/vault/list";

interface Entry {
	path: string;
	type: "file" | "folder";
}

function makeApp(paths: string[]) {
	const files = paths.map((path) => (path.endsWith("/") ? new mocks.MockTFolder(path) : new mocks.MockTFile(path)));
	return {
		vault: {
			getAllLoadedFiles: () => files,
		},
	};
}

async function listPaths(app: unknown, glob: string): Promise<string[]> {
	const result = await listTool(app as never).run({ glob, type: "file" }, {} as never);
	expect(result.ok).toBe(true);
	const value = result.value as { entries: Entry[] };
	return value.entries.map((entry) => entry.path);
}

describe("globToRegex leading ** command", () => {
	it("treats a leading **/ as zero or more folders", () => {
		const re = globToRegex("**/*.md");
		expect(re.test("Note.md")).toBe(true);
		expect(re.test("Daily/Note.md")).toBe(true);
		expect(re.test("a/b/c/Note.md")).toBe(true);
		expect(re.test("Note.txt")).toBe(false);
	});

	it("matches every depth for a bare **/ pattern", () => {
		const re = globToRegex("**/*");
		expect(re.test("Note.md")).toBe(true);
		expect(re.test("Daily/Note.md")).toBe(true);
	});
});

describe("globToRegex literal characters", () => {
	it("treats brackets and braces as literal characters in a glob", () => {
		expect(globToRegex("[a]{b}.md").test("[a]{b}.md")).toBe(true);
		expect(globToRegex("[a]{b}.md").test("a.md")).toBe(false);
	});
});

describe("vault_list glob matching", () => {
	it("includes root-level and nested Markdown files for **/*.md", async () => {
		const app = makeApp(["Note.md", "Daily/", "Daily/Note.md", "a/b/Note.md", "readme.txt"]);
		const paths = await listPaths(app, "**/*.md");
		expect(paths).toEqual(["Note.md", "Daily/Note.md", "a/b/Note.md"]);
	});

	it("still limits a single star to one path segment", async () => {
		const app = makeApp(["Note.md", "Daily/", "Daily/Note.md"]);
		const paths = await listPaths(app, "*.md");
		expect(paths).toEqual(["Note.md"]);
	});
});
