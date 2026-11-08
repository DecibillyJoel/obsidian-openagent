import { describe, expect, it } from "vitest";
import { oaEscapeRegExp, oaOrdinalImageLabel, oaSanitizeImagePrompt } from "../../src/images/prompt";

describe("oaOrdinalImageLabel", () => {
	it("names the first ten images with ordinal words", () => {
		expect(oaOrdinalImageLabel(0)).toBe("the first image");
		expect(oaOrdinalImageLabel(1)).toBe("the second image");
		expect(oaOrdinalImageLabel(9)).toBe("the tenth image");
	});

	it("falls back to a numeric label beyond the tenth image", () => {
		expect(oaOrdinalImageLabel(10)).toBe("the 11th image");
	});
});

describe("oaEscapeRegExp", () => {
	it("escapes regular-expression metacharacters", () => {
		expect(oaEscapeRegExp("a.b*c")).toBe("a\\.b\\*c");
		expect(oaEscapeRegExp("a(b)[c]")).toBe("a\\(b\\)\\[c\\]");
	});
});

describe("oaSanitizeImagePrompt", () => {
	it("replaces a source name with its ordinal reference", () => {
		expect(oaSanitizeImagePrompt("draw a.png now", ["a.png"])).toBe("draw the first image now");
	});

	it("replaces every occurrence case-insensitively", () => {
		expect(oaSanitizeImagePrompt("A.PNG and a.png", ["a.png"])).toBe(
			"the first image and the first image",
		);
	});

	it("replaces the basename of a nested vault path", () => {
		expect(oaSanitizeImagePrompt("use photo.png", ["images/photo.png"])).toBe("use the first image");
	});

	it("keeps reference order when several names are replaced", () => {
		expect(oaSanitizeImagePrompt("b.png over a.png", ["a.png", "b.png"])).toBe(
			"the second image over the first image",
		);
	});

	it("skips names shorter than three characters", () => {
		expect(oaSanitizeImagePrompt("ab cat", ["ab"])).toBe("ab cat");
	});

	it("skips the conversation-image placeholder and empty names", () => {
		expect(oaSanitizeImagePrompt("conversation image", ["conversation image"])).toBe(
			"conversation image",
		);
		expect(oaSanitizeImagePrompt("plain prompt", ["", "a.png"])).toBe("plain prompt");
	});

	it("returns the prompt unchanged when there are no names", () => {
		expect(oaSanitizeImagePrompt("a cat in a hat", [])).toBe("a cat in a hat");
	});
});
