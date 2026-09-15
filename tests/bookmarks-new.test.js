import { describe, expect, it } from "vitest";
import { computeNewIds } from "../extension/scripts/bookmarks-model.js";
import { markReadState, pruneNewIds, synchronizeNewMarkers } from "../extension/scripts/bookmarks-state.js";

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
        expect(state).toEqual({ lastViewedAt: 500, newIds: [] });
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
