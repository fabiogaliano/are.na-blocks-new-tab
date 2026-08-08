import {
    BAR_COMPONENTS,
    DATE_FORMATS,
    DEFAULT_BAR_LAYOUT,
    DEFAULT_SETTINGS,
    TIME_FORMATS
} from "./constants.js";

const BAR_NAMES = ["top", "bottom"];
const SLOT_NAMES = ["left", "right"];
const BAR_LABELS = {
    none: "None",
    bookmarks: "Bookmarks",
    cache: "Cache indicator",
    settings: "Settings",
    date: "Date",
    time: "Time",
    dateTime: "Date + time"
};
const DATE_FORMATTERS = new Map();
const TIME_FORMATTERS = new Map();

export const normalizeBarLayout = (value) => {
    const normalized = {};
    const usedComponents = new Set();

    BAR_NAMES.forEach((barName) => {
        const source = value?.[barName] || {};
        const fallback = DEFAULT_BAR_LAYOUT[barName];
        normalized[barName] = {
            left: "none",
            right: "none"
        };

        SLOT_NAMES.forEach((slotName) => {
            const requested = BAR_COMPONENTS.includes(source[slotName]) ? source[slotName] : fallback[slotName];
            if (requested === "none" || usedComponents.has(requested)) {
                return;
            }
            normalized[barName][slotName] = requested;
            usedComponents.add(requested);
        });
    });

    return normalized;
};

const selectBarComponent = (value, slotPath, component) => {
    const [barName, slotName] = `${slotPath}`.split(".");
    const layout = normalizeBarLayout(value);
    if (!BAR_NAMES.includes(barName) || !SLOT_NAMES.includes(slotName)) {
        return layout;
    }

    const selected = BAR_COMPONENTS.includes(component) ? component : "none";
    if (selected !== "none") {
        BAR_NAMES.forEach((candidateBar) => {
            SLOT_NAMES.forEach((candidateSlot) => {
                if (layout[candidateBar][candidateSlot] === selected) {
                    layout[candidateBar][candidateSlot] = "none";
                }
            });
        });
    }
    layout[barName][slotName] = selected;
    return layout;
};

const getBarFormatVisibility = (value) => {
    const layout = normalizeBarLayout(value);
    const components = new Set(BAR_NAMES.flatMap((barName) => SLOT_NAMES.map((slotName) => layout[barName][slotName])));
    const date = components.has("date") || components.has("dateTime");
    const time = components.has("time") || components.has("dateTime");
    return {
        date,
        time,
        options: date || time
    };
};

const hasVisibleSettingsButton = ({ barLayout, showHeader = true, showFooter = true }) => {
    const layout = normalizeBarLayout(barLayout);
    return BAR_NAMES.some((barName) => {
        const barVisible = barName === "top" ? showHeader : showFooter;
        if (!barVisible) {
            return false;
        }
        return SLOT_NAMES.some((slotName) => layout[barName][slotName] === "settings");
    });
};

export const normalizeDateFormat = (value) => DATE_FORMATS.includes(value) ? value : DEFAULT_SETTINGS.dateFormat;

export const normalizeTimeFormat = (value) => TIME_FORMATS.includes(value) ? value : DEFAULT_SETTINGS.timeFormat;

export function createBarEditor({ selects, formatOptions, dateFormatField, timeFormatField }) {
    const controls = Array.from(selects || []);

    controls.forEach((select) => {
        const document = select.ownerDocument ?? globalThis.document;
        select.replaceChildren(...BAR_COMPONENTS.map((value) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = BAR_LABELS[value] || value;
            return option;
        }));
    });

    function read() {
        const draft = {
            top: { left: "none", right: "none" },
            bottom: { left: "none", right: "none" }
        };
        controls.forEach((select) => {
            const [barName, slotName] = `${select.dataset.barSlot}`.split(".");
            if (BAR_NAMES.includes(barName) && SLOT_NAMES.includes(slotName)) {
                draft[barName][slotName] = select.value;
            }
        });
        return normalizeBarLayout(draft);
    }

    function write(value) {
        const layout = normalizeBarLayout(value);
        controls.forEach((select) => {
            const [barName, slotName] = `${select.dataset.barSlot}`.split(".");
            select.value = layout[barName]?.[slotName] || "none";
        });
        updateFormatVisibility(layout);
        return layout;
    }

    function select(slotPath, component) {
        return write(selectBarComponent(read(), slotPath, component));
    }

    function updateFormatVisibility(value = read()) {
        const visibility = getBarFormatVisibility(value);
        if (dateFormatField) {
            dateFormatField.hidden = !visibility.date;
        }
        if (timeFormatField) {
            timeFormatField.hidden = !visibility.time;
        }
        if (formatOptions) {
            formatOptions.hidden = !visibility.options;
        }
    }

    function hasVisibleSettings({ showHeader = true, showFooter = true } = {}) {
        return hasVisibleSettingsButton({
            barLayout: read(),
            showHeader,
            showFooter
        });
    }

    return {
        read,
        write,
        select,
        hasVisibleSettings
    };
}

