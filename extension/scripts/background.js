import { addListenerSafe, alarms, runtime } from "./extension-api.js";
import { ALARMS, CACHE_STATE, MESSAGES } from "./constants.js";
import { saveCacheMeta } from "./storage.js";
import { cacheLifecycle } from "./cache-refresh.js";

runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== MESSAGES.refreshCache) {
        return false;
    }
    cacheLifecycle.refresh(message.payload || {})
        .then((result) => sendResponse({ ok: true, summary: result }))
        .catch((error) => {
            console.error("Cache refresh failed", error);
            sendResponse({ ok: false, error: error.message });
        });
    return true;
});

runtime.onInstalled.addListener(async () => {
    const { cache } = await cacheLifecycle.read();
    if (!cache.blockIds.length) {
        await saveCacheMeta({ state: CACHE_STATE.idle, lastUpdated: 0, lastError: null });
    }
});

addListenerSafe(alarms?.onAlarm, async (alarm) => {
    if (alarm?.name !== ALARMS.cacheResume) {
        return;
    }
    try {
        // Not forced: the point of resuming is to pick up the channels the
        // paused pass never reached, not to spend the window on the ones it did.
        await cacheLifecycle.refresh({ reason: "cooldown-resume" });
    } catch (error) {
        console.error("Cache resume after rate limit failed", error);
    }
});

runtime.onStartup?.addListener(async () => {
    try {
        await cacheLifecycle.ensureReady();
    } catch (error) {
        console.error("Startup cache recovery failed", error);
    }
});
