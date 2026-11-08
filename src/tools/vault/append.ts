import { type App, TFile, TFolder } from "obsidian";
import { type UndoBuffer } from "../../consent/undo";
import { defineTool, fail, ok } from "../define";
import { PathError, safeVaultPath } from "./path-safe";

interface Args {
	path: string;
	content: string;
	ensureNewline?: boolean;
}

export function appendTool(app: App, undo: UndoBuffer) {
	return defineTool<Args>({
		name: "vault_append",
		description:
			"Append text to an EXISTING TEXT FILE. The tool never creates a file and rejects folders. By default it inserts one newline before the appended content only when the existing file is non-empty and lacks a trailing newline.",
		category: "vault_write",
		mutates: true,
		schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Exact vault-relative path of an EXISTING TEXT FILE, including its extension such as `.md`.",
				},
				content: {
					type: "string",
					description: "Literal text to append; it is not parsed as frontmatter.",
				},
				ensureNewline: {
					type: "boolean",
					description: "When true (default), insert a newline separator if the existing non-empty file lacks one.",
				},
			},
			required: ["path", "content"],
		},
		async run(args) {
			let p: string;
			try {
				p = safeVaultPath(args.path);
			} catch (e) {
				if (e instanceof PathError) return fail(`PathError: ${e.message}`);
				throw e;
			}
			const file = app.vault.getAbstractFileByPath(p);
			if (file instanceof TFolder) return fail(`IsFolder: ${p}`);
			if (!(file instanceof TFile)) return fail(`NotFound: ${p}`);

			const before = await app.vault.read(file);
			const ensureNewline = args.ensureNewline ?? true;
			const sep = ensureNewline && before.length > 0 && !before.endsWith("\n") ? "\n" : "";
			const after = before + sep + args.content;

			await app.vault.modify(file, after);
			undo.record({ path: p, before, after });

			return ok({ path: p, bytesAppended: after.length - before.length });
		},
	});
}
