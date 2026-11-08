import { type App, TFile, TFolder } from "obsidian";
import { type UndoBuffer } from "../../consent/undo";
import { defineTool, fail, ok } from "../define";
import { PathError, safeVaultPath } from "./path-safe";

interface Args {
	path: string;
	newName: string;
}

export function openAgentVaultRenameTool(app: App, undo: UndoBuffer) {
	return defineTool<Args>({
		name: "vault_rename",
		description:
			"Rename an existing FILE OR FOLDER within its current parent. Folders may be non-empty. IMPORTANT FOR FILES: `newName` is used LITERALLY and MUST INCLUDE the desired extension, such as `.md`; the tool does NOT preserve or add an omitted extension. To change only the stem of `Notes/old.md`, use `newName: new.md`. For folders, use only the new folder name, for example `Antagonists`. `newName` must not contain a path. Existing destinations are rejected. Obsidian updates internal links according to user preferences.",
		category: "vault_write",
		mutates: true,
		schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Exact vault-relative source FILE OR FOLDER path. For files, include the current extension, for example `Notes/old.md`.",
				},
				newName: {
					type: "string",
					description:
						"New FILE OR FOLDER name only, without a parent path. For a file, MUST INCLUDE the desired extension (for example `new.md`); omitted extensions are NOT preserved automatically. For a folder, provide the new directory name without a slash.",
				},
			},
			required: ["path", "newName"],
		},
		async run(args) {
			let p: string;
			let newName: string;
			try {
				p = safeVaultPath(args.path);
				newName = safeVaultPath(args.newName);
			} catch (e) {
				if (e instanceof PathError) return fail(`PathError: ${e.message}`);
				throw e;
			}
			if (newName.includes("/")) return fail("PathError: newName must be a single name, not a path");

			const item = app.vault.getAbstractFileByPath(p);
			if (!(item instanceof TFile) && !(item instanceof TFolder)) return fail(`NotFound: ${p}`);

			const slash = p.lastIndexOf("/");
			const dest = slash < 0 ? newName : `${p.slice(0, slash)}/${newName}`;
			if (dest === p) return fail("NoOpError: new name is unchanged");
			if (app.vault.getAbstractFileByPath(dest)) return fail(`AlreadyExists: ${dest}`);

			await app.fileManager.renameFile(item, dest);
			const type = item instanceof TFolder ? "folder" : "file";
			undo.record({ kind: "move", from: p, to: dest, itemType: type });
			return ok({ from: p, to: dest, type });
		},
	});
}
