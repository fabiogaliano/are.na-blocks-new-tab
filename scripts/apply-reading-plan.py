#!/usr/bin/env python3
"""Rebuild reading/daily, add reading/product, and file the deep reads.

Mutates the live bookmarks file in place rather than rewriting the tree from a
snapshot, so anything changed in the browser since the last plan survives.
Helium must be quit: it writes the file back on exit and would clobber this.

Run with --dry-run first.
"""
import hashlib, json, os, shutil, sys, time, uuid

TARGET = os.path.expanduser("~/Library/Application Support/net.imput.helium/Default/Bookmarks")
NOW = str(int((time.time() + 11644473600) * 1_000_000))

DAILY_GROUPS = {
    "communities": [
        ("Hacker News", "https://news.ycombinator.com/"),
        ("Lobsters", "https://lobste.rs/"),
        ("Tildes", "https://tildes.net/"),
        ("MetaFilter", "https://www.metafilter.com/"),
    ],
    "applied ai & product": [
        ("Simon Willison", "https://simonwillison.net/"),
        ("Sean Goedecke", "https://www.seangoedecke.com/"),
        ("Armin Ronacher", "https://lucumr.pocoo.org/"),
        ("Thorsten Ball — Register Spill", "https://registerspill.thorstenball.com/"),
        ("Maggie Appleton", "https://maggieappleton.com/"),
        ("Latent Space", "https://www.latent.space/"),
        ("The Pragmatic Engineer", "https://blog.pragmaticengineer.com/"),
    ],
    "startups": [
        ("Sifted", "https://sifted.eu/"),
        ("EU-Startups", "https://www.eu-startups.com/"),
        ("Not Boring", "https://www.notboring.co/"),
        ("The Generalist", "https://www.generalist.com/"),
        ("Stratechery", "https://stratechery.com/"),
    ],
    "ideas & adjacent": [
        ("IEEE Spectrum", "https://spectrum.ieee.org/"),
        ("Construction Physics", "https://www.construction-physics.com/"),
        ("Astral Codex Ten", "https://www.astralcodexten.com/"),
        ("Engineering Blogs", "https://engineeringblogs.xyz/"),
    ],
}

PRODUCT = [
    ("PostHog", "https://posthog.com/blog"),
    ("Linear", "https://linear.app/blog"),
    ("Vercel", "https://vercel.com/blog"),
    ("Raycast", "https://www.raycast.com/blog"),
    ("Tana", "https://tana.inc/blog"),
    ("Figma", "https://www.figma.com/blog/"),
    ("Supabase", "https://supabase.com/blog"),
    ("Val Town", "https://blog.val.town/"),
    ("Replit", "https://blog.replit.com/"),
    ("Granola", "https://www.granola.ai/blog"),
]

ADDITIONS = {
    "reading/slow/knowledge": [
        ("Works in Progress", "https://worksinprogress.co/"),
        ("Asterisk Magazine", "https://asteriskmag.com/"),
        ("Noema Magazine", "https://www.noemamag.com/"),
        ("Aeon", "https://aeon.co/"),
        ("Palladium", "https://www.palladiummag.com/"),
        ("Ink & Switch", "https://www.inkandswitch.com/"),
    ],
    "reading/slow/science": [("Nautilus", "https://nautil.us/")],
    "people/dev": [
        ("Dan Luu", "https://danluu.com/"),
        ("Hillel Wayne", "https://www.hillelwayne.com/"),
        ("Julia Evans", "https://jvns.ca/"),
    ],
    "people/writing & thinking": [
        ("Geoffrey Litt", "https://www.geoffreylitt.com/"),
        ("Linus Lee", "https://thesephist.com/"),
        ("Amelia Wattenberger", "https://wattenberger.com/"),
        ("Alexander Obenauer", "https://alexanderobenauer.com/"),
    ],
}

# Moved rather than deleted: still worth reading, just not every morning.
MOVE_TO_SLOW_TECH = ["arstechnica.com", "wired.com", "technologyreview.com", "hackaday.com", "robohub.org"]
DELETE = ["theverge.com", "interestingengineering.com", "researchbuzz.me", "redef.com",
          "dailyrotation.com", "jimmyr.com", "techurls.com", "old.reddit.com/r/portugal"]


def load():
    with open(TARGET) as f:
        return json.load(f)


def find(node, name):
    for child in node.get("children", []):
        if child["type"] == "folder" and child["name"].lower() == name.lower():
            return child
    return None


