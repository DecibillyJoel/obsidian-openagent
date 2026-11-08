import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockElement, requestUrlMock } from "../setup";
import type { ModelCategory } from "../../src/models/categories";
import { renderModelCategoriesSection } from "../../src/models/categoriesSection";

function findByClass(root: MockElement, className: string): MockElement[] {
	const out: MockElement[] = [];
	for (const child of root.children) {
		if (child.classList.contains(className)) out.push(child);
		out.push(...findByClass(child, className));
	}
	return out;
}

function setup(categories: ModelCategory[]) {
	const container = new MockElement("div");
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

beforeEach(() => {
	requestUrlMock.mockResolvedValue({
		status: 200,
		text: JSON.stringify({ data: [] }),
	});
});

describe("model categories section", () => {
	it("renders the stored members before any fetch, marked available", () => {
		const { container } = setup([{ id: "c1", name: "Favourites", models: ["a", "b"] }]);
		expect(listIds(container)).toEqual(["a", "b"]);
		expect(findByClass(container, "open-agent-model-option-unavailable")).toEqual([]);
	});

	it("lists a fetched id after the stored members, once", async () => {
		requestUrlMock.mockResolvedValue(TEXT_CATALOG);
		const { container } = setup([{ id: "c1", name: "Favourites", models: ["b"] }]);
		await clickFetch(container);
		expect(listIds(container)).toEqual(["b", "a"]);
	});

	it("marks a stored id the fetch did not return as unavailable and keeps it checked", async () => {
		requestUrlMock.mockResolvedValue(TEXT_CATALOG);
		const { container } = setup([{ id: "c1", name: "Favourites", models: ["a", "gone"] }]);
		await clickFetch(container);
		expect(listIds(container)).toEqual(["a", "gone", "b"]);
		const goneRow = findByClass(container, "open-agent-category-row")[1];
		expect(goneRow.classList.contains("open-agent-model-option-unavailable")).toBe(true);
		expect(checkRow(container, "gone").checked).toBe(true);
	});

	it("adds a checked fetched id and saves", async () => {
		requestUrlMock.mockResolvedValue(TEXT_CATALOG);
		const { container, saves, changed } = setup([{ id: "c1", name: "Favourites", models: ["b"] }]);
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
		const { container, saves } = setup([{ id: "c1", name: "Favourites", models: ["a", "b"] }]);
		await clickFetch(container);
		checkRow(container, "b").checked = false;
		checkRow(container, "b").fire("change");
		await flush();
		expect(saves).toHaveLength(1);
		expect(saves[0][0].models).toEqual(["a"]);
	});

	it("filters the rows", async () => {
		requestUrlMock.mockResolvedValue(TEXT_CATALOG);
		const { container } = setup([{ id: "c1", name: "Favourites", models: ["a", "b"] }]);
		await clickFetch(container);
		const filter = findByClass(container, "open-agent-category-filter")[0];
		filter.value = "a";
		filter.fire("change");
		expect(findByClass(container, "open-agent-category-row-hidden")).toHaveLength(1);
		expect(listIds(container)).toEqual(["a", "b"]);
	});

	it("keeps the stored members and shows a notice when the fetch is empty", async () => {
		const { container } = setup([{ id: "c1", name: "Favourites", models: ["a", "b"] }]);
		await clickFetch(container);
		expect(listIds(container)).toEqual(["a", "b"]);
		expect(findByClass(container, "open-agent-model-option-unavailable")).toEqual([]);
		expect(findByClass(container, "open-agent-notice")).toHaveLength(1);
	});

	it("adds an empty category and saves it", async () => {
		const { container, saves, changed } = setup([{ id: "c1", name: "Favourites", models: ["a"] }]);
		findByClass(container, "open-agent-category-add")[0].click();
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
		const { container, saves } = setup([{ id: "c1", name: "Favourites", models: ["a"] }]);
		findByClass(container, "open-agent-category-remove")[0].click();
		await flush();
		expect(saves).toHaveLength(1);
		expect(saves[0]).toEqual([]);
		expect(findByClass(container, "open-agent-category")).toEqual([]);
	});

	it("renames a category on change and shows Untitled category for a blank name", async () => {
		const { container, saves } = setup([{ id: "c1", name: "Favourites", models: [] }]);
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
});
