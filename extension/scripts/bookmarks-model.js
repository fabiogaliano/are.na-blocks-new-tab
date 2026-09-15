const displayFolderTitle = (title) => title && title !== "null" ? title : "(untitled)";

export function normalizePath(value) {
    return `${value ?? ""}`.split("/").map((segment) => segment.trim()).filter(Boolean).join("/");
}

export function isHiddenPath(path, hiddenFolders = []) {
    const candidate = normalizePath(path).toLowerCase();
    return hiddenFolders.some((hidden) => {
        const prefix = normalizePath(hidden).toLowerCase();
        return prefix && (candidate === prefix || candidate.startsWith(`${prefix}/`));
    });
}

export function linkHost(url) {
    try {
        return new URL(url).host.replace(/^www\./i, "");
    } catch {
        return "";
    }
}

function findBar(tree) {
    const root = tree?.[0];
    return root?.children?.find((node) => String(node.id) === "1")
        || root?.children?.find((node) => /bookmark/i.test(node.title || ""))
        || root?.children?.[0]
        || null;
}

export function resolveRoot(tree, rootPath = "") {
    let current = findBar(tree);
    if (!current) {
        return null;
    }
    for (const segment of normalizePath(rootPath).split("/").filter(Boolean)) {
        current = (current.children || []).find((node) => !node.url && `${node.title || ""}`.toLowerCase() === segment.toLowerCase());
        if (!current) {
            return null;
        }
    }
    return current;
}

function makeLink(node, path) {
    const title = `${node.title || ""}`.trim();
    return {
        id: String(node.id),
        parentId: String(node.parentId ?? ""),
        title: title || linkHost(node.url) || node.url,
        url: node.url,
        host: linkHost(node.url),
        dateAdded: Number(node.dateAdded || 0),
        path,
        index: Number.isInteger(node.index) ? node.index : 0
    };
}

function collectGroups(folder, currentPath, relativeTitles, hiddenFolders, groups, flatLinks) {
    for (const child of folder.children || []) {
        if (child.type === "separator" || child.url) {
            continue;
        }
        const rawTitle = child.title ?? "";
        const path = `${currentPath}/${rawTitle}`;
        if (isHiddenPath(path, hiddenFolders)) {
            continue;
        }
        const titles = [...relativeTitles, displayFolderTitle(rawTitle)];
        const links = (child.children || [])
            .filter((node) => node.url && node.type !== "separator")
            .map((node) => makeLink(node, path));
        flatLinks.push(...links);
        if (links.length) {
            groups.push({
                id: String(child.id),
                title: titles.join(" / "),
                path,
                count: links.length,
                links
            });
        }
        collectGroups(child, path, titles, hiddenFolders, groups, flatLinks);
    }
}

function emptyModel(rootPath, error) {
    return {
        rootId: null,
        rootTitle: normalizePath(rootPath).split("/").at(-1) || "",
        rootPath: normalizePath(rootPath),
        cards: [],
        launchLinks: [],
        links: [],
        linkCount: 0,
        ...(error ? { error } : {})
    };
}

export function buildBoard(tree, { rootPath = "", hiddenFolders = [], launchFolder = "launch" } = {}) {
    const root = resolveRoot(tree, rootPath);
    if (!root) {
        return emptyModel(rootPath, "root-missing");
    }
    const cards = [];
    const links = [];
    const rootPathLabel = "";
    const rootFolders = (root.children || []).filter((node) => !node.url && node.type !== "separator");
    const looseLinks = (root.children || [])
        .filter((node) => node.url && node.type !== "separator")
        .map((node) => makeLink(node, rootPathLabel));
    if (looseLinks.length) {
        cards.push({
            id: String(root.id),
            title: displayFolderTitle(root.title) || "bar",
            path: "",
            count: looseLinks.length,
            links: looseLinks,
            groups: [],
            isRoot: true
        });
        links.push(...looseLinks);
    }

    for (const folder of root.children || []) {
        if (folder.type === "separator" || folder.url) {
            continue;
        }
        const path = normalizePath(folder.title ?? "");
        if (isHiddenPath(path, hiddenFolders)) {
            continue;
        }
        const directLinks = (folder.children || [])
            .filter((node) => node.url && node.type !== "separator")
            .map((node) => makeLink(node, path));
        const groups = [];
        const descendantLinks = [];
        collectGroups(folder, path, [], hiddenFolders, groups, descendantLinks);
        const count = directLinks.length + descendantLinks.length;
        if (!count) {
            continue;
        }
        cards.push({
            id: String(folder.id),
            title: displayFolderTitle(folder.title),
            path,
            count,
            links: directLinks,
            groups
        });
        links.push(...directLinks, ...descendantLinks);
    }

    const launchPath = normalizePath(launchFolder).toLowerCase();
    const launchLinks = launchPath
        ? links.filter((link) => link.path.toLowerCase() === launchPath)
        : [];
    return {
        rootId: String(root.id),
        rootTitle: displayFolderTitle(root.title),
        rootPath: normalizePath(rootPath),
        cards,
        launchLinks,
        links,
        linkCount: links.length,
        folderCount: cards.filter((card) => !card.isRoot).length + cards.reduce((total, card) => total + card.groups.length, 0),
        emptyReason: !links.length && rootFolders.length && rootFolders.every((folder) => isHiddenPath(normalizePath(folder.title ?? ""), hiddenFolders))
            ? "all-hidden"
            : !links.length ? "empty" : null
    };
}

export function computeNewIds({ links = [], lastViewedAt = 0, knownNewIds = [] }) {
    const present = new Set(links.map((link) => String(link.id)));
    const accumulated = new Set((knownNewIds || []).map(String).filter((id) => present.has(id)));
    for (const link of links) {
        if (Number(link.dateAdded || 0) > Number(lastViewedAt || 0)) {
            accumulated.add(String(link.id));
        }
    }
    return [...accumulated];
}
