import { BLOCK_TYPES, CACHE_STATE, DEFAULT_SETTINGS, STORAGE_KEYS, TILE_SIZE_OPTIONS } from "./constants.js";
import { bookmarks, storage } from "./extension-api.js";
import {
    clearArenaAuth,
    clearCache,
    getArenaAuth,
    getSettings,
    saveArenaAuth,
    saveSettings
} from "./storage.js";
import { connectArenaAccount, loadArenaAccountCatalog } from "./arena-account.js";
import { getChannelRequestCost } from "./arena.js";
import { createBarEditor } from "./bar-customization.js";
import { canonicalizeSettings, classifySettingsChanges } from "./settings-model.js";
import { applyTheme } from "./theme.js";
import { formatCountdown, formatRelativeTime } from "./time.js";
import { getRequestBudget } from "./rate-limiter.js";
import { runtimeCacheLifecycle } from "./cache-refresh.js";
import { applyPlan, resolvePlan, validatePlan } from "./bookmark-plan-runner.js";
import { clearTrash, readTrash, restoreEntry } from "./bookmarks-trash.js";
import { resetNewMarkers } from "./bookmarks-state.js";

const EMPTY_AUTH = { token: "", user: null };

const state = {
    settings: canonicalizeSettings(),
    auth: { ...EMPTY_AUTH },
    cache: null,
    cacheMeta: {
        state: CACHE_STATE.idle,
        lastUpdated: 0,
        lastError: null,
        retryAt: 0,
        progress: null
    },
    rateLimit: null,
    ownedChannels: [],
    followedChannels: [],
    ownedTotal: 0,
    followedTotal: 0,
    catalogLoaded: false,
    working: false,
    sourcesDirty: false,
    displayDirty: false,
    resolvedPlan: null,
    bookmarkTrash: []
};

let settingsScrollFrame = null;

const elements = {
    form: document.getElementById("settings-form"),
    contentArea: document.getElementById("content-area"),
    channelSlugs: document.getElementById("channel-slugs"),
    blockIds: document.getElementById("block-ids"),
    blockCount: document.getElementById("block-count"),
    blockCountOutput: document.getElementById("block-count-output"),
    tileSize: document.getElementById("tile-size"),
    tileSizeOutput: document.getElementById("tile-size-output"),
    showHeader: document.getElementById("show-header"),
    showFooter: document.getElementById("show-footer"),
    includeFeed: document.getElementById("include-feed"),
    filters: document.querySelectorAll("input[name='filters']"),
    themeRadios: document.querySelectorAll("input[name='theme']"),
    blockMetaFields: document.querySelectorAll("input[name='blockMetaFields']"),
    barComponentSelects: document.querySelectorAll("select[data-bar-slot]"),
    barFormatOptions: document.getElementById("bar-format-options"),
    dateFormatField: document.getElementById("date-format-field"),
    timeFormatField: document.getElementById("time-format-field"),
    dateFormat: document.getElementById("date-format"),
    timeFormat: document.getElementById("time-format"),
    settingsAccessWarning: document.getElementById("settings-access-warning"),
    cacheInfo: document.getElementById("cache-info"),
    clearCacheButton: document.getElementById("clear-cache-button"),
    clearCacheDialog: document.getElementById("clear-cache-dialog"),
    clearCacheCancelButton: document.getElementById("clear-cache-cancel"),
    clearCacheConfirmButton: document.getElementById("clear-cache-confirm"),
    sourceSaveButtons: document.querySelectorAll(".source-save-button"),
    displaySaveButton: document.getElementById("save-display"),
    backButton: document.getElementById("back-button"),
    saveAllButton: document.getElementById("save-all-button"),
    unsavedIndicator: document.getElementById("unsaved-indicator"),
    settingsStatus: document.getElementById("settings-status"),
    navButtons: document.querySelectorAll("[data-settings-nav]"),
    pages: document.querySelectorAll("[data-settings-page]"),
    arenaToken: document.getElementById("arena-token"),
    connectArenaButton: document.getElementById("connect-arena"),
    disconnectArenaButton: document.getElementById("disconnect-arena"),
    reloadAccountChannelsButton: document.getElementById("reload-account-channels"),
    accountSummary: document.getElementById("account-summary"),
    accountSourcesFieldset: document.getElementById("account-sources-fieldset"),
    ownedChannelPicker: document.getElementById("owned-channel-picker"),
    followedChannelPicker: document.getElementById("followed-channel-picker"),
    accountChannelNote: document.getElementById("account-channel-note"),
    accountCostNote: document.getElementById("account-cost-note"),
    rateLimitInfo: document.getElementById("rate-limit-info"),
    bookmarksRoot: document.getElementById("bookmarks-root"),
    hiddenFolders: document.getElementById("hidden-folders"),
    launchFolder: document.getElementById("launch-folder"),
    pinnedFolders: document.getElementById("pinned-folders"),
    mainFolders: document.getElementById("main-folders"),
    bookmarksSaveButton: document.getElementById("save-bookmarks"),
    resetNewMarkersButton: document.getElementById("reset-new-markers"),
    bookmarkTrash: document.getElementById("bookmark-trash"),
    clearTrashButton: document.getElementById("clear-trash"),
    planJson: document.getElementById("plan-json"),
    planFile: document.getElementById("plan-file"),
    dryRunPlanButton: document.getElementById("dry-run-plan"),
    planStatus: document.getElementById("plan-status"),
    planPreview: document.getElementById("plan-preview"),
    planRoot: document.getElementById("plan-root"),
    planSummary: document.getElementById("plan-summary"),
    planTargets: document.getElementById("plan-targets"),
    planRemovals: document.getElementById("plan-removals"),
    planWarnings: document.getElementById("plan-warnings"),
    applyHiddenFolders: document.getElementById("apply-hidden-folders"),
    removeSourceFolder: document.getElementById("remove-source-folder"),
    removeSourceLabel: document.getElementById("remove-source-label"),
    applyPlanButton: document.getElementById("apply-plan"),
    planResult: document.getElementById("plan-result")
};

let cacheCooldownTimer = null;

const TILE_SIZE_LABEL_MAP = {
    auto: "Auto",
    xs: "Extra small",
    s: "Small",
    m: "Medium",
    l: "Large",
    xl: "Extra large"
};

const barEditor = createBarEditor({
    selects: elements.barComponentSelects,
    formatOptions: elements.barFormatOptions,
    dateFormatField: elements.dateFormatField,
    timeFormatField: elements.timeFormatField
});