def resolve(bar, path, create=False):
    node = bar
    for segment in path.split("/"):
        nxt = find(node, segment)
        if nxt is None:
            if not create:
                return None
            nxt = {"children": [], "date_added": NOW, "date_modified": NOW,
                   "guid": str(uuid.uuid4()), "id": None, "name": segment, "type": "folder"}
            node.setdefault("children", []).append(nxt)
        node = nxt
    return node


def urls_in(node):
    for child in node.get("children", []):
        if child["type"] == "url":
            yield child
        else:
            yield from urls_in(child)


def main():
    data = load()
    bar = data["roots"]["bookmark_bar"]
    report = []

    daily = resolve(bar, "reading/daily")
    if daily is None:
        sys.exit("reading/daily not found")

    existing = {child["url"]: child for child in daily.get("children", []) if child["type"] == "url"}

    # Re-use the original node when a link survives the rebuild, so its date_added
    # and guid stay put and the board does not flag it as newly bookmarked.
    def node_for(title, url):
        for known_url, node in existing.items():
            if known_url.rstrip("/") == url.rstrip("/"):
                node["name"] = title
                return node
        return {"date_added": NOW, "date_last_used": "0", "guid": str(uuid.uuid4()),
                "id": None, "name": title, "type": "url", "url": url}

    moved, deleted = [], []
    slow_tech = resolve(bar, "reading/slow/tech", create=True)
    for url, node in existing.items():
        low = url.lower()
        if any(m in low for m in MOVE_TO_SLOW_TECH):
            slow_tech["children"].append(node); moved.append(node["name"])
        elif any(d in low for d in DELETE):
            deleted.append(node["name"])
    report.append(f"moved to reading/slow/tech: {len(moved)}")
    report.append(f"deleted: {len(deleted)}")

    daily["children"] = []
    for group, links in DAILY_GROUPS.items():
        folder = {"children": [node_for(t, u) for t, u in links], "date_added": NOW,
                  "date_modified": NOW, "guid": str(uuid.uuid4()), "id": None,
                  "name": group, "type": "folder"}
        daily["children"].append(folder)
    report.append(f"reading/daily: {len(DAILY_GROUPS)} groups, "
                  f"{sum(len(v) for v in DAILY_GROUPS.values())} links")

    product = resolve(bar, "reading/product", create=True)
    have = {c["url"].rstrip("/") for c in product.get("children", []) if c["type"] == "url"}
    for title, url in PRODUCT:
        if url.rstrip("/") not in have:
            product["children"].append(node_for(title, url))
    report.append(f"reading/product: {len(product['children'])} links")

    for path, links in ADDITIONS.items():
        folder = resolve(bar, path, create=True)
        have = {c["url"].rstrip("/") for c in urls_in(folder)}
        added = 0
        for title, url in links:
            if url.rstrip("/") not in have:
                folder["children"].append(node_for(title, url)); added += 1
        report.append(f"{path}: +{added}")

    # Ids must be unique across the whole file, so they are reassigned in one pass
    # after every structural edit rather than guessed while building.
    counter = [0]

    def renumber(node):
        for child in node.get("children", []):
            counter[0] += 1
            child["id"] = str(counter[0])
            if child["type"] == "folder":
                renumber(child)

    for key in ("bookmark_bar", "other", "synced"):
        root = data["roots"].get(key)
        if isinstance(root, dict):
            counter[0] += 1
            root["id"] = str(counter[0])
            renumber(root)
    data["roots"]["bookmark_bar"]["id"] = "1"

    md5 = hashlib.md5()

    def walk(node):
        md5.update(node["id"].encode()); md5.update(node["name"].encode())
        if node["type"] == "url":
            md5.update(b"url"); md5.update(node["url"].encode())
        else:
            md5.update(b"folder")
            for child in node.get("children", []):
                walk(child)

    for key in ("bookmark_bar", "other", "synced"):
        root = data["roots"].get(key)
        if isinstance(root, dict):
            walk(root)
    data["checksum"] = md5.hexdigest()

    total = sum(1 for _ in urls_in(bar))
    print("\n".join(report))
    print(f"total links in bar: {total}")
    if "--dry-run" in sys.argv:
        print("DRY RUN — nothing written")
        return
    backup = f"{TARGET}.pre-reading-plan-{time.strftime('%Y%m%d-%H%M%S')}.bak"
    shutil.copy2(TARGET, backup)
    with open(TARGET, "w") as f:
        json.dump(data, f, indent=3)
    print("backup:", backup)
    print("written:", TARGET)


if __name__ == "__main__":
    main()
