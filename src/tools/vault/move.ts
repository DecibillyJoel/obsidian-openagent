import { type App, TFile, TFolder } from "obsidian";
import { type UndoBuffer } from "../../consent/undo";
import { defineTool, fail, ok } from "../define";
import { PathError, safeVaultPath } from "./path-safe";
import { NotAFolderError, ensureParentFolder } from "./ensure-folder";

interface Args {
	path: string;
	newPath: string;
}

export function openAgentVaultMoveTool(app: App, undo: UndoBuffer) {
	return defineTool<Args>({
		name: "vault_move",
		description:
			"Move an existing FILE OR FOLDER, including an entire non-empty folder tree. `newPath` is used LITERALLY and is the COMPLETE destination including the item name. IMPORTANT FOR FILES: include the desired filename extension, such as `.md`; the tool does NOT preserve or add an omitted extension. Example file move: `Notes/old.md` to `Archive/old.md`. Example folder move: `Characters/Villains` to `Archive/Villains`. Missing destination parents are created, existing destinations are rejected, and a folder cannot move inside itself. Obsidian updates internal links according to user preferences.",
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
				newPath: {
					type: "string",
					description:
						"Complete vault-relative destination path including the new item name. For files, MUST INCLUDE the desired extension (for example `Archive/old.md`); omitted extensions are NOT preserved automatically. For folders, end with the destination folder name.",
				},
			},
			required: ["path", "newPath"],
		},
		async run(args) {
			let p: string;
			let dest: string;
			try {
				p = safeVaultPath(args.path);
				dest = safeVaultPath(args.newPath);
			} catch (e) {
				if (e instanceof PathError) return fail(`PathError: ${e.message}`);
				throw e;
			}

			const item = app.vault.getAbstractFileByPath(p);
			if (!(item instanceof TFile) && !(item instanceof TFolder)) return fail(`NotFound: ${p}`);
			if (dest === p) return fail("NoOpError: destination is unchanged");
			if (item instanceof TFolder && dest.startsWith(`${p}/`)) {
				return fail("InvalidMove: a folder cannot be moved inside itself");
			}
			if (app.vault.getAbstractFileByPath(dest)) return fail(`AlreadyExists: ${dest}`);

			try {
				await ensureParentFolder(app, dest);
			} catch (e) {
				if (e instanceof NotAFolderError) return fail(e.message);
				throw e;
			}

			await app.fileManager.renameFile(item, dest);
			const type = item instanceof TFolder ? "folder" : "file";
			undo.record({ kind: "move", from: p, to: dest, itemType: type });
			return ok({ from: p, to: dest, type });
		},
	});
}
