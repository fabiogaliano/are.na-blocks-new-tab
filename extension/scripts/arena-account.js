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
