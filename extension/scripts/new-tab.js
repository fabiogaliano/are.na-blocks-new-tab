import { CACHE_STATE, CACHE_VERSION, MESSAGES, STORAGE_KEYS, TILE_SIZE_OPTIONS } from "./constants.js";
import { formatRelativeTime } from "./time.js";
import { bookmarks, runtime, storage } from "./extension-api.js";
import { chooseRandomBlocks } from "./arena.js";
import { getCache, getSettings } from "./storage.js";
import { applyTheme } from "./theme.js";
import { refreshCache } from "./cache-refresh.js";
import { formatBarDate, formatBarTime, getBlockMetaItems } from "./customization.js";

const TILE_SIZE_MAP = {
  xs: 225,
  s: 260,
  m: 310,
  l: 360,
  xl: 420,
};

const AUTO_TILE_SIZES = [420, 360, 320, 300, 260, 225];
const TILE_GAP = 18;
const INFO_HEIGHT = 0;
const RESIZE_DEBOUNCE = 150;
const BOOKMARK_MENU_OFFSET = 4;
const BOOKMARK_SUBMENU_OFFSET = 6;
const BOOKMARK_OVERFLOW_TOLERANCE = 2;
const CACHE_STALE_THRESHOLD = 60 * 60 * 1000;
const USER_AGENT = typeof navigator === "object" && typeof navigator.userAgent === "string" ? navigator.userAgent.toLowerCase() : "";
const IS_FIREFOX = USER_AGENT.includes("firefox");
const IS_CHROMIUM = !IS_FIREFOX && /chrome|chromium|crios|edg|opr|vivaldi/.test(USER_AGENT);

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
  bootstrapAttempted: false,
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
  bookmarkEmptyTemplate: document.getElementById("bookmark-empty-template"),
  bookmarkMenuLayer: document.getElementById("bookmark-menu-layer"),
};

let resizeTimer = null;
let clockTimer = null;
let bookmarkResizeObserver = null;
const openBookmarkFolders = new Set();
let cacheRefreshPromise = null;

const barComponents = {
  bookmarks: elements.bookmarkStrip,
  cache: document.querySelector(".bar-component--cache"),
  settings: document.querySelector(".bar-component--settings"),
  date: elements.barDate,
  time: elements.barTime,
  dateTime: elements.barDateTime,
};

const setMenuLayerActive = (isActive) => {
  const layer = elements.bookmarkMenuLayer;
  if (!layer) return;

  layer.setAttribute("aria-hidden", isActive ? "false" : "true");
  layer.style.pointerEvents = isActive ? "auto" : "none";
};

const calculateMenuPosition = (triggerRect, menuSize, viewport, offset = 0, isSubMenu = false) => {
  const { width: menuWidth, height: menuHeight } = menuSize;
  const { width: viewportWidth, height: viewportHeight } = viewport;

  let left, top;

  if (isSubMenu) {
    left = triggerRect.right + offset;
    if (left + menuWidth + 8 > viewportWidth) {
      left = triggerRect.left - menuWidth - offset;
    }
    top = triggerRect.top;
    if (top + menuHeight + 8 > viewportHeight) {
      top = viewportHeight - menuHeight - 8;
    }
  } else {
    left = triggerRect.left;
    top = triggerRect.bottom + offset;
  }

  return {
    left: Math.min(Math.max(8, left), Math.max(8, viewportWidth - menuWidth - 8)),
    top: Math.min(Math.max(8, top), Math.max(8, viewportHeight - menuHeight - 8)),
    maxWidth: Math.max(8, viewportWidth - 16),
    maxHeight: Math.max(8, viewportHeight - 16)
  };
};

const positionMenu = (menu, trigger, offset = BOOKMARK_MENU_OFFSET, isSubMenu = false) => {
  if (!menu || !trigger) return;

  menu.style.maxHeight = "";
  menu.style.overflowY = "visible";
  menu.style.width = "auto";

  const position = calculateMenuPosition(
    trigger.getBoundingClientRect(),
    { width: menu.offsetWidth || 0, height: menu.offsetHeight || 0 },
    { width: window.innerWidth, height: window.innerHeight },
    offset,
    isSubMenu
  );

  menu.style.left = `${Math.round(position.left)}px`;
  menu.style.top = `${Math.round(position.top)}px`;
  menu.style.maxHeight = `${position.maxHeight}px`;
  menu.style.overflowY = "auto";
  menu.style.width = `${Math.min(menu.offsetWidth || 200, position.maxWidth)}px`;
};

const positionRootMenu = (menu, trigger) => positionMenu(menu, trigger, BOOKMARK_MENU_OFFSET, false);
const positionSubMenu = (menu, trigger) => positionMenu(menu, trigger, BOOKMARK_SUBMENU_OFFSET, true);

function setPageBootState(status) {
  if (document.documentElement) {
    document.documentElement.dataset.pageState = status;
  }
}

