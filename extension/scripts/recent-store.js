import { storage } from "./extension-api.js";
import { STORAGE_KEYS } from "./constants.js";
import { normalizeRecent, recordRecent } from "./recent-model.js";

export const getRecentEntries = async () => {
    const raw = await storage.get(STORAGE_KEYS.recent);
    return normalizeRecent(raw?.[STORAGE_KEYS.recent]?.entries);
};

export const saveRecentEntries = async (entries) => {
    const normalized = normalizeRecent(entries);
    await storage.set({ [STORAGE_KEYS.recent]: { entries: normalized } });
    return normalized;
};

// Re-read before writing rather than merging into a copy held by the page:
// several new tabs can draw in the same second, and the last writer must not
// erase what the others just recorded.
export const recordShownBlocks = async (ids, at = Date.now()) => {
    const next = recordRecent(await getRecentEntries(), ids, at);
    return saveRecentEntries(next);
};

export const clearRecent = async () => {
    await storage.remove(STORAGE_KEYS.recent);
};
