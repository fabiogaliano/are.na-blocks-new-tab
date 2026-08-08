import { buildCache } from "./arena.js";
import { CACHE_VERSION, MESSAGES, STORAGE_KEYS } from "./constants.js";
import { runtime, storage } from "./extension-api.js";
import { getArenaAuth, getCache, getSettings, saveCache, saveCacheMeta } from "./storage.js";
import { createCacheLifecycle } from "./cache-lifecycle.js";

const CACHE_STALE_AFTER_MS = 60 * 60 * 1000;
const RUNTIME_ROUTE_UNAVAILABLE = /receiving end|message port closed|did not return a result/i;

const refreshLocal = async ({ testOnly = false, settingsOverride = null } = {}) => {
    const settings = settingsOverride || (await getSettings());
    const auth = await getArenaAuth();
    const cache = await buildCache({
        channelSlugs: settings.channelSlugs,
        accountChannelSlugs: settings.accountChannelSlugs,
        blockIds: settings.blockIds,
        filters: settings.filters,
        includeFeed: settings.includeFeed,
        token: auth.token
    });

    if (!testOnly) {
        await saveCache(cache);
    }

    return {
        blockCount: cache.blockIds.length,
        fetchedAt: cache.fetchedAt,
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
