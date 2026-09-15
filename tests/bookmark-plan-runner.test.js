import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolvePlan, validatePlan } from "../extension/scripts/bookmark-plan-runner.js";

const folder = (id, title, children = []) => ({ id, title, children });
const link = (id, title, url, parentId = "12") => ({ id, parentId, title, url });
const validPlan = (overrides = {}) => ({
    version: 1,
    folders: ["design/icons"],
    hiddenFolders: ["archive"],
    ops: [{ op: "move", id: "l1", to: "design/icons", title: "One", url: "https://one.test" }],
    ...overrides
});

function treeWith(children) {
    return [folder("0", "root", [folder("1", "Bookmarks bar", children)])];
}

describe("validatePlan", () => {
    it("accepts a valid plan", () => expect(validatePlan(validPlan()).ok).toBe(true));

    it.each([
        [{ version: 2 }, "version"],
        [{ ops: [] }, "non-empty"],
        [{ ops: [{ op: "copy", id: "x" }] }, "move or remove"],
        [{ ops: [{ op: "remove", id: 1 }] }, "string id"],
        [{ ops: [{ op: "move", id: "x", to: "///" }] }, "target path"],
        [{ ops: [{ op: "remove", id: "x" }, { op: "remove", id: "x" }] }, "Duplicate"],
        [{ folders: [""] }, "folders"],
        [{ hiddenFolders: "archive" }, "hiddenFolders"]
    ])("rejects invalid plan data", (override, message) => {
        const result = validatePlan(validPlan(override));
        expect(result.ok).toBe(false);
        expect(result.errors.join(" ")).toContain(message);
    });
});

describe("resolvePlan", () => {
    it("deduplicates folders, expands ancestors and reuses names case-insensitively", () => {
        const tree = treeWith([folder("d", "Design", [folder("i", "Icons")]), link("l1", "One", "https://one.test", "i")]);
        const resolved = resolvePlan(validPlan({ folders: ["design/icons", "design/icons", "design/type"] }), tree, { rootId: "1" });
        expect(resolved.folderOps.map((op) => op.path)).toEqual(["design", "design/icons", "design/type"]);
        expect(resolved.folderOps.slice(0, 2).every((op) => !op.isNew)).toBe(true);
        expect(resolved.folderOps[2].parentPath).toBe("design");
        expect(resolved.summary.alreadyInPlace).toBe(1);
    });

    it("warns for folders, mismatches and ambiguous URL fallbacks", () => {
        const tree = treeWith([
            folder("folder-id", "A"),
            link("stale", "Wrong", "https://wrong.test", "1"),
            link("a", "A", "https://duplicate.test", "1"),
            link("b", "B", "https://duplicate.test", "1")
        ]);
        const plan = validPlan({
            folders: ["target"],
            ops: [
                { op: "move", id: "folder-id", to: "target" },
                { op: "move", id: "stale", to: "target", url: "https://missing.test" },
                { op: "move", id: "missing", to: "target", url: "https://duplicate.test" }
            ]
        });
        const resolved = resolvePlan(plan, tree, { rootId: "1" });
        expect(resolved.warnings.map((warning) => warning.reason)).toEqual(["not-a-link", "url-mismatch", "url-ambiguous"]);
        expect(resolved.summary.skipped).toBe(3);
    });

    it("does not delete a duplicate's surviving copy when a plan is rerun", () => {
        const tree = treeWith([link("keeper", "Kept", "https://duplicate.test", "1")]);
        const plan = validPlan({
            folders: ["target"],
            ops: [{ op: "remove", id: "gone", title: "Duplicate", url: "https://duplicate.test", reason: "duplicate" }]
        });
        const resolved = resolvePlan(plan, tree, { rootId: "1" });
        expect(resolved.removeOps).toEqual([]);
        expect(resolved.warnings[0].reason).toBe("already-removed");
    });

    it("falls back to one URL match and keeps removes after moves", () => {
        const tree = treeWith([link("actual", "One", "https://one.test", "1"), link("remove", "Old", "https://old.test", "1")]);
        const plan = validPlan({
            folders: ["target"],
            ops: [
                { op: "move", id: "stale", to: "target", title: "One", url: "https://one.test" },
                { op: "remove", id: "remove", title: "Old", url: "https://old.test", reason: "duplicate" }
            ]
        });
        const resolved = resolvePlan(plan, tree, { rootId: "1" });
        expect(resolved.moveOps[0].id).toBe("actual");
        expect(resolved.summary.matchedByUrl).toBe(1);
        expect(resolved.removeOps).toHaveLength(1);
    });

    it("resolves the real 228-op fixture with the locked preview totals", async () => {
        const plan = JSON.parse(await readFile(new URL("../docs/tmp/bookmark-plan-knowledge-exploration.json", import.meta.url), "utf8"));
        const seeded = folder("12", plan.sourceFolder, [
            folder("existing-design", "design", [folder("existing-icons", "icons")]),
            folder("existing-dev", "dev"),
            folder("existing-learning", "learning"),
            folder("existing-tana", "tana"),
            ...plan.ops.map((op) => link(op.id, op.title, op.url, "12"))
        ]);
        const resolved = resolvePlan(plan, treeWith([seeded]), { rootId: "1" });
        expect(resolved.errors).toEqual([]);
        expect(resolved.warnings).toEqual([]);
        expect(resolved.moveOps).toHaveLength(217);
        expect(resolved.removeOps).toHaveLength(11);
        expect(resolved.summary).toMatchObject({ folderCount: 26, newFolderCount: 21, skipped: 0 });
        expect(resolved.summary.targets.slice(0, 3).map(({ path, moves }) => [path, moves])).toEqual([
            ["archive/myhalo", 38],
            ["design/icons", 21],
            ["dev/hearted", 19]
        ]);
    });
});
