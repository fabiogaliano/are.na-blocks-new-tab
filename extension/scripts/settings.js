import { BLOCK_TYPES, CACHE_STATE, DEFAULT_SETTINGS, MESSAGES, STORAGE_KEYS, TILE_SIZE_OPTIONS } from "./constants.js";
import { runtime, storage } from "./extension-api.js";
import {
    clearArenaAuth,
    clearCache,
    getArenaAuth,
    getCache,
    getSettings,
    parseBlockIds,
    parseChannelSlugs,
    saveArenaAuth,
    saveSettings
} from "./storage.js";
import { connectArenaAccount, loadArenaAccountCatalog } from "./arena-account.js";
import { hasVisibleSettingsButton, normalizeBarLayout, normalizeBlockMetaFields } from "./customization.js";
import { applyTheme } from "./theme.js";
import { formatRelativeTime } from "./time.js";
import { refreshCache } from "./cache-refresh.js";

const EMPTY_AUTH = { token: "", user: null };

const state = {
    settings: cloneSettings(DEFAULT_SETTINGS),
    auth: { ...EMPTY_AUTH },
    cache: null,
    cacheMeta: {
        state: CACHE_STATE.idle,
        lastUpdated: 0,
        lastError: null
    },
    ownedChannels: [],
    followedChannels: [],
    ownedTotal: 0,
    followedTotal: 0,
    catalogLoaded: false,
    working: false,
    sourcesDirty: false,
    displayDirty: false
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
    accountChannelNote: document.getElementById("account-channel-note")
};

const TILE_SIZE_LABEL_MAP = {
    auto: "Auto",
    xs: "Extra small",
    s: "Small",
    m: "Medium",
    l: "Large",
    xl: "Extra large"
};

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
        populateForm();
        updateTheme(getSelectedTheme());
        updateCacheInfo();
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
    const [settings, auth, cacheState] = await Promise.all([getSettings(), getArenaAuth(), getCache()]);
    state.settings = settings;
    state.auth = auth;
    state.cache = cacheState.cache;
    state.cacheMeta = {
        ...state.cacheMeta,
        ...cacheState.meta,
        lastUpdated: cacheState.meta.lastUpdated || cacheState.cache.fetchedAt || 0
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
    const barLayout = normalizeBarLayout(settings.barLayout);
    elements.barComponentSelects.forEach((select) => {
        const [barName, slotName] = select.dataset.barSlot.split(".");
        select.value = barLayout[barName][slotName];
    });
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
    updateBarFormatVisibility();
    updateSettingsAccessWarning();

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

    [elements.channelSlugs, elements.blockIds, elements.showHeader, elements.showFooter, elements.includeFeed].forEach((control) => {
        control?.addEventListener("input", updateDirtyState);
        control?.addEventListener("change", updateDirtyState);
    });
    elements.filters.forEach((checkbox) => checkbox.addEventListener("change", updateDirtyState));
    elements.ownedChannelPicker?.addEventListener("change", handleAccountChannelChange);
    elements.followedChannelPicker?.addEventListener("change", handleAccountChannelChange);

    runtime?.onMessage?.addListener(handleRuntimeMessage);
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
        channelSlugs: parseChannelSlugs(elements.channelSlugs?.value || ""),
        blockIds: parseBlockIds(elements.blockIds?.value || ""),
        filters: filters.length ? filters : [...BLOCK_TYPES],
        includeFeed: Boolean(state.auth.token && elements.includeFeed?.checked),
        accountChannelSlugs: getSelectedAccountChannelSlugs()
    };
}

function gatherDisplaySettings() {
    const blockCount = Math.min(6, Math.max(1, Number(elements.blockCount?.value || DEFAULT_SETTINGS.blockCount)));
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
        blockMetaFields: normalizeBlockMetaFields(blockMetaFields)
    };
}

function gatherBarLayout() {
    const draft = {
        top: {
            left: "none",
            right: "none"
        },
        bottom: {
            left: "none",
            right: "none"
        }
    };
    elements.barComponentSelects.forEach((select) => {
        const [barName, slotName] = select.dataset.barSlot.split(".");
        draft[barName][slotName] = select.value;
    });
    return normalizeBarLayout(draft);
}

const gatherFormSettings = () => ({
    ...gatherSourceSettings(),
    ...gatherDisplaySettings()
});

