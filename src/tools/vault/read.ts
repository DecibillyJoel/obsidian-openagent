import { type App, TFile, TFolder } from "obsidian";
import { defineTool, fail, ok } from "../define";
import { PathError, safeVaultPath } from "./path-safe";
import { splitFrontmatter } from "./frontmatter";
import { oaImageMimeFromTarget } from "../../images/attachments";

interface Args {
	path: string;
}

interface FolderEntry {
	path: string;
	type: "file" | "folder";
	size?: number;
	children?: number;
}

export function readTool(app: App) {
	return defineTool<Args>({
		name: "vault_read",
		description:
			"Read one file, or inspect one folder. Text-file results return parsed frontmatter and body. A direct image-file result returns file information plus exact dimensions, exact reduced aspectRatio, nearestSupportedAspectRatio, and resolution tier; it does not decode binary bytes as text. Folder results list IMMEDIATE CHILDREN ONLY, with the same metadata on image entries; use `vault_list` with a recursive glob for all descendants.",
		category: "vault_read",
		mutates: false,
		schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Exact vault-relative FILE OR FOLDER path. Include the file extension for files, for example `Notes/idea.md`.",
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
			const item = app.vault.getAbstractFileByPath(p);
			if (item instanceof TFolder) {
				const entries: FolderEntry[] = item.children.map((child) =>
					child instanceof TFolder
						? { path: child.path, type: "folder", children: child.children.length }
						: { path: child.path, type: "file", size: child instanceof TFile ? child.stat?.size ?? 0 : 0 },
				);
				return ok({ path: p, type: "folder", entries });
			}
			if (!(item instanceof TFile)) return fail(`NotFound: ${p}`);

			const mime = oaImageMimeFromTarget(item.path);
			if (mime) return ok({ path: p, type: "file", mimeType: mime, size: item.stat?.size ?? 0 });

			const raw = await app.vault.cachedRead(item);
			const { frontmatter, body } = splitFrontmatter(raw);
			return ok({ path: p, type: "file", frontmatter, body });
		},
	});
}
