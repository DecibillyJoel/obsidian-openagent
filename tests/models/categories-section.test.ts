import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockElement, requestUrlMock } from "../setup";
import type { ModelCategory } from "../../src/models/categories";
import { oaNewCategoriesSectionState, renderModelCategoriesSection } from "../../src/models/categoriesSection";

function findByClass(root: MockElement, className: string): MockElement[] {
	const out: MockElement[] = [];
	for (const child of root.children) {
		if (child.classList.contains(className)) out.push(child);
		out.push(...findByClass(child, className));
	}
	return out;
}

function setup(categories: ModelCategory[], container = new MockElement("div")) {
	const saves: ModelCategory[][] = [];
	const changed = vi.fn();
	renderModelCategoriesSection(container as unknown as HTMLElement, {
		getCategories: () => categories,
		setCategories: async (next: ModelCategory[]) => {
			saves.push(next);
			categories.splice(0, categories.length, ...next);
		},
		getEndpoint: () => ({ baseUrl: "https://example.test/v1", apiKey: "token" }),
		onChanged: changed,
	});
	return { container, saves, changed };
}

function listIds(container: MockElement): string[] {
	return findByClass(container, "open-agent-category-row-label").map((el) => el.textContent);
}

/** The root of the section as it was painted last, not an earlier one. */
function currentRoot(container: MockElement): MockElement {
	const roots = findByClass(container, "open-agent-categories");
	return roots[roots.length - 1];
}

/**
 * The mock element records no category id, and the section paints one
 * `<details>` per category in `getCategories()` order, so the order of the last
 * render maps an id to its element.
 */
let renderedIds: string[] = [];

type DetailsElement = MockElement & { open?: boolean };

function detailsOf(container: MockElement, id: string): DetailsElement {
	const index = renderedIds.indexOf(id);
	expect(index).toBeGreaterThanOrEqual(0);
	return findByClass(currentRoot(container), "open-agent-category")[index] as DetailsElement;
}

function isCategoryOpen(container: MockElement, id: string): boolean {
	return detailsOf(container, id).open === true;
}

/** The user expands the category: the browser sets `open`, then fires `toggle`. */
function openCategory(container: MockElement, id: string): void {
	const details = detailsOf(container, id);
	details.open = true;
	details.fire("toggle");
}

function renderSection(
	container: MockElement,
	options: { state: ReturnType<typeof oaNewCategoriesSectionState>; categories: ModelCategory[] },
): void {
	renderedIds = options.categories.map((category) => category.id);
	renderModelCategoriesSection(container as unknown as HTMLElement, {
		state: options.state,
		getCategories: () => options.categories,
		setCategories: async () => undefined,
		getEndpoint: () => ({ baseUrl: "https://example.test/v1", apiKey: "token" }),
		onChanged: () => undefined,
	});
}

// The fetch handler is async, and `requestUrlMock` resolves at once, so a
// fixed run of microtask ticks settles it. This is deterministic because the
// mock never touches a timer, a socket, or the clock.
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function clickFetch(container: MockElement): Promise<void> {
	findByClass(container, "open-agent-category-fetch")[0].click();
	await flush();
}

function checkRow(container: MockElement, id: string): MockElement {
	return findByClass(container, "open-agent-category-check")[listIds(container).indexOf(id)];
}

const TEXT_CATALOG = {
	status: 200,
	text: JSON.stringify({
		data: [
			{ id: "a", architecture: { output_modalities: ["text"] } },
			{ id: "b", architecture: { output_modalities: ["text"] } },
		],
	}),
};

const IMAGE_CATALOG = {
	status: 200,
	text: JSON.stringify({
		data: [
			{ id: "i1", architecture: { output_modalities: ["image"] } },
			{ id: "i2", architecture: { output_modalities: ["image"] } },
		],
	}),
};

beforeEach(() => {
	renderedIds = [];
	requestUrlMock.mockResolvedValue({
		status: 200,
		text: JSON.stringify({ data: [] }),
	});
});