const sanitizeErrorLabel = (message) => {
    if (!message || typeof message !== "string") {
        return "Error";
    }
    const lower = message.toLowerCase();
    if (lower.includes("failed to fetch") || lower.includes("network") || lower.includes("offline")) {
        return "Offline";
    }
    if (lower.includes("timeout") || lower.includes("aborted") || /\(504\)/.test(message)) {
        return "Timeout";
    }
    if (/\(401\)/.test(message) || /\(403\)/.test(message)) {
        return "Invalid or unauthorized token";
    }
    if (/\(404\)/.test(message) || lower.includes("not found")) {
        return "Not found";
    }
    if (/\(429\)/.test(message) || lower.includes("rate limit")) {
        return "Rate limited";
    }
    const stripped = message.replace(/<[^>]*>/g, "").trim();
    return stripped.length > 60 ? `${stripped.slice(0, 57)}...` : stripped || "Error";
};

async function init() {
    try {
        await hydrateState();
        await Promise.all([populateBookmarkRoots(), renderBookmarkTrash()]);
        populateForm();
        updateTheme(getSelectedTheme());
        updateCacheInfo();
        renderRateLimitInfo();
        renderAccountState();
        wireEvents();
        if (state.auth.token) {
            await loadAccountCatalog({ quiet: true });
        }
        const initialSection = readSectionFromHash();
        setActiveSettingsSection(initialSection);
        if (window.location.hash) {
            requestAnimationFrame(() => scrollToSettingsSection(initialSection, { behavior: "auto", updateHash: false }));
        }
        updateDirtyState();
    } catch (error) {
        console.error("Failed to init settings", error);
        showStatus(`Error: ${sanitizeErrorLabel(error.message)}`);
    }
}

async function hydrateState() {
    const [settings, auth, cacheState, rateLimit] = await Promise.all([
        getSettings(),
        getArenaAuth(),
        runtimeCacheLifecycle.read(),
        storage.get(STORAGE_KEYS.rateLimit)
    ]);
    state.settings = settings;
    state.auth = auth;
    state.rateLimit = rateLimit?.[STORAGE_KEYS.rateLimit] || null;
    state.cache = cacheState.cache;
    state.cacheMeta = {
        ...state.cacheMeta,
        ...cacheState.meta,
        lastUpdated: cacheState.meta.lastUpdated || cacheState.cache.completedAt || 0
    };
}

function populateForm(settings = state.settings) {
    if (elements.channelSlugs) {
        elements.channelSlugs.value = settings.channelSlugs.join(", ");
    }
    if (elements.blockIds) {
        elements.blockIds.value = settings.blockIds.join(", ");
    }
    if (elements.blockCount) {
        elements.blockCount.value = String(settings.blockCount);
        updateBlockCountOutput();
    }
    if (elements.tileSize) {
        elements.tileSize.value = String(Math.max(0, TILE_SIZE_OPTIONS.indexOf(settings.tileSize)));
        updateTileSizeOutput();
    }
    if (elements.showHeader) {
        elements.showHeader.checked = settings.showHeader;
    }
    if (elements.showFooter) {
        elements.showFooter.checked = settings.showFooter;
    }
    if (elements.includeFeed) {
        elements.includeFeed.checked = Boolean(settings.includeFeed);
    }

    const selectedFilters = new Set(settings.filters);
    elements.filters.forEach((checkbox) => {
        checkbox.checked = selectedFilters.has(checkbox.value) || (!selectedFilters.size && BLOCK_TYPES.includes(checkbox.value));
    });

    elements.themeRadios.forEach((radio) => {
        radio.checked = radio.value === settings.theme;
    });
    barEditor.write(settings.barLayout);
    if (elements.dateFormat) {
        elements.dateFormat.value = settings.dateFormat;
    }
    if (elements.timeFormat) {
        elements.timeFormat.value = settings.timeFormat;
    }
    const selectedMetaFields = new Set(settings.blockMetaFields);
    elements.blockMetaFields.forEach((checkbox) => {
        checkbox.checked = selectedMetaFields.has(checkbox.value);
    });
    updateSettingsAccessWarning();
    if (elements.bookmarksRoot) {
        ensureBookmarkRootOption(settings.bookmarksRootPath);
        elements.bookmarksRoot.value = settings.bookmarksRootPath;
    }
    if (elements.hiddenFolders) {
        elements.hiddenFolders.value = settings.hiddenFolders.join("\n");
    }
    if (elements.launchFolder) {
        elements.launchFolder.value = settings.launchFolder;
    }
    if (elements.pinnedFolders) {
        elements.pinnedFolders.value = settings.pinnedFolders.join("\n");
    }
    if (elements.mainFolders) {
        elements.mainFolders.value = settings.mainFolders.join("\n");
    }

    renderAccountCatalog(new Set(settings.accountChannelSlugs));
}

function wireEvents() {
    elements.form?.addEventListener("reset", handleReset);
    elements.blockCount?.addEventListener("input", () => {
        updateBlockCountOutput();
        updateDirtyState();
    });
    elements.tileSize?.addEventListener("input", () => {
        updateTileSizeOutput();
        updateDirtyState();
    });
    elements.themeRadios.forEach((radio) => {
        radio.addEventListener("change", (event) => {
            if (event.target.checked) {
                updateTheme(event.target.value);
                updateDirtyState();
            }
        });
    });
    elements.barComponentSelects.forEach((select) => {
        select.addEventListener("change", handleBarComponentChange);
    });
    [elements.dateFormat, elements.timeFormat].forEach((select) => {
        select?.addEventListener("change", updateDirtyState);
    });
    elements.blockMetaFields.forEach((checkbox) => {
        checkbox.addEventListener("change", updateDirtyState);
    });
    [elements.showHeader, elements.showFooter].forEach((checkbox) => {
        checkbox?.addEventListener("change", updateSettingsAccessWarning);
    });
    elements.sourceSaveButtons.forEach((button) => button.addEventListener("click", handleSourcesSave));
    elements.clearCacheButton?.addEventListener("click", handleClearCacheOpen);
    elements.clearCacheCancelButton?.addEventListener("click", handleClearCacheCancel);
    elements.clearCacheConfirmButton?.addEventListener("click", handleClearCacheConfirm);
    elements.displaySaveButton?.addEventListener("click", handleDisplaySave);
    elements.bookmarksSaveButton?.addEventListener("click", handleBookmarksSave);
    elements.resetNewMarkersButton?.addEventListener("click", handleResetNewMarkers);
    elements.clearTrashButton?.addEventListener("click", handleClearTrash);
    elements.bookmarkTrash?.addEventListener("click", handleTrashClick);
    elements.planJson?.addEventListener("input", invalidatePlanPreview);
    elements.planFile?.addEventListener("change", handlePlanFile);
    elements.dryRunPlanButton?.addEventListener("click", handlePlanDryRun);
    elements.applyPlanButton?.addEventListener("click", handlePlanApply);
    elements.backButton?.addEventListener("click", handleBack);
    elements.saveAllButton?.addEventListener("click", handleSaveAll);
    elements.connectArenaButton?.addEventListener("click", handleConnectArena);
    elements.disconnectArenaButton?.addEventListener("click", handleDisconnectArena);
    elements.reloadAccountChannelsButton?.addEventListener("click", () => loadAccountCatalog());
    elements.navButtons.forEach((button) => {
        button.addEventListener("click", handleSettingsNavClick);
    });
    elements.contentArea?.addEventListener("scroll", handleSettingsScroll, { passive: true });
    window.addEventListener("resize", handleSettingsScroll, { passive: true });
    window.addEventListener("hashchange", () => {
        scrollToSettingsSection(readSectionFromHash(), { behavior: getSettingsScrollBehavior(), updateHash: false });
    });

    [elements.channelSlugs, elements.blockIds, elements.showHeader, elements.showFooter, elements.includeFeed, elements.bookmarksRoot, elements.hiddenFolders, elements.launchFolder, elements.pinnedFolders, elements.mainFolders].forEach((control) => {
        control?.addEventListener("input", updateDirtyState);
        control?.addEventListener("change", updateDirtyState);
    });
    elements.filters.forEach((checkbox) => checkbox.addEventListener("change", updateDirtyState));
    elements.ownedChannelPicker?.addEventListener("change", handleAccountChannelChange);
    elements.followedChannelPicker?.addEventListener("change", handleAccountChannelChange);

    storage?.onChanged?.addListener(handleStorageChange);
}

