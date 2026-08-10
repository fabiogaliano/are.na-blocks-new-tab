import { fetchSourceBlocks } from "./arena.js";
import { CACHE_VERSION, MESSAGES, STORAGE_KEYS } from "./constants.js";
import { runtime, storage } from "./extension-api.js";
import {
    getArenaAuth,
    getCache,
    getSettings,
    mergeCacheChannel,
    mergeCacheStandalone,
    pruneCacheChannels,
    saveCache,
    saveCacheMeta
} from "./storage.js";
import { createCacheLifecycle } from "./cache-lifecycle.js";

const CACHE_STALE_AFTER_MS = 60 * 60 * 1000;
const RUNTIME_ROUTE_UNAVAILABLE = /receiving end|message port closed|did not return a result/i;

const getFreshChannelSlugs = (cache, now) => {
    const tracked = cache?.channelFetchedAt || {};
    return new Set(
        Object.entries(tracked)
            .filter(([, at]) => Number.isFinite(at) && at > 0 && now - at < CACHE_STALE_AFTER_MS)
            .map(([slug]) => slug)
    );
};

// Blocks are filtered by type as they are fetched, so a cached channel holds
// only the types selected at the time. A changed filter set has to refetch.
const filtersMatch = (cache, filters) => {
    const cached = cache?.sources?.filters;
    return Array.isArray(cached)
        && cached.length === filters.length
        && filters.every((filter) => cached.includes(filter));
};

const refreshLocal = async ({ testOnly = false, force = false, settingsOverride = null } = {}) => {
    const settings = settingsOverride || (await getSettings());
    const auth = await getArenaAuth();
    const channelSlugs = [...new Set([...settings.channelSlugs, ...settings.accountChannelSlugs].filter(Boolean))];

    const stored = (await getCache()).cache;
    const refetchAll = force || !filtersMatch(stored, settings.filters);

    let cache = pruneCacheChannels(stored, channelSlugs);
    cache = {
        ...cache,
        sources: {
            channels: channelSlugs,
            manualChannels: settings.channelSlugs,
            accountChannels: settings.accountChannelSlugs,
            blockIds: settings.blockIds,
            feed: Boolean(settings.includeFeed && auth.token),
            filters: settings.filters
        }
    };

    const persist = async (next) => {
        cache = next;
        if (!testOnly) {
            await saveCache(cache);
        }
    };

    // Old timestamps cannot distinguish channels completed by this full pass
    // from channels not yet forced or still built with the previous filters.
    if (refetchAll) {
        await persist({ ...cache, channelFetchedAt: {} });
    }

    const { standaloneBlocks } = await fetchSourceBlocks({
        channelSlugs,
        blockIds: settings.blockIds,
        filters: settings.filters,
        includeFeed: settings.includeFeed,
        token: auth.token,
        freshSlugs: refetchAll ? null : getFreshChannelSlugs(cache, Date.now()),
        // Checkpoint: a run killed mid-pass leaves the channels it finished on disk.
        onChannelBlocks: (slug, blocks) => persist(mergeCacheChannel(cache, slug, blocks))
    });

    const completedAt = Date.now();
    await persist({ ...mergeCacheStandalone(cache, standaloneBlocks), completedAt });

    return {
        blockCount: cache.blockIds.length,
        completedAt,
        cacheVersion: CACHE_VERSION
    };
};

const refreshThroughRuntime = async (options) => {
    let response;
    try {
        response = await runtime.sendMessage({
            type: MESSAGES.refreshCache,
            payload: options
        });
    } catch (error) {
        if (RUNTIME_ROUTE_UNAVAILABLE.test(error?.message || "")) {
            return null;
        }
        throw error;
    }

    if (response?.ok) {
        return response.summary || null;
    }
    if (!response || RUNTIME_ROUTE_UNAVAILABLE.test(response.error || "")) {
        return null;
    }
    throw new Error(response.error || "Cache refresh did not return a result.");
};

const bootstrapStore = {
    read: async () => {
        const stored = await storage.get(STORAGE_KEYS.bootstrap);
        return stored?.[STORAGE_KEYS.bootstrap] || null;
    },
    write: (marker) => storage.set({ [STORAGE_KEYS.bootstrap]: marker }),
    clear: () => storage.remove(STORAGE_KEYS.bootstrap)
};

const lifecycleDependencies = {
    cacheVersion: CACHE_VERSION,
    readCache: getCache,
    writeCacheMeta: saveCacheMeta,
    refreshLocal
};

export const cacheLifecycle = createCacheLifecycle({
    ...lifecycleDependencies,
    reconcileReadyMeta: true,
    emptyRefreshReason: "startup"
});

export const runtimeCacheLifecycle = createCacheLifecycle({
    ...lifecycleDependencies,
    refreshRemote: refreshThroughRuntime,
    bootstrapStore,
    staleAfterMs: CACHE_STALE_AFTER_MS
});
