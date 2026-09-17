import { applyFavicon } from "./bookmark-favicon.js";
import { createLinkDrag } from "./bookmarks-drag.js";
import { beginLinkEdit, createButton, focusTitle, makeTitleEditable } from "./bookmarks-edit.js";

export const COLUMN_SLOTS = 3;

// A folder only advertises unread posts for what is actually inside it, so the count
// you follow down the columns always resolves to a marked row.
export function countFresh(node, freshFor) {
    if (typeof freshFor !== "function") {
        return 0;
    }
    const own = (node.links || []).reduce((total, link) => total + (freshFor(link) || 0), 0);
    return (node.children || []).reduce((total, child) => total + countFresh(child, freshFor), own);
}

export function createNewPill(document, label) {
    const pill = document.createElement("span");
    pill.className = "bm-new-pill";
    pill.textContent = label;
    return pill;
}

export function nodeAtDepth(nodes, path, depth) {
    if (depth === 0) {
        return { children: nodes };
    }
    let node = nodes.find((candidate) => candidate.path === path[0]);
    for (let index = 1; index < depth; index += 1) {
        if (!node) {
            return null;
        }
        node = (node.children || []).find((candidate) => candidate.path === path[index]);
    }
    return node || null;
}

// Only the deepest COLUMN_SLOTS columns are shown, so arbitrarily deep paths still fit
// three panes instead of growing the browser sideways.
export function windowStart(path) {
    return Math.max(0, path.length + 1 - COLUMN_SLOTS);
}

export function columnDescriptor(nodes, path, depth) {
    const node = nodeAtDepth(nodes, path, depth);
    if (!node) {
        return null;
    }
    const children = node.children || [];
    if (!children.length && depth > 0) {
        return { type: "links", links: node.links || [], selected: null };
    }
    return { type: "items", items: children, links: depth > 0 ? node.links || [] : [], selected: path[depth] || null };
}

