import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, OpenAgentSettingsTab, type PluginSettings } from "../src/settings";
import { oaSanitizeModelCategories } from "../src/models/categories";
import { MockElement, createMockApp, requestUrlMock, settingControls } from "./setup";

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
async function clickFetch(): Promise<void> {
	requestUrlMock.mockResolvedValue({ status: 200, text: IMAGE_CATALOG_REPLY });
	const handler = settingControls.at(-1)?.buttonHandlers[0];
	if (!handler) throw new Error("the model setting did not render a fetch button");
	await handler();
}

/** The options inside the painted groups, without the pseudo options above them. */
function optgroupValuesOf(select: MockElement): string[] {
	return select.children
		.filter((child) => child.tagName === "optgroup")
		.flatMap((group) => group.children.map((option) => option.value));
}

describe("model dropdowns in settings", () => {
	beforeEach(() => {
		settingControls.length = 0;
	});

	it("drops a stored image model the catalog knows cannot serve images", async () => {
		const select = renderImageModelSetting("text-only-id");
		await clickFetch();
		expect(select.value).toBe("img-only-id");
		expect(optgroupValuesOf(select)).toEqual(["img-only-id"]);
	});

	it("drops a stored batch image model", async () => {
		const select = renderImageModelSetting("img-a:batch");
		await clickFetch();
		expect(select.value).toBe("img-only-id");
		expect(optgroupValuesOf(select)).toEqual(["img-only-id"]);
	});

	it("keeps a stored image model the catalog missed", async () => {
		const select = renderImageModelSetting("gone-image");
		await clickFetch();
		expect(select.value).toBe("gone-image");
		expect(optgroupValuesOf(select)).toEqual(["gone-image", "img-only-id"]);
	});
});
