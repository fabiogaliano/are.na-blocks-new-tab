![are.na blocks new tab hero](image/Marquee%20promo%20tile.png)

# are.na blocks new tab

## Overview
This extension replaces the browser’s default new tab with a grid of random Are.na blocks sourced from your favourite channels. Out of the box it shows one block at a time pulled from the `ephemeral-visions` and `device-gadget` channels, and it keeps your existing bookmarks accessible with a scrollable strip and nested folder menus (overflowing items sit behind a `⋯` button).

## This fork
This is a personal fork of the original extension by Leon ([lok.computer](https://lok.computer), [@lok](https://are.na/lok) on Are.na). The original lives on [GitHub](https://github.com/l3ony2k/are.na-blocks-new-tab) and in the [Chrome Web Store](https://chromewebstore.google.com/detail/arena-blocks-new-tab/igojkfooklaplhnapbafjobcamcedieo).

What differs from the original:
- Bookmarks became a full board with stacked pinned, main and archive surfaces, folder options, a trash view and a recent rail, replacing the single top strip.
- Bookmarks show unread post counts from RSS/Atom feeds, refreshed by a background alarm.
- The block cache lives in IndexedDB instead of a single storage key, so it is no longer capped by the storage quota.
- Channel refreshes run incrementally, report progress and resume partial passes after an interruption.
- Are.na requests are throttled to stay inside the observed rate limits.
- Up to 8 blocks per new tab, and clicking a tile opens its Are.na page.
- Settings open in a slide-over from the new tab.

## Installation
- **Chrome Web Store:** Visit the listing for “are.na blocks new tab” and click `Add to Chrome`. The extension starts working immediately after the install prompt.
- **Manual install (development builds):**
  1. Clone or download this repository.
  2. Open `chrome://extensions/`, enable *Developer mode*, and choose *Load unpacked*.
  3. Select the `extension/` directory to load the unpacked build. Reload the page after pulling updates.

## Using the New Tab
- Open a new tab to see a fresh block; the layout adapts automatically to the viewport and your display settings.
- Use the bookmark strip across the top to launch saved links or drill into folders. If the strip overflows the header, the `⋯` button reveals the hidden bookmarks in the same dropdown style as nested folders.
- The footer shows the current cache status message and links to the settings page. On the first launch the extension saves the default settings and immediately refreshes the cache so the grid is never blank.

## Unread post counts
- Bookmarks in the reading, people, dev, design, learning, mac & terminal, film and tana
  folders show a count of posts published since you last opened them, sourced from the
  site's RSS/Atom feed. Folders sum the counts of everything inside them.
- Feed discovery runs offline, not in the extension. `extension/data/feeds.json` maps a
  bookmark url to its feed, and the generator also rewrites `host_permissions` in the
  manifest so the extension can only reach feeds it already found.
- Re-run it after adding bookmarks: `python3 scripts/build-feeds.py` (Helium may stay open;
  the script only reads the bookmarks file). Reload the unpacked extension afterwards so
  the new manifest permissions take effect.
- A background alarm polls a slice of the feed list every 30 minutes, refreshing any feed
  older than 6 hours. Links whose site publishes no feed simply show no count.

## Settings Page
- **Content Sources:** Configure channel slugs, specific block IDs, and the block types (filters) to include. Click **Save & Refresh** to store the changes and fetch a fresh cache in one step.
- **Display:** Adjust block amount and size, theme, bar components, and supporting block information. Click **Save display settings** to apply without triggering a cache refresh.
- **Global actions:** Use **Reset to defaults** to load the out-of-box configuration into the form (Image/Text filters, default channels, one block, auto sizing).

## Screenshots

| light | dark |
| --- | --- |
| ![Block layout sample w1](image/small/w1.png) | ![Block layout sample b2](image/small/b2.png) |
| ![Block layout sample w3](image/small/w3.png) | ![Block layout sample b4](image/small/b4.png) |
| ![Block layout sample w5](image/small/w5.png) | ![Block layout sample b6](image/small/b6.png) |
| ![Block layout sample ws](image/small/ws.png) | ![Block layout sample bs](image/small/bs.png) |