export function createColumns({ container, breadcrumb, onOpen, onOpenAll, onManageAction }) {
    let nodes = [];
    let path = [];
    let freshFor = () => 0;
    let manage = false;
    let pendingRemoves = new Set();
    const drag = createLinkDrag({
        container,
        rowSelector: ".bm-col-row",
        folderSelector: ".bm-col-item, .bm-col",
        onMove: (move) => onManageAction?.({ type: "move", ...move })
    });

    function selectAt(depth, nodePath) {
        path = path.slice(0, depth);
        path.push(nodePath);
        render();
    }

    function label(depth) {
        if (depth === 0) {
            return "top level";
        }
        const parent = nodeAtDepth(nodes, path, depth);
        return parent?.title || path[depth - 1]?.split("/").at(-1) || "";
    }

    // Titles rather than the stored path: a folder renamed in manage mode has to read
    // back as its new name before the rename is written to the browser.
    function breadcrumbLabel() {
        return path.map((segment, index) => nodeAtDepth(nodes, path, index + 1)?.title || segment.split("/").at(-1)).join(" › ");
    }

    function renderLinkRow(link) {
        const row = document.createElement("a");
        row.className = "bm-col-row";
        row.href = link.url;
        row.target = "_blank";
        row.rel = "noopener";
        row.title = link.title;
        row.dataset.bookmarkId = link.id;
        row.draggable = manage;
        row.classList.toggle("is-pending-remove", pendingRemoves.has(String(link.id)));
        const favicon = document.createElement("img");
        favicon.className = "bm-favicon";
        favicon.alt = "";
        favicon.loading = "lazy";
        favicon.decoding = "async";
        applyFavicon(favicon, link.url);
        const title = document.createElement("span");
        title.className = "bm-col-row-title";
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
            return row;
        }
        const fresh = freshFor(link);
        if (fresh) {
            row.classList.add("bm-new-row");
            row.append(createNewPill(document, `${fresh}`));
        }
        if (onOpen) {
            row.addEventListener("click", (event) => onOpen(event, link, row));
            row.addEventListener("auxclick", (event) => {
                if (event.button === 1) {
                    onOpen(event, link, row);
                }
            });
        }
        return row;
    }

    function renderItem(node, depth, selected) {
        // A rename button cannot live inside a button, so manage mode trades the
        // native button for a focusable row that still opens on click and Enter.
        const item = document.createElement(manage ? "div" : "button");
        if (manage) {
            item.tabIndex = 0;
            item.dataset.folderId = node.id;
        } else {
            item.type = "button";
        }
        item.className = "bm-col-item";
        item.classList.toggle("is-selected", node.path === selected);
        item.dataset.folderPath = node.path;
        const name = document.createElement("span");
        name.className = "bm-col-item-name";
        name.textContent = node.title;
        const count = document.createElement("span");
        count.className = "bm-col-item-count";
        count.textContent = `${node.count} ›`;
        const fresh = manage ? 0 : countFresh(node, freshFor);
        if (fresh) {
            item.classList.add("has-new");
            item.append(name, createNewPill(document, `${fresh}`), count);
        } else {
            item.append(name, count);
        }
        const open = () => selectAt(depth, node.path);
        if (manage) {
            const rename = createButton("✎", "bm-tool bm-col-rename");
            rename.title = "rename";
            rename.addEventListener("click", (event) => {
                event.stopPropagation();
                focusTitle(makeTitleEditable(name, node, onManageAction));
            });
            item.append(rename);
            item.addEventListener("click", (event) => {
                if (!event.target.closest("button, [contenteditable='true']")) {
                    open();
                }
            });
            item.addEventListener("keydown", (event) => {
                if (event.key === "Enter" && event.target === item) {
                    event.preventDefault();
                    open();
                }
            });
        } else {
            item.addEventListener("click", open);
        }
        return item;
    }

    function renderHead(column, depth, node) {
        const head = document.createElement("div");
        head.className = "bm-col-head";
        const title = document.createElement("span");
        title.className = "bm-col-head-title";
        title.textContent = label(depth);
        const tools = document.createElement("span");
        tools.className = "bm-tools";
        head.append(title, tools);
        column.append(head);
        if (manage && node) {
            makeTitleEditable(title, node, onManageAction);
            const addFolder = createButton("＋ folder", "bm-tool bm-add-folder");
            addFolder.addEventListener("click", () => onManageAction?.({ type: "create-folder", parent: node }));
            tools.append(addFolder);
        }
        return { head, tools };
    }

    function render() {
        // Every edit re-renders the browser, so a column still showing the same folder
        // keeps its place rather than jumping to the top after a rename or a delete.
        const scrollTops = new Map(Array.from(container.children, (column) => [column.dataset.folderPath || "", column.scrollTop]));
        container.innerHTML = "";
        if (breadcrumb) {
            breadcrumb.textContent = breadcrumbLabel();
        }
        const start = windowStart(path);
        for (let slot = 0; slot < COLUMN_SLOTS; slot += 1) {
            const depth = start + slot;
            const column = document.createElement("div");
            column.className = "bm-col";
            const node = depth > 0 ? nodeAtDepth(nodes, path, depth) : null;
            if (node) {
                column.dataset.folderId = node.id;
                column.dataset.folderPath = node.path;
            }

            const { tools } = renderHead(column, depth, node);
            const descriptor = columnDescriptor(nodes, path, depth);
            if (!descriptor) {
                // a column past the current selection stays blank rather than prompting
                column.classList.add("is-idle");
            } else if (descriptor.type === "links") {
                if (!descriptor.links.length) {
                    const empty = document.createElement("div");
                    empty.className = "bm-col-empty";
                    empty.textContent = "empty";
                    column.append(empty);
                } else {
                    if (onOpenAll && !manage && descriptor.links.length > 1) {
                        tools.append(openAllButton(descriptor.links));
                    }
                    for (const link of descriptor.links) {
                        column.append(renderLinkRow(link));
                    }
                }
            } else {
                for (const child of descriptor.items) {
                    column.append(renderItem(child, depth, descriptor.selected));
                }
                // a folder holding both subfolders and its own links shows them under the subfolders
                for (const link of descriptor.links) {
                    column.append(renderLinkRow(link));
                }
            }
            container.append(column);
            column.scrollTop = scrollTops.get(column.dataset.folderPath || "") || 0;
        }
        drag.setEnabled(manage);
    }

    function openAllButton(links) {
        const button = createButton("open all ↗", "bm-tool");
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            onOpenAll(links);
        });
        return button;
    }

    function setNodes(nextNodes, { keepPath = true, freshFor: nextFreshFor, manage: nextManage = false, pendingRemoveIds = [] } = {}) {
        nodes = nextNodes || [];
        manage = nextManage;
        pendingRemoves = new Set(Array.from(pendingRemoveIds, String));
        if (typeof nextFreshFor === "function") {
            freshFor = nextFreshFor;
        }
        if (!keepPath || !nodeAtDepth(nodes, path, path.length)) {
            path = nodes.length ? [nodes[0].path] : [];
        }
        render();
    }

    // A folder created while managing lands in the column the user pressed ＋ in,
    // so it opens for renaming instead of leaving "new folder" to be hunted down.
    function focusFolder(node) {
        const name = container.querySelector(`.bm-col-item[data-folder-id="${CSS.escape(String(node.id))}"] .bm-col-item-name`);
        if (!name) {
            return false;
        }
        focusTitle(makeTitleEditable(name, node, onManageAction));
        return true;
    }

    return { setNodes, render, focusFolder, getPath: () => path.slice() };
}
