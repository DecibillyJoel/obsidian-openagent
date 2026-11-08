import { type App, TFile, TFolder } from "obsidian";
import { type UndoBuffer } from "../../consent/undo";
import { defineTool, fail, ok } from "../define";
import { PathError, safeVaultPath } from "./path-safe";
import { NotAFolderError, openAgentEnsureFolderPath } from "./ensure-folder";

interface Args {
	path: string;
}

export function openAgentVaultDeleteTool(app: App, undo: UndoBuffer) {
	return defineTool<Args>({
		name: "vault_delete",
		description:
			"Move an existing FILE OR FOLDER into the vault's `.trash` folder without reading or copying its contents. This is a low-memory move, including for large non-empty folders. A UTC timestamp is appended to the item name to prevent collisions; for files it is inserted before the extension (for example `note.md` becomes `.trash/note-20260830T140000000Z.md`). OpenAgent records only the original and trash paths for `Undo last tool write`; undo history is lost when the plugin/view unloads.",
		category: "vault_write",
		mutates: true,
		schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Exact vault-relative FILE OR FOLDER path to move into `.trash`. For files, include the extension such as `.md`. The `.trash` folder itself and items already under `.trash` are rejected.",
				},
			},
			required: ["path"],
		},
		async run(args) {
			let p: string;
			try {
				p = safeVaultPath(args.path);
			} catch (e) {
				if (e instanceof PathError) return fail(`PathError: ${e.message}`);
				throw e;
			}

			if (p === ".trash" || p.startsWith(".trash/")) {
				return fail("InvalidDelete: cannot delete .trash or an item already inside it");
			}

			const item = app.vault.getAbstractFileByPath(p);
			if (!(item instanceof TFile) && !(item instanceof TFolder)) return fail(`NotFound: ${p}`);

			try {
				await openAgentEnsureFolderPath(app, ".trash");
			} catch (e) {
				if (e instanceof NotAFolderError) return fail(e.message);
				throw e;
			}

			const trashPath = openAgentTrashPath(app, p, item);
			await app.vault.rename(item, trashPath);
			const type = item instanceof TFolder ? "folder" : "file";
			undo.record({ kind: "trash-move", from: p, to: trashPath, itemType: type });
			return ok({ path: p, trashPath, type, trashed: true, lowMemory: true });
		},
	});
}

function openAgentTrashTimestamp(): string {
	return new Date().toISOString().replace(/[-:.]/g, "");
}

function openAgentTrashPath(app: App, path: string, item: TFile | TFolder): string {
	const basename = path.slice(path.lastIndexOf("/") + 1);
	let stem = basename;
	let ext = "";
	if (item instanceof TFile) {
		const dot = basename.lastIndexOf(".");
		if (dot > 0) {
			stem = basename.slice(0, dot);
			ext = basename.slice(dot);
		}
	}
	let candidate = `.trash/${stem}-${openAgentTrashTimestamp()}${ext}`;
	let counter = 2;
	while (app.vault.getAbstractFileByPath(candidate)) {
		candidate = `.trash/${stem}-${openAgentTrashTimestamp()}-${counter++}${ext}`;
	}
	return candidate;
}
