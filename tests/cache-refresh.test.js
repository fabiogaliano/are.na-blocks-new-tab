import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
    data: new Map(),
    stamps: {},
    sendMessage: null,
    fetchSourceBlocks: null,
    fetchAccountChannelIndex: null
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

vi.mock("../extension/scripts/arena-account.js", () => ({
    fetchAccountChannelIndex: (...args) => env.fetchAccountChannelIndex(...args)
}));

import { CACHE_VERSION, STORAGE_KEYS } from "../extension/scripts/constants.js";
import { canonicalizeSettings } from "../extension/scripts/settings-model.js";
import { cacheLifecycle, runtimeCacheLifecycle } from "../extension/scripts/cache-refresh.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const seedCache = ({
    channelFetchedAt,
    channelDownloads,
    filters = null,
    settings: settingsOverrides = {},
    sources = {},
    standaloneFetchedAt
}) => {
    const slugs = Object.keys(channelFetchedAt);
    const settings = canonicalizeSettings({ channelSlugs: [], accountChannelSlugs: slugs, ...settingsOverrides });
    env.data.set(STORAGE_KEYS.settings, settings);
    env.data.set(STORAGE_KEYS.cache, {
        version: CACHE_VERSION,
        completedAt: Date.now() - 2 * DAY,
        blockIds: slugs,
        channelBlockIds: Object.fromEntries(slugs.map((slug) => [slug, [slug]])),
        channelFetchedAt,
        ...(channelDownloads ? { channelDownloads } : {}),
        standaloneBlockIds: [],
        ...(standaloneFetchedAt ? { standaloneFetchedAt } : {}),
        sources: {
            channels: slugs,
            manualChannels: [],
            accountChannels: slugs,
            feed: false,
            blockIds: [],
            filters: filters || settings.filters,
            ...sources
        }
    });
};

const storedCache = () => env.data.get(STORAGE_KEYS.cache);

// Stands in for the real loop in arena.js: what it decides per channel is under
// test there, and here only the policy this module hands it.
const emulateSourceFetch = () => vi.fn(async ({ channelSlugs, freshSlugs, isChannelCurrent, onChannelBlocks, onChannelUnchanged }) => {
    for (const slug of channelSlugs) {
        if (freshSlugs?.has(slug)) {
            continue;
        }
        const stamp = env.stamps[slug] || { updatedAt: null, count: null };
        if (isChannelCurrent(slug, stamp)) {
            await onChannelUnchanged(slug, stamp);
            continue;
        }
        await onChannelBlocks(slug, [{ id: `${slug}-new`, kind: "Image" }], { stamp, startedAt: Date.now() });
    }
    return { standaloneBlocks: [] };
});

const downloadedSlugs = () => storedCache().blockIds.filter((id) => id.endsWith("-new")).map((id) => id.slice(0, -4));

beforeEach(() => {
    env.data.clear();
    env.stamps = {};
    env.sendMessage = vi.fn();
    env.fetchSourceBlocks = emulateSourceFetch();
    env.fetchAccountChannelIndex = vi.fn(async () => new Map());
});

describe("forced refresh", () => {
    it("leaves channels checked after it was asked for alone", async () => {
        const requestedAt = Date.now() - 1000;
        seedCache({ channelFetchedAt: { before: requestedAt - 10 * MINUTE, after: requestedAt + 500 } });

        await cacheLifecycle.refresh({ force: true, requestedAt });

        expect([...env.fetchSourceBlocks.mock.calls[0][0].freshSlugs]).toEqual(["after"]);
    });

    it("makes every channel due when nothing was checked after the request", async () => {
        const requestedAt = Date.now() - 1000;
        seedCache({ channelFetchedAt: { one: requestedAt - 1, two: requestedAt - 5 * MINUTE } });

        await cacheLifecycle.refresh({ force: true, requestedAt });

        expect([...env.fetchSourceBlocks.mock.calls[0][0].freshSlugs]).toEqual([]);
    });
});

