import { type App, getAllTags, TFile, TFolder } from "obsidian";
import { defineTool, fail, ok } from "../define";
import { EMPTY_FALLBACK_METADATA, oaParseMetadataFallback } from "./metadata-fallback";
import { oaImageMimeFromTarget } from "../../images/attachments";
import { PathError, safeVaultPath } from "./path-safe";

interface Args {
	path: string;
}

export function metadataTool(app: App) {
	return defineTool<Args>({
		name: "vault_metadata",
		description:
			"Get metadata for one file, or structural statistics for a folder. Image-file results include exact dimensions, exact reduced aspectRatio, nearestSupportedAspectRatio, and resolution tier. Text-file metadata falls back to parsing the current note when Obsidian's metadata cache is empty or incomplete. Folder results include immediate children plus recursive descendant file/folder counts and total bytes; image children include the same image metadata. Folder results do not return note frontmatter.",
		category: "vault_read",
		mutates: false,
		schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Exact vault-relative FILE OR FOLDER path. Include the file extension for files, for example Notes/idea.md.",
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
				let descendantFiles = 0;
				let descendantFolders = 0;
				let bytes = 0;
				const walk = (folder: TFolder) => {
					for (const child of folder.children) {
						if (child instanceof TFolder) {
							descendantFolders++;
							walk(child);
						} else if (child instanceof TFile) {
							descendantFiles++;
							bytes += child.stat?.size ?? 0;
						}
					}
				};
				walk(item);
				const children: Array<{ path: string; type: "file" | "folder" }> = item.children.map((child) => ({
					path: child.path,
					type: child instanceof TFolder ? "folder" : "file",
				}));
				return ok({
					path: p,
					type: "folder",
					children,
					descendantFiles,
					descendantFolders,
					bytes,
				});
			}
			if (!(item instanceof TFile)) return fail(`NotFound: ${p}`);

			const mime = oaImageMimeFromTarget(item.path);
			if (mime) return ok({ path: p, type: "file", mimeType: mime, size: item.stat?.size ?? 0 });

			const cache = app.metadataCache.getFileCache(item);
			let fallback = EMPTY_FALLBACK_METADATA;
			try {
				fallback = oaParseMetadataFallback(await app.vault.cachedRead(item));
			} catch {
				fallback = EMPTY_FALLBACK_METADATA;
			}

			const cacheTags =
				typeof getAllTags === "function" && cache ? getAllTags(cache) ?? [] : cache?.tags?.map((t) => t.tag) ?? [];
			const cacheHeadings = cache?.headings?.map((h) => ({ level: h.level, text: h.heading, line: h.position.start.line })) ?? [];
			const cacheLinks = cache?.links?.map((l) => l.link) ?? [];
			const cacheEmbeds = cache?.embeds?.map((e) => e.link) ?? [];
			return ok({
				path: p,
				type: "file",
				frontmatter: cache?.frontmatter ?? fallback.frontmatter,
				tags: cacheTags.length > 0 ? cacheTags : fallback.tags,
				headings: cacheHeadings.length > 0 ? cacheHeadings : fallback.headings,
				outboundLinks: cacheLinks.length > 0 ? cacheLinks : fallback.outboundLinks,
				embeds: cacheEmbeds.length > 0 ? cacheEmbeds : fallback.embeds,
			});
		},
	});
}
