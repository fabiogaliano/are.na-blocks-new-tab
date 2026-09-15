import { describe, expect, it } from "vitest";
import { computeNewIds } from "../extension/scripts/bookmarks-model.js";
import { markOpenedState, markReadState, pruneNewIds, pruneOpenedAt, seedOpenedAt, synchronizeNewMarkers } from "../extension/scripts/bookmarks-state.js";

const links = [
    { id: "before", dateAdded: 99 },
    { id: "equal", dateAdded: 100 },
    { id: "after", dateAdded: 101 }
];

function memoryStorage(initial) {
    const data = initial ? { bookmarkState: initial } : {};
    return {
        data,
        async get(key) { return { [key]: data[key] }; },
        async set(value) { Object.assign(data, value); }
    };
}

describe("new bookmark markers", () => {
    it("uses a strict dateAdded boundary", () => {
        expect(computeNewIds({ links, lastViewedAt: 100 })).toEqual(["after"]);
    });

    it("seeds first run without marking existing links", async () => {
        const storage = memoryStorage();
        const state = await synchronizeNewMarkers(links, storage, 500);
        expect(state).toEqual({ lastViewedAt: 500, newIds: [], openedAt: {} });
    });

    it("keeps unread ids after lastViewedAt advances", () => {
        expect(computeNewIds({ links, lastViewedAt: 200, knownNewIds: ["after"] })).toEqual(["after"]);
    });

    it("prunes deleted ids", () => {
        expect(pruneNewIds(["after", "gone"], links)).toEqual(["after"]);
    });

    it("marks one or many ids read idempotently", () => {
        const state = { lastViewedAt: 100, newIds: ["before", "after"] };
        expect(markReadState(state, "after").newIds).toEqual(["before"]);
        expect(markReadState(markReadState(state, "after"), "after").newIds).toEqual(["before"]);
        expect(markReadState(state, ["before", "after"]).newIds).toEqual([]);
    });
});

describe("per-link open timestamps", () => {
    it("stamps every opened url", () => {
        const state = markOpenedState({ lastViewedAt: 0, newIds: [], openedAt: {} }, ["a", "b"], 900);
        expect(state.openedAt).toEqual({ a: 900, b: 900 });
    });

    it("overwrites an earlier open so only the latest visit counts", () => {
        const first = markOpenedState({ lastViewedAt: 0, newIds: [], openedAt: {} }, ["a"], 100);
        expect(markOpenedState(first, ["a"], 400).openedAt).toEqual({ a: 400 });
    });

    it("accepts a single url", () => {
        expect(markOpenedState({ lastViewedAt: 0, newIds: [], openedAt: {} }, "a", 1).openedAt).toEqual({ a: 1 });
    });

    it("drops timestamps for links that no longer exist", () => {
        expect(pruneOpenedAt({ a: 1, b: 2 }, [{ url: "b" }])).toEqual({ b: 2 });
    });

    it("seeds unseen links so a first run counts no backlog", () => {
        expect(seedOpenedAt({}, [{ url: "a" }, { url: "b" }], 700)).toEqual({ a: 700, b: 700 });
    });

    it("leaves an already recorded visit alone", () => {
        expect(seedOpenedAt({ a: 100 }, [{ url: "a" }, { url: "b" }], 700)).toEqual({ a: 100, b: 700 });
    });
});