function readSectionFromHash() {
    const requested = window.location.hash.replace(/^#/, "");
    return Array.from(elements.pages).some(page => page.dataset.settingsPage === requested) ? requested : "sources";
}

function getSettingsSection(sectionName) {
    return Array.from(elements.pages).find(page => page.dataset.settingsPage === sectionName) || elements.pages[0] || null;
}

function setActiveSettingsSection(sectionName) {
    const nextSection = getSettingsSection(sectionName)?.dataset.settingsPage || "sources";
    elements.navButtons.forEach((button) => {
        const active = button.dataset.settingsNav === nextSection;
        button.classList.toggle("is-active", active);
        if (active) {
            button.setAttribute("aria-current", "location");
        } else {
            button.removeAttribute("aria-current");
        }
    });
}

function getSettingsScrollBehavior() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function scrollToSettingsSection(sectionName, { behavior = "auto", updateHash = true } = {}) {
    const section = getSettingsSection(sectionName);
    if (!section) {
        return;
    }
    setActiveSettingsSection(section.dataset.settingsPage);
    section.scrollIntoView({ behavior, block: "start" });
    if (updateHash && window.location.hash !== `#${section.dataset.settingsPage}`) {
        window.history.replaceState(null, "", `#${section.dataset.settingsPage}`);
    }
}

function handleSettingsNavClick(event) {
    event.preventDefault();
    scrollToSettingsSection(event.currentTarget.dataset.settingsNav, { behavior: getSettingsScrollBehavior() });
}

function handleSettingsScroll() {
    if (settingsScrollFrame) {
        return;
    }
    settingsScrollFrame = requestAnimationFrame(() => {
        settingsScrollFrame = null;
        updateActiveSettingsSection();
    });
}

function updateActiveSettingsSection() {
    const contentArea = elements.contentArea;
    const sections = Array.from(elements.pages);
    if (!contentArea || !sections.length) {
        return;
    }
    const contentRect = contentArea.getBoundingClientRect();
    const readingLine = contentRect.top + Math.min(180, Math.max(80, contentRect.height * 0.25));
    let current = sections[0];
    sections.forEach((section) => {
        if (section.getBoundingClientRect().top <= readingLine) {
            current = section;
        }
    });
    if (contentArea.scrollTop + contentArea.clientHeight >= contentArea.scrollHeight - 2) {
        current = sections[sections.length - 1];
    }
    setActiveSettingsSection(current.dataset.settingsPage);
}

function getSelectedTheme() {
    return document.querySelector("input[name='theme']:checked")?.value || DEFAULT_SETTINGS.theme;
}

function gatherSourceSettings() {
    const filters = Array.from(document.querySelectorAll("input[name='filters']:checked"), input => input.value);
    return {
        channelSlugs: elements.channelSlugs?.value || "",
        blockIds: elements.blockIds?.value || "",
        filters: filters.length ? filters : [...BLOCK_TYPES],
        includeFeed: Boolean(state.auth.token && elements.includeFeed?.checked),
        accountChannelSlugs: getSelectedAccountChannelSlugs()
    };
}

function gatherDisplaySettings() {
    const blockCount = Math.min(8, Math.max(1, Number(elements.blockCount?.value || DEFAULT_SETTINGS.blockCount)));
    const tileIndex = Number(elements.tileSize?.value || 0);
    const blockMetaFields = Array.from(document.querySelectorAll("input[name='blockMetaFields']:checked"), input => input.value);
    return {
        blockCount,
        showHeader: Boolean(elements.showHeader?.checked),
        showFooter: Boolean(elements.showFooter?.checked),
        tileSize: TILE_SIZE_OPTIONS[tileIndex] || DEFAULT_SETTINGS.tileSize,
        theme: getSelectedTheme(),
        barLayout: gatherBarLayout(),
        dateFormat: elements.dateFormat?.value || DEFAULT_SETTINGS.dateFormat,
        timeFormat: elements.timeFormat?.value || DEFAULT_SETTINGS.timeFormat,
        blockMetaFields
    };
}

function gatherBarLayout() {
    return barEditor.read();
}

function gatherBookmarkSettings() {
    return {
        bookmarksRootPath: elements.bookmarksRoot?.value || "",
        hiddenFolders: elements.hiddenFolders?.value || "",
        launchFolder: elements.launchFolder?.value || "",
        pinnedFolders: elements.pinnedFolders?.value || "",
        mainFolders: elements.mainFolders?.value || ""
    };
}

const gatherFormSettings = () => ({
    ...gatherSourceSettings(),
    ...gatherDisplaySettings(),
    ...gatherBookmarkSettings()
});

function findBookmarksBar(tree) {
    const root = tree?.[0];
    return root?.children?.find((node) => String(node.id) === "1")
        || root?.children?.find((node) => /bookmark/i.test(node.title || ""))
        || root?.children?.[0]
        || null;
}

function ensureBookmarkRootOption(path) {
    if (!elements.bookmarksRoot || !path || Array.from(elements.bookmarksRoot.options).some((option) => option.value === path)) {
        return;
    }
    elements.bookmarksRoot.add(new Option(path, path));
}

async function populateBookmarkRoots() {
    if (!elements.bookmarksRoot) {
        return;
    }
    elements.bookmarksRoot.innerHTML = "";
    elements.bookmarksRoot.add(new Option("Bookmarks bar", ""));
    if (!bookmarks) {
        elements.bookmarksRoot.disabled = true;
        return;
    }
    const tree = await bookmarks.getTree();
    const bar = findBookmarksBar(tree);
    for (const child of bar?.children || []) {
        if (!child.url && child.type !== "separator") {
            elements.bookmarksRoot.add(new Option(child.title || "(untitled)", child.title || ""));
        }
    }
}

async function resolveBoardRootId() {
    const tree = await bookmarks.getTree();
    let current = findBookmarksBar(tree);
    for (const segment of (state.settings.bookmarksRootPath || "").split("/").filter(Boolean)) {
        current = current?.children?.find((child) => !child.url && `${child.title || ""}`.toLowerCase() === segment.toLowerCase());
        if (!current) {
            return String(findBookmarksBar(tree)?.id || "1");
        }
    }
    return String(current?.id || "1");
}

async function handleBookmarksSave(event) {
    event.preventDefault();
    if (state.working) {
        return;
    }
    const nextSettings = { ...state.settings, ...gatherBookmarkSettings() };
    if (!classifySettingsChanges(nextSettings, state.settings).changed) {
        showStatus("Bookmark settings are already saved.");
        return;
    }
    updateWorking(true, "Saving bookmark settings...");
    try {
        state.settings = await saveSettings(nextSettings);
        populateForm();
        updateDirtyState();
        showStatus("Bookmark settings saved.");
    } catch (error) {
        showStatus(`Save failed: ${sanitizeErrorLabel(error.message)}`);
    } finally {
        updateWorking(false);
    }
}

async function handleResetNewMarkers(event) {
    event.preventDefault();
    updateWorking(true, "Clearing new markers...");
    try {
        await resetNewMarkers();
        showStatus("New markers cleared.");
    } catch (error) {
        showStatus(`Reset failed: ${sanitizeErrorLabel(error.message)}`);
    } finally {
        updateWorking(false);
    }
}

async function renderBookmarkTrash() {
    if (!elements.bookmarkTrash) {
        return;
    }
    const trash = await readTrash();
    state.bookmarkTrash = trash.entries;
    elements.bookmarkTrash.innerHTML = "";
    if (!trash.entries.length) {
        const empty = document.createElement("li");
        empty.className = "bookmark-trash-empty";
        empty.textContent = "Nothing deleted yet.";
        elements.bookmarkTrash.append(empty);
        if (elements.clearTrashButton) {
            elements.clearTrashButton.disabled = true;
        }
        return;
    }
    if (elements.clearTrashButton) {
        elements.clearTrashButton.disabled = false;
    }
    for (const entry of trash.entries) {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${entry.label} · ${formatRelativeTime(entry.deletedAt)}`;
        const restore = document.createElement("button");
        restore.className = "button";
        restore.type = "button";
        restore.dataset.restoreTrash = entry.id;
        restore.textContent = "restore";
        item.append(label, restore);
        elements.bookmarkTrash.append(item);
    }
}

async function handleTrashClick(event) {
    const button = event.target.closest("[data-restore-trash]");
    if (!button || state.working || !bookmarks) {
        return;
    }
    const entry = state.bookmarkTrash.find((candidate) => candidate.id === button.dataset.restoreTrash);
    if (!entry) {
        return;
    }
    updateWorking(true, "Restoring bookmarks...");
    try {
        const rootId = await resolveBoardRootId();
        const result = await restoreEntry(entry, bookmarks, { rootId });
        const orphanNote = result.orphaned ? ` · ${result.orphaned} to the board root, folder gone` : "";
        showStatus(`${result.created.length} restored${orphanNote}.`);
        await renderBookmarkTrash();
    } catch (error) {
        showStatus(`Restore failed: ${sanitizeErrorLabel(error.message)}`);
    } finally {
        updateWorking(false);
    }
}

async function handleClearTrash(event) {
    event.preventDefault();
    if (state.working || !state.bookmarkTrash.length || !window.confirm("Clear deleted bookmarks permanently?")) {
        return;
    }
    updateWorking(true, "Clearing bookmark trash...");
    try {
        await clearTrash();
        await renderBookmarkTrash();
        showStatus("Bookmark trash cleared.");
    } catch (error) {
        showStatus(`Clear failed: ${sanitizeErrorLabel(error.message)}`);
    } finally {
        updateWorking(false);
    }
}

function invalidatePlanPreview() {
    state.resolvedPlan = null;
    if (elements.applyPlanButton) {
        elements.applyPlanButton.disabled = true;
    }
    if (elements.planPreview) {
        elements.planPreview.hidden = true;
    }
    if (elements.planResult) {
        elements.planResult.textContent = "";
    }
}

async function handlePlanFile(event) {
    const [file] = event.target.files || [];
    if (!file) {
        return;
    }
    elements.planJson.value = await file.text();
    invalidatePlanPreview();
    elements.planStatus.textContent = `Loaded ${file.name}. Run a dry run to continue.`;
}

function hostLabel(url) {
    try {
        return new URL(url).host;
    } catch {
        return url || "";
    }
}

function isHiddenTarget(path, hiddenFolders) {
    const candidate = path.toLowerCase();
    return hiddenFolders.some((hidden) => candidate === hidden || candidate.startsWith(`${hidden}/`));
}

function renderPlanPreview(plan, resolved) {
    const summary = resolved.summary;
    const hiddenFolders = (plan.hiddenFolders || []).map((path) => path.toLowerCase());
    const hiddenMoves = summary.targets.filter((target) => isHiddenTarget(target.path, hiddenFolders)).reduce((total, target) => total + target.moves, 0);
    elements.planRoot.textContent = `Root: ${plan.sourceFolder || plan.space || "Bookmarks bar"}`;
    elements.planSummary.textContent = `${summary.folderCount} folders to ensure (${summary.newFolderCount} new) · Moves: ${summary.moves} · already in place: ${summary.alreadyInPlace} · matched by url: ${summary.matchedByUrl} · Removes: ${summary.removes} · Skipped: ${summary.skipped}`;
    elements.planTargets.innerHTML = "";
    for (const target of summary.targets) {
        const row = document.createElement("tr");
        const path = document.createElement("td");
        const moves = document.createElement("td");
        const status = document.createElement("td");
        path.textContent = target.path;
        moves.textContent = String(target.moves);
        status.textContent = isHiddenTarget(target.path, hiddenFolders) ? "hidden" : target.isNew ? "new" : "exists";
        row.append(path, moves, status);
        elements.planTargets.append(row);
    }
    elements.planRemovals.innerHTML = "";
    if (summary.removals.length) {
        const heading = document.createElement("p");
        heading.textContent = `Removals · ${summary.removals.length}`;
        const list = document.createElement("ul");
        for (const removal of summary.removals) {
            const item = document.createElement("li");
            item.textContent = `${removal.reason} · ${removal.title} · ${hostLabel(removal.url)}`;
            list.append(item);
        }
        elements.planRemovals.append(heading, list);
    }
    elements.planWarnings.innerHTML = "";
    for (const warning of resolved.warnings) {
        const item = document.createElement("li");
        item.textContent = `${warning.reason} · ${warning.title || warning.id}`;
        elements.planWarnings.append(item);
    }
    if (hiddenMoves) {
        const item = document.createElement("li");
        item.textContent = `hidden — ${hiddenMoves} links will not appear on the board`;
        elements.planWarnings.append(item);
    }
    elements.applyHiddenFolders.checked = true;
    elements.applyHiddenFolders.parentElement.hidden = !plan.hiddenFolders?.length;
    elements.removeSourceFolder.checked = true;
    elements.removeSourceFolder.parentElement.hidden = !plan.sourceFolder;
    elements.removeSourceLabel.textContent = `remove the emptied source folder "${plan.sourceFolder || ""}"`;
    elements.planPreview.hidden = false;
}

async function handlePlanDryRun(event) {
    event.preventDefault();
    invalidatePlanPreview();
    if (!bookmarks) {
        elements.planStatus.textContent = "Bookmarks unavailable.";
        return;
    }
    let plan;
    try {
        plan = JSON.parse(elements.planJson.value);
    } catch (error) {
        elements.planStatus.textContent = `Invalid JSON: ${sanitizeErrorLabel(error.message)}`;
        return;
    }
    const validation = validatePlan(plan);
    if (!validation.ok) {
        elements.planStatus.textContent = validation.errors.join(" ");
        return;
    }
    updateWorking(true, "Reading bookmarks for dry run...");
    try {
        const tree = await bookmarks.getTree();
        const bar = findBookmarksBar(tree);
        const resolved = resolvePlan(plan, tree, { rootId: String(bar.id) });
        if (resolved.errors.length) {
            elements.planStatus.textContent = resolved.errors.join(" ");
            return;
        }
        state.resolvedPlan = { plan, resolved };
        renderPlanPreview(plan, resolved);
        elements.planStatus.textContent = `Dry run ready · ${resolved.summary.moves} moves · ${resolved.summary.removes} removes · ${resolved.errors.length} errors.`;
    } catch (error) {
        elements.planStatus.textContent = `Dry run failed: ${sanitizeErrorLabel(error.message)}`;
    } finally {
        updateWorking(false);
        elements.applyPlanButton.disabled = !state.resolvedPlan;
    }
}

function subtreeLinkCount(node) {
    return node?.url ? 1 : (node?.children || []).reduce((total, child) => total + subtreeLinkCount(child), 0);
}

async function removeDrainedSource(plan) {
    if (!elements.removeSourceFolder.checked || !plan.sourceFolder) {
        return "";
    }
    const tree = await bookmarks.getTree();
    const bar = findBookmarksBar(tree);
    const source = bar?.children?.find((child) => !child.url && `${child.title || ""}`.toLowerCase() === plan.sourceFolder.toLowerCase());
    if (!source) {
        return "";
    }
    const remaining = subtreeLinkCount(source);
    if (remaining) {
        return ` · source folder kept with ${remaining} remaining`;
    }
    await bookmarks.removeTree(String(source.id));
    return ` · removed ${plan.sourceFolder}`;
}

async function handlePlanApply(event) {
    event.preventDefault();
    if (state.working || !state.resolvedPlan || !bookmarks) {
        return;
    }
    const { plan, resolved } = state.resolvedPlan;
    updateWorking(true, "Applying bookmark plan...");
    try {
        const result = await applyPlan(resolved, bookmarks, (done, total) => {
            elements.planStatus.textContent = `applying ${done}/${total}`;
        });
        let sourceNote = "";
        if (!result.failed) {
            sourceNote = await removeDrainedSource(plan);
            if (elements.applyHiddenFolders.checked && plan.hiddenFolders?.length) {
                state.settings = await saveSettings({ ...state.settings, hiddenFolders: plan.hiddenFolders });
                populateForm();
            }
        }
        elements.planResult.textContent = `Applied ${result.applied} of ${result.applied + result.failed} · ${result.failed} failed${sourceNote}.`;
        elements.planStatus.textContent = result.failed ? result.errors.map((error) => error.message).join(" · ") : "Plan applied.";
        await Promise.all([populateBookmarkRoots(), renderBookmarkTrash()]);
        ensureBookmarkRootOption(state.settings.bookmarksRootPath);
        elements.bookmarksRoot.value = state.settings.bookmarksRootPath;
        updateDirtyState();
        state.resolvedPlan = null;
        elements.applyPlanButton.disabled = true;
    } catch (error) {
        elements.planResult.textContent = `Apply failed: ${sanitizeErrorLabel(error.message)}`;
    } finally {
        updateWorking(false);
        elements.applyPlanButton.disabled = true;
    }
}

async function handleDisplaySave(event) {
    event.preventDefault();
    if (state.working) {
        return;
    }
    const nextSettings = { ...state.settings, ...gatherDisplaySettings() };
    if (!classifySettingsChanges(nextSettings, state.settings).changed) {
        showStatus("Display settings are already saved.");
        return;
    }
    updateWorking(true, "Saving display settings...");
    try {
        state.settings = await saveSettings(nextSettings);
        updateTheme(state.settings.theme);
        updateDirtyState();
        showStatus("Display settings saved.");
    } catch (error) {
        console.error("Failed to save display settings", error);
        showStatus(`Save failed: ${sanitizeErrorLabel(error.message)}`);
    } finally {
        updateWorking(false);
    }
}

function handleReset(event) {
    event.preventDefault();
    populateForm(canonicalizeSettings());
    updateTheme(DEFAULT_SETTINGS.theme);
    updateDirtyState();
    showStatus("Defaults loaded. Save to apply.");
}

async function handleSourcesSave(event) {
    event?.preventDefault?.();
    if (state.working) {
        return;
    }
    const nextSettings = { ...state.settings, ...gatherSourceSettings() };
    const settingsChanged = classifySettingsChanges(nextSettings, state.settings).changed;
    updateWorking(true, settingsChanged ? "Saving sources..." : "Refreshing cache...");
    try {
        if (settingsChanged) {
            state.settings = await saveSettings(nextSettings);
            updateDirtyState();
        }
        const summary = await runtimeCacheLifecycle.refresh({ force: true });
        showStatus(`Cache refreshed with ${summary?.blockCount || 0} block${summary?.blockCount === 1 ? "" : "s"}.`);
    } catch (error) {
        console.error("Refresh failed", error);
        showStatus(`Refresh failed: ${sanitizeErrorLabel(error.message)}`);
    } finally {
        updateWorking(false);
    }
}

function handleClearCacheOpen(event) {
    event.preventDefault();
    if (state.working || !elements.clearCacheDialog || elements.clearCacheDialog.open) {
        return;
    }
    if (typeof elements.clearCacheDialog.showModal === "function") {
        elements.clearCacheDialog.showModal();
    } else {
        elements.clearCacheDialog.setAttribute("open", "");
    }
}

function handleClearCacheCancel(event) {
    event.preventDefault();
    closeClearCacheDialog();
}

async function handleClearCacheConfirm(event) {
    event.preventDefault();
    if (state.working) {
        return;
    }
    let cacheCleared = false;
    if (elements.clearCacheConfirmButton) {
        elements.clearCacheConfirmButton.disabled = true;
    }
    updateWorking(true, "Clearing cache...");
    try {
        await clearCache();
        const { cache, meta } = await runtimeCacheLifecycle.read();
        state.cache = cache;
        state.cacheMeta = meta;
        updateCacheInfo();
        cacheCleared = true;
        closeClearCacheDialog();
        showStatus("Cache cleared. Click Save & Refresh to rebuild it.");
    } catch (error) {
        console.error("Failed to clear cache", error);
        showStatus(`Clear failed: ${sanitizeErrorLabel(error.message)}`);
    } finally {
        if (elements.clearCacheConfirmButton) {
            elements.clearCacheConfirmButton.disabled = false;
        }
        updateWorking(false);
        if (cacheCleared) {
            elements.clearCacheButton?.focus();
        }
    }
}

function closeClearCacheDialog() {
    if (!elements.clearCacheDialog?.open) {
        return;
    }
    if (typeof elements.clearCacheDialog.close === "function") {
        elements.clearCacheDialog.close();
    } else {
        elements.clearCacheDialog.removeAttribute("open");
    }
}

async function handleConnectArena(event) {
    event.preventDefault();
    if (state.working) {
        return;
    }
    updateWorking(true, "Connecting to Are.na...");
    try {
        const auth = await connectArenaAccount(elements.arenaToken?.value || "");
        state.auth = await saveArenaAuth(auth);
        if (elements.arenaToken) {
            elements.arenaToken.value = "";
        }
        state.catalogLoaded = false;
        renderAccountState();
        await loadAccountCatalog({ quiet: true });
        showStatus(`Connected as ${state.auth.user?.name || "Are.na user"}.`);
    } catch (error) {
        console.error("Are.na connection failed", error);
        showStatus(`Connection failed: ${sanitizeErrorLabel(error.message)}`);
    } finally {
        updateWorking(false);
    }
}

async function handleDisconnectArena(event) {
    event.preventDefault();
    if (state.working) {
        return;
    }
    updateWorking(true, "Disconnecting Are.na account...");
    try {
        await clearArenaAuth();
        state.auth = { ...EMPTY_AUTH };
        state.ownedChannels = [];
        state.followedChannels = [];
        state.catalogLoaded = false;
        state.settings = await saveSettings({
            ...state.settings,
            includeFeed: false,
            accountChannelSlugs: []
        });
        renderAccountState();
        renderAccountCatalog(new Set());
        updateDirtyState();
        await runtimeCacheLifecycle.refresh();
        showStatus("Are.na account disconnected and account sources removed.");
    } catch (error) {
        console.error("Are.na disconnect failed", error);
        showStatus(`Disconnect failed: ${sanitizeErrorLabel(error.message)}`);
    } finally {
        updateWorking(false);
    }
}

async function loadAccountCatalog({ quiet = false } = {}) {
    if (!state.auth.token || !state.auth.user) {
        renderAccountState();
        return;
    }
    const selected = new Set(getSelectedAccountChannelSlugs());
    if (!quiet) {
        showStatus("Loading account channels...");
    }
    if (elements.reloadAccountChannelsButton) {
        elements.reloadAccountChannelsButton.disabled = true;
    }
    try {
        const catalog = await loadArenaAccountCatalog(state.auth);
        state.ownedChannels = catalog.ownedChannels;
        state.followedChannels = catalog.followedChannels;
        state.ownedTotal = catalog.ownedTotal;
        state.followedTotal = catalog.followedTotal;
        state.catalogLoaded = true;
        renderAccountCatalog(selected);
        if (!quiet) {
            showStatus("Account channels loaded.");
        }
    } catch (error) {
        state.catalogLoaded = false;
        console.error("Failed to load account channels", error);
        showStatus(`Could not load channels: ${sanitizeErrorLabel(error.message)}`);
        renderAccountCatalog(new Set(state.settings.accountChannelSlugs));
    } finally {
        if (elements.reloadAccountChannelsButton) {
            elements.reloadAccountChannelsButton.disabled = false;
        }
        renderAccountState();
    }
}

function renderAccountState() {
    const connected = Boolean(state.auth.token && state.auth.user);
    if (elements.accountSummary) {
        elements.accountSummary.innerHTML = "";
        const stateLabel = document.createElement("span");
        stateLabel.className = "account-state";
        stateLabel.textContent = connected
            ? `Connected as ${state.auth.user.name}${state.auth.user.slug ? ` · @${state.auth.user.slug}` : ""}`
            : "Not connected";
        elements.accountSummary.appendChild(stateLabel);
    }
    if (elements.accountSourcesFieldset) {
        elements.accountSourcesFieldset.disabled = !connected;
    }
    if (elements.connectArenaButton) {
        elements.connectArenaButton.hidden = connected;
    }
    if (elements.disconnectArenaButton) {
        elements.disconnectArenaButton.hidden = !connected;
    }
    if (elements.arenaToken) {
        elements.arenaToken.disabled = connected;
        elements.arenaToken.placeholder = connected ? "Account connected" : "Paste token";
    }
}

function renderAccountCatalog(selected = new Set(state.settings.accountChannelSlugs)) {
    renderChannelPicker(elements.ownedChannelPicker, state.ownedChannels, selected, "No owned channels found.");
    renderChannelPicker(elements.followedChannelPicker, state.followedChannels, selected, "No followed channels found.");
    if (elements.accountChannelNote) {
        const notes = [];
        if (state.ownedTotal > state.ownedChannels.length) {
            notes.push(`Showing the first ${state.ownedChannels.length} of ${state.ownedTotal} owned channels.`);
        }
        if (state.followedTotal > state.followedChannels.length) {
            notes.push(`Showing the first ${state.followedChannels.length} of ${state.followedTotal} followed channels.`);
        }
        elements.accountChannelNote.textContent = notes.join(" ");
    }
    updateAccountCostNote(selected);
}

const readRateLimit = () => {
    const limit = Number(state.rateLimit?.limit);
    if (!Number.isFinite(limit) || limit <= 0) {
        return null;
    }
    const windowMs = Number(state.rateLimit?.windowMs);
    return {
        limit,
        windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60 * 1000,
        tier: state.rateLimit?.tier || null
    };
};

const formatRateWindow = (windowMs) => windowMs === 60 * 1000 ? "min" : `${Math.round(windowMs / 1000)}s`;

const formatRateWait = (waitMs) => {
    const seconds = Math.ceil(waitMs / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
};

function renderRateLimitInfo() {
    if (!elements.rateLimitInfo) {
        return;
    }
    const rate = readRateLimit();
    if (!rate) {
        elements.rateLimitInfo.hidden = true;
        elements.rateLimitInfo.textContent = "";
        return;
    }
    const tier = rate.tier ? `${rate.tier} · ` : "";
    elements.rateLimitInfo.textContent = `Are.na rate limit: ${tier}${rate.limit} req/${formatRateWindow(rate.windowMs)}`;
    elements.rateLimitInfo.hidden = false;
}

// Informative only. A selection over budget still syncs, it just takes more
// than one window, and saying so beforehand beats a silent multi-minute wait.
function updateAccountCostNote(selected) {
    if (!elements.accountCostNote) {
        return;
    }

    const chosen = [...state.ownedChannels, ...state.followedChannels]
        .filter((channel, index, list) => list.findIndex(item => item.slug === channel.slug) === index)
        .filter((channel) => selected.has(channel.slug));

    if (!chosen.length) {
        elements.accountCostNote.hidden = true;
        elements.accountCostNote.textContent = "";
        return;
    }

    const cost = chosen.reduce((total, channel) => total + getChannelRequestCost(channel.contentCount), 0);
    const summary = `~${cost} request${cost === 1 ? "" : "s"} to sync ${chosen.length} selected account channel${chosen.length === 1 ? "" : "s"}`;
    const rate = readRateLimit();

    const otherSourcesNote = "Other configured sources may add requests.";
    if (!rate) {
        elements.accountCostNote.textContent = `${summary}. ${otherSourcesNote}`;
    } else {
        const budget = getRequestBudget(rate.limit);
        const tier = rate.tier ? `${rate.tier} account` : "account";
        if (cost <= budget) {
            elements.accountCostNote.textContent = `${summary}; your ${tier} allows ${rate.limit}/${formatRateWindow(rate.windowMs)}, so these account channels fit one sync window by themselves. ${otherSourcesNote}`;
        } else {
            const windows = Math.ceil(cost / budget);
            const wait = formatRateWait((windows - 1) * rate.windowMs);
            elements.accountCostNote.textContent = `${summary}; your ${tier} allows ${rate.limit}/${formatRateWindow(rate.windowMs)}, so these account channels need ${windows} sync windows (≈${wait} waiting). ${otherSourcesNote}`;
        }
    }
    elements.accountCostNote.hidden = false;
}

function renderChannelPicker(container, channels, selected, emptyLabel) {
    if (!container) {
        return;
    }
    container.innerHTML = "";
    if (!state.auth.token) {
        const empty = document.createElement("p");
        empty.className = "channel-picker-empty";
        empty.textContent = "Connect your account to load channels.";
        container.appendChild(empty);
        return;
    }
    if (!channels.length) {
        const empty = document.createElement("p");
        empty.className = "channel-picker-empty";
        empty.textContent = state.catalogLoaded ? emptyLabel : "Channels are not loaded yet.";
        container.appendChild(empty);
        return;
    }
    channels.forEach((channel) => {
        const label = document.createElement("label");
        label.className = "channel-option";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = "accountChannelSlugs";
        input.value = channel.slug;
        input.checked = selected.has(channel.slug);
        const copy = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = channel.title;
        const meta = document.createElement("small");
        const visibility = channel.visibility ? ` · ${channel.visibility}` : "";
        meta.textContent = `${channel.slug} · ${channel.contentCount} item${channel.contentCount === 1 ? "" : "s"}${visibility}`;
        copy.append(title, meta);
        label.append(input, copy);
        container.appendChild(label);
    });
}

function handleAccountChannelChange(event) {
    const input = event.target.closest("input[name='accountChannelSlugs']");
    if (!input) {
        return;
    }
    document.querySelectorAll("input[name='accountChannelSlugs']").forEach((candidate) => {
        if (candidate.value === input.value) {
            candidate.checked = input.checked;
        }
    });
    updateAccountCostNote(new Set(getSelectedAccountChannelSlugs()));
    updateDirtyState();
}

function getSelectedAccountChannelSlugs() {
    if (!state.auth.token) {
        return [];
    }
    if (!state.catalogLoaded) {
        return [...state.settings.accountChannelSlugs];
    }
    return [...new Set(Array.from(document.querySelectorAll("input[name='accountChannelSlugs']:checked"), input => input.value))];
}

function handleBarComponentChange(event) {
    barEditor.select(event.target.dataset.barSlot, event.target.value);
    updateSettingsAccessWarning();
    updateDirtyState();
}

function updateSettingsAccessWarning() {
    if (!elements.settingsAccessWarning) {
        return;
    }
    const visible = barEditor.hasVisibleSettings({
        showHeader: Boolean(elements.showHeader?.checked),
        showFooter: Boolean(elements.showFooter?.checked)
    });
    elements.settingsAccessWarning.hidden = visible;
}

function updateTheme(theme = getSelectedTheme()) {
    applyTheme(theme);
}

function updateWorking(isWorking, message) {
    state.working = isWorking;
    elements.form?.querySelectorAll("button, input, textarea, select").forEach((node) => {
        if (node.dataset.persistent === "true") {
            return;
        }
        if (isWorking) {
            node.setAttribute("data-prev-disabled", node.disabled ? "1" : "0");
            node.disabled = true;
        } else if (node.hasAttribute("data-prev-disabled")) {
            node.disabled = node.getAttribute("data-prev-disabled") === "1";
            node.removeAttribute("data-prev-disabled");
        }
    });
    if (elements.saveAllButton) {
        elements.saveAllButton.disabled = isWorking;
    }
    if (!isWorking) {
        renderAccountState();
    }
    if (message) {
        showStatus(message);
    }
}

function getCooldownRemaining() {
    if (state.cacheMeta.state !== CACHE_STATE.cooldown) {
        return 0;
    }
    return Math.max((state.cacheMeta.retryAt || 0) - Date.now(), 0);
}

function formatCacheProgress(progress) {
    const total = progress?.channelsTotal;
    if (!Number.isFinite(total) || total <= 0) {
        return null;
    }
    return `${progress.channelsDone ?? 0}/${total} channel${total === 1 ? "" : "s"}`;
}

function scheduleCacheCooldownTick() {
    const active = getCooldownRemaining() > 0;
    if (active && !cacheCooldownTimer) {
        cacheCooldownTimer = setInterval(updateCacheInfo, 1000);
    } else if (!active && cacheCooldownTimer) {
        clearInterval(cacheCooldownTimer);
        cacheCooldownTimer = null;
    }
}

function updateCacheInfo() {
    if (!elements.cacheInfo) {
        return;
    }
    const blockTotal = state.cache?.blockIds?.length || 0;
    const timestamp = state.cacheMeta.lastUpdated;
    const progress = formatCacheProgress(state.cacheMeta.progress);
    const remaining = getCooldownRemaining();
    scheduleCacheCooldownTick();

    if (state.cacheMeta.state === CACHE_STATE.working) {
        const channel = state.cacheMeta.progress?.currentChannel;
        elements.cacheInfo.textContent = progress
            ? `Refreshing ${channel ? `${channel} · ` : ""}${progress}...`
            : "Cache refresh in progress...";
    } else if (state.cacheMeta.state === CACHE_STATE.cooldown) {
        const synced = progress ? `Synced ${progress}` : "Are.na rate limit reached";
        elements.cacheInfo.textContent = remaining > 0
            ? `${synced} · resuming in ${formatCountdown(remaining)}`
            : `${synced} · resuming now`;
    } else if (state.cacheMeta.state === CACHE_STATE.error) {
        elements.cacheInfo.textContent = sanitizeErrorLabel(state.cacheMeta.lastError);
    } else if (blockTotal) {
        elements.cacheInfo.textContent = `${blockTotal} cached block${blockTotal === 1 ? "" : "s"} · updated ${formatRelativeTime(timestamp)}`;
    } else {
        elements.cacheInfo.textContent = "No cached blocks yet.";
    }
}

function showStatus(message) {
    if (elements.settingsStatus) {
        elements.settingsStatus.textContent = message;
    }
}

function handleStorageChange(changes, area) {
    if (area !== "local") {
        return;
    }
    if (changes[STORAGE_KEYS.cache]) {
        runtimeCacheLifecycle.read().then(({ cache, meta }) => {
            state.cache = cache;
            state.cacheMeta = { ...state.cacheMeta, ...meta, lastUpdated: meta.lastUpdated || cache.completedAt || state.cacheMeta.lastUpdated };
            updateCacheInfo();
        });
    } else if (changes[STORAGE_KEYS.cacheMeta]?.newValue) {
        state.cacheMeta = { ...state.cacheMeta, ...changes[STORAGE_KEYS.cacheMeta].newValue };
        updateCacheInfo();
    } else if (changes[STORAGE_KEYS.cacheMeta]) {
        runtimeCacheLifecycle.read().then(({ cache, meta }) => {
            state.cache = cache;
            state.cacheMeta = { ...state.cacheMeta, ...meta };
            updateCacheInfo();
        });
    }
    if (changes[STORAGE_KEYS.rateLimit]) {
        state.rateLimit = changes[STORAGE_KEYS.rateLimit].newValue || null;
        renderRateLimitInfo();
        updateAccountCostNote(new Set(getSelectedAccountChannelSlugs()));
    }
    if (changes[STORAGE_KEYS.bookmarkTrash]) {
        renderBookmarkTrash();
    }
    if (changes[STORAGE_KEYS.settings] && !state.working && !state.sourcesDirty && !state.displayDirty) {
        getSettings().then((settings) => {
            state.settings = settings;
            populateForm();
            updateTheme(state.settings.theme);
            updateDirtyState();
        });
    }
}

function updateBlockCountOutput() {
    if (elements.blockCountOutput && elements.blockCount) {
        elements.blockCountOutput.textContent = elements.blockCount.value;
    }
}

function updateTileSizeOutput() {
    if (!elements.tileSizeOutput || !elements.tileSize) {
        return;
    }
    const label = TILE_SIZE_OPTIONS[Number(elements.tileSize.value || 0)] || TILE_SIZE_OPTIONS[0];
    elements.tileSizeOutput.textContent = label === "auto" ? "AUTO" : label.toUpperCase();
    elements.tileSize.setAttribute("aria-valuetext", TILE_SIZE_LABEL_MAP[label] || label.toUpperCase());
}

function updateDirtyState() {
    const changes = classifySettingsChanges({ ...state.settings, ...gatherFormSettings() }, state.settings);
    state.sourcesDirty = changes.sourcesChanged;
    state.displayDirty = changes.displayChanged;
    const anyDirty = changes.changed;
    elements.sourceSaveButtons.forEach((button) => button.classList.toggle("is-dirty", state.sourcesDirty));
    elements.displaySaveButton?.classList.toggle("is-dirty", state.displayDirty);
    elements.bookmarksSaveButton?.classList.toggle("is-dirty", state.displayDirty);
    elements.saveAllButton?.classList.toggle("is-dirty", anyDirty);
    elements.unsavedIndicator?.classList.toggle("hidden", !anyDirty);
    if (anyDirty) {
        window.addEventListener("beforeunload", handleBeforeUnload);
    } else {
        window.removeEventListener("beforeunload", handleBeforeUnload);
    }
}

function handleBeforeUnload(event) {
    event.preventDefault();
    event.returnValue = "";
    return "";
}

function handleBack() {
    window.close();
}

async function handleSaveAll(event) {
    event?.preventDefault?.();
    if (state.working) {
        return;
    }
    const formValues = gatherFormSettings();
    const nextSettings = { ...state.settings, ...formValues };
    const changes = classifySettingsChanges(nextSettings, state.settings);
    if (!changes.changed) {
        showStatus("No changes to save.");
        return;
    }
    updateWorking(true, "Saving all settings...");
    try {
        state.settings = await saveSettings(nextSettings);
        updateTheme(state.settings.theme);
        updateDirtyState();
        if (changes.sourcesChanged) {
            showStatus("Settings saved. Refreshing cache...");
            const summary = await runtimeCacheLifecycle.refresh();
            showStatus(`Saved. Cache refreshed with ${summary?.blockCount || 0} block${summary?.blockCount === 1 ? "" : "s"}.`);
        } else {
            showStatus("All settings saved.");
        }
    } catch (error) {
        console.error("Save all failed", error);
        showStatus(`Save failed: ${sanitizeErrorLabel(error.message)}`);
    } finally {
        updateWorking(false);
        updateDirtyState();
    }
}

init();
