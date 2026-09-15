import { describe, expect, it } from "vitest";
import { bookmarkTree } from "./fixtures/bookmark-tree.js";
import { buildSurfaces } from "../extension/scripts/bookmarks-model.js";

const paths = (nodes) => nodes.map((node) => node.path);

describe("board surfaces", () => {
    it("resolves pinned and main folders by path, including nested ones", () => {
        const surfaces = buildSurfaces(bookmarkTree, {
            pinnedFolders: ["Design/Inspiration"],
            mainFolders: ["design", "space/inside"]
        });
        expect(paths(surfaces.pinned)).toEqual(["Design/Inspiration"]);
        expect(paths(surfaces.main)).toEqual(["Design", "Space/Inside"]);
    });

    it("sends unclaimed top-level folders to the archive", () => {
        const surfaces = buildSurfaces(bookmarkTree, { mainFolders: ["design"] });
        expect(paths(surfaces.archive)).toContain("Archive");
        expect(paths(surfaces.archive)).toContain("Launch");
        expect(paths(surfaces.archive)).not.toContain("Design");
    });

    it("keeps a parent off the archive when only a descendant is claimed", () => {
        const surfaces = buildSurfaces(bookmarkTree, { mainFolders: ["space/inside"] });
        expect(paths(surfaces.archive)).not.toContain("Space");
    });

    it("counts links through descendants and drops hidden branches", () => {
        const surfaces = buildSurfaces(bookmarkTree, { hiddenFolders: ["archive"], mainFolders: ["design"] });
        expect(surfaces.main[0].count).toBe(3);
        expect(paths(surfaces.archive)).not.toContain("Archive");
    });

    it("ignores folder paths that do not exist", () => {
        const surfaces = buildSurfaces(bookmarkTree, { pinnedFolders: ["nope/missing"], mainFolders: ["design"] });
        expect(surfaces.pinned).toEqual([]);
        expect(paths(surfaces.main)).toEqual(["Design"]);
    });

    it("returns empty surfaces when the root path is missing", () => {
        expect(buildSurfaces(bookmarkTree, { rootPath: "nope" })).toEqual({ pinned: [], main: [], archive: [] });
    });
});
