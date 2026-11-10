import { oaFetchModelIds } from "../provider";
import { oaNewModelCategoryId, type ModelCategory, type ModelCategoryKind } from "./categories";

export interface OaCategoriesSectionState {
	noticeIds: Set<string>;
	openIds: Set<string>;
}

export function oaNewCategoriesSectionState(): OaCategoriesSectionState {
	return { noticeIds: new Set<string>(), openIds: new Set<string>() };
}

export interface ModelCategoriesSectionOptions {
	getCategories(): ModelCategory[];
	setCategories(next: ModelCategory[]): Promise<void>;
	getEndpoint(): { baseUrl: string; apiKey: string };
	onChanged(): void;
	/**
	 * The state that must outlive one render, and one call: which categories are
	 * open, and which show a fetch notice. A caller that repaints the section
	 * passes the same object to every call.
	 */
	state?: OaCategoriesSectionState;
}

const UNTITLED_NAME = "Untitled category";

function oaCountLabel(count: number): string {
	return count === 1 ? "1 model" : `${count} models`;
}

/**
 * Renders the category editor: one `<details>` per category, then the button
 * that adds one.
 *
 * The editor never decides usability — the fetched catalog does. A stored id
 * the catalog lacks stays listed and checked, marked unavailable, so the user
 * can still clear it. Every mutation builds a new array for `setCategories`,
 * so the caller's own list is never edited in place.
 *
 * Ownership: the section creates one child div of `container` and empties only
 * that child on every render. A sibling that is already in `container` stays.
 *
 * The section caches one catalog per kind, so the fetch of one category cannot
 * relabel the rows of a category of the other kind.
 *
 * State: which categories are open and which show a fetch notice lives in
 * `options.state`, so a repaint keeps it. The section makes its own state when
 * the caller passes none.
 */
export function renderModelCategoriesSection(
	container: HTMLElement,
	options: ModelCategoriesSectionOptions,
): void {
	const catalogs: Record<ModelCategoryKind, string[] | null> = { text: null, image: null };
	const { noticeIds, openIds } = options.state ?? oaNewCategoriesSectionState();
	const root = container.createDiv({ cls: "open-agent-categories" });

	const render = (): void => {
		root.empty();
		const titles = new Map<string, HTMLInputElement>();

		for (const category of options.getCategories()) {
			const details = root.createEl("details", { cls: "open-agent-category" });
			details.open = openIds.has(category.id);
			details.addEventListener("toggle", () => {
				if (details.open) openIds.add(category.id);
				else openIds.delete(category.id);
			});

			const summary = details.createEl("summary");
			const nameEl = summary.createEl("span", {
				cls: "open-agent-category-name",
				text: category.name.trim() || UNTITLED_NAME,
			});
			const countEl = summary.createEl("span", {
				cls: "open-agent-category-count",
				text: oaCountLabel(category.models.length),
			});

			const body = details.createDiv({ cls: "open-agent-category-body" });
			const title = body.createEl("input", {
				cls: "open-agent-category-title",
				attr: { placeholder: "Category name" },
			});
			title.type = "text";
			title.value = category.name;
			titles.set(category.id, title);
			title.addEventListener("change", () => {
				void (async () => {
					const name = title.value;
					await options.setCategories(
						options.getCategories().map((entry) =>
							entry.id === category.id ? { ...entry, name } : entry,
						),
					);
					options.onChanged();
					nameEl.setText(name.trim() || UNTITLED_NAME);
				})();
			});

			const fetchButton = body.createEl("button", {
				cls: "open-agent-category-fetch",
				text: "Fetch models",
			});
			fetchButton.addEventListener("click", () => {
				void (async () => {
					const { baseUrl, apiKey } = options.getEndpoint();
					const fetched = await oaFetchModelIds(baseUrl, apiKey, category.kind);
					if (fetched.length === 0) {
						catalogs[category.kind] = null;
						noticeIds.add(category.id);
					} else {
						catalogs[category.kind] = fetched;
						noticeIds.delete(category.id);
					}
					render();
				})();
			});

			const filter = body.createEl("input", {
				cls: "open-agent-category-filter",
				attr: { placeholder: "Filter models" },
			});
			filter.type = "text";

			if (noticeIds.has(category.id)) {
				body.createEl("p", {
					cls: "open-agent-notice",
					text: "Could not fetch models — check URL and API key.",
				});
			}

			const list = body.createDiv({ cls: "open-agent-category-list" });
			const rows = new Map<string, HTMLElement>();
			const stored = category.models;
			const catalog = catalogs[category.kind];
			const listed =
				catalog === null ? [...stored] : [...stored, ...catalog.filter((id) => !stored.includes(id))];
			for (const id of listed) {
				const row = list.createEl("label", { cls: "open-agent-category-row" });
				const box = row.createEl("input", { cls: "open-agent-category-check" });
				box.type = "checkbox";
				box.checked = stored.includes(id);
				box.addEventListener("change", () => {
					void (async () => {
						const next = options.getCategories().map((entry) => {
							if (entry.id !== category.id) return entry;
							const models = box.checked
								? [...entry.models, id]
								: entry.models.filter((value) => value !== id);
							return { ...entry, models };
						});
						await options.setCategories(next);
						options.onChanged();
						const updated = next.find((entry) => entry.id === category.id);
						countEl.setText(oaCountLabel(updated ? updated.models.length : 0));
					})();
				});
				row.createEl("span", { cls: "open-agent-category-row-label", text: id });
				if (catalog !== null && !catalog.includes(id)) {
					row.addClass("open-agent-model-option-unavailable");
				}
				rows.set(id, row);
			}

			filter.addEventListener("change", () => {
				const text = filter.value.trim().toLowerCase();
				for (const [id, row] of rows) {
					if (id.toLowerCase().includes(text)) row.removeClass("open-agent-category-row-hidden");
					else row.addClass("open-agent-category-row-hidden");
				}
			});

			const removeButton = body.createEl("button", {
				cls: "open-agent-category-remove",
				text: "Remove category",
			});
			removeButton.addEventListener("click", () => {
				void (async () => {
					openIds.delete(category.id);
					await options.setCategories(
						options.getCategories().filter((entry) => entry.id !== category.id),
					);
					options.onChanged();
					render();
				})();
			});
		}

		const addButtons: Array<[ModelCategoryKind, string]> = [
			["text", "Add text category"],
			["image", "Add image category"],
		];
		for (const [kind, label] of addButtons) {
			const addButton = root.createEl("button", {
				cls: `open-agent-category-add-${kind}`,
				text: label,
			});
			addButton.addEventListener("click", () => {
				void (async () => {
					const created: ModelCategory = { id: oaNewModelCategoryId(), name: "", kind, models: [] };
					openIds.add(created.id);
					await options.setCategories([...options.getCategories(), created]);
					options.onChanged();
					render();
					titles.get(created.id)?.focus();
				})();
			});
		}
	};

	render();
}
