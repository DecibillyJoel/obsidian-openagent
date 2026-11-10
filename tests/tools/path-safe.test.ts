import { describe, expect, it, vi } from "vitest";

// Obsidian's normalizePath removes a leading slash, so the check after it can
// never see an absolute path. This mock copies that behavior.
vi.mock("obsidian", () => ({
	normalizePath: (path: string) =>
		path
			.replace(/\\/g, "/")
			.replace(/\/+/g, "/")
			.replace(/^\//, "")
			.replace(/\/$/, ""),
}));

import { PathError, safeVaultPath } from "../../src/tools/vault/path-safe";

describe("safeVaultPath", () => {
	it("rejects an absolute path", () => {
		expect(() => safeVaultPath("/Notes/a.md")).toThrow(PathError);
	});

	it("accepts a vault-relative path", () => {
		expect(safeVaultPath("Notes/a.md")).toBe("Notes/a.md");
	});

	it("rejects a path that escapes the vault root", () => {
		expect(() => safeVaultPath("../secret.md")).toThrow(PathError);
	});
});
