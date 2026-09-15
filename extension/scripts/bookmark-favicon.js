const extensionRuntime = globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
const userAgent = typeof navigator === "object" ? navigator.userAgent.toLowerCase() : "";
const isFirefox = userAgent.includes("firefox");
const isChromium = !isFirefox && /chrome|chromium|crios|edg|opr|vivaldi/.test(userAgent);

export function getFaviconUrl(pageUrl) {
    if (!pageUrl) {
        return null;
    }
    if (isChromium && extensionRuntime?.getURL) {
        const url = new URL(extensionRuntime.getURL("/_favicon/"));
        url.searchParams.set("pageUrl", pageUrl);
        url.searchParams.set("size", "32");
        return url.toString();
    }
    if (isFirefox) {
        return `chrome://favicon/size/32@1x/${pageUrl}`;
    }
    return null;
}

export function applyFavicon(img, pageUrl) {
    if (!img) {
        return;
    }
    const remoteUrl = `https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(pageUrl || "")}`;
    const localUrl = getFaviconUrl(pageUrl);
    img.referrerPolicy = "no-referrer";
    if (localUrl) {
        img.src = localUrl;
        img.onerror = () => {
            img.onerror = () => img.remove();
            img.src = remoteUrl;
        };
    } else {
        img.src = remoteUrl;
        img.onerror = () => img.remove();
    }
}
