// Entry dates are pulled with a regex rather than DOMParser: a service worker has
// no DOM, and an offscreen document is a lot of machinery for the one field the
// board reads. `lastBuildDate` is deliberately absent — it describes the channel,
// not an entry, so counting it would make every feed look freshly published.
const ENTRY_DATE = /<(?:pubDate|updated|published|dc:date)[^>]*>([^<]+)</gi;

const MAX_DATES = 60;

export function parseEntryDates(text) {
    const dates = [];
    for (const match of `${text || ""}`.matchAll(ENTRY_DATE)) {
        const at = Date.parse(match[1].trim());
        if (Number.isFinite(at)) {
            dates.push(at);
        }
    }
    return [...new Set(dates)].sort((a, b) => b - a).slice(0, MAX_DATES);
}

const ISO_DATE = /(20[1-9]\d)-(\d{2})-(\d{2})/g;
const MONTHS = ["january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"];
const LONG_DATE = new RegExp(`(${MONTHS.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20[1-9]\\d)`, "gi");

// Used for the handful of sites whose advertised feed stopped tracking them: the
// dates printed on the page are the only remaining signal. Future dates are
// dropped because copyright years and event listings would otherwise always win.
export function parsePageDates(html, now = Date.now()) {
    const text = `${html || ""}`;
    const dates = [];
    for (const [, year, month, day] of text.matchAll(ISO_DATE)) {
        dates.push(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    }
    for (const [, month, day, year] of text.matchAll(LONG_DATE)) {
        dates.push(Date.UTC(Number(year), MONTHS.indexOf(month.toLowerCase()), Number(day)));
    }
    return [...new Set(dates.filter((at) => Number.isFinite(at) && at <= now))]
        .sort((a, b) => b - a)
        .slice(0, MAX_DATES);
}

export function newestOf(dates) {
    return (dates || []).reduce((newest, at) => (at > newest ? at : newest), 0);
}

export function countSince(dates, since) {
    const floor = Number(since || 0);
    return (dates || []).filter((at) => at > floor).length;
}

// A feed the board has never polled sorts ahead of a stale one, so the first runs
// spend their budget covering ground instead of refreshing what is already known.
export function selectDueFeeds(entries, feedUrls, { now = Date.now(), ttlMs = 0, batchSize = Infinity } = {}) {
    return [...new Set(feedUrls || [])]
        .map((url) => ({ url, checkedAt: Number(entries?.[url]?.checkedAt || 0) }))
        .filter(({ checkedAt }) => now - checkedAt >= ttlMs)
        .sort((a, b) => a.checkedAt - b.checkedAt)
        .slice(0, batchSize)
        .map(({ url }) => url);
}

export function mergeFeedResult(entries, feedUrl, { dates = null, at = Date.now(), error = null } = {}) {
    const previous = entries?.[feedUrl];
    return {
        ...entries,
        // A failed poll keeps the dates it managed to read last time, so one flaky
        // response does not blank out a pill that was correct a minute ago.
        [feedUrl]: {
            checkedAt: at,
            dates: dates || previous?.dates || [],
            ...(error ? { error: String(error) } : {})
        }
    };
}

// Feeds are keyed by the bookmark url they were discovered for, so a link with no
// entry in the generated map simply has no freshness to report.
export function freshCountForLink(feedMap, entries, link, openedAt = 0) {
    const feedUrl = feedMap?.[link?.url];
    if (!feedUrl) {
        return 0;
    }
    return countSince(entries?.[feedUrl]?.dates, openedAt);
}

export function pruneFeedEntries(entries, feedUrls) {
    const keep = new Set(feedUrls || []);
    return Object.fromEntries(Object.entries(entries || {}).filter(([url]) => keep.has(url)));
}
