import { type App, TFile } from "obsidian";
import { defineTool, fail, ok } from "../define";
import { OA_MAX_IMAGE_BYTES, oaDetectImageMime, oaImageMimeFromTarget } from "../../images/attachments";

interface Args {
	path: string;
}

function normalizeImagePath(raw: string): string {
	return raw.trim().replace(/^!??\[\[|\]\]$/g, "").split("|")[0].trim();
}

export function openAgentVaultImageTool(app: App) {
	return defineTool<Args>({
		name: "vault_image",
		description:
			"Read and display an existing vault image as visual context. The result reports exact dimensions, exact reduced aspectRatio, nearestSupportedAspectRatio, and resolution tier. Inspect source images before editing them. Images in any supported source format are internally converted to PNG before being sent to a model. When later writing an image_generate prompt, refer to displayed sources only by order (`the first image`, `the second image`), never by filename or title.",
		category: "vault_read",
		mutates: false,
		schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Exact vault-relative image path or link target, for example `Nora Portrait.png` or `Assets/portrait.webp`.",
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
		async run(args) {
			const path = normalizeImagePath(args.path ?? "");
			const direct = app.vault.getAbstractFileByPath(path);
			const file = direct instanceof TFile ? direct : app.metadataCache.getFirstLinkpathDest(path, "");
			if (!(file instanceof TFile)) return fail(`ImageNotFound: ${path}`);
			const expected = oaImageMimeFromTarget(file.path);
			if (!expected) return fail(`UnsupportedImage: ${file.path}. Use PNG, JPEG, WebP, or GIF.`);
			const size = file.stat?.size ?? 0;
			if (size <= 0 || size > OA_MAX_IMAGE_BYTES) {
				return fail(`ImageTooLarge: ${file.path} exceeds the 10 MB display limit.`);
			}
			const bytes = new Uint8Array(await app.vault.readBinary(file));
			const detected = oaDetectImageMime(bytes);
			if (!detected || detected !== expected) return fail(`InvalidImage: ${file.path}`);
			return ok({
				path: file.path,
				displayInChat: true,
				markdownEmbed: `![[${file.path}]]`,
				mimeType: detected,
				size,
			});
		},
	});
}
