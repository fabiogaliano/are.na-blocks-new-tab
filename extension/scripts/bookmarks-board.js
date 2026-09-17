import { applyFavicon } from "./bookmark-favicon.js";
import { createLinkDrag } from "./bookmarks-drag.js";
import { beginLinkEdit, createButton, makeTitleEditable } from "./bookmarks-edit.js";

function createRow(link, onOpen, { manage = false, pendingRemove = false, onManageAction } = {}) {
    const row = document.createElement("a");
    row.className = "bm-row";
    row.href = link.url;
    row.target = "_blank";
    row.rel = "noopener";
    row.title = link.title;
    row.dataset.bookmarkId = link.id;
    row.dataset.parentId = link.parentId;
    row.draggable = manage;
    row.classList.toggle("is-pending-remove", pendingRemove);

    const favicon = document.createElement("img");
    favicon.className = "bm-favicon";
    favicon.alt = "";
    favicon.loading = "lazy";
    favicon.decoding = "async";
    applyFavicon(favicon, link.url);

    const title = document.createElement("span");
    title.className = "bm-row-title";
    title.textContent = link.title;
    if (manage) {
        const grip = document.createElement("span");
        grip.className = "bm-grip";
        grip.textContent = "⋮⋮";
        row.append(grip);
    }
    row.append(favicon, title);
    if (manage) {
        const remove = createButton("✕", "bm-row-remove");
        remove.title = "delete";
        remove.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onManageAction?.({ type: "remove", link });
        });
        row.append(remove);
        row.addEventListener("click", (event) => {
            event.preventDefault();
            if (!event.target.closest("button")) {
                beginLinkEdit(row, link, onManageAction);
            }
        });
    } else if (onOpen) {
        row.addEventListener("click", (event) => onOpen(event, link, row));
        row.addEventListener("auxclick", (event) => {
            if (event.button === 1) {
                onOpen(event, link, row);
            }
        });
    }
    return row;
}

function createHeader(className, title, count, tools) {
    const header = document.createElement("header");
    header.className = className;
    const label = document.createElement("span");
    label.className = `${className}-title`;
    label.textContent = title;
    const number = document.createElement("span");
    number.className = "bm-count";
    number.textContent = String(count);
    header.append(label, number);
    if (tools) {
        header.append(tools);
    }
    return header;
}

