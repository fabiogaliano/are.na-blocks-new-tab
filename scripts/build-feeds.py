#!/usr/bin/env python3
"""Regenerate extension/data/feeds.json from the live Chromium bookmarks file.

Feed discovery is done here, once, rather than in the extension: the result is a
static bookmark-url -> feed-url map, so the extension never parses HTML or
guesses paths at runtime. Re-run after adding bookmarks.
"""
import json, re, sys, time
from pathlib import Path
from urllib.parse import urljoin, urlparse
from concurrent.futures import ThreadPoolExecutor
import urllib.request

BOOKMARKS = Path.home() / "Library/Application Support/net.imput.helium/Default/Bookmarks"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension/data/feeds.json"
MANIFEST = ROOT / "extension/manifest.json"
KEEP_HOSTS = ["https://api.are.na/*"]

# Folders whose links are worth polling. Everything else (icon sets, tools) has
# no publishing cadence, so probing it only costs time.
TARGET = ["reading", "people", "dev", "design", "learning", "mac & terminal", "film", "tana"]

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}
GUESS = ["/feed", "/rss", "/feed.xml", "/rss.xml", "/index.xml", "/atom.xml",
         "/feed/", "/blog/feed", "/feeds/posts/default"]
LINKRE = re.compile(rb"<link[^>]+>", re.I)


def get(url, limit=300000, timeout=12):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as f:
        return f.status, f.headers.get("Content-Type", ""), f.read(limit)


def looks_feed(body):
    head = body[:2000].lower()
    return b"<rss" in head or b"<feed" in head or b"<rdf" in head


# WordPress advertises a comments feed alongside the posts feed, and some sites
# (quanta) advertise only the comments one, under a url with no "comment" in it —
# so the link title has to be read too. A comments feed counts replies, not posts,
# which is never what the board wants; rejecting it lets the guessed paths run.
def is_comment_feed(url, title):
    return "comment" in url.lower() or "comment" in title.lower()


def discover_in(html, base):
    found = []
    for tag in LINKRE.findall(html):
        if b"alternate" not in tag.lower():
            continue
        ty = re.search(rb'type=["\']([^"\']+)', tag, re.I)
        href = re.search(rb'href=["\']([^"\']+)', tag, re.I)
        if not ty or not href:
            continue
        kind = ty.group(1).decode("utf8", "ignore").lower()
        if "rss" not in kind and "atom" not in kind:
            continue
        title = re.search(rb'title=["\']([^"\']*)', tag, re.I)
        url = urljoin(base, href.group(1).decode("utf8", "ignore"))
        if is_comment_feed(url, title.group(1).decode("utf8", "ignore") if title else ""):
            continue
        found.append(url)
    return found


def verify(url):
    try:
        _, _, body = get(url, 20000)
        return looks_feed(body)
    except Exception:
        return False


def github_feed(url):
    """github repos advertise no feed, but always expose atom endpoints.

    releases.atom answers 200 with zero entries for repos that never cut a
    release, so an empty body has to fall through to the commit log.
    """
    parts = urlparse(url)
    if parts.netloc.replace("www.", "").lower() != "github.com":
        return None
    seg = [s for s in parts.path.split("/") if s]
    if len(seg) == 1:
        cand = [f"https://github.com/{seg[0]}.atom"]
    elif len(seg) >= 2:
        owner, repo = seg[0], seg[1]
        cand = [f"https://github.com/{owner}/{repo}/releases.atom",
                f"https://github.com/{owner}/{repo}/commits/main.atom",
                f"https://github.com/{owner}/{repo}/commits/master.atom"]
    else:
        return None
    for feed in cand:
        try:
            _, _, body = get(feed, 8000)
            if b"<entry" in body:
                return feed
        except Exception:
            pass
    return None


def find_feed(url):
    special = github_feed(url)
    if special:
        return special
    origin = "{0.scheme}://{0.netloc}".format(urlparse(url))
    try:
        _, ctype, body = get(url)
    except Exception:
        body, ctype = b"", ""
    if body and "html" in ctype.lower():
        for feed in discover_in(body, url):
            if verify(feed):
                return feed
    if origin.rstrip("/") != url.rstrip("/"):
        try:
            _, ctype, body = get(origin)
            if "html" in ctype.lower():
                for feed in discover_in(body, origin):
                    if verify(feed):
                        return feed
        except Exception:
            pass
    # A quarter of working feeds are advertised nowhere, so the common paths
    # still have to be tried by hand.
    for path in GUESS:
        try:
            _, _, body = get(origin + path, 20000, 8)
            if looks_feed(body):
                return origin + path
        except Exception:
            pass
    return None


# Feed urls are stored post-redirect: the manifest grants host permissions per
# origin, and Chrome's CORS bypass does not survive a redirect to an origin the
# extension was never granted — the fetch dies with a CORS error instead.
def canonical(url):
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=12) as f:
            f.read(20000)
            final = f.url
    except Exception:
        return url
    # An http landing spot would have to be granted as an http origin; most hosts
    # serve the same feed over https, so prefer that when it answers.
    if final.startswith("http://"):
        secure = "https://" + final[len("http://"):]
        if verify(secure):
            return secure
    return final


