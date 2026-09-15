import { CACHE_STATE, STORAGE_KEYS } from "./constants.js";
import { formatCountdown, formatRelativeTime } from "./time.js";
import { storage } from "./extension-api.js";
import { chooseRandomBlockIds } from "./arena.js";
import { getBlocks } from "./block-store.js";
import { getSettings } from "./storage.js";
import { applyTheme } from "./theme.js";
import { runtimeCacheLifecycle } from "./cache-refresh.js";
import { getBlockMetaItems } from "./customization.js";
import { createBarRenderer } from "./bar-customization.js";
import { createBlockLayout } from "./block-layout.js";
import { classifySettingsChanges } from "./settings-model.js";
import { createBookmarksView } from "./bookmarks-view.js";

const RESIZE_DEBOUNCE = 150;
const COOLDOWN_TICK_MS = 1000;

/**
 * Maps error messages to short, button-friendly labels.
 * Prevents HTML or long text from overflowing the cache status button.
 */
const sanitizeErrorLabel = (message) => {
  if (!message || typeof message !== "string") {
    return "Error";
  }

  const lower = message.toLowerCase();

  // Network/connection errors
  if (lower.includes("networkerror") || lower.includes("network error") ||
    lower.includes("failed to fetch") || lower.includes("dns") ||
    lower.includes("net::") || lower.includes("offline")) {
    return "Offline";
  }

  // Timeout/abort errors
  if (lower.includes("timeout") || lower.includes("aborted") ||
    lower.includes("abort") || lower.includes("timed out")) {
    return "Timeout";
  }

  // HTTP status code errors
  if (/\(401\)/.test(message) || /\(403\)/.test(message)) {
    return "Auth error";
  }
  if (/\(404\)/.test(message) || lower.includes("not found")) {
    return "Not found";
  }
  if (/\(429\)/.test(message) || lower.includes("rate limit")) {
    return "Rate limited";
  }
  if (/\(5\d{2}\)/.test(message)) {
    return "Server error";
  }

  // Already in progress
  if (lower.includes("already in progress") || lower.includes("busy")) {
    return "Busy";
  }

  // Fallback: strip HTML and truncate
  const stripped = message.replace(/<[^>]*>/g, "").trim();
  if (stripped.length > 20) {
    return stripped.slice(0, 17) + "...";
  }

  return stripped || "Error";
};

const state = {
  settings: null,
  cache: null,
  cacheMeta: {
    state: CACHE_STATE.idle,
    lastUpdated: 0,
    lastError: null,
    blockCount: 0,
  },
  currentBlocks: [],
};

const elements = {
  contentArea: document.getElementById("content-area"),
  header: document.getElementById("header-bar"),
  footer: document.getElementById("footer-bar"),
  bookmarkStrip: document.getElementById("bookmark-strip"),
  barComponentPool: document.getElementById("bar-component-pool"),
  barDate: document.getElementById("bar-date"),
  barTime: document.getElementById("bar-time"),
  barDateTime: document.getElementById("bar-date-time"),
  topBarLeft: document.getElementById("top-bar-left"),
  topBarRight: document.getElementById("top-bar-right"),
  bottomBarLeft: document.getElementById("bottom-bar-left"),
  bottomBarRight: document.getElementById("bottom-bar-right"),
  blocksContainer: document.getElementById("blocks-container"),
  cacheButton: document.getElementById("cache-status-button"),
  cacheLabel: document.getElementById("cache-label"),
  blockTemplate: document.getElementById("block-card-template"),
  blocksView: document.getElementById("blocks-view"),
  bookmarksView: document.getElementById("bookmarks-view"),
  bookmarksBoard: document.getElementById("bm-board"),
  bookmarksSummary: document.getElementById("bm-summary"),
};

let resizeTimer = null;
let cooldownTimer = null;

const barComponents = {
  bookmarks: elements.bookmarkStrip,
  cache: document.querySelector(".bar-component--cache"),
  settings: document.querySelector(".bar-component--settings"),
  date: elements.barDate,
  time: elements.barTime,
  dateTime: elements.barDateTime,
};

