import { CACHE_STATE } from "./constants.js";

// A worker killed mid-refresh leaves `working` in storage forever. The
// heartbeat is how a later reader tells a live refresh from a dead one.
const WORKING_HEARTBEAT_MS = 30 * 1000;
const WORKING_STALE_MS = 3 * 60 * 1000;

const hasCachedBlocks = (cache) => Array.isArray(cache?.blockIds) && cache.blockIds.length > 0;

// `completedAt` only moves when a whole pass finishes. A pass that stopped
// halfway has persisted the channels it did reach, and must still read as stale
// so the ones it never reached get fetched.
const getCacheTimestamp = ({ cache, meta }) => meta?.lastUpdated || cache?.completedAt || 0;

const getErrorMessage = (error) => error instanceof Error ? error.message : `${error || "Unknown cache refresh error"}`;

const getRefreshKey = (options) => JSON.stringify(options || {});

export const createCacheLifecycle = ({
    cacheVersion,
    readCache,
    writeCacheMeta,
    refreshLocal,
    refreshRemote = null,
    bootstrapStore = null,
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

    const startWorkingHeartbeat = async () => {
        await writeCacheMeta({ state: CACHE_STATE.working, lastError: null, heartbeatAt: now() });

        let pending = Promise.resolve();
        const timer = setInterval(() => {
            pending = pending
                .catch(() => {})
                .then(() => writeCacheMeta({ state: CACHE_STATE.working, heartbeatAt: now() }));
        }, WORKING_HEARTBEAT_MS);

        return async () => {
            clearInterval(timer);
            // Draining first stops a late beat from overwriting the final state.
            await pending.catch(() => {});
        };
    };

    const refreshDirectly = async (options) => {
        const stopHeartbeat = await startWorkingHeartbeat();

        try {
            const summary = await refreshLocal(options);
            if (!summary || summary.cacheVersion !== cacheVersion) {
                throw new Error("Local cache refresh returned an incompatible cache version");
            }

            await stopHeartbeat();
            await writeCacheMeta({
                state: CACHE_STATE.idle,
                lastUpdated: summary.completedAt,
                lastError: null,
                blockCount: summary.blockCount
            });
            return summary;
        } catch (error) {
            await stopHeartbeat();
            await writeCacheMeta({
                state: CACHE_STATE.error,
                lastError: getErrorMessage(error),
                lastUpdated: now()
            });
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
        if (!reconcileReadyMeta || !hasCachedBlocks(snapshot.cache) || snapshot.meta.state === CACHE_STATE.working) {
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
