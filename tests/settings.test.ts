import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type PluginSettings } from "../src/settings";
import { oaSanitizeModelCategories } from "../src/models/categories";

describe("model categories in settings", () => {
	it("defaults to an empty list", () => {
		expect(DEFAULT_SETTINGS.modelCategories).toEqual([]);
	});

	it("gives each settings object its own category list", () => {
		const build = (): PluginSettings => ({
			...DEFAULT_SETTINGS,
			modelCategories: oaSanitizeModelCategories(undefined),
		});
		const first = build();
		first.modelCategories.push({ id: "cat-1", name: "Favourites", models: ["a"] });
		const second = build();
		expect(first.modelCategories).not.toBe(second.modelCategories);
		expect(second.modelCategories).toEqual([]);
		expect(DEFAULT_SETTINGS.modelCategories).toEqual([]);
	});
});