function repositionOpenMenus() {
  if (!elements.bookmarkMenuLayer || !openBookmarkFolders.size) {
    return;
  }
  for (const controller of openBookmarkFolders) {
    if (typeof controller?.position === "function") {
      controller.position();
    } else if (controller?.menu && controller?.trigger) {
      positionRootMenu(controller.menu, controller.trigger);
    }
  }
}
async function init() {
  try {
    await hydrateState();
    wireEvents();
    await renderAll();
    setPageBootState("ready");
    await maybeBootstrapCache();
    await maybeRefreshStaleCache();
  } catch (error) {
    console.error("Failed to initialise new tab", error);
    renderError(error);
    setPageBootState("ready");
  }
}

async function hydrateState() {
  const { cache, meta } = await getCache();
  state.cache = cache;
  state.cacheMeta = { ...state.cacheMeta, ...meta };
  state.settings = await getSettings();
  applyTheme(state.settings.theme);
  toggleRegions();
}

async function maybeBootstrapCache() {
  if (state.bootstrapAttempted) {
    return;
  }
  state.bootstrapAttempted = true;

  if (!storage?.get || !runtime?.sendMessage) {
    return;
  }

  if (state.cache?.blockIds?.length) {
    try {
      await storage.set({
        [STORAGE_KEYS.bootstrap]: {
          status: "complete",
          cacheVersion: CACHE_VERSION,
          timestamp: Date.now(),
        },
      });
    } catch (_) {
      // ignore
    }
    return;
  }

  try {
    await storage.set({
      [STORAGE_KEYS.bootstrap]: {
        status: "pending",
        cacheVersion: CACHE_VERSION,
        timestamp: Date.now(),
      },
    });

    const success = await triggerCacheRefresh("bootstrap");
    if (success) {
      await storage.set({
        [STORAGE_KEYS.bootstrap]: {
          status: "complete",
          cacheVersion: CACHE_VERSION,
          timestamp: Date.now(),
        },
      });
    } else {
      await storage.set({
        [STORAGE_KEYS.bootstrap]: {
          status: "error",
          cacheVersion: CACHE_VERSION,
          timestamp: Date.now(),
        },
      });
    }
  } catch (error) {
    console.warn("Bootstrap cache request failed", error);
    try {
      await storage.remove([STORAGE_KEYS.bootstrap]);
    } catch (_) {
      // ignore cleanup errors
    }
  }
}

async function maybeRefreshStaleCache() {
  if (state.cacheMeta.state === CACHE_STATE.working || cacheRefreshPromise) {
    return;
  }
  const timestamp = state.cacheMeta.lastUpdated || state.cache?.fetchedAt || 0;
  if (!timestamp) {
    return;
  }
  if (Date.now() - timestamp < CACHE_STALE_THRESHOLD) {
    return;
  }
  await triggerCacheRefresh("stale");
}

function wireEvents() {
  if (storage?.onChanged) {
    storage.onChanged.addListener(handleStorageChange);
  }
  if (runtime?.onMessage) {
    runtime.onMessage.addListener(handleRuntimeMessage);
  }
  window.addEventListener("resize", handleResize, { passive: true });
  window.addEventListener("scroll", handleScroll, { passive: true });
  if (elements.bookmarkStrip) {
    elements.bookmarkStrip.addEventListener("wheel", handleBookmarkWheel, { passive: false });
    if (typeof ResizeObserver === "function") {
      bookmarkResizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => applyBookmarkOverflow());
      });
      bookmarkResizeObserver.observe(elements.bookmarkStrip);
    }
  }
  elements.cacheButton?.addEventListener("click", handleCacheButtonClick);
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  document.addEventListener("keydown", handleDocumentKeyDown);
  document.addEventListener("visibilitychange", updateClock);
  clearInterval(clockTimer);
  clockTimer = setInterval(updateClock, 1000);
}

async function renderAll() {
  await renderBookmarks();
  renderBlocks();
  updateCacheStatus();
}

function toggleRegions() {
  const showHeader = state.settings?.showHeader !== false;
  const showFooter = state.settings?.showFooter !== false;
  const layout = state.settings?.barLayout;
  closeAllBookmarkFolders();
  Object.values(barComponents).forEach((component) => {
    if (component && elements.barComponentPool) {
      elements.barComponentPool.appendChild(component);
    }
  });
  if (elements.header) {
    elements.header.hidden = !showHeader;
  }
  if (elements.footer) {
    elements.footer.hidden = !showFooter;
  }
  renderBar(layout?.top, elements.topBarLeft, elements.topBarRight);
  renderBar(layout?.bottom, elements.bottomBarLeft, elements.bottomBarRight);
  updateClock();
}

function renderBar(bar, leftRegion, rightRegion) {
  if (!leftRegion || !rightRegion) {
    return;
  }
  const barElement = leftRegion.parentElement;
  if (barElement) {
    barElement.dataset.hasBookmarks = bar?.left === "bookmarks" || bar?.right === "bookmarks" ? "true" : "false";
  }
  configureBarRegion(leftRegion, bar?.left);
  configureBarRegion(rightRegion, bar?.right);
}

function configureBarRegion(region, componentName) {
  region.style.removeProperty("flex-basis");
  region.style.removeProperty("max-width");
  region.hidden = !componentName || componentName === "none";
  region.dataset.component = componentName || "none";
  const component = barComponents[componentName];
  if (component) {
    region.appendChild(component);
  }
}

