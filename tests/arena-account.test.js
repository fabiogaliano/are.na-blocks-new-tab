import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
    owned: [],
    followed: []
}));

vi.mock("../extension/scripts/arena-client.js", () => ({
    fetchArenaMe: async () => {
        throw new Error("not expected");
    },
    fetchArenaUserContentsPage: vi.fn(async (_, { page, per }) => ({
        data: client.owned.slice((page - 1) * per, page * per)
    })),
    fetchArenaUserFollowingPage: vi.fn(async (_, { page, per }) => ({
        data: client.followed.slice((page - 1) * per, page * per)
    }))
}));

import { fetchArenaUserContentsPage, fetchArenaUserFollowingPage } from "../extension/scripts/arena-client.js";
import { fetchAccountChannelIndex, isCatalogCurrent } from "../extension/scripts/arena-account.js";

const channels = (prefix, count) => Array.from({ length: count }, (_, index) => ({
    type: "Channel",
    slug: `${prefix}-${index}`,
    updated_at: "2026-10-01T10:00:00.000Z"
}));

const AUTH = { token: "token", user: { slug: "me" } };

beforeEach(() => {
    client.owned = [];
    client.followed = [];
    vi.clearAllMocks();
});

describe("fetchAccountChannelIndex", () => {
    it("asks nothing when no account channel is due", async () => {
        const index = await fetchAccountChannelIndex({ ...AUTH, wanted: [] });

        expect(index.size).toBe(0);
        expect(fetchArenaUserContentsPage).not.toHaveBeenCalled();
    });

    it("stops at the owned list once every wanted channel is in it", async () => {
        client.owned = channels("own", 3);

        const index = await fetchAccountChannelIndex({ ...AUTH, wanted: ["own-0", "own-2"] });

        expect([...index.keys()]).toEqual(["own-0", "own-2"]);
        expect(fetchArenaUserContentsPage).toHaveBeenCalledTimes(1);
        expect(fetchArenaUserFollowingPage).not.toHaveBeenCalled();
    });

    it("pages through full lists and falls through to followed channels", async () => {
        client.owned = channels("own", 150);
        client.followed = channels("follow", 2);

        const index = await fetchAccountChannelIndex({ ...AUTH, wanted: ["own-120", "follow-1", "gone"] });

        expect([...index.keys()].sort()).toEqual(["follow-1", "own-120"]);
        expect(fetchArenaUserContentsPage).toHaveBeenCalledTimes(2);
        expect(fetchArenaUserFollowingPage).toHaveBeenCalledTimes(1);
    });

    it("asks nothing without a connected account", async () => {
        const index = await fetchAccountChannelIndex({ token: "", user: null, wanted: ["one"] });

        expect(index.size).toBe(0);
        expect(fetchArenaUserContentsPage).not.toHaveBeenCalled();
    });
});

describe("isCatalogCurrent", () => {
    const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
    const HOUR = 60 * 60 * 1000;

    it("reuses a catalog loaded for the same account within a day", () => {
        expect(isCatalogCurrent({ userSlug: "me", fetchedAt: NOW - 23 * HOUR }, { slug: "me" }, NOW)).toBe(true);
    });

    it("reloads a catalog that is a day old or belongs to another account", () => {
        expect(isCatalogCurrent({ userSlug: "me", fetchedAt: NOW - 25 * HOUR }, { slug: "me" }, NOW)).toBe(false);
        expect(isCatalogCurrent({ userSlug: "other", fetchedAt: NOW }, { slug: "me" }, NOW)).toBe(false);
        expect(isCatalogCurrent(null, { slug: "me" }, NOW)).toBe(false);
    });
});
