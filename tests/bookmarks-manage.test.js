import { describe, expect, it } from "vitest";
import { applyQueue, describeQueue, queueOp, reduceQueue } from "../extension/scripts/bookmarks-manage.js";

describe("bookmark manage queue", () => {
    it("queues without mutating the source", () => {
        const source = [];
        expect(queueOp(source, { op: "remove", id: "a" })).toEqual([{ op: "remove", id: "a" }]);
        expect(source).toEqual([]);
    });

    it("cancels create then remove and dependent creates", () => {
        const reduced = reduceQueue([
            { op: "create", tempId: "temp-a", parentId: "root", title: "A" },
            { op: "create", tempId: "temp-b", parentId: "temp-a", title: "B" },
            { op: "update", id: "temp-a", title: "Renamed" },
            { op: "remove", id: "temp-a" }
        ]);
        expect(reduced).toEqual([]);
    });

    it("merges repeated updates and keeps the final move", () => {
        const reduced = reduceQueue([
            { op: "update", id: "a", title: "First" },
            { op: "move", id: "a", parentId: "one", index: 1 },
            { op: "update", id: "a", url: "https://new.test" },
            { op: "move", id: "a", parentId: "two", index: 4 }
        ]);
        expect(reduced).toEqual([
            { op: "update", id: "a", title: "First", url: "https://new.test" },
            { op: "move", id: "a", parentId: "two", index: 4 }
        ]);
    });

    it("drops updates and moves for removed nodes", () => {
        expect(reduceQueue([
            { op: "update", id: "a", title: "Changed" },
            { op: "move", id: "a", parentId: "two", index: 0 },
            { op: "remove", id: "a" }
        ])).toEqual([{ op: "remove", id: "a" }]);
    });

    it("orders parents before children, then update, move and remove", () => {
        const reduced = reduceQueue([
            { op: "move", id: "link", parentId: "temp-child", index: 0 },
            { op: "create", tempId: "temp-child", parentId: "temp-parent", title: "Child" },
            { op: "remove", id: "old" },
            { op: "update", id: "link", title: "Link" },
            { op: "create", tempId: "temp-parent", parentId: "root", title: "Parent" }
        ]);
        expect(reduced.map((op) => op.op)).toEqual(["create", "create", "update", "move", "remove"]);
        expect(reduced.slice(0, 2).map((op) => op.tempId)).toEqual(["temp-parent", "temp-child"]);
    });

    it("stops on the first apply failure", async () => {
        const calls = [];
        const api = {
            async update(id) {
                calls.push(id);
                if (id === "b") throw new Error("failed b");
            }
        };
        const result = await applyQueue([
            { op: "update", id: "a", title: "A" },
            { op: "update", id: "b", title: "B" },
            { op: "update", id: "c", title: "C" }
        ], api);
        expect(calls).toEqual(["a", "b"]);
        expect(result).toMatchObject({ applied: 1, failed: 2, total: 3 });
    });

    it("describes reduced changes", () => {
        expect(describeQueue([])).toBe("0 changes");
        expect(describeQueue([{ op: "remove", id: "a" }])).toBe("1 change");
    });
});