const barView = createBarRenderer({
  header: elements.header,
  footer: elements.footer,
  pool: elements.barComponentPool,
  regions: {
    top: { left: elements.topBarLeft, right: elements.topBarRight },
    bottom: { left: elements.bottomBarLeft, right: elements.bottomBarRight },
  },
  components: barComponents,
  dateElement: elements.barDate,
  timeElement: elements.barTime,
  dateTimeElement: elements.barDateTime,
});

const renderBlockLayout = createBlockLayout({
  container: elements.blocksContainer,
  contentArea: elements.contentArea,
  renderCard: renderBlockCard,
});

const bookmarksView = createBookmarksView({
  root: elements.bookmarksView,
  blocksView: elements.blocksView,
  boardContainer: elements.bookmarksBoard,
  strip: elements.bookmarkStrip,
  summary: elements.bookmarksSummary,
  settings: state.settings,
});

function setPageBootState(status) {
  if (document.documentElement) {
    document.documentElement.dataset.pageState = status;
  }
}

async function init() {
  try {
    await hydrateState();
    wireEvents();
    await renderAll();
    setPageBootState("ready");
    await ensureCacheReady();
  } catch (error) {
    console.error("Failed to initialise new tab", error);
    renderError(error);
    setPageBootState("ready");
  }
}

async function hydrateState() {
  const [{ cache, meta }, settings] = await Promise.all([
    runtimeCacheLifecycle.read(),
    getSettings(),
  ]);
  state.cache = cache;
  state.cacheMeta = { ...state.cacheMeta, ...meta };
  state.settings = settings;
  applyTheme(state.settings.theme);
  toggleRegions();
}

async function ensureCacheReady() {
  try {
    applyCacheSnapshot(await runtimeCacheLifecycle.ensureReady());
  } catch (error) {
    console.warn("Bootstrap cache request failed", error);
    try {
      applyCacheSnapshot(await runtimeCacheLifecycle.read());
      // A rate limit already wrote `cooldown`; overwriting it with `error` would
      // drop the countdown and label a pause as a failure.
      if (state.cacheMeta.state !== CACHE_STATE.error && state.cacheMeta.state !== CACHE_STATE.cooldown) {
        state.cacheMeta = { ...state.cacheMeta, state: CACHE_STATE.error, lastError: error.message };
        updateCacheStatus();
      }
    } catch (_) {
      state.cacheMeta = { ...state.cacheMeta, state: CACHE_STATE.error, lastError: error.message };
      updateCacheStatus();
    }
  }
}

function wireEvents() {
  if (storage?.onChanged) {
    storage.onChanged.addListener(handleStorageChange);
  }
  window.addEventListener("resize", handleResize, { passive: true });
  if (elements.bookmarkStrip) {
    elements.bookmarkStrip.addEventListener("wheel", handleBookmarkWheel, { passive: false });
  }
  elements.cacheButton?.addEventListener("click", handleCacheButtonClick);
  document.addEventListener("visibilitychange", () => barView.render());
}

async function renderAll() {
  await bookmarksView.mount(state.settings);
  await renderBlocks();
  updateCacheStatus();
}

function toggleRegions() {
  barView.render(state.settings);
}

async function renderBookmarks() {
  await bookmarksView.updateSettings(state.settings);
}

function handleBookmarkWheel(event) {
  const strip = elements.bookmarkStrip;
  if (!strip || !strip.classList.contains("scrolling")) {
    return;
  }
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) {
    return;
  }
  event.preventDefault();
  strip.scrollLeft += delta;
}

function handleCacheButtonClick(event) {
  event?.preventDefault?.();
  triggerCacheRefresh("manual");
}

async function triggerCacheRefresh(reason = "manual") {
  const resumeFromCooldown = state.cacheMeta.state === CACHE_STATE.cooldown;
  state.cacheMeta = { ...state.cacheMeta, state: CACHE_STATE.working, lastError: null, retryAt: 0 };
  updateCacheStatus();
  try {
    // A fresh manual request replaces the cache; a cooldown retry preserves the
    // channel checkpoints that make the paused pass resumable.
    await runtimeCacheLifecycle.refresh({ reason, force: !resumeFromCooldown });
    applyCacheSnapshot(await runtimeCacheLifecycle.read());
    return true;
  } catch (error) {
    try {
      applyCacheSnapshot(await runtimeCacheLifecycle.read());
      // A rate limit already wrote `cooldown`; overwriting it with `error` would
      // drop the countdown and label a pause as a failure.
      if (state.cacheMeta.state !== CACHE_STATE.error && state.cacheMeta.state !== CACHE_STATE.cooldown) {
        state.cacheMeta = { ...state.cacheMeta, state: CACHE_STATE.error, lastError: error.message };
        updateCacheStatus();
      }
    } catch (_) {
      state.cacheMeta = { ...state.cacheMeta, state: CACHE_STATE.error, lastError: error.message };
      updateCacheStatus();
    }
    return false;
  }
}

