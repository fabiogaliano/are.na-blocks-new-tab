import { STORAGE_KEYS, TRASH_MAX_ENTRIES } from "./constants.js";

const asEntries = (value) => Array.isArray(value?.entries) ? value.entries : [];

async function getStorage(storageApi) {
    return storageApi || (await import("./extension-api.js")).storage;
}

async function getApi(api) {
    return api || (await import("./extension-api.js")).bookmarks;
}

export function snapshotSubtree(node, parentPath = node?.parentPath || "") {
    if (!node || typeof node !== "object") {
        throw new Error("Cannot snapshot an empty bookmark node.");
    }
    const snapshot = {
        title: node.title ?? "",
        parentId: node.parentId ?? null,
        parentPath,
        index: Number.isInteger(node.index) ? node.index : 0
    };
    if (typeof node.url === "string") {
        snapshot.url = node.url;
    }
    if (Array.isArray(node.children)) {
        const childParentPath = [parentPath, node.title].filter(Boolean).join("/");
        snapshot.children = node.children.map((child) => snapshotSubtree(child, childParentPath));
    }
    return snapshot;
}

export function pruneTrash(entries, max = TRASH_MAX_ENTRIES) {
    return [...(Array.isArray(entries) ? entries : [])]
        .sort((left, right) => Number(right.deletedAt || 0) - Number(left.deletedAt || 0))
        .slice(0, Math.max(0, max));
}

export async function readTrash(storageApi) {
    const storage = await getStorage(storageApi);
    const raw = await storage.get(STORAGE_KEYS.bookmarkTrash);
    return { entries: pruneTrash(asEntries(raw?.[STORAGE_KEYS.bookmarkTrash])) };
}

export async function writeTrash(entries, storageApi) {
    const storage = await getStorage(storageApi);
    const value = { entries: pruneTrash(entries) };
    await storage.set({ [STORAGE_KEYS.bookmarkTrash]: value });
    return value;
}

export async function clearTrash(storageApi) {
    const storage = await getStorage(storageApi);
    await storage.set({ [STORAGE_KEYS.bookmarkTrash]: { entries: [] } });
}

function buildParentPaths(tree) {
    const paths = new Map();
    const visit = (node, path) => {
        paths.set(String(node.id), path);
        const childPath = node.id === "1" ? "" : [path, node.title].filter(Boolean).join("/");
        for (const child of node.children || []) {
            visit(child, childPath);
        }
    };
    for (const root of tree || []) {
        visit(root, "");
    }
    return paths;
}

export async function deleteNodes(ids, api, { label, storage: storageApi } = {}) {
    const targets = [...new Set((ids || []).map(String))];
    if (!targets.length) {
        return null;
    }
    const bookmarksApi = await getApi(api);
    const storage = await getStorage(storageApi);
    if (!bookmarksApi) {
        throw new Error("Bookmarks unavailable");
    }
    const tree = await bookmarksApi.getTree();
    const parentPaths = buildParentPaths(tree);
    const nodes = [];
    for (const id of targets) {
        const subtree = await bookmarksApi.getSubTree(id);
        const node = subtree?.[0];
        if (!node) {
            continue;
        }
        nodes.push(snapshotSubtree(node, parentPaths.get(String(node.parentId)) || ""));
    }
    if (!nodes.length) {
        return null;
    }
    const entry = {
        id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        deletedAt: Date.now(),
        label: label || `${nodes.length} bookmark${nodes.length === 1 ? "" : "s"}`,
        nodes
    };
    const current = await readTrash(storage);
    await writeTrash([entry, ...current.entries], storage);
    for (const id of targets) {
        await bookmarksApi.remove(id);
    }
    return entry;
}

async function nodeExists(api, id) {
    if (!id) {
        return false;
    }
    try {
        const result = await api.get(String(id));
        return Boolean(result?.length);
    } catch {
        return false;
    }
}

async function restoreNode(node, api, parentId, created) {
    const details = {
        parentId: String(parentId),
        index: node.index,
        title: node.title
    };
    if (node.url) {
        details.url = node.url;
    }
    const restored = await api.create(details);
    created.push(String(restored.id));
    for (const child of node.children || []) {
        await restoreNode(child, api, restored.id, created);
    }
}

export async function restoreEntry(entry, api, { rootId = "1", storage: storageApi } = {}) {
    const bookmarksApi = await getApi(api);
    const storage = await getStorage(storageApi);
    if (!bookmarksApi) {
        throw new Error("Bookmarks unavailable");
    }
    const created = [];
    let orphaned = 0;
    for (const node of entry?.nodes || []) {
        const useOriginalParent = await nodeExists(bookmarksApi, node.parentId);
        if (!useOriginalParent) {
            orphaned += 1;
        }
        await restoreNode(node, bookmarksApi, useOriginalParent ? node.parentId : rootId, created);
    }
    const trash = await readTrash(storage);
    await writeTrash(trash.entries.filter((candidate) => candidate.id !== entry.id), storage);
    return { created, orphaned };
}
