import { BLOCK_TYPES } from "./constants.js";
import { fetchArenaBlock, fetchArenaChannel, fetchArenaChannelContentsPage, fetchArenaFeedPage } from "./arena-client.js";
import { sanitizeHtml, toPlainText } from "./sanitize.js";

const PER_PAGE = 100;
const MAX_PAGES = 10;
const REQUEST_BATCH = 4;

export const getChannelRequestCost = (contentCount) => {
    const pages = Math.ceil((Number(contentCount) || 0) / PER_PAGE);
    return 1 + Math.min(Math.max(pages, 1), MAX_PAGES);
};

const safeUrl = (url) => {
    if (!url) return null;
    try {
        const inspected = new URL(url);
        return inspected.protocol.startsWith("http") ? inspected.toString() : null;
    } catch {
        return null;
    }
};
const getRenderedHtml = (value) => sanitizeHtml(value?.html || "");
const getRenderedPlainText = (value) => value?.plain || toPlainText(value?.html || "") || value?.markdown || "";

const deriveTitle = (item) =>
    item.title || item.source?.title || getRenderedPlainText(item.content) || getRenderedPlainText(item.description) || `${item.type || "Block"} ${item.id}`;

const buildArenaUrl = (item) => {
    if (!item) return null;
    if (item.type === "Channel" && item.owner?.slug && item.slug) {
        return `https://www.are.na/${encodeURIComponent(item.owner.slug)}/${encodeURIComponent(item.slug)}`;
    }
    if (item.id) {
        return `https://www.are.na/block/${item.id}`;
    }
    return null;
};

const normalizeOwner = (owner) => {
    if (!owner) return null;
    return {
        id: owner.id ? `${owner.id}` : null,
        type: owner.type || null,
        name: owner.name || null,
        slug: owner.slug || null,
        avatarUrl: safeUrl(owner.avatar),
        initials: owner.initials || null
    };
};

const normalizeSource = (source) => {
    if (!source) return null;
    return {
        url: safeUrl(source.url),
        title: source.title || null,
        provider: source.provider
            ? {
                  name: source.provider.name || null,
                  url: safeUrl(source.provider.url)
              }
            : null
    };
};

const normalizeCounts = (counts) => {
    if (!counts) return null;
    return {
        blocks: Number.isFinite(counts.blocks) ? counts.blocks : null,
        channels: Number.isFinite(counts.channels) ? counts.channels : null,
        contents: Number.isFinite(counts.contents) ? counts.contents : null,
        collaborators: Number.isFinite(counts.collaborators) ? counts.collaborators : null
    };
};

const normalizeMetadataValue = (value, depth = 0) => {
    if (value === null || value === undefined || depth > 2) {
        return null;
    }
    if (typeof value === "string") {
        return value.slice(0, 1000);
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.slice(0, 20).map(item => normalizeMetadataValue(item, depth + 1));
    }
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .slice(0, 20)
                .map(([key, item]) => [key.slice(0, 80), normalizeMetadataValue(item, depth + 1)])
        );
    }
    return `${value}`.slice(0, 1000);
};

const normalizeMetadata = (metadata) => {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return null;
    }
    const entries = Object.entries(metadata).slice(0, 30);
    return entries.length
        ? Object.fromEntries(entries.map(([key, value]) => [key.slice(0, 80), normalizeMetadataValue(value)]))
        : null;
};

const normalizeConnection = (connection) => {
    if (!connection) return null;
    return {
        id: connection.id ? `${connection.id}` : null,
        position: Number.isFinite(connection.position) ? connection.position : null,
        pinned: typeof connection.pinned === "boolean" ? connection.pinned : null,
        connectedAt: connection.connected_at || null,
        connectedBy: normalizeOwner(connection.connected_by),
        metadata: normalizeMetadata(connection.metadata)
    };
};

