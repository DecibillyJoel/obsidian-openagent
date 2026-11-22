import { requestUrl } from "obsidian";
import type { JsonSchema, ToolDef } from "../../types";
import { oaParseHtml, type HtmlPage } from "../../web/html";
import { defineTool, fail, ok } from "../define";

/** Above this many bytes the tool fails before any parse. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** The cap on the `text` field of `web_fetch`. */
const MAX_TEXT_CHARS = 40_000;

/** The cap on the `links` field of `web_fetch`. */
const MAX_LINKS = 200;

/** The marker appended to a capped value. */
const TRUNCATED_MARKER = "\n\n[truncated]";

/** The content types that the HTML parser reads. */
const PARSED_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/** The one error for a URL that the tools cannot fetch. */
const URL_REJECTED = "WebUrlRejected: only absolute http and https URLs are supported";

/** The one error for a URL that points into a private network. */
const PRIVATE_HOST_REJECTED = "WebUrlRejected: only public http and https hosts are supported";

/**
 * True for a loopback, private, link-local or unspecified hostname. The check
 * reads the hostname only, so a public name that resolves to a private address
 * still passes: `requestUrl` does not expose the resolved address.
 */
function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
	if (host === "" || host === "localhost" || host.endsWith(".local")) return true;
	if (host === "0.0.0.0" || host === "::1" || host.endsWith("::1")) return true;
	if (host.startsWith("127.") || host.startsWith("10.")) return true;
	if (host.startsWith("192.168.") || host.startsWith("169.254.")) return true;
	if (host.startsWith("172.")) {
		const second = Number.parseInt(host.split(".")[1] ?? "", 10);
		return second >= 16 && second <= 31;
	}
	return false;
}

export interface WebToolArgs {
	url: string;
}

/** One fetched page, either parsed HTML or the raw body. */
type FetchedPage =
	| { kind: "html"; url: string; status: number; page: HtmlPage }
	| { kind: "raw"; url: string; status: number; text: string };

/** The shared outcome of one fetch. The tools turn a failure into `fail`. */
type FetchOutcome = { ok: true; page: FetchedPage } | { ok: false; error: string };

export function oaTruncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}${TRUNCATED_MARKER}` : value;
}

/** The media type of a response, without parameters and in lower case. */
function mediaTypeOf(headers: Record<string, string> | undefined): string {
	if (!headers) return "";
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "content-type") {
			return String(value).split(";")[0].trim().toLowerCase();
		}
	}
	return "";
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

/**
 * Fetch one URL and apply the gates that both web tools share. The caller
 * reports the failure unchanged.
 */
export async function oaFetchPage(url: string): Promise<FetchOutcome> {
	const target = String(url ?? "").trim();
	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return { ok: false, error: URL_REJECTED };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, error: URL_REJECTED };
	}
	if (isPrivateHost(parsed.hostname)) {
		return { ok: false, error: PRIVATE_HOST_REJECTED };
	}

	let response: Awaited<ReturnType<typeof requestUrl>>;
	try {
		response = await requestUrl({ url: target, method: "GET", throw: false });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `WebNetworkError: ${message}` };
	}
	if (response.status >= 400) {
		return { ok: false, error: `WebHttpError: HTTP ${response.status}` };
	}

	const body = response.text ?? "";
	const size = byteLength(body);
	if (size > MAX_BODY_BYTES) {
		return { ok: false, error: `WebBodyTooLarge: response body is ${size} bytes, limit ${MAX_BODY_BYTES}` };
	}

	const mediaType = mediaTypeOf(response.headers);
	if (!PARSED_CONTENT_TYPES.has(mediaType)) {
		return { ok: true, page: { kind: "raw", url: target, status: response.status, text: body } };
	}
	return { ok: true, page: { kind: "html", url: target, status: response.status, page: oaParseHtml(body, target) } };
}

/** The url schema that `web_fetch` and `web_read` share. */
export const WEB_URL_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		url: { type: "string", description: "Absolute http or https URL to fetch or read." },
	},
	required: ["url"],
};

/** The tool fields that `web_fetch` and `web_read` share. */
export const WEB_TOOL_DEFAULTS = {
	category: "web",
	mutates: false,
	timeoutMs: 20_000,
} as const;

export function webFetchTool(): ToolDef<WebToolArgs> {
	return defineTool<WebToolArgs>({
		name: "web_fetch",
		description:
			"Fetch one http or https page and return its title, readable text and links. `requestUrl` does not report the final URL after a redirect, so `url` in the result is the URL that was requested while the content may be the page it redirected to.",
		...WEB_TOOL_DEFAULTS,
		schema: WEB_URL_SCHEMA,
		async run(args) {
			const outcome = await oaFetchPage(args.url);
			if (!outcome.ok) return fail(outcome.error);
			const fetched = outcome.page;
			const text = oaTruncate(fetched.kind === "html" ? fetched.page.text : fetched.text, MAX_TEXT_CHARS);
			const links = fetched.kind === "html" ? fetched.page.links.slice(0, MAX_LINKS) : [];
			const title = fetched.kind === "html" ? fetched.page.title : "";
			return ok({ url: fetched.url, status: fetched.status, title, text, links });
		},
	});
}
