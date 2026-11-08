import type { ModelOptionGroup } from "./categories";

export interface ModelSelectPseudoOption {
    label: string;
    value: string;
}

/**
 * Repaints a model chooser: the caller's own pseudo options first, then one
 * section per group, then the full list the caller passed as the last group.
 *
 * A stored member the catalog missed is drawn disabled and struck through, so
 * the user can see that the choice is stale without losing it. The caller sets
 * the select's own value afterwards.
 */
export function oaPaintModelSelect(
    select: HTMLSelectElement,
    pseudo: ModelSelectPseudoOption[],
    groups: ModelOptionGroup[],
): void {
    select.empty();
    for (const entry of pseudo) {
        const option = select.createEl("option", { text: entry.label });
        option.value = entry.value;
    }
    for (const group of groups) {
        const section = select.createEl("optgroup", { attr: { label: group.label } });
        for (const entry of group.options) {
            const option = section.createEl("option", { text: entry.value });
            option.value = entry.value;
            if (!entry.available) {
                option.disabled = true;
                option.addClass("open-agent-model-option-unavailable");
            }
        }
    }
}
