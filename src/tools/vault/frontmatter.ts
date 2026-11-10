import { parseYaml, stringifyYaml } from "obsidian";

const FRONTMATTER_PATTERN = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const TOP_LEVEL_KEY_PATTERN = /^([A-Za-z0-9_.\-$"']+)[ \t]*:(?:[ \t]|$)/;

export interface FrontmatterSplit {
	frontmatter: Record<string, unknown> | null;
	body: string;
}

export function splitFrontmatter(text: string): FrontmatterSplit {
	const info = getFrontmatterInfoCompat(text);
	if (!info.exists) return { frontmatter: null, body: text };
	return {
		frontmatter: parseFrontmatterObject(info.frontmatter),
		body: text.slice(info.contentStart),
	};
}

/** Return the raw text of the frontmatter block, without the `---` delimiters. */
export function extractFrontmatterBlock(text: string): string {
	const info = getFrontmatterInfoCompat(text);
	return info.exists ? info.frontmatter : "";
}

/** Patch the raw block text line by line and return the patched block text. */
export function mergeFrontmatter(existing: string, incoming: Record<string, unknown> | undefined): string;
/** Merge two parsed frontmatter objects. */
export function mergeFrontmatter(
	existing: Record<string, unknown> | null | undefined,
	incoming: Record<string, unknown> | undefined,
): Record<string, unknown>;
export function mergeFrontmatter(
	existing: string | Record<string, unknown> | null | undefined,
	incoming: Record<string, unknown> | undefined,
): string | Record<string, unknown> {
	if (typeof existing !== "string") {
		return { ...(existing ?? {}), ...(incoming ?? {}) };
	}
	return mergeFrontmatterText(existing, incoming ?? {});
}

/** Build the file text from the raw block text and the body text. */
export function stitchFrontmatter(frontmatterBlock: string, body: string): string;
/** Build the file text from a parsed frontmatter object and the body text. */
export function stitchFrontmatter(
	frontmatter: Record<string, unknown> | null | undefined,
	body: string,
): string;
export function stitchFrontmatter(
	frontmatter: string | Record<string, unknown> | null | undefined,
	body: string,
): string {
	if (typeof frontmatter !== "string") {
		if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
		const yaml = stringifyYaml(frontmatter).trim();
		return `---\n${yaml}\n---${cleanBody(body)}`;
	}
	const block = frontmatter.trim();
	if (block === "") return body;
	const bodyClean = cleanBody(body);
	if (FRONTMATTER_PATTERN.test(block)) return `${block}${bodyClean}`;
	const newline = block.includes("\r\n") ? "\r\n" : "\n";
	return `---${newline}${block}${newline}---${bodyClean}`;
}

function mergeFrontmatterText(existing: string, incoming: Record<string, unknown>): string {
	const keys = Object.keys(incoming);
	if (keys.length === 0) return existing;
	const inner = stripDelimiters(existing);
	const newline = inner.includes("\r\n") ? "\r\n" : "\n";
	const lines = inner === "" ? [] : inner.split(newline);
	return patchLines(lines, incoming).join(newline);
}

function patchLines(lines: string[], incoming: Record<string, unknown>): string[] {
	if (!parseFrontmatterObject(lines.join("\n"))) {
		const appended = [...lines];
		for (const key of Object.keys(incoming)) {
			appended.push(...serializeKey(key, incoming[key]));
		}
		return appended;
	}
	const entries = findTopLevelEntries(lines);
	const patched: string[] = [];
	let cursor = 0;
	const handled = new Set<string>();
	for (const entry of entries) {
		patched.push(...lines.slice(cursor, entry.start));
		if (Object.prototype.hasOwnProperty.call(incoming, entry.key)) {
			patched.push(...serializeKey(entry.key, incoming[entry.key]));
			handled.add(entry.key);
		} else {
			patched.push(...lines.slice(entry.start, entry.end));
		}
		cursor = entry.end;
	}
	patched.push(...lines.slice(cursor));
	for (const key of Object.keys(incoming)) {
		if (handled.has(key)) continue;
		patched.push(...serializeKey(key, incoming[key]));
	}
	return patched;
}

interface TopLevelEntry {
	key: string;
	start: number;
	end: number;
}

function findTopLevelEntries(lines: string[]): TopLevelEntry[] {
	const entries: TopLevelEntry[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const match = TOP_LEVEL_KEY_PATTERN.exec(line);
		if (!match) continue;
		let end = index + 1;
		while (end < lines.length && isIndented(lines[end] ?? "")) end++;
		entries.push({ key: match[1] ?? "", start: index, end });
		index = end - 1;
	}
	return entries;
}

function isIndented(line: string): boolean {
	return /^[ \t]/.test(line);
}

function serializeKey(key: string, value: unknown): string[] {
	const yaml = stringifyYaml({ [key]: value }).trim();
	if (yaml === "") return [];
	return yaml.split("\n");
}

function stripDelimiters(block: string): string {
	const match = FRONTMATTER_PATTERN.exec(block);
	if (!match) return block;
	return match[1] ?? "";
}

function cleanBody(body: string): string {
	return body.startsWith("\n") ? body : "\n" + body;
}

function parseFrontmatterObject(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = parseYaml(text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function getFrontmatterInfoCompat(text: string): { exists: boolean; frontmatter: string; contentStart: number } {
	const match = text.match(FRONTMATTER_PATTERN);
	if (!match) {
		return {
			exists: false,
			frontmatter: "",
			contentStart: 0,
		};
	}
	return {
		exists: true,
		frontmatter: match[1] ?? "",
		contentStart: match[0].length,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
