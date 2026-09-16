import { BOOKMARK_REFRESH_DEBOUNCE, STORAGE_KEYS, TRASH_TOAST_MS } from "./constants.js";
import { addListenerSafe, bookmarks, storage } from "./extension-api.js";
import { applyFavicon } from "./bookmark-favicon.js";
import { createBoard } from "./bookmarks-board.js";
import { createColumns, createNewPill } from "./bookmarks-columns.js";
import { buildBoard, buildSurfaces } from "./bookmarks-model.js";
import { openLinks } from "./bookmarks-open.js";
import { markBoardOpened, markOpened, markRead, pruneNewIds, pruneOpenedAt, seedOpenedAt, synchronizeNewMarkers, writeBookmarkState } from "./bookmarks-state.js";
import { freshCountForLink } from "./feeds.js";
import { loadFeedMap } from "./feed-poll.js";
import { getFeedState } from "./storage.js";
import { deleteNodes, restoreEntry } from "./bookmarks-trash.js";
import { createMarquee, pruneSelection, toggle } from "./bookmarks-select.js";
import { createPalette } from "./bookmarks-palette.js";
import { applyQueue, describeQueue, queueOp, reduceQueue } from "./bookmarks-manage.js";

const LAUNCH_CHIP_CLEARANCE = 16;

