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

import { fetchSourceBlocks, getChannelStamp } from "../extension/scripts/arena.js";

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