function isBarComponentVisible(componentName) {
  const component = barComponents[componentName];
  const region = component?.parentElement;
  const bar = region?.parentElement;
  return Boolean(region?.classList.contains("bar-region") && !region.hidden && bar && !bar.hidden);
}

function updateClock() {
  if (document.hidden) {
    return;
  }
  const now = new Date();
  if (elements.barDate) {
    const label = formatBarDate(now, state.settings?.dateFormat);
    elements.barDate.textContent = label;
    elements.barDate.dateTime = now.toISOString();
    elements.barDate.title = label ? `Current date: ${label}` : "Current date";
  }
  if (elements.barTime) {
    const label = formatBarTime(now, state.settings?.timeFormat);
    elements.barTime.textContent = label;
    elements.barTime.dateTime = now.toISOString();
    elements.barTime.title = label ? `Current time: ${label}` : "Current time";
  }
  if (elements.barDateTime) {
    const dateLabel = formatBarDate(now, state.settings?.dateFormat);
    const timeLabel = formatBarTime(now, state.settings?.timeFormat);
    const label = [dateLabel, timeLabel].filter(Boolean).join(" ");
    elements.barDateTime.textContent = label;
    elements.barDateTime.dateTime = now.toISOString();
    elements.barDateTime.title = label ? `Current date and time: ${label}` : "Current date and time";
  }
}

async function renderBookmarks() {
  const strip = elements.bookmarkStrip;
  if (!strip) {
    return;
  }
  closeAllBookmarkFolders();
  openBookmarkFolders.clear();
  if (elements.bookmarkMenuLayer) {
    elements.bookmarkMenuLayer.innerHTML = "";
    setMenuLayerActive(false);
  }
  strip.textContent = "";
  strip.classList.remove("scrolling");
  strip.classList.remove("has-overflow");
  strip.dataset.hasOverflow = "false";
  if (!isBarComponentVisible("bookmarks")) {
    return;
  }
  if (!bookmarks) {
    strip.textContent = "Bookmarks unavailable";
    return;
  }
  try {
    strip.dataset.state = "loading";
    const tree = await bookmarks.getTree();
    const rootChildren = tree[0]?.children || [];
    const bar = rootChildren.find((node) => node.id === "1" || (node.title && node.title.toLowerCase().includes("bookmark")));
    const nodes = (bar?.children || rootChildren || []).filter(Boolean);
    const fragment = document.createDocumentFragment();
    for (const node of nodes) {
      if (node.type === "separator") {
        continue;
      }
      if (node.url) {
        fragment.appendChild(createBookmarkLink(node));
      } else if (node.children?.length) {
        fragment.appendChild(createBookmarkFolder(node));
      }
    }
    if (!fragment.childElementCount) {
      const template = elements.bookmarkEmptyTemplate?.content?.cloneNode(true);
      if (template) {
        strip.appendChild(template);
      } else {
        strip.textContent = "No bookmarks";
      }
      return;
    }
    strip.appendChild(fragment);
    requestAnimationFrame(() => {
      applyBookmarkOverflow();
    });
  } catch (error) {
    console.error("Failed to load bookmarks", error);
    strip.textContent = "Bookmarks unavailable";
    strip.classList.remove("scrolling");
  } finally {
    strip.dataset.state = "ready";
  }
}

function getLocalBookmarkFaviconUrl(pageUrl) {
  if (!pageUrl) {
    return null;
  }
  if (IS_CHROMIUM && runtime?.getURL) {
    try {
      const url = new URL(runtime.getURL("/_favicon/"));
      url.searchParams.set("pageUrl", pageUrl);
      url.searchParams.set("size", "32");
      return url.toString();
    } catch (error) {
      console.warn("Failed to build favicon URL", error);
    }
  }
  if (IS_FIREFOX) {
    return `chrome://favicon/size/32@1x/${pageUrl}`;
  }
  return null;
}

function getRemoteBookmarkFaviconUrl(pageUrl) {
  return `https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(pageUrl || "")}`;
}

function setBookmarkFaviconSource(img, pageUrl) {
  if (!img) {
    return;
  }
  const fallbackUrl = getRemoteBookmarkFaviconUrl(pageUrl);
  const localUrl = getLocalBookmarkFaviconUrl(pageUrl);
  if (localUrl) {
    img.src = localUrl;
    img.onerror = () => {
      img.onerror = () => img.remove();
      img.src = fallbackUrl;
    };
  } else {
    img.src = fallbackUrl;
    img.onerror = () => img.remove();
  }
}

function createBookmarkLink(node, className = "bookmark-link") {
  const link = document.createElement("a");
  link.className = className;
  link.href = node.url;
  link.rel = "noopener";
  link.title = node.title || node.url;
  link.dataset.bookmarkItem = "true";
  link.__bookmarkNode = node;

  const favicon = document.createElement("img");
  favicon.className = "bookmark-favicon";
  favicon.alt = "";
  favicon.referrerPolicy = "no-referrer";
  favicon.decoding = "async";
  favicon.loading = "lazy";
  setBookmarkFaviconSource(favicon, node.url);

  const label = document.createElement("span");
  label.textContent = node.title || node.url;

  link.append(favicon, label);
  return link;
}

