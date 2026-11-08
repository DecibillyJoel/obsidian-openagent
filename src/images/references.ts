import { oaImageMimeFromTarget } from "./attachments";

const OA_WIKILINK_EMBED_PATTERN = /!\[\[([^\]]+)\]\]/g;
const OA_MARKDOWN_EMBED_PATTERN = /!\[[^\]]*\]\(([^)]+)\)/g;

// Collect the image embeds that are actually rendered in assistant text. This is strict:
// unlike oaExtractImageTargets it has no bare-text mode and no remote-URL pattern. Only a
// real wikilink or markdown embed whose extension resolves to an image mime is kept.
export function oaExtractDisplayedImageEmbeds(text: string): string[] {
	if (typeof text !== "string" || text.length === 0) return [];
	const found = new Set<string>();
	let match: RegExpExecArray | null;

	OA_WIKILINK_EMBED_PATTERN.lastIndex = 0;
	while ((match = OA_WIKILINK_EMBED_PATTERN.exec(text)) !== null) {
		const target = match[1].split("|")[0].split("#")[0].trim();
		if (target.length > 0 && oaImageMimeFromTarget(target)) found.add(target);
	}

	OA_MARKDOWN_EMBED_PATTERN.lastIndex = 0;
	while ((match = OA_MARKDOWN_EMBED_PATTERN.exec(text)) !== null) {
		let target = match[1].trim();
		const angled = /^<(.*)>$/.exec(target);
		if (angled) target = angled[1];
		target = target.replace(/\s+["'][^"']*["']\s*$/, "").trim();
		try {
			target = decodeURIComponent(target);
		} catch {
			// Keep the raw target when it is not valid percent-encoding.
		}
		target = target.trim();
		if (target.length > 0 && oaImageMimeFromTarget(target)) found.add(target);
	}

	return [...found];
}
