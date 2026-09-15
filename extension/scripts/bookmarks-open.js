import { OPEN_ALL_THRESHOLD } from "./constants.js";

async function createBackgroundTab(url) {
    const { tabs } = await import("./extension-api.js");
    if (tabs) {
        await tabs.create({ url, active: false });
        return;
    }
    window.open(url, "_blank", "noopener");
}

export async function openLinks(urls, { threshold = OPEN_ALL_THRESHOLD, confirm = window.confirm.bind(window), createTab = createBackgroundTab } = {}) {
    const links = Array.from(urls || []).filter(Boolean);
    if (links.length > threshold && !confirm(`Open ${links.length} tabs?`)) {
        return { opened: 0, cancelled: true };
    }
    let opened = 0;
    for (const url of links) {
        await createTab(url);
        opened += 1;
    }
    return { opened, cancelled: false };
}
