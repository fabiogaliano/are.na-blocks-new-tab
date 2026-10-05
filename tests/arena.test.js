import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
    fetchArenaChannel: null,
    fetchArenaChannelContentsPage: null
}));

vi.mock("../extension/scripts/arena-client.js", () => ({
    fetchArenaChannel: (...args) => client.fetchArenaChannel(...args),
    fetchArenaChannelContentsPage: (...args) => client.fetchArenaChannelContentsPage(...args),
    fetchArenaBlock: async () => {
        throw new Error("not expected");
    },
    fetchArenaFeedPage: async () => {
        throw new Error("not expected");
    }
}));

import { fetchChannelAdditions, fetchSourceBlocks, getChannelStamp } from "../extension/scripts/arena.js";

const UPDATED = "2026-10-01T10:00:00.000Z";
const channel = (slug, count = 1) => ({ slug, title: slug.toUpperCase(), updated_at: UPDATED, counts: { contents: count } });
const page = (slug) => ({
    data: [{ id: 1, type: "Image", title: `${slug} image`, image: { src: "https://example.com/a.jpg" } }],
    meta: { total_pages: 1, total_count: 1 }
});

beforeEach(() => {
    client.fetchArenaChannel = vi.fn(async (slug) => channel(slug));
    client.fetchArenaChannelContentsPage = vi.fn(async (slug) => page(slug));
});

describe("getChannelStamp", () => {
    it("reads the update time and contents count", () => {
        expect(getChannelStamp(channel("one", 7))).toEqual({ updatedAt: Date.parse(UPDATED), count: 7 });
    });

    it("leaves fields Are.na did not send unknown", () => {
        expect(getChannelStamp({})).toEqual({ updatedAt: null, count: null });
    });
});

describe("fetchSourceBlocks", () => {
    it("spends no request on a listed channel that has not changed", async () => {
        const onChannelUnchanged = vi.fn();
        const onChannelBlocks = vi.fn();

        await fetchSourceBlocks({
            channelSlugs: ["one"],
            listedChannels: new Map([["one", channel("one", 3)]]),
            isChannelCurrent: () => true,
            onChannelUnchanged,
            onChannelBlocks
        });

        expect(client.fetchArenaChannel).not.toHaveBeenCalled();
        expect(client.fetchArenaChannelContentsPage).not.toHaveBeenCalled();
        expect(onChannelUnchanged).toHaveBeenCalledWith("one", { updatedAt: Date.parse(UPDATED), count: 3 });
        expect(onChannelBlocks).not.toHaveBeenCalled();
    });

    it("spends one request on an unlisted channel that has not changed", async () => {
        const onChannelUnchanged = vi.fn();

        await fetchSourceBlocks({
            channelSlugs: ["one"],
            isChannelCurrent: () => true,
            onChannelUnchanged
        });

        expect(client.fetchArenaChannel).toHaveBeenCalledTimes(1);
        expect(client.fetchArenaChannelContentsPage).not.toHaveBeenCalled();
        expect(onChannelUnchanged).toHaveBeenCalledTimes(1);
    });

    it("downloads a changed listed channel without fetching the channel again", async () => {
        const onChannelBlocks = vi.fn();

        await fetchSourceBlocks({
            channelSlugs: ["one"],
            listedChannels: new Map([["one", channel("one", 3)]]),
            isChannelCurrent: () => false,
            onChannelBlocks
        });

        expect(client.fetchArenaChannel).not.toHaveBeenCalled();
        expect(client.fetchArenaChannelContentsPage).toHaveBeenCalledTimes(1);
        const [slug, blocks, { stamp, startedAt }] = onChannelBlocks.mock.calls[0];
        expect(slug).toBe("one");
        expect(blocks.map((block) => block.sourceChannel)).toEqual([{ title: "ONE", slug: "one" }]);
        expect(stamp).toEqual({ updatedAt: Date.parse(UPDATED), count: 3 });
        expect(Number.isFinite(startedAt)).toBe(true);
    });

    it("skips channels checked within the interval entirely", async () => {
        await fetchSourceBlocks({
            channelSlugs: ["one"],
            freshSlugs: new Set(["one"]),
            isChannelCurrent: () => false
        });

        expect(client.fetchArenaChannel).not.toHaveBeenCalled();
        expect(client.fetchArenaChannelContentsPage).not.toHaveBeenCalled();
    });
});

