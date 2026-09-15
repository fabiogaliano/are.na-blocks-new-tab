#!/usr/bin/env python3
"""Build a reorganisation plan for the Helium bookmarks bar.

Reads Chromium's Bookmarks JSON, decides a target folder for every link from
the rule tables below, and writes a JSON plan plus a Markdown review copy to
docs/tmp/. The plan references Chromium ids, which are the same ids the
extension sees through the bookmarks API, so a runner can apply it later
without re-matching by URL. Nothing is written to the browser.

Usage: python3 scripts/bookmark-plan.py [path/to/Bookmarks]
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

BOOKMARKS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Library/Application Support/net.imput.helium/Default/Bookmarks"
OUT_DIR = Path(__file__).resolve().parent.parent / "docs/tmp"
SPACE = "knowledge exploration - Space"

# Whole current folders that map to one target. Matched on the path below the
# space folder, longest prefix wins, so a nested rule beats its parent.
FOLDER_RULES = {
    "visual": "design/inspiration",
    "visual/typography": "design/typography",
    "art exploration": "design/learning",
    "web design exploration": "design/learning",
    "Design Books": "design/learning",
    "design/icons": "design/icons",
    "design/grid system": "design/layout & css",
    "design/fluid typography": "design/typography",
    "product discovery": "to move/personal",
    "learning": "learning",
    "learning/hci": "design/learning",
    "dev/mymind: replica": "dev/hearted",
    "dev/computer vision": "archive/myhalo",
    "dev/aws": "dev/infra",
    "dev/spotify-playlist-generator app": "dev/practice",
    "dev/f. blog": "dev/blog",
    "zsa config": "mac & terminal/keyboard",
    "home server": "dev/infra",
    "movies film": "film",
    "p_pé": "to move/personal",
    "ls colors": "mac & terminal/shell",
    "FabricJs - intro": "dev/hearted",
    "coding": "dev/tooling",
    "tana": "tana",
    "myhalo": "archive/myhalo",
    "myhalo/research": "dev/hearted",
    "myhalo/infinite canvas": "dev/hearted",
    "remix": "dev/practice",
    "Top Apps": "launch",
}

# Per-link overrides, matched on a substring of the URL. These win over folder
# rules, so a link filed in the wrong folder today still lands correctly.
URL_RULES = [
    ("iconic.app", "design/icons"),
    ("pikaicons.com", "design/icons"),
    ("streamlinehq.com", "design/icons"),
    ("macosicons.com", "design/icons"),
    ("artofvisualdesign.com", "design/learning"),
    ("dribbble.com", "design/inspiration"),
    ("10m.co", "design/inspiration"),
    ("recent.design", "design/inspiration"),
    ("fluid-type-scale.com", "design/typography"),
    ("modern-fluid-typography", "design/typography"),
    ("aleksandrhovhannisyan.com", "design/typography"),
    ("typescale.com", "design/typography"),
    ("utopia.fyi", "design/typography"),
    ("monotype.com", "design/typography"),
    ("fontsinuse.com", "design/typography"),
    ("gorko", "design/layout & css"),
    ("css-tricks.com", "design/layout & css"),
    ("buildexcellentwebsit.es", "design/layout & css"),
    ("piccalil.li", "design/layout & css"),
    ("design-systems.github.io", "design/layout & css"),
    ("nostarch.com", "design/learning"),
    ("gamemath.com", "dev/practice"),
    ("cses.fi", "dev/practice"),
    ("coding-interview-university", "dev/practice"),
    ("hproctor.medium.com", "dev/practice"),
    ("goodreads.com", "dev/practice"),
    ("startupschool.org", "dev/practice"),
    ("bilibili.com", "dev/practice"),
    ("youtube.com/watch?v=", "dev/practice"),
    ("lexical", "dev/practice"),
    ("semanticscholar.org", "archive/myhalo"),
    ("medium.com/@", "archive/myhalo"),
    ("Computer Vision Top Projects", "archive/myhalo"),
    ("roboflow.com", "archive/myhalo"),
    ("replit.com", "mac & terminal/keyboard"),
    ("mouseless.click", "mac & terminal/keyboard"),
    ("nikitabobko.github.io", "mac & terminal/keyboard"),
    ("JankyBorders", "mac & terminal/keyboard"),
    ("koekeishiya", "mac & terminal/keyboard"),
    ("Tim-W-James/.dotfiles", "mac & terminal/shell"),
    ("x.com/oops4041555", "mac & terminal"),
    ("evite.netlify.app", "dev/tooling"),
    ("better-sqlite3", "dev/tooling"),
    ("sqlean", "dev/tooling"),
    ("vueuse.org", "dev/tooling"),
    ("jlord.us", "dev/tooling"),
    ("electronjs", "dev/tooling"),
    ("pixijs", "dev/hearted"),
    ("canvas-engines-comparison", "dev/hearted"),
    ("Moodboard", "dev/hearted"),
    ("seald/nedb", "dev/hearted"),
    ("127.0.0.1:5173", "dev/hearted"),
    ("sst.dev", "dev/infra"),
    ("signin.aws.amazon.com", "dev/infra"),
    ("q=Coolify", "dev/infra"),
    ("signalvnoise.com", "dev/infra"),
    ("dev.to", "dev/infra"),
    ("console.cloud.google.com", "dev/ai"),
    ("Amphion", "dev/ai"),
    ("texttospeech", "dev/ai"),
    ("rhasspy/piper", "dev/ai"),
    ("StyleTTS2", "dev/ai"),
    ("replicate.com", "dev/ai"),
    ("dev.marblism.com", "dev/ai"),
    ("danielkossmann.com", "dev/ai"),
    ("tana.inc/docs", "tana"),
    ("21st.dev", "dev/tooling"),
    ("openclaw/skills", "dev/reading"),
    ("mitsuhiko.github.io", "dev/reading"),
    ("AIE Europe", "dev/reading"),
    ("engineeringblogs.xyz", "to move/news"),
    ("jimmyr.com", "to move/news"),
    ("techurls.com", "to move/news"),
    ("researchbuzz.me", "to move/news"),
    ("interestingengineering.com", "to move/news"),
    ("robohub.org", "to move/news"),
    ("dailyrotation.com", "to move/news"),
    ("old.reddit.com/r/portugal", "to move/news"),
    ("twitter_interests", "to move/personal"),
    ("byjus.com", "learning"),
    ("app.tana.inc", "film"),
    ("Movies & TV", "film"),
    ("access.mymind.com", "launch"),
    ("claude.ai/chat", "archive/myhalo"),
    ("claude.ai", "launch"),
    ("localhost", "launch"),
    ("fabiogaliano", "launch"),
]

# Links removed rather than moved. Duplicates are found automatically.
REMOVE_URL_PARTS = [
    "artofvisualdesign.com/open-house",
    "open.substack.com/pub/aella",
]

# Folders the strip should not show. Recorded in the plan so the extension
# setting can be seeded from it.
HIDDEN_FOLDERS = ["archive", "to move"]


def load_tree(path):
    return json.loads(path.read_text())["roots"]["bookmark_bar"]


def iter_links(node, path=()):
    for child in node.get("children", []):
        if child.get("type") == "folder":
            yield from iter_links(child, path + (child["name"] or "null",))
        else:
            yield child, path


def folder_target(path):
    rel = "/".join(path[1:]) if path and path[0] == SPACE else "/".join(path)
    best = None
    for prefix, target in FOLDER_RULES.items():
        if rel == prefix or rel.startswith(prefix + "/"):
            if best is None or len(prefix) > len(best[0]):
                best = (prefix, target)
    return best[1] if best else None


def url_target(link):
    hay = link["url"] + " " + link["name"]
    if link["url"].rstrip("/") == "https://github.com":
        return "launch"
    for needle, target in URL_RULES:
        if needle in hay:
            return target
    return None


def build_plan(bar):
    seen_urls = set()
    ops = []
    unplaced = []
    for link, path in iter_links(bar):
        url = link["url"]
        base = {"id": link["id"], "title": link["name"], "url": url, "from": "/".join(path)}
        if url in seen_urls:
            ops.append({"op": "remove", "reason": "duplicate", **base})
            continue
        seen_urls.add(url)
        if any(part in url for part in REMOVE_URL_PARTS):
            ops.append({"op": "remove", "reason": "dead page", **base})
            continue
        target = url_target(link) or folder_target(path)
        if target is None:
            unplaced.append(base)
            continue
        ops.append({"op": "move", "to": target, **base})
    return ops, unplaced


def write_outputs(ops, unplaced):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    folders = sorted({op["to"] for op in ops if op["op"] == "move"})
    plan = {
        "version": 1,
        "source": str(BOOKMARKS),
        "space": SPACE,
        "sourceFolder": SPACE,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "hiddenFolders": HIDDEN_FOLDERS,
        "folders": folders,
        "ops": ops,
        "unplaced": unplaced,
    }
    (OUT_DIR / "bookmark-plan-knowledge-exploration.json").write_text(json.dumps(plan, indent=2, ensure_ascii=False))

    lines = ["# Bookmark plan: knowledge exploration", "",
             f"Source: `{BOOKMARKS}`", "",
             f"Moves: {sum(op['op'] == 'move' for op in ops)}  ·  Removes: {sum(op['op'] == 'remove' for op in ops)}  ·  Unplaced: {len(unplaced)}", ""]
    lines += ["## Target tree", ""]
    by_target = {}
    for op in ops:
        if op["op"] == "move":
            by_target.setdefault(op["to"], []).append(op)
    for target in folders:
        items = by_target[target]
        lines.append(f"### {target} ({len(items)})")
        for op in items:
            host = urlparse(op["url"]).netloc.replace("www.", "")
            lines.append(f"- {op['title'][:70]}  ·  {host}  ←  {op['from'].replace(SPACE + '/', '') or 'bar'}")
        lines.append("")
    lines += ["## Removed", ""]
    for op in ops:
        if op["op"] == "remove":
            lines.append(f"- [{op['reason']}] {op['title'][:70]}  ·  {op['url'][:90]}")
    lines += ["", "## Unplaced", ""]
    for item in unplaced:
        lines.append(f"- {item['title'][:70]}  ·  {item['url'][:90]}  (in {item['from']})")
    (OUT_DIR / "bookmark-plan-knowledge-exploration.md").write_text("\n".join(lines) + "\n")
    return plan


if __name__ == "__main__":
    ops, unplaced = build_plan(load_tree(BOOKMARKS))
    plan = write_outputs(ops, unplaced)
    print(f"moves {sum(op['op'] == 'move' for op in ops)}, removes {sum(op['op'] == 'remove' for op in ops)}, unplaced {len(unplaced)}")
    for item in unplaced:
        print(f"  ? {item['title'][:60]}  {item['url'][:70]}  (in {item['from']})")