function applyCacheSnapshot({ cache, meta }) {
  state.cache = cache;
  state.cacheMeta = {
    ...state.cacheMeta,
    ...meta,
    blockCount: cache.blockIds.length,
  };
  // A background refresh updates the source pool, not the selection already on screen.
  // Repaint only when the view has no usable block selection yet.
  if (needsCacheSelection()) {
    renderBlocks();
  }
  updateCacheStatus();
}

function applyCacheMeta(meta) {
  state.cacheMeta = {
    ...state.cacheMeta,
    ...(meta || {}),
    blockCount: Number.isFinite(meta?.blockCount)
      ? meta.blockCount
      : state.cache?.blockIds?.length ?? state.cacheMeta.blockCount ?? 0,
  };
  updateCacheStatus();
}

function getCacheSourceCounts() {
  const cache = state.cache || {};
  const sources = cache.sources || {};
  const blockCount = cache.blockIds?.length ?? state.cacheMeta.blockCount ?? 0;
  const channelCount = Array.isArray(sources.channels) ? sources.channels.length : Array.isArray(state.settings?.channelSlugs) ? state.settings.channelSlugs.length : 0;
  const blockIdCount = Array.isArray(sources.blockIds) ? sources.blockIds.length : Array.isArray(state.settings?.blockIds) ? state.settings.blockIds.length : 0;
  const includesFeed = Boolean(sources.feed ?? state.settings?.includeFeed);
  return {
    blockCount,
    channelCount,
    blockIdCount,
    includesFeed,
  };
}

