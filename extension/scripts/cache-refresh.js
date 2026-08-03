import { buildCache } from "./arena.js";
import { CACHE_STATE, CACHE_VERSION } from "./constants.js";
import { getArenaAuth, getSettings, saveCache, saveCacheMeta } from "./storage.js";

const notify = async (meta, onStateChange) => {
    if (typeof onStateChange === "function") {
        await onStateChange(meta);
        return;
    }
    await saveCacheMeta(meta);
};

export const refreshCache = async ({ testOnly = false, settingsOverride = null, onStateChange } = {}) => {
    await notify({ state: CACHE_STATE.working, lastError: null }, onStateChange);

    try {
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

        await notify({
            state: CACHE_STATE.idle,
            lastUpdated: cache.fetchedAt,
            lastError: null,
            blockCount: cache.blockIds.length
        }, onStateChange);

        return {
            blockCount: cache.blockIds.length,
            fetchedAt: cache.fetchedAt,
            cacheVersion: CACHE_VERSION
        };
    } catch (error) {
        await notify({
            state: CACHE_STATE.error,
            lastError: error.message,
            lastUpdated: Date.now()
        }, onStateChange);
        throw error;
    }
};
