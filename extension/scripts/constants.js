export const STORAGE_KEYS = {
    settings: "settings",
    cache: "blockCache",
    cacheMeta: "blockCacheMeta",
    bootstrap: "bootstrapState",
    arenaAuth: "arenaAuth",
    rateLimit: "arenaRateLimit",
    bookmarkState: "bookmarkState",
    bookmarkTrash: "bookmarkTrash",
    feedState: "feedState"
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
    blockMetaFields: ["title", "description", "createdAt", "blockId", "type"],
    bookmarksRootPath: "",
    hiddenFolders: ["archive", "to move"],
    launchFolder: "launch",
    pinnedFolders: ["reading/daily", "reading/curated"],
    mainFolders: ["people", "reading/slow", "dev", "design", "learning", "mac & terminal", "film", "tana"]
};

export const DEFAULT_BOOKMARK_STATE = { lastViewedAt: 0, newIds: [], openedAt: {} };
export const DEFAULT_FEED_STATE = { entries: {}, lastRunAt: 0 };

// One alarm covers a slice of the feed list rather than all of it: the worker is
// evicted after ~30s idle and capped at five minutes per invocation, so the poll
// has to survive being cut off and resume where it stopped.
export const FEED_POLL_INTERVAL_MINUTES = 30;
export const FEED_POLL_BATCH = 25;
export const FEED_TTL_MS = 6 * 60 * 60 * 1000;
export const FEED_FETCH_TIMEOUT_MS = 10_000;
export const OPEN_ALL_THRESHOLD = 15;
export const TRASH_MAX_ENTRIES = 200;
export const TRASH_TOAST_MS = 10_000;
export const MARQUEE_START_DISTANCE = 4;
export const BOOKMARK_REFRESH_DEBOUNCE = 250;

// 5: block records moved out of the cache object into the block store. The bump
// discards v4 caches, which carried every block inline and are the payload this
// version exists to stop writing.
export const CACHE_VERSION = 5;

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
    cacheResume: "arena-cache-resume",
    feedPoll: "feed-poll"
};

export const TILE_SIZE_OPTIONS = ["auto", "xs", "s", "m", "l", "xl"];

