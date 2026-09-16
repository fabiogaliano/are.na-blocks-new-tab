import { describe, expect, it } from "vitest";
import {
    listEntryLinks,
    pruneEntryToPaths,
    pruneTrash,
    removePathsFromEntry,
    restoreEntry,
    restoreSelection,
    snapshotSubtree
} from "../extension/scripts/bookmarks-trash.js";

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

// A batch delete of a loose link plus a folder holding two more.
const batchEntry = () => ({
    id: "trash-1",
    label: "manage · 3 removed",
    deletedAt: 1000,
    nodes: [
        { title: "Loose", url: "https://loose.test", parentId: "1", parentPath: "", index: 0 },
        {
            title: "daily", parentId: "gone", parentPath: "reading", index: 1,
            children: [
                { title: "Alpha", url: "https://alpha.test", parentId: "f", parentPath: "reading/daily", index: 0 },
                { title: "Beta", url: "https://beta.test", parentId: "f", parentPath: "reading/daily", index: 1 }
            ]
        }
    ]
});

describe("picking links out of a trash entry", () => {
    it("flattens every link with an addressable path and its folder", () => {
        expect(listEntryLinks(batchEntry())).toEqual([
            { path: "0", title: "Loose", folderPath: "", url: "https://loose.test" },
            { path: "1.0", title: "Alpha", folderPath: "reading/daily", url: "https://alpha.test" },
            { path: "1.1", title: "Beta", folderPath: "reading/daily", url: "https://beta.test" }
        ]);
    });

    it("falls back to the url when a link has no title", () => {
        const entry = { nodes: [{ title: "", url: "https://bare.test", parentPath: "", index: 0 }] };
        expect(listEntryLinks(entry)[0].title).toBe("https://bare.test");
    });

    it("keeps the ancestor folder when a nested link is selected", () => {
        const pruned = pruneEntryToPaths(batchEntry(), ["1.0"]);
        expect(pruned.nodes).toEqual([{
            title: "daily", parentId: "gone", parentPath: "reading", index: 1,
            children: [{ title: "Alpha", url: "https://alpha.test", parentId: "f", parentPath: "reading/daily", index: 0 }]
        }]);
    });

    it("drops a folder none of whose links were selected", () => {
        expect(pruneEntryToPaths(batchEntry(), ["0"]).nodes).toEqual([
            { title: "Loose", url: "https://loose.test", parentId: "1", parentPath: "", index: 0 }
        ]);
    });

    it("leaves the unselected links behind in the trash", () => {
        const remainder = removePathsFromEntry(batchEntry(), ["1.0"]);
        expect(listEntryLinks(remainder).map((link) => link.url)).toEqual([
            "https://loose.test",
            "https://beta.test"
        ]);
        expect(remainder.label).toBe("manage · 2 left");
    });

    it("returns null once every link has been taken out", () => {
        expect(removePathsFromEntry(batchEntry(), ["0", "1.0", "1.1"])).toBeNull();
    });

    it("restores only the selection and keeps the rest of the entry", async () => {
        const calls = [];
        let id = 30;
        const api = {
            async get(parentId) { return parentId === "gone" ? [] : [{ id: parentId }]; },
            async create(details) { calls.push(details); return { id: String(id++) }; }
        };
        const entry = batchEntry();
        const storage = memoryStorage({ bookmarkTrash: { entries: [entry] } });

        const result = await restoreSelection(entry, ["1.1"], api, { rootId: "1", storage });

        // The folder was deleted too, so it comes back at the board root first.
        expect(calls).toEqual([
            { parentId: "1", index: 1, title: "daily" },
            { parentId: "30", index: 1, title: "Beta", url: "https://beta.test" }
        ]);
        expect(result).toEqual({ created: ["30", "31"], orphaned: 1 });

        const [remaining] = storage.data.bookmarkTrash.entries;
        expect(listEntryLinks(remaining).map((link) => link.url)).toEqual([
            "https://loose.test",
            "https://alpha.test"
        ]);
    });

    it("drops the entry from the trash when the selection empties it", async () => {
        let id = 40;
        const api = {
            async get() { return [{ id: "1" }]; },
            async create() { return { id: String(id++) }; }
        };
        const entry = batchEntry();
        const storage = memoryStorage({ bookmarkTrash: { entries: [entry] } });

        await restoreSelection(entry, ["0", "1.0", "1.1"], api, { rootId: "1", storage });

        expect(storage.data.bookmarkTrash.entries).toEqual([]);
    });

    it("does nothing when the selection matches no link", async () => {
        const api = { async get() { throw new Error("should not be called"); }, async create() { throw new Error("should not be called"); } };
        const entry = batchEntry();
        const storage = memoryStorage({ bookmarkTrash: { entries: [entry] } });

        expect(await restoreSelection(entry, [], api, { storage })).toEqual({ created: [], orphaned: 0 });
        expect(storage.data.bookmarkTrash.entries).toHaveLength(1);
    });
});