async function handleDisplaySave(event) {
    event.preventDefault();
    if (state.working) {
        return;
    }
    const nextSettings = { ...state.settings, ...gatherDisplaySettings() };
    if (settingsEqual(nextSettings, state.settings)) {
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
    populateForm(cloneSettings(DEFAULT_SETTINGS));
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
    const settingsChanged = !settingsEqual(nextSettings, state.settings);
    updateWorking(true, settingsChanged ? "Saving sources..." : "Refreshing cache...");
    try {
        if (settingsChanged) {
            state.settings = await saveSettings(nextSettings);
            updateDirtyState();
        }
        const summary = await refreshCache();
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
        const { cache, meta } = await getCache();
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
        await refreshCache();
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
    const selected = event.target.value;
    if (selected !== "none") {
        elements.barComponentSelects.forEach((select) => {
            if (select !== event.target && select.value === selected) {
                select.value = "none";
            }
        });
    }
    updateBarFormatVisibility();
    updateSettingsAccessWarning();
    updateDirtyState();
}

function updateBarFormatVisibility() {
    const components = new Set(Array.from(elements.barComponentSelects, select => select.value));
    const showDate = components.has("date") || components.has("dateTime");
    const showTime = components.has("time") || components.has("dateTime");
    if (elements.dateFormatField) {
        elements.dateFormatField.hidden = !showDate;
    }
    if (elements.timeFormatField) {
        elements.timeFormatField.hidden = !showTime;
    }
    if (elements.barFormatOptions) {
        elements.barFormatOptions.hidden = !showDate && !showTime;
    }
}

function updateSettingsAccessWarning() {
    if (!elements.settingsAccessWarning) {
        return;
    }
    const visible = hasVisibleSettingsButton({
        barLayout: gatherBarLayout(),
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

function updateCacheInfo() {
    if (!elements.cacheInfo) {
        return;
    }
    const blockTotal = state.cache?.blockIds?.length || 0;
    const timestamp = state.cacheMeta.lastUpdated;
    if (state.cacheMeta.state === CACHE_STATE.working) {
        elements.cacheInfo.textContent = "Cache refresh in progress...";
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

function handleRuntimeMessage(message) {
    if (message?.type === MESSAGES.cacheStatus) {
        state.cacheMeta = { ...state.cacheMeta, ...message.payload };
        updateCacheInfo();
    }
    return false;
}

function handleStorageChange(changes, area) {
    if (area !== "local") {
        return;
    }
    if (changes[STORAGE_KEYS.cache] || changes[STORAGE_KEYS.cacheMeta]) {
        getCache().then(({ cache, meta }) => {
            state.cache = cache;
            state.cacheMeta = { ...state.cacheMeta, ...meta, lastUpdated: meta.lastUpdated || cache.fetchedAt || state.cacheMeta.lastUpdated };
            updateCacheInfo();
        });
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

function settingsEqual(next, current) {
    if (!current) {
        return false;
    }
    return (
        arraysEqual(next.channelSlugs, current.channelSlugs) &&
        arraysEqual(next.blockIds, current.blockIds) &&
        arraysEqual(next.filters, current.filters) &&
        arraysEqual(next.accountChannelSlugs, current.accountChannelSlugs) &&
        arraysEqual(next.blockMetaFields, current.blockMetaFields) &&
        barLayoutsEqual(next.barLayout, current.barLayout) &&
        next.includeFeed === current.includeFeed &&
        next.blockCount === current.blockCount &&
        next.showHeader === current.showHeader &&
        next.showFooter === current.showFooter &&
        next.theme === current.theme &&
        next.tileSize === current.tileSize &&
        next.dateFormat === current.dateFormat &&
        next.timeFormat === current.timeFormat
    );
}

function arraysEqual(a = [], b = []) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function barLayoutsEqual(a, b) {
    const left = normalizeBarLayout(a);
    const right = normalizeBarLayout(b);
    return ["top", "bottom"].every((barName) => (
        left[barName].left === right[barName].left &&
        left[barName].right === right[barName].right
    ));
}

function sourcesAreDirty() {
    const values = gatherSourceSettings();
    return (
        !arraysEqual(values.channelSlugs, state.settings.channelSlugs) ||
        !arraysEqual(values.blockIds, state.settings.blockIds) ||
        !arraysEqual(values.filters, state.settings.filters) ||
        !arraysEqual(values.accountChannelSlugs, state.settings.accountChannelSlugs) ||
        values.includeFeed !== state.settings.includeFeed
    );
}

function displayIsDirty() {
    const values = gatherDisplaySettings();
    return (
        values.blockCount !== state.settings.blockCount ||
        values.showHeader !== state.settings.showHeader ||
        values.showFooter !== state.settings.showFooter ||
        values.tileSize !== state.settings.tileSize ||
        values.theme !== state.settings.theme ||
        values.dateFormat !== state.settings.dateFormat ||
        values.timeFormat !== state.settings.timeFormat ||
        !barLayoutsEqual(values.barLayout, state.settings.barLayout) ||
        !arraysEqual(values.blockMetaFields, state.settings.blockMetaFields)
    );
}

function updateDirtyState() {
    state.sourcesDirty = sourcesAreDirty();
    state.displayDirty = displayIsDirty();
    const anyDirty = state.sourcesDirty || state.displayDirty;
    elements.sourceSaveButtons.forEach((button) => button.classList.toggle("is-dirty", state.sourcesDirty));
    elements.displaySaveButton?.classList.toggle("is-dirty", state.displayDirty);
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
    const settingsChanged = !settingsEqual(nextSettings, state.settings);
    const sourcesChanged = sourcesAreDirty();
    if (!settingsChanged) {
        showStatus("No changes to save.");
        return;
    }
    updateWorking(true, "Saving all settings...");
    try {
        state.settings = await saveSettings(nextSettings);
        updateTheme(state.settings.theme);
        updateDirtyState();
        if (sourcesChanged) {
            showStatus("Settings saved. Refreshing cache...");
            const summary = await refreshCache();
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

function cloneSettings(settings) {
    return {
        ...settings,
        channelSlugs: [...(settings.channelSlugs || [])],
        blockIds: [...(settings.blockIds || [])],
        filters: [...(settings.filters || [])],
        accountChannelSlugs: [...(settings.accountChannelSlugs || [])],
        barLayout: normalizeBarLayout(settings.barLayout),
        blockMetaFields: [...(settings.blockMetaFields || [])]
    };
}

init();