describe("model categories section", () => {
	it("renders the stored members before any fetch, marked available", () => {
		const { container } = setup([{ id: "c1", name: "Favourites", kind: "text", models: ["a", "b"] }]);
		expect(listIds(container)).toEqual(["a", "b"]);
		expect(findByClass(container, "open-agent-model-option-unavailable")).toEqual([]);
	});

	it("lists a fetched id after the stored members, once", async () => {
		requestUrlMock.mockResolvedValue(TEXT_CATALOG);
		const { container } = setup([{ id: "c1", name: "Favourites", kind: "text", models: ["b"] }]);
		await clickFetch(container);
		expect(listIds(container)).toEqual(["b", "a"]);
	});

	it("marks a stored id the fetch did not return as unavailable and keeps it checked", async () => {
		requestUrlMock.mockResolvedValue(TEXT_CATALOG);
		const { container } = setup([{ id: "c1", name: "Favourites", kind: "text", models: ["a", "gone"] }]);
		await clickFetch(container);
		expect(listIds(container)).toEqual(["a", "gone", "b"]);
		const goneRow = findByClass(container, "open-agent-category-row")[1];
		expect(goneRow.classList.contains("open-agent-model-option-unavailable")).toBe(true);
		expect(checkRow(container, "gone").checked).toBe(true);
	});

	it("adds a checked fetched id and saves", async () => {
		requestUrlMock.mockResolvedValue(TEXT_CATALOG);
		const { container, saves, changed } = setup([{ id: "c1", name: "Favourites", kind: "text", models: ["b"] }]);
		await clickFetch(container);
		checkRow(container, "a").checked = true;
		checkRow(container, "a").fire("change");
		await flush();
		expect(saves).toHaveLength(1);
		expect(saves[0][0].models).toEqual(["b", "a"]);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("removes an unchecked stored id and saves", async () => {
		requestUrlMock.mockResolvedValue(TEXT_CATALOG);
		const { container, saves } = setup([{ id: "c1", name: "Favourites", kind: "text", models: ["a", "b"] }]);
		await clickFetch(container);
		checkRow(container, "b").checked = false;
		checkRow(container, "b").fire("change");
		await flush();
		expect(saves).toHaveLength(1);
		expect(saves[0][0].models).toEqual(["a"]);
	});

	it("filters the rows", async () => {
		requestUrlMock.mockResolvedValue(TEXT_CATALOG);
		const { container } = setup([{ id: "c1", name: "Favourites", kind: "text", models: ["a", "b"] }]);
		await clickFetch(container);
		const filter = findByClass(container, "open-agent-category-filter")[0];
		filter.value = "a";
		filter.fire("change");
		expect(findByClass(container, "open-agent-category-row-hidden")).toHaveLength(1);
		expect(listIds(container)).toEqual(["a", "b"]);
	});

	it("keeps the stored members and shows a notice when the fetch is empty", async () => {
		const { container } = setup([{ id: "c1", name: "Favourites", kind: "text", models: ["a", "b"] }]);
		await clickFetch(container);
		expect(listIds(container)).toEqual(["a", "b"]);
		expect(findByClass(container, "open-agent-model-option-unavailable")).toEqual([]);
		expect(findByClass(container, "open-agent-notice")).toHaveLength(1);
	});

	it("adds an empty category and saves it", async () => {
		const { container, saves, changed } = setup([{ id: "c1", name: "Favourites", kind: "text", models: ["a"] }]);
		findByClass(container, "open-agent-category-add-text")[0].click();
		await flush();
		expect(saves).toHaveLength(1);
		expect(saves[0]).toHaveLength(2);
		const created = saves[0][1];
		expect(created.name).toBe("");
		expect(created.models).toEqual([]);
		expect(created.id).not.toBe("");
		expect(changed).toHaveBeenCalledTimes(1);
		expect(findByClass(container, "open-agent-category")).toHaveLength(2);
	});

	it("removes a category and saves", async () => {
		const { container, saves } = setup([{ id: "c1", name: "Favourites", kind: "text", models: ["a"] }]);
		findByClass(container, "open-agent-category-remove")[0].click();
		await flush();
		expect(saves).toHaveLength(1);
		expect(saves[0]).toEqual([]);
		expect(findByClass(container, "open-agent-category")).toEqual([]);
	});

	it("renames a category on change and shows Untitled category for a blank name", async () => {
		const { container, saves } = setup([{ id: "c1", name: "Favourites", kind: "text", models: [] }]);
		const title = findByClass(container, "open-agent-category-title")[0];
		title.value = "Fast";
		title.fire("change");
		await flush();
		expect(saves[0][0].name).toBe("Fast");
		expect(findByClass(container, "open-agent-category-name")[0].textContent).toBe("Fast");

		title.value = "";
		title.fire("change");
		await flush();
		expect(saves[1][0].name).toBe("");
		expect(findByClass(container, "open-agent-category-name")[0].textContent).toBe("Untitled category");
	});

	it("leaves a sibling already in the container alone", () => {
		const container = new MockElement("div");
		const sibling = container.createDiv({ cls: "open-agent-existing-setting" });
		sibling.setText("Grounded Research");
		setup([{ id: "c1", name: "Favourites", kind: "text", models: [] }], container);
		expect(container.children).toContain(sibling);
		expect(sibling.textContent).toBe("Grounded Research");
	});

	it("creates a text category from the text button", async () => {
		const { container, saves } = setup([]);
		findByClass(container, "open-agent-category-add-text")[0].click();
		await flush();
		expect(saves[saves.length - 1][0].kind).toBe("text");
	});

	it("creates an image category from the image button", async () => {
		const { container, saves } = setup([]);
		findByClass(container, "open-agent-category-add-image")[0].click();
		await flush();
		expect(saves[saves.length - 1][0].kind).toBe("image");
	});

	it("renders no control that could change an existing kind", () => {
		const { container } = setup([{ id: "a", name: "A", kind: "text", models: [] }]);
		expect(findByClass(container, "open-agent-category-add-kind")).toEqual([]);
		expect(findByClass(container, "open-agent-category-kind")).toEqual([]);
	});

	it("keeps a category open across a re-render", () => {
		const container = new MockElement("div");
		const state = oaNewCategoriesSectionState();
		const categories: ModelCategory[] = [{ id: "cat-1", name: "A", kind: "text", models: [] }];
		renderSection(container, { state, categories });
		openCategory(container, "cat-1");
		renderSection(container, { state, categories });
		expect(isCategoryOpen(container, "cat-1")).toBe(true);
	});

	it("keeps a fetch notice across a re-render", () => {
		const container = new MockElement("div");
		const state = oaNewCategoriesSectionState();
		state.noticeIds.add("cat-1");
		renderSection(container, {
			state,
			categories: [{ id: "cat-1", name: "A", kind: "text", models: [] }],
		});
		const notices = findByClass(currentRoot(container), "open-agent-notice");
		expect(notices).toHaveLength(1);
		expect(notices[0].textContent).toContain("Could not fetch models");
	});

	it("fetches only the kind of the category it belongs to", async () => {
		requestUrlMock.mockClear();
		requestUrlMock.mockResolvedValue(IMAGE_CATALOG);
		const { container } = setup([{ id: "a", name: "A", kind: "image", models: [] }]);
		await clickFetch(container);
		const asked = requestUrlMock.mock.calls.map((call) => (call[0] as { url: string }).url);
		expect(asked).toEqual(["https://example.test/v1/images/models"]);
	});
});
