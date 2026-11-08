import { describe, expect, it } from "vitest";
import {
    OA_ALL_MODELS_GROUP_LABEL,
    oaBuildModelOptionGroups,
    oaCatalogWithCurrent,
    oaNewModelCategoryId,
    oaSanitizeModelCategories,
    type ModelCategory,
} from "../../src/models/categories";

describe("oaBuildModelOptionGroups", () => {
    it("puts each category in stored order above the full list", () => {
        const categories: ModelCategory[] = [
            { id: "c1", name: "Favourites", kind: "text", models: ["b", "a"] },
            { id: "c2", name: "Local", kind: "text", models: ["c"] },
        ];
        const groups = oaBuildModelOptionGroups(["a", "b", "c"], categories, "text");
        expect(groups.map((g) => g.label)).toEqual(["Favourites", "Local", OA_ALL_MODELS_GROUP_LABEL]);
        expect(groups[0].options).toEqual([
            { value: "b", available: true },
            { value: "a", available: true },
        ]);
        expect(groups[2].options).toEqual([
            { value: "a", available: true },
            { value: "b", available: true },
            { value: "c", available: true },
        ]);
    });

    it("marks a member the catalog does not have as unavailable and keeps it", () => {
        const groups = oaBuildModelOptionGroups(
            ["a"],
            [{ id: "c1", name: "Mixed", kind: "text", models: ["a", "gone"] }],
            "text",
        );
        expect(groups[0].options).toEqual([
            { value: "a", available: true },
            { value: "gone", available: false },
        ]);
    });

    it("skips a category with no available member in this catalog", () => {
        const groups = oaBuildModelOptionGroups(
            ["a"],
            [
                { id: "c1", name: "Empty", kind: "text", models: [] },
                { id: "c2", name: "Names", kind: "text", models: ["   "] },
                { id: "c3", name: "   ", kind: "text", models: ["a"] },
                { id: "c4", name: "Elsewhere", kind: "text", models: ["gone"] },
            ],
            "text",
        );
        expect(groups.map((g) => g.label)).toEqual([OA_ALL_MODELS_GROUP_LABEL]);
    });

    it("emits nothing for an empty catalog", () => {
        expect(
            oaBuildModelOptionGroups([], [{ id: "c1", name: "Old", kind: "text", models: ["gone"] }], "text"),
        ).toEqual([]);
        expect(oaBuildModelOptionGroups([], [], "text")).toEqual([]);
    });

    it("keeps a current value the catalog dropped", () => {
        expect(oaCatalogWithCurrent(["a"], "old", () => true)).toEqual(["old", "a"]);
    });

    it("leaves the catalog alone when it already holds the current value", () => {
        expect(oaCatalogWithCurrent(["a", "b"], "a", () => true)).toEqual(["a", "b"]);
    });

    it("drops a current value the catalog dropped and the kind rejects", () => {
        expect(oaCatalogWithCurrent(["a"], "old", () => false)).toEqual(["a"]);
        expect(oaCatalogWithCurrent(["a"], "", () => true)).toEqual(["a"]);
    });

    it("de-duplicates a repeated member and drops blanks", () => {
        const groups = oaBuildModelOptionGroups(
            ["a"],
            [{ id: "c1", name: "Dup", kind: "text", models: ["a", "a", "", "a"] }],
            "text",
        );
        expect(groups[0].options).toEqual([{ value: "a", available: true }]);
    });

    it("does not mutate its inputs", () => {
        const categories: ModelCategory[] = [{ id: "c1", name: "C", kind: "text", models: ["a"] }];
        const catalog = ["a"];
        oaBuildModelOptionGroups(catalog, categories, "text");
        expect(categories).toEqual([{ id: "c1", name: "C", kind: "text", models: ["a"] }]);
        expect(catalog).toEqual(["a"]);
    });
});

describe("oaSanitizeModelCategories", () => {
    it("returns an empty list for every damaged shape", () => {
        for (const raw of [undefined, null, "x", 42, {}, [], [1, "a", null]]) {
            expect(oaSanitizeModelCategories(raw)).toEqual([]);
        }
    });

    it("keeps good entries, repairs a missing id, and cleans members", () => {
        const result = oaSanitizeModelCategories([
            { id: "c1", name: "Keep", models: ["a", 2, "", "a"] },
            { name: "No id", models: ["b"] },
            { id: "c3", name: 7, models: ["b"] },
            { id: "c4", name: "No models" },
            { id: "c5", name: "Bad models", models: "b" },
        ]);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ id: "c1", name: "Keep", kind: "text", models: ["a", "2"] });
        expect(result[1].name).toBe("No id");
        expect(result[1].id.length).toBeGreaterThan(0);
        expect(result[1].models).toEqual(["b"]);
    });

    it("keeps an empty name, so a new category survives a reload", () => {
        expect(oaSanitizeModelCategories([{ id: "c1", name: "", models: [] }])).toEqual([
            { id: "c1", name: "", kind: "text", models: [] },
        ]);
    });

    it("gives a category with no kind the text kind", () => {
        const result = oaSanitizeModelCategories([{ id: "a", name: "A", models: ["m"] }]);
        expect(result[0].kind).toBe("text");
    });

    it("keeps a known kind", () => {
        const result = oaSanitizeModelCategories([{ id: "a", name: "A", kind: "image", models: ["m"] }]);
        expect(result[0].kind).toBe("image");
    });

    it("gives an unknown kind the text kind, and keeps the entry", () => {
        const result = oaSanitizeModelCategories([{ id: "a", name: "A", kind: "audio", models: ["m"] }]);
        expect(result[0].kind).toBe("text");
        expect(result[0].models).toEqual(["m"]);
    });
});

describe("oaBuildModelOptionGroups and the kind", () => {
    const catalog = ["m-both", "m-text", "m-image"];

    it("shows a text category in a text chooser", () => {
        const groups = oaBuildModelOptionGroups(
            catalog,
            [{ id: "a", name: "Text picks", kind: "text", models: ["m-both"] }],
            "text",
        );
        expect(groups.map((group) => group.label)).toEqual(["Text picks", OA_ALL_MODELS_GROUP_LABEL]);
    });

    it("hides a text category in an image chooser", () => {
        const groups = oaBuildModelOptionGroups(
            catalog,
            [{ id: "a", name: "Text picks", kind: "text", models: ["m-both"] }],
            "image",
        );
        expect(groups.map((group) => group.label)).toEqual([OA_ALL_MODELS_GROUP_LABEL]);
    });

    it("hides an image category in a text chooser even when the text catalog holds its member", () => {
        const groups = oaBuildModelOptionGroups(
            catalog,
            [{ id: "a", name: "Image picks", kind: "image", models: ["m-both"] }],
            "text",
        );
        expect(groups.map((group) => group.label)).toEqual([OA_ALL_MODELS_GROUP_LABEL]);
    });

    it("keeps the All models group last across kinds", () => {
        const groups = oaBuildModelOptionGroups(
            catalog,
            [
                { id: "a", name: "Image picks", kind: "image", models: ["m-image"] },
                { id: "b", name: "Text picks", kind: "text", models: ["m-text"] },
            ],
            "text",
        );
        expect(groups.map((group) => group.label)).toEqual(["Text picks", OA_ALL_MODELS_GROUP_LABEL]);
    });
});

describe("oaNewModelCategoryId", () => {
    it("returns a fresh non-empty id each call", () => {
        const first = oaNewModelCategoryId();
        expect(first.length).toBeGreaterThan(0);
        expect(oaNewModelCategoryId()).not.toBe(first);
    });
});
