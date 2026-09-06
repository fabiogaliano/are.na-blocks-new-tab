import { storage } from "./extension-api.js";
import { clearBlocks } from "./block-store.js";
import { CACHE_VERSION, STORAGE_KEYS } from "./constants.js";
import { canonicalizeSettings } from "./settings-model.js";

// A factory, not a constant: the cache carries nested objects and a spread copy
// would hand every caller the same `channelBlockIds` and `channelFetchedAt`.
const createDefaultCache = () => ({
    version: CACHE_VERSION,
    completedAt: 0,
    blockIds: [],
    channelBlockIds: {},
    channelFetchedAt: {},
    standaloneBlockIds: [],
    sources: {
        channels: [],
        manualChannels: [],
        accountChannels: [],
        feed: false,
        blockIds: [],
        filters: []
    }
});

const DEFAULT_CACHE_META = {
    state: "idle",
    lastUpdated: 0,
    lastError: null,
    blockCount: 0,
    heartbeatAt: 0,
    retryAt: 0,
    progress: null
};

const DEFAULT_ARENA_AUTH = {
    token: "",
    user: null
};

export const getSettings = async () => {
    const raw = await storage.get(STORAGE_KEYS.settings);
    const stored = raw?.[STORAGE_KEYS.settings];
    return canonicalizeSettings(stored || undefined);
};

export const saveSettings = async (settings) => {
    const payload = canonicalizeSettings(settings);
    await storage.set({ [STORAGE_KEYS.settings]: payload });
    return payload;
};

export const getCache = async () => {
    const raw = await storage.get([STORAGE_KEYS.cache, STORAGE_KEYS.cacheMeta]);
    const storedCache = raw?.[STORAGE_KEYS.cache];
    const storedMeta = raw?.[STORAGE_KEYS.cacheMeta];
    const cache = storedCache?.version === CACHE_VERSION ? storedCache : createDefaultCache();
    const blockCount = Array.isArray(cache.blockIds) ? cache.blockIds.length : 0;
    const meta = {
        ...DEFAULT_CACHE_META,
        ...(storedMeta || {}),
        lastUpdated: storedMeta?.lastUpdated || cache.completedAt || 0,
        blockCount
    };
    
    return {
        cache,
        meta
    };
};

export const saveCache = async (cache) => {
    await storage.set({ [STORAGE_KEYS.cache]: { ...cache, version: CACHE_VERSION } });
};

// Each source tracks its own membership because the same block routinely sits
// in several channels at once. Reading ownership off a block's `sourceChannel`
// is the tempting shortcut and it is wrong: that field holds whichever channel
// fetched the block last, so dropping that channel evicts a block the others
// still list.
//
// Only ids are rebuilt here. The block records themselves live in the block
// store, written before the index that names them, so this stays a pure
// function over the membership records.
const rebuildIndex = (cache) => {
    const retained = new Set(cache.standaloneBlockIds || []);
    for (const memberIds of Object.values(cache.channelBlockIds || {})) {
        for (const id of memberIds) {
            retained.add(id);
        }
    }
    return { ...cache, blockIds: [...retained] };
};

export const mergeCacheChannel = (cache, slug, blocks, at = Date.now()) => rebuildIndex({
    ...cache,
    channelBlockIds: { ...(cache?.channelBlockIds || {}), [slug]: blocks.map((block) => block.id) },
    channelFetchedAt: { ...(cache?.channelFetchedAt || {}), [slug]: at }
});

// Blocks fetched by id and blocks pulled from the feed have no channel to be
// refreshed against, so every pass replaces them wholesale.
export const mergeCacheStandalone = (cache, blocks) => rebuildIndex({
    ...cache,
    standaloneBlockIds: blocks.map((block) => block.id)
});

export const pruneCacheChannels = (cache, slugs) => {
    const keep = new Set(slugs);
    // Both records, because a forced pass clears `channelFetchedAt` while the
    // membership it has to prune stays behind in `channelBlockIds`.
    const tracked = new Set([
        ...Object.keys(cache?.channelBlockIds || {}),
        ...Object.keys(cache?.channelFetchedAt || {})
    ]);
    if ([...tracked].every((slug) => keep.has(slug))) {
        return cache;
    }

    const kept = (record) => Object.fromEntries(Object.entries(record || {}).filter(([slug]) => keep.has(slug)));
    return rebuildIndex({
        ...cache,
        channelBlockIds: kept(cache?.channelBlockIds),
        channelFetchedAt: kept(cache?.channelFetchedAt)
    });
};

export const saveCacheMeta = async (meta) => {
    const raw = await storage.get(STORAGE_KEYS.cacheMeta);
    const current = {
        ...DEFAULT_CACHE_META,
        ...(raw?.[STORAGE_KEYS.cacheMeta] || {})
    };
    await storage.set({ [STORAGE_KEYS.cacheMeta]: { ...current, ...meta } });
};

export const clearCache = async () => {
    await storage.remove([STORAGE_KEYS.cache, STORAGE_KEYS.cacheMeta, STORAGE_KEYS.bootstrap]);
    await clearBlocks();
};

export const getArenaAuth = async () => {
    const raw = await storage.get(STORAGE_KEYS.arenaAuth);
    const stored = raw?.[STORAGE_KEYS.arenaAuth];
    if (!stored || typeof stored.token !== "string" || !stored.token.trim()) {
        return { ...DEFAULT_ARENA_AUTH };
    }
    return {
        token: stored.token.trim(),
        user: stored.user && typeof stored.user === "object" ? stored.user : null
    };
};

export const saveArenaAuth = async ({ token, user }) => {
    const payload = {
        token: typeof token === "string" ? token.trim() : "",
        user: user && typeof user === "object" ? user : null
    };
    await storage.set({ [STORAGE_KEYS.arenaAuth]: payload });
    return payload;
};

export const clearArenaAuth = async () => {
    await storage.remove(STORAGE_KEYS.arenaAuth);
};
