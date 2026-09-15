import { describe, expect, it } from "vitest";
import { bookmarkTree } from "./fixtures/bookmark-tree.js";
import { buildBoard, isHiddenPath, linkHost, normalizePath, resolveRoot } from "../extension/scripts/bookmarks-model.js";

describe("bookmarks model", () => {
    it("resolves the bar, a case-insensitive path and a missing path", () => {
        expect(resolveRoot(bookmarkTree, "").id).toBe("1");
        expect(resolveRoot(bookmarkTree, "space/INSIDE").id).toBe("space-child");
        expect(resolveRoot(bookmarkTree, "missing")).toBeNull();
    });

    it("normalizes paths and hosts", () => {
        expect(normalizePath(" / Design // Icons / ")).toBe("Design/Icons");
        expect(linkHost("https://www.example.test/path")).toBe("example.test");
        expect(linkHost("not a url")).toBe("");
    });

    it("matches hidden paths exactly, by prefix and without case", () => {
        expect(isHiddenPath("Archive", ["archive"])).toBe(true);
        expect(isHiddenPath("ARCHIVE/deep", ["archive"])).toBe(true);
        expect(isHiddenPath("archive-old", ["archive"])).toBe(false);
    });

    it("builds a root card, flattens deep groups and labels untitled folders", () => {
        const board = buildBoard(bookmarkTree, { hiddenFolders: ["archive"], launchFolder: "launch" });
        expect(board.cards[0]).toMatchObject({ id: "1", isRoot: true, count: 1 });
        const design = board.cards.find((card) => card.id === "design");
        expect(design.groups.map((group) => group.title)).toEqual(["Inspiration", "Typography / (untitled)"]);
        expect(design.groups.map((group) => group.count)).toEqual([1, 1]);
        expect(design.count).toBe(3);
    });

    it("excludes hidden descendants and separators from every count", () => {
        const board = buildBoard(bookmarkTree, { hiddenFolders: ["ARCHIVE"] });
        expect(board.cards.some((card) => card.id === "archive")).toBe(false);
        expect(board.links.some((link) => link.id.startsWith("archived"))).toBe(false);
        expect(board.links.some((link) => link.id.includes("separator"))).toBe(false);
        expect(board.linkCount).toBe(6);
    });

    it("keeps the launch folder on the board and exposes its links", () => {
        const board = buildBoard(bookmarkTree, { hiddenFolders: ["archive"], launchFolder: "Launch" });
        expect(board.cards.some((card) => card.id === "launch")).toBe(true);
        expect(board.launchLinks.map((link) => link.id)).toEqual(["launch-one"]);
    });

    it("skips empty cards and groups", () => {
        const board = buildBoard(bookmarkTree, { hiddenFolders: ["archive"] });
        expect(board.cards.some((card) => card.id === "empty")).toBe(false);
        expect(board.cards.find((card) => card.id === "design").groups.some((group) => group.id === "empty-child")).toBe(false);
    });

    it("returns a root-missing model", () => {
        expect(buildBoard(bookmarkTree, { rootPath: "gone" })).toMatchObject({ error: "root-missing", rootPath: "gone", cards: [], links: [] });
    });
});
