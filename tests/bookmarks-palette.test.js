import { describe, expect, it } from "vitest";
import { filterLinks } from "../extension/scripts/bookmarks-palette.js";

const links = [
    { id: "1", title: "Fluid Type Scale", host: "typography.test", path: "design/typography" },
    { id: "2", title: "Icon Library", host: "icons.example", path: "design/icons" },
    { id: "3", title: "Server Guide", host: "infra.example", path: "dev/infra" }
];

describe("bookmark palette filtering", () => {
    it("ANDs case-insensitive query terms across title and host", () => {
        expect(filterLinks(links, { query: "FLUID typography" }).map((link) => link.id)).toEqual(["1"]);
        expect(filterLinks(links, { query: "icon example" }).map((link) => link.id)).toEqual(["2"]);
        expect(filterLinks(links, { query: "fluid missing" })).toEqual([]);
    });

    it("scopes a card path to descendants and a group path exactly", () => {
        expect(filterLinks(links, { folder: "design" }).map((link) => link.id)).toEqual(["1", "2"]);
        expect(filterLinks(links, { folder: "design/icons" }).map((link) => link.id)).toEqual(["2"]);
    });

    it("keeps only new ids", () => {
        expect(filterLinks(links, { filter: "new", newIds: ["3"] }).map((link) => link.id)).toEqual(["3"]);
    });

    it("returns every visible link for an empty query", () => {
        expect(filterLinks(links, {}).map((link) => link.id)).toEqual(["1", "2", "3"]);
    });
});
