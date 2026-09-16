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

async function restoreNodes(nodes, bookmarksApi, rootId) {
    const created = [];
    let orphaned = 0;
    for (const node of nodes || []) {
        const useOriginalParent = await nodeExists(bookmarksApi, node.parentId);
        if (!useOriginalParent) {
            orphaned += 1;
        }
        await restoreNode(node, bookmarksApi, useOriginalParent ? node.parentId : rootId, created);
    }
    return { created, orphaned };
}

export async function restoreEntry(entry, api, { rootId = "1", storage: storageApi } = {}) {
    const bookmarksApi = await getApi(api);
    const storage = await getStorage(storageApi);
    if (!bookmarksApi) {
        throw new Error("Bookmarks unavailable");
    }
    const result = await restoreNodes(entry?.nodes, bookmarksApi, rootId);
    const trash = await readTrash(storage);
    await writeTrash(trash.entries.filter((candidate) => candidate.id !== entry.id), storage);
    return result;
}

/**
 * Addresses one node inside an entry by its position in the snapshot forest,
 * e.g. "0.2.1". Index paths survive a round trip through storage, which the
 * bookmark ids in a snapshot cannot: those nodes no longer exist.
 */
const childPath = (path, index) => (path ? `${path}.${index}` : String(index));

/** Every link in an entry, flattened, so a restore can be picked apart. */
export function listEntryLinks(entry) {
    const links = [];
    const visit = (nodes, path) => {
        (nodes || []).forEach((node, index) => {
            const here = childPath(path, index);
            if (typeof node.url === "string") {
                links.push({
                    path: here,
                    title: node.title || node.url,
                    // Where it lived when it was deleted: the snapshot already
                    // resolved this for every node, ancestors included.
                    folderPath: node.parentPath || "",
                    url: node.url
                });
                return;
            }
            visit(node.children, here);
        });
    };
    visit(entry?.nodes, "");
    return links;
}

const pruneNodes = (nodes, path, keep, wanted) => (nodes || []).reduce((kept, node, index) => {
    const here = childPath(path, index);
    const selected = wanted.has(here);
    if (typeof node.url === "string") {
        if (selected === keep) {
            kept.push(node);
        }
        return kept;
    }
    const children = pruneNodes(node.children, here, keep, wanted);
    // An ancestor folder rides along with the links it held, so a restored link
    // lands back in its folder rather than loose at the board root.
    if (children.length) {
        kept.push({ ...node, children });
    }
    return kept;
}, []);

/** The entry reduced to the chosen links, ancestor folders included. */
export function pruneEntryToPaths(entry, paths) {
    return { ...entry, nodes: pruneNodes(entry?.nodes, "", true, new Set(paths || [])) };
}

/** What is left in the trash once the chosen links are restored out of it. */
export function removePathsFromEntry(entry, paths) {
    const nodes = pruneNodes(entry?.nodes, "", false, new Set(paths || []));
    return nodes.length ? { ...entry, nodes, label: relabelEntry(entry, nodes) } : null;
}

function relabelEntry(entry, nodes) {
    const count = listEntryLinks({ nodes }).length;
    const prefix = `${entry?.label || ""}`.split(" · ")[0];
    const tail = `${count} left`;
    return prefix && prefix !== entry?.label ? `${prefix} · ${tail}` : tail;
}

export async function restoreSelection(entry, paths, api, { rootId = "1", storage: storageApi } = {}) {
    const bookmarksApi = await getApi(api);
    const storage = await getStorage(storageApi);
    if (!bookmarksApi) {
        throw new Error("Bookmarks unavailable");
    }
    const selection = pruneEntryToPaths(entry, paths);
    if (!selection.nodes.length) {
        return { created: [], orphaned: 0 };
    }
    const result = await restoreNodes(selection.nodes, bookmarksApi, rootId);
    const remainder = removePathsFromEntry(entry, paths);
    const trash = await readTrash(storage);
    await writeTrash(
        trash.entries.flatMap((candidate) => {
            if (candidate.id !== entry.id) {
                return [candidate];
            }
            return remainder ? [remainder] : [];
        }),
        storage
    );
    return result;
}
