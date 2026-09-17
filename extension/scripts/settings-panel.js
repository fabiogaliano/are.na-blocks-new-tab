export const SETTINGS_PANEL_CHANNEL = "arena-settings-panel";

/**
 * Hosts the settings page in a slide-over instead of a tab so the blocks the
 * user was looking at stay on screen and survive the visit.
 */
export function createSettingsPanel({ root, frame, openButton, closeButtons = [], src, onManageBookmarks }) {
    if (!root || !frame) {
        return { open() {}, close() {}, isOpen: () => false };
    }

    let lastFocused = null;

    const isOpen = () => !root.hasAttribute("inert");

    function open() {
        if (isOpen()) {
            return;
        }
        lastFocused = document.activeElement;
        // Loaded on first open only: the settings page reads storage and the
        // Are.na catalog, which a tab that never opens it should not pay for.
        if (!frame.getAttribute("src")) {
            frame.setAttribute("src", src);
        }
        root.removeAttribute("inert");
        root.setAttribute("aria-hidden", "false");
        closeButtons[0]?.focus();
    }

    function close() {
        if (!isOpen()) {
            return;
        }
        root.setAttribute("inert", "");
        root.setAttribute("aria-hidden", "true");
        // Settings auto-saves, so there is nothing to discard — but it holds
        // back the Are.na refresh its edits earned until it hears this.
        frame.contentWindow?.postMessage(
            { channel: SETTINGS_PANEL_CHANNEL, type: "closed" },
            window.location.origin
        );
        if (lastFocused?.isConnected) {
            lastFocused.focus();
        } else {
            openButton?.focus();
        }
        lastFocused = null;
    }

    function handleMessage(event) {
        if (event.origin !== window.location.origin || event.source !== frame.contentWindow) {
            return;
        }
        if (event.data?.channel !== SETTINGS_PANEL_CHANNEL) {
            return;
        }
        if (event.data.type === "close-requested") {
            close();
        } else if (event.data.type === "manage-bookmarks") {
            // The editor it asks for lives out here, so the panel gets out of its way.
            close();
            onManageBookmarks?.();
        }
    }

    function handleKeyDown(event) {
        if (!isOpen() || event.defaultPrevented) {
            return;
        }
        // The panel owns the keyboard while it is up, so the new tab shortcuts
        // underneath it cannot fire at a surface the user cannot see.
        event.preventDefault();
        if (event.key === "Escape") {
            close();
        }
    }

    openButton?.addEventListener("click", (event) => {
        event.preventDefault();
        open();
    });
    closeButtons.forEach((button) => button.addEventListener("click", () => close()));
    window.addEventListener("message", handleMessage);
    document.addEventListener("keydown", handleKeyDown);

    return { open, close, isOpen };
}
