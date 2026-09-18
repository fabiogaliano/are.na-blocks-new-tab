import { storage } from "./extension-api.js";
import { STORAGE_KEYS } from "./constants.js";
import { getBlocks } from "./block-store.js";
import { getRecentEntries, saveRecentEntries } from "./recent-store.js";
import { groupRecent, pruneRecent } from "./recent-model.js";
import { formatRelativeTime } from "./time.js";

const TEXT_PREVIEW_LENGTH = 120;

const isTyping = (target) => Boolean(target?.isContentEditable) ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || "");

const thumbSource = (block) => block?.imageVersions?.square?.src ||
    block?.imageVersions?.small?.src ||
    block?.imageUrl ||
    "";

const blockLabel = (block) => {
    const title = `${block?.title || ""}`.trim();
    if (title) {
        return title;
    }
    const text = `${block?.contentText || block?.descriptionText || ""}`.trim();
    return text || `Block ${block?.id ?? ""}`.trim();
};

export function createRecentRail({
    root,
    track,
    countElements = [],
    toggleButton,
    closeButton,
    emptyElement,
    onRestore,
    canOpen = () => true
}) {
    const document = root?.ownerDocument ?? globalThis.document;
    const counters = countElements.filter(Boolean);
    let mounted = false;
    let open = false;
    let entries = [];
    let renderToken = 0;

    function setCount(value) {
        counters.forEach((element) => {
            element.textContent = value ? `${value}` : "";
            element.hidden = !value;
        });
    }

    async function refresh({ rerender = open } = {}) {
        entries = await getRecentEntries();
        setCount(entries.length);
        if (rerender) {
            await render();
        }
    }

    // Resolving ids to records is the expensive half, so it happens when the
    // rail is opened rather than on every draw.
    async function render() {
        if (!track) {
            return;
        }
        const token = ++renderToken;
        let blocks = [];
        try {
            blocks = await getBlocks(entries.map((entry) => entry.id));
        } catch (error) {
            console.warn("Could not read recently seen blocks", error);
        }
        if (token !== renderToken) {
            return;
        }

        const byId = new Map(blocks.map((block) => [`${block.id}`, block]));
        // Ids the store can no longer resolve are gone for good; dropping them
        // here keeps the buffer from silently filling with holes.
        if (byId.size !== entries.length) {
            const pruned = pruneRecent(entries, byId.keys());
            if (pruned.length !== entries.length) {
                entries = pruned;
                setCount(entries.length);
                saveRecentEntries(entries).catch((error) => console.warn("Could not prune recently seen blocks", error));
            }
        }

        track.replaceChildren();
        const now = Date.now();
        let lastLabel = "";
        for (const group of groupRecent(entries, now)) {
            const resolved = group.entries.filter((entry) => byId.has(entry.id));
            if (!resolved.length) {
                continue;
            }
            track.appendChild(renderGroup(group.label, group.label === lastLabel, resolved, byId, now));
            lastLabel = group.label;
        }
        const empty = !track.childElementCount;
        if (emptyElement) {
            emptyElement.hidden = !empty;
        }
        track.hidden = empty;
    }

    function renderGroup(label, repeatsLabel, groupEntries, byId, now) {
        const section = document.createElement("section");
        section.className = "recent-group";
        const heading = document.createElement("h2");
        heading.className = "recent-group-label";
        // Kept in the flow when it repeats the group before it, so every row of
        // thumbnails still starts at the same height.
        heading.classList.toggle("is-repeat", Boolean(repeatsLabel));
        heading.textContent = label;
        if (repeatsLabel) {
            heading.setAttribute("aria-hidden", "true");
        }

        const row = document.createElement("div");
        row.className = "recent-group-row";
        const blocks = groupEntries.map((entry) => byId.get(entry.id));
        groupEntries.forEach((entry, index) => row.appendChild(renderThumb(blocks[index], entry.at, now)));

        const restoreButton = document.createElement("button");
        restoreButton.type = "button";
        restoreButton.className = "recent-group-restore";
        restoreButton.textContent = "bring back";
        restoreButton.setAttribute(
            "aria-label",
            `Bring these ${blocks.length === 1 ? "block" : `${blocks.length} blocks`} back to the tab`
        );
        restoreButton.addEventListener("click", () => restore(blocks));

        const head = document.createElement("div");
        head.className = "recent-group-head";
        head.append(heading, restoreButton);

        section.append(head, row);
        return section;
    }

    function renderThumb(block, at, now) {
        const thumb = document.createElement("a");
        thumb.className = "recent-thumb";
        thumb.dataset.blockId = `${block.id}`;
        thumb.href = block.arenaUrl || `https://www.are.na/block/${block.id}`;
        thumb.target = "_blank";
        thumb.rel = "noopener";

        const label = blockLabel(block);
        const seen = at ? formatRelativeTime(at, now) : "";
        thumb.title = seen ? `${label} — seen ${seen}` : label;

        const source = thumbSource(block);
        if (source) {
            const image = document.createElement("img");
            image.src = source;
            image.alt = "";
            image.loading = "lazy";
            thumb.appendChild(image);
        } else {
            const text = document.createElement("span");
            text.className = "recent-thumb-text";
            text.textContent = label.slice(0, TEXT_PREVIEW_LENGTH);
            thumb.appendChild(text);
        }

        const caption = document.createElement("span");
        caption.className = "recent-thumb-caption";
        caption.textContent = label;
        thumb.appendChild(caption);

        return thumb;
    }

    function restore(blocks) {
        if (!blocks?.length) {
            return;
        }
        onRestore?.(blocks);
        close();
    }

    function thumbs() {
        return Array.from(track?.querySelectorAll(".recent-thumb") || []);
    }

    function moveFocus(step) {
        const all = thumbs();
        if (!all.length) {
            return;
        }
        const index = all.indexOf(document.activeElement);
        const next = index === -1 ? 0 : Math.min(all.length - 1, Math.max(0, index + step));
        all[next]?.focus();
    }

    async function show() {
        if (open || !root || !canOpen()) {
            return;
        }
        open = true;
        root.hidden = false;
        toggleButton?.setAttribute("aria-expanded", "true");
        await refresh({ rerender: true });
        // Only after the render, or there is nothing to put the focus on.
        thumbs()[0]?.focus();
    }

    function close({ restoreFocus = true } = {}) {
        if (!open || !root) {
            return;
        }
        open = false;
        root.hidden = true;
        toggleButton?.setAttribute("aria-expanded", "false");
        if (restoreFocus && toggleButton && root.contains(document.activeElement)) {
            toggleButton.focus();
        }
    }

    function toggle() {
        return open ? close() : show();
    }

    function handleKeyDown(event) {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }
        if (open && event.key === "Escape") {
            event.preventDefault();
            close();
            return;
        }
        if (open && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
            event.preventDefault();
            moveFocus(event.key === "ArrowRight" ? 1 : -1);
            return;
        }
        if (event.shiftKey || isTyping(event.target) || event.key.toLowerCase() !== "h") {
            return;
        }
        event.preventDefault();
        toggle();
    }

    function handleStorageChange(changes, area) {
        if (area !== "local" || !changes[STORAGE_KEYS.recent]) {
            return;
        }
        refresh();
    }

    async function mount() {
        if (mounted) {
            return;
        }
        mounted = true;
        toggleButton?.addEventListener("click", toggle);
        closeButton?.addEventListener("click", () => close());
        document.addEventListener("keydown", handleKeyDown);
        storage.onChanged?.addListener(handleStorageChange);
        // The bookmarks view can be reached by click as well as by key, and an
        // open rail hanging over it would have nothing to put a block back onto.
        new MutationObserver(() => {
            if (!canOpen()) {
                close({ restoreFocus: false });
            }
        }).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
        await refresh({ rerender: false });
    }

    return {
        mount,
        refresh,
        open: show,
        close,
        toggle,
        isOpen: () => open
    };
}