const extractImageVersions = (image) => {
    if (!image) return null;

    const readVersion = (version) => {
        if (!version) return null;
        const src = safeUrl(version.src);
        const src2x = safeUrl(version.src_2x);

        if (!src && !src2x) {
            return null;
        }

        return {
            src,
            src2x,
            width: Number.isFinite(version.width) ? version.width : null,
            height: Number.isFinite(version.height) ? version.height : null
        };
    };

    return {
        original: {
            src: safeUrl(image.src),
            width: Number.isFinite(image.width) ? image.width : null,
            height: Number.isFinite(image.height) ? image.height : null
        },
        small: readVersion(image.small),
        medium: readVersion(image.medium),
        large: readVersion(image.large),
        square: readVersion(image.square)
    };
};

const extractImage = (item) =>
    safeUrl(
        item.image?.small?.src_2x ||
        item.image?.small?.src ||
        item.image?.medium?.src ||
        item.image?.large?.src ||
        item.image?.src
    );

const extractAttachment = (item) => {
    if (!item.attachment) return null;
    const { url, filename, file_name, file_extension, extension, content_type, file_size } = item.attachment;
    return {
        url: safeUrl(url),
        fileName: filename || file_name || null,
        extension: file_extension || extension || null,
        contentType: content_type || null,
        fileSize: Number.isFinite(file_size) ? file_size : null
    };
};

const extractEmbed = (item) => {
    if (!item.embed) return null;
    const { url, html, type, title, author_name, author_url, thumbnail_url, width, height } = item.embed;
    return {
        url: safeUrl(url),
        html: sanitizeHtml(html || ""),
        type: type || null,
        title: title || null,
        authorName: author_name || null,
        authorUrl: safeUrl(author_url),
        thumbnailUrl: safeUrl(thumbnail_url),
        width: Number.isFinite(width) ? width : null,
        height: Number.isFinite(height) ? height : null
    };
};

const normalizeArenaItem = (item, context = {}) => {
    const kind = item.type || item.base_type || "Unknown";
    const descriptionHtml = getRenderedHtml(item.description);
    const contentHtml = getRenderedHtml(item.content);
    const descriptionText = getRenderedPlainText(item.description);
    const contentText = getRenderedPlainText(item.content);
    const owner = normalizeOwner(item.owner || item.user);
    const source = normalizeSource(item.source);
    const sourceChannel = context.sourceChannel || null;
    const channel = kind === "Channel"
        ? {
              title: item.title || null,
              slug: item.slug || null
          }
        : sourceChannel;

    return {
        id: `${item.id}`,
        kind,
        type: kind,
        slug: item.slug || null,
        title: deriveTitle(item),
        arenaUrl: buildArenaUrl(item),
        descriptionHtml,
        descriptionText,
        contentHtml,
        contentText,
        createdAt: item.created_at || null,
        updatedAt: item.updated_at || null,
        state: item.state || null,
        visibility: item.visibility || null,
        metadata: normalizeMetadata(item.metadata),
        commentCount: Number.isFinite(item.comment_count) ? item.comment_count : null,
        owner,
        author: owner?.name || null,
        source,
        linkUrl: source?.url || null,
        imageUrl: extractImage(item),
        imageVersions: extractImageVersions(item.image),
        imageAlt: item.image?.alt_text || null,
        imageAspectRatio: Number.isFinite(item.image?.aspect_ratio) ? item.image.aspect_ratio : null,
        attachment: extractAttachment(item),
        embed: extractEmbed(item),
        channel,
        sourceChannel,
        connection: normalizeConnection(item.connection),
        counts: normalizeCounts(item.counts)
    };
};

