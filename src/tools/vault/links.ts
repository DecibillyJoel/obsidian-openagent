import { type App, TFile, TFolder } from "obsidian";
import { defineTool, fail, ok } from "../define";
import { PathError, safeVaultPath } from "./path-safe";

interface Args {
	path: string;
}

export function linksTool(app: App) {
	return defineTool<Args>({
		name: "vault_links",
		description:
			"For a note, list its inbound and outbound resolved links. For a folder, aggregate links across Markdown notes recursively contained in that folder. Folder `outbound` may include both internal and external-to-folder targets; folder `inbound` contains source notes that link to notes inside the folder.",
		category: "vault_read",
		mutates: false,
		schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Exact vault-relative NOTE OR FOLDER path. Include `.md` (or the actual extension) for a file.",
				},
			},
			required: ["path"],
		},
		run(args) {
			let p: string;
			try {
				p = safeVaultPath(args.path);
			} catch (e) {
				if (e instanceof PathError) return Promise.resolve(fail(`PathError: ${e.message}`));
				throw e;
			}
			const item = app.vault.getAbstractFileByPath(p);
			const resolved = app.metadataCache.resolvedLinks ?? {};

			if (item instanceof TFolder) {
				const prefix = `${p}/`;
				const notes = Object.keys(resolved).filter((key) => key.startsWith(prefix));
				const outbound = new Set<string>();
				for (const note of notes) {
					for (const target of Object.keys(resolved[note] ?? {})) outbound.add(target);
				}
				const inbound = new Set<string>();
				for (const [source, targets] of Object.entries(resolved)) {
					if (Object.keys(targets).some((target) => target.startsWith(prefix))) inbound.add(source);
				}
				return Promise.resolve(ok({
					path: p,
					type: "folder",
					notes: notes.length,
					inbound: [...inbound],
					outbound: [...outbound],
				}));
			}
			if (!(item instanceof TFile)) return Promise.resolve(fail(`NotFound: ${p}`));

			// Outbound: from resolvedLinks[source][target]
			const outbound = Object.keys(resolved[p] ?? {});

			// Inbound: scan resolvedLinks for any source linking to p.
			const inbound: string[] = [];
			for (const [source, targets] of Object.entries(resolved)) {
				if (p in targets) inbound.push(source);
			}

			return Promise.resolve(ok({ path: p, type: "file", inbound, outbound }));
		},
	});
}