function formatCount(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function updateCacheSummaryTooltip() {
  const button = elements.cacheButton;
  if (!button) {
    return;
  }
  const { blockCount, channelCount, blockIdCount, includesFeed } = getCacheSourceCounts();
  const timestamp = state.cacheMeta.lastUpdated || state.cache?.completedAt;
  const relativeTime = timestamp ? formatRelativeTime(timestamp) : null;

  // This string is also the button's accessible name, so it deliberately leaves
  // the countdown to the visible label rather than rewriting it every second.
  const action = getCooldownRemaining() > 0
    ? "Are.na rate limit reached. The sync resumes on its own."
    : "Click to refresh cache.";

  let tooltip;
  if (!blockCount) {
    tooltip = "No cached blocks yet.";
  } else {
    const feedLabel = includesFeed ? " plus your Are.na feed" : "";
    tooltip = `Randomly picked from ${formatCount(blockCount, "block")}, sourced from ${formatCount(channelCount, "channel")} and ${formatCount(blockIdCount, "specific block", "specific blocks")}${feedLabel}.`;
  }
  if (relativeTime) {
    tooltip += `\nLast refresh: ${relativeTime}`;
  }
  tooltip += `\n${action}`;
  button.title = tooltip;
  button.setAttribute("aria-label", tooltip.replace(/\n/g, " "));
}

function needsCacheSelection() {
  return !state.currentBlocks.length ||
    !elements.blocksContainer?.childElementCount ||
    elements.blocksContainer.classList.contains("is-empty");
}

async function renderBlocks() {
  const container = elements.blocksContainer;
  if (!container) {
    return;
  }

  container.innerHTML = "";

  if (!state.cache?.blockIds?.length) {
    state.currentBlocks = [];
    state.cacheMeta.blockCount = 0;
    showEmptyState();
    return;
  }

  const blockCount = Math.max(1, Number(state.settings?.blockCount) || 1);
  const ids = chooseRandomBlockIds(state.cache, blockCount);
  // Only the ids about to be drawn are read, so this cost no longer grows with
  // the size of the account. Most callers do not await this, so a store that
  // will not open has to end as an empty tab rather than a rejected promise.
  let blocks = [];
  try {
    blocks = await getBlocks(ids);
  } catch (error) {
    console.warn("Could not read cached blocks", error);
  }
  if (!blocks.length) {
    state.currentBlocks = [];
    showEmptyState();
    return;
  }

  state.currentBlocks = blocks;
  state.cacheMeta.blockCount = state.cache?.blockIds?.length ?? blocks.length;
  renderLayout(blocks);
}

function renderLayout(blocks) {
  const container = elements.blocksContainer;
  const contentArea = elements.contentArea;
  if (!container || !contentArea) {
    return;
  }

  if (!blocks || !blocks.length) {
    state.currentBlocks = [];
    showEmptyState();
    return;
  }

  renderBlockLayout(blocks, state.settings?.tileSize);
  updateCacheStatus();
}

function showEmptyState() {
  state.currentBlocks = [];
  const container = elements.blocksContainer;
  const contentArea = elements.contentArea;
  if (!container || !contentArea) {
    return;
  }
  container.classList.add("is-empty");
  container.innerHTML = "";
  const emptyState = document.createElement("div");
  emptyState.className = "block-empty";
  emptyState.textContent = "Configure channels or blocks in settings to start seeing content.";
  container.appendChild(emptyState);
  contentArea.classList.remove("is-scroll-y", "is-scroll-x");
  contentArea.style.overflow = "hidden";
  contentArea.style.overflowX = "hidden";
  contentArea.style.overflowY = "hidden";
  updateCacheStatus();
}

function renderBlockCard(block) {
  let article;
  if (elements.blockTemplate?.content) {
    const fragment = elements.blockTemplate.content.cloneNode(true);
    article = fragment.querySelector("article");
    populateCard(article, block);
  }
  if (!article) {
    article = buildFallbackCard(block);
  }
  return article;
}

function populateCard(article, block) {
  if (!article) {
    return;
  }
  article.dataset.blockId = block.id;
  const main = article.querySelector("[data-main]");
  const titleEl = article.querySelector(".block-title");
  const descriptionEl = article.querySelector(".block-description");
  const metaRow = article.querySelector("[data-meta]");
  const enabledFields = new Set(state.settings?.blockMetaFields || []);

  if (main) {
    buildMainContent(main, block);
  }

  if (titleEl) {
    const title = `${block.title || `Block ${block.id}`}`.trim();
    titleEl.textContent = title;
    titleEl.title = title;
    titleEl.hidden = !enabledFields.has("title") || !title;
  }

  if (descriptionEl) {
    const text = block.descriptionText?.trim();
    if (enabledFields.has("description") && text) {
      descriptionEl.textContent = text;
      descriptionEl.title = text;
      descriptionEl.hidden = false;
      descriptionEl.classList.remove("is-empty");
    } else {
      descriptionEl.textContent = "";
      descriptionEl.removeAttribute("title");
      descriptionEl.hidden = true;
      descriptionEl.classList.add("is-empty");
    }
  }

  if (metaRow) {
    renderBlockMeta(metaRow, block);
  }

  const infoVisible = Boolean(
    (titleEl && !titleEl.hidden) ||
    (descriptionEl && !descriptionEl.hidden) ||
    (metaRow && !metaRow.hidden)
  );
  article.querySelector(".block-info")?.toggleAttribute("hidden", !infoVisible);
  article.classList.toggle("block-card--no-info", !infoVisible);
}

function renderBlockMeta(container, block) {
  container.innerHTML = "";
  const items = getBlockMetaItems(block, state.settings?.blockMetaFields);
  items.forEach((item) => {
    const wrapper = document.createElement("span");
    wrapper.className = "block-meta-item";
    const label = document.createElement("span");
    label.className = "block-meta-label";
    label.textContent = `${item.label}:`;
    const value = item.href ? document.createElement("a") : document.createElement("span");
    value.className = "block-meta-value";
    value.textContent = item.value;
    value.title = item.fullValue;
    if (item.href) {
      value.href = item.href;
      value.target = "_blank";
      value.rel = "noopener";
    }
    wrapper.append(label, value);
    container.appendChild(wrapper);
  });
  container.hidden = !items.length;
}

function buildFallbackCard(block) {
  const article = document.createElement("article");
  article.className = "block-card";

  const main = document.createElement("div");
  main.className = "block-main";
  main.dataset.main = "";
  article.appendChild(main);

  const info = document.createElement("div");
  info.className = "block-info";

  const titleEl = document.createElement("h2");
  titleEl.className = "block-title";
  info.appendChild(titleEl);

  const descriptionEl = document.createElement("p");
  descriptionEl.className = "block-description";
  info.appendChild(descriptionEl);

  const metaRow = document.createElement("div");
  metaRow.className = "block-meta-row";
  metaRow.dataset.meta = "";

  info.appendChild(metaRow);
  article.appendChild(info);

  populateCard(article, block);
  return article;
}

function buildMainContent(container, block) {
  container.innerHTML = "";
  const node = buildMainNode(block);
  container.appendChild(block.arenaUrl ? wrapInArenaLink(node, block.arenaUrl) : node);
}

function buildMainNode(block) {
  const kind = block.kind;

  if (kind !== "Text" && block.imageUrl) {
    const img = document.createElement("img");
    img.src = block.imageUrl;
    img.alt = block.imageAlt || block.descriptionText || block.title || "Are.na preview";
    img.loading = "lazy";
    return img;
  }

  if (kind === "Text") {
    const wrapper = document.createElement("div");
    wrapper.className = "text-tile";
    const content = document.createElement("span");
    content.className = "tile-text-content";
    const textContent = block.contentText || block.descriptionText || block.title || "Text";
    content.textContent = textContent.trim() || "Text";
    wrapper.appendChild(content);
    return wrapper;
  }

  if (kind === "Link" && block.linkUrl) {
    return createChip(formatLinkLabel(block.linkUrl));
  }

  if (kind === "Attachment" && block.attachment?.url) {
    const name = block.attachment.fileName || block.title || "Attachment";
    return createChip(name);
  }

  if (kind === "Embed") {
    const label = block.embed?.type || block.title || "Embed";
    return createChip(label);
  }

  if (kind === "Channel") {
    if (block.counts?.contents) {
      return createChip(formatCount(block.counts.contents, "item"));
    }
    if (block.owner?.name) {
      return createChip(block.owner.name);
    }
    if (block.channel?.title) {
      return createChip(block.channel.title);
    }
  }

  if (block.source?.provider?.name) {
    return createChip(block.source.provider.name);
  }

  const fallback = block.descriptionText || block.title || "Untitled";
  return createChip(fallback);
}

function wrapInArenaLink(node, arenaUrl) {
  const link = document.createElement("a");
  link.className = "block-main-link";
  link.href = arenaUrl;
  link.target = "_blank";
  link.rel = "noopener";
  // Text tiles are readable content: don't navigate when the click was the end of a drag-selection.
  link.addEventListener("click", (event) => {
    if (!window.getSelection()?.isCollapsed) {
      event.preventDefault();
    }
  });
  link.appendChild(node);
  return link;
}

function createChip(label) {
  const chip = document.createElement("div");
  chip.className = "tile-chip";
  chip.textContent = label;
  return chip;
}

function formatLinkLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "");
  } catch (_) {
    return url;
  }
}

