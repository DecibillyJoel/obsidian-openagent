import { describe, expect, it } from "vitest";
import { oaParseHtml } from "../../src/web/html";
import {
	createMockAnchor,
	createMockHtmlFragment,
	htmlToMarkdownCalls,
	type MockHtmlFragment,
	type MockHtmlFragmentOptions,
	sanitizeHTMLToDomMock,
	setAttributeCalls,
} from "../setup";

const base = "https://example.com/docs/page.html";

/**
 * Queue the fragment that the body parse returns. The title decode is a
 * separate call and falls through to the default mock implementation.
 */
function queueFragment(options: MockHtmlFragmentOptions = {}): MockHtmlFragment {
	const fragment = createMockHtmlFragment(options);
	sanitizeHTMLToDomMock.mockReturnValueOnce(fragment);
	return fragment;
}

describe("oaParseHtml title", () => {
	it("reads and collapses the first title", () => {
		queueFragment();
		const page = oaParseHtml("<html><head><title>  Docs   Home  </title><title>Second</title></head></html>", base);
		expect(page.title).toBe("Docs Home");
	});

	it("decodes entities through the native sanitiser", () => {
		queueFragment();
		expect(oaParseHtml("<html><head><title>Tom &amp; Jerry</title></head></html>", base).title).toBe("Tom & Jerry");
	});

	it("ignores attributes on the title element", () => {
		queueFragment();
		expect(oaParseHtml('<html><head><title id="t" class="x">Spaced</title></head></html>', base).title).toBe("Spaced");
	});

	it("gives an empty title when absent", () => {
		queueFragment();
		expect(oaParseHtml("<p>Hi</p>", base).title).toBe("");
	});
});

describe("oaParseHtml body parse", () => {
	it("passes the raw html to the native sanitiser", () => {
		const html = "<p>Visible</p><script>var leak = 1;</script>";
		queueFragment({ markdown: "Visible" });
		oaParseHtml(html, base);
		expect(sanitizeHTMLToDomMock).toHaveBeenCalledWith(html);
	});

	it("takes no text from a script element", () => {
		const html = '<html><body><script>var leak = "x";</script><p>Visible</p></body></html>';
		queueFragment({ markdown: "Visible" });
		const page = oaParseHtml(html, base);
		expect(page.text).toBe("Visible");
		expect(page.markdown).toBe("Visible");
	});
});

describe("oaParseHtml markdown", () => {
	it("equals the native conversion, trimmed", () => {
		const fragment = queueFragment({ markdown: "\n\n# One\n\nText\n\n" });
		const page = oaParseHtml("<p>Text</p>", base);
		expect(page.markdown).toBe("# One\n\nText");
		expect(htmlToMarkdownCalls).toHaveLength(1);
		expect(htmlToMarkdownCalls[0]).toBe(fragment);
	});
});

describe("oaParseHtml text", () => {
	const text = (markdown: string): string => {
		queueFragment({ markdown });
		return oaParseHtml("<p>x</p>", base).text;
	};

	it("keeps block boundaries from the markdown", () => {
		expect(text("# Title\n\nOne\n\n- Alpha\n- Beta")).toBe("Title\n\nOne\n\nAlpha\nBeta");
	});

	it("unwraps markdown links to label and href", () => {
		expect(text("See [Docs](https://example.com/docs) now")).toBe("See Docs (https://example.com/docs) now");
	});

	it("drops heading, quote, rule and table markers", () => {
		expect(text("# Head\n\n> Quoted\n\n---\n\n| A | B |")).toBe("Head\n\nQuoted\n\nA B");
	});

	it("removes markdown backslash escapes in one pass", () => {
		expect(text("See \\[0\\] and \\*star\\* here")).toBe("See [0] and *star* here");
		expect(text("a \\\\* b")).toBe("a \\* b");
		expect(text("a \\q b")).toBe("a \\q b");
	});

	it("passes fenced code through without stripping it", () => {
		const markdown = ["# Title", "", "```sh", "# comment", "- item", "a | b", "\\*kept\\*", "```", "", "After"];
		const expected = ["Title", "", "# comment", "- item", "a | b", "\\*kept\\*", "", "After"];
		expect(text(markdown.join("\n"))).toBe(expected.join("\n"));
	});

	it("treats a tilde fence as a code block", () => {
		expect(text("~~~\na | b\n~~~")).toBe("a | b");
	});

	it("keeps an indented line verbatim", () => {
		expect(text("Code:\n\n    a | b\n\n    \\# hash")).toBe("Code:\n\n    a | b\n\n    \\# hash");
	});

	it("drops a table delimiter row and keeps the cells", () => {
		expect(text("| A | B |\n| --- | :-- |\n| 1 | 2 |")).toBe("A B\n1 2");
	});

	it("collapses 3 or more blank lines to one blank line", () => {
		expect(text("One\n\n\n\nTwo")).toBe("One\n\nTwo");
	});

	it("trims the text", () => {
		expect(text("  \n\n  One  \n\n  ")).toBe("One");
	});

	it("gives empty text for empty markdown", () => {
		expect(text("")).toBe("");
	});
});

