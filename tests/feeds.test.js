import { describe, expect, it } from "vitest";
import {
    countSince,
    parsePageDates,
    freshCountForLink,
    mergeFeedResult,
    newestOf,
    parseEntryDates,
    pruneFeedEntries,
    selectDueFeeds
} from "../extension/scripts/feeds.js";

const RSS = `<rss><channel>
  <lastBuildDate>Wed, 16 Sep 2026 09:00:00 GMT</lastBuildDate>
  <item><pubDate>Tue, 15 Sep 2026 10:00:00 GMT</pubDate></item>
  <item><pubDate>Mon, 14 Sep 2026 08:30:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<feed>
  <entry><updated>2026-09-15T10:00:00Z</updated></entry>
  <entry><published>2026-09-13T10:00:00Z</published></entry>
</feed>`;

describe("parseEntryDates", () => {
    it("reads RFC822 item dates newest first", () => {
        expect(parseEntryDates(RSS)).toEqual([
            Date.parse("Tue, 15 Sep 2026 10:00:00 GMT"),
            Date.parse("Mon, 14 Sep 2026 08:30:00 GMT")
        ]);
    });

    it("ignores lastBuildDate so a rebuilt feed is not mistaken for a new post", () => {
        expect(parseEntryDates(RSS)).not.toContain(Date.parse("Wed, 16 Sep 2026 09:00:00 GMT"));
    });

    it("reads atom updated and published", () => {
        expect(parseEntryDates(ATOM)).toEqual([
            Date.parse("2026-09-15T10:00:00Z"),
            Date.parse("2026-09-13T10:00:00Z")
        ]);
    });

    it("drops unparseable dates and duplicates", () => {
        const text = "<item><pubDate>not a date</pubDate></item>"
            + "<item><pubDate>2026-09-15T10:00:00Z</pubDate></item>"
            + "<item><pubDate>2026-09-15T10:00:00Z</pubDate></item>";
        expect(parseEntryDates(text)).toEqual([Date.parse("2026-09-15T10:00:00Z")]);
    });

    it("returns nothing for empty input", () => {
        expect(parseEntryDates("")).toEqual([]);
        expect(parseEntryDates(null)).toEqual([]);
    });
});

describe("parsePageDates", () => {
    const NOW = Date.parse("2026-09-15T00:00:00Z");

    it("reads ISO dates printed on the page", () => {
        expect(parsePageDates('<time datetime="2026-04-08">x</time>', NOW))
            .toEqual([Date.UTC(2026, 3, 8)]);
    });

    it("reads long-form dates with ordinal suffixes", () => {
        expect(parsePageDates("<p>April 8th, 2026</p>", NOW)).toEqual([Date.UTC(2026, 3, 8)]);
        expect(parsePageDates("<p>December 1 2025</p>", NOW)).toEqual([Date.UTC(2025, 11, 1)]);
    });

    it("drops future dates so copyright years do not win", () => {
        expect(parsePageDates("<footer>© 2030</footer><p>2026-04-08</p>", NOW))
            .toEqual([Date.UTC(2026, 3, 8)]);
    });

    it("sorts newest first and de-duplicates", () => {
        const html = "<p>2024-07-15</p><p>April 8th, 2026</p><p>2024-07-15</p>";
        expect(parsePageDates(html, NOW)).toEqual([Date.UTC(2026, 3, 8), Date.UTC(2024, 6, 15)]);
    });

    it("returns nothing when the page prints no dates", () => {
        expect(parsePageDates("<p>hello</p>", NOW)).toEqual([]);
        expect(parsePageDates(null, NOW)).toEqual([]);
    });
});

describe("countSince", () => {
    it("counts only entries strictly newer than the mark", () => {
        const dates = [300, 200, 100];
        expect(countSince(dates, 150)).toBe(2);
        expect(countSince(dates, 300)).toBe(0);
        expect(countSince(dates, 0)).toBe(3);
    });

    it("treats a missing mark as never opened", () => {
        expect(countSince([300], undefined)).toBe(1);
    });
});

describe("newestOf", () => {
    it("returns the highest timestamp, or zero when empty", () => {
        expect(newestOf([100, 300, 200])).toBe(300);
        expect(newestOf([])).toBe(0);
    });
});

describe("selectDueFeeds", () => {
    const entries = { a: { checkedAt: 500 }, b: { checkedAt: 100 } };

    it("puts never-polled feeds ahead of stale ones", () => {
        expect(selectDueFeeds(entries, ["a", "b", "c"], { now: 1000, ttlMs: 0 })).toEqual(["c", "b", "a"]);
    });

    it("skips feeds checked inside the ttl", () => {
        expect(selectDueFeeds(entries, ["a", "b"], { now: 1000, ttlMs: 600 })).toEqual(["b"]);
    });

    it("caps the batch", () => {
        expect(selectDueFeeds(entries, ["a", "b", "c"], { now: 1000, ttlMs: 0, batchSize: 2 })).toEqual(["c", "b"]);
    });

    it("de-duplicates the input", () => {
        expect(selectDueFeeds({}, ["a", "a"], { now: 1000 })).toEqual(["a"]);
    });
});

describe("mergeFeedResult", () => {
    it("records dates and the check time", () => {
        const next = mergeFeedResult({}, "f", { dates: [200], at: 900 });
        expect(next.f).toEqual({ checkedAt: 900, dates: [200] });
    });

    it("keeps the previous dates when a poll fails", () => {
        const first = mergeFeedResult({}, "f", { dates: [200], at: 900 });
        const next = mergeFeedResult(first, "f", { at: 1000, error: "boom" });
        expect(next.f.dates).toEqual([200]);
        expect(next.f.checkedAt).toBe(1000);
        expect(next.f.error).toBe("boom");
    });

    it("leaves other feeds untouched", () => {
        const next = mergeFeedResult({ other: { checkedAt: 1, dates: [] } }, "f", { dates: [], at: 2 });
        expect(next.other).toEqual({ checkedAt: 1, dates: [] });
    });
});

describe("freshCountForLink", () => {
    const feedMap = { "https://site.test/": "https://site.test/feed" };
    const entries = { "https://site.test/feed": { checkedAt: 1, dates: [300, 200] } };

    it("counts entries newer than the last open", () => {
        expect(freshCountForLink(feedMap, entries, { url: "https://site.test/" }, 150)).toBe(2);
        expect(freshCountForLink(feedMap, entries, { url: "https://site.test/" }, 250)).toBe(1);
    });

    it("reports nothing for a link with no discovered feed", () => {
        expect(freshCountForLink(feedMap, entries, { url: "https://other.test/" }, 0)).toBe(0);
    });

    it("reports nothing when the feed has not been polled yet", () => {
        expect(freshCountForLink(feedMap, {}, { url: "https://site.test/" }, 0)).toBe(0);
    });
});

describe("pruneFeedEntries", () => {
    it("drops entries for feeds no longer in the map", () => {
        const entries = { a: { checkedAt: 1 }, b: { checkedAt: 2 } };
        expect(pruneFeedEntries(entries, ["b"])).toEqual({ b: { checkedAt: 2 } });
    });
});