describe("reading only a channel's additions", () => {
    const SYNCED_AT = Date.UTC(2026, 9, 1, 12, 0, 0);
    const OLD = new Date(SYNCED_AT - 60 * 60 * 1000).toISOString();
    const NEW = new Date(SYNCED_AT + 60 * 60 * 1000).toISOString();

    // A channel of `total` items read in position order; the positions listed in
    // `added` were connected after the last sync, everything else before it.
    const serveChannel = (total, added = []) => {
        const fresh = new Set(added);
        const items = Array.from({ length: total }, (_, index) => ({
            id: index + 1,
            type: "Image",
            title: `item ${index + 1}`,
            image: { src: "https://example.com/a.jpg" },
            connection: { connected_at: fresh.has(index + 1) ? NEW : OLD }
        }));
        client.fetchArenaChannelContentsPage = vi.fn(async (_, { page, per }) => ({
            data: items.slice((page - 1) * per, page * per),
            meta: { total_pages: Math.ceil(total / per), total_count: total }
        }));
    };

    const requestedPages = () => client.fetchArenaChannelContentsPage.mock.calls.map(([, { page }]) => page);

    it("reads one page when the new blocks were appended", async () => {
        serveChannel(600, [599, 600]);

        const result = await fetchChannelAdditions("big", channel("big", 600), { at: SYNCED_AT, count: 598 }, 600);

        expect(result.grows).toBe("tail");
        expect(result.blocks.map((block) => block.id)).toEqual(["599", "600"]);
        expect(requestedPages()).toEqual([6]);
    });

    it("finds blocks added at the top after the end it tried first", async () => {
        serveChannel(600, [1, 2]);

        const result = await fetchChannelAdditions("big", channel("big", 600), { at: SYNCED_AT, count: 598 }, 600);

        expect(result.grows).toBe("head");
        expect(result.blocks.map((block) => block.id)).toEqual(["1", "2"]);
        expect(requestedPages()).toEqual([6, 1]);
    });

    it("tries the end additions were last found at first", async () => {
        serveChannel(600, [1, 2]);

        await fetchChannelAdditions("big", channel("big", 600), { at: SYNCED_AT, count: 598, grows: "head" }, 600);

        expect(requestedPages()).toEqual([1]);
    });

    it("gives up when an old block is missing next to the new ones", async () => {
        serveChannel(600, [598, 599, 600]);

        const result = await fetchChannelAdditions("big", channel("big", 600), { at: SYNCED_AT, count: 598 }, 600);

        expect(result).toBeNull();
    });

    it("does not probe a channel a single page covers", async () => {
        serveChannel(80, [80]);

        const result = await fetchChannelAdditions("small", channel("small", 80), { at: SYNCED_AT, count: 79 }, 80);

        expect(result).toBeNull();
        expect(client.fetchArenaChannelContentsPage).not.toHaveBeenCalled();
    });

    it("falls back to a full read that reuses the pages the probe fetched", async () => {
        serveChannel(600, [300]);
        const onChannelBlocks = vi.fn();
        const onChannelExtended = vi.fn();

        await fetchSourceBlocks({
            channelSlugs: ["big"],
            listedChannels: new Map([["big", channel("big", 600)]]),
            getSyncBase: () => ({ at: SYNCED_AT, count: 599 }),
            onChannelBlocks,
            onChannelExtended
        });

        expect(onChannelExtended).not.toHaveBeenCalled();
        expect(onChannelBlocks.mock.calls[0][1]).toHaveLength(600);
        expect(requestedPages().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("hands appended blocks to the caller without a full read", async () => {
        serveChannel(600, [600]);
        const onChannelBlocks = vi.fn();
        const onChannelExtended = vi.fn();

        await fetchSourceBlocks({
            channelSlugs: ["big"],
            listedChannels: new Map([["big", channel("big", 600)]]),
            getSyncBase: () => ({ at: SYNCED_AT, count: 599 }),
            onChannelBlocks,
            onChannelExtended
        });

        expect(onChannelBlocks).not.toHaveBeenCalled();
        const [slug, blocks, { grows }] = onChannelExtended.mock.calls[0];
        expect(slug).toBe("big");
        expect(blocks.map((block) => block.id)).toEqual(["600"]);
        expect(grows).toBe("tail");
        expect(requestedPages()).toEqual([6]);
    });
});
