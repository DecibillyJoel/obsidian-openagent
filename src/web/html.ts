import { htmlToMarkdown, sanitizeHTMLToDom } from "obsidian";

export interface HtmlPage {
	title: string;
	text: string;
	links: Array<{ text: string; href: string }>;
	markdown: string;
}

/** Schemes a link must never carry, whatever the markup says. */
const BLOCKED_SCHEMES = new Set(["data:", "javascript:", "vbscript:"]);
const LINE_PREFIX_PATTERN = /^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|>[ \t]?)/;
/** The characters a markdown backslash escape can protect. */
const ESCAPE_PATTERN = /\\([\\`*_{}[\]()#+\-.!|<>~])/g;
const FENCE_PATTERN = /^(?:`{3,}|~{3,})/;
const INDENTED_PATTERN = /^(?: {4}|\t)/;
const DELIMITER_ROW_PATTERN = /^[-:|*_ ]+$/;
/** A rule or a delimiter row holds one of these and no other content. */
const RULE_CHAR_PATTERN = /[-*_]/;

function collapseSpace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Resolve `href` against `baseUrl`. Return null for a link we must not keep. */
function resolveHref(href: string, baseUrl: string): string | null {
	const trimmed = href.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return null;
	try {
		const url = new URL(trimmed, baseUrl);
		return BLOCKED_SCHEMES.has(url.protocol) ? null : url.href;
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
		if (href === null) {
			// Without the attribute the markdown keeps the label and drops the link.
			element.removeAttribute("href");
			continue;
		}
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
	return RULE_CHAR_PATTERN.test(trimmed) && DELIMITER_ROW_PATTERN.test(trimmed);
}

/** Read the `(target)` of a markdown link at `start`. Return null when it is no target. */
function readLinkTarget(line: string, start: number): { value: string; next: number } | null {
	if (line[start] !== "(") return null;
	let index = start + 1;
	while (index < line.length) {
		const char = line[index];
		if (char === ")") return { value: line.slice(start + 1, index), next: index + 1 };
		if (char === "(" || char === "[") return null;
		index += 1;
	}
	return null;
}

/**
 * Rewrite `[label](href)` as `label (href)` and drop `![alt](src)`, in one
 * left-to-right pass. Every index only moves forward, so the cost grows with
 * the line length and never with its square.
 */
function unwrapMarkdownLinks(line: string): string {
	const root: string[] = [];
	const opened: string[][] = [root];
	const images: boolean[] = [];
	let index = 0;
	while (index < line.length) {
		const char = line[index];
		if (char === "[" || (char === "!" && line[index + 1] === "[")) {
			const image = char === "!";
			opened.push([]);
			images.push(image);
			index += image ? 2 : 1;
			continue;
		}
		if (char === "]" && opened.length > 1) {
			const label = opened.pop()?.join("") ?? "";
			const image = images.pop() === true;
			const target = readLinkTarget(line, index + 1);
			if (target === null) {
				opened[opened.length - 1].push((image ? "![" : "[") + label + "]");
				index += 1;
				continue;
			}
			// An image holds no text for the reader, so the whole element goes.
			if (!image) opened[opened.length - 1].push(`${label} (${target.value})`);
			index = target.next;
			continue;
		}
		opened[opened.length - 1].push(char);
		index += 1;
	}
	const parts: string[] = [];
	for (let depth = 0; depth < opened.length; depth += 1) {
		if (depth > 0) parts.push(images[depth - 1] ? "![" : "[");
		parts.push(opened[depth].join(""));
	}
	return parts.join("");
}

function stripMarkdownLine(line: string): string | null {
	const unwrapped = unwrapMarkdownLinks(line).replace(ESCAPE_PATTERN, "$1");
	// Strip the block prefix first, so a quoted or listed delimiter row still goes.
	const content = unwrapped.replace(LINE_PREFIX_PATTERN, "");
	if (isDelimiterRow(content)) return null;
	return collapseSpace(content.replace(/\|/g, " "));
}

/** Drop blank edge lines only, so an opening indented block keeps its indent. */
function stripBlankEdges(text: string): string {
	return text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

/** Derive plain text from the native markdown, so block boundaries survive. */
function toText(markdown: string): string {
	const lines: string[] = [];
	let inFence = false;
	let blankPlain = false;
	for (const line of markdown.split(/\r\n|\r|\n/)) {
		if (FENCE_PATTERN.test(line.trim())) {
			inFence = !inFence;
			blankPlain = false;
			continue;
		}
		// A fenced block and an indented code block keep every character, but a
		// nested table is a table, so its rows go through the table strip.
		if (inFence || (INDENTED_PATTERN.test(line) && !line.trimStart().startsWith("|"))) {
			lines.push(line);
			blankPlain = false;
			continue;
		}
		const stripped = stripMarkdownLine(line);
		if (stripped === null) continue;
		// A run of blank lines collapses to one, but a fenced block keeps its own.
		if (stripped === "" && blankPlain) continue;
		lines.push(stripped);
		blankPlain = stripped === "";
	}
	return stripBlankEdges(lines.join("\n"));
}

/** Read the title from the parsed document, never from the raw string. */
function readTitle(doc: Document): string {
	const title = doc.head?.querySelector("title") ?? null;
	return title === null ? "" : collapseSpace(title.textContent ?? "");
}

/** Resolve the document `<base href>` against the caller's base, else keep it. */
function resolveBase(doc: Document, baseUrl: string): string {
	const href = (doc.querySelector("base[href]")?.getAttribute("href") ?? "").trim();
	if (href === "") return baseUrl;
	try {
		return new URL(href, baseUrl).href;
	} catch {
		return baseUrl;
	}
}

export function oaParseHtml(html: string, baseUrl: string): HtmlPage {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const fragment = sanitizeHTMLToDom(html);
	const links = collectLinks(fragment, resolveBase(doc, baseUrl));
	// The text keeps the untrimmed conversion, so an opening indented block stays indented.
	const converted = htmlToMarkdown(fragment);
	return { title: readTitle(doc), text: toText(converted), links, markdown: converted.trim() };
}
