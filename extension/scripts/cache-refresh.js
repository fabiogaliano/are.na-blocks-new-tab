import { fetchSourceBlocks } from "./arena.js";
import { ALARMS, CACHE_VERSION, MESSAGES, STORAGE_KEYS } from "./constants.js";
import { alarms, runtime, storage } from "./extension-api.js";
import { putBlocks, retainBlocks } from "./block-store.js";
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

const refreshLocal = async ({ testOnly = false, force = false, settingsOverride = null } = {}, { onProgress } = {}) => {
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

    // Blocks go in before the index that names them. A pass killed between the
    // two leaves records nothing points at, which the next pass reconciles; the
    // reverse order would leave ids whose blocks were never stored, and those
    // render as gaps until a full refresh clears them.
    const persistBlocks = async (blocks) => {
        if (!testOnly) {
            await putBlocks(blocks);
        }
    };

    // Old timestamps cannot distinguish channels completed by this full pass
    // from channels not yet forced or still built with the previous filters.
    if (refetchAll) {
        await persist({ ...cache, channelFetchedAt: {} });
    }

    const freshSlugs = refetchAll ? null : getFreshChannelSlugs(cache, Date.now());

    // Channels a previous pass already made fresh count as done, so a resumed
    // pass carries on from the number the paused one stopped at.
    const channelsTotal = channelSlugs.length;
    let channelsDone = freshSlugs ? channelSlugs.filter((slug) => freshSlugs.has(slug)).length : 0;
    let currentChannel = null;

    const report = () => onProgress?.({ channelsDone, channelsTotal, currentChannel });
    report();

    const { standaloneBlocks } = await fetchSourceBlocks({
        channelSlugs,
        blockIds: settings.blockIds,
        filters: settings.filters,
        includeFeed: settings.includeFeed,
        token: auth.token,
        freshSlugs,
        onProgress: ({ title, slug }) => {
            currentChannel = title || slug;
            report();
        },
        // Checkpoint: a run killed mid-pass leaves the channels it finished on disk.
        onChannelBlocks: async (slug, blocks) => {
            await persistBlocks(blocks);
            await persist(mergeCacheChannel(cache, slug, blocks));
            channelsDone += 1;
            report();
        }
    });

    const completedAt = Date.now();
    await persistBlocks(standaloneBlocks);
    await persist({ ...mergeCacheStandalone(cache, standaloneBlocks), completedAt });

    // Once per completed pass, not per checkpoint: dropping a channel or
    // finishing a forced refresh orphans the blocks only it referenced, and
    // walking every key is affordable here but not 49 times over.
    if (!testOnly) {
        await retainBlocks(cache.blockIds);
    }

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

// MV3 tears the worker down long before a 60s window reopens, so the wait
// cannot be a `setTimeout`. Where alarms are unavailable the cooldown still
// clears, just not until a tab is opened after `retryAt`.
const scheduleResume = async (retryAt) => {
    if (!alarms) {
        return;
    }
    try {
        await alarms.create(ALARMS.cacheResume, { when: retryAt });
    } catch (error) {
        console.warn("Could not schedule the Are.na cache resume", error);
    }
};

const cancelResume = async () => {
    if (!alarms) {
        return;
    }
    try {
        await alarms.clear(ALARMS.cacheResume);
    } catch (error) {
        console.warn("Could not clear the Are.na cache resume", error);
    }
};

const lifecycleDependencies = {
    cacheVersion: CACHE_VERSION,
    readCache: getCache,
    writeCacheMeta: saveCacheMeta,
    refreshLocal,
    scheduleResume,
    cancelResume
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
