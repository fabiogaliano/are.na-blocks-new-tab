import { storage } from "./extension-api.js";
import { CACHE_VERSION, DEFAULT_SETTINGS, STORAGE_KEYS, TILE_SIZE_OPTIONS } from "./constants.js";
import { normalizeBarLayout, normalizeBlockMetaFields, normalizeDateFormat, normalizeTimeFormat } from "./customization.js";

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

const normalizeCommaList = (value) => (value || "").split(",").map(item => item.trim()).filter(Boolean);

const normalizeStringArray = (value) => Array.isArray(value)
    ? value.map(item => `${item}`.trim()).filter(Boolean)
    : [];

export const parseChannelSlugs = (input) => normalizeCommaList(input.toLowerCase());

export const parseBlockIds = (input) => normalizeCommaList(input).map(id => id.replace(/[^0-9]/g, "")).filter(Boolean);

export const getSettings = async () => {
    const raw = await storage.get(STORAGE_KEYS.settings);
    const stored = raw?.[STORAGE_KEYS.settings];
    
    if (!stored) {
        return {
            ...DEFAULT_SETTINGS,
            channelSlugs: [...DEFAULT_SETTINGS.channelSlugs],
            blockIds: [...DEFAULT_SETTINGS.blockIds],
            filters: [...DEFAULT_SETTINGS.filters],
            accountChannelSlugs: [...DEFAULT_SETTINGS.accountChannelSlugs],
            barLayout: normalizeBarLayout(DEFAULT_SETTINGS.barLayout),
            blockMetaFields: [...DEFAULT_SETTINGS.blockMetaFields]
        };
    }
    
    return {
        ...DEFAULT_SETTINGS,
        ...stored,
        channelSlugs: Array.isArray(stored.channelSlugs) ? stored.channelSlugs : normalizeCommaList(stored.channelSlugs),
        blockIds: Array.isArray(stored.blockIds) ? stored.blockIds : parseBlockIds(stored.blockIds),
        filters: normalizeStringArray(stored.filters).length ? normalizeStringArray(stored.filters) : [...DEFAULT_SETTINGS.filters],
        tileSize: TILE_SIZE_OPTIONS.includes(stored.tileSize) ? stored.tileSize : DEFAULT_SETTINGS.tileSize,
        includeFeed: Boolean(stored.includeFeed),
        accountChannelSlugs: normalizeStringArray(stored.accountChannelSlugs),
        barLayout: normalizeBarLayout(stored.barLayout),
        dateFormat: normalizeDateFormat(stored.dateFormat),
        timeFormat: normalizeTimeFormat(stored.timeFormat),
        blockMetaFields: normalizeBlockMetaFields(stored.blockMetaFields)
    };
};

export const saveSettings = async (settings) => {
    const payload = {
        ...DEFAULT_SETTINGS,
        ...settings,
        channelSlugs: Array.isArray(settings.channelSlugs)
            ? settings.channelSlugs.map(slug => slug.trim()).filter(Boolean)
            : [],
        blockIds: Array.isArray(settings.blockIds)
            ? settings.blockIds.map(id => `${id}`.trim()).filter(Boolean)
            : [],
        filters: normalizeStringArray(settings.filters).length ? normalizeStringArray(settings.filters) : [...DEFAULT_SETTINGS.filters],
        tileSize: TILE_SIZE_OPTIONS.includes(settings.tileSize) ? settings.tileSize : DEFAULT_SETTINGS.tileSize,
        includeFeed: Boolean(settings.includeFeed),
        accountChannelSlugs: normalizeStringArray(settings.accountChannelSlugs),
        barLayout: normalizeBarLayout(settings.barLayout),
        dateFormat: normalizeDateFormat(settings.dateFormat),
        timeFormat: normalizeTimeFormat(settings.timeFormat),
        blockMetaFields: normalizeBlockMetaFields(settings.blockMetaFields)
    };
    
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
    const { meta: current } = await getCache();
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
