import { MARQUEE_START_DISTANCE } from "./constants.js";

export function hitTest(rects, rect) {
    if (!rect || rect.right <= rect.left || rect.bottom <= rect.top) {
        return [];
    }
    return (rects || [])
        .filter((candidate) => candidate.right > candidate.left && candidate.bottom > candidate.top && candidate.right > rect.left && candidate.left < rect.right && candidate.bottom > rect.top && candidate.top < rect.bottom)
        .map((candidate) => String(candidate.id));
}

export function computeMarquee(base, hitIds, { additive = false } = {}) {
    const hits = new Set((hitIds || []).map(String));
    return additive ? new Set([...base, ...hits]) : hits;
}

export function toggle(set, id) {
    const next = new Set(set || []);
    const key = String(id);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
}

export function pruneSelection(set, ids) {
    const available = new Set(Array.from(ids || [], String));
    return new Set([...set].filter((id) => available.has(String(id))));
}

export function createMarquee({ board, getRects, getSelection = () => new Set(), onChange }) {
    let start = null;
    let marquee = null;
    let rects = [];
    let frame = null;
    let scrollFrame = null;
    let autoDirection = 0;
    let swallowClick = false;
    let enabled = true;

    function draw(event) {
        frame = null;
        if (!start) {
            return;
        }
        const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (!marquee && distance < MARQUEE_START_DISTANCE) {
            return;
        }
        if (!marquee) {
            marquee = document.createElement("div");
            marquee.className = "bm-marquee";
            document.body.append(marquee);
            board.setPointerCapture?.(event.pointerId);
        }
        const rect = {
            left: Math.min(start.x, event.clientX),
            right: Math.max(start.x, event.clientX),
            top: Math.min(start.y, event.clientY),
            bottom: Math.max(start.y, event.clientY)
        };
        Object.assign(marquee.style, {
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.right - rect.left}px`,
            height: `${rect.bottom - rect.top}px`
        });
        onChange(computeMarquee(start.base, hitTest(rects, rect), { additive: start.additive }));
        const boardRect = board.getBoundingClientRect();
        autoDirection = event.clientY < boardRect.top + 40 ? -1 : event.clientY > boardRect.bottom - 40 ? 1 : 0;
        if (autoDirection && !scrollFrame) {
            const scroll = () => {
                if (!start || !autoDirection) {
                    scrollFrame = null;
                    return;
                }
                board.scrollTop += autoDirection * 8;
                rects = getRects();
                scrollFrame = requestAnimationFrame(scroll);
            };
            scrollFrame = requestAnimationFrame(scroll);
        }
    }

    function pointerDown(event) {
        if (!enabled || event.button !== 0 || event.target.closest(".bm-card-head, .bm-group-head, .bm-new-head, button, input, textarea, [contenteditable]")) {
            return;
        }
        rects = getRects();
        start = {
            x: event.clientX,
            y: event.clientY,
            additive: event.shiftKey,
            base: new Set(getSelection())
        };
    }

    function pointerMove(event) {
        if (!start || frame) {
            return;
        }
        frame = requestAnimationFrame(() => draw(event));
    }

    function pointerUp() {
        if (frame) {
            cancelAnimationFrame(frame);
            frame = null;
        }
        if (scrollFrame) {
            cancelAnimationFrame(scrollFrame);
            scrollFrame = null;
        }
        autoDirection = 0;
        if (marquee) {
            marquee.remove();
            marquee = null;
            swallowClick = true;
        }
        start = null;
    }

    function captureClick(event) {
        if (!swallowClick) {
            return;
        }
        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
    }

    function handleScroll() {
        if (!start || frame) {
            return;
        }
        frame = requestAnimationFrame(() => {
            rects = getRects();
            frame = null;
        });
    }

    board.addEventListener("pointerdown", pointerDown);
    board.addEventListener("pointermove", pointerMove);
    board.addEventListener("pointerup", pointerUp);
    board.addEventListener("pointercancel", pointerUp);
    board.addEventListener("click", captureClick, true);
    board.addEventListener("scroll", handleScroll, { passive: true });

    return {
        setEnabled(value) {
            enabled = Boolean(value);
            if (!enabled) {
                pointerUp();
            }
        },
        destroy() {
            pointerUp();
            board.removeEventListener("pointerdown", pointerDown);
            board.removeEventListener("pointermove", pointerMove);
            board.removeEventListener("pointerup", pointerUp);
            board.removeEventListener("pointercancel", pointerUp);
            board.removeEventListener("click", captureClick, true);
            board.removeEventListener("scroll", handleScroll);
        }
    };
}
