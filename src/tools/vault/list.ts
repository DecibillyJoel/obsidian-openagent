import { type App, TFile, TFolder } from "obsidian";
import { defineTool, fail, ok } from "../define";

interface Args {
	glob: string;
	type?: string;
	limit?: number;
}

interface Entry {
	path: string;
	type: "file" | "folder";
	size?: number;
	children?: number;
}

export function listTool(app: App) {
	return defineTool<Args>({
		name: "vault_list",
		description:
			"List FILES AND FOLDERS whose complete vault-relative paths match a glob. `*` matches within one path segment; `**` matches recursively across folders. A leading `**/` matches zero or more folders, so `**/*` and `**/*.md` include files in the vault root as well as nested folders. When completeness matters, explicitly verify that the chosen glob covers root-level files. Use `type` to return all entries, files only, or folders only. Every returned image-file entry includes exact dimensions, exact reduced aspectRatio, nearestSupportedAspectRatio, and resolution tier.",
		category: "vault_read",
		mutates: false,
		schema: {
			type: "object",
			properties: {
				glob: {
					type: "string",
					description:
						"Glob matched against complete vault-relative paths. Examples: `*` for root-level entries, `*.md` for root-level Markdown files, `Daily/*` for immediate children, `Daily/**` for all descendants, and `**/*.md` for Markdown files at every depth INCLUDING THE VAULT ROOT. Do not use a folder-only pattern when the search must include top-level files. Include file extensions when filtering files.",
				},
				type: {
					type: "string",
					enum: ["all", "file", "folder"],
					description: "Return `all`, `file`, or `folder` entries. Default: `all`.",
				},
				limit: {
					type: "integer",
					description: "Maximum returned entries. Default: 200; maximum: 2000.",
					minimum: 1,
					maximum: 2000,
				},
			},
			required: ["glob"],
		},
		run(args) {
			const limit = args.limit ?? 200;
			const type = args.type ?? "all";
			if (type !== "all" && type !== "file" && type !== "folder") {
				return Promise.resolve(fail(`InvalidType: ${type}`));
			}
			const re = globToRegex(args.glob);
			const entries: Entry[] = [];
			for (const item of app.vault.getAllLoadedFiles()) {
				if (!re.test(item.path)) continue;
				if (item instanceof TFolder) {
					if (type === "file") continue;
					entries.push({ path: item.path, type: "folder", children: item.children.length });
				} else if (item instanceof TFile) {
					if (type === "folder") continue;
					entries.push({ path: item.path, type: "file", size: item.stat?.size ?? 0 });
				} else {
					continue;
				}
				if (entries.length >= limit) break;
			}
			return Promise.resolve(ok({ entries, count: entries.length, truncated: entries.length >= limit }));
		},
	});
}

function globToRegex(glob: string): RegExp {
	let re = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		const next = glob[i + 1];
		if (c === "*" && next === "*" && glob[i + 2] === "/") {
			re += "(?:.*/)?";
			i += 2;
		} else if (c === "*" && next === "*") {
			re += ".*";
			i++;
		} else if (c === "*") {
			re += "[^/]*";
		} else if (c === "?") {
			re += "[^/]";
		} else if (".+()|^$\\".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	re += "$";
	return new RegExp(re);
}

export { globToRegex };
