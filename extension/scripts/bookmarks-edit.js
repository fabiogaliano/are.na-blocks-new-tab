// The flat board and the column browser edit the same bookmarks, so the row and
// title editors live here rather than being written twice with two behaviours.

export function createButton(label, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    return button;
}

export function beginLinkEdit(row, link, onManageAction) {
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

export function makeTitleEditable(title, entity, onManageAction) {
    // The columns wire this on demand from a rename button, so a second click on
    // an already editable title must not stack another rename listener on it.
    if (title.dataset.editId) {
        return title;
    }
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
    return title;
}

export function focusTitle(title) {
    title.focus();
    const range = title.ownerDocument.createRange();
    range.selectNodeContents(title);
    const selection = title.ownerDocument.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}
