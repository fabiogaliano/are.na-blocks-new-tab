import { describe, expect, it } from "vitest";
import { columnDescriptor, countFresh, nodeAtDepth, windowStart } from "../extension/scripts/bookmarks-columns.js";

const leaf = (path, title, count) => ({ path, title, count, links: Array.from({ length: count }, (_, i) => ({ id: `${path}-${i}` })), children: [] });
const branch = (path, title, children) => ({
    path, title, children, links: [],
    count: children.reduce((total, child) => total + child.count, 0)
});

const nodes = [
    branch("shopping", "shopping", [
        branch("shopping/fashion", "fashion", [
            branch("shopping/fashion/clothing", "clothing", [leaf("shopping/fashion/clothing/high fashion", "high fashion", 8)])
        ]),
        leaf("shopping/house", "house", 7)
    ]),
    leaf("film", "film", 5)
];

describe("column browser", () => {
    it("keeps the window at three columns however deep the path goes", () => {
        expect(windowStart([])).toBe(0);
        expect(windowStart(["shopping"])).toBe(0);
        expect(windowStart(["shopping", "shopping/fashion"])).toBe(0);
        expect(windowStart(["shopping", "shopping/fashion", "shopping/fashion/clothing"])).toBe(1);
        expect(windowStart(["a", "b", "c", "d"])).toBe(2);
    });

    it("walks to a node at a given depth and returns null past the end", () => {
        expect(nodeAtDepth(nodes, ["shopping"], 1).title).toBe("shopping");
        expect(nodeAtDepth(nodes, ["shopping", "shopping/fashion"], 2).title).toBe("fashion");
        expect(nodeAtDepth(nodes, ["shopping", "nope"], 2)).toBeNull();
        expect(nodeAtDepth(nodes, [], 0).children).toBe(nodes);
    });

    it("describes folder columns with the current selection", () => {
        const descriptor = columnDescriptor(nodes, ["shopping"], 0);
        expect(descriptor.type).toBe("items");
        expect(descriptor.selected).toBe("shopping");
        expect(descriptor.items.map((node) => node.title)).toEqual(["shopping", "film"]);
    });

    it("describes a childless folder as a link column", () => {
        const descriptor = columnDescriptor(nodes, ["film"], 1);
        expect(descriptor.type).toBe("links");
        expect(descriptor.links).toHaveLength(5);
    });

    it("sums unread posts through the whole subtree", () => {
        const counts = {
            "shopping/fashion/clothing/high fashion-0": 3,
            "shopping/fashion/clothing/high fashion-1": 1,
            "film-2": 5
        };
        const freshFor = (link) => counts[link.id] || 0;
        expect(countFresh(nodes[0], freshFor)).toBe(4);
        expect(countFresh(nodes[1], freshFor)).toBe(5);
        expect(countFresh(nodes[0].children[1], freshFor)).toBe(0);
    });

    it("counts nothing without a counter", () => {
        expect(countFresh(nodes[0], () => 0)).toBe(0);
        expect(countFresh(nodes[0], undefined)).toBe(0);
    });

    it("returns null for a column beyond the selected path", () => {
        expect(columnDescriptor(nodes, ["film"], 2)).toBeNull();
    });
});