const createBookmarkController = (container, trigger, menu, level = 0) => {
  const menuLayer = elements.bookmarkMenuLayer;
  let isOpen = false;

  const focusFirstItem = () => menu.querySelector("a, button")?.focus();

  const close = () => {
    if (!isOpen) return;
    closeBookmarkMenusFromLevel(level + 1);
    trigger.setAttribute("aria-expanded", "false");
    container.classList.remove("is-open");
    menu.hidden = true;
    menu.setAttribute("hidden", "");
    menu.setAttribute("aria-hidden", "true");
    isOpen = false;
    openBookmarkFolders.delete(controller);
    if (!openBookmarkFolders.size) setMenuLayerActive(false);
  };

  const position = () => positionRootMenu(menu, trigger);

  const open = (focusFirst = false) => {
    if (isOpen) {
      position();
      if (focusFirst) focusFirstItem();
      return;
    }
    closeAllBookmarkFolders(controller);
    container.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    menu.removeAttribute("hidden");
    menu.setAttribute("aria-hidden", "false");
    menu.scrollTop = 0;
    isOpen = true;
    openBookmarkFolders.add(controller);
    if (menuLayer) {
      setMenuLayerActive(true);
      menuLayer.appendChild(menu);
      menu.style.zIndex = "30";
    }
    position();
    if (focusFirst) focusFirstItem();
  };

  const destroy = () => {
    close();
    menu.parentElement?.removeChild(menu);
  };

  const controller = { trigger, menu, level, isOpen: () => isOpen, position, open, close, destroy };

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    isOpen ? close() : open();
  });

  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      open(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      trigger.focus();
    }
  });

  return controller;
};

const createBookmarkFolder = (node) => {
  const container = document.createElement("div");
  container.className = "bookmark-folder";
  container.dataset.bookmarkItem = "true";
  container.__bookmarkNode = node;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "bookmark-trigger";
  trigger.title = node.title || "Folder";
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  trigger.textContent = node.title || "Folder";

  container.appendChild(trigger);

  const menu = buildBookmarkMenu(node.children || [], 0);
  if (!menu.childElementCount) {
    trigger.disabled = true;
    trigger.setAttribute("aria-disabled", "true");
    return container;
  }

  const menuId = `bookmark-menu-${node.id || Math.random().toString(36).slice(2)}`;
  menu.id = menuId;
  trigger.setAttribute("aria-controls", menuId);

  menu.hidden = true;
  menu.setAttribute("hidden", "");
  menu.setAttribute("aria-hidden", "true");

  const menuLayer = elements.bookmarkMenuLayer;
  if (menuLayer) {
    menuLayer.appendChild(menu);
  } else {
    container.appendChild(menu);
  }

  container.__bookmarkController = createBookmarkController(container, trigger, menu, 0);
  return container;
};

function buildBookmarkMenu(nodes, level = 0) {
  const menu = document.createElement("ul");
  menu.className = level === 0 ? "bookmark-menu" : "bookmark-submenu";
  menu.dataset.level = String(level);
  menu.setAttribute("role", "menu");

  for (const child of nodes) {
    if (!child) {
      continue;
    }
    if (child.type === "separator") {
      const divider = document.createElement("li");
      divider.className = "bookmark-menu-divider";
      menu.appendChild(divider);
      continue;
    }
    if (child.url) {
      menu.appendChild(createBookmarkMenuLink(child));
    } else if (child.children?.length) {
      const folderItem = createBookmarkMenuFolder(child, level + 1);
      if (folderItem) {
        menu.appendChild(folderItem);
      }
    }
  }

  return menu;
}

function createBookmarkMenuLink(node) {
  const item = document.createElement("li");
  item.className = "bookmark-menu-item";
  const link = createBookmarkLink(node, "bookmark-menu-link");
  link.tabIndex = -1;
  item.appendChild(link);
  return item;
}

const createBookmarkMenuController = (item, button, submenu, level) => {
  const menuLayer = elements.bookmarkMenuLayer;
  let isOpen = false;

  const focusFirstItem = () => submenu.querySelector("a, button")?.focus();

  const close = () => {
    if (!isOpen) return;
    item.classList.remove("submenu-open");
    button.setAttribute("aria-expanded", "false");
    submenu.hidden = true;
    submenu.setAttribute("hidden", "");
    submenu.setAttribute("aria-hidden", "true");
    isOpen = false;
    closeBookmarkMenusFromLevel(level + 1);
    openBookmarkFolders.delete(controller);
    if (!openBookmarkFolders.size) setMenuLayerActive(false);
  };

  const position = () => positionSubMenu(submenu, button);

  const open = (focusFirst = false) => {
    if (isOpen) {
      position();
      if (focusFirst) focusFirstItem();
      return;
    }
    closeBookmarkMenusFromLevel(level, controller);
    item.classList.add("submenu-open");
    button.setAttribute("aria-expanded", "true");
    submenu.hidden = false;
    submenu.removeAttribute("hidden");
    submenu.setAttribute("aria-hidden", "false");
    submenu.scrollTop = 0;
    isOpen = true;
    openBookmarkFolders.add(controller);
    if (menuLayer) {
      menuLayer.appendChild(submenu);
      submenu.style.zIndex = String(30 + level);
    }
    position();
    if (focusFirst) focusFirstItem();
  };

  const controller = { trigger: button, menu: submenu, level, isOpen: () => isOpen, position, open, close };

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    isOpen ? close() : open(true);
  });

  button.addEventListener("pointerenter", () => open());
  button.addEventListener("focus", () => open());

  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      open(true);
    } else if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      close();
      button.focus();
    }
  });

  return controller;
};

