import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
    data: new Map(),
    sendMessage: null,
    fetchSourceBlocks: null
}));

vi.mock("../extension/scripts/extension-api.js", () => ({
    storage: {
        get: async (keys) => {
            const list = keys == null ? [...env.data.keys()] : [].concat(keys);
            return Object.fromEntries(
                list.filter((key) => env.data.has(key)).map((key) => [key, structuredClone(env.data.get(key))])
            );
        },
        set: async (items) => {
            Object.entries(items).forEach(([key, value]) => env.data.set(key, structuredClone(value)));
        },
        remove: async (keys) => {
            [].concat(keys).forEach((key) => env.data.delete(key));
        },
        clear: async () => env.data.clear(),
        onChanged: null
    },
    runtime: {
        sendMessage: (...args) => env.sendMessage(...args)
    },
    alarms: null
}));

vi.mock("../extension/scripts/block-store.js", () => ({
    putBlocks: async () => {},
    retainBlocks: async () => {},
    clearBlocks: async () => {}
}));

vi.mock("../extension/scripts/arena.js", () => ({
    fetchSourceBlocks: (...args) => env.fetchSourceBlocks(...args)
}));

import { CACHE_VERSION, STORAGE_KEYS } from "../extension/scripts/constants.js";
import { canonicalizeSettings } from "../extension/scripts/settings-model.js";
import { cacheLifecycle, runtimeCacheLifecycle } from "../extension/scripts/cache-refresh.js";

const MINUTE = 60 * 1000;

const seedCache = (channelFetchedAt) => {
    const slugs = Object.keys(channelFetchedAt);
    const settings = canonicalizeSettings({ channelSlugs: [], accountChannelSlugs: slugs });
    env.data.set(STORAGE_KEYS.settings, settings);
    env.data.set(STORAGE_KEYS.cache, {
        version: CACHE_VERSION,
        completedAt: Date.now() - 10 * MINUTE,
        blockIds: slugs,
        channelBlockIds: Object.fromEntries(slugs.map((slug) => [slug, [slug]])),
        channelFetchedAt,
        standaloneBlockIds: [],
        sources: {
            channels: slugs,
            manualChannels: [],
            accountChannels: slugs,
            feed: false,
            blockIds: [],
            filters: settings.filters
        }
    });
};

const fetchUnlessFresh = () => vi.fn(async ({ channelSlugs, freshSlugs, onChannelBlocks }) => {
    for (const slug of channelSlugs) {
        if (!freshSlugs?.has(slug)) {
            await onChannelBlocks(slug, [{ id: `${slug}-new`, kind: "Image" }]);
        }
    }
    return { standaloneBlocks: [] };
});

beforeEach(() => {
    env.data.clear();
    env.sendMessage = vi.fn();
    env.fetchSourceBlocks = fetchUnlessFresh();
});

describe("forced refresh", () => {
    it("keeps channels fetched after it was asked for", async () => {
        const requestedAt = Date.now() - 1000;
        seedCache({ before: requestedAt - 10 * MINUTE, after: requestedAt + 500 });

        await cacheLifecycle.refresh({ force: true, requestedAt });

        const { freshSlugs } = env.fetchSourceBlocks.mock.calls[0][0];
        expect([...freshSlugs]).toEqual(["after"]);
    });

    it("refetches every channel when nothing is newer than the request", async () => {
        const requestedAt = Date.now() - 1000;
        seedCache({ one: requestedAt - 1, two: requestedAt - 5 * MINUTE });

        await cacheLifecycle.refresh({ force: true, requestedAt });

        expect([...env.fetchSourceBlocks.mock.calls[0][0].freshSlugs]).toEqual([]);
        expect(Object.keys(env.data.get(STORAGE_KEYS.cache).channelFetchedAt).sort()).toEqual(["one", "two"]);
    });
});

describe("refresh through the worker", () => {
    it("asks again when the worker was torn down mid-reply", async () => {
        seedCache({ one: Date.now() - 10 * MINUTE });
        env.sendMessage
            .mockRejectedValueOnce(new Error("The message port closed before a response was received."))
            .mockResolvedValueOnce({ ok: true, summary: { cacheVersion: CACHE_VERSION, blockCount: 1, completedAt: 1 } });

        await runtimeCacheLifecycle.refresh({ force: true });

        expect(env.sendMessage).toHaveBeenCalledTimes(2);
        expect(env.fetchSourceBlocks).not.toHaveBeenCalled();
    });
});
