import { TILE_SIZE_OPTIONS } from "./constants.js";

const TILE_SIZE_MAP = {
    xs: 225,
    s: 260,
    m: 310,
    l: 360,
    xl: 420,
};

const AUTO_TILE_MAX = 420;
const AUTO_TILE_MIN = 120;
const AUTO_TILE_STEP = 5;
const TILE_GAP = 18;
const CARD_SHADOW_OFFSET = 8;

export function createBlockLayout({ container, contentArea, renderCard }) {
    const document = container?.ownerDocument ?? globalThis.document;
    const view = document?.defaultView ?? globalThis.window;
    const balancedLayoutCache = new Map();

    function render(blocks, requestedTileSize) {
        if (!container || !contentArea || !blocks?.length) {
            return;
        }

        container.classList.remove("is-empty");
        container.innerHTML = "";
        contentArea.classList.remove("is-scroll-y", "is-scroll-x");
        contentArea.style.overflowX = "hidden";
        contentArea.style.overflowY = "hidden";

        const viewport = getViewport();
        container.style.setProperty("--tile-gap", `${TILE_GAP}px`);
        const cards = blocks.map((block) => renderCard(block));
        const requested = TILE_SIZE_OPTIONS.includes(requestedTileSize) ? requestedTileSize : "auto";
        const result = requested === "auto"
            ? determineAutoLayout(cards, viewport)
            : determineFixedLayout(cards.length, viewport, requested);

        applyTileSize(result.tileSize);
        placeBlockCards(cards, result.layout.rows);
        view.requestAnimationFrame(applyOverflowStates);
    }

    function applyTileSize(tileSize) {
        const isCompact = tileSize <= TILE_SIZE_MAP.s;
        container.style.setProperty("--tile-size", `${tileSize}px`);
        container.style.setProperty("--block-title-size", isCompact ? "0.9rem" : "1rem");
        container.style.setProperty("--block-meta-size", isCompact ? "0.6rem" : "0.7rem");
    }

    function determineFixedLayout(count, viewport, requested) {
        const baseSize = TILE_SIZE_MAP[requested] || TILE_SIZE_MAP.m;
        const tileSize = clampTileSize(baseSize, viewport);
        return { tileSize, layout: chooseLayout(count, viewport, tileSize) };
    }

    function determineAutoLayout(cards, viewport) {
        const measurementRow = document.createElement("div");
        measurementRow.className = "block-row";
        measurementRow.style.width = "max-content";
        cards.forEach((card) => measurementRow.appendChild(card));
        container.appendChild(measurementRow);

        const containerStyle = view.getComputedStyle(container);
        const padding = {
            horizontal: readPixelValue(containerStyle.paddingLeft) + readPixelValue(containerStyle.paddingRight),
            vertical: readPixelValue(containerStyle.paddingTop) + readPixelValue(containerStyle.paddingBottom),
        };
        const layouts = getBalancedLayouts(cards.length);
        const largestUsefulSize = Math.min(
            AUTO_TILE_MAX,
            Math.floor(viewport.width - padding.horizontal - CARD_SHADOW_OFFSET),
        );
        const startSize = Math.max(AUTO_TILE_MIN, largestUsefulSize);
        let fallback = null;

        for (let tileSize = startSize; tileSize >= AUTO_TILE_MIN; tileSize -= AUTO_TILE_STEP) {
            const candidateSize = Math.max(AUTO_TILE_MIN, tileSize);
            applyTileSize(candidateSize);
            const cardHeights = cards.map((card) => card.getBoundingClientRect().height);
            const candidates = layouts.map((rows) => measureLayout(rows, cardHeights, candidateSize, viewport, padding));
            const fitting = candidates.filter((layout) => layout.fitsWidth && layout.fitsHeight);

            if (fitting.length) {
                return {
                    tileSize: candidateSize,
                    layout: chooseBestFittingLayout(fitting, viewport),
                };
            }

            if (candidateSize === AUTO_TILE_MIN) {
                fallback = chooseLeastOverflowingLayout(candidates, viewport);
            }
        }

        if (!fallback) {
            applyTileSize(AUTO_TILE_MIN);
            const cardHeights = cards.map((card) => card.getBoundingClientRect().height);
            const candidates = layouts.map((rows) => measureLayout(rows, cardHeights, AUTO_TILE_MIN, viewport, padding));
            fallback = chooseLeastOverflowingLayout(candidates, viewport);
        }

        return { tileSize: AUTO_TILE_MIN, layout: fallback };
    }

    function getBalancedLayouts(count) {
        if (balancedLayoutCache.has(count)) {
            return balancedLayoutCache.get(count);
        }

        const layouts = [];
        const seen = new Set();

        for (let rowCount = 1; rowCount <= count; rowCount += 1) {
            const minimumColumns = Math.floor(count / rowCount);
            const fullerRows = count % rowCount;
            const rows = Array.from(
                { length: rowCount },
                (_, index) => minimumColumns + (index < fullerRows ? 1 : 0),
            );
            const key = rows.join(",");
            if (!seen.has(key)) {
                seen.add(key);
                layouts.push(rows);
            }
        }

        balancedLayoutCache.set(count, layouts);
        return layouts;
    }

    function measureLayout(rows, cardHeights, tileSize, viewport, padding) {
        let cardIndex = 0;
        const rowHeights = rows.map((columns) => {
            const heights = cardHeights.slice(cardIndex, cardIndex + columns);
            cardIndex += columns;
            return Math.max(...heights);
        });
        const widestRow = Math.max(...rows);
        const requiredWidth = widestRow * tileSize
            + (widestRow - 1) * TILE_GAP
            + padding.horizontal
            + CARD_SHADOW_OFFSET;
        const requiredHeight = rowHeights.reduce((total, height) => total + height, 0)
            + (rows.length - 1) * TILE_GAP
            + padding.vertical
            + CARD_SHADOW_OFFSET;

        return {
            rows,
            requiredWidth,
            requiredHeight,
            fitsWidth: requiredWidth <= viewport.width + 1,
            fitsHeight: requiredHeight <= viewport.height + 1,
        };
    }

    function chooseBestFittingLayout(layouts, viewport) {
        return layouts.reduce((best, layout) => (
            layoutAspectDistance(layout, viewport) < layoutAspectDistance(best, viewport) ? layout : best
        ));
    }

    function chooseLeastOverflowingLayout(layouts, viewport) {
        return layouts.reduce((best, layout) => {
            const bestOverflow = layoutOverflow(best, viewport);
            const overflow = layoutOverflow(layout, viewport);
            if (overflow < bestOverflow) {
                return layout;
            }
            if (overflow === bestOverflow && layoutAspectDistance(layout, viewport) < layoutAspectDistance(best, viewport)) {
                return layout;
            }
            return best;
        });
    }

    function layoutOverflow(layout, viewport) {
        return Math.max(
            layout.requiredWidth / Math.max(viewport.width, 1),
            layout.requiredHeight / Math.max(viewport.height, 1),
        );
    }

    function layoutAspectDistance(layout, viewport) {
        const layoutRatio = layout.requiredWidth / Math.max(layout.requiredHeight, 1);
        const viewportRatio = viewport.width / Math.max(viewport.height, 1);
        return Math.abs(Math.log(layoutRatio / Math.max(viewportRatio, 0.01)));
    }

    function placeBlockCards(cards, rows) {
        container.innerHTML = "";
        let index = 0;
        rows.forEach((columns) => {
            const row = document.createElement("div");
            row.className = "block-row";
            row.dataset.columns = String(columns);
            for (let column = 0; column < columns && index < cards.length; column += 1) {
                row.appendChild(cards[index]);
                index += 1;
            }
            container.appendChild(row);
        });
    }

    function chooseLayout(count, viewport, tileSize) {
        if (count <= 0) {
            return emptyLayout();
        }

        const widthFor = (columns) => columns * tileSize + (columns - 1) * TILE_GAP;
        const heightForRows = (rows) => rows * tileSize + (rows - 1) * TILE_GAP;
        const fitsColumns = (columns) => widthFor(columns) <= viewport.width;
        const fitsRows = (rows) => heightForRows(rows) <= viewport.height;
        const ratio = viewport.width / Math.max(viewport.height, 1);
        const superThin = viewport.width < widthFor(2);
        const superWide = viewport.height < heightForRows(2);

        let rows;

        switch (count) {
            case 1:
                rows = [1];
                break;
            case 2:
                rows = ratio >= 1 && fitsColumns(2) ? [2] : [1, 1];
                break;
            case 3:
                if (ratio >= 1 && fitsColumns(3)) {
                    rows = [3];
                } else if (ratio >= 1 && fitsColumns(2)) {
                    rows = [2, 1];
                } else {
                    rows = [1, 1, 1];
                }
                break;
            case 4:
                if (superThin) {
                    rows = [1, 1, 1, 1];
                } else if (superWide && fitsColumns(4)) {
                    rows = [4];
                } else if (fitsColumns(2) && fitsRows(2)) {
                    rows = [2, 2];
                } else if (fitsColumns(2)) {
                    rows = [2, 1, 1];
                } else {
                    rows = [1, 1, 1, 1];
                }
                break;
            case 5:
                if (superThin) {
                    rows = [1, 1, 1, 1, 1];
                } else if (superWide && fitsColumns(5)) {
                    rows = [5];
                } else if (fitsColumns(2) && !fitsColumns(3)) {
                    rows = [2, 2, 1];
                } else if (fitsColumns(3) && fitsRows(2)) {
                    rows = [3, 2];
                } else if (fitsColumns(3) && fitsRows(3)) {
                    rows = [2, 2, 1];
                } else if (fitsColumns(2)) {
                    rows = [2, 2, 1];
                } else {
                    rows = [1, 1, 1, 1, 1];
                }
                break;
            case 6:
                if (superThin) {
                    rows = [1, 1, 1, 1, 1, 1];
                } else if (superWide && fitsColumns(6)) {
                    rows = [6];
                } else {
                    const canThreeCols = fitsColumns(3);
                    const canTwoCols = fitsColumns(2);
                    const preferWide = ratio >= 1;
                    if (canThreeCols && preferWide && fitsRows(2)) {
                        rows = [3, 3];
                    } else if (canThreeCols && !canTwoCols && fitsRows(2)) {
                        rows = [3, 3];
                    } else if (canTwoCols && fitsRows(3)) {
                        rows = [2, 2, 2];
                    } else if (canThreeCols) {
                        rows = [3, 3];
                    } else if (canTwoCols) {
                        rows = [2, 2, 2];
                    } else {
                        rows = [1, 1, 1, 1, 1, 1];
                    }
                }
                break;
            default:
                rows = Array.from({ length: count }, () => 1);
                break;
        }

        const rowWidths = rows.map((columns) => widthFor(columns));
        const requiredWidth = Math.max(...rowWidths);
        const requiredHeight = heightForRows(rows.length);

        return {
            rows,
            requiredWidth,
            requiredHeight,
            fitsWidth: requiredWidth <= viewport.width,
            fitsHeight: requiredHeight <= viewport.height,
        };
    }

    function clampTileSize(size, viewport) {
        const maxWidth = Math.max(AUTO_TILE_MIN, viewport.width - 32);
        const maxHeight = Math.max(AUTO_TILE_MIN, viewport.height - 48);
        const limited = Math.min(size, maxWidth, maxHeight);
        return Math.max(AUTO_TILE_MIN, Math.floor(limited));
    }

    function getViewport() {
        const areaStyle = view.getComputedStyle(contentArea);
        const horizontalPadding = readPixelValue(areaStyle.paddingLeft) + readPixelValue(areaStyle.paddingRight);
        const verticalPadding = readPixelValue(areaStyle.paddingTop) + readPixelValue(areaStyle.paddingBottom);
        const width = Math.max(0, (contentArea.clientWidth || view.innerWidth) - horizontalPadding);
        const height = Math.max(0, (contentArea.clientHeight || view.innerHeight) - verticalPadding);
        return { width, height };
    }

    function applyOverflowStates() {
        let { verticalOverflow, horizontalOverflow } = measureOverflow();
        setOverflowStates(verticalOverflow, horizontalOverflow);

        const feedback = measureOverflow();
        verticalOverflow = verticalOverflow || feedback.verticalOverflow;
        horizontalOverflow = horizontalOverflow || feedback.horizontalOverflow;
        setOverflowStates(verticalOverflow, horizontalOverflow);

        if (!verticalOverflow) {
            contentArea.scrollTop = 0;
        }
        if (!horizontalOverflow) {
            contentArea.scrollLeft = 0;
        }
    }

    function measureOverflow() {
        const containerRect = container.getBoundingClientRect();
        const viewport = getViewport();
        return {
            verticalOverflow: containerRect.height + CARD_SHADOW_OFFSET > viewport.height + 1,
            horizontalOverflow: containerRect.width + CARD_SHADOW_OFFSET > viewport.width + 1,
        };
    }

    function setOverflowStates(verticalOverflow, horizontalOverflow) {
        contentArea.classList.toggle("is-scroll-y", verticalOverflow);
        contentArea.classList.toggle("is-scroll-x", horizontalOverflow);
        contentArea.style.overflowY = verticalOverflow ? "auto" : "hidden";
        contentArea.style.overflowX = horizontalOverflow ? "auto" : "hidden";
    }

    return render;
}

function emptyLayout() {
    return { rows: [], requiredWidth: 0, requiredHeight: 0, fitsWidth: true, fitsHeight: true };
}

function readPixelValue(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
