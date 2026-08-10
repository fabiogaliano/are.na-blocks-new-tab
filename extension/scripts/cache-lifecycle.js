import { CACHE_STATE } from "./constants.js";

// A worker killed mid-refresh leaves `working` in storage forever. The
// heartbeat is how a later reader tells a live refresh from a dead one.
const WORKING_HEARTBEAT_MS = 30 * 1000;
const WORKING_STALE_MS = 3 * 60 * 1000;

// `storage.onChanged` fans out to every open new tab, so progress cannot be
// written per page fetched. One tick is the finest granularity worth paying for.
const WORKING_TICK_MS = 1000;

const hasCachedBlocks = (cache) => Array.isArray(cache?.blockIds) && cache.blockIds.length > 0;

// `completedAt` only moves when a whole pass finishes. A pass that stopped
// halfway has persisted the channels it did reach, and must still read as stale
// so the ones it never reached get fetched.
const getCacheTimestamp = ({ cache, meta }) => meta?.lastUpdated || cache?.completedAt || 0;

const getErrorMessage = (error) => error instanceof Error ? error.message : `${error || "Unknown cache refresh error"}`;

// Only a 429 carries `retryAt`. Anything else is a real failure and must not be
// dressed up as a pause the user is told to wait out.
const getRetryAt = (error) => Number.isFinite(error?.retryAt) ? error.retryAt : 0;

const getRefreshKey = (options = {}) => {
    // `reason` identifies the caller but cannot change the resulting cache.
    const refreshOptions = { ...options };
    delete refreshOptions.reason;
    return JSON.stringify(refreshOptions);
};

