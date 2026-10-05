import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../extension/scripts/rate-limiter.js", () => ({
    acquireRequestSlot: async () => {},
    releaseRequestSlot: () => {},
    observeRateLimit: () => {},
    noteRateLimitExhausted: () => {}
}));

import { fetchArenaJson } from "../extension/scripts/arena-client.js";

const serverError = () => new Response("down", { status: 503, statusText: "Service Unavailable" });

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("fetchArenaJson", () => {
    it("retries a server error once and then gives up", async () => {
        const fetch = vi.fn(async () => serverError());
        vi.stubGlobal("fetch", fetch);

        const request = fetchArenaJson("/channels/one");
        const settled = expect(request).rejects.toThrow("(503)");
        await vi.runAllTimersAsync();
        await settled;

        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("does not retry a 403", async () => {
        const fetch = vi.fn(async () => new Response("403 - Automated access blocked", { status: 403 }));
        vi.stubGlobal("fetch", fetch);

        await expect(fetchArenaJson("/channels/one")).rejects.toThrow("(403)");

        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