function getCooldownRemaining() {
  if (state.cacheMeta?.state !== CACHE_STATE.cooldown) {
    return 0;
  }
  return Math.max((state.cacheMeta.retryAt || 0) - Date.now(), 0);
}

function formatCacheProgress(progress) {
  const total = progress?.channelsTotal;
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  return `${progress.channelsDone ?? 0}/${total}`;
}

// The button sits in a bar sized for a block count, so a long channel title has
// to be cut the same way an error message already is.
function truncateChannelLabel(value, max = 18) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function scheduleCooldownTick() {
  const active = getCooldownRemaining() > 0;
  if (active && !cooldownTimer) {
    cooldownTimer = setInterval(updateCacheStatus, COOLDOWN_TICK_MS);
  } else if (!active && cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

function getCacheLedStatus() {
  const status = state.cacheMeta?.state || CACHE_STATE.idle;
  const timestamp = state.cacheMeta.lastUpdated || state.cache?.completedAt;

  if (status === CACHE_STATE.error) {
    return "error";
  }

  if (status === CACHE_STATE.cooldown) {
    return "cooldown";
  }

  if (status === CACHE_STATE.working) {
    return "working";
  }

  if (!timestamp) {
    return "idle";
  }

  const age = Date.now() - timestamp;
  const oneHour = 60 * 60 * 1000;

  if (age < oneHour) {
    return "fresh";
  }

  return "stale";
}

function updateCacheStatus() {
  const label = elements.cacheLabel;
  const button = elements.cacheButton;
  const status = state.cacheMeta?.state || CACHE_STATE.idle;
  const remaining = getCooldownRemaining();

  if (button) {
    // Re-enabled the moment the window reopens, so a user who does not want to
    // wait for the alarm can start the pass by hand.
    button.disabled = status === CACHE_STATE.working || remaining > 0;
  }
  scheduleCooldownTick();
  if (!label) {
    return;
  }

  const ledStatus = getCacheLedStatus();

  // Update LED indicator
  let ledSpan = button?.querySelector(".cache-led");
  if (button && !ledSpan) {
    ledSpan = document.createElement("span");
    ledSpan.className = "cache-led";
    button.insertBefore(ledSpan, label);
  }
  if (ledSpan) {
    ledSpan.dataset.status = ledStatus;
  }

  switch (status) {
    case CACHE_STATE.working: {
      const progress = formatCacheProgress(state.cacheMeta.progress);
      const channel = state.cacheMeta.progress?.currentChannel;
      if (channel && progress) {
        label.textContent = `Syncing ${truncateChannelLabel(channel)} · ${progress}`;
      } else {
        label.textContent = progress ? `Syncing · ${progress}` : "Refreshing...";
      }
      break;
    }
    case CACHE_STATE.cooldown: {
      const progress = formatCacheProgress(state.cacheMeta.progress);
      const synced = progress ? `Synced ${progress}` : "Rate limited";
      label.textContent = remaining > 0
        ? `${synced} · resuming in ${formatCountdown(remaining)}`
        : `${synced} · resuming`;
      break;
    }
    case CACHE_STATE.error:
      label.textContent = sanitizeErrorLabel(state.cacheMeta.lastError);
      break;
    default: {
      const blockCount = state.cache?.blockIds?.length ?? state.cacheMeta.blockCount ?? 0;
      if (blockCount) {
        label.textContent = `${blockCount} block${blockCount === 1 ? "" : "s"}`;
      } else {
        label.textContent = "Cache idle";
      }
    }
  }
  updateCacheSummaryTooltip();
}

function handleStorageChange(changes, area) {
  if (area !== "local") {
    return;
  }
  if (changes[STORAGE_KEYS.settings]) {
    getSettings().then((settings) => {
      const { displayChanged } = classifySettingsChanges(settings, state.settings);
      state.settings = settings;
      if (!displayChanged) {
        return;
      }
      applyTheme(state.settings.theme);
      toggleRegions();
      if (state.currentBlocks.length) {
        renderLayout(state.currentBlocks);
      } else {
        renderBlocks();
      }
      renderBookmarks();
    });
  }
  if (changes[STORAGE_KEYS.cache]) {
    runtimeCacheLifecycle.read().then(applyCacheSnapshot);
  } else if (changes[STORAGE_KEYS.cacheMeta]?.newValue) {
    applyCacheMeta(changes[STORAGE_KEYS.cacheMeta].newValue);
  } else if (changes[STORAGE_KEYS.cacheMeta]) {
    runtimeCacheLifecycle.read().then(applyCacheSnapshot);
  }
}

function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.currentBlocks.length) {
      renderLayout(state.currentBlocks);
    }
  }, RESIZE_DEBOUNCE);
}

function renderError(error) {
  state.currentBlocks = [];
  if (!elements.blocksContainer) {
    return;
  }
  elements.blocksContainer.classList.add("is-empty");
  const div = document.createElement("div");
  div.className = "block-empty";
  div.textContent = `Error: ${error.message}`;
  elements.blocksContainer.innerHTML = "";
  elements.blocksContainer.appendChild(div);
}

init();
