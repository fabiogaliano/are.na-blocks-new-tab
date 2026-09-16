import { describe, expect, it, vi } from "vitest";
import { createAutoSaver } from "../extension/scripts/settings-autosave.js";

function fakeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    return {
        setTimeout: (fn, delay) => {
            const id = nextId++;
            timers.set(id, { fn, at: now + delay });
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= now) {
                    timers.delete(id);
                    timer.fn();
                }
            }
        },
        get size() {
            return timers.size;
        }
    };
}

describe("createAutoSaver", () => {
    it("commits once after the delay settles", () => {
        const clock = fakeClock();
        const commit = vi.fn();
        const saver = createAutoSaver({ commit, delay: 700, ...clock });

        saver.schedule();
        clock.advance(699);
        expect(commit).not.toHaveBeenCalled();

        clock.advance(1);
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it("collapses a burst of keystrokes into a single commit", () => {
        const clock = fakeClock();
        const commit = vi.fn();
        const saver = createAutoSaver({ commit, delay: 700, ...clock });

        saver.schedule();
        clock.advance(300);
        saver.schedule();
        clock.advance(300);
        saver.schedule();
        clock.advance(700);

        expect(commit).toHaveBeenCalledTimes(1);
    });

    it("flushes early and drops the scheduled run", async () => {
        const clock = fakeClock();
        const commit = vi.fn();
        const saver = createAutoSaver({ commit, delay: 700, ...clock });

        saver.schedule();
        await saver.flush();
        expect(commit).toHaveBeenCalledTimes(1);

        clock.advance(1000);
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it("cancels a pending commit without running it", () => {
        const clock = fakeClock();
        const commit = vi.fn();
        const saver = createAutoSaver({ commit, delay: 700, ...clock });

        saver.schedule();
        saver.cancel();
        clock.advance(1000);

        expect(commit).not.toHaveBeenCalled();
    });

    it("queues a commit requested while one is in flight", async () => {
        const clock = fakeClock();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const commit = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);
        const saver = createAutoSaver({ commit, delay: 700, ...clock });

        const first = saver.flush();
        expect(commit).toHaveBeenCalledTimes(1);

        saver.flush();
        expect(commit).toHaveBeenCalledTimes(1);

        release();
        await first;
        expect(commit).toHaveBeenCalledTimes(2);
    });

    it("reports whether work is outstanding", async () => {
        const clock = fakeClock();
        const saver = createAutoSaver({ commit: () => {}, delay: 700, ...clock });

        expect(saver.pending()).toBe(false);
        saver.schedule();
        expect(saver.pending()).toBe(true);
        await saver.flush();
        expect(saver.pending()).toBe(false);
    });
});
