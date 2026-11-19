import { htmlToMarkdown, sanitizeHTMLToDom } from "obsidian";

export interface HtmlPage {
	title: string;
	text: string;
	links: Array<{ text: string; href: string }>;
	markdown: string;
}

/** A fragment parse drops the document head, so read the title from the raw string. */
const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;
const LINK_PATTERN = /\[([^\]]*)\]\(([^)]*)\)/g;
const LINE_PREFIX_PATTERN = /^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|>[ \t]?)/;
/** The characters a markdown backslash escape can protect. */
const ESCAPE_PATTERN = /\\([\\`*_{}[\]()#+\-.!|<>~])/g;
const FENCE_PATTERN = /^(?:`{3,}|~{3,})/;
const INDENTED_PATTERN = /^(?: {4}|\t)/;
const DELIMITER_ROW_PATTERN = /^[-:| ]+$/;

function collapseSpace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Resolve `href` against `baseUrl`. Return null for a link we must not keep. */
function resolveHref(href: string, baseUrl: string): string | null {
	const trimmed = href.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return null;
	try {
		const url = new URL(trimmed, baseUrl);
		return url.protocol === "javascript:" ? null : url.href;
	} catch {
		return null;
	}
}

/** Write each resolved href back, so the markdown carries absolute URLs. */
function collectLinks(fragment: DocumentFragment, baseUrl: string): Array<{ text: string; href: string }> {
	const links: Array<{ text: string; href: string }> = [];
	const seen = new Set<string>();
	for (const element of Array.from(fragment.querySelectorAll("a[href]"))) {
		const href = resolveHref(element.getAttribute("href") ?? "", baseUrl);
		if (href === null) continue;
		element.setAttribute("href", href);
		if (seen.has(href)) continue;
		seen.add(href);
		links.push({ text: collapseSpace(element.textContent ?? ""), href });
	}
	return links;
}

/** True for a rule or a GFM delimiter row, which must produce no text. */
function isDelimiterRow(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.includes("-") && DELIMITER_ROW_PATTERN.test(trimmed);
}

function stripMarkdownLine(line: string): string | null {
	const unwrapped = line.replace(LINK_PATTERN, "$1 ($2)").replace(ESCAPE_PATTERN, "$1");
	if (isDelimiterRow(unwrapped)) return null;
	return collapseSpace(unwrapped.replace(LINE_PREFIX_PATTERN, "").replace(/\|/g, " "));
}

/** Derive plain text from the native markdown, so block boundaries survive. */
function toText(markdown: string): string {
	const lines: string[] = [];
	let inFence = false;
	for (const line of markdown.split(/\r\n|\r|\n/)) {
		if (FENCE_PATTERN.test(line.trim())) {
			inFence = !inFence;
			continue;
		}
		if (inFence || INDENTED_PATTERN.test(line)) {
			lines.push(line);
			continue;
		}
		const stripped = stripMarkdownLine(line);
		if (stripped !== null) lines.push(stripped);
	}
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Decode the captured title with the native sanitiser, never by hand. */
function readTitle(html: string): string {
	const match = TITLE_PATTERN.exec(html);
	if (match === null) return "";
	return collapseSpace(sanitizeHTMLToDom(match[1]).textContent ?? "");
}

export function oaParseHtml(html: string, baseUrl: string): HtmlPage {
	const fragment = sanitizeHTMLToDom(html);
	const links = collectLinks(fragment, baseUrl);
	const markdown = htmlToMarkdown(fragment).trim();
	return { title: readTitle(html), text: toText(markdown), links, markdown };
}
