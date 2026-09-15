"""Flag feeds that no longer track the site they belong to.

A site can keep publishing while its advertised feed sits frozen, which reads as
"never anything new" on the board — worse than having no feed at all, because it
looks like a working signal. Comparing the newest feed entry against the newest
date printed on the page catches that. Run when a link seems suspiciously quiet;
it is kept out of build-feeds.py because it doubles the fetching.

Usage: python3 scripts/audit-feeds.py
"""
import json, re, datetime
from concurrent.futures import ThreadPoolExecutor
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
ENTRY = re.compile(rb"<(?:pubDate|updated|published|dc:date)[^>]*>([^<]+)<", re.I)
ISO = re.compile(r"(20[12]\d)-(\d{2})-(\d{2})")
MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december"
LONG = re.compile(rf"({MONTHS})\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(20[12]\d)", re.I)
MON = {m: i + 1 for i, m in enumerate(
    "january february march april may june july august september october november december".split())}


def fetch(url, limit=1500000, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as f:
        return f.read(limit)


def parse_any(text):
    from email.utils import parsedate_to_datetime
    for fn in (parsedate_to_datetime, datetime.datetime.fromisoformat):
        try:
            at = fn(text.replace("Z", "+00:00") if fn is not parsedate_to_datetime else text)
            return at.replace(tzinfo=at.tzinfo or datetime.timezone.utc)
        except Exception:
            continue
    return None


def feed_newest(url):
    best = None
    for raw in ENTRY.findall(fetch(url)):
        at = parse_any(raw.decode("utf8", "ignore").strip())
        if at and (best is None or at > best):
            best = at
    return best


def page_newest(url):
    """Newest plausible publication date printed on the page.

    Only dates at or before today count: sites love to render future-dated
    copyright years and event listings, which would otherwise always win.
    """
    html = fetch(url).decode("utf8", "ignore")
    today = datetime.datetime.now(datetime.timezone.utc)
    seen = []
    for y, m, d in ISO.findall(html):
        try:
            seen.append(datetime.datetime(int(y), int(m), int(d), tzinfo=datetime.timezone.utc))
        except ValueError:
            pass
    for mon, d, y in LONG.findall(html):
        try:
            seen.append(datetime.datetime(int(y), MON[mon.lower()], int(d), tzinfo=datetime.timezone.utc))
        except ValueError:
            pass
    usable = [at for at in seen if at <= today]
    return max(usable) if usable else None


def audit(pair):
    link, feed = pair
    row = {"link": link, "feed": feed}
    try:
        row["feedNewest"] = (feed_newest(feed) or datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)).isoformat()
    except Exception as e:
        row["feedErr"] = type(e).__name__
    try:
        at = page_newest(link)
        row["pageNewest"] = at.isoformat() if at else None
    except Exception as e:
        row["pageErr"] = type(e).__name__
    return row


feeds = json.load(open("extension/data/feeds.json"))["feeds"]
pairs = list(feeds.items())
rows, n = [], 0
with ThreadPoolExecutor(max_workers=12) as pool:
    for row in pool.map(audit, pairs):
        rows.append(row); n += 1
        if n % 25 == 0:
            print(n, "/", len(pairs), flush=True)
json.dump(rows, open("docs/tmp/stale_audit.json", "w"), indent=1)

lagging = []
for r in rows:
    if not r.get("pageNewest") or "feedNewest" not in r:
        continue
    fn = datetime.datetime.fromisoformat(r["feedNewest"])
    pn = datetime.datetime.fromisoformat(r["pageNewest"])
    lag = (pn - fn).days
    if lag > 120:
        lagging.append((lag, r["link"], fn.date(), pn.date()))
print(f"\n{len(lagging)} feeds lag their page by >120 days:")
for lag, link, fn, pn in sorted(lagging, reverse=True)[:30]:
    print(f"  feed {fn}  page {pn}  (+{lag}d)  {link[:60]}")
