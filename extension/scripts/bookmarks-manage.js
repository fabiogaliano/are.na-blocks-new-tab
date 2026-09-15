import { deleteNodes } from "./bookmarks-trash.js";

export function queueOp(queue, op) {
    return [...(queue || []), { ...op }];
}

function orderCreates(creates) {
    const pending = [...creates];
    const ordered = [];
    const ids = new Set(creates.map((op) => op.tempId));
    while (pending.length) {
        const index = pending.findIndex((op) => !ids.has(op.parentId) || ordered.some((parent) => parent.tempId === op.parentId));
        if (index < 0) {
            ordered.push(...pending);
            break;
        }
        ordered.push(pending.splice(index, 1)[0]);
    }
    return ordered;
}

export function reduceQueue(queue) {
    const operations = queue || [];
    const creates = new Map();
    for (const op of operations) {
        if (op.op === "create") {
            creates.set(String(op.tempId), { ...op, tempId: String(op.tempId), parentId: String(op.parentId) });
        }
    }
    const cancelled = new Set();
    for (const op of operations) {
        if (op.op === "remove" && creates.has(String(op.id))) {
            cancelled.add(String(op.id));
        }
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const create of creates.values()) {
            if (!cancelled.has(create.tempId) && cancelled.has(String(create.parentId))) {
                cancelled.add(create.tempId);
                changed = true;
            }
        }
    }

    const removed = new Set(operations.filter((op) => op.op === "remove" && !creates.has(String(op.id))).map((op) => String(op.id)));
    const updates = new Map();
    const moves = new Map();
    const removes = new Map();
    for (const op of operations) {
        const id = String(op.id ?? op.tempId ?? "");
        if (!id || cancelled.has(id)) {
            continue;
        }
        if (op.op === "update" && !removed.has(id)) {
            updates.set(id, { ...(updates.get(id) || { op: "update", id }), ...op, id });
        } else if (op.op === "move" && !removed.has(id)) {
            moves.set(id, { ...op, id, parentId: String(op.parentId) });
        } else if (op.op === "remove" && removed.has(id)) {
            removes.set(id, { op: "remove", id });
        }
    }

    return [
        ...orderCreates([...creates.values()].filter((op) => !cancelled.has(op.tempId))),
        ...updates.values(),
        ...moves.values(),
        ...removes.values()
    ];
}

export function describeQueue(ops) {
    const count = reduceQueue(ops).length;
    return `${count} change${count === 1 ? "" : "s"}`;
}

function resolveId(id, tempIds) {
    return tempIds.get(String(id)) || String(id);
}

export async function applyQueue(queue, api, onProgress = () => {}) {
    const operations = reduceQueue(queue);
    const tempIds = new Map();
    const errors = [];
    let applied = 0;
    let trashEntry = null;
    for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index];
        try {
            if (operation.op === "create") {
                const created = await api.create({
                    parentId: resolveId(operation.parentId, tempIds),
                    title: operation.title
                });
                tempIds.set(operation.tempId, String(created.id));
            } else if (operation.op === "update") {
                const changes = {};
                if (operation.title !== undefined) {
                    changes.title = operation.title;
                }
                if (operation.url !== undefined) {
                    changes.url = operation.url;
                }
                await api.update(resolveId(operation.id, tempIds), changes);
            } else if (operation.op === "move") {
                await api.move(resolveId(operation.id, tempIds), {
                    parentId: resolveId(operation.parentId, tempIds),
                    index: operation.index
                });
            } else if (operation.op === "remove") {
                const consecutive = [];
                let cursor = index;
                while (operations[cursor]?.op === "remove") {
                    consecutive.push(operations[cursor]);
                    cursor += 1;
                }
                trashEntry = await deleteNodes(consecutive.map((item) => resolveId(item.id, tempIds)), api, {
                    label: `manage · ${consecutive.length} removed`
                });
                applied += consecutive.length;
                index = cursor - 1;
                onProgress(applied, operations.length);
                continue;
            }
            applied += 1;
            onProgress(applied, operations.length);
        } catch (error) {
            errors.push({ op: operation, message: error.message });
            break;
        }
    }
    return {
        applied,
        failed: errors.length ? operations.length - applied : 0,
        total: operations.length,
        errors,
        tempIds,
        trashEntry
    };
}