export function createBarRenderer({
    header,
    footer,
    pool,
    regions,
    components,
    dateElement,
    timeElement,
    dateTimeElement,
    beforeRender
}) {
    const document = pool?.ownerDocument ?? globalThis.document;
    const view = document?.defaultView ?? globalThis;
    let settings = { ...DEFAULT_SETTINGS, barLayout: normalizeBarLayout(DEFAULT_SETTINGS.barLayout) };
    let clockTimer = null;

    function render(nextSettings) {
        if (nextSettings) {
            settings = {
                ...DEFAULT_SETTINGS,
                ...nextSettings,
                barLayout: normalizeBarLayout(nextSettings.barLayout)
            };
            beforeRender?.();
            Object.values(components).forEach((component) => {
                if (component && pool) {
                    pool.appendChild(component);
                }
            });
            if (header) {
                header.hidden = settings.showHeader === false;
            }
            if (footer) {
                footer.hidden = settings.showFooter === false;
            }
            renderBar(settings.barLayout.top, regions?.top);
            renderBar(settings.barLayout.bottom, regions?.bottom);
        }
        updateClock();
    }

    function renderBar(bar, barRegions) {
        const leftRegion = barRegions?.left;
        const rightRegion = barRegions?.right;
        if (!leftRegion || !rightRegion) {
            return;
        }
        const barElement = leftRegion.parentElement;
        if (barElement) {
            barElement.dataset.hasBookmarks = bar.left === "bookmarks" || bar.right === "bookmarks" ? "true" : "false";
        }
        configureRegion(leftRegion, bar.left);
        configureRegion(rightRegion, bar.right);
    }

    function configureRegion(region, componentName) {
        region.style.removeProperty("flex-basis");
        region.style.removeProperty("max-width");
        region.hidden = !componentName || componentName === "none";
        region.dataset.component = componentName || "none";
        const component = components[componentName];
        if (component) {
            region.appendChild(component);
        }
    }

    function updateClock() {
        if (clockTimer !== null) {
            view.clearTimeout(clockTimer);
            clockTimer = null;
        }
        if (document?.hidden) {
            return;
        }

        const now = new Date();
        const iso = now.toISOString();
        const visibleComponents = getVisibleComponents(settings);
        const showsDate = visibleComponents.has("date") || visibleComponents.has("dateTime");
        const showsTime = visibleComponents.has("time") || visibleComponents.has("dateTime");
        const dateLabel = showsDate ? formatBarDate(now, settings.dateFormat) : "";
        const timeLabel = showsTime ? formatBarTime(now, settings.timeFormat) : "";
        if (visibleComponents.has("date")) {
            setTimeElement(dateElement, dateLabel, iso, "Current date");
        }
        if (visibleComponents.has("time")) {
            setTimeElement(timeElement, timeLabel, iso, "Current time");
        }
        if (visibleComponents.has("dateTime")) {
            setTimeElement(dateTimeElement, [dateLabel, timeLabel].filter(Boolean).join(" "), iso, "Current date and time");
        }

        const delay = getClockDelay(now, visibleComponents, settings.timeFormat);
        if (delay !== null) {
            clockTimer = view.setTimeout(updateClock, delay);
        }
    }

    function isVisible(componentName) {
        const component = components[componentName];
        const region = component?.parentElement;
        const bar = region?.parentElement;
        return Boolean(region?.classList.contains("bar-region") && !region.hidden && bar && !bar.hidden);
    }

    return {
        render,
        isVisible
    };
}

const formatBarDate = (value, format = "system") => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    const normalized = normalizeDateFormat(format);
    switch (normalized) {
        case "iso":
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        case "short":
            return getDateFormatter(normalized, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
        case "long":
            return getDateFormatter(normalized, { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(date);
        case "system":
        default:
            return getDateFormatter(normalized).format(date);
    }
};

const formatBarTime = (value, format = "system") => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    const normalized = normalizeTimeFormat(format);
    const options = {
        hour: "numeric",
        minute: "2-digit"
    };
    if (normalized.includes("seconds")) {
        options.second = "2-digit";
    }
    if (normalized.startsWith("12-hour")) {
        options.hour12 = true;
    } else if (normalized.startsWith("24-hour")) {
        options.hour12 = false;
    }
    if (!TIME_FORMATTERS.has(normalized)) {
        TIME_FORMATTERS.set(normalized, new Intl.DateTimeFormat(undefined, options));
    }
    return TIME_FORMATTERS.get(normalized).format(date);
};

const getDateFormatter = (format, options) => {
    if (!DATE_FORMATTERS.has(format)) {
        DATE_FORMATTERS.set(format, new Intl.DateTimeFormat(undefined, options));
    }
    return DATE_FORMATTERS.get(format);
};

const setTimeElement = (element, label, iso, title) => {
    if (!element) {
        return;
    }
    element.textContent = label;
    element.dateTime = iso;
    element.title = label ? `${title}: ${label}` : title;
};

const getVisibleComponents = (settings) => {
    const visible = new Set();
    const addBar = (bar) => {
        SLOT_NAMES.forEach((slotName) => visible.add(bar[slotName]));
    };
    if (settings.showHeader !== false) {
        addBar(settings.barLayout.top);
    }
    if (settings.showFooter !== false) {
        addBar(settings.barLayout.bottom);
    }
    return visible;
};

const getClockDelay = (now, visibleComponents, timeFormat) => {
    const showsTime = visibleComponents.has("time") || visibleComponents.has("dateTime");
    const showsDate = visibleComponents.has("date") || visibleComponents.has("dateTime");
    if (!showsTime && !showsDate) {
        return null;
    }
    if (showsTime) {
        const hasSeconds = normalizeTimeFormat(timeFormat).includes("seconds");
        const interval = hasSeconds ? 1000 : 60 * 1000;
        return interval - (now.getTime() % interval) + 20;
    }
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return Math.max(20, nextDay.getTime() - now.getTime() + 20);
};

const pad = (value) => `${value}`.padStart(2, "0");