describe("oaParseHtml links", () => {
	it("resolves a relative href and keeps an absolute one", () => {
		queueFragment({
			anchors: [createMockAnchor("/docs/intro.html", "  Intro  "), createMockAnchor("https://other.test/x?a=1&b=2", "Other")],
		});
		expect(oaParseHtml("<p>x</p>", base).links).toEqual([
			{ text: "Intro", href: "https://example.com/docs/intro.html" },
			{ text: "Other", href: "https://other.test/x?a=1&b=2" },
		]);
	});

	it("resolves a path-relative href", () => {
		queueFragment({ anchors: [createMockAnchor("rel/page.html", "Rel")] });
		expect(oaParseHtml("<p>x</p>", base).links).toEqual([{ text: "Rel", href: "https://example.com/docs/rel/page.html" }]);
	});

	it("drops javascript, anchor-only and empty hrefs", () => {
		queueFragment({
			anchors: [
				createMockAnchor("javascript:void(0)", "JS"),
				createMockAnchor("#section", "Anchor"),
				createMockAnchor("", "Empty"),
				createMockAnchor("https://example.com/kept", "Kept"),
			],
		});
		const page = oaParseHtml("<p>x</p>", base);
		expect(page.links).toEqual([{ text: "Kept", href: "https://example.com/kept" }]);
		expect(setAttributeCalls.map((call) => call.value)).toEqual(["https://example.com/kept"]);
	});

	it("collapses duplicate resolved hrefs and keeps the first text", () => {
		queueFragment({
			anchors: [createMockAnchor("/docs", "First"), createMockAnchor("https://example.com/docs", "Second")],
		});
		expect(oaParseHtml("<p>x</p>", base).links).toEqual([{ text: "First", href: "https://example.com/docs" }]);
	});

	it("writes every resolved href back before the conversion", () => {
		const relative = createMockAnchor("/docs", "Docs");
		const absolute = createMockAnchor("https://other.test/x", "Other");
		const fragment = queueFragment({ anchors: [relative, absolute] });
		oaParseHtml("<p>x</p>", base);
		expect(setAttributeCalls.map((call) => [call.name, call.value])).toEqual([
			["href", "https://example.com/docs"],
			["href", "https://other.test/x"],
		]);
		expect(relative.getAttribute("href")).toBe("https://example.com/docs");
		expect(absolute.getAttribute("href")).toBe("https://other.test/x");
		expect(htmlToMarkdownCalls[0]).toBe(fragment);
	});

	it("has no links when the page has none", () => {
		queueFragment();
		expect(oaParseHtml("<p>Plain</p>", base).links).toEqual([]);
	});
});

describe("oaParseHtml on a long line", () => {
	it("parses a line of 200 000 open brackets well under a second", () => {
		const line = "[".repeat(200_000);
		queueFragment({ markdown: line });

		const started = Date.now();
		const page = oaParseHtml("<p>x</p>", base);
		const elapsed = Date.now() - started;

		expect(page.text).toBe(line);
		expect(elapsed).toBeLessThan(2_000);
	});

	it("still strips escapes, the prefix and the pipes on a long prose line", () => {
		const words = "a".repeat(3_000);
		queueFragment({ markdown: `# ${words} \\[0\\] | b` });

		expect(oaParseHtml("<p>x</p>", base).text).toBe(`${words} [0] b`);
	});
});
