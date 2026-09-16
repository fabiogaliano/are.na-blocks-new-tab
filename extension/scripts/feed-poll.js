import { FEED_FETCH_TIMEOUT_MS, FEED_POLL_BATCH, FEED_TTL_MS } from "./constants.js";
import { runtime } from "./extension-api.js";
import { mergeFeedResult, parseEntryDates, parsePageDates, pruneFeedEntries, selectDueFeeds } from "./feeds.js";
import { getFeedState, saveFeedState } from "./storage.js";

// Discovery runs offline in scripts/build-feeds.py, so the extension only ever
// reads the map it produced — no html parsing, no guessing paths at runtime.
let cachedSources = null;

async function loadSources() {
    if (cachedSources) {
        return cachedSources;
    }
    let parsed = null;
    try {
        parsed = await (await fetch(runtime.getURL("data/feeds.json"))).json();
    } catch {
        parsed = null;
    }
    const asMap = (value) => (value && typeof value === "object" ? value : {});
    cachedSources = { feeds: asMap(parsed?.feeds), pages: asMap(parsed?.pages) };
    return cachedSources;
}

// Both kinds resolve a bookmark to one url carrying dates, so the board can look up
// freshness without caring whether it came from a feed or from the page itself.
export async function loadFeedMap() {
    const { feeds, pages } = await loadSources();
    return { ...feeds, ...pages };
}

async function fetchFeed(url) {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
        redirect: "follow"
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
}

// Each pass writes as it goes: the worker can be evicted mid-batch, and the next
// alarm should pick up from the feeds that were already covered rather than redo them.
export async function pollFeeds({ batchSize = FEED_POLL_BATCH, ttlMs = FEED_TTL_MS, now = Date.now() } = {}) {
    const { feeds, pages } = await loadSources();
    const pageUrls = new Set(Object.values(pages));
    const feedUrls = [...new Set([...Object.values(feeds), ...pageUrls])];
    if (!feedUrls.length) {
        return { polled: 0, failed: 0, remaining: 0 };
    }

    const state = await getFeedState();
    let entries = pruneFeedEntries(state.entries, feedUrls);
    const due = selectDueFeeds(entries, feedUrls, { now, ttlMs, batchSize });

    let failed = 0;
    for (const feedUrl of due) {
        try {
            const body = await fetchFeed(feedUrl);
            const dates = pageUrls.has(feedUrl) ? parsePageDates(body) : parseEntryDates(body);
            entries = mergeFeedResult(entries, feedUrl, { dates, at: Date.now() });
        } catch (error) {
            failed += 1;
            entries = mergeFeedResult(entries, feedUrl, { at: Date.now(), error: error.message });
        }
        await saveFeedState({ entries, lastRunAt: Date.now() });
    }

    return {
        polled: due.length,
        failed,
        remaining: selectDueFeeds(entries, feedUrls, { now: Date.now(), ttlMs }).length
    };
}
