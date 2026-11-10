/**
 * Model categories, and the option groups they produce for a model chooser.
 *
 * This module imports nothing, so vitest covers it directly.
 */

/** Which kind of model a category holds. */
export type ModelCategoryKind = "text" | "image";

export interface ModelCategory {
    id: string;
    name: string;
    kind: ModelCategoryKind;
    models: string[];
}

export interface ModelOption {
    value: string;
    available: boolean;
}

export interface ModelOptionGroup {
    label: string;
    options: ModelOption[];
}

export const OA_ALL_MODELS_GROUP_LABEL = "All models";

let categoryIdCounter = 0;

/** A fresh id for a new category. */
export function oaNewModelCategoryId(): string {
    categoryIdCounter += 1;
    const random = Math.random().toString(36).slice(2, 8);
    return `cat-${Date.now().toString(36)}-${categoryIdCounter}-${random}`;
}

/** Drops blanks and repeats, and turns a stray number into its text form. */
function oaCleanMembers(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const cleaned: string[] = [];
    for (const member of raw) {
        if (typeof member !== "string" && typeof member !== "number") {
            continue;
        }
        const text = String(member).trim();
        if (!text || cleaned.includes(text)) {
            continue;
        }
        cleaned.push(text);
    }
    return cleaned;
}

/**
 * Turns whatever `data.json` holds into a usable category list.
 *
 * A damaged store must never throw and must never cost the user another
 * setting, so this keeps every entry it can read and drops the rest.
 */
export function oaSanitizeModelCategories(raw: unknown): ModelCategory[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const categories: ModelCategory[] = [];
    const seenIds = new Set<string>();
    for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) {
            continue;
        }
        const record = entry as { id?: unknown; name?: unknown; kind?: unknown; models?: unknown };
        if (typeof record.name !== "string") {
            continue;
        }
        const id = typeof record.id === "string" && record.id ? record.id : oaNewModelCategoryId();
        if (seenIds.has(id)) {
            continue;
        }
        seenIds.add(id);
        const kind: ModelCategoryKind = record.kind === "image" ? "image" : "text";
        categories.push({ id, name: record.name.trim(), kind, models: oaCleanMembers(record.models) });
    }
    return categories;
}

/**
 * The sections a model chooser shows, in paint order.
 *
 * The kind gate comes first, so a category of the other kind never appears in
 * this chooser, whatever the catalog holds. A category of the same kind then
 * appears only when this chooser's own catalog holds at least one of its
 * members. A category never decides whether a model works: only the catalog
 * does. The full list comes last, and is left out when the catalog is empty.
 */
export function oaBuildModelOptionGroups(
    catalog: string[],
    categories: ModelCategory[],
    kind: ModelCategoryKind,
): ModelOptionGroup[] {
    const groups: ModelOptionGroup[] = [];
    for (const category of categories) {
        if (category.kind !== kind) {
            continue;
        }
        if (category.name.trim() === "") {
            continue;
        }
        const members = oaCleanMembers(category.models);
        if (!members.some((member) => catalog.includes(member))) {
            continue;
        }
        groups.push({
            label: category.name,
            options: members.map((value) => ({ value, available: catalog.includes(value) })),
        });
    }
    if (catalog.length > 0) {
        groups.push({
            label: OA_ALL_MODELS_GROUP_LABEL,
            options: catalog.map((value) => ({ value, available: true })),
        });
    }
    return groups;
}

/**
 * Keeps the current value in the list when a fetch dropped it, so a saved
 * choice never silently becomes a different model. The caller injects the
 * rules for its own kind of model.
 */
export function oaCatalogWithCurrent(
    catalog: string[],
    current: string,
    isEligible: (id: string) => boolean,
): string[] {
    const wanted = current.trim();
    if (!wanted || catalog.includes(wanted) || !isEligible(wanted)) {
        return catalog;
    }
    return [wanted, ...catalog];
}
