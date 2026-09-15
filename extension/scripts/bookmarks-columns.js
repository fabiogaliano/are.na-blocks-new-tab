import { applyFavicon } from "./bookmark-favicon.js";

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

export function createColumns({ container, breadcrumb, onOpen, onOpenAll }) {
    let nodes = [];
    let path = [];
    let freshFor = () => 0;

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

    function renderLinkRow(link) {
        const row = document.createElement("a");
        row.className = "bm-col-row";
        row.href = link.url;
        row.target = "_blank";
        row.rel = "noopener";
        row.title = link.title;
        row.dataset.bookmarkId = link.id;
        const favicon = document.createElement("img");
        favicon.className = "bm-favicon";
        favicon.alt = "";
        favicon.loading = "lazy";
        favicon.decoding = "async";
        applyFavicon(favicon, link.url);
        const title = document.createElement("span");
        title.className = "bm-col-row-title";
        title.textContent = link.title;
        row.append(favicon, title);
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
        const item = document.createElement("button");
        item.type = "button";
        item.className = "bm-col-item";
        item.classList.toggle("is-selected", node.path === selected);
        item.dataset.folderPath = node.path;
        const name = document.createElement("span");
        name.className = "bm-col-item-name";
        name.textContent = node.title;
        const count = document.createElement("span");
        count.className = "bm-col-item-count";
        count.textContent = `${node.count} ›`;
        const fresh = countFresh(node, freshFor);
        if (fresh) {
            item.classList.add("has-new");
            item.append(name, createNewPill(document, `${fresh}`), count);
        } else {
            item.append(name, count);
        }
        item.addEventListener("click", () => selectAt(depth, node.path));
        return item;
    }

    function render() {
        container.innerHTML = "";
        if (breadcrumb) {
            breadcrumb.textContent = path.length ? path.at(-1).split("/").join(" › ") : "";
        }
        const start = windowStart(path);
        for (let slot = 0; slot < COLUMN_SLOTS; slot += 1) {
            const depth = start + slot;
            const column = document.createElement("div");
            column.className = "bm-col";

            const head = document.createElement("div");
            head.className = "bm-col-head";
            head.textContent = label(depth);
            column.append(head);

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
                    if (onOpenAll && descriptor.links.length > 1) {
                        head.append(openAllButton(descriptor.links));
                    }
                    for (const link of descriptor.links) {
                        column.append(renderLinkRow(link));
                    }
                }
            } else {
                for (const node of descriptor.items) {
                    column.append(renderItem(node, depth, descriptor.selected));
                }
                // a folder holding both subfolders and its own links shows them under the subfolders
                for (const link of descriptor.links) {
                    column.append(renderLinkRow(link));
                }
            }
            container.append(column);
        }
    }

    function openAllButton(links) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "bm-tool";
        button.textContent = "open all ↗";
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            onOpenAll(links);
        });
        return button;
    }

    function setNodes(nextNodes, { keepPath = true, freshFor: nextFreshFor } = {}) {
        nodes = nextNodes || [];
        if (typeof nextFreshFor === "function") {
            freshFor = nextFreshFor;
        }
        if (!keepPath || !nodeAtDepth(nodes, path, path.length)) {
            path = nodes.length ? [nodes[0].path] : [];
        }
        render();
    }

    return { setNodes, render, getPath: () => path.slice() };
}
