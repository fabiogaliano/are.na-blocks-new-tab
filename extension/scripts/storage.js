import { storage } from "./extension-api.js";
import { CACHE_VERSION, STORAGE_KEYS } from "./constants.js";
import { canonicalizeSettings } from "./settings-model.js";

const DEFAULT_CACHE = {
    version: CACHE_VERSION,
    fetchedAt: 0,
    blockIds: [],
    blocksById: {},
    sources: {
        channels: [],
        manualChannels: [],
        accountChannels: [],
        feed: false,
        blockIds: []
    }
};

const DEFAULT_CACHE_META = {
    state: "idle",
    lastUpdated: 0,
    lastError: null,
    blockCount: 0
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
    const cache = storedCache?.version === CACHE_VERSION ? storedCache : { ...DEFAULT_CACHE };
    const blockCount = Array.isArray(cache.blockIds) ? cache.blockIds.length : 0;
    const meta = {
        ...DEFAULT_CACHE_META,
        ...(storedMeta || {}),
        lastUpdated: storedMeta?.lastUpdated || cache.fetchedAt || 0,
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
