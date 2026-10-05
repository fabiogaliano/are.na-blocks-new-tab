import { fetchArenaMe, fetchArenaUserContentsPage, fetchArenaUserFollowingPage } from "./arena-client.js";

const normalizeUser = (user) => ({
    id: user?.id ? `${user.id}` : null,
    name: user?.name || "Are.na user",
    slug: user?.slug || null,
    avatarUrl: typeof user?.avatar === "string" ? user.avatar : null
});

const normalizeChannel = (channel) => ({
    id: channel?.id ? `${channel.id}` : null,
    slug: channel?.slug || null,
    title: channel?.title || channel?.slug || "Untitled channel",
    visibility: channel?.visibility || null,
    ownerName: channel?.owner?.name || null,
    contentCount: Number.isFinite(channel?.counts?.contents) ? channel.counts.contents : 0
});

const readChannels = (payload) => {
    const channels = Array.isArray(payload?.data)
        ? payload.data.filter(item => item?.type === "Channel" && item.slug).map(normalizeChannel)
        : [];
    return channels.filter((channel, index, list) => list.findIndex(item => item.slug === channel.slug) === index);
};

export const connectArenaAccount = async (token, signal) => {
    const normalizedToken = typeof token === "string" ? token.trim() : "";
    if (!normalizedToken) {
        throw new Error("Enter an Are.na personal access token.");
    }
    const user = await fetchArenaMe({ token: normalizedToken, signal });
    return {
        token: normalizedToken,
        user: normalizeUser(user)
    };
};

export const loadArenaAccountCatalog = async ({ token, user, signal }) => {
    if (!token || !user?.slug) {
        return {
            ownedChannels: [],
            followedChannels: [],
            ownedTotal: 0,
            followedTotal: 0
        };
    }

    const [ownedPayload, followedPayload] = await Promise.all([
        fetchArenaUserContentsPage(user.slug, {
            page: 1,
            per: 100,
            sort: "updated_at_desc",
            type: "Channel",
            token,
            signal
        }),
        fetchArenaUserFollowingPage(user.slug, {
            page: 1,
            per: 100,
            sort: "created_at_desc",
            type: "Channel",
            token,
            signal
        })
    ]);

    return {
        ownedChannels: readChannels(ownedPayload),
        followedChannels: readChannels(followedPayload),
        ownedTotal: Number(ownedPayload?.meta?.total_count) || 0,
        followedTotal: Number(followedPayload?.meta?.total_count) || 0
    };
};

const INDEX_PER_PAGE = 100;
const INDEX_MAX_PAGES = 10;

// One page of the account's channel lists carries `updated_at` and counts for a
// hundred channels, where checking them one at a time costs a request each.
// Walks owned channels before followed ones and stops as soon as every wanted
// channel is found; anything still missing is checked on its own by the caller.
export const fetchAccountChannelIndex = async ({ token, user, wanted, signal }) => {
    const index = new Map();
    const remaining = new Set(wanted || []);
    if (!token || !user?.slug || !remaining.size) {
        return index;
    }

    const lists = [
        (page) => fetchArenaUserContentsPage(user.slug, { page, per: INDEX_PER_PAGE, sort: "updated_at_desc", type: "Channel", token, signal }),
        (page) => fetchArenaUserFollowingPage(user.slug, { page, per: INDEX_PER_PAGE, sort: "created_at_desc", type: "Channel", token, signal })
    ];

    for (const fetchPage of lists) {
        for (let page = 1; page <= INDEX_MAX_PAGES && remaining.size; page += 1) {
            const items = (await fetchPage(page))?.data;
            const list = Array.isArray(items) ? items : [];
            list.forEach((item) => {
                if (item?.type === "Channel" && remaining.has(item.slug)) {
                    index.set(item.slug, item);
                    remaining.delete(item.slug);
                }
            });
            if (list.length < INDEX_PER_PAGE) {
                break;
            }
        }
    }

    return index;
};

// Owned and followed channels change when the user curates, not between two
// visits to settings. The reload button is there for the day they just did.
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const isCatalogCurrent = (stored, user, now = Date.now()) =>
    Boolean(stored && user?.slug)
    && stored.userSlug === user.slug
    && Number.isFinite(stored.fetchedAt)
    && now - stored.fetchedAt < CATALOG_MAX_AGE_MS;
