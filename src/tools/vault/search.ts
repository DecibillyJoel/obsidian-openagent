import { type App, TFile, TFolder } from "obsidian";
import { defineTool, fail, ok } from "../define";
import { PathError, safeVaultPath } from "./path-safe";

interface Args {
	query: string;
	scope?: { folder?: string; tag?: string; limit?: number };
}

interface Match {
	path: string;
	line: number;
	excerpt: string;
}

const BYTE_BUDGET = 5 * 1024 * 1024;

export function searchTool(app: App) {
	return defineTool<Args>({
		name: "vault_search",
		description:
			"Search MARKDOWN NOTES (`.md`) by full text. A `[[wikilink]]` query may resolve directly, including to an image; exact image matches include exact dimensions, exact reduced aspectRatio, nearestSupportedAspectRatio, and resolution tier. Otherwise the tool scans Markdown note contents. With no folder scope, the scan includes Markdown notes in the VAULT ROOT and all nested folders. An optional folder scope intentionally limits the scan to that folder and its descendants and therefore excludes root-level notes outside it. This tool does not search folder names or non-Markdown file contents.",
		category: "vault_read",
		mutates: false,
		schema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Text to find in Markdown note contents, or a `[[wikilink]]` to resolve. For an exact filename query, include its extension when applicable.",
				},
				scope: {
					type: "object",
					description: "Optional scoping. Omit `folder` when a broad search must include top-level vault notes.",
					properties: {
						folder: {
							type: "string",
							description:
								"Exact vault-relative FOLDER path. Searches Markdown notes in this folder and all descendants. Do not include a trailing filename.",
						},
						tag: {
							type: "string",
							description: "Restrict results to Markdown notes with this tag, with or without the leading `#`.",
						},
						limit: {
							type: "integer",
							description: "Maximum matches to return (1-100). Default: 20.",
							minimum: 1,
							maximum: 100,
						},
					},
				},
			},
			required: ["query"],
		},
		async run(args) {
			const limit = args.scope?.limit ?? 20;
			const matches: Match[] = [];

			let folderScope: string | undefined;
			if (args.scope?.folder) {
				try {
					folderScope = safeVaultPath(args.scope.folder);
				} catch (e) {
					if (e instanceof PathError) return fail(`PathError: ${e.message}`);
					throw e;
				}
				const scopeItem = app.vault.getAbstractFileByPath(folderScope);
				if (!scopeItem) return fail(`NotFound: ${folderScope}`);
				if (!(scopeItem instanceof TFolder)) return fail(`NotAFolder: ${folderScope}`);
			}

			// 1. Linkpath / exact-name resolution — only for explicit [[wikilink]] syntax.
			const wikilinkMatch = /^\[\[([^\]]+)\]\]$/.exec(args.query.trim());
			if (wikilinkMatch) {
				const resolved = app.metadataCache.getFirstLinkpathDest(wikilinkMatch[1], "");
				if (resolved instanceof TFile && inFolder(resolved, folderScope)) {
					return ok({
						matches: [{ path: resolved.path, line: 0, excerpt: "(exact match)" }],
						strategy: "linkpath",
						truncated: false,
					});
				}
			}

			// 2. Tag-scoped iteration
			if (args.scope?.tag) {
				const tag = args.scope.tag.startsWith("#") ? args.scope.tag : `#${args.scope.tag}`;
				const candidates = app.vault
					.getMarkdownFiles()
					.filter((f) => fileHasTag(app, f, tag))
					.filter((f) => inFolder(f, folderScope));
				await scanFiles(app, candidates, args.query, matches, limit, BYTE_BUDGET);
				return ok({ matches, strategy: "tag", truncated: matches.length >= limit });
			}

			// 3. Bounded full-text — byte budget is the only cap.
			const all = app.vault.getMarkdownFiles().filter((f) => inFolder(f, folderScope));
			const scanned = await scanFiles(app, all, args.query, matches, limit, BYTE_BUDGET);
			return ok({
				matches,
				strategy: "fulltext",
				truncated: scanned.bytesHit || matches.length >= limit,
				bytesScanned: scanned.bytesScanned,
			});
		},
	});
}

function inFolder(f: TFile, folder?: string): boolean {
	if (!folder) return true;
	const norm = folder.endsWith("/") ? folder : folder + "/";
	return f.path.startsWith(norm) || f.path === folder;
}

function fileHasTag(app: App, f: TFile, tag: string): boolean {
	const cache = app.metadataCache.getFileCache(f);
	if (!cache) return false;
	const tags = cache.tags?.map((t) => t.tag) ?? [];
	const fmTags = (cache.frontmatter?.tags as unknown) ?? [];
	const fmList = Array.isArray(fmTags) ? fmTags.map(String) : typeof fmTags === "string" ? [fmTags] : [];
	const fmNormalized = fmList.map((t) => (t.startsWith("#") ? t : `#${t}`));
	return tags.includes(tag) || fmNormalized.includes(tag);
}

async function scanFiles(
	app: App,
	files: TFile[],
	query: string,
	out: Match[],
	limit: number,
	byteBudget: number,
): Promise<{ bytesScanned: number; bytesHit: boolean }> {
	let bytesScanned = 0;
	const needle = query.toLowerCase();
	for (const f of files) {
		if (out.length >= limit) break;
		if (bytesScanned >= byteBudget) return { bytesScanned, bytesHit: true };
		const text = await app.vault.cachedRead(f);
		bytesScanned += text.length;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].toLowerCase().includes(needle)) {
				out.push({ path: f.path, line: i + 1, excerpt: lines[i].slice(0, 200) });
				if (out.length >= limit) break;
			}
		}
	}
	return { bytesScanned, bytesHit: false };
}