def resolve_all(mapping, label):
    targets = sorted(set(mapping.values()))
    if not targets:
        return mapping
    print(f"resolving redirects for {len(targets)} {label}", flush=True)
    with ThreadPoolExecutor(max_workers=16) as pool:
        resolved = dict(zip(targets, pool.map(canonical, targets)))
    for before, after in resolved.items():
        if after != before:
            print(f"  {before} -> {after}")
    return {link: resolved[url] for link, url in mapping.items()}


ENTRY_DATE = re.compile(rb"<(?:pubDate|updated|published|dc:date)[^>]*>([^<]+)<", re.I)


def newest_entry(feed_url):
    """Newest entry timestamp, or None when the feed carries no usable dates.

    Mirrors the regex the extension uses, so a feed that survives here is one the
    board can actually count posts from.
    """
    try:
        _, _, body = get(feed_url, 200000)
    except Exception:
        return None
    from email.utils import parsedate_to_datetime
    import datetime
    best = None
    for raw in ENTRY_DATE.findall(body):
        text = raw.decode("utf8", "ignore").strip()
        for parse in (parsedate_to_datetime, datetime.datetime.fromisoformat):
            try:
                at = parse(text.replace("Z", "+00:00") if parse is not parsedate_to_datetime else text)
                if at.tzinfo is None:
                    at = at.replace(tzinfo=datetime.timezone.utc)
                best = at if best is None or at > best else best
                break
            except Exception:
                continue
    return best


def walk(node, path):
    for child in node.get("children", []):
        if child.get("type") == "url":
            yield path, child["url"]
        else:
            name = child.get("name", "")
            yield from walk(child, f"{path}/{name}" if path else name)


def main():
    data = json.loads(BOOKMARKS.read_text())
    seen, links = set(), []
    for path, url in walk(data["roots"]["bookmark_bar"], ""):
        low = path.lower()
        if not any(low == t or low.startswith(t + "/") for t in TARGET):
            continue
        if url in seen or not url.startswith("http"):
            continue
        seen.add(url)
        links.append(url)
    print(f"probing {len(links)} links", flush=True)

    feeds, done = {}, 0
    with ThreadPoolExecutor(max_workers=16) as pool:
        for url, feed in zip(links, pool.map(find_feed, links)):
            done += 1
            if feed:
                feeds[url] = feed
            if done % 50 == 0:
                print(f"  {done}/{len(links)} — {len(feeds)} feeds", flush=True)

    feeds = resolve_all(feeds, "feeds")

    import datetime
    now = datetime.datetime.now(datetime.timezone.utc)
    print(f"verifying {len(set(feeds.values()))} feeds", flush=True)
    newest = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        urls = list(feeds.keys())
        for url, at in zip(urls, pool.map(lambda u: newest_entry(feeds[u]), urls)):
            newest[url] = at

    # A feed with no parseable entry dates cannot answer "how many posts since I
    # last looked", so it is worse than no feed at all — it would show a dead pill.
    dropped = [u for u, at in newest.items() if at is None]
    for url in dropped:
        print(f"  dropped (no entry dates): {feeds[url]}")
        del feeds[url]

    stale = sorted(
        ((u, at) for u, at in newest.items() if at and (now - at).days > 365),
        key=lambda pair: pair[1]
    )
    if stale:
        print(f"  {len(stale)} feeds have not published in over a year (kept):")
        for url, at in stale[:10]:
            print(f"    {at.date()}  {feeds[url]}")

    # Page fallbacks are recorded by audit-feeds.py, not discovered here, so a
    # regeneration has to carry forward the ones whose bookmark still exists.
    previous = json.loads(OUT.read_text()).get("pages", {}) if OUT.exists() else {}
    pages = resolve_all({link: page for link, page in previous.items() if link in seen}, "page fallbacks")
    for link in pages:
        feeds.pop(link, None)

    OUT.write_text(json.dumps({
        "generatedAt": int(time.time() * 1000),
        "feeds": dict(sorted(feeds.items())),
        "pages": dict(sorted(pages.items()))
    }, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT} — {len(feeds)}/{len(links)} links have a feed, "
          f"{len(pages)} page fallbacks")
    # Host permissions are written from the same probe rather than declared as
    # <all_urls>: the extension only ever fetches feeds it already discovered.
    origins = sorted({"{0.scheme}://{0.netloc}/*".format(urlparse(u))
                      for u in list(feeds.values()) + list(pages.values())})
    manifest = json.loads(MANIFEST.read_text())
    manifest["host_permissions"] = KEEP_HOSTS + origins
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(origins)} feed origins written to manifest host_permissions")


if __name__ == "__main__":
    sys.exit(main())
