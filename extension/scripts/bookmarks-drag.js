// One drag implementation for every bookmark surface: the board, the pinned
// blocks and the column browser all move rows between folders the same way, they
// only disagree on which elements are rows and which are folders.
export function createLinkDrag({ container, rowSelector, folderSelector, rowsSelector = null, onMove }) {
    let draggedId = null;

    const clearInsertion = () => container.querySelectorAll(".is-drop-target").forEach((node) => node.classList.remove("is-drop-target"));

    function handleDragStart(event) {
        const row = event.target.closest(rowSelector);
        if (!row) {
            return;
        }
        draggedId = row.dataset.bookmarkId;
        row.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedId);
    }

    function handleDragOver(event) {
        const target = event.target.closest(`${rowSelector}, ${folderSelector}`);
        if (!target) {
            return;
        }
        event.preventDefault();
        clearInsertion();
        target.classList.add("is-drop-target");
    }

    function handleDrop(event) {
        event.preventDefault();
        // Reading the transfer too lets a row dragged out of one surface land in another.
        const id = draggedId || event.dataTransfer.getData("text/plain");
        const targetRow = event.target.closest(rowSelector);
        const targetFolder = event.target.closest(folderSelector);
        if (!id || !targetFolder?.dataset.folderId || targetRow?.dataset.bookmarkId === id) {
            clearInsertion();
            return;
        }
        const rows = targetRow?.parentElement || (rowsSelector && targetFolder.querySelector(rowsSelector)) || targetFolder;
        const candidates = Array.from(rows.querySelectorAll(`:scope > ${rowSelector}`)).filter((row) => row.dataset.bookmarkId !== id);
        const index = targetRow ? Math.max(0, candidates.indexOf(targetRow)) : candidates.length;
        onMove?.({ id, parentId: targetFolder.dataset.folderId, path: targetFolder.dataset.folderPath, index });
        clearInsertion();
    }

    function handleDragEnd() {
        draggedId = null;
        clearInsertion();
        container.querySelectorAll(".is-dragging").forEach((row) => row.classList.remove("is-dragging"));
    }

    function setEnabled(enabled) {
        container.ondragstart = enabled ? handleDragStart : null;
        container.ondragover = enabled ? handleDragOver : null;
        container.ondrop = enabled ? handleDrop : null;
        container.ondragend = enabled ? handleDragEnd : null;
        if (!enabled) {
            draggedId = null;
        }
    }

    return { setEnabled };
}
