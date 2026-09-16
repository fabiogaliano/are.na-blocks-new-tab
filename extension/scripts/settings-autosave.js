const DEFAULT_DELAY = 700;

/**
 * Debounced writer behind the settings form's auto-save.
 *
 * Typing schedules a commit; leaving a field flushes it early so a value is
 * never stranded by closing the panel mid-edit. A commit requested while one is
 * already running is queued rather than dropped, so the last keystroke always
 * reaches storage.
 */
export function createAutoSaver({
    commit,
    delay = DEFAULT_DELAY,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: unschedule = globalThis.clearTimeout
} = {}) {
    let timer = null;
    let running = null;
    let queued = false;

    const pending = () => timer !== null || queued || running !== null;

    function cancel() {
        if (timer !== null) {
            unschedule(timer);
            timer = null;
        }
    }

    async function run() {
        if (running) {
            queued = true;
            return running;
        }
        running = (async () => {
            try {
                await commit();
            } finally {
                running = null;
            }
            if (queued) {
                queued = false;
                await run();
            }
        })();
        return running;
    }

    function schedule_() {
        cancel();
        timer = schedule(() => {
            timer = null;
            run();
        }, delay);
    }

    function flush() {
        cancel();
        return run();
    }

    return { schedule: schedule_, flush, cancel, pending };
}
