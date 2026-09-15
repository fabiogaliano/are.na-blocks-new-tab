import { deleteNodes } from "./bookmarks-trash.js";
import { normalizeFolderPath } from "./settings-model.js";

const folderChildren = (node) => (node?.children || []).filter((child) => !child.url && child.type !== "separator");
const keyPath = (path) => normalizeFolderPath(path).toLowerCase();
const pathDepth = (path) => normalizeFolderPath(path).split("/").filter(Boolean).length;

function addAncestors(paths) {
    const expanded = new Map();
    for (const rawPath of paths) {
        const segments = normalizeFolderPath(rawPath).split("/").filter(Boolean);
        for (let index = 1; index <= segments.length; index += 1) {
            const path = segments.slice(0, index).join("/");
            if (!expanded.has(keyPath(path))) {
                expanded.set(keyPath(path), path);
            }
        }
    }
    return [...expanded.values()].sort((left, right) => pathDepth(left) - pathDepth(right));
}

function indexTree(tree) {
    const byId = new Map();
    const byUrl = new Map();
    const parentById = new Map();
    const visit = (node, parent = null) => {
        byId.set(String(node.id), node);
        if (parent) {
            parentById.set(String(node.id), parent);
        }
        if (node.url) {
            const matches = byUrl.get(node.url) || [];
            matches.push(node);
            byUrl.set(node.url, matches);
        }
        for (const child of node.children || []) {
            visit(child, node);
        }
    };
    for (const root of tree || []) {
        visit(root);
    }
    return { byId, byUrl, parentById };
}

function findFolder(root, path) {
    let current = root;
    for (const segment of normalizeFolderPath(path).split("/").filter(Boolean)) {
        current = folderChildren(current).find((child) => `${child.title ?? ""}`.toLowerCase() === segment.toLowerCase());
        if (!current) {
            return null;
        }
    }
    return current;
}

function resolveNode(op, indexes, warnings, counters) {
    const direct = indexes.byId.get(String(op.id));
    if (direct && direct.url === op.url) {
        return direct;
    }
    const candidates = indexes.byUrl.get(op.url) || [];
    if (candidates.length === 1) {
        counters.matchedByUrl += 1;
        return candidates[0];
    }
    const reason = candidates.length > 1 ? "url-ambiguous" : "url-mismatch";
    warnings.push({ id: String(op.id), reason, title: op.title || "", url: op.url || "" });
    counters.skipped += 1;
    return null;
}

export function validatePlan(value) {
    const errors = [];
    const plan = value && typeof value === "object" ? value : {};
    if (plan.version !== 1) {
        errors.push("Plan version must be 1.");
    }
    if (!Array.isArray(plan.ops) || !plan.ops.length) {
        errors.push("Plan ops must be a non-empty array.");
    }
    const seenIds = new Set();
    for (const [index, op] of (Array.isArray(plan.ops) ? plan.ops : []).entries()) {
        if (!op || !["move", "remove"].includes(op.op)) {
            errors.push(`Op ${index + 1} must be move or remove.`);
        }
        if (!op || typeof op.id !== "string" || !op.id.trim()) {
            errors.push(`Op ${index + 1} must have a non-empty string id.`);
        } else if (seenIds.has(op.id)) {
            errors.push(`Duplicate bookmark id: ${op.id}.`);
        } else {
            seenIds.add(op.id);
        }
        if (op?.op === "move" && !normalizeFolderPath(op.to)) {
            errors.push(`Move ${op.id || index + 1} must have a target path.`);
        }
    }
    if (!Array.isArray(plan.folders) || plan.folders.some((path) => !normalizeFolderPath(path))) {
        errors.push("Plan folders must be an array of non-empty paths.");
    }
    if (plan.hiddenFolders !== undefined && (!Array.isArray(plan.hiddenFolders) || plan.hiddenFolders.some((path) => typeof path !== "string"))) {
        errors.push("Plan hiddenFolders must be an array of strings.");
    }
    return { ok: errors.length === 0, errors, plan };
}

