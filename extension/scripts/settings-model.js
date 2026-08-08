import { BLOCK_TYPES, DEFAULT_SETTINGS, TILE_SIZE_OPTIONS } from "./constants.js";
import { normalizeBarLayout, normalizeDateFormat, normalizeTimeFormat } from "./bar-customization.js";
import { normalizeBlockMetaFields } from "./customization.js";

const SOURCE_FIELDS = ["channelSlugs", "blockIds", "filters", "accountChannelSlugs", "includeFeed"];
const DISPLAY_FIELDS = [
    "blockCount",
    "showHeader",
    "showFooter",
    "theme",
    "tileSize",
    "barLayout",
    "dateFormat",
    "timeFormat",
    "blockMetaFields"
];
const ARRAY_FIELDS = new Set(["channelSlugs", "blockIds", "filters", "accountChannelSlugs", "blockMetaFields"]);
const SET_FIELDS = new Set(["filters", "accountChannelSlugs", "blockMetaFields"]);
const THEMES = ["system", "light", "dark"];

const unique = (values) => [...new Set(values)];

const normalizeCommaList = (value) => `${value || ""}`.split(",").map(item => item.trim()).filter(Boolean);

const normalizeStringArray = (value) => Array.isArray(value)
    ? unique(value.map(item => `${item}`.trim()).filter(Boolean))
    : [];

const normalizeChannelSlugs = (value) => unique(
    (Array.isArray(value) ? value : normalizeCommaList(value))
        .map(item => `${item}`.trim().toLowerCase())
        .filter(Boolean)
);

const normalizeBlockIds = (value) => unique(
    (Array.isArray(value) ? value : normalizeCommaList(value))
        .map(id => `${id}`.replace(/[^0-9]/g, ""))
        .filter(Boolean)
);

const normalizeBlockCount = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed)
        ? Math.min(6, Math.max(1, Math.trunc(parsed)))
        : DEFAULT_SETTINGS.blockCount;
};

const normalizeBoolean = (value, fallback) => value === undefined ? fallback : Boolean(value);

export const canonicalizeSettings = (value = DEFAULT_SETTINGS) => {
    const source = value && typeof value === "object" ? value : DEFAULT_SETTINGS;
    const filters = normalizeStringArray(source.filters).filter((filter) => BLOCK_TYPES.includes(filter));

    return {
        ...DEFAULT_SETTINGS,
        ...source,
        channelSlugs: normalizeChannelSlugs(source.channelSlugs),
        blockIds: normalizeBlockIds(source.blockIds),
        filters: filters.length ? filters : [...DEFAULT_SETTINGS.filters],
        blockCount: normalizeBlockCount(source.blockCount),
        showHeader: normalizeBoolean(source.showHeader, DEFAULT_SETTINGS.showHeader),
        showFooter: normalizeBoolean(source.showFooter, DEFAULT_SETTINGS.showFooter),
        theme: THEMES.includes(source.theme) ? source.theme : DEFAULT_SETTINGS.theme,
        tileSize: TILE_SIZE_OPTIONS.includes(source.tileSize) ? source.tileSize : DEFAULT_SETTINGS.tileSize,
        includeFeed: Boolean(source.includeFeed),
        accountChannelSlugs: normalizeChannelSlugs(source.accountChannelSlugs),
        barLayout: normalizeBarLayout(source.barLayout),
        dateFormat: normalizeDateFormat(source.dateFormat),
        timeFormat: normalizeTimeFormat(source.timeFormat),
        blockMetaFields: normalizeBlockMetaFields(source.blockMetaFields)
    };
};

export const classifySettingsChanges = (next, current) => {
    if (!current) {
        return {
            changed: true,
            sourcesChanged: true,
            displayChanged: true
        };
    }

    const candidate = canonicalizeSettings(next);
    const saved = canonicalizeSettings(current);
    const sourcesChanged = SOURCE_FIELDS.some((field) => !fieldEquals(field, candidate[field], saved[field]));
    const displayChanged = DISPLAY_FIELDS.some((field) => !fieldEquals(field, candidate[field], saved[field]));
    return {
        changed: sourcesChanged || displayChanged,
        sourcesChanged,
        displayChanged
    };
};

const fieldEquals = (field, left, right) => {
    if (SET_FIELDS.has(field)) {
        return left.length === right.length && left.every((value) => right.includes(value));
    }
    if (ARRAY_FIELDS.has(field)) {
        return arraysEqual(left, right);
    }
    if (field === "barLayout") {
        return left.top.left === right.top.left &&
            left.top.right === right.top.right &&
            left.bottom.left === right.bottom.left &&
            left.bottom.right === right.bottom.right;
    }
    return left === right;
};

const arraysEqual = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
