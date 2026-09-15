import { DEFAULT_BOOKMARK_STATE, STORAGE_KEYS } from "./constants.js";
import { computeNewIds } from "./bookmarks-model.js";

const normalizeState = (value) => ({
    lastViewedAt: Number.isFinite(Number(value?.lastViewedAt)) ? Number(value.lastViewedAt) : DEFAULT_BOOKMARK_STATE.lastViewedAt,
    newIds: [...new Set(Array.isArray(value?.newIds) ? value.newIds.map(String) : [])],
    // Keyed by url, not bookmark id: re-filing a link into another folder gives it a
    // new id, and that should not reset how much of the site you have already read.
    openedAt: value?.openedAt && typeof value.openedAt === "object"
        ? Object.fromEntries(Object.entries(value.openedAt).map(([url, at]) => [url, Number(at) || 0]))
        : {}
});

async function getStorage(storageApi) {
    if (storageApi) {
        return storageApi;
    }
    return (await import("./extension-api.js")).storage;
}

export async function readBookmarkState(storageApi) {
    const target = await getStorage(storageApi);
    const raw = await target.get(STORAGE_KEYS.bookmarkState);
    return normalizeState(raw?.[STORAGE_KEYS.bookmarkState]);
}

export async function writeBookmarkState(value, storageApi) {
    const target = await getStorage(storageApi);
    const state = normalizeState(value);
    await target.set({ [STORAGE_KEYS.bookmarkState]: state });
    return state;
}

export function pruneNewIds(ids, links) {
    const present = new Set((links || []).map((link) => String(link.id)));
    return [...new Set((ids || []).map(String))].filter((id) => present.has(id));
}

export function markOpenedState(state, urls, at = Date.now()) {
    const openedAt = { ...state.openedAt };
    for (const url of Array.isArray(urls) ? urls : [urls]) {
        if (url) {
            openedAt[url] = at;
        }
    }
    return normalizeState({ ...state, openedAt });
}

// A link with no recorded visit would otherwise count every entry the feed carries,
// so first sight is stamped as "read up to here" — the same way the first board open
// seeds lastViewedAt instead of marking every existing bookmark new.
export function seedOpenedAt(openedAt, links, at = Date.now()) {
    const seeded = { ...openedAt };
    for (const link of links || []) {
        if (link.url && !(link.url in seeded)) {
            seeded[link.url] = at;
        }
    }
    return seeded;
}

export function pruneOpenedAt(openedAt, links) {
    const present = new Set((links || []).map((link) => link.url));
    return Object.fromEntries(Object.entries(openedAt || {}).filter(([url]) => present.has(url)));
}

export function markReadState(state, ids) {
    const read = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    return normalizeState({ ...state, newIds: state.newIds.filter((id) => !read.has(id)) });
}

export async function synchronizeNewMarkers(links, storageApi, at = Date.now()) {
    const current = await readBookmarkState(storageApi);
    if (!current.lastViewedAt) {
        return writeBookmarkState({ lastViewedAt: at, newIds: [] }, storageApi);
    }
    const newIds = computeNewIds({ links, lastViewedAt: current.lastViewedAt, knownNewIds: current.newIds });
    if (newIds.length !== current.newIds.length || newIds.some((id, index) => id !== current.newIds[index])) {
        return writeBookmarkState({ ...current, newIds }, storageApi);
    }
    return current;
}

export async function markBoardOpened(openedAt = Date.now(), storageApi) {
    const current = await readBookmarkState(storageApi);
    return writeBookmarkState({ ...current, lastViewedAt: openedAt }, storageApi);
}

export async function markOpened(urls, at = Date.now(), storageApi) {
    const current = await readBookmarkState(storageApi);
    return writeBookmarkState(markOpenedState(current, urls, at), storageApi);
}

export async function markRead(ids, storageApi) {
    const current = await readBookmarkState(storageApi);
    return writeBookmarkState(markReadState(current, ids), storageApi);
}

export async function resetNewMarkers(storageApi, at = Date.now()) {
    return writeBookmarkState({ lastViewedAt: at, newIds: [] }, storageApi);
}
