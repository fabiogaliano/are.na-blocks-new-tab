const link = (id, parentId, title, url, dateAdded = 0, index = 0) => ({ id, parentId, title, url, dateAdded, index });
const folder = (id, parentId, title, children = [], index = 0) => ({ id, parentId, title, children, index });

export const bookmarkTree = [folder("0", null, "root", [
    folder("1", "0", "Bookmarks bar", [
        link("loose", "1", "Loose", "https://loose.test", 10),
        { id: "separator", parentId: "1", type: "separator" },
        folder("space", "1", "Space", [
            folder("space-child", "space", "Inside", [link("inside", "space-child", "Inside link", "https://inside.test")])
        ]),
        folder("design", "1", "Design", [
            link("direct", "design", "Direct", "https://www.direct.test/path", 20),
            folder("inspiration", "design", "Inspiration", [link("inspired", "inspiration", "Inspired", "https://inspired.test", 30)]),
            folder("typography", "design", "Typography", [
                folder("untitled", "typography", "null", [link("deep", "untitled", "Deep", "https://deep.test", 40)])
            ]),
            folder("empty-child", "design", "Empty")
        ]),
        folder("archive", "1", "Archive", [
            link("archived", "archive", "Archived", "https://archive.test"),
            folder("archive-deep", "archive", "Deep", [link("archived-deep", "archive-deep", "Archived deep", "https://archive-deep.test")])
        ]),
        folder("launch", "1", "Launch", [
            link("launch-one", "launch", "Launch one", "https://launch.test", 50),
            { id: "launch-separator", parentId: "launch", type: "separator" }
        ]),
        folder("empty", "1", "Empty")
    ])
])];
