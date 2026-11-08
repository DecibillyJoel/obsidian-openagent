import { splitFrontmatter } from "./frontmatter";

export interface OaFallbackHeading {
	level: number;
	text: string;
	line: number;
}

export interface OaFallbackMetadata {
	frontmatter: Record<string, unknown> | null;
	tags: string[];
	headings: OaFallbackHeading[];
	outboundLinks: string[];
	embeds: string[];
}

const FENCED_CODE = /^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;
const WIKI_EMBED = /!\[\[([^\]]+)\]\]/g;
const MARKDOWN_EMBED = /!\[[^\]]*\]\(([^)]+)\)/g;
const WIKI_LINK = /(^|[^!])\[\[([^\]]+)\]\]/gm;
const MARKDOWN_LINK = /(^|[^!])\[[^\]]*\]\(([^)]+)\)/gm;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const INLINE_TAG = /(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gmu;

export const EMPTY_FALLBACK_METADATA: OaFallbackMetadata = {
	frontmatter: null,
	tags: [],
	headings: [],
	outboundLinks: [],
	embeds: [],
};

function scan(re: RegExp, text: string, group: number): string[] {
	const out: string[] = [];
	re.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const value = match[group];
		if (value !== undefined) out.push(value);
		if (match.index === re.lastIndex) re.lastIndex++;
	}
	return out;
}

export function oaUnique(values: string[]): string[] {
	return [...new Set(values.filter((value) => Boolean(value)))];
}

export function oaWikiTarget(raw: string): string {
	return (raw.split("|", 1)[0] ?? "").trim();
}

export function oaMarkdownTarget(raw: string): string {
	const target = raw.trim();
	if (target.startsWith("<")) {
		const end = target.indexOf(">");
		return (end === -1 ? target.slice(1) : target.slice(1, end)).trim();
	}
	return target.match(/^\S+/)?.[0] ?? "";
}

export function oaFrontmatterTags(frontmatter: Record<string, unknown> | null | undefined): string[] {
	const raw = frontmatter?.tags ?? frontmatter?.tag;
	const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[ ,]+/) : [];
	return values
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.map((value) => (value.startsWith("#") ? value : `#${value}`));
}

export function oaParseMetadataFallback(text: string): OaFallbackMetadata {
	const { frontmatter, body } = splitFrontmatter(text);
	const masked = body
		.replace(FENCED_CODE, (match) => match.replace(/[^\n]/g, " "))
		.replace(INLINE_CODE, (match) => " ".repeat(match.length));

	const headings: OaFallbackHeading[] = [];
	HEADING.lastIndex = 0;
	let heading: RegExpExecArray | null;
	while ((heading = HEADING.exec(masked)) !== null) {
		headings.push({
			level: heading[1].length,
			text: heading[2],
			line: body.slice(0, heading.index).split("\n").length - 1,
		});
		if (heading.index === HEADING.lastIndex) HEADING.lastIndex++;
	}

	const inlineTags = scan(INLINE_TAG, masked, 2).map((tag) => `#${tag}`);
	const wikiLinks = scan(WIKI_LINK, masked, 2).map(oaWikiTarget);
	const markdownLinks = scan(MARKDOWN_LINK, masked, 2).map(oaMarkdownTarget);
	const wikiEmbeds = scan(WIKI_EMBED, masked, 1).map(oaWikiTarget);
	const markdownEmbeds = scan(MARKDOWN_EMBED, masked, 1).map(oaMarkdownTarget);

	return {
		frontmatter,
		tags: oaUnique([...oaFrontmatterTags(frontmatter), ...inlineTags]),
		headings,
		outboundLinks: oaUnique([...wikiLinks, ...markdownLinks]),
		embeds: oaUnique([...wikiEmbeds, ...markdownEmbeds]),
	};
}
