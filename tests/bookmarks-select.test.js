import { describe, expect, it } from "vitest";
import { computeMarquee, hitTest, pruneSelection, toggle } from "../extension/scripts/bookmarks-select.js";

const rects = [
    { id: "a", left: 0, top: 0, right: 10, bottom: 10 },
    { id: "b", left: 10, top: 10, right: 20, bottom: 20 },
    { id: "zero", left: 5, top: 5, right: 5, bottom: 5 }
];

describe("bookmark selection", () => {
    it("hits positive intersections but excludes touching edges and zero-area rows", () => {
        expect(hitTest(rects, { left: 9, top: 9, right: 11, bottom: 11 })).toEqual(["a", "b"]);
        expect(hitTest(rects, { left: 20, top: 0, right: 30, bottom: 10 })).toEqual([]);
        expect(hitTest(rects, { left: 0, top: 0, right: 0, bottom: 10 })).toEqual([]);
        expect(hitTest(rects, { left: 4, top: 4, right: 6, bottom: 6 })).toEqual(["a"]);
    });

    it("replaces or adds marquee hits", () => {
        expect([...computeMarquee(new Set(["a"]), ["b"])]).toEqual(["b"]);
        expect([...computeMarquee(new Set(["a"]), ["b"], { additive: true })]).toEqual(["a", "b"]);
    });

    it("toggles without mutating the source", () => {
        const source = new Set(["a"]);
        expect([...toggle(source, "a")]).toEqual([]);
        expect([...toggle(source, "b")]).toEqual(["a", "b"]);
        expect([...source]).toEqual(["a"]);
    });

    it("prunes a selection against live ids", () => {
        expect([...pruneSelection(new Set(["a", "gone", "b"]), ["b", "a"])]).toEqual(["a", "b"]);
    });
});
