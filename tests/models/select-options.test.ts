import { describe, expect, it } from "vitest";
import { MockElement } from "../setup";
import { oaPaintModelSelect } from "../../src/models/selectOptions";

function optionsOf(select: MockElement): MockElement[] {
    const out: MockElement[] = [];
    for (const child of select.children) {
        if (child.tagName === "optgroup") out.push(...child.children);
        else out.push(child);
    }
    return out;
}

function groupsOf(select: MockElement): MockElement[] {
    return select.children.filter((child) => child.tagName === "optgroup");
}

describe("oaPaintModelSelect", () => {
    it("puts the pseudo options first, then one section per group", () => {
        const select = new MockElement("select");
        oaPaintModelSelect(
            select as unknown as HTMLSelectElement,
            [
                { label: "Default: gpt-4o-mini", value: "" },
                { label: "my-model", value: "my-model" },
            ],
            [
                { label: "Favourites", options: [{ value: "my-model", available: true }] },
                { label: "All models", options: [{ value: "other", available: true }] },
            ],
        );
        expect(optionsOf(select).map((o) => o.value)).toEqual(["", "my-model", "my-model", "other"]);
        expect(optionsOf(select)[0].textContent).toBe("Default: gpt-4o-mini");
        expect(groupsOf(select).map((g) => g.attrs.label)).toEqual(["Favourites", "All models"]);
        expect(select.children.map((c) => c.tagName)).toEqual(["option", "option", "optgroup", "optgroup"]);
    });

    it("disables an unavailable option and marks it", () => {
        const select = new MockElement("select");
        oaPaintModelSelect(select as unknown as HTMLSelectElement, [], [
            { label: "Favourites", options: [{ value: "gone", available: false }, { value: "here", available: true }] },
        ]);
        const [gone, here] = groupsOf(select)[0].children;
        expect(gone.disabled).toBe(true);
        expect(gone.classList.contains("open-agent-model-option-unavailable")).toBe(true);
        expect(here.disabled).toBe(false);
        expect(here.classList.contains("open-agent-model-option-unavailable")).toBe(false);
    });

    it("clears a previous paint, including a stale section", () => {
        const select = new MockElement("select");
        const stale = select.createEl("optgroup", { attr: { label: "Old" } });
        stale.createEl("option", { text: "old-model" });
        select.createEl("option", { text: "old-pseudo" });
        oaPaintModelSelect(select as unknown as HTMLSelectElement, [{ label: "Default", value: "" }], []);
        expect(select.children.map((c) => c.tagName)).toEqual(["option"]);
        expect(groupsOf(select)).toEqual([]);
    });
});