const createBookmarkMenuFolder = (node, level) => {
  const item = document.createElement("li");
  item.className = "bookmark-menu-item has-children";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "bookmark-menu-button";
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");

  const label = document.createElement("span");
  label.textContent = node.title || "Folder";
  const arrow = document.createElement("span");
  arrow.className = "bookmark-menu-arrow";
  arrow.textContent = "›";
  button.append(label, arrow);

  const submenu = buildBookmarkMenu(node.children || [], level);
  if (!submenu.childElementCount) return null;

  submenu.hidden = true;
  submenu.setAttribute("hidden", "");
  submenu.setAttribute("aria-hidden", "true");

  const submenuId = `bookmark-menu-${node.id || Math.random().toString(36).slice(2)}`;
  submenu.id = submenuId;
  button.setAttribute("aria-controls", submenuId);

  const menuLayer = elements.bookmarkMenuLayer;
  if (menuLayer) {
    menuLayer.appendChild(submenu);
  } else {
    item.appendChild(submenu);
  }

  item.__bookmarkController = createBookmarkMenuController(item, button, submenu, level);
  item.appendChild(button);
  return item;
};

function cleanupBookmarkElement(element) {
  if (!element) {
    return;
  }
  const controller = element.__bookmarkController;
  if (controller) {
    controller.destroy();
  }
  if (element.parentElement) {
    element.parentElement.removeChild(element);
  }
}

function closeBookmarkMenusFromLevel(level, except) {
  if (!openBookmarkFolders.size) {
    return;
  }
  const controllers = Array.from(openBookmarkFolders);
  for (const controller of controllers) {
    if (controller === except) {
      continue;
    }
    const controllerLevel = controller?.level ?? 0;
    if (controllerLevel >= level) {
      controller.close();
    }
  }
}

function closeAllBookmarkFolders(except) {
  const controllers = Array.from(openBookmarkFolders);
  for (const controller of controllers) {
    if (controller !== except) {
      controller.close();
    }
  }
  if (!except) {
    openBookmarkFolders.clear();
  }
}

function handleDocumentPointerDown(event) {
  if (!openBookmarkFolders.size) {
    return;
  }
  if (!event.target.closest(".bookmark-folder, .bookmark-menu, .bookmark-submenu")) {
    closeAllBookmarkFolders();
  }
}

function handleDocumentKeyDown(event) {
  if (event.key === "Escape") {
    closeAllBookmarkFolders();
  }
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

function triggerCacheRefresh(reason = "manual") {
  if (cacheRefreshPromise) {
    return cacheRefreshPromise;
  }
  state.cacheMeta = { ...state.cacheMeta, state: CACHE_STATE.working, lastError: null };
  updateCacheStatus();
  cacheRefreshPromise = (async () => {
    try {
      let summary = null;

      if (runtime?.sendMessage) {
        const response = await runtime.sendMessage({
          type: MESSAGES.refreshCache,
          payload: { reason },
        });

        if (response?.ok) {
          summary = response.summary || null;
        } else if (response?.error) {
          throw new Error(response.error);
        } else {
          throw new Error("Cache refresh did not return a result.");
        }
      } else {
        summary = await refreshCache();
      }

      if (summary?.cacheVersion !== CACHE_VERSION) {
        summary = await refreshCache();
      }

      await applyCacheRefreshResult(summary);
      return true;
    } catch (error) {
      const message = error?.message || "";

      if (/receiving end|message port closed|did not return a result/i.test(message)) {
        try {
          const summary = await refreshCache();
          await applyCacheRefreshResult(summary);
          return true;
        } catch (fallbackError) {
          state.cacheMeta = { ...state.cacheMeta, state: CACHE_STATE.error, lastError: fallbackError.message };
          updateCacheStatus();
          return false;
        }
      }

      state.cacheMeta = { ...state.cacheMeta, state: CACHE_STATE.error, lastError: error.message };
      updateCacheStatus();
      return false;
    } finally {
      cacheRefreshPromise = null;
    }
  })();
  return cacheRefreshPromise;
}

async function applyCacheRefreshResult(summary) {
  const { cache, meta } = await getCache();
  state.cache = cache;
  state.cacheMeta = {
    ...state.cacheMeta,
    ...meta,
    state: CACHE_STATE.idle,
    lastError: null,
    lastUpdated: summary?.fetchedAt || meta.lastUpdated || Date.now(),
    blockCount: cache.blockIds.length,
  };
  // A background refresh updates the source pool, not the selection already on screen.
  // Repaint only when the view has no usable block selection yet.
  if (needsCacheSelection()) {
    renderBlocks();
  }
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
  const timestamp = state.cacheMeta.lastUpdated || state.cache?.fetchedAt;
  const relativeTime = timestamp ? formatRelativeTime(timestamp) : null;

  let tooltip;
  if (!blockCount) {
    tooltip = "No cached blocks yet.";
    if (relativeTime) {
      tooltip += `\nLast refresh: ${relativeTime}`;
    }
    tooltip += "\nClick to refresh cache.";
  } else {
    const feedLabel = includesFeed ? " plus your Are.na feed" : "";
    tooltip = `Randomly picked from ${formatCount(blockCount, "block")}, sourced from ${formatCount(channelCount, "channel")} and ${formatCount(blockIdCount, "specific block", "specific blocks")}${feedLabel}.`;
    if (relativeTime) {
      tooltip += `\nLast refresh: ${relativeTime}`;
    }
    tooltip += "\nClick to refresh cache.";
  }
  button.title = tooltip;
  button.setAttribute("aria-label", tooltip.replace(/\n/g, " "));
}

function createOverflowButton(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) {
    return null;
  }
  const overflowNode = {
    id: "bookmark-overflow",
    title: "⋯",
    children: nodes,
  };
  const container = createBookmarkFolder(overflowNode);
  if (!container) {
    return null;
  }
  container.dataset.bookmarkOverflow = "true";
  container.dataset.bookmarkItem = "overflow";
  container.classList.add("bookmark-overflow");
  container.__bookmarkNode = overflowNode;
  const trigger = container.querySelector(".bookmark-trigger");
  if (trigger) {
    trigger.textContent = "⋯";
    trigger.setAttribute("aria-label", "More bookmarks");
    trigger.title = "More bookmarks";
    trigger.classList.add("bookmark-overflow-trigger");
  }
  return container;
}

