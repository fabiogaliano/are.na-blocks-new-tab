// sessionStorage is scoped to one browser tab and survives navigating away and
// back, so coming back to this tab redraws what it first showed while every new
// tab still starts empty and picks its own blocks.
const KEY = "arenaTabBlockIds";

const navigationType = () => {
    try {
        return globalThis.performance?.getEntriesByType?.("navigation")?.[0]?.type ?? "navigate";
    } catch (_) {
        return "navigate";
    }
};

const sessionStore = () => {
    try {
        return globalThis.sessionStorage ?? null;
    } catch (_) {
        return null;
    }
};

// Only Back/Forward returns to the earlier blocks; a reload is an explicit ask
// for new ones, even though sessionStorage survives it.
export const readTabBlockIds = (store = sessionStore(), navigation = navigationType()) => {
    if (navigation !== "back_forward") {
        return [];
    }
    try {
        const ids = JSON.parse(store?.getItem(KEY) ?? "null");
        return Array.isArray(ids) ? ids.map(String) : [];
    } catch (_) {
        return [];
    }
};

export const saveTabBlockIds = (ids, store = sessionStore()) => {
    try {
        store?.setItem(KEY, JSON.stringify((ids || []).map(String)));
    } catch (_) {
        // Losing this only means the tab picks new blocks when revisited.
    }
};