export function createBookmarksView({ root, blocksView, boardContainer, strip, status, settings }) {
    let currentSettings = settings;
    let model = null;
    let surfaces = { pinned: [], main: [], archive: [] };
    let mounted = false;
    let visible = false;
    let refreshTimer = null;
    let stale = false;
    let openedInThisTab = false;
    let markersSynchronized = false;
    let bookmarkState = { lastViewedAt: 0, newIds: [], openedAt: {} };
    let feedMap = {};
    let feedEntries = {};
    let selection = new Set();
    let suppressEvents = 0;
    let pendingRefresh = false;
    let ignoreEventsUntil = 0;
    let statusTimer = null;
    let statusRemaining = 0;
    let statusDeadline = 0;
    let statusActive = false;
    let lastTrashEntry = null;
    let managing = false;
    let manageQueue = [];
    let manageModel = null;
    let nextTempId = 1;
    const document = root.ownerDocument;
    const toBlocks = document.getElementById("view-blocks");
    const toBookmarks = document.getElementById("view-bookmarks");
    const launchList = document.getElementById("launch-chips");
    const newBadge = document.getElementById("bookmark-new-count");
    const selectionBar = document.getElementById("bm-selection-bar");
    const selectionCount = document.getElementById("bm-selection-count");
    const openSelectionButton = document.getElementById("bm-open-selection");
    const moveSelectionButton = document.getElementById("bm-move-selection");
    const deleteSelectionButton = document.getElementById("bm-delete-selection");
    const clearSelectionButton = document.getElementById("bm-clear-selection");
    const searchButton = document.getElementById("bm-search");
    const manageButton = document.getElementById("bm-manage");
    const addRootFolderButton = document.getElementById("bm-add-root-folder");
    const manageNote = document.getElementById("bm-manage-note");
    const manageCount = document.getElementById("bm-manage-count");
    const manageCancelButton = document.getElementById("bm-manage-cancel");
    const manageDoneButton = document.getElementById("bm-manage-done");
    const manageErrors = document.getElementById("bm-manage-errors");
    const paletteOverlay = document.getElementById("bm-palette");
    const surfaceRoot = document.getElementById("bm-surface");
    const browseLabel = document.getElementById("bm-browse-label");
    const surfaceMainButton = document.getElementById("bm-surface-main");
    const surfaceArchiveButton = document.getElementById("bm-surface-archive");
    const pinnedContainer = document.getElementById("bm-pinned");
    const mainColumnsEl = document.getElementById("bm-main-columns");
    const archiveColumnsEl = document.getElementById("bm-archive-columns");
    const mainCrumb = document.getElementById("bm-main-crumb");
    const archiveCrumb = document.getElementById("bm-archive-crumb");
    const mainColumns = mainColumnsEl
        ? createColumns({ container: mainColumnsEl, breadcrumb: mainCrumb, onOpen: handleOpen, onOpenAll: handleOpenAll })
        : null;
    const archiveColumns = archiveColumnsEl
        ? createColumns({ container: archiveColumnsEl, breadcrumb: archiveCrumb, onOpen: handleOpen, onOpenAll: handleOpenAll })
        : null;
    const board = createBoard({ container: boardContainer, onOpen: handleOpen, onOpenAll: handleOpenAll, onManageAction: handleManageAction });
    const marquee = createMarquee({
        board: boardContainer,
        getRects: board.getRects,
        getSelection: () => selection,
        onChange: setSelection
    });
    const palette = createPalette({
        overlay: paletteOverlay,
        onOpen: openPaletteLink,
        onOpenAll: openPaletteLinks,
        onPickFolder: moveSelectionTo
    });
    const bookmarkEvents = bookmarks ? [
        bookmarks.onCreated,
        bookmarks.onChanged,
        bookmarks.onMoved,
        bookmarks.onRemoved,
        bookmarks.onChildrenReordered
    ] : [];

    // "day to day" and "archive" are two reads of the same tree, so they swap in
    // place rather than stacking two boards on top of each other.
    function setSurface(name) {
        const archive = name === "archive";
        if (pinnedContainer) {
            pinnedContainer.hidden = archive;
        }
        if (mainColumnsEl) {
            mainColumnsEl.hidden = archive;
        }
        if (archiveColumnsEl) {
            archiveColumnsEl.hidden = !archive;
        }
        if (mainCrumb) {
            mainCrumb.hidden = archive;
        }
        if (archiveCrumb) {
            archiveCrumb.hidden = !archive;
        }
        if (browseLabel) {
            browseLabel.textContent = archive ? "archive" : "everything else";
        }
        surfaceMainButton?.classList.toggle("is-active", !archive);
        surfaceArchiveButton?.classList.toggle("is-active", archive);
        surfaceMainButton?.setAttribute("aria-pressed", String(!archive));
        surfaceArchiveButton?.setAttribute("aria-pressed", String(archive));
    }

    const showMainSurface = () => setSurface("main");
    const showArchiveSurface = () => setSurface("archive");

    function setActiveView(showBookmarks) {
        visible = showBookmarks;
        root.hidden = !showBookmarks;
        blocksView.hidden = showBookmarks;
        document.body.dataset.view = showBookmarks ? "bookmarks" : "blocks";
        toBlocks?.classList.toggle("is-active", !showBookmarks);
        toBookmarks?.classList.toggle("is-active", showBookmarks);
        toBlocks?.setAttribute("aria-pressed", String(!showBookmarks));
        toBookmarks?.setAttribute("aria-pressed", String(showBookmarks));
    }

    function renderLaunchChips() {
        if (!launchList) {
            return;
        }
        launchList.innerHTML = "";
        for (const link of model?.launchLinks || []) {
            const anchor = document.createElement("a");
            anchor.className = "launch-chip";
            anchor.href = link.url;
            anchor.title = link.title;
            anchor.setAttribute("aria-label", link.title);
            const favicon = document.createElement("img");
            favicon.alt = "";
            favicon.loading = "lazy";
            favicon.decoding = "async";
            applyFavicon(favicon, link.url);
            anchor.append(favicon);
            launchList.append(anchor);
        }
        requestAnimationFrame(updateStripLayout);
    }

    // The chips are absolutely centred in the bar, so they only stay centred while
    // they clear the view toggle on the left; otherwise they rejoin the flow and scroll.
    function updateStripLayout() {
        if (!launchList) {
            return;
        }
        const chipsWidth = launchList.scrollWidth;
        const available = strip.clientWidth;
        let leftEnd = 0;
        for (const child of strip.children) {
            if (child !== launchList) {
                leftEnd = Math.max(leftEnd, child.offsetLeft + child.offsetWidth);
            }
        }
        const centred = chipsWidth <= available && (available - chipsWidth) / 2 >= leftEnd + LAUNCH_CHIP_CLEARANCE;
        strip.classList.toggle("scrolling", !centred);
    }

    function clearStatus() {
        if (!status) {
            return;
        }
        status.textContent = "";
        status.hidden = true;
    }

    function clearToolbarStatus() {
        clearTimeout(statusTimer);
        statusTimer = null;
        statusActive = false;
        clearStatus();
    }

    function armStatusTimer() {
        clearTimeout(statusTimer);
        statusDeadline = Date.now() + statusRemaining;
        statusTimer = setTimeout(clearToolbarStatus, statusRemaining);
    }

    function showToolbarStatus(text, { duration = 4000, undo = false } = {}) {
        if (!status) {
            return;
        }
        clearTimeout(statusTimer);
        statusActive = true;
        statusRemaining = duration;
        status.innerHTML = "";
        status.hidden = false;
        status.append(`${text}${undo ? " · " : ""}`);
        if (undo) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "bm-inline-action";
            button.textContent = "undo";
            button.addEventListener("click", handleUndo);
            status.append(button);
        }
        armStatusTimer();
    }

    function setSelection(next) {
        selection = new Set(next || []);
        board.setSelection(selection);
        if (selectionBar) {
            selectionBar.hidden = !selection.size;
        }
        if (selectionCount) {
            selectionCount.textContent = `${selection.size} selected`;
        }
        document.body.toggleAttribute("data-selecting", Boolean(selection.size));
    }

    function clearSelection() {
        setSelection(new Set());
    }

    function pendingRemoveIds() {
        return reduceQueue(manageQueue).filter((op) => op.op === "remove").map((op) => op.id);
    }

    function updateManageNote(message = "") {
        if (manageCount) {
            manageCount.textContent = message || describeQueue(manageQueue);
        }
    }

    function renderManageModel() {
        board.render(manageModel, [], { manage: true, pendingRemoveIds: pendingRemoveIds() });
        updateManageNote();
    }

    function findManageFolder(id) {
        if (String(id) === String(manageModel.rootId)) {
            return manageModel.cards.find((card) => card.isRoot) || { id: manageModel.rootId, path: "", links: [] };
        }
        for (const card of manageModel.cards) {
            if (String(card.id) === String(id)) {
                return card;
            }
            const group = card.groups.find((candidate) => String(candidate.id) === String(id));
            if (group) {
                return group;
            }
        }
        return null;
    }

    function containingCard(folder) {
        return manageModel.cards.find((card) => card === folder || card.groups.includes(folder));
    }

    function recalculateManageCounts() {
        for (const card of manageModel.cards) {
            for (const group of card.groups) {
                group.count = group.links.length;
            }
            card.count = card.links.length + card.groups.reduce((total, group) => total + group.links.length, 0);
        }
        manageModel.folderCount = manageModel.cards.filter((card) => !card.isRoot).length + manageModel.cards.reduce((total, card) => total + card.groups.length, 0);
    }

    function createManagedFolder(parent) {
        const tempId = `temp-${nextTempId++}`;
        const title = "new folder";
        const operation = { op: "create", tempId, parentId: String(parent?.id || manageModel.rootId), title };
        manageQueue = queueOp(manageQueue, operation);
        if (!parent || String(parent.id) === String(manageModel.rootId)) {
            manageModel.cards.push({ id: tempId, title, path: title, count: 0, links: [], groups: [], isNewFolder: true });
        } else {
            const card = containingCard(parent);
            card.groups.push({ id: tempId, title, path: `${parent.path}/${title}`, count: 0, links: [], isNewFolder: true });
        }
        recalculateManageCounts();
        renderManageModel();
        requestAnimationFrame(() => boardContainer.querySelector(`[data-edit-id="${CSS.escape(tempId)}"]`)?.focus());
    }

    function handleManageAction(action) {
        if (!managing || !manageModel) {
            return;
        }
        if (action.type === "remove") {
            if (!pendingRemoveIds().includes(action.link.id)) {
                manageQueue = queueOp(manageQueue, { op: "remove", id: action.link.id });
            }
        } else if (action.type === "update-link") {
            const link = manageModel.links.find((candidate) => candidate.id === action.link.id);
            if (link) {
                link.title = action.title;
                link.url = action.url;
                manageQueue = queueOp(manageQueue, { op: "update", id: link.id, title: action.title, url: action.url });
            }
        } else if (action.type === "rename-folder") {
            const folder = findManageFolder(action.folder.id);
            if (folder) {
                folder.title = action.title;
                manageQueue = queueOp(manageQueue, { op: "update", id: folder.id, title: action.title });
            }
        } else if (action.type === "create-folder") {
            createManagedFolder(action.parent);
            return;
        } else if (action.type === "move") {
            const link = manageModel.links.find((candidate) => candidate.id === action.id);
            const destination = findManageFolder(action.parentId);
            if (link && destination) {
                for (const card of manageModel.cards) {
                    card.links = card.links.filter((candidate) => candidate.id !== link.id);
                    for (const group of card.groups) {
                        group.links = group.links.filter((candidate) => candidate.id !== link.id);
                    }
                }
                destination.links.splice(action.index, 0, link);
                link.parentId = String(destination.id);
                link.path = action.path || destination.path || "";
                destination.links.forEach((candidate, index) => { candidate.index = index; });
                manageQueue = queueOp(manageQueue, { op: "move", id: link.id, parentId: String(destination.id), index: action.index });
                recalculateManageCounts();
            }
        }
        renderManageModel();
    }

    function setManageUi(active) {
        managing = active;
        document.body.dataset.manage = active ? "true" : "false";
        manageNote.hidden = !active;
        addRootFolderButton.hidden = !active;
        manageButton.disabled = active;
        searchButton.disabled = active;
        marquee.setEnabled(!active);
    }

    function handleAddRootFolder() {
        createManagedFolder(null);
    }

    async function enterManage() {
        await show();
        palette.close();
        clearSelection();
        manageQueue = [];
        manageModel = structuredClone(model);
        if (manageErrors) {
            manageErrors.hidden = true;
            manageErrors.textContent = "";
        }
        setManageUi(true);
        setLayout(true);
        renderManageModel();
    }

    async function cancelManage() {
        manageQueue = [];
        manageModel = null;
        setManageUi(false);
        setLayout(false);
        if (stale) {
            await refresh();
        } else {
            renderModel();
        }
    }

    async function finishManage() {
        const operations = reduceQueue(manageQueue);
        if (!operations.length) {
            await cancelManage();
            return;
        }
        suppressEvents += 1;
        manageDoneButton.disabled = true;
        manageCancelButton.disabled = true;
        let result;
        try {
            result = await applyQueue(manageQueue, bookmarks, (done, total) => updateManageNote(`applying ${done}/${total}`));
        } finally {
            suppressEvents -= 1;
            manageDoneButton.disabled = false;
            manageCancelButton.disabled = false;
        }
        if (result.failed) {
            updateManageNote(`applied ${result.applied} of ${result.total} · ${result.failed} failed`);
            manageErrors.hidden = false;
            manageErrors.textContent = result.errors.map((error) => error.message).join(" · ");
            return;
        }
        lastTrashEntry = result.trashEntry;
        const applied = result.applied;
        manageQueue = [];
        manageModel = null;
        setManageUi(false);
        pendingRefresh = false;
        ignoreEventsUntil = Date.now() + BOOKMARK_REFRESH_DEBOUNCE;
        await refresh();
        showToolbarStatus(`applied ${applied} of ${result.total}`, { duration: result.trashEntry ? TRASH_TOAST_MS : 4000, undo: Boolean(result.trashEntry) });
    }

    async function runBatch(task) {
        suppressEvents += 1;
        try {
            return await task();
        } finally {
            suppressEvents -= 1;
            if (!suppressEvents) {
                pendingRefresh = false;
                ignoreEventsUntil = Date.now() + BOOKMARK_REFRESH_DEBOUNCE;
                await refresh();
            }
        }
    }

    function folderChoices({ includeRoot = false } = {}) {
        if (!model) {
            return [];
        }
        const choices = includeRoot ? [{ id: model.rootId, path: "", title: model.rootTitle || "bar", count: model.linkCount, linkIds: model.links.map((link) => link.id) }] : [];
        for (const card of model.cards) {
            const cardLinks = card.links.concat(card.groups.flatMap((group) => group.links));
            if (!card.isRoot) {
                choices.push({ id: card.id, path: card.path, title: card.path, count: card.count, linkIds: cardLinks.map((link) => link.id) });
            }
            for (const group of card.groups) {
                choices.push({ id: group.id, path: group.path, title: group.path, count: group.count, linkIds: group.links.map((link) => link.id) });
            }
        }
        return choices;
    }

    async function openSearchPalette() {
        await show();
        palette.open({ links: model.links, folders: folderChoices(), newIds: bookmarkState.newIds });
    }

    function openMovePalette() {
        if (!selection.size) {
            return;
        }
        palette.open({ links: model.links, folders: folderChoices({ includeRoot: true }), newIds: bookmarkState.newIds, mode: "folder" });
    }

    async function openPaletteLink(link) {
        const result = await openLinks([link.url]);
        if (!result.cancelled) {
            await markLinksRead(link.id);
            palette.update({ newIds: bookmarkState.newIds });
        }
    }

    async function openPaletteLinks(links) {
        const result = await openLinks(links.map((link) => link.url));
        if (!result.cancelled) {
            await markLinksRead(links.map((link) => link.id));
            palette.update({ newIds: bookmarkState.newIds });
        }
    }

    async function moveSelectionTo(folder) {
        const ids = [...selection];
        await runBatch(async () => {
            for (const id of ids) {
                await bookmarks.move(id, { parentId: String(folder.id) });
            }
        });
        clearSelection();
        showToolbarStatus(`${ids.length} moved to ${folder.path || model.rootTitle || "bar"}`);
    }

    async function openSelected() {
        const chosen = model.links.filter((link) => selection.has(link.id));
        const result = await openLinks(chosen.map((link) => link.url));
        if (!result.cancelled) {
            await markLinksRead(chosen.map((link) => link.id));
        }
    }

    async function deleteSelected() {
        const ids = [...selection];
        if (!ids.length) {
            return;
        }
        lastTrashEntry = await runBatch(() => deleteNodes(ids, bookmarks, { label: `${ids.length} bookmarks` }));
        clearSelection();
        showToolbarStatus(`${ids.length} deleted`, { duration: TRASH_TOAST_MS, undo: Boolean(lastTrashEntry) });
    }

    async function handleUndo() {
        if (!lastTrashEntry) {
            return;
        }
        const entry = lastTrashEntry;
        lastTrashEntry = null;
        const result = await runBatch(() => restoreEntry(entry, bookmarks, { rootId: model.rootId }));
        const orphanNote = result.orphaned ? ` · ${result.orphaned} to the bar, folder gone` : "";
        showToolbarStatus(`${result.created.length} restored${orphanNote}`);
    }

    function updateNewBadge() {
        if (!newBadge) {
            return;
        }
        newBadge.textContent = bookmarkState.newIds.length ? String(bookmarkState.newIds.length) : "";
        newBadge.hidden = !bookmarkState.newIds.length;
    }

    // Unread posts, not unread bookmarks: the pill counts feed entries published
    // since you last opened that link, so a site you never visit keeps climbing.
    function freshFor(link) {
        return freshCountForLink(feedMap, feedEntries, link, bookmarkState.openedAt?.[link.url] || 0);
    }

    async function markLinksRead(ids) {
        const targets = (Array.isArray(ids) ? ids : [ids]).map(String).filter((id) => bookmarkState.newIds.includes(id));
        if (!targets.length) {
            return;
        }
        bookmarkState = { ...bookmarkState, newIds: bookmarkState.newIds.filter((id) => !targets.includes(id)) };
        board.markRead(targets);
        updateNewBadge();
        await markRead(targets);
    }

    async function handleOpen(event, link) {
        event.preventDefault();
        if (event.shiftKey) {
            setSelection(toggle(selection, link.id));
            return;
        }
        if (selection.size) {
            return;
        }
        const result = await openLinks([link.url]);
        if (!result.cancelled) {
            await markLinksRead(link.id);
            await markLinksOpened([link.url]);
        }
    }

    async function handleOpenAll(links) {
        const urls = links.map((link) => link.url);
        const result = await openLinks(urls);
        if (!result.cancelled) {
            await markLinksRead(links.map((link) => link.id));
            await markLinksOpened(urls);
        }
    }

    async function markLinksOpened(urls) {
        bookmarkState = await markOpened(urls);
        renderModel();
    }

    function setLayout(manageLayout) {
        if (surfaceRoot) {
            surfaceRoot.hidden = manageLayout;
        }
        boardContainer.hidden = !manageLayout;
    }

    function renderPinned() {
        if (!pinnedContainer) {
            return;
        }
        pinnedContainer.innerHTML = "";
        for (const node of surfaces.pinned) {
            const heading = document.createElement("h2");
            heading.className = "bm-section-title";
            heading.textContent = node.path.split("/").join(" — ");
            const block = document.createElement("div");
            block.className = "bm-pinned-block";
            // Subfolders are the grouping: a pinned folder split into "communities",
            // "startups" and so on reads as labelled columns instead of one long list.
            if (node.children.length) {
                block.classList.add("is-grouped");
                for (const group of node.children) {
                    block.append(createPinnedGroup(group.title, group.links));
                }
            } else {
                block.append(createPinnedRows(node.links));
            }
            pinnedContainer.append(heading, block);
        }
    }

    function createPinnedRows(links) {
        const rows = document.createElement("div");
        rows.className = "bm-pinned-rows";
        for (const link of links) {
            rows.append(createPinnedRow(link));
        }
        return rows;
    }

    function createPinnedGroup(title, links) {
        const group = document.createElement("div");
        group.className = "bm-pinned-group";
        const label = document.createElement("div");
        label.className = "bm-group-label";
        label.textContent = title;
        group.append(label, createPinnedRows(links));
        return group;
    }

    function createPinnedRow(link) {
        const row = document.createElement("a");
        row.className = "bm-row bm-pinned-row";
        row.href = link.url;
        row.target = "_blank";
        row.rel = "noopener";
        row.title = link.title;
        row.dataset.bookmarkId = link.id;
        const fresh = freshFor(link);
        row.classList.toggle("bm-new-row", Boolean(fresh));
        const favicon = document.createElement("img");
        favicon.className = "bm-favicon";
        favicon.alt = "";
        favicon.loading = "lazy";
        favicon.decoding = "async";
        applyFavicon(favicon, link.url);
        const title = document.createElement("span");
        title.className = "bm-row-title";
        title.textContent = link.title;
        row.append(favicon, title);
        if (fresh) {
            row.append(createNewPill(document, `${fresh}`));
        }
        row.addEventListener("click", (event) => handleOpen(event, link, row));
        row.addEventListener("auxclick", (event) => {
            if (event.button === 1) {
                handleOpen(event, link, row);
            }
        });
        return row;
    }

    function renderModel() {
        const startedAt = performance.now();
        if (managing && manageModel) {
            board.render(manageModel, [], { manage: true, pendingRemoveIds: pendingRemoveIds() });
        } else {
            renderPinned();
            mainColumns?.setNodes(surfaces.main, { freshFor });
            archiveColumns?.setNodes(surfaces.archive, { freshFor });
        }
        root.dataset.renderMs = (performance.now() - startedAt).toFixed(2);
        renderLaunchChips();
        updateNewBadge();
        palette.update({ links: model.links, folders: folderChoices(), newIds: bookmarkState.newIds });
    }

    async function refresh() {
        if (!bookmarks) {
            // the flat board is hidden outside manage mode, so the notice goes on the visible card
            const host = pinnedContainer || boardContainer;
            host.innerHTML = "";
            const empty = document.createElement("div");
            empty.className = "bm-empty";
            empty.textContent = "Bookmarks unavailable";
            host.append(empty);
            return;
        }
        const tree = await bookmarks.getTree();
        model = buildBoard(tree, {
            rootPath: currentSettings.bookmarksRootPath,
            hiddenFolders: currentSettings.hiddenFolders,
            launchFolder: currentSettings.launchFolder
        });
        surfaces = buildSurfaces(tree, {
            rootPath: currentSettings.bookmarksRootPath,
            hiddenFolders: currentSettings.hiddenFolders,
            pinnedFolders: currentSettings.pinnedFolders,
            mainFolders: currentSettings.mainFolders
        });
        stale = false;
        selection = pruneSelection(selection, model.links.map((link) => link.id));
        if (markersSynchronized) {
            const pruned = pruneNewIds(bookmarkState.newIds, model.links);
            const openedAt = seedOpenedAt(pruneOpenedAt(bookmarkState.openedAt, model.links), model.links);
            const openedChanged = Object.keys(openedAt).length !== Object.keys(bookmarkState.openedAt || {}).length;
            if (pruned.length !== bookmarkState.newIds.length || openedChanged) {
                bookmarkState = await writeBookmarkState({ ...bookmarkState, newIds: pruned, openedAt });
            }
        }
        renderModel();
        setSelection(selection);
    }

    function scheduleRefresh() {
        stale = true;
        if (suppressEvents || managing) {
            pendingRefresh = true;
            return;
        }
        if (Date.now() < ignoreEventsUntil) {
            return;
        }
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => refresh().catch((error) => console.error("Failed to refresh bookmarks", error)), BOOKMARK_REFRESH_DEBOUNCE);
    }

    function handleStorageChange(changes, area) {
        if (area !== "local") {
            return;
        }
        if (changes[STORAGE_KEYS.feedState]?.newValue) {
            feedEntries = changes[STORAGE_KEYS.feedState].newValue.entries || {};
            if (model) {
                renderModel();
            }
        }
        if (!changes[STORAGE_KEYS.bookmarkState]?.newValue) {
            return;
        }
        const next = changes[STORAGE_KEYS.bookmarkState].newValue;
        const nextIds = pruneNewIds(next.newIds, model?.links || []);
        const unchanged = nextIds.length === bookmarkState.newIds.length && nextIds.every((id, index) => id === bookmarkState.newIds[index]);
        bookmarkState = {
            lastViewedAt: Number(next.lastViewedAt || 0),
            newIds: nextIds,
            openedAt: next.openedAt || {}
        };
        if (!unchanged && model) {
            renderModel();
        } else {
            updateNewBadge();
        }
    }

    function handleKeyDown(event) {
        if (event.defaultPrevented) {
            return;
        }
        if (event.key === "Escape") {
            if (managing) {
                const count = reduceQueue(manageQueue).length;
                if (!count || window.confirm(`Discard ${count} changes?`)) {
                    cancelManage();
                }
            } else if (selection.size) {
                clearSelection();
            }
            return;
        }
        const typing = event.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "");
        if (event.key === "/" && !managing && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            openSearchPalette();
            return;
        }
        if (event.key.toLowerCase() !== "b" || typing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !bookmarks) {
            return;
        }
        event.preventDefault();
        visible ? hide() : show();
    }

    async function mount(nextSettings = currentSettings) {
        currentSettings = nextSettings;
        if (mounted) {
            return;
        }
        mounted = true;
        setActiveView(false);
        if (!bookmarks) {
            strip.hidden = true;
            await refresh();
            return;
        }
        strip.hidden = false;
        toBlocks?.addEventListener("click", hide);
        toBookmarks?.addEventListener("click", show);
        openSelectionButton?.addEventListener("click", openSelected);
        moveSelectionButton?.addEventListener("click", openMovePalette);
        deleteSelectionButton?.addEventListener("click", deleteSelected);
        clearSelectionButton?.addEventListener("click", clearSelection);
        searchButton?.addEventListener("click", openSearchPalette);
        manageButton?.addEventListener("click", enterManage);
        addRootFolderButton?.addEventListener("click", handleAddRootFolder);
        manageCancelButton?.addEventListener("click", cancelManage);
        manageDoneButton?.addEventListener("click", finishManage);
        surfaceMainButton?.addEventListener("click", showMainSurface);
        surfaceArchiveButton?.addEventListener("click", showArchiveSurface);
        status?.addEventListener("pointerenter", pauseStatusTimer);
        status?.addEventListener("pointerleave", resumeStatusTimer);
        document.addEventListener("keydown", handleKeyDown);
        document.defaultView?.addEventListener("resize", updateStripLayout);
        for (const event of bookmarkEvents) {
            addListenerSafe(event, scheduleRefresh);
        }
        storage.onChanged?.addListener(handleStorageChange);
        setLayout(false);
        [feedMap, { entries: feedEntries }] = await Promise.all([loadFeedMap(), getFeedState()]);
        await refresh();
        bookmarkState = await synchronizeNewMarkers(model.links);
        markersSynchronized = true;
        renderModel();
    }

    async function show() {
        if (!bookmarks) {
            return;
        }
        if (!model || stale) {
            await refresh();
        }
        setActiveView(true);
        if (!openedInThisTab) {
            openedInThisTab = true;
            bookmarkState = await markBoardOpened(Date.now());
            updateNewBadge();
        }
    }

    function hide() {
        setActiveView(false);
    }

    async function updateSettings(nextSettings) {
        currentSettings = nextSettings;
        await refresh();
    }

    function pauseStatusTimer() {
        if (statusActive) {
            statusRemaining = Math.max(0, statusDeadline - Date.now());
            clearTimeout(statusTimer);
        }
    }

    function resumeStatusTimer() {
        if (statusActive) {
            armStatusTimer();
        }
    }

    function destroy() {
        clearTimeout(refreshTimer);
        clearTimeout(statusTimer);
        document.removeEventListener("keydown", handleKeyDown);
        toBlocks?.removeEventListener("click", hide);
        toBookmarks?.removeEventListener("click", show);
        openSelectionButton?.removeEventListener("click", openSelected);
        moveSelectionButton?.removeEventListener("click", openMovePalette);
        deleteSelectionButton?.removeEventListener("click", deleteSelected);
        clearSelectionButton?.removeEventListener("click", clearSelection);
        searchButton?.removeEventListener("click", openSearchPalette);
        manageButton?.removeEventListener("click", enterManage);
        addRootFolderButton?.removeEventListener("click", handleAddRootFolder);
        manageCancelButton?.removeEventListener("click", cancelManage);
        manageDoneButton?.removeEventListener("click", finishManage);
        surfaceMainButton?.removeEventListener("click", showMainSurface);
        surfaceArchiveButton?.removeEventListener("click", showArchiveSurface);
        status?.removeEventListener("pointerenter", pauseStatusTimer);
        status?.removeEventListener("pointerleave", resumeStatusTimer);
        for (const event of bookmarkEvents) {
            event?.removeListener?.(scheduleRefresh);
        }
        storage.onChanged?.removeListener?.(handleStorageChange);
        marquee.destroy();
        palette.destroy();
        board.destroy();
        mounted = false;
    }

    return {
        mount,
        show,
        hide,
        isVisible: () => visible,
        getNewCount: () => bookmarkState.newIds.length,
        updateSettings,
        refresh,
        destroy,
        getModel: () => model
    };
}