export function createBoard({ container, onOpen, onOpenAll, onManageAction } = {}) {
    let model = null;
    let currentNewIds = new Set();
    let currentSelection = new Set();
    const drag = createLinkDrag({
        container,
        rowSelector: ".bm-row",
        folderSelector: ".bm-group, .bm-card",
        rowsSelector: ":scope > .bm-rows",
        onMove: (move) => onManageAction?.({ type: "move", ...move })
    });

    function renderEmpty(nextModel) {
        const empty = document.createElement("div");
        empty.className = "bm-empty";
        if (nextModel.error === "root-missing") {
            empty.append(`Folder "${nextModel.rootPath}" not found. Pick a board root in `);
            const settings = document.createElement("a");
            settings.href = "../pages/settings.html#bookmarks";
            settings.target = "_blank";
            settings.textContent = "settings";
            empty.append(settings, ".");
        } else if (nextModel.emptyReason === "all-hidden") {
            empty.append("Every folder is hidden. Edit hidden folders in ");
            const settings = document.createElement("a");
            settings.href = "../pages/settings.html#bookmarks";
            settings.target = "_blank";
            settings.textContent = "settings";
            empty.append(settings, ".");
        } else {
            empty.textContent = "No bookmarks here yet.";
        }
        container.append(empty);
    }

    function render(nextModel, newIds = currentNewIds, { manage = false, pendingRemoveIds = [] } = {}) {
        model = nextModel;
        currentNewIds = new Set(Array.from(newIds || [], String));
        const pendingRemoves = new Set(Array.from(pendingRemoveIds, String));
        const scrollTop = container.scrollTop;
        container.innerHTML = "";
        if (!nextModel.cards.length) {
            renderEmpty(nextModel);
            container.scrollTop = scrollTop;
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const card of nextModel.cards) {
            const section = document.createElement("section");
            section.className = "bm-card";
            section.dataset.folderId = card.id;
            section.dataset.folderPath = card.path;
            const cardTools = document.createElement("span");
            cardTools.className = "bm-tools";
            if (onOpenAll && !manage) {
                const openAll = createButton("open all ↗", "bm-tool");
                openAll.addEventListener("click", () => onOpenAll(card.links.concat(card.groups.flatMap((group) => group.links)), card));
                cardTools.append(openAll);
            }
            if (manage && !card.isRoot) {
                const addFolder = createButton("＋ folder", "bm-tool bm-add-folder");
                addFolder.addEventListener("click", () => onManageAction?.({ type: "create-folder", parent: card }));
                cardTools.append(addFolder);
            }
            const cardHead = createHeader("bm-card-head", card.title, card.count, cardTools.childElementCount ? cardTools : null);
            if (manage && !card.isRoot) {
                makeTitleEditable(cardHead.firstElementChild, card, onManageAction);
            }
            section.append(cardHead);
            const cardLinks = card.links.concat(card.groups.flatMap((group) => group.links));
            const freshLinks = cardLinks.filter((link) => currentNewIds.has(link.id));
            if (freshLinks.length) {
                const fresh = document.createElement("section");
                fresh.className = "bm-new-section";
                const freshTools = document.createElement("span");
                freshTools.className = "bm-tools";
                if (onOpenAll) {
                    const openNew = createButton("open new ↗", "bm-tool");
                    openNew.addEventListener("click", () => onOpenAll(freshLinks, card, { markRead: true }));
                    freshTools.append(openNew);
                }
                fresh.append(createHeader("bm-new-head", `new · ${freshLinks.length}`, "", freshTools.childElementCount ? freshTools : null));
                const freshRows = document.createElement("div");
                freshRows.className = "bm-rows";
                for (const link of freshLinks) {
                    const row = createRow(link, onOpen, { manage, pendingRemove: pendingRemoves.has(link.id), onManageAction });
                    row.classList.add("bm-new-row");
                    freshRows.append(row);
                }
                fresh.append(freshRows);
                section.append(fresh);
            }
            const directRows = document.createElement("div");
            directRows.className = "bm-rows";
            for (const link of card.links) {
                const row = createRow(link, onOpen, { manage, pendingRemove: pendingRemoves.has(link.id), onManageAction });
                row.hidden = currentNewIds.has(link.id);
                directRows.append(row);
            }
            section.append(directRows);
            for (const group of card.groups) {
                const groupElement = document.createElement("section");
                groupElement.className = "bm-group";
                groupElement.dataset.folderId = group.id;
                groupElement.dataset.folderPath = group.path;
                const groupTools = document.createElement("span");
                groupTools.className = "bm-tools";
                if (onOpenAll && !manage) {
                    const openAll = createButton("open all ↗", "bm-tool");
                    openAll.addEventListener("click", () => onOpenAll(group.links, group));
                    groupTools.append(openAll);
                }
                const groupHead = createHeader("bm-group-head", group.title, group.count, groupTools.childElementCount ? groupTools : null);
                if (manage) {
                    makeTitleEditable(groupHead.firstElementChild, group, onManageAction);
                }
                groupElement.append(groupHead);
                const rows = document.createElement("div");
                rows.className = "bm-rows";
                for (const link of group.links) {
                    const row = createRow(link, onOpen, { manage, pendingRemove: pendingRemoves.has(link.id), onManageAction });
                    row.hidden = currentNewIds.has(link.id);
                    rows.append(row);
                }
                groupElement.append(rows);
                section.append(groupElement);
            }
            fragment.append(section);
        }
        container.append(fragment);
        drag.setEnabled(manage);
        setSelection(currentSelection);
        container.scrollTop = scrollTop;
    }

    function setSelection(ids) {
        currentSelection = new Set(Array.from(ids || [], String));
        container.querySelectorAll(".bm-row[data-bookmark-id]").forEach((row) => {
            row.classList.toggle("is-selected", currentSelection.has(row.dataset.bookmarkId));
        });
    }

    function getRects() {
        return Array.from(container.querySelectorAll(".bm-row:not([hidden])"), (row) => {
            const rect = row.getBoundingClientRect();
            return { id: row.dataset.bookmarkId, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
        }).filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
    }

    function markRead(ids) {
        for (const id of (Array.isArray(ids) ? ids : [ids]).map(String)) {
            currentNewIds.delete(id);
            const escaped = CSS.escape(id);
            const fresh = container.querySelector(`.bm-new-row[data-bookmark-id="${escaped}"]`);
            const twin = container.querySelector(`.bm-row:not(.bm-new-row)[data-bookmark-id="${escaped}"]`);
            if (fresh) {
                fresh.classList.add("is-leaving");
                setTimeout(() => {
                    const section = fresh.closest(".bm-new-section");
                    fresh.remove();
                    if (twin) {
                        twin.hidden = false;
                    }
                    const remaining = section?.querySelectorAll(".bm-new-row").length || 0;
                    if (!remaining) {
                        section?.remove();
                    } else {
                        const heading = section.querySelector(".bm-new-head-title");
                        if (heading) {
                            heading.textContent = `new · ${remaining}`;
                        }
                    }
                }, 150);
            } else if (twin) {
                twin.hidden = false;
            }
        }
    }

    function destroy() {
        container.innerHTML = "";
        model = null;
    }

    return { render, markRead, setSelection, getRects, destroy, getModel: () => model };
}