function applyBookmarkOverflow() {
  const strip = elements.bookmarkStrip;
  if (!strip || !strip.childElementCount) {
    return;
  }

  const previousOverflow = Array.from(strip.querySelectorAll('[data-bookmark-overflow="true"]'));
  for (const element of previousOverflow) {
    cleanupBookmarkElement(element);
  }

  const items = Array.from(strip.children).filter((child) => child?.dataset?.bookmarkItem === "true");

  if (!items.length) {
    strip.dataset.hasOverflow = "false";
    return;
  }

  const availableWidth = strip.clientWidth || 0;
  if (!availableWidth) {
    strip.dataset.hasOverflow = "false";
    return;
  }

  const threshold = availableWidth - BOOKMARK_OVERFLOW_TOLERANCE;
  const hiddenNodes = [];

  const showItem = (item) => {
    item.classList.remove("bookmark-overflow-hidden");
    item.removeAttribute("aria-hidden");
  };

  const hideItem = (item, addToFront = false) => {
    if (!item || item.classList.contains("bookmark-overflow-hidden")) {
      return;
    }
    if (item.__bookmarkController) {
      item.__bookmarkController.close();
    }
    item.classList.add("bookmark-overflow-hidden");
    item.setAttribute("aria-hidden", "true");
    const data = item.__bookmarkNode;
    if (data) {
      if (addToFront) {
        hiddenNodes.unshift(data);
      } else {
        hiddenNodes.push(data);
      }
    }
  };

  for (const item of items) {
    showItem(item);
  }

  let cutoff = items.length;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const rectRight = item.offsetLeft + item.offsetWidth;
    if (rectRight > threshold) {
      cutoff = i;
      break;
    }
  }

  if (cutoff < items.length) {
    for (let i = cutoff; i < items.length; i += 1) {
      hideItem(items[i]);
    }
  }

  let overflowContainer = null;

  if (hiddenNodes.length) {
    overflowContainer = createOverflowButton(hiddenNodes);
    if (overflowContainer) {
      strip.appendChild(overflowContainer);
      let index = cutoff - 1;
      while (overflowContainer.offsetLeft + overflowContainer.offsetWidth > threshold && index >= 0) {
        const item = items[index];
        hideItem(item, true);
        index -= 1;
        cleanupBookmarkElement(overflowContainer);
        overflowContainer = createOverflowButton(hiddenNodes);
        if (!overflowContainer) {
          break;
        }
        strip.appendChild(overflowContainer);
      }
    }
  }

  strip.dataset.hasOverflow = hiddenNodes.length ? "true" : "false";
  strip.classList.toggle("has-overflow", hiddenNodes.length > 0);
  if (openBookmarkFolders.size) {
    repositionOpenMenus();
  }
}

function needsCacheSelection() {
  return !state.currentBlocks.length ||
    !elements.blocksContainer?.childElementCount ||
    elements.blocksContainer.classList.contains("is-empty");
}

