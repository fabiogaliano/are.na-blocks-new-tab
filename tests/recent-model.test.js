import { describe, expect, it } from "vitest";
import {
    RECENT_LIMIT,
    SOFT_AVOID_RATIO,
    softAvoidIds,
    bucketRecent,
    groupRecent,
    normalizeRecent,
    pruneRecent,
    recordRecent
} from "../extension/scripts/recent-model.js";

const NOW = new Date(2026, 8, 15, 12, 0, 0).getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe("recordRecent", () => {
    it("puts the blocks just drawn at the front, newest first", () => {
        const entries = recordRecent([{ id: "1", at: NOW - HOUR }], ["7", "8"], NOW);
        expect(entries.map((entry) => entry.id)).toEqual(["7", "8", "1"]);
        expect(entries[0].at).toBe(NOW);
    });

    it("moves a redrawn block back to the front instead of listing it twice", () => {
        const entries = recordRecent(
            [{ id: "1", at: NOW - HOUR }, { id: "2", at: NOW - 2 * HOUR }],
            ["2"],
            NOW
        );
        expect(entries.map((entry) => entry.id)).toEqual(["2", "1"]);
        expect(entries[0].at).toBe(NOW);
    });

    it("accepts numeric ids and stores them as strings", () => {
        expect(recordRecent([], [42], NOW)).toEqual([{ id: "42", at: NOW }]);
    });

    it("keeps one entry when the same block is drawn twice in one tab", () => {
        expect(recordRecent([], ["5", "5"], NOW)).toEqual([{ id: "5", at: NOW }]);
    });

    it("leaves the buffer alone when nothing was drawn", () => {
        const entries = [{ id: "1", at: NOW }];
        expect(recordRecent(entries, [], NOW)).toEqual(entries);
    });

    it("drops the oldest entries past the limit", () => {
        const full = Array.from({ length: RECENT_LIMIT }, (_, index) => ({ id: `${index}`, at: NOW - index }));
        const entries = recordRecent(full, ["new"], NOW);
        expect(entries).toHaveLength(RECENT_LIMIT);
        expect(entries[0].id).toBe("new");
        expect(entries.some((entry) => entry.id === `${RECENT_LIMIT - 1}`)).toBe(false);
    });
});

describe("normalizeRecent", () => {
    it("discards junk rather than rendering it", () => {
        expect(normalizeRecent([{ id: "1", at: NOW }, null, { at: NOW }, { id: "1", at: NOW - 5 }]))
            .toEqual([{ id: "1", at: NOW }]);
    });

    it("treats an unreadable timestamp as unknown", () => {
        expect(normalizeRecent([{ id: "1", at: "soon" }])).toEqual([{ id: "1", at: 0 }]);
    });

    it("survives a missing or malformed buffer", () => {
        expect(normalizeRecent(undefined)).toEqual([]);
        expect(normalizeRecent("nope")).toEqual([]);
    });
});

describe("pruneRecent", () => {
    it("keeps only ids the block store still holds", () => {
        const entries = [{ id: "1", at: NOW }, { id: "2", at: NOW }, { id: "3", at: NOW }];
        expect(pruneRecent(entries, ["3", "1"]).map((entry) => entry.id)).toEqual(["1", "3"]);
    });
});

describe("bucketRecent", () => {
    it("groups by how the time reads, not by fixed slices", () => {
        expect(bucketRecent(NOW - 30 * 1000, NOW)).toBe("just now");
        expect(bucketRecent(NOW - 20 * MINUTE, NOW)).toBe("last hour");
        expect(bucketRecent(NOW - 5 * HOUR, NOW)).toBe("earlier today");
    });

    it("counts calendar days, so 90 minutes before midnight is yesterday", () => {
        const justAfterMidnight = new Date(2026, 8, 15, 0, 30, 0).getTime();
        expect(bucketRecent(justAfterMidnight - 2 * HOUR, justAfterMidnight)).toBe("yesterday");
    });

    it("falls back to older for undated entries", () => {
        expect(bucketRecent(0, NOW)).toBe("older");
        expect(bucketRecent(NOW - 3 * 24 * HOUR, NOW)).toBe("older");
    });
});

describe("groupRecent", () => {
    it("keeps newest-first order and makes one group per tab draw", () => {
        const groups = groupRecent([
            { id: "1", at: NOW - 10 * 1000 },
            { id: "2", at: NOW - 30 * MINUTE },
            { id: "3", at: NOW - 30 * MINUTE },
            { id: "4", at: NOW - 40 * MINUTE },
            { id: "5", at: NOW - 6 * HOUR }
        ], NOW);
        expect(groups.map((group) => group.label))
            .toEqual(["just now", "last hour", "last hour", "earlier today"]);
        expect(groups.map((group) => group.entries.map((entry) => entry.id)))
            .toEqual([["1"], ["2", "3"], ["4"], ["5"]]);
    });

    it("carries the draw time, so a group can be told from its neighbours", () => {
        const groups = groupRecent([{ id: "1", at: NOW }, { id: "2", at: NOW }], NOW);
        expect(groups).toHaveLength(1);
        expect(groups[0].at).toBe(NOW);
    });
});

describe("softAvoidIds", () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({ id: `${index}`, at: NOW - index }));

    it("avoids at most half the pool, newest first", () => {
        const avoided = softAvoidIds(entries, 60, 1);
        expect(avoided).toHaveLength(Math.floor(60 * SOFT_AVOID_RATIO));
        expect(avoided[0]).toBe("0");
    });

    it("never avoids more than the buffer holds", () => {
        expect(softAvoidIds(entries, 400, 1)).toHaveLength(entries.length);
    });

    it("always leaves enough blocks to fill the tab", () => {
        expect(softAvoidIds(entries, 6, 4)).toHaveLength(2);
        expect(softAvoidIds(entries, 5, 5)).toEqual([]);
    });

    it("avoids nothing when the pool is tiny, so the tab still draws", () => {
        expect(softAvoidIds(entries, 1, 1)).toEqual([]);
        expect(softAvoidIds(entries, 0, 1)).toEqual([]);
    });

    it("survives an empty buffer", () => {
        expect(softAvoidIds([], 100, 1)).toEqual([]);
    });
});
