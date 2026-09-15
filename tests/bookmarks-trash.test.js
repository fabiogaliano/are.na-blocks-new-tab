import { describe, expect, it } from "vitest";
import { pruneTrash, restoreEntry, snapshotSubtree } from "../extension/scripts/bookmarks-trash.js";

const memoryStorage = (initial = {}) => {
    const data = { ...initial };
    return {
        data,
        async get(key) { return { [key]: data[key] }; },
        async set(value) { Object.assign(data, value); }
    };
};

describe("bookmark trash", () => {
    it("snapshots a subtree recursively", () => {
        const snapshot = snapshotSubtree({
            id: "f", parentId: "1", index: 2, title: "Folder",
            children: [{ id: "l", parentId: "f", index: 0, title: "Link", url: "https://one.test" }]
        }, "Work");
        expect(snapshot).toEqual({
            title: "Folder", parentId: "1", parentPath: "Work", index: 2,
            children: [{ title: "Link", url: "https://one.test", parentId: "f", parentPath: "Work/Folder", index: 0 }]
        });
    });

    it("prunes oldest entries", () => {
        const entries = Array.from({ length: 205 }, (_, index) => ({ id: String(index), deletedAt: index }));
        const pruned = pruneTrash(entries, 200);
        expect(pruned).toHaveLength(200);
        expect(pruned[0].id).toBe("204");
        expect(pruned.at(-1).id).toBe("5");
    });

    it("restores recursively and falls back to the root for an orphan", async () => {
        const calls = [];
        let id = 20;
        const api = {
            async get(parentId) { return parentId === "gone" ? [] : [{ id: parentId }]; },
            async create(details) { calls.push(details); return { id: String(id++) }; }
        };
        const entry = {
            id: "trash-1",
            nodes: [{
                title: "Folder", parentId: "gone", parentPath: "Old", index: 1,
                children: [{ title: "Link", url: "https://one.test", parentId: "old", parentPath: "Old/Folder", index: 0 }]
            }]
        };
        const storage = memoryStorage({ bookmarkTrash: { entries: [entry] } });
        const result = await restoreEntry(entry, api, { rootId: "1", storage });
        expect(result).toEqual({ created: ["20", "21"], orphaned: 1 });
        expect(calls[0]).toMatchObject({ parentId: "1", title: "Folder", index: 1 });
        expect(calls[1]).toMatchObject({ parentId: "20", title: "Link", url: "https://one.test" });
        expect(storage.data.bookmarkTrash.entries).toEqual([]);
    });
});
