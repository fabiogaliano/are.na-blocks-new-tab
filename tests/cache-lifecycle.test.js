import { describe, expect, it, vi } from "vitest";
import { CACHE_STATE } from "../extension/scripts/constants.js";
import { createCacheLifecycle } from "../extension/scripts/cache-lifecycle.js";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const VERSION = 1;
const SUMMARY = { cacheVersion: VERSION, blockCount: 1, completedAt: NOW };

const createHarness = ({ cache = {}, meta = {}, ...dependencies } = {}) => {
    const store = {
        cache: { blockIds: ["1"], completedAt: NOW - 10 * MINUTE, ...cache },
        meta: {
            state: CACHE_STATE.idle,
            lastUpdated: NOW - 10 * MINUTE,
            lastError: null,
            heartbeatAt: 0,
            retryAt: 0,
            progress: null,
            ...meta
        }
    };
    const lifecycle = createCacheLifecycle({
        cacheVersion: VERSION,
        readCache: async () => ({ cache: store.cache, meta: { ...store.meta } }),
        writeCacheMeta: async (next) => {
            store.meta = { ...store.meta, ...next };
        },
        refreshLocal: vi.fn(async () => SUMMARY),
        now: () => NOW,
        ...dependencies
    });
    return { store, lifecycle };
};

const memoryBootstrapStore = () => {
    let marker = null;
    return {
        read: async () => marker,
        write: async (next) => {
            marker = next;
        },
        clear: async () => {
            marker = null;
        }
    };
};

const rateLimited = () => Object.assign(new Error("Are.na request failed (429): slow down"), {
    status: 429,
    retryAt: NOW + MINUTE
});

describe("forced refresh queued behind another pass", () => {
    it("carries the time it was asked for, not the time it starts", async () => {
        let clock = NOW;
        let finishFirst;
        const refreshLocal = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => {
                finishFirst = () => resolve(SUMMARY);
            }))
            .mockResolvedValue(SUMMARY);
        const { lifecycle } = createHarness({ refreshLocal, now: () => clock });

        const stale = lifecycle.refresh({ reason: "stale" });
        clock = NOW + 5000;
        const forced = lifecycle.refresh({ reason: "manual", force: true });
        clock = NOW + 30000;
        finishFirst();
        await Promise.all([stale, forced]);

        expect(refreshLocal).toHaveBeenCalledTimes(2);
        expect(refreshLocal.mock.calls[1][0]).toMatchObject({ force: true, requestedAt: NOW + 5000 });
    });

    it("folds repeat requests into one queued pass that honours the latest", async () => {
        let clock = NOW;
        let finishFirst;
        const refreshLocal = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => {
                finishFirst = () => resolve(SUMMARY);
            }))
            .mockResolvedValue(SUMMARY);
        const { lifecycle } = createHarness({ refreshLocal, now: () => clock });

        const stale = lifecycle.refresh({ reason: "stale" });
        clock = NOW + 1000;
        const first = lifecycle.refresh({ force: true });
        clock = NOW + 2000;
        const second = lifecycle.refresh({ force: true });
        finishFirst();
        await Promise.all([stale, first, second]);

        expect(refreshLocal).toHaveBeenCalledTimes(2);
        expect(refreshLocal.mock.calls[1][0].requestedAt).toBe(NOW + 2000);
    });
});

describe("source edits", () => {
    it("queue behind a pass that read the settings before the edit", async () => {
        let finishFirst;
        const refreshLocal = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => {
                finishFirst = () => resolve(SUMMARY);
            }))
            .mockResolvedValue(SUMMARY);
        const { lifecycle } = createHarness({ refreshLocal });

        const stale = lifecycle.refresh({ reason: "stale" });
        const edited = lifecycle.refresh({ reason: "sources", sourcesChanged: true });
        finishFirst();
        await Promise.all([stale, edited]);

        expect(refreshLocal).toHaveBeenCalledTimes(2);
        expect(refreshLocal.mock.calls[1][0].force).toBeUndefined();
    });
});

