import {
    BLOCK_META_FIELDS,
    DEFAULT_SETTINGS
} from "./constants.js";

const MAX_META_LENGTH = 320;
const MAX_META_FULL_LENGTH = 2000;

export const normalizeBlockMetaFields = (value) => {
    if (!Array.isArray(value)) {
        return [...DEFAULT_SETTINGS.blockMetaFields];
    }
    return [...new Set(value.filter(field => BLOCK_META_FIELDS.includes(field)))];
};


export const getBlockMetaItems = (block, enabledFields) => {
    const enabled = new Set(normalizeBlockMetaFields(enabledFields));
    const items = [];
    const add = (key, label, value, options = {}) => {
        const normalized = normalizeMetaValue(value);
        if (!enabled.has(key) || !normalized) {
            return;
        }
        items.push({
            key,
            label,
            value: normalized.short,
            fullValue: normalized.full,
            href: options.href || null
        });
    };

    add("createdAt", "Created", formatExactDate(block?.createdAt));
    add("updatedAt", "Updated", formatExactDate(block?.updatedAt));
    add("blockId", "Block", block?.id ? `#${block.id}` : "", { href: block?.arenaUrl });
    add("type", "Type", block?.kind || block?.type);
    add("author", "By", block?.owner?.name || block?.owner?.slug || block?.author);
    add("sourceChannel", "Channel", block?.sourceChannel?.title || block?.sourceChannel?.slug);
    add("source", "Source", getSourceLabel(block), { href: block?.linkUrl });
    add("comments", "Comments", Number.isFinite(block?.commentCount) ? `${block.commentCount}` : "");
    add("visibility", "Visibility", block?.visibility);
    add("state", "State", block?.state);
    add("connectedBy", "Connected by", block?.connection?.connectedBy?.name || block?.connection?.connectedBy?.slug);
    add("connectedAt", "Connected", formatExactDate(block?.connection?.connectedAt));
    add("position", "Position", Number.isFinite(block?.connection?.position) ? `${block.connection.position}` : "");
    add("pinned", "Pinned", typeof block?.connection?.pinned === "boolean" ? (block.connection.pinned ? "Yes" : "No") : "");
    add("itemCount", "Items", getItemCount(block));
    add("attachment", "File", formatAttachment(block?.attachment), { href: block?.attachment?.url });

    if (enabled.has("customMetadata")) {
        addCustomMetadata(items, block?.metadata, "customMetadata", "");
        addCustomMetadata(items, block?.connection?.metadata, "connectionMetadata", "Connection ");
    }

    return items;
};

const getSourceLabel = (block) => {
    if (block?.source?.provider?.name) {
        return block.source.provider.name;
    }
    if (block?.source?.title) {
        return block.source.title;
    }
    if (!block?.linkUrl) {
        return "";
    }
    try {
        return new URL(block.linkUrl).hostname.replace(/^www\./i, "");
    } catch {
        return block.linkUrl;
    }
};

const getItemCount = (block) => {
    const count = block?.counts?.contents ?? block?.counts?.blocks;
    return Number.isFinite(count) ? `${count}` : "";
};

const formatAttachment = (attachment) => {
    if (!attachment) {
        return "";
    }
    const parts = [];
    if (attachment.fileName) {
        parts.push(attachment.fileName);
    } else if (attachment.extension) {
        parts.push(attachment.extension.toUpperCase());
    }
    if (attachment.contentType) {
        parts.push(attachment.contentType);
    }
    if (Number.isFinite(attachment.fileSize)) {
        parts.push(formatFileSize(attachment.fileSize));
    }
    return parts.join(" · ");
};

const formatFileSize = (bytes) => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatExactDate = (value) => {
    if (!value) {
        return "";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

const normalizeMetaValue = (value) => {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    let full;
    if (Array.isArray(value)) {
        full = value.map(item => serializeValue(item)).filter(Boolean).join(", ");
    } else {
        full = serializeValue(value);
    }
    full = full.replace(/\s+/g, " ").trim();
    if (!full) {
        return null;
    }
    const boundedFull = full.length > MAX_META_FULL_LENGTH ? `${full.slice(0, MAX_META_FULL_LENGTH - 3)}...` : full;
    return {
        full: boundedFull,
        short: boundedFull.length > MAX_META_LENGTH ? `${boundedFull.slice(0, MAX_META_LENGTH - 3)}...` : boundedFull
    };
};

const addCustomMetadata = (items, metadata, keyPrefix, labelPrefix) => {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return;
    }
    Object.entries(metadata).forEach(([key, value]) => {
        const label = humanizeKey(key);
        const normalized = normalizeMetaValue(value);
        if (!label || !normalized) {
            return;
        }
        items.push({
            key: `${keyPrefix}:${key}`,
            label: `${labelPrefix}${label}`,
            value: normalized.short,
            fullValue: normalized.full,
            href: null
        });
    });
};

const serializeValue = (value) => {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch {
            return "";
        }
    }
    return `${value}`;
};

const humanizeKey = (value) => `${value}`
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
