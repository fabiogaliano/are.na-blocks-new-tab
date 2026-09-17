// Editing happens on a clone of the pinned/main/archive surfaces, which are three
// reads of one folder tree: a pinned folder can also sit inside a browsable
// column, so every walk dedupes by object identity and edits that folder once.
function surfaceLists(surfaces) {
    return [surfaces?.pinned, surfaces?.main, surfaces?.archive].filter(Boolean);
}

export function walkSurfaceNodes(surfaces, visit) {
    const seen = new Set();
    const walk = (node) => {
        if (!node || seen.has(node)) {
            return;
        }
        seen.add(node);
        visit(node);
        for (const child of node.children || []) {
            walk(child);
        }
    };
    for (const list of surfaceLists(surfaces)) {
        for (const node of list) {
            walk(node);
        }
    }
}

export function findSurfaceNode(surfaces, id) {
    let found = null;
    walkSurfaceNodes(surfaces, (node) => {
        if (!found && String(node.id) === String(id)) {
            found = node;
        }
    });
    return found;
}

export function findSurfaceLink(surfaces, id) {
    let found = null;
    walkSurfaceNodes(surfaces, (node) => {
        if (found) {
            return;
        }
        const link = (node.links || []).find((candidate) => String(candidate.id) === String(id));
        if (link) {
            found = { link, parent: node };
        }
    });
    return found;
}

export function removeSurfaceLink(surfaces, id) {
    walkSurfaceNodes(surfaces, (node) => {
        node.links = (node.links || []).filter((candidate) => String(candidate.id) !== String(id));
    });
}

export function insertSurfaceLink(node, link, index) {
    node.links = node.links || [];
    const position = Number.isInteger(index) ? Math.max(0, Math.min(index, node.links.length)) : node.links.length;
    node.links.splice(position, 0, link);
    link.parentId = String(node.id);
    link.path = node.path;
    node.links.forEach((candidate, order) => { candidate.index = order; });
    return position;
}

// A pending folder is keyed by its temporary id so the column browser, which
// tracks the selected path by string, cannot confuse two folders called the same.
export function createSurfaceFolder(parent, { id, title }) {
    const folder = {
        id,
        title,
        path: parent.path ? `${parent.path}/${id}` : String(id),
        links: [],
        children: [],
        count: 0,
        isNewFolder: true
    };
    parent.children = parent.children || [];
    parent.children.push(folder);
    return folder;
}

export function recountSurfaces(surfaces) {
    const recount = (node) => {
        const childCount = (node.children || []).reduce((total, child) => total + recount(child), 0);
        node.count = (node.links || []).length + childCount;
        return node.count;
    };
    for (const list of surfaceLists(surfaces)) {
        for (const node of list) {
            recount(node);
        }
    }
    return surfaces;
}
