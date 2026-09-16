#!/usr/bin/env python3
"""Delete bookmarks by exact url. Helium must be quit.

Usage: python3 scripts/remove-links.py [--dry-run]
"""
import hashlib, json, os, shutil, sys, time

TARGET = os.path.expanduser("~/Library/Application Support/net.imput.helium/Default/Bookmarks")

# Search-result pages and already-read articles: artefacts of a session, filed
# where sites belong. theunreasonable.com stays — dormant but still good material.
REMOVE_CONTAINS = [
    "google.com/search",
    "fstoppers.com/architecture/copyright-rules-new-nyc-landmark",
    "open.substack.com/pub/aella",
    "marginalrevolution.com/marginalrevolution/2024/03/austin-vernon-on-utilities",
]


def prune(node, removed):
    kept = []
    for child in node.get("children", []):
        if child["type"] == "url":
            if any(token in child["url"] for token in REMOVE_CONTAINS):
                removed.append((child["name"], child["url"]))
                continue
        else:
            prune(child, removed)
        kept.append(child)
    node["children"] = kept


def main():
    with open(TARGET) as f:
        data = json.load(f)
    removed = []
    prune(data["roots"]["bookmark_bar"], removed)
    for name, url in removed:
        print(f"  {name[:60]}")
    print(f"{len(removed)} removed")

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

    if "--dry-run" in sys.argv:
        print("DRY RUN — nothing written")
        return
    backup = f"{TARGET}.pre-remove-links-{time.strftime('%Y%m%d-%H%M%S')}.bak"
    shutil.copy2(TARGET, backup)
    with open(TARGET, "w") as f:
        json.dump(data, f, indent=3)
    print("backup:", backup)


if __name__ == "__main__":
    main()