function renderBlocks() {
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
  const blocks = chooseRandomBlocks(state.cache, blockCount);
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

  container.classList.remove("is-empty");
  container.innerHTML = "";
  contentArea.classList.remove("is-scroll-y", "is-scroll-x");
  contentArea.style.overflowX = "hidden";
  contentArea.style.overflowY = "hidden";

  const viewport = getViewport();
  container.style.setProperty("--tile-gap", `${TILE_GAP}px`);
  const { tileSize, layout } = determineLayout(blocks.length, viewport);
  container.style.setProperty("--tile-size", `${tileSize}px`);
  const isCompact = tileSize <= TILE_SIZE_MAP.s;
  container.style.setProperty("--block-title-size", isCompact ? "0.9rem" : "1rem");
  container.style.setProperty("--block-meta-size", isCompact ? "0.6rem" : "0.7rem");

  let index = 0;
  layout.rows.forEach((columns) => {
    const row = document.createElement("div");
    row.className = "block-row";
    row.dataset.columns = String(columns);
    for (let column = 0; column < columns && index < blocks.length; column += 1) {
      row.appendChild(renderBlockCard(blocks[index]));
      index += 1;
    }
    container.appendChild(row);
  });

  while (index < blocks.length) {
    const fallbackRow = document.createElement("div");
    fallbackRow.className = "block-row";
    fallbackRow.dataset.columns = "1";
    fallbackRow.appendChild(renderBlockCard(blocks[index]));
    container.appendChild(fallbackRow);
    index += 1;
  }

  requestAnimationFrame(() => applyOverflowStates());
  updateCacheStatus();
}

function determineLayout(count, viewport) {
  const requested = state.settings?.tileSize && TILE_SIZE_OPTIONS.includes(state.settings.tileSize) ? state.settings.tileSize : "auto";

  if (requested !== "auto") {
    const baseSize = TILE_SIZE_MAP[requested] || TILE_SIZE_MAP.m;
    const tileSize = clampTileSize(baseSize, viewport);
    const layout = chooseLayout(count, viewport, tileSize);
    return { tileSize, layout };
  }

  for (const candidate of AUTO_TILE_SIZES) {
    const tileSize = clampTileSize(candidate, viewport);
    const layout = chooseLayout(count, viewport, tileSize);
    if (layout.fitsWidth && layout.fitsHeight) {
      return { tileSize, layout };
    }
  }

  const fallbackSize = clampTileSize(AUTO_TILE_SIZES[AUTO_TILE_SIZES.length - 1], viewport);
  return { tileSize: fallbackSize, layout: chooseLayout(count, viewport, fallbackSize) };
}

function chooseLayout(count, viewport, tileSize) {
  if (count <= 0) {
    return { rows: [], requiredWidth: 0, requiredHeight: 0, fitsWidth: true, fitsHeight: true };
  }

  const widthFor = (cols) => cols * tileSize + (cols - 1) * TILE_GAP;
  const heightForRows = (rows) => rows * (tileSize + INFO_HEIGHT) + (rows - 1) * TILE_GAP;

  const fitsColumns = (cols) => widthFor(cols) <= viewport.width;
  const fitsRows = (rows) => heightForRows(rows) <= viewport.height;

  const ratio = viewport.width / Math.max(viewport.height, 1);
  const superThin = viewport.width < widthFor(2);
  const superWide = viewport.height < heightForRows(2);

  let rows;

  switch (count) {
    case 1:
      rows = [1];
      break;
    case 2:
      rows = ratio >= 1 && fitsColumns(2) ? [2] : [1, 1];
      break;
    case 3:
      if (ratio >= 1 && fitsColumns(3)) {
        rows = [3];
      } else if (ratio >= 1 && fitsColumns(2)) {
        rows = [2, 1];
      } else {
        rows = [1, 1, 1];
      }
      break;
    case 4:
      if (superThin) {
        rows = [1, 1, 1, 1];
      } else if (superWide && fitsColumns(4)) {
        rows = [4];
      } else if (fitsColumns(2) && fitsRows(2)) {
        rows = [2, 2];
      } else if (fitsColumns(2)) {
        rows = [2, 1, 1];
      } else {
        rows = [1, 1, 1, 1];
      }
      break;
    case 5:
      if (superThin) {
        rows = [1, 1, 1, 1, 1];
      } else if (superWide && fitsColumns(5)) {
        rows = [5];
      } else if (fitsColumns(2) && !fitsColumns(3)) {
        rows = [2, 2, 1];
      } else if (fitsColumns(3) && fitsRows(2)) {
        rows = [3, 2];
      } else if (fitsColumns(3) && fitsRows(3)) {
        rows = [2, 2, 1];
      } else if (fitsColumns(2)) {
        rows = [2, 2, 1];
      } else {
        rows = [1, 1, 1, 1, 1];
      }
      break;
    case 6:
      if (superThin) {
        rows = [1, 1, 1, 1, 1, 1];
      } else if (superWide && fitsColumns(6)) {
        rows = [6];
      } else {
        const canThreeCols = fitsColumns(3);
        const canTwoCols = fitsColumns(2);
        const preferWide = ratio >= 1;
        if (canThreeCols && preferWide && fitsRows(2)) {
          rows = [3, 3];
        } else if (canThreeCols && !canTwoCols && fitsRows(2)) {
          rows = [3, 3];
        } else if (canTwoCols && fitsRows(3)) {
          rows = [2, 2, 2];
        } else if (canThreeCols) {
          rows = [3, 3];
        } else if (canTwoCols) {
          rows = [2, 2, 2];
        } else {
          rows = [1, 1, 1, 1, 1, 1];
        }
      }
      break;
    default:
      rows = Array.from({ length: count }, () => 1);
      break;
  }

  const rowWidths = rows.map((cols) => widthFor(cols));
  const requiredWidth = Math.max(...rowWidths);
  const requiredHeight = heightForRows(rows.length);

  return {
    rows,
    requiredWidth,
    requiredHeight,
    fitsWidth: requiredWidth <= viewport.width,
    fitsHeight: requiredHeight <= viewport.height,
  };
}