export const createCacheLifecycle = ({
    cacheVersion,
    readCache,
    writeCacheMeta,
    refreshLocal,
    refreshRemote = null,
    bootstrapStore = null,
    scheduleResume = async () => {},
    cancelResume = async () => {},
    staleAfterMs = null,
    reconcileReadyMeta = false,
    emptyRefreshReason = "bootstrap",
    now = Date.now
}) => {
    if (!Number.isFinite(cacheVersion)) {
        throw new TypeError("cacheVersion is required");
    }
    if (typeof readCache !== "function" || typeof writeCacheMeta !== "function" || typeof refreshLocal !== "function") {
        throw new TypeError("Cache lifecycle requires read, metadata, and local refresh adapters");
    }

    let refreshPromise = null;
    let activeRefreshKey = null;
    let queuedRefresh = null;
    let readinessPromise = null;
    let bootstrapAttempted = false;

    const read = async () => {
        const snapshot = await readCache();
        if (!snapshot?.cache || !snapshot?.meta) {
            throw new Error("Cache storage returned an invalid snapshot");
        }
        return snapshot;
    };

    // One timer covers both jobs: a tick with new progress publishes it, and a
    // tick with nothing new still beats often enough to prove the run is alive.
    const startWorkingReport = () => {
        let progress = null;
        let unpublished = false;
        let lastWriteAt = now();
        let pending = writeCacheMeta({
            state: CACHE_STATE.working,
            lastError: null,
            heartbeatAt: lastWriteAt,
            retryAt: 0,
            progress: null
        });

        const timer = setInterval(() => {
            const at = now();
            if (!unpublished && at - lastWriteAt < WORKING_HEARTBEAT_MS) {
                return;
            }

            unpublished = false;
            lastWriteAt = at;
            pending = pending
                .catch(() => {})
                .then(() => writeCacheMeta({ state: CACHE_STATE.working, heartbeatAt: now(), progress }));
        }, WORKING_TICK_MS);

        return {
            report: (next) => {
                progress = next;
                unpublished = true;
            },
            stop: async () => {
                clearInterval(timer);
                // Draining first stops a late beat from overwriting the final state.
                await pending.catch(() => {});
                return progress;
            }
        };
    };

    const refreshDirectly = async (options) => {
        // The opening write is not awaited: the `pending` chain keeps it ahead of
        // every later write, so the fetch can start while it lands.
        const report = startWorkingReport();

        try {
            const summary = await refreshLocal(options, { onProgress: report.report });
            if (!summary || summary.cacheVersion !== cacheVersion) {
                throw new Error("Local cache refresh returned an incompatible cache version");
            }

            await report.stop();
            await cancelResume();
            await writeCacheMeta({
                state: CACHE_STATE.idle,
                lastUpdated: summary.completedAt,
                lastError: null,
                blockCount: summary.blockCount,
                retryAt: 0,
                progress: null
            });
            return summary;
        } catch (error) {
            const progress = await report.stop();
            const retryAt = getRetryAt(error);

            if (retryAt > now()) {
                // `lastUpdated` deliberately stays put: the channels this pass
                // never reached must still read as stale once the window opens.
                await writeCacheMeta({
                    state: CACHE_STATE.cooldown,
                    lastError: null,
                    retryAt,
                    progress
                });
                await scheduleResume(retryAt);
            } else {
                await cancelResume();
                await writeCacheMeta({
                    state: CACHE_STATE.error,
                    lastError: getErrorMessage(error),
                    lastUpdated: now(),
                    retryAt: 0,
                    progress: null
                });
            }
            throw error;
        }
    };

    const performRefresh = async (options) => {
        if (typeof refreshRemote === "function") {
            const summary = await refreshRemote(options);
            if (summary?.cacheVersion === cacheVersion) {
                return summary;
            }
        }

        return refreshDirectly(options);
    };

    const startRefresh = (options, key) => {
        activeRefreshKey = key;
        const promise = performRefresh(options);
        refreshPromise = promise;

        const continueWithQueuedRefresh = () => {
            if (refreshPromise !== promise) {
                return;
            }

            refreshPromise = null;
            activeRefreshKey = null;
            const queued = queuedRefresh;
            queuedRefresh = null;
            if (!queued) {
                return;
            }

            startRefresh(queued.options, queued.key).then(queued.resolve, queued.reject);
        };

        promise.then(continueWithQueuedRefresh, continueWithQueuedRefresh);
        return promise;
    };

    const queueRefresh = (options, key) => {
        if (queuedRefresh) {
            queuedRefresh.options = options;
            queuedRefresh.key = key;
            return queuedRefresh.promise;
        }

        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        queuedRefresh = { options, key, promise, resolve, reject };
        return promise;
    };

    const refresh = (options = {}) => {
        const key = getRefreshKey(options);
        if (!refreshPromise) {
            return startRefresh(options, key);
        }
        if (key === activeRefreshKey) {
            return refreshPromise;
        }
        if (key === queuedRefresh?.key) {
            return queuedRefresh.promise;
        }
        return queueRefresh(options, key);
    };

    const writeBootstrapMarker = async (status) => {
        if (!bootstrapStore?.write) {
            return;
        }

        try {
            await bootstrapStore.write({
                status,
                cacheVersion,
                timestamp: now()
            });
        } catch (_) {
            try {
                await bootstrapStore.clear?.();
            } catch (_) {
                // Bootstrap markers are diagnostic; cache recovery must still continue.
            }
        }
    };

    const markExistingCacheReady = async () => {
        if (!bootstrapStore?.write) {
            return;
        }

        let marker = null;
        try {
            marker = await bootstrapStore.read?.();
        } catch (_) {
            // A replacement marker is written below.
        }

        if (marker?.status !== "complete" || marker.cacheVersion !== cacheVersion) {
            await writeBootstrapMarker("complete");
        }
    };

    const reconcileMetadata = async (snapshot) => {
        // Cooldown is as much a live pass as working is, and reconciling it back
        // to idle would erase the progress and `retryAt` the UI counts down from.
        const inFlight = snapshot.meta.state === CACHE_STATE.working || snapshot.meta.state === CACHE_STATE.cooldown;
        if (!reconcileReadyMeta || !hasCachedBlocks(snapshot.cache) || inFlight) {
            return snapshot;
        }

        const blockCount = snapshot.cache.blockIds.length;
        const lastUpdated = snapshot.cache.completedAt || 0;
        const metadataIsCurrent = snapshot.meta.state === CACHE_STATE.idle
            && snapshot.meta.lastError == null
            && snapshot.meta.lastUpdated === lastUpdated
            && snapshot.meta.blockCount === blockCount;

        if (metadataIsCurrent) {
            return snapshot;
        }

        await writeCacheMeta({
            state: CACHE_STATE.idle,
            lastUpdated,
            lastError: null,
            blockCount
        });
        return read();
    };

    const shouldRefreshStaleCache = (snapshot) => {
        if (refreshPromise) {
            return false;
        }
        if (snapshot.meta.state === CACHE_STATE.working) {
            return now() - (snapshot.meta.heartbeatAt || 0) > WORKING_STALE_MS;
        }
        // Opening a tab is the second way a paused pass resumes, and the only one
        // left where `chrome.alarms` is unavailable. Before `retryAt` it must not
        // fire, or every new tab spends another request into a closed window.
        if (snapshot.meta.state === CACHE_STATE.cooldown) {
            return now() >= (snapshot.meta.retryAt || 0);
        }
        if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
            return false;
        }
        const timestamp = getCacheTimestamp(snapshot);
        return timestamp > 0 && now() - timestamp >= staleAfterMs;
    };

    const performReadinessCheck = async () => {
        let snapshot = await read();

        if (!hasCachedBlocks(snapshot.cache)) {
            if (bootstrapStore && bootstrapAttempted) {
                return { ...snapshot, refreshed: false, summary: null };
            }

            bootstrapAttempted = Boolean(bootstrapStore);
            await writeBootstrapMarker("pending");

            try {
                const summary = await refresh({ reason: emptyRefreshReason });
                snapshot = await read();
                await writeBootstrapMarker("complete");
                return { ...snapshot, refreshed: true, summary };
            } catch (error) {
                await writeBootstrapMarker("error");
                throw error;
            }
        }

        await markExistingCacheReady();
        snapshot = await reconcileMetadata(snapshot);

        if (!shouldRefreshStaleCache(snapshot)) {
            return { ...snapshot, refreshed: false, summary: null };
        }

        const summary = await refresh({ reason: "stale" });
        snapshot = await read();
        return { ...snapshot, refreshed: true, summary };
    };

    const ensureReady = () => {
        if (readinessPromise) {
            return readinessPromise;
        }

        readinessPromise = (async () => {
            try {
                return await performReadinessCheck();
            } finally {
                readinessPromise = null;
            }
        })();
        return readinessPromise;
    };

    return Object.freeze({ read, refresh, ensureReady });
};
