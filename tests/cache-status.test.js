import { describe, expect, it } from "vitest";
import { CACHE_STATE } from "../extension/scripts/constants.js";
import {
    describeCacheStatus,
    formatResumeDelay,
    getCacheLed,
    getSyncPercent
} from "../extension/scripts/cache-status.js";

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe("getSyncPercent", () => {
    it("rounds progress to a whole percentage", () => {
        expect(getSyncPercent({ channelsDone: 2, channelsTotal: 5 })).toBe(40);
        expect(getSyncPercent({ channelsDone: 1, channelsTotal: 3 })).toBe(33);
    });

    it("returns null without a usable total", () => {
        expect(getSyncPercent(null)).toBeNull();
        expect(getSyncPercent({ channelsTotal: 0 })).toBeNull();
        expect(getSyncPercent({ channelsTotal: "many" })).toBeNull();
    });

    it("clamps a done count that overshoots the total", () => {
        expect(getSyncPercent({ channelsDone: 9, channelsTotal: 4 })).toBe(100);
        expect(getSyncPercent({ channelsDone: -3, channelsTotal: 4 })).toBe(0);
    });
});

describe("formatResumeDelay", () => {
    it("keeps seconds under a minute", () => {
        expect(formatResumeDelay(45 * 1000)).toBe("resumes in 45 sec");
    });

    it("rounds minutes up so it never promises an early resume", () => {
        expect(formatResumeDelay(2 * MINUTE)).toBe("resumes in 2 min");
        expect(formatResumeDelay(61 * 1000)).toBe("resumes in 2 min");
        expect(formatResumeDelay(60 * 1000)).toBe("resumes in 1 min");
    });

    it("reports an elapsed window as resuming now", () => {
        expect(formatResumeDelay(0)).toBe("resuming now");
        expect(formatResumeDelay(-5000)).toBe("resuming now");
    });
});

describe("getCacheLed", () => {
    it("prefers the lifecycle state over cache age", () => {
        expect(getCacheLed({ state: CACHE_STATE.error, lastUpdated: NOW, now: NOW })).toBe("error");
        expect(getCacheLed({ state: CACHE_STATE.cooldown, lastUpdated: NOW, now: NOW })).toBe("cooldown");
        expect(getCacheLed({ state: CACHE_STATE.working, lastUpdated: NOW, now: NOW })).toBe("working");
    });

    it("splits an idle cache on the one hour freshness window", () => {
        expect(getCacheLed({ lastUpdated: NOW - 59 * MINUTE, now: NOW })).toBe("fresh");
        expect(getCacheLed({ lastUpdated: NOW - 2 * HOUR, now: NOW })).toBe("stale");
        expect(getCacheLed({ lastUpdated: 0, now: NOW })).toBe("idle");
    });
});

describe("describeCacheStatus", () => {
    it("reports a sync as a percentage", () => {
        expect(describeCacheStatus({
            state: CACHE_STATE.working,
            progress: { channelsDone: 2, channelsTotal: 5 },
            now: NOW
        })).toEqual({ led: "working", label: "Syncing 40%" });
    });

    it("falls back to a bare sync label without progress", () => {
        expect(describeCacheStatus({ state: CACHE_STATE.working, now: NOW }).label).toBe("Syncing");
    });

    it("names Are.na as the reason a pass is paused", () => {
        expect(describeCacheStatus({
            state: CACHE_STATE.cooldown,
            retryAt: NOW + 2 * MINUTE,
            now: NOW
        })).toEqual({ led: "cooldown", label: "Paused by Are.na, resumes in 2 min" });
    });

    it("calls a recent cache up to date", () => {
        expect(describeCacheStatus({
            lastUpdated: NOW - 10 * MINUTE,
            blockCount: 42,
            now: NOW
        })).toEqual({ led: "fresh", label: "Up to date" });
    });

    it("names the age of a stale cache instead", () => {
        expect(describeCacheStatus({
            lastUpdated: NOW - 3 * HOUR,
            blockCount: 42,
            now: NOW
        })).toEqual({ led: "stale", label: "Updated 3 hrs ago" });
    });

    it("reports an empty cache", () => {
        expect(describeCacheStatus({ blockCount: 0, now: NOW }).label).toBe("No blocks yet");
    });

    it("surfaces the caller's error label", () => {
        expect(describeCacheStatus({
            state: CACHE_STATE.error,
            errorLabel: "Offline",
            now: NOW
        })).toEqual({ led: "error", label: "Offline" });
    });
});