describe("page fallback when the worker cannot be reached", () => {
    it("leaves a pass that is still beating to finish", async () => {
        const refreshLocal = vi.fn(async () => SUMMARY);
        const { lifecycle } = createHarness({
            refreshLocal,
            refreshRemote: async () => null,
            meta: { state: CACHE_STATE.working, heartbeatAt: NOW - 10 * 1000 }
        });

        const summary = await lifecycle.refresh({ force: true });

        expect(refreshLocal).not.toHaveBeenCalled();
        expect(summary).toMatchObject({ cacheVersion: VERSION, blockCount: 1 });
    });

    it("takes over a pass whose heartbeat has stopped", async () => {
        const refreshLocal = vi.fn(async () => SUMMARY);
        const { lifecycle } = createHarness({
            refreshLocal,
            refreshRemote: async () => null,
            meta: { state: CACHE_STATE.working, heartbeatAt: NOW - 10 * MINUTE }
        });

        await lifecycle.refresh({ force: true });

        expect(refreshLocal).toHaveBeenCalledTimes(1);
    });
});

describe("rate limit pauses", () => {
    it("gives up after repeated pauses and holds off for the stale window", async () => {
        const scheduleResume = vi.fn(async () => {});
        const cancelResume = vi.fn(async () => {});
        const { lifecycle, store } = createHarness({
            refreshLocal: vi.fn(async () => {
                throw rateLimited();
            }),
            scheduleResume,
            cancelResume
        });

        await expect(lifecycle.refresh()).rejects.toThrow("(429)");
        expect(store.meta).toMatchObject({ state: CACHE_STATE.cooldown, rateLimitPauses: 1, retryAt: NOW + MINUTE });

        await expect(lifecycle.refresh()).rejects.toThrow("(429)");
        expect(store.meta).toMatchObject({ state: CACHE_STATE.cooldown, rateLimitPauses: 2 });

        await expect(lifecycle.refresh()).rejects.toThrow("(429)");
        expect(store.meta).toMatchObject({
            state: CACHE_STATE.error,
            rateLimitPauses: 0,
            retryAt: 0,
            lastUpdated: NOW
        });
        expect(store.meta.lastError).toMatch("(429)");
        expect(scheduleResume).toHaveBeenCalledTimes(2);
        expect(cancelResume).toHaveBeenCalledTimes(1);
    });

    it("starts counting again after a pass completes", async () => {
        const { lifecycle, store } = createHarness({ meta: { rateLimitPauses: 2 } });

        await lifecycle.refresh();

        expect(store.meta.rateLimitPauses).toBe(0);
    });
});

describe("empty cache readiness", () => {
    const emptyCacheHarness = (meta, refreshRemote = vi.fn(async () => SUMMARY)) => ({
        refreshRemote,
        ...createHarness({
            cache: { blockIds: [], completedAt: 0 },
            meta,
            refreshRemote,
            bootstrapStore: memoryBootstrapStore(),
            staleAfterMs: HOUR
        })
    });

    it("does not retry a failed first build from every new tab", async () => {
        const { lifecycle, refreshRemote } = emptyCacheHarness({ state: CACHE_STATE.error, lastUpdated: NOW - 5 * MINUTE });

        const result = await lifecycle.ensureReady();

        expect(result.refreshed).toBe(false);
        expect(refreshRemote).not.toHaveBeenCalled();
    });

    it("retries a failed first build once the stale window has passed", async () => {
        const { lifecycle, refreshRemote } = emptyCacheHarness({ state: CACHE_STATE.error, lastUpdated: NOW - 2 * HOUR });

        const result = await lifecycle.ensureReady();

        expect(result.refreshed).toBe(true);
        expect(refreshRemote).toHaveBeenCalledTimes(1);
    });

    it("waits out a rate limit pause before building", async () => {
        const { lifecycle, refreshRemote } = emptyCacheHarness({ state: CACHE_STATE.cooldown, retryAt: NOW + MINUTE });

        await lifecycle.ensureReady();

        expect(refreshRemote).not.toHaveBeenCalled();
    });

    it("builds a cache that has never been attempted", async () => {
        const { lifecycle, refreshRemote } = emptyCacheHarness({ state: CACHE_STATE.idle, lastUpdated: 0 });

        await lifecycle.ensureReady();

        expect(refreshRemote).toHaveBeenCalledTimes(1);
    });
});
