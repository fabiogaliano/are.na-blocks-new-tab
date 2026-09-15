import { applyFavicon } from "./bookmark-favicon.js";

function createButton(label, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    return button;
}

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

function beginLinkEdit(row, link, onManageAction) {
    if (row.dataset.editing === "true") {
        return;
    }
    row.dataset.editing = "true";
    const original = Array.from(row.childNodes);
    const title = document.createElement("input");
    title.type = "text";
    title.value = link.title;
    title.setAttribute("aria-label", "Bookmark title");
    const url = document.createElement("input");
    url.type = "text";
    url.value = link.url;
    url.setAttribute("aria-label", "Bookmark URL");
    const restore = () => {
        row.dataset.editing = "false";
        row.replaceChildren(...original);
    };
    const commit = () => {
        onManageAction?.({ type: "update-link", link, title: title.value, url: url.value });
    };
    for (const input of [title, url]) {
        input.addEventListener("click", (event) => event.stopPropagation());
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                commit();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                restore();
            }
        });
    }
    row.replaceChildren(title, url);
    title.focus();
    title.select();
}

function makeTitleEditable(header, entity, onManageAction) {
    const title = header.firstElementChild;
    const original = title.textContent;
    title.contentEditable = "true";
    title.spellcheck = false;
    title.dataset.editId = entity.id;
    title.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            title.blur();
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            title.textContent = original;
            title.blur();
        }
    });
    title.addEventListener("blur", () => {
        const next = title.textContent.trim();
        if (next && next !== original) {
            onManageAction?.({ type: "rename-folder", folder: entity, title: next });
        }
    });
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
                makeTitleEditable(cardHead, card, onManageAction);
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
                    makeTitleEditable(groupHead, group, onManageAction);
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
        wireDrag(manage);
        setSelection(currentSelection);
        container.scrollTop = scrollTop;
    }

    function wireDrag(manage) {
        let draggedId = null;
        const clearInsertion = () => container.querySelectorAll(".is-drop-target").forEach((node) => node.classList.remove("is-drop-target"));
        container.ondragstart = manage ? (event) => {
            const row = event.target.closest(".bm-row");
            if (!row) {
                return;
            }
            draggedId = row.dataset.bookmarkId;
            row.classList.add("is-dragging");
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", draggedId);
        } : null;
        container.ondragover = manage ? (event) => {
            const target = event.target.closest(".bm-row, .bm-group, .bm-card");
            if (!target) {
                return;
            }
            event.preventDefault();
            clearInsertion();
            target.classList.add("is-drop-target");
        } : null;
        container.ondrop = manage ? (event) => {
            event.preventDefault();
            const targetRow = event.target.closest(".bm-row");
            const targetFolder = event.target.closest(".bm-group, .bm-card");
            if (!draggedId || !targetFolder || targetRow?.dataset.bookmarkId === draggedId) {
                clearInsertion();
                return;
            }
            const rows = targetRow?.parentElement || targetFolder.querySelector(":scope > .bm-rows");
            const candidates = Array.from(rows?.querySelectorAll(":scope > .bm-row") || []).filter((row) => row.dataset.bookmarkId !== draggedId);
            const index = targetRow ? Math.max(0, candidates.indexOf(targetRow)) : candidates.length;
            onManageAction?.({ type: "move", id: draggedId, parentId: targetFolder.dataset.folderId, path: targetFolder.dataset.folderPath, index });
            clearInsertion();
        } : null;
        container.ondragend = manage ? () => {
            draggedId = null;
            clearInsertion();
            container.querySelectorAll(".is-dragging").forEach((row) => row.classList.remove("is-dragging"));
        } : null;
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