function clampTileSize(size, viewport) {
  const maxWidth = Math.max(120, viewport.width - 32);
  const maxHeight = Math.max(120, viewport.height - INFO_HEIGHT - 48);
  const limited = Math.min(size, maxWidth, maxHeight);
  return Math.max(120, Math.floor(limited));
}

function getViewport() {
  const area = elements.contentArea;
  if (!area) {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  const width = area.clientWidth || window.innerWidth;
  const height = area.clientHeight || window.innerHeight;
  return { width, height };
}

function applyOverflowStates(layout) {
  const contentArea = elements.contentArea;
  const container = elements.blocksContainer;
  if (!contentArea || !container) {
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const areaHeight = contentArea.clientHeight;
  const areaWidth = contentArea.clientWidth;

  const verticalOverflow = containerRect.height > areaHeight + 1;
  const horizontalOverflow = containerRect.width > areaWidth + 1;

  contentArea.classList.toggle("is-scroll-y", verticalOverflow);
  contentArea.classList.toggle("is-scroll-x", horizontalOverflow);

  contentArea.style.overflowY = verticalOverflow ? "auto" : "hidden";
  contentArea.style.overflowX = horizontalOverflow ? "auto" : "hidden";

  if (!verticalOverflow) {
    contentArea.scrollTop = 0;
  }
  if (!horizontalOverflow) {
    contentArea.scrollLeft = 0;
  }
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
  const kind = block.kind;

  if (kind !== "Text" && block.imageUrl) {
    const img = document.createElement("img");
    img.src = block.imageUrl;
    img.alt = block.imageAlt || block.descriptionText || block.title || "Are.na preview";
    img.loading = "lazy";
    container.appendChild(img);
    return;
  }

  if (kind === "Text") {
    const wrapper = document.createElement("div");
    wrapper.className = "text-tile";
    const content = document.createElement("span");
    content.className = "tile-text-content";
    const textContent = block.contentText || block.descriptionText || block.title || "Text";
    content.textContent = textContent.trim() || "Text";
    wrapper.appendChild(content);
    container.appendChild(wrapper);
    return;
  }

  if (kind === "Link" && block.linkUrl) {
    container.appendChild(createChip(formatLinkLabel(block.linkUrl)));
    return;
  }

  if (kind === "Attachment" && block.attachment?.url) {
    const name = block.attachment.fileName || block.title || "Attachment";
    container.appendChild(createChip(name));
    return;
  }

  if (kind === "Embed") {
    const label = block.embed?.type || block.title || "Embed";
    container.appendChild(createChip(label));
    return;
  }

  if (kind === "Channel") {
    if (block.counts?.contents) {
      container.appendChild(createChip(formatCount(block.counts.contents, "item")));
      return;
    }
    if (block.owner?.name) {
      container.appendChild(createChip(block.owner.name));
      return;
    }
    if (block.channel?.title) {
      container.appendChild(createChip(block.channel.title));
      return;
    }
  }

  if (block.source?.provider?.name) {
    container.appendChild(createChip(block.source.provider.name));
    return;
  }

  const fallback = block.descriptionText || block.title || "Untitled";
  container.appendChild(createChip(fallback));
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

function getCacheLedStatus() {
  const status = state.cacheMeta?.state || CACHE_STATE.idle;
  const timestamp = state.cacheMeta.lastUpdated || state.cache?.fetchedAt;

  if (status === CACHE_STATE.error) {
    return "error";
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
  if (button) {
    button.disabled = state.cacheMeta?.state === CACHE_STATE.working;
  }
  if (!label) {
    return;
  }

  const status = state.cacheMeta?.state || CACHE_STATE.idle;
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
    case CACHE_STATE.working:
      label.textContent = "Refreshing...";
      break;
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
      state.settings = settings;
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
  if (changes[STORAGE_KEYS.cache] || changes[STORAGE_KEYS.cacheMeta]) {
    getCache().then(({ cache, meta }) => {
      state.cache = cache;
      state.cacheMeta = { ...state.cacheMeta, ...meta };
      if (!cache.blockIds.length || needsCacheSelection()) {
        renderBlocks();
      }
      updateCacheStatus();
    });
  }
}

function handleRuntimeMessage(message) {
  if (message?.type === MESSAGES.cacheStatus) {
    state.cacheMeta = { ...state.cacheMeta, ...message.payload };
    updateCacheStatus();
  }
  return false;
}

function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.currentBlocks.length) {
      renderLayout(state.currentBlocks);
    }
    repositionOpenMenus();
    applyBookmarkOverflow();
  }, RESIZE_DEBOUNCE);
}

function handleScroll() {
  repositionOpenMenus();
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
