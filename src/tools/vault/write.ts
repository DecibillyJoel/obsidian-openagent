import { type App, TFile, TFolder } from "obsidian";
import { type UndoBuffer } from "../../consent/undo";
import { defineTool, fail, ok } from "../define";
import { PathError, safeVaultPath } from "./path-safe";
import { extractFrontmatterBlock, mergeFrontmatter, stitchFrontmatter } from "./frontmatter";
import { NotAFolderError, ensureParentFolder, openAgentEnsureFolderPath } from "./ensure-folder";

interface Args {
	path: string;
	type?: string;
	body?: string;
	frontmatter?: Record<string, unknown>;
}

export function writeTool(app: App, undo: UndoBuffer) {
	return defineTool<Args>({
		name: "vault_write",
		description:
			"Create or overwrite a TEXT FILE, or create an EMPTY FOLDER with `type: folder`. For files, `path` is literal and MUST INCLUDE the desired extension such as `.md`; the tool does NOT add an omitted extension. Existing files are overwritten, but an existing folder at the path is rejected. Missing parent folders are created. `type` defaults to `file`.",
		category: "vault_write",
		mutates: true,
		schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Complete vault-relative destination path. For `type: file`, INCLUDE the filename extension (for example `Notes/idea.md`). For `type: folder`, provide the folder path (for example `Notes/Ideas`).",
				},
				type: {
					type: "string",
					enum: ["file", "folder"],
					description:
						"Use `file` (default) to write text, or `folder` to create an empty folder. Folder creation rejects `body` and `frontmatter`.",
				},
				body: {
					type: "string",
					description:
						"Complete text body, excluding YAML frontmatter. Required for `type: file`; forbidden for `type: folder`.",
				},
				frontmatter: {
					type: "object",
					description:
						"Optional YAML frontmatter object. Existing keys are preserved unless overridden. Valid only for `type: file`.",
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

			const type = args.type ?? "file";

			if (type === "folder") {
				if (args.body !== undefined || args.frontmatter !== undefined) {
					return fail("InvalidArguments: folder creation does not accept body or frontmatter");
				}
				if (app.vault.getAbstractFileByPath(p)) return fail(`AlreadyExists: ${p}`);
				let createdPaths: string[];
				try {
					createdPaths = await openAgentEnsureFolderPath(app, p);
				} catch (e) {
					if (e instanceof NotAFolderError) return fail(e.message);
					throw e;
				}
				undo.record({ kind: "create-folder", path: p, createdPaths });
				return ok({ path: p, type: "folder", created: true, createdPaths });
			}

			if (type !== "file") return fail(`InvalidType: ${type}`);

			const body = args.body;
			if (body === undefined) return fail("InvalidArguments: body must be supplied when type is file");

			const existing = app.vault.getAbstractFileByPath(p);
			if (existing instanceof TFolder) return fail(`IsFolder: ${p}`);

			let before: string | null = null;
			let existingBlock = "";

			if (existing instanceof TFile) {
				before = await app.vault.read(existing);
				existingBlock = extractFrontmatterBlock(before);
			}

			const mergedBlock = mergeFrontmatter(existingBlock, args.frontmatter ?? {});
			const after = stitchFrontmatter(mergedBlock, body);

			if (existing instanceof TFile) {
				await app.vault.modify(existing, after);
			} else {
				try {
					await ensureParentFolder(app, p);
				} catch (e) {
					if (e instanceof NotAFolderError) return fail(e.message);
					throw e;
				}
				await app.vault.create(p, after);
			}

			undo.record({ path: p, before, after });

			return ok({
				path: p,
				type: "file",
				created: before === null,
				bytesBefore: before?.length ?? 0,
				bytesAfter: after.length,
			});
		},
	});
}
