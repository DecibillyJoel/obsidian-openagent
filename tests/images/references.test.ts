import { describe, expect, it } from "vitest";
import { oaExtractDisplayedImageEmbeds } from "../../src/images/references";

describe("oaExtractDisplayedImageEmbeds", () => {
	it("extracts wikilink embeds and strips aliases and headings", () => {
		expect(oaExtractDisplayedImageEmbeds("See ![[img/a.png]] here.")).toEqual(["img/a.png"]);
		expect(oaExtractDisplayedImageEmbeds("![[img/a.png|alt text]]")).toEqual(["img/a.png"]);
		expect(oaExtractDisplayedImageEmbeds("![[img/a.png#Section]]")).toEqual(["img/a.png"]);
	});

	it("extracts markdown embeds and strips titles and angle brackets", () => {
		expect(oaExtractDisplayedImageEmbeds("![alt](img/a.png)")).toEqual(["img/a.png"]);
		expect(oaExtractDisplayedImageEmbeds('![alt](img/a.png "title")')).toEqual(["img/a.png"]);
		expect(oaExtractDisplayedImageEmbeds("![alt](<img/a.png>)")).toEqual(["img/a.png"]);
	});

	it("decodes percent-encoded markdown targets", () => {
		expect(oaExtractDisplayedImageEmbeds("![alt](img/my%20photo.png)")).toEqual(["img/my photo.png"]);
	});

	it("ignores non-image embeds and bare text", () => {
		const text = [
			"![note](notes/a.md)",
			"![[notes/b.txt]]",
			"a bare a.png path",
			"https://example.com/a.png",
		].join(" ");
		expect(oaExtractDisplayedImageEmbeds(text)).toEqual([]);
	});

	it("keeps a markdown embed whose target is a remote image URL", () => {
		expect(oaExtractDisplayedImageEmbeds("![remote](https://example.com/a.png)")).toEqual([
			"https://example.com/a.png",
		]);
	});

	it("de-duplicates and preserves order", () => {
		const text = "![[img/a.png]] ![[img/b.png]] ![dup](img/a.png)";
		expect(oaExtractDisplayedImageEmbeds(text)).toEqual(["img/a.png", "img/b.png"]);
	});

	it("returns [] for an empty string", () => {
		expect(oaExtractDisplayedImageEmbeds("")).toEqual([]);
	});
});