export function resolvePlan(plan, tree, { rootId }) {
    const validation = validatePlan(plan);
    if (!validation.ok) {
        return {
            folderOps: [], moveOps: [], removeOps: [], warnings: [], errors: validation.errors,
            summary: { folderCount: 0, newFolderCount: 0, moves: 0, removes: 0, alreadyInPlace: 0, matchedByUrl: 0, skipped: 0, targets: [], removals: [] }
        };
    }
    const indexes = indexTree(tree);
    const root = indexes.byId.get(String(rootId));
    if (!root) {
        return {
            folderOps: [], moveOps: [], removeOps: [], warnings: [], errors: [`Bookmark root ${rootId} was not found.`],
            summary: { folderCount: 0, newFolderCount: 0, moves: 0, removes: 0, alreadyInPlace: 0, matchedByUrl: 0, skipped: 0, targets: [], removals: [] }
        };
    }

    const requestedPaths = [
        ...plan.folders,
        ...plan.ops.filter((op) => op.op === "move").map((op) => op.to)
    ];
    const paths = addAncestors(requestedPaths);
    const sourceFolder = normalizeFolderPath(plan.sourceFolder || plan.space);
    const source = sourceFolder ? findFolder(root, sourceFolder) : null;
    const folderOps = [];
    const resolvedFolders = new Map([["", String(root.id)]]);

    for (const path of paths) {
        const parentPath = normalizeFolderPath(path.split("/").slice(0, -1).join("/"));
        const title = path.split("/").at(-1);
        let existing = findFolder(root, path);
        let relocate = false;
        if (!existing && source) {
            existing = findFolder(source, path);
            relocate = Boolean(existing && pathDepth(path) === 1);
        }
        const operation = {
            op: existing ? (relocate ? "move" : "reuse") : "create",
            path,
            parentPath,
            title,
            id: existing ? String(existing.id) : null,
            isNew: !existing
        };
        folderOps.push(operation);
        if (existing) {
            resolvedFolders.set(keyPath(path), String(existing.id));
        }
    }

    const warnings = [];
    const counters = { matchedByUrl: 0, alreadyInPlace: 0, skipped: 0 };
    const moveOps = [];
    const removeOps = [];
    const targets = new Map(paths.map((path) => [keyPath(path), { path, moves: 0, isNew: folderOps.find((op) => keyPath(op.path) === keyPath(path))?.isNew || false }]));

    for (const op of plan.ops) {
        let node;
        if (op.op === "remove") {
            const direct = indexes.byId.get(String(op.id));
            if (direct?.url === op.url) {
                node = direct;
            } else if (op.reason !== "duplicate" && (indexes.byUrl.get(op.url) || []).length === 1) {
                node = resolveNode(op, indexes, warnings, counters);
            } else if ((indexes.byUrl.get(op.url) || []).length > 1) {
                warnings.push({ id: String(op.id), reason: "url-ambiguous", title: op.title || "", url: op.url || "" });
                counters.skipped += 1;
                continue;
            } else {
                warnings.push({ id: String(op.id), reason: "already-removed", title: op.title || "", url: op.url || "" });
                counters.skipped += 1;
                continue;
            }
        } else {
            node = resolveNode(op, indexes, warnings, counters);
        }
        if (!node) {
            continue;
        }
        if (!node.url) {
            warnings.push({ id: String(op.id), reason: "not-a-link", title: op.title || node.title || "" });
            counters.skipped += 1;
            continue;
        }
        if (op.op === "move") {
            const targetPath = normalizeFolderPath(op.to);
            const target = targets.get(keyPath(targetPath));
            target.moves += 1;
            const existingTarget = findFolder(root, targetPath);
            if (existingTarget && String(node.parentId) === String(existingTarget.id)) {
                counters.alreadyInPlace += 1;
            }
            moveOps.push({
                op: "move",
                id: String(node.id),
                originalId: String(op.id),
                to: targetPath,
                url: node.url,
                title: op.title || node.title || ""
            });
        } else {
            removeOps.push({
                op: "remove",
                id: String(node.id),
                originalId: String(op.id),
                reason: op.reason || "remove",
                title: op.title || node.title || "",
                url: node.url
            });
        }
    }

    return {
        folderOps,
        moveOps,
        removeOps,
        warnings,
        errors: [],
        sourceId: source ? String(source.id) : null,
        rootId: String(root.id),
        summary: {
            folderCount: folderOps.length,
            newFolderCount: folderOps.filter((op) => op.isNew).length,
            moves: moveOps.length,
            removes: removeOps.length,
            alreadyInPlace: counters.alreadyInPlace,
            matchedByUrl: counters.matchedByUrl,
            skipped: counters.skipped,
            targets: [...targets.values()].filter((target) => target.moves).sort((left, right) => right.moves - left.moves || left.path.localeCompare(right.path)),
            removals: removeOps.map(({ reason, title, url }) => ({ reason, title, url }))
        }
    };
}

export async function applyPlan(resolved, api, onProgress = () => {}) {
    const errors = [];
    const folderIds = new Map([["", String(resolved.rootId)]]);
    const failedFolderPaths = new Set();
    const total = resolved.moveOps.length + resolved.removeOps.length;
    let done = 0;
    let applied = 0;

    for (const operation of resolved.folderOps) {
        try {
            if (operation.parentPath && failedFolderPaths.has(keyPath(operation.parentPath))) {
                throw new Error(`Parent folder ${operation.parentPath} is unavailable.`);
            }
            if (operation.op === "move") {
                const parentId = folderIds.get(keyPath(operation.parentPath)) || resolved.rootId;
                await api.move(operation.id, { parentId: String(parentId) });
                folderIds.set(keyPath(operation.path), operation.id);
            } else if (operation.op === "reuse") {
                folderIds.set(keyPath(operation.path), operation.id);
            } else {
                const parentId = folderIds.get(keyPath(operation.parentPath));
                if (!parentId) {
                    throw new Error(`Parent folder ${operation.parentPath} is unavailable.`);
                }
                const created = await api.create({ parentId: String(parentId), title: operation.title });
                folderIds.set(keyPath(operation.path), String(created.id));
            }
        } catch (error) {
            failedFolderPaths.add(keyPath(operation.path));
            errors.push({ op: operation, message: error.message });
        }
    }

    for (const operation of resolved.moveOps) {
        const parentId = folderIds.get(keyPath(operation.to));
        try {
            if (!parentId) {
                throw new Error(`Target folder ${operation.to} is unavailable.`);
            }
            await api.move(operation.id, { parentId: String(parentId) });
            applied += 1;
        } catch (error) {
            errors.push({ op: operation, message: error.message });
        }
        done += 1;
        onProgress(done, total);
    }

    if (resolved.removeOps.length) {
        try {
            await deleteNodes(resolved.removeOps.map((operation) => operation.id), api, {
                label: `plan · ${resolved.removeOps.length} removed`
            });
            applied += resolved.removeOps.length;
        } catch (error) {
            for (const operation of resolved.removeOps) {
                errors.push({ op: operation, message: error.message });
            }
        }
        done += resolved.removeOps.length;
        onProgress(done, total);
    }

    return { applied, failed: total - applied, errors };
}
