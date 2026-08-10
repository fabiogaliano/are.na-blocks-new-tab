import { ARENA_API_ROOT } from "./constants.js";
import { acquireRequestSlot, noteRateLimitExhausted, observeRateLimit, releaseRequestSlot } from "./rate-limiter.js";

const JSON_HEADERS = { Accept: "application/json" };
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;

// A worker cannot reliably survive a Retry-After timeout. The cache lifecycle
// persists `retryAt` and resumes the request through an alarm.
const MAX_RATE_LIMIT_DELAY = 90 * 1000;
const DEFAULT_RATE_LIMIT_DELAY = 60 * 1000;
const RATE_LIMIT_JITTER = 300;

const delay = (ms, signal) => new Promise((resolve, reject) => {
    const abortError = () => signal.reason || new DOMException("Aborted", "AbortError");

    if (signal?.aborted) {
        reject(abortError());
        return;
    }

    const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
    }, ms);

    const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
});

const parseRetryAfterHeader = (value) => {
    if (!value) {
        return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return seconds * 1000;
    }

    const httpDate = Date.parse(value);
    return Number.isFinite(httpDate) ? httpDate - Date.now() : null;
};

const parseRetryAfterBody = (body) => {
    let seconds;
    try {
        const payload = JSON.parse(body);
        seconds = Number(payload?.error?.retry_after ?? payload?.retry_after);
    } catch (_) {
        return null;
    }
    return Number.isFinite(seconds) ? seconds * 1000 : null;
};

const parseResetHeader = (value) => {
    const resetAt = Number(value);
    return Number.isFinite(resetAt) && resetAt > 0 ? resetAt * 1000 - Date.now() : null;
};

const getRateLimitDelay = (response, body) => {
    const requested = parseRetryAfterHeader(response.headers.get("Retry-After"))
        ?? parseRetryAfterBody(body)
        ?? parseResetHeader(response.headers.get("x-ratelimit-reset"))
        ?? DEFAULT_RATE_LIMIT_DELAY;

    const bounded = Math.min(Math.max(requested, 0), MAX_RATE_LIMIT_DELAY);
    return bounded + Math.random() * RATE_LIMIT_JITTER;
};

const buildQuery = (params = {}) => {
    const searchParams = new URLSearchParams();

    Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") {
            return;
        }
        searchParams.set(key, `${value}`);
    });

    const query = searchParams.toString();
    return query ? `?${query}` : "";
};

const buildHeaders = (token) => {
    const headers = { ...JSON_HEADERS };
    if (typeof token === "string" && token.trim()) {
        headers.Authorization = `Bearer ${token.trim()}`;
    }
    return headers;
};

export const fetchArenaJson = async (path, { signal, token } = {}) => {
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            await acquireRequestSlot(signal);

            let response;
            let body = "";
            let waitMs = 0;
            let retryAt = 0;

            try {
                response = await fetch(`${ARENA_API_ROOT}${path}`, {
                    headers: buildHeaders(token),
                    signal
                });

                if (!response.ok) {
                    body = await response.text().catch(() => "");
                    if (response.status === 429) {
                        waitMs = getRateLimitDelay(response, body);
                        retryAt = Date.now() + waitMs;
                        noteRateLimitExhausted(retryAt);
                    }
                }

                observeRateLimit(response);
            } finally {
                releaseRequestSlot();
            }

            if (!response.ok) {
                const message = body.length > 120 ? `${body.slice(0, 117)}...` : body;

                const error = new Error(`Are.na request failed (${response.status}): ${message || response.statusText}`);
                error.status = response.status;

                if (response.status === 429) {
                    error.retryAt = retryAt;
                    throw error;
                }

                if (response.status >= 500 && attempt < MAX_RETRIES) {
                    await delay(RETRY_BASE_DELAY * Math.pow(2, attempt), signal);
                    continue;
                }

                throw error;
            }

            return response.json();
        } catch (error) {
            lastError = error;

            if (signal?.aborted || error.name === "AbortError") {
                throw error;
            }

            const isNetworkError = !error.status && (
                error.message?.includes("fetch") ||
                error.message?.includes("network") ||
                error.name === "TypeError"
            );

            if (isNetworkError && attempt < MAX_RETRIES) {
                await delay(RETRY_BASE_DELAY * Math.pow(2, attempt), signal);
                continue;
            }

            throw error;
        }
    }

    throw lastError;
};

export const fetchArenaChannel = (id, options = {}) =>
    fetchArenaJson(`/channels/${encodeURIComponent(id)}`, options);

export const fetchArenaChannelContentsPage = (id, { page = 1, per = 100, sort = "position_asc", userId, ...options } = {}) =>
    fetchArenaJson(
        `/channels/${encodeURIComponent(id)}/contents${buildQuery({
            page,
            per,
            sort,
            user_id: userId
        })}`,
        options
    );

export const fetchArenaBlock = (id, options = {}) =>
    fetchArenaJson(`/blocks/${encodeURIComponent(id)}`, options);

export const fetchArenaMe = (options = {}) =>
    fetchArenaJson("/me", options);

export const fetchArenaFeedPage = ({ limit = 100, next, prev, ...options } = {}) =>
    fetchArenaJson(
        `/me/feed${buildQuery({ limit, next, prev })}`,
        options
    );

export const fetchArenaUserContentsPage = (id, { page = 1, per = 100, sort = "updated_at_desc", type, ...options } = {}) =>
    fetchArenaJson(
        `/users/${encodeURIComponent(id)}/contents${buildQuery({ page, per, sort, type })}`,
        options
    );

export const fetchArenaUserFollowingPage = (id, { page = 1, per = 100, sort = "created_at_desc", type, ...options } = {}) =>
    fetchArenaJson(
        `/users/${encodeURIComponent(id)}/following${buildQuery({ page, per, sort, type })}`,
        options
    );