export const fetchChannelBlocks = async (slug, signal, onProgress, token) => {
    const [channel, firstPage] = await Promise.all([
        fetchArenaChannel(slug, { signal, token }),
        fetchArenaChannelContentsPage(slug, { page: 1, per: PER_PAGE, sort: "position_asc", signal, token })
    ]);

    const totalPages = Math.min(firstPage?.meta?.total_pages || 1, MAX_PAGES);
    const orderedPages = [{ page: 1, payload: firstPage }];

    for (let start = 2; start <= totalPages; start += REQUEST_BATCH) {
        const batch = [];
        for (let page = start; page < start + REQUEST_BATCH && page <= totalPages; page += 1) {
            batch.push(
                fetchArenaChannelContentsPage(slug, { page, per: PER_PAGE, sort: "position_asc", signal, token })
                    .then((payload) => ({ page, payload }))
            );
        }

        const settled = await Promise.allSettled(batch);
        const failure = settled.find((result) => result.status === "rejected");
        if (failure) {
            throw failure.reason;
        }

        orderedPages.push(...settled.map((result) => result.value));
    }

    orderedPages.sort((left, right) => left.page - right.page);

    const normalized = [];
    for (const { page, payload } of orderedPages) {
        const contents = Array.isArray(payload?.data) ? payload.data : [];
        normalized.push(
            ...contents.map((item) => normalizeArenaItem(item, {
                sourceChannel: {
                    title: channel.title,
                    slug: channel.slug
                }
            }))
        );

        if (typeof onProgress === "function") {
            onProgress({
                slug,
                title: channel.title || slug,
                page,
                total: payload?.meta?.total_count || channel.counts?.contents || normalized.length
            });
        }
    }

    return normalized;
};

export const fetchBlocksById = async (ids, signal, token) => {
    const responses = [];

    for (let start = 0; start < ids.length; start += REQUEST_BATCH) {
        const batch = ids.slice(start, start + REQUEST_BATCH);
        responses.push(...await Promise.all(batch.map((id) => fetchArenaBlock(id, { signal, token }))));
    }

    return responses.map((item) => normalizeArenaItem(item));
};

export const fetchFeedBlocks = async (token, signal) => {
    if (!token) {
        return [];
    }
    const payload = await fetchArenaFeedPage({ limit: 100, token, signal });
    const activities = Array.isArray(payload?.data) ? payload.data : [];
    const items = [];

    activities.forEach((activity) => {
        const candidates = [activity?.item, activity?.target, activity?.parent];
        candidates.forEach((item) => {
            if (!item || !BLOCK_TYPES.includes(item.type)) {
                return;
            }
            const sourceChannel = item.type !== "Channel" && activity?.target?.type === "Channel"
                ? {
                      title: activity.target.title || null,
                      slug: activity.target.slug || null
                  }
                : null;
            items.push(normalizeArenaItem(item, { sourceChannel }));
        });
    });

    return items.filter((item, index, list) => list.findIndex(candidate => candidate.id === item.id) === index);
};

// Channels stream out one at a time because each is a resumable unit; blocks
// fetched by id and from the feed are returned together because they are not.
export const fetchSourceBlocks = async ({
    channelSlugs = [],
    blockIds = [],
    filters = BLOCK_TYPES,
    includeFeed = false,
    token = "",
    signal,
    onProgress,
    onChannelBlocks,
    freshSlugs = null
}) => {
    const allowedTypes = new Set(filters?.length ? filters : BLOCK_TYPES);
    const allowed = (blocks) => blocks.filter((block) => allowedTypes.has(block.kind));

    for (const slug of channelSlugs) {
        if (freshSlugs?.has(slug)) {
            continue;
        }

        // `fetchChannelBlocks` cannot report before its pages land, which is the
        // whole download. Naming the slug first is what makes progress live; the
        // title replaces it once the channel itself has been read.
        onProgress?.({ slug, title: null });
        const blocks = allowed(await fetchChannelBlocks(slug, signal, onProgress, token));
        if (typeof onChannelBlocks === "function") {
            await onChannelBlocks(slug, blocks);
        }
    }

    const standaloneBlocks = [];

    if (blockIds.length) {
        standaloneBlocks.push(...allowed(await fetchBlocksById(blockIds, signal, token)));
    }

    if (includeFeed && token) {
        standaloneBlocks.push(...allowed(await fetchFeedBlocks(token, signal)));
    }

    return { standaloneBlocks };
};

// Returns ids, not blocks: the block records are in the block store and the
// caller fetches only the few it is about to render, rather than this module
// reaching into storage to hand back the whole selection.
export const chooseRandomBlockIds = (cache, count = 1, exclude = []) => {
    const pool = cache?.blockIds || [];
    if (!pool.length) return [];

    const excludeSet = new Set((exclude || []).map(String));
    const filtered = pool.filter(id => !excludeSet.has(String(id)));
    if (!filtered.length) return [];

    const shuffled = [...filtered];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled.slice(0, Math.min(count, shuffled.length));
};
