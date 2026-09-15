import { describe, expect, it } from "vitest";
import { canonicalizeSettings, classifySettingsChanges, normalizeFolderPath, normalizeHiddenFolders } from "../extension/scripts/settings-model.js";

describe("bookmark settings", () => {
    it("normalizes folder paths", () => {
        expect(normalizeFolderPath(" / design // icons / ")).toBe("design/icons");
        expect(normalizeFolderPath("///")).toBe("");
    });

    it("normalizes hidden folders from text and arrays", () => {
        expect(normalizeHiddenFolders(" Archive \n design / Drafts\narchive")).toEqual(["archive", "design/drafts"]);
        expect(normalizeHiddenFolders([" To Move ", "to move", ""])).toEqual(["to move"]);
    });

    it("supplies bookmark defaults to settings saved by older versions", () => {
        const settings = canonicalizeSettings({ channelSlugs: [] });
        expect(settings).toMatchObject({ bookmarksRootPath: "", hiddenFolders: ["archive", "to move"], launchFolder: "launch" });
    });

    it("round-trips bookmark fields", () => {
        const settings = canonicalizeSettings({
            bookmarksRootPath: " Work / Research ",
            hiddenFolders: ["Archive", "TO MOVE"],
            launchFolder: " Quick / Launch "
        });
        expect(settings.bookmarksRootPath).toBe("Work/Research");
        expect(settings.hiddenFolders).toEqual(["archive", "to move"]);
        expect(settings.launchFolder).toBe("Quick/Launch");
    });

    it.each([
        ["bookmarksRootPath", "research"],
        ["hiddenFolders", ["private"]],
        ["launchFolder", "start"]
    ])("classifies %s as a display change", (field, value) => {
        const current = canonicalizeSettings();
        const changes = classifySettingsChanges({ ...current, [field]: value }, current);
        expect(changes).toMatchObject({ changed: true, sourcesChanged: false, displayChanged: true });
    });

    it("compares hidden folders without regard to order", () => {
        const current = canonicalizeSettings({ hiddenFolders: ["archive", "to move"] });
        expect(classifySettingsChanges({ ...current, hiddenFolders: ["to move", "archive"] }, current).changed).toBe(false);
    });
});
