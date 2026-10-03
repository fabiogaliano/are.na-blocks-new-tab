import { describe, expect, it } from "vitest";
import { readTabBlockIds, saveTabBlockIds } from "../extension/scripts/tab-blocks.js";

const memoryStore = () => {
    const data = new Map();
    return {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
    };
};

describe("tab block ids", () => {
    it("starts empty for a fresh tab", () => {
        expect(readTabBlockIds(memoryStore())).toEqual([]);
    });

    it("returns the ids this tab saved, as strings, when navigating back", () => {
        const store = memoryStore();
        saveTabBlockIds([1, "2"], store);
        expect(readTabBlockIds(store, "back_forward")).toEqual(["1", "2"]);
    });

    it("ignores the saved ids on a reload so the tab picks new blocks", () => {
        const store = memoryStore();
        saveTabBlockIds(["1"], store);
        expect(readTabBlockIds(store, "reload")).toEqual([]);
    });

    it("treats a corrupt entry as empty", () => {
        const store = memoryStore();
        store.setItem("arenaTabBlockIds", "{not json");
        expect(readTabBlockIds(store, "back_forward")).toEqual([]);
    });

    it("tolerates a missing store", () => {
        expect(readTabBlockIds(null, "back_forward")).toEqual([]);
        expect(() => saveTabBlockIds(["1"], null)).not.toThrow();
    });
});
