import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, OpenAgentSettingsTab, isConfigured, type PluginSettings } from "../src/settings";
import { oaSanitizeModelCategories } from "../src/models/categories";
import { MockElement, createMockApp, requestUrlMock, settingControls } from "./setup";

describe("isConfigured", () => {
	it("does not throw when a stored field is not a string", () => {
		const broken = { ...DEFAULT_SETTINGS, apiKey: 42 as unknown as string };
		expect(() => isConfigured(broken)).not.toThrow();
		expect(isConfigured(broken)).toBe(false);
	});

	it("still reports a complete configuration as configured", () => {
		expect(isConfigured({ ...DEFAULT_SETTINGS, baseUrl: "https://x/v1", apiKey: "k", model: "m" })).toBe(true);
	});
});

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
		first.modelCategories.push({ id: "cat-1", name: "Favourites", kind: "text", models: ["a"] });
		const second = build();
		expect(first.modelCategories).not.toBe(second.modelCategories);
		expect(second.modelCategories).toEqual([]);
		expect(DEFAULT_SETTINGS.modelCategories).toEqual([]);
	});
});

const IMAGE_CATALOG_REPLY = JSON.stringify({
	data: [
		{ id: "text-only-id", architecture: { output_modalities: ["text"] } },
		{ id: "img-only-id", architecture: { output_modalities: ["image"] } },
	],
});

/**
 * Renders the "Image generation model" setting of the settings tab for a stored
 * value, and returns the select the setting painted.
 */
function renderImageModelSetting(stored: string): MockElement {
	const settings: PluginSettings = {
		...DEFAULT_SETTINGS,
		baseUrl: "https://example.test/v1",
		apiKey: "token",
		imageModel: stored,
	};
	const plugin = { settings, saveSettings: async () => undefined, manifest: { dir: "test" } };
	const tab = new OpenAgentSettingsTab(createMockApp() as never, plugin as never);
	const container = new MockElement("div");

	const call = tab as unknown as {
		renderModelSetting(
			container: MockElement,
			name: string,
			desc: string,
			getValue: () => string,
			onSave: (value: string) => Promise<void>,
			getBaseUrl: () => string,
			getApiKey: () => string,
			kind: "text" | "image",
		): void;
	};
	call.renderModelSetting(
		container,
		"Image generation model",
		"",
		() => stored,
		async () => undefined,
		() => settings.baseUrl,
		() => settings.apiKey,
		"image",
	);

	const select = settingControls.at(-1)?.select;
	if (!select) throw new Error("the model setting did not render a dropdown");
	return select;
}

/** Answers the endpoint with the image catalog, then clicks the setting's Fetch button. */
async function clickFetch(catalogReply: string = IMAGE_CATALOG_REPLY): Promise<void> {
	requestUrlMock.mockResolvedValue({ status: 200, text: catalogReply });
	const handler = settingControls.at(-1)?.buttonHandlers[0];
	if (!handler) throw new Error("the model setting did not render a fetch button");
	await handler();
}

/** The pseudo options the select owns, above the painted groups. */
function topLevelOptionValuesOf(select: MockElement): string[] {
	return select.children
		.filter((child) => child.tagName === "option")
		.map((option) => option.value);
}

/** Every option the select holds, the pseudo options and the painted groups. */
function allOptionValuesOf(select: MockElement): string[] {
	return select.children.flatMap((child) =>
		child.tagName === "optgroup" ? child.children.map((option) => option.value) : [child.value],
	);
}

/** The options inside the painted groups, without the pseudo options above them. */
function optgroupValuesOf(select: MockElement): string[] {
	return select.children
		.filter((child) => child.tagName === "optgroup")
		.flatMap((group) => group.children.map((option) => option.value));
}

/** A text catalog answer. An id with no architecture carries no known kind. */
function textCatalogReply(ids: string[]): string {
	return JSON.stringify({ data: ids.map((id) => ({ id })) });
}

/**
 * Renders the "Model" setting for a stored value and returns the select it
 * painted. `saved` collects every value the setting persists.
 */
function renderModelSettingWithCatalog(stored: string): { select: MockElement; saved: string[] } {
	const settings: PluginSettings = {
		...DEFAULT_SETTINGS,
		baseUrl: "https://example.test/v1",
		apiKey: "token",
		model: stored,
	};
	const saved: string[] = [];
	const plugin = { settings, saveSettings: async () => undefined, manifest: { dir: "test" } };
	const tab = new OpenAgentSettingsTab(createMockApp() as never, plugin as never);

	const call = tab as unknown as {
		renderModelSetting(
			container: MockElement,
			name: string,
			desc: string,
			getValue: () => string,
			onSave: (value: string) => Promise<void>,
			getBaseUrl: () => string,
			getApiKey: () => string,
			kind: "text" | "image",
		): void;
	};
	call.renderModelSetting(
		new MockElement("div"),
		"Model",
		"",
		() => settings.model,
		async (value) => {
			saved.push(value);
			settings.model = value;
		},
		() => settings.baseUrl,
		() => settings.apiKey,
		"text",
	);

	const select = settingControls.at(-1)?.select;
	if (!select) throw new Error("the model setting did not render a dropdown");
	return { select, saved };
}

describe("model dropdowns in settings", () => {
	beforeEach(() => {
		settingControls.length = 0;
	});

	it("drops a stored image model the catalog knows cannot serve images", async () => {
		const select = renderImageModelSetting("text-only-id");
		await clickFetch();
		expect(select.value).toBe("");
		expect(optgroupValuesOf(select)).toEqual(["img-only-id"]);
	});

	it("drops a stored batch image model", async () => {
		const select = renderImageModelSetting("img-a:batch");
		await clickFetch();
		expect(select.value).toBe("");
		expect(optgroupValuesOf(select)).toEqual(["img-only-id"]);
	});

	it("keeps a stored image model the catalog missed", async () => {
		const select = renderImageModelSetting("gone-image");
		await clickFetch();
		expect(select.value).toBe("gone-image");
		expect(optgroupValuesOf(select)).toEqual(["gone-image", "img-only-id"]);
	});

	it("offers the stored model before a Fetch fills the catalog", () => {
		const { select } = renderModelSettingWithCatalog("b");
		expect(topLevelOptionValuesOf(select)).toEqual(["b"]);
		expect(allOptionValuesOf(select)).toContain("b");
		expect(select.value).toBe("b");
	});
});

describe("fetching a model catalog in settings", () => {
	beforeEach(() => {
		settingControls.length = 0;
	});

	it("does not choose a model when the stored value is empty", async () => {
		const { select, saved } = renderModelSettingWithCatalog("");
		await clickFetch(textCatalogReply(["a", "b"]));
		expect(select.value).toBe("");
		expect(saved).toEqual([]);
	});

	it("keeps the stored model when the catalog holds it", async () => {
		const { select, saved } = renderModelSettingWithCatalog("b");
		await clickFetch(textCatalogReply(["a", "b"]));
		expect(select.value).toBe("b");
		expect(saved).toEqual([]);
	});

	it("keeps a stored model the catalog missed and does not persist it", async () => {
		const { select, saved } = renderModelSettingWithCatalog("gone");
		await clickFetch(textCatalogReply(["a", "b"]));
		expect(select.value).toBe("gone");
		expect(saved).toEqual([]);
	});

	it("does not persist the stored model when Fetch returns a different catalog", async () => {
		const { select, saved } = renderModelSettingWithCatalog("b");
		await clickFetch(textCatalogReply(["x", "y"]));
		expect(select.value).toBe("b");
		expect(saved).toEqual([]);
	});
});
