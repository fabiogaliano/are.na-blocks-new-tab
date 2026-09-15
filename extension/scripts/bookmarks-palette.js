import { applyFavicon } from "./bookmark-favicon.js";

export function filterLinks(links, { query = "", folder = "", filter = "all", newIds = [] } = {}) {
    const terms = `${query}`.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const folderPath = `${folder}`.toLowerCase();
    const fresh = new Set(Array.from(newIds || [], String));
    return (links || []).filter((link) => {
        const path = `${link.path || ""}`.toLowerCase();
        const cardPath = path.split("/")[0];
        const inFolder = !folderPath || path === folderPath || cardPath === folderPath;
        const searchable = `${link.title || ""} ${link.host || ""}`.toLowerCase();
        return inFolder && (filter !== "new" || fresh.has(String(link.id))) && terms.every((term) => searchable.includes(term));
    });
}

function createResultRow(document, link, onOpen) {
    const row = document.createElement("a");
    row.className = "bm-palette-row";
    row.href = link.url;
    row.target = "_blank";
    row.rel = "noopener";
    row.dataset.bookmarkId = link.id;
    const favicon = document.createElement("img");
    favicon.alt = "";
    applyFavicon(favicon, link.url);
    const title = document.createElement("span");
    title.textContent = link.title;
    const host = document.createElement("span");
    host.className = "bm-palette-host";
    host.textContent = link.host;
    row.append(favicon, title, host);
    row.addEventListener("click", (event) => {
        event.preventDefault();
        onOpen(link);
    });
    return row;
}

export function createPalette({ overlay, onOpen, onOpenAll, onPickFolder }) {
    const document = overlay.ownerDocument;
    const panel = overlay.querySelector(".bm-palette-panel");
    const input = overlay.querySelector("#bm-palette-query");
    const nav = overlay.querySelector("#bm-palette-folders");
    const filters = overlay.querySelector("#bm-palette-filters");
    const list = overlay.querySelector("#bm-palette-results");
    let links = [];
    let folders = [];
    let newIds = new Set();
    let folder = "";
    let filter = "all";
    let highlighted = 0;
    let shownLinks = [];
    let shownFolders = [];
    let mode = "search";

    function renderFolders() {
        nav.innerHTML = "";
        const query = mode === "folder" ? input.value.trim().toLowerCase() : "";
        shownFolders = [{ id: "", path: "", title: "all", count: links.length, linkIds: links.map((link) => link.id) }, ...folders]
            .filter((item) => mode !== "folder" || item.id && (!query || item.title.toLowerCase().includes(query)));
        shownFolders.forEach((item, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.folderPath = item.path;
            button.classList.toggle("is-active", mode === "folder" ? index === highlighted : folder === item.path);
            const title = document.createElement("span");
            title.textContent = item.title;
            button.append(title);
            const freshCount = item.linkIds?.filter((id) => newIds.has(String(id))).length || 0;
            if (freshCount) {
                const badge = document.createElement("span");
                badge.className = "bookmark-new-badge";
                badge.textContent = String(freshCount);
                button.append(badge);
            }
            const count = document.createElement("span");
            count.className = "bm-palette-count";
            count.textContent = String(item.count);
            button.append(count);
            button.addEventListener("click", () => {
                if (mode === "folder") {
                    onPickFolder(item);
                    close();
                } else {
                    folder = item.path;
                    highlighted = 0;
                    render();
                }
            });
            nav.append(button);
        });
    }

    function renderResults() {
        shownLinks = filterLinks(links, { query: input.value, folder, filter, newIds });
        highlighted = Math.min(highlighted, Math.max(0, shownLinks.length - 1));
        list.innerHTML = "";
        if (!links.length) {
            list.textContent = "No bookmarks to search";
            return;
        }
        if (!shownLinks.length) {
            list.textContent = "No matches";
            return;
        }
        shownLinks.forEach((link, index) => {
            const row = createResultRow(document, link, onOpen);
            row.classList.toggle("is-highlighted", index === highlighted);
            list.append(row);
        });
    }

    function render() {
        if (mode === "folder") {
            highlighted = Math.min(highlighted, Math.max(0, shownFolders.length - 1));
        }
        renderFolders();
        if (mode !== "folder") {
            renderResults();
        }
    }

    function moveHighlight(delta) {
        const length = mode === "folder" ? shownFolders.length : shownLinks.length;
        highlighted = Math.max(0, Math.min(Math.max(0, length - 1), highlighted + delta));
        render();
        const selector = mode === "folder" ? ".is-active" : ".is-highlighted";
        (mode === "folder" ? nav : list).querySelector(selector)?.scrollIntoView({ block: "nearest" });
    }

    function handleKeyDown(event) {
        if (overlay.hidden) {
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveHighlight(event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Enter" && mode === "folder") {
            event.preventDefault();
            const choice = shownFolders[highlighted];
            if (choice) {
                onPickFolder(choice);
                close();
            }
        } else if (event.key === "Enter" && event.shiftKey) {
            event.preventDefault();
            onOpenAll(shownLinks);
        } else if (event.key === "Enter") {
            event.preventDefault();
            const link = shownLinks[highlighted];
            if (link) {
                onOpen(link);
            }
        } else if (event.key === "Escape") {
            event.preventDefault();
            if (input.value) {
                input.value = "";
                highlighted = 0;
                render();
            } else {
                close();
            }
        }
    }

    function open({ links: nextLinks = [], folders: nextFolders = [], newIds: nextNewIds = [], mode: nextMode = "search" } = {}) {
        links = nextLinks;
        folders = nextFolders;
        newIds = new Set(Array.from(nextNewIds, String));
        mode = nextMode;
        folder = "";
        filter = "all";
        highlighted = 0;
        filters.querySelectorAll("[data-filter]").forEach((button) => button.classList.toggle("is-active", button.dataset.filter === "all"));
        input.value = "";
        input.placeholder = mode === "folder" ? "Move to folder…" : `Search ${links.length} bookmarks, or browse a folder →`;
        overlay.dataset.mode = mode;
        overlay.hidden = false;
        render();
        input.focus();
    }

    function close() {
        overlay.hidden = true;
    }

    input.addEventListener("input", () => {
        highlighted = 0;
        render();
    });
    filters.addEventListener("click", (event) => {
        const button = event.target.closest("[data-filter]");
        if (!button) {
            return;
        }
        filter = button.dataset.filter;
        highlighted = 0;
        filters.querySelectorAll("[data-filter]").forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
        renderResults();
    });
    overlay.addEventListener("pointerdown", (event) => {
        if (event.target === overlay) {
            close();
        }
    });
    panel.addEventListener("pointerdown", (event) => event.stopPropagation());
    document.addEventListener("keydown", handleKeyDown);

    return {
        open,
        close,
        isOpen: () => !overlay.hidden,
        update({ links: nextLinks = links, folders: nextFolders = folders, newIds: nextNewIds = newIds } = {}) {
            links = nextLinks;
            folders = nextFolders;
            newIds = new Set(Array.from(nextNewIds, String));
            if (!overlay.hidden) {
                render();
            }
        },
        destroy() {
            document.removeEventListener("keydown", handleKeyDown);
        }
    };
}
