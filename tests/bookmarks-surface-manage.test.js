import { describe, expect, it } from "vitest";
import {
    createSurfaceFolder,
    findSurfaceLink,
    findSurfaceNode,
    insertSurfaceLink,
    recountSurfaces,
    removeSurfaceLink,
    walkSurfaceNodes
} from "../extension/scripts/bookmarks-surface-manage.js";

const link = (id, path) => ({ id, parentId: path, title: id, url: `https://${id}.test`, path, index: 0 });

function surfaces() {
    const daily = { id: "11", title: "daily", path: "reading/daily", links: [link("a", "reading/daily"), link("b", "reading/daily")], children: [], count: 2 };
    const reading = { id: "10", title: "reading", path: "reading", links: [link("c", "reading")], children: [daily], count: 3 };
    const dev = { id: "20", title: "dev", path: "dev", links: [link("d", "dev")], children: [], count: 1 };
    // The pinned folder is the same object the columns browse, exactly as structuredClone leaves it.
    return { pinned: [daily], main: [reading], archive: [dev] };
}

describe("surface manage tree", () => {
    it("visits every folder once even when a surface shares it", () => {
        const visited = [];
        walkSurfaceNodes(surfaces(), (node) => visited.push(node.id));
        expect(visited).toEqual(["11", "10", "20"]);
    });

    it("finds folders and links anywhere in the surfaces", () => {
        const tree = surfaces();
        expect(findSurfaceNode(tree, "20").title).toBe("dev");
        expect(findSurfaceNode(tree, "nope")).toBeNull();
        expect(findSurfaceLink(tree, "c").parent.id).toBe("10");
        expect(findSurfaceLink(tree, "missing")).toBeNull();
    });

    it("moves a link between folders once for every surface holding it", () => {
        const tree = surfaces();
        const found = findSurfaceLink(tree, "a");
        removeSurfaceLink(tree, "a");
        expect(tree.pinned[0].links.map((item) => item.id)).toEqual(["b"]);
        expect(tree.main[0].children[0].links.map((item) => item.id)).toEqual(["b"]);
        const index = insertSurfaceLink(findSurfaceNode(tree, "20"), found.link, 0);
        expect(index).toBe(0);
        expect(tree.archive[0].links.map((item) => item.id)).toEqual(["a", "d"]);
        expect(found.link.parentId).toBe("20");
        expect(found.link.path).toBe("dev");
    });

    it("appends when the drop has no index and clamps one past the end", () => {
        const tree = surfaces();
        const target = findSurfaceNode(tree, "20");
        expect(insertSurfaceLink(target, link("e", ""), null)).toBe(1);
        expect(insertSurfaceLink(target, link("f", ""), 99)).toBe(2);
        expect(target.links.map((item) => item.id)).toEqual(["d", "e", "f"]);
    });

    it("keys a pending folder by its temporary id so siblings cannot collide", () => {
        const tree = surfaces();
        const parent = findSurfaceNode(tree, "10");
        const folder = createSurfaceFolder(parent, { id: "temp-1", title: "new folder" });
        expect(folder.path).toBe("reading/temp-1");
        expect(parent.children.at(-1)).toBe(folder);
        expect(createSurfaceFolder(parent, { id: "temp-2", title: "new folder" }).path).not.toBe(folder.path);
    });

    it("recounts a folder from its own links plus its descendants", () => {
        const tree = surfaces();
        removeSurfaceLink(tree, "a");
        createSurfaceFolder(findSurfaceNode(tree, "20"), { id: "temp-1", title: "new folder" });
        recountSurfaces(tree);
        expect(findSurfaceNode(tree, "11").count).toBe(1);
        expect(findSurfaceNode(tree, "10").count).toBe(2);
        expect(findSurfaceNode(tree, "20").count).toBe(1);
    });
});
