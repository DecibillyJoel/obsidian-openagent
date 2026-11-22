import type { ToolDef } from "../../types";
import { defineTool, fail, ok } from "../define";
import { oaFetchPage, oaTruncate, WEB_TOOL_DEFAULTS, WEB_URL_SCHEMA, type WebToolArgs } from "./fetch";

/** The cap on the `markdown` field of `web_read`. */
const MAX_MARKDOWN_CHARS = 100_000;

export function webReadTool(): ToolDef<WebToolArgs> {
	return defineTool<WebToolArgs>({
		name: "web_read",
		description:
			"Fetch one http or https page and return it as markdown with absolute links. `requestUrl` does not report the final URL after a redirect, so `url` in the result is the URL that was requested while the content may be the page it redirected to.",
		...WEB_TOOL_DEFAULTS,
		schema: WEB_URL_SCHEMA,
		async run(args) {
			const outcome = await oaFetchPage(args.url);
			if (!outcome.ok) return fail(outcome.error);
			const fetched = outcome.page;
			const markdown = fetched.kind === "html" ? fetched.page.markdown : fetched.text;
			return ok({ url: fetched.url, markdown: oaTruncate(markdown, MAX_MARKDOWN_CHARS) });
		},
	});
}
