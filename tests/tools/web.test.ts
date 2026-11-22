import { beforeEach, describe, expect, it } from "vitest";
import { webTools } from "../../src/tools/web";
import { webFetchTool } from "../../src/tools/web/fetch";
import { webReadTool } from "../../src/tools/web/read";
import type { ToolDef } from "../../src/types";
import {
	createMockAnchor,
	createMockHtmlFragment,
	requestUrlMock,
	sanitizeHTMLToDomMock,
} from "../setup";

const PAGE_URL = "https://example.com/";

const EXAMPLE_MARKDOWN =
	"# Example Domain\n\nThis domain is for use in illustrative examples.\n\n[More information...](https://example.com/more)";

const EXAMPLE_TEXT =
	"Example Domain\n\nThis domain is for use in illustrative examples.\n\nMore information... (https://example.com/more)";

const EXAMPLE_HTML = [
	"<html><head><title>Example Domain</title></head><body>",
	"<h1>Example Domain</h1>",
	"<p>This domain is for use in illustrative examples.</p>",
	'<a href="/more">More information...</a>',
	"</body></html>",
].join("");

function toolNamed(name: string): ToolDef {
	const tool = webTools().find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing tool: ${name}`);
	return tool;
}

interface Reply {
	status?: number;
	contentType?: string;
	text: string;
}

/** Answer the next `requestUrl` call, with the headers of a real response. */
function reply({ status = 200, contentType = "text/html; charset=utf-8", text }: Reply): void {
	requestUrlMock.mockResolvedValueOnce({
		status,
		headers: { "content-type": contentType, "content-length": String(text.length) },
		text,
		arrayBuffer: new ArrayBuffer(0),
		json: {},
	});
}

/** Stage the fragment that the body parse returns. The title decode falls through. */
function stagePage(options: { markdown?: string; anchors?: ReturnType<typeof createMockAnchor>[] }): void {
	sanitizeHTMLToDomMock.mockReturnValueOnce(
		createMockHtmlFragment({ markdown: options.markdown ?? "", anchors: options.anchors ?? [] }),
	);
}

function run(toolName: string, url: string): Promise<unknown> {
	return toolNamed(toolName).run({ url }, {});
}

beforeEach(() => {
	requestUrlMock.mockReset();
});

describe("webTools", () => {
	it("registers web_fetch then web_read, both read-only and time-limited", () => {
		const tools = webTools();
		expect(tools.map((tool) => tool.name)).toEqual(["web_fetch", "web_read", "research"]);
		for (const tool of [webFetchTool(), webReadTool()]) {
			expect(tool.category).toBe("web");
			expect(tool.mutates).toBe(false);
			expect(tool.timeoutMs).toBe(20_000);
			expect(tool.schema.required).toEqual(["url"]);
			expect(tool.schema.properties.url.type).toBe("string");
		}
	});

	it("states the redirect limitation in both descriptions", () => {
		for (const tool of [webFetchTool(), webReadTool()]) {
			const limitation =
				"`requestUrl` does not report the final URL after a redirect, so `url` in the result is the URL that was requested while the content may be the page it redirected to.";
			expect(tool.description).toContain(limitation);
		}
	});
});

describe("web_fetch", () => {
	it("returns the title, the text and the links of an html page", async () => {
		reply({ text: EXAMPLE_HTML });
		stagePage({ markdown: EXAMPLE_MARKDOWN, anchors: [createMockAnchor("/more", "More information...")] });

		const result = await run("web_fetch", PAGE_URL);

		expect(result).toEqual({
			ok: true,
			value: {
				url: PAGE_URL,
				status: 200,
				title: "Example Domain",
				text: EXAMPLE_TEXT,
				links: [{ text: "More information...", href: "https://example.com/more" }],
			},
		});
	});

	it("parses application/xhtml+xml", async () => {
		reply({ text: EXAMPLE_HTML, contentType: "application/xhtml+xml" });
		stagePage({ markdown: EXAMPLE_MARKDOWN, anchors: [createMockAnchor("/more", "More information...")] });

		const result = (await run("web_fetch", PAGE_URL)) as { ok: true; value: { title: string } };

		expect(result.value.title).toBe("Example Domain");
	});

	it("passes plain text through without a parse", async () => {
		reply({ text: "hello world", contentType: "text/plain; charset=utf-8" });

		const result = await run("web_fetch", PAGE_URL);

		expect(result).toEqual({
			ok: true,
			value: { url: PAGE_URL, status: 200, title: "", text: "hello world", links: [] },
		});
		expect(sanitizeHTMLToDomMock).not.toHaveBeenCalled();
	});

	it("passes json through unchanged", async () => {
		reply({ text: '{"a":1}', contentType: "application/json" });

		const result = (await run("web_fetch", PAGE_URL)) as { ok: true; value: { text: string } };

		expect(result.value.text).toBe('{"a":1}');
	});

	it("fails with the status when the response is an error", async () => {
		reply({ status: 404, text: "<html><body>Not found</body></html>" });

		expect(await run("web_fetch", PAGE_URL)).toEqual({ ok: false, error: "WebHttpError: HTTP 404" });
		expect(sanitizeHTMLToDomMock).not.toHaveBeenCalled();
	});

	it("fails on status 400", async () => {
		reply({ status: 400, text: "bad request" });

		expect(await run("web_fetch", PAGE_URL)).toEqual({ ok: false, error: "WebHttpError: HTTP 400" });
	});

	it("accepts status 399 and passes it through", async () => {
		reply({ status: 399, text: "hello world", contentType: "text/plain" });

		expect(await run("web_fetch", PAGE_URL)).toEqual({
			ok: true,
			value: { url: PAGE_URL, status: 399, title: "", text: "hello world", links: [] },
		});
	});

	it("fails before a parse when the body is above 2 MB", async () => {
		reply({ text: "x".repeat(2 * 1024 * 1024 + 1) });

		const result = (await run("web_fetch", PAGE_URL)) as { ok: false; error: string };

		expect(result.ok).toBe(false);
		expect(result.error.startsWith("WebBodyTooLarge:")).toBe(true);
		expect(result.error).toContain("2097153");
		expect(sanitizeHTMLToDomMock).not.toHaveBeenCalled();
	});

	it("rejects a scheme that is not http or https", async () => {
		for (const toolName of ["web_fetch", "web_read"]) {
			const result = (await run(toolName, "ftp://example.com/file")) as { ok: false; error: string };

			expect(result.ok).toBe(false);
			expect(result.error.startsWith("WebUrlRejected:")).toBe(true);
		}
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("rejects a url that is not absolute", async () => {
		const result = (await run("web_fetch", "example.com/page")) as { ok: false; error: string };

		expect(result.ok).toBe(false);
		expect(result.error.startsWith("WebUrlRejected:")).toBe(true);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("truncates the text at 40 000 characters and says so", async () => {
		reply({ text: `<html><body>${"a".repeat(40_001)}</body></html>` });
		stagePage({ markdown: "a".repeat(40_001) });

		const result = (await run("web_fetch", PAGE_URL)) as { ok: true; value: { text: string } };

		expect(result.value.text).toBe(`${"a".repeat(40_000)}\n\n[truncated]`);
	});

	it("truncates the raw text at 40 000 characters too", async () => {
		reply({ text: "a".repeat(40_001), contentType: "text/plain" });

		const result = (await run("web_fetch", PAGE_URL)) as { ok: true; value: { text: string } };

		expect(result.value.text).toBe(`${"a".repeat(40_000)}\n\n[truncated]`);
	});

	it("keeps only the first 200 links", async () => {
		const anchors = Array.from({ length: 201 }, (_, index) => createMockAnchor(`/p/${index}`, `link ${index}`));
		reply({ text: "<html><body>Links</body></html>" });
		stagePage({ markdown: "Links", anchors });

		const result = (await run("web_fetch", PAGE_URL)) as {
			ok: true;
			value: { links: Array<{ text: string; href: string }> };
		};

		expect(result.value.links).toHaveLength(200);
		expect(result.value.links[0].href).toBe("https://example.com/p/0");
		expect(result.value.links[199].href).toBe("https://example.com/p/199");
	});
});

describe("web_read", () => {
	it("returns the markdown of an html page", async () => {
		reply({ text: EXAMPLE_HTML });
		stagePage({ markdown: EXAMPLE_MARKDOWN, anchors: [createMockAnchor("/more", "More information...")] });

		const result = await run("web_read", PAGE_URL);

		expect(result).toEqual({ ok: true, value: { url: PAGE_URL, markdown: EXAMPLE_MARKDOWN } });
	});

	it("returns plain text as its own markdown", async () => {
		reply({ text: "plain words", contentType: "text/plain" });

		const result = await run("web_read", PAGE_URL);

		expect(result).toEqual({ ok: true, value: { url: PAGE_URL, markdown: "plain words" } });
		expect(sanitizeHTMLToDomMock).not.toHaveBeenCalled();
	});

	it("shares the error handling of web_fetch", async () => {
		reply({ status: 500, text: "boom" });
		expect(await run("web_read", PAGE_URL)).toEqual({ ok: false, error: "WebHttpError: HTTP 500" });
	});

	it("truncates the markdown at 100 000 characters and says so", async () => {
		reply({ text: "<html><body>Long</body></html>" });
		stagePage({ markdown: "b".repeat(100_001) });

		const result = (await run("web_read", PAGE_URL)) as { ok: true; value: { markdown: string } };

		expect(result.value.markdown).toBe(`${"b".repeat(100_000)}\n\n[truncated]`);
	});
});

describe("web_fetch host and network gates", () => {
	const PRIVATE_HOST_REJECTED = "WebUrlRejected: only public http and https hosts are supported";

	it("rejects a loopback, private, link-local or unspecified host", async () => {
		const hosts = [
			"http://127.0.0.1:27123/vault/",
			"http://localhost:5173/",
			"http://192.168.1.1/",
			"http://10.0.0.5/",
			"http://172.16.0.1/",
			"http://172.31.255.255/",
			"http://169.254.169.254/",
			"http://0.0.0.0/",
			"http://printer.local/",
			"http://[::1]/",
		];
		for (const url of hosts) {
			expect(await run("web_fetch", url)).toEqual({ ok: false, error: PRIVATE_HOST_REJECTED });
		}
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("still fetches a public host, including the edges of the private ranges", async () => {
		for (const url of ["https://172.15.0.1/", "https://172.32.0.1/", "https://93.184.216.34/page"]) {
			reply({ text: "hello world", contentType: "text/plain" });
			expect(await run("web_fetch", url)).toEqual({
				ok: true,
				value: { url, status: 200, title: "", text: "hello world", links: [] },
			});
		}
	});

	it("reports a transport failure as a named error", async () => {
		requestUrlMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED 93.184.216.34:443"));

		const result = (await run("web_fetch", PAGE_URL)) as { ok: false; error: string };

		expect(result).toEqual({ ok: false, error: "WebNetworkError: connect ECONNREFUSED 93.184.216.34:443" });
	});

	it("reports a non-Error rejection as its text", async () => {
		requestUrlMock.mockRejectedValueOnce("socket hung up");

		const result = (await run("web_fetch", PAGE_URL)) as { ok: false; error: string };

		expect(result).toEqual({ ok: false, error: "WebNetworkError: socket hung up" });
	});
});
