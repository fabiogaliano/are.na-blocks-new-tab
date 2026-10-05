import { CACHE_STATE } from "./constants.js";
import { formatRelativeTime } from "./time.js";

// Past this the cache is still usable but no longer worth calling current, so
// the status names the age instead of claiming freshness.
const FRESH_WINDOW_MS = 60 * 60 * 1000;

// Are.na's edge answers traffic it takes for a bot with a 403 carrying this
// text, whatever the token. Reading it as an auth failure sends the user off to
// replace a token that works.
export function isAutomatedAccessBlock(message) {
    return typeof message === "string" && /\(403\)/.test(message) && /automated access blocked/i.test(message);
}

/**
 * Maps a stored refresh error to a label short enough for the cache status
 * button, so a raw HTML body or long message never overflows it.
 */
export function getCacheErrorLabel(message) {
    if (!message || typeof message !== "string") {
        return "Error";
    }

    if (isAutomatedAccessBlock(message)) {
        return "Blocked by Are.na";
    }

    const lower = message.toLowerCase();

    if (lower.includes("networkerror") || lower.includes("network error") ||
        lower.includes("failed to fetch") || lower.includes("dns") ||
        lower.includes("net::") || lower.includes("offline")) {
        return "Offline";
    }

    if (lower.includes("timeout") || lower.includes("aborted") ||
        lower.includes("abort") || lower.includes("timed out")) {
        return "Timeout";
    }

    if (/\(401\)/.test(message) || /\(403\)/.test(message)) {
        return "Auth error";
    }
    if (/\(404\)/.test(message) || lower.includes("not found")) {
        return "Not found";
    }
    if (/\(429\)/.test(message) || lower.includes("rate limit")) {
        return "Rate limited";
    }
    if (/\(5\d{2}\)/.test(message)) {
        return "Server error";
    }

    if (lower.includes("already in progress") || lower.includes("busy")) {
        return "Busy";
    }

    const stripped = message.replace(/<[^>]*>/g, "").trim();
    if (stripped.length > 20) {
        return stripped.slice(0, 17) + "...";
    }

    return stripped || "Error";
}

export function getSyncPercent(progress) {
    const total = Number(progress?.channelsTotal);
    if (!Number.isFinite(total) || total <= 0) {
        return null;
    }
    const done = Math.min(Math.max(Number(progress?.channelsDone) || 0, 0), total);
    return Math.round((done / total) * 100);
}

export function formatResumeDelay(ms) {
    // Rounded up so the status never promises a resume earlier than it happens.
    const seconds = Math.ceil((Number(ms) || 0) / 1000);
    if (seconds <= 0) {
        return "resuming now";
    }
    if (seconds < 60) {
        return `resumes in ${seconds} sec`;
    }
    const minutes = Math.ceil(seconds / 60);
    return `resumes in ${minutes} min`;
}

export function getCacheLed({ state = CACHE_STATE.idle, lastUpdated = 0, now = Date.now() } = {}) {
    if (state === CACHE_STATE.error) {
        return "error";
    }
    if (state === CACHE_STATE.cooldown) {
        return "cooldown";
    }
    if (state === CACHE_STATE.working) {
        return "working";
    }
    if (!lastUpdated) {
        return "idle";
    }
    return now - lastUpdated < FRESH_WINDOW_MS ? "fresh" : "stale";
}

/**
 * Single source of the cache wording shared by the new tab button and the
 * settings notice, so the same condition never reads two different ways.
 */
export function describeCacheStatus({
    state = CACHE_STATE.idle,
    progress = null,
    retryAt = 0,
    lastUpdated = 0,
    blockCount = 0,
    errorLabel = "Error",
    now = Date.now()
} = {}) {
    const led = getCacheLed({ state, lastUpdated, now });

    if (state === CACHE_STATE.working) {
        const percent = getSyncPercent(progress);
        return { led, label: percent === null ? "Syncing" : `Syncing ${percent}%` };
    }

    if (state === CACHE_STATE.cooldown) {
        return { led, label: `Paused by Are.na, ${formatResumeDelay((retryAt || 0) - now)}` };
    }

    if (state === CACHE_STATE.error) {
        return { led, label: errorLabel || "Error" };
    }

    if (!blockCount) {
        return { led, label: "No blocks yet" };
    }

    if (led === "stale") {
        return { led, label: `Updated ${formatRelativeTime(lastUpdated, now)}` };
    }

    return { led, label: "Up to date" };
}
