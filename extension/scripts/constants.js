export const STORAGE_KEYS = {
    settings: "settings",
    cache: "blockCache",
    cacheMeta: "blockCacheMeta",
    bootstrap: "bootstrapState",
    arenaAuth: "arenaAuth",
    rateLimit: "arenaRateLimit"
};

export const BAR_COMPONENTS = ["none", "bookmarks", "cache", "settings", "date", "time", "dateTime"];

export const BLOCK_META_FIELDS = [
    "title",
    "description",
    "createdAt",
    "updatedAt",
    "blockId",
    "type",
    "author",
    "sourceChannel",
    "source",
    "comments",
    "visibility",
    "state",
    "connectedBy",
    "connectedAt",
    "position",
    "pinned",
    "itemCount",
    "attachment",
    "customMetadata"
];

export const DATE_FORMATS = ["system", "short", "long", "iso"];
export const TIME_FORMATS = ["system", "12-hour", "24-hour", "12-hour-seconds", "24-hour-seconds"];

export const DEFAULT_BAR_LAYOUT = {
    top: {
        left: "bookmarks",
        right: "none"
    },
    bottom: {
        left: "cache",
        right: "settings"
    }
};

export const DEFAULT_SETTINGS = {
    channelSlugs: ["ephemeral-visions", "device-gadget"],
    blockIds: [],
    blockCount: 1,
    showHeader: true,
    showFooter: true,
    filters: ["Image", "Text"],
    theme: "system",
    tileSize: "auto",
    includeFeed: false,
    accountChannelSlugs: [],
    barLayout: DEFAULT_BAR_LAYOUT,
    dateFormat: "system",
    timeFormat: "system",
    blockMetaFields: ["title", "description", "createdAt", "blockId", "type"]
};

export const CACHE_VERSION = 4;

export const ARENA_API_ROOT = "https://api.are.na/v3";

export const BLOCK_TYPES = ["Image", "Text", "Link", "Attachment", "Embed", "Channel"];

export const CACHE_STATE = {
    idle: "idle",
    working: "working",
    // A pass paused by a 429. Distinct from `error`: the data is fine, the
    // window is not, and the pass resumes on its own once `retryAt` passes.
    cooldown: "cooldown",
    error: "error"
};

export const MESSAGES = {
    refreshCache: "arena-cache-refresh"
};

export const ALARMS = {
    cacheResume: "arena-cache-resume"
};

export const TILE_SIZE_OPTIONS = ["auto", "xs", "s", "m", "l", "xl"];