describe("unchanged channels", () => {
    it("are marked checked without downloading their blocks again", async () => {
        const downloadedAt = Date.now() - 2 * DAY;
        seedCache({
            channelFetchedAt: { one: downloadedAt },
            channelDownloads: { one: { at: downloadedAt, count: 5 } }
        });
        env.stamps.one = { updatedAt: downloadedAt - DAY, count: 5 };

        await cacheLifecycle.refresh({ force: true });

        expect(downloadedSlugs()).toEqual([]);
        expect(storedCache().blockIds).toEqual(["one"]);
        expect(storedCache().channelFetchedAt.one).toBeGreaterThan(downloadedAt);
        expect(storedCache().channelDownloads.one).toEqual({ at: downloadedAt, count: 5 });
    });

    it("are downloaded again once updated after the last download", async () => {
        const downloadedAt = Date.now() - 2 * DAY;
        seedCache({
            channelFetchedAt: { one: downloadedAt },
            channelDownloads: { one: { at: downloadedAt, count: 5 } }
        });
        env.stamps.one = { updatedAt: downloadedAt + HOUR, count: 5 };

        await cacheLifecycle.refresh({ force: true });

        expect(downloadedSlugs()).toEqual(["one"]);
        expect(storedCache().channelDownloads.one.count).toBe(5);
    });

    it("are downloaded again when their contents count moved", async () => {
        const downloadedAt = Date.now() - 2 * DAY;
        seedCache({
            channelFetchedAt: { one: downloadedAt },
            channelDownloads: { one: { at: downloadedAt, count: 5 } }
        });
        env.stamps.one = { updatedAt: downloadedAt - DAY, count: 4 };

        await cacheLifecycle.refresh({ force: true });

        expect(downloadedSlugs()).toEqual(["one"]);
    });

    it("are downloaded again when updated just before the download, inside the clock slack", async () => {
        const downloadedAt = Date.now() - 2 * DAY;
        seedCache({
            channelFetchedAt: { one: downloadedAt },
            channelDownloads: { one: { at: downloadedAt, count: 5 } }
        });
        env.stamps.one = { updatedAt: downloadedAt - MINUTE, count: 5 };

        await cacheLifecycle.refresh({ force: true });

        expect(downloadedSlugs()).toEqual(["one"]);
    });

    it("are still read again after a month without reported changes", async () => {
        const downloadedAt = Date.now() - 31 * DAY;
        seedCache({
            channelFetchedAt: { one: downloadedAt },
            channelDownloads: { one: { at: downloadedAt, count: 5 } }
        });
        env.stamps.one = { updatedAt: downloadedAt - DAY, count: 5 };

        await cacheLifecycle.refresh({ force: true });

        expect(downloadedSlugs()).toEqual(["one"]);
    });

    it("are recognised in caches written before downloads were recorded", async () => {
        const fetchedAt = Date.now() - 2 * DAY;
        seedCache({ channelFetchedAt: { one: fetchedAt } });
        env.stamps.one = { updatedAt: fetchedAt - DAY, count: 7 };

        await cacheLifecycle.refresh({ force: true });

        expect(downloadedSlugs()).toEqual([]);
        expect(storedCache().channelDownloads.one).toEqual({ at: fetchedAt, count: 7 });
    });

    it("are all downloaded when the type filters changed", async () => {
        const downloadedAt = Date.now() - 2 * DAY;
        seedCache({
            channelFetchedAt: { one: downloadedAt },
            channelDownloads: { one: { at: downloadedAt, count: 5 } },
            filters: ["Image"]
        });
        env.stamps.one = { updatedAt: downloadedAt - DAY, count: 5 };

        await cacheLifecycle.refresh();

        expect(downloadedSlugs()).toEqual(["one"]);
    });
});

describe("account channel listing", () => {
    it("is asked only for account channels that are due", async () => {
        env.data.set(STORAGE_KEYS.arenaAuth, { token: "token", user: { slug: "me" } });
        seedCache({ channelFetchedAt: { fresh: Date.now() - HOUR, due: Date.now() - 2 * DAY } });

        await cacheLifecycle.refresh();

        const [request] = env.fetchAccountChannelIndex.mock.calls[0];
        expect(request).toMatchObject({ token: "token", user: { slug: "me" } });
        expect(request.wanted).toEqual(["due"]);
        expect(env.fetchSourceBlocks.mock.calls[0][0].listedChannels).toBeInstanceOf(Map);
    });
});

describe("standalone blocks and the feed", () => {
    const withFeed = (standaloneFetchedAt) => {
        env.data.set(STORAGE_KEYS.arenaAuth, { token: "token", user: { slug: "me" } });
        seedCache({
            channelFetchedAt: { one: Date.now() - HOUR },
            settings: { includeFeed: true },
            sources: { feed: true },
            standaloneFetchedAt
        });
    };

    it("are left alone inside the check interval", async () => {
        withFeed(Date.now() - HOUR);

        await cacheLifecycle.refresh();

        expect(env.fetchSourceBlocks.mock.calls[0][0]).toMatchObject({ blockIds: [], includeFeed: false });
    });

    it("are fetched once the check interval has passed", async () => {
        withFeed(Date.now() - 2 * DAY);

        await cacheLifecycle.refresh();

        expect(env.fetchSourceBlocks.mock.calls[0][0].includeFeed).toBe(true);
        expect(storedCache().standaloneFetchedAt).toBeGreaterThan(Date.now() - MINUTE);
    });

    it("are fetched by a forced refresh asked for after they were", async () => {
        withFeed(Date.now() - HOUR);

        await cacheLifecycle.refresh({ force: true });

        expect(env.fetchSourceBlocks.mock.calls[0][0].includeFeed).toBe(true);
    });
});

describe("refresh through the worker", () => {
    it("asks again when the worker was torn down mid-reply", async () => {
        seedCache({ channelFetchedAt: { one: Date.now() - 10 * MINUTE } });
        env.sendMessage
            .mockRejectedValueOnce(new Error("The message port closed before a response was received."))
            .mockResolvedValueOnce({ ok: true, summary: { cacheVersion: CACHE_VERSION, blockCount: 1, completedAt: 1 } });

        await runtimeCacheLifecycle.refresh({ force: true });

        expect(env.sendMessage).toHaveBeenCalledTimes(2);
        expect(env.fetchSourceBlocks).not.toHaveBeenCalled();
    });
});
