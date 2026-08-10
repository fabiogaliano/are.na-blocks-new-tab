import { STORAGE_KEYS } from "./constants.js";
import { storage } from "./extension-api.js";

// Are.na sends no x-ratelimit-remaining header, so the client counts its own
// spend per window. The headroom absorbs requests made outside this JS context
// (another tab, the same token used elsewhere) that we cannot see.
const GUEST_LIMIT = 30;
const BUDGET_RATIO = 0.85;
const DEFAULT_WINDOW_MS = 60 * 1000;
const MAX_CONCURRENT = 4;
const WINDOW_PUMP_MARGIN_MS = 50;

const state = {
    limit: GUEST_LIMIT,
    tier: null,
    windowMs: DEFAULT_WINDOW_MS,
    resetAt: 0,
    spent: 0
};

const queue = [];
let inFlight = 0;
let windowTimer = null;
let restored = null;
let persistence = Promise.resolve();

const abortError = (signal) => signal.reason || new DOMException("Aborted", "AbortError");

// Exported so a cost estimate shown to the user is measured against the same
// headroom the queue actually enforces, not the raw ceiling Are.na advertises.
export const getRequestBudget = (limit) => Math.max(1, Math.floor(limit * BUDGET_RATIO));

const budget = () => getRequestBudget(state.limit);

const persist = () => {
    const snapshot = {
        limit: state.limit,
        tier: state.tier,
        windowMs: state.windowMs,
        resetAt: state.resetAt,
        spent: state.spent
    };

    persistence = persistence
        .then(() => storage.set({ [STORAGE_KEYS.rateLimit]: snapshot }))
        .catch((error) => console.warn("Could not store Are.na rate limit info", error));
};

const restore = () => {
    if (restored) {
        return restored;
    }

    restored = storage
        .get(STORAGE_KEYS.rateLimit)
        .then((raw) => {
            const stored = raw?.[STORAGE_KEYS.rateLimit];
            if (Number.isFinite(stored?.limit) && stored.limit > 0) {
                state.limit = stored.limit;
            }
            if (Number.isFinite(stored?.windowMs) && stored.windowMs > 0) {
                state.windowMs = stored.windowMs;
            }
            if (stored?.tier) {
                state.tier = stored.tier;
            }
            if (Number.isFinite(stored?.resetAt) && stored.resetAt > 0) {
                state.resetAt = stored.resetAt;
            }
            if (Number.isFinite(stored?.spent) && stored.spent > 0) {
                state.spent = stored.spent;
            }
        })
        .catch((error) => console.warn("Could not read stored Are.na rate limit info", error));

    return restored;
};

const rollWindow = () => {
    const now = Date.now();
    if (now < state.resetAt) {
        return false;
    }

    state.resetAt = now + state.windowMs;
    state.spent = 0;
    return true;
};

const pump = () => {
    let stateChanged = rollWindow();

    while (queue.length && inFlight < MAX_CONCURRENT && state.spent < budget()) {
        const waiter = queue.shift();
        state.spent += 1;
        inFlight += 1;
        stateChanged = true;
        waiter.admit();
    }

    if (stateChanged) {
        persist();
    }

    // A queue held back by the budget alone has no release to wake it.
    if (queue.length && state.spent >= budget() && !windowTimer) {
        windowTimer = setTimeout(() => {
            windowTimer = null;
            pump();
        }, Math.max(state.resetAt - Date.now(), 0) + WINDOW_PUMP_MARGIN_MS);
    }
};

export const acquireRequestSlot = async (signal) => {
    await restore();

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal));
            return;
        }

        const waiter = {};

        const onAbort = () => {
            const index = queue.indexOf(waiter);
            if (index >= 0) {
                queue.splice(index, 1);
            }
            if (!queue.length && windowTimer) {
                clearTimeout(windowTimer);
                windowTimer = null;
            }
            reject(abortError(signal));
        };

        waiter.admit = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        };

        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(waiter);
        pump();
    });
};

export const releaseRequestSlot = () => {
    inFlight = Math.max(inFlight - 1, 0);
    pump();
};

export const observeRateLimit = (response) => {
    const limit = Number(response.headers.get("x-ratelimit-limit"));
    const windowSeconds = Number(response.headers.get("x-ratelimit-window"));
    const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    const tier = response.headers.get("x-ratelimit-tier");

    let budgetChanged = false;

    if (Number.isFinite(limit) && limit > 0 && limit !== state.limit) {
        state.limit = limit;
        budgetChanged = true;
    }
    if (Number.isFinite(windowSeconds) && windowSeconds > 0 && windowSeconds * 1000 !== state.windowMs) {
        state.windowMs = windowSeconds * 1000;
        budgetChanged = true;
    }
    if (tier && tier !== state.tier) {
        state.tier = tier;
        budgetChanged = true;
    }

    if (Number.isFinite(resetAt) && resetAt > state.resetAt) {
        state.resetAt = resetAt;
        budgetChanged = true;
    }

    if (budgetChanged) {
        persist();
    }

    pump();
};

export const noteRateLimitExhausted = (resumeAt) => {
    if (Number.isFinite(resumeAt) && resumeAt > state.resetAt) {
        state.resetAt = resumeAt;
    }
    state.spent = budget();
    persist();
};
