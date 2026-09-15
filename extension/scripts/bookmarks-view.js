import { BOOKMARK_REFRESH_DEBOUNCE, STORAGE_KEYS, TRASH_TOAST_MS } from "./constants.js";
import { addListenerSafe, bookmarks, storage } from "./extension-api.js";
import { applyFavicon } from "./bookmark-favicon.js";
import { createBoard } from "./bookmarks-board.js";
import { buildBoard } from "./bookmarks-model.js";
import { openLinks } from "./bookmarks-open.js";
import { markBoardOpened, markRead, pruneNewIds, synchronizeNewMarkers, writeBookmarkState } from "./bookmarks-state.js";
import { deleteNodes, restoreEntry } from "./bookmarks-trash.js";
import { createMarquee, pruneSelection, toggle } from "./bookmarks-select.js";
import { createPalette } from "./bookmarks-palette.js";
import { applyQueue, describeQueue, queueOp, reduceQueue } from "./bookmarks-manage.js";

export function createBookmarksView({ root, blocksView, boardContainer, strip, summary, settings }) {
    let currentSettings = settings;
    let model = null;
    let mounted = false;
    let visible = false;
    let refreshTimer = null;
    let stale = false;
    let openedInThisTab = false;
    let markersSynchronized = false;
    let bookmarkState = { lastViewedAt: 0, newIds: [] };
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
    const backToBlocks = document.getElementById("bm-back-blocks");
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
        requestAnimationFrame(() => {
            strip.classList.toggle("scrolling", strip.scrollWidth > strip.clientWidth);
        });
    }

    function renderSummary() {
        if (!summary || !model) {
            return;
        }
        summary.textContent = `${model.linkCount} link${model.linkCount === 1 ? "" : "s"} · ${model.folderCount || 0} folder${model.folderCount === 1 ? "" : "s"}`;
    }

    function clearToolbarStatus() {
        clearTimeout(statusTimer);
        statusTimer = null;
        statusActive = false;
        renderSummary();
    }

    function armStatusTimer() {
        clearTimeout(statusTimer);
        statusDeadline = Date.now() + statusRemaining;
        statusTimer = setTimeout(clearToolbarStatus, statusRemaining);
    }

    function showToolbarStatus(text, { duration = 4000, undo = false } = {}) {
        if (!summary) {
            return;
        }
        clearTimeout(statusTimer);
        statusActive = true;
        statusRemaining = duration;
        summary.innerHTML = "";
        summary.append(`${text}${undo ? " · " : ""}`);
        if (undo) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "bm-inline-action";
            button.textContent = "undo";
            button.addEventListener("click", handleUndo);
            summary.append(button);
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
        renderManageModel();
    }

    async function cancelManage() {
        manageQueue = [];
        manageModel = null;
        setManageUi(false);
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
        }
    }

    async function handleOpenAll(links) {
        const result = await openLinks(links.map((link) => link.url));
        if (!result.cancelled) {
            await markLinksRead(links.map((link) => link.id));
        }
    }

    function renderModel() {
        const startedAt = performance.now();
        if (managing && manageModel) {
            board.render(manageModel, [], { manage: true, pendingRemoveIds: pendingRemoveIds() });
        } else {
            board.render(model, bookmarkState.newIds);
        }
        root.dataset.renderMs = (performance.now() - startedAt).toFixed(2);
        if (summary && !statusActive) {
            renderSummary();
        }
        renderLaunchChips();
        updateNewBadge();
        palette.update({ links: model.links, folders: folderChoices(), newIds: bookmarkState.newIds });
    }

    async function refresh() {
        if (!bookmarks) {
            boardContainer.innerHTML = "";
            const empty = document.createElement("div");
            empty.className = "bm-empty";
            empty.textContent = "Bookmarks unavailable";
            boardContainer.append(empty);
            return;
        }
        const tree = await bookmarks.getTree();
        model = buildBoard(tree, {
            rootPath: currentSettings.bookmarksRootPath,
            hiddenFolders: currentSettings.hiddenFolders,
            launchFolder: currentSettings.launchFolder
        });
        stale = false;
        selection = pruneSelection(selection, model.links.map((link) => link.id));
        if (markersSynchronized) {
            const pruned = pruneNewIds(bookmarkState.newIds, model.links);
            if (pruned.length !== bookmarkState.newIds.length) {
                bookmarkState = await writeBookmarkState({ ...bookmarkState, newIds: pruned });
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
        if (area !== "local" || !changes[STORAGE_KEYS.bookmarkState]?.newValue) {
            return;
        }
        const next = changes[STORAGE_KEYS.bookmarkState].newValue;
        const nextIds = pruneNewIds(next.newIds, model?.links || []);
        const unchanged = nextIds.length === bookmarkState.newIds.length && nextIds.every((id, index) => id === bookmarkState.newIds[index]);
        bookmarkState = { lastViewedAt: Number(next.lastViewedAt || 0), newIds: nextIds };
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
        backToBlocks?.addEventListener("click", hide);
        openSelectionButton?.addEventListener("click", openSelected);
        moveSelectionButton?.addEventListener("click", openMovePalette);
        deleteSelectionButton?.addEventListener("click", deleteSelected);
        clearSelectionButton?.addEventListener("click", clearSelection);
        searchButton?.addEventListener("click", openSearchPalette);
        manageButton?.addEventListener("click", enterManage);
        addRootFolderButton?.addEventListener("click", handleAddRootFolder);
        manageCancelButton?.addEventListener("click", cancelManage);
        manageDoneButton?.addEventListener("click", finishManage);
        summary?.addEventListener("pointerenter", pauseStatusTimer);
        summary?.addEventListener("pointerleave", resumeStatusTimer);
        document.addEventListener("keydown", handleKeyDown);
        for (const event of bookmarkEvents) {
            addListenerSafe(event, scheduleRefresh);
        }
        storage.onChanged?.addListener(handleStorageChange);
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
        backToBlocks?.removeEventListener("click", hide);
        openSelectionButton?.removeEventListener("click", openSelected);
        moveSelectionButton?.removeEventListener("click", openMovePalette);
        deleteSelectionButton?.removeEventListener("click", deleteSelected);
        clearSelectionButton?.removeEventListener("click", clearSelection);
        searchButton?.removeEventListener("click", openSearchPalette);
        manageButton?.removeEventListener("click", enterManage);
        addRootFolderButton?.removeEventListener("click", handleAddRootFolder);
        manageCancelButton?.removeEventListener("click", cancelManage);
        manageDoneButton?.removeEventListener("click", finishManage);
        summary?.removeEventListener("pointerenter", pauseStatusTimer);
        summary?.removeEventListener("pointerleave", resumeStatusTimer);
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
