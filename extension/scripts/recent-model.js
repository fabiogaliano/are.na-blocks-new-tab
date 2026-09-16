// The ring buffer behind the recent rail. Kept pure so it can be tested without
// a browser: everything that touches chrome.storage lives in recent-store.js.

export const RECENT_LIMIT = 100;

const JUST_NOW_MS = 2 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const asId = (value) => `${value}`;

const startOfDay = (value) => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
};

export const normalizeRecent = (entries) => {
    if (!Array.isArray(entries)) {
        return [];
    }
    const seen = new Set();
    const normalized = [];
    for (const entry of entries) {
        const id = entry?.id === 0 || entry?.id ? asId(entry.id) : "";
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        const at = Number(entry.at);
        normalized.push({ id, at: Number.isFinite(at) && at > 0 ? at : 0 });
    }
    return normalized.slice(0, RECENT_LIMIT);
};

// Newest first. A block drawn again moves back to the front with the new
// timestamp instead of appearing twice, so the rail lists each block once.
export const recordRecent = (entries, ids, at = Date.now()) => {
    const incoming = (Array.isArray(ids) ? ids : [ids])
        .filter((value) => value === 0 || Boolean(value))
        .map(asId);
    const current = normalizeRecent(entries);
    if (!incoming.length) {
        return current;
    }
    const drawn = new Set(incoming);
    const head = [...drawn].map((id) => ({ id, at }));
    return [...head, ...current.filter((entry) => !drawn.has(entry.id))].slice(0, RECENT_LIMIT);
};

// A block can leave the cache — dropped from a channel, or evicted by the
// retain pass — and its record leaves the block store with it. Ids that no
// longer resolve are dead weight, so a read that cannot find them drops them.
export const pruneRecent = (entries, availableIds) => {
    const keep = new Set([...(availableIds || [])].map(asId));
    return normalizeRecent(entries).filter((entry) => keep.has(entry.id));
};

export const bucketRecent = (timestamp, now = Date.now()) => {
    const at = Number(timestamp);
    if (!Number.isFinite(at) || at <= 0) {
        return "older";
    }
    const delta = now - at;
    if (delta < JUST_NOW_MS) {
        return "just now";
    }
    if (delta < HOUR_MS) {
        return "last hour";
    }
    const today = startOfDay(now);
    if (at >= today) {
        return "earlier today";
    }
    if (at >= today - 24 * HOUR_MS) {
        return "yesterday";
    }
    return "older";
};

// Groups stay in the order the entries arrive, so the rail reads newest first
// left to right without sorting the buckets separately.
export const groupRecent = (entries, now = Date.now()) => {
    const groups = [];
    for (const entry of normalizeRecent(entries)) {
        const label = bucketRecent(entry.at, now);
        const last = groups[groups.length - 1];
        if (last?.label === label) {
            last.entries.push(entry);
        } else {
            groups.push({ label, entries: [entry] });
        }
    }
    return groups;
};

// Half the pool at most, and never so much that the tab cannot be filled with
// blocks nobody has seen. The randomness is the reason to open another tab, so
// this damps immediate repeats rather than ruling any block out.
export const SOFT_AVOID_RATIO = 0.5;

export const softAvoidIds = (entries, poolSize, count = 1) => {
    const size = Math.max(0, Math.floor(Number(poolSize) || 0));
    const wanted = Math.max(1, Math.floor(Number(count) || 1));
    const room = Math.max(0, size - wanted);
    const window = Math.min(Math.floor(size * SOFT_AVOID_RATIO), room);
    return window > 0 ? normalizeRecent(entries).slice(0, window).map((entry) => entry.id) : [];
};
