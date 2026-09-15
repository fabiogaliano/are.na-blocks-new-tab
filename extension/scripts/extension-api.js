const isBrowserStyle = typeof browser !== "undefined" && !!browser.storage;
const api = isBrowserStyle ? browser : typeof chrome !== "undefined" ? chrome : null;

if (!api) {
    throw new Error("No extension API detected. This code must run in a WebExtension context.");
}

function promisify(namespace, methodName) {
    const method = namespace[methodName];
    if (typeof method !== "function") {
        throw new Error(`Missing method ${methodName}`);
    }
    
    const handleCallback = (resolve, reject) => (result) => {
        const error = api.runtime?.lastError;
        return error ? reject(new Error(error.message)) : resolve(result);
    };
    
    return isBrowserStyle
        ? (...args) => method.apply(namespace, args)
        : (...args) => new Promise((resolve, reject) => {
            try {
                method.call(namespace, ...args, handleCallback(resolve, reject));
            } catch (err) {
                reject(err);
            }
        });
}

export const extensionApi = api;

export const storage = {
    get: promisify(api.storage.local, "get"),
    set: promisify(api.storage.local, "set"),
    remove: promisify(api.storage.local, "remove"),
    clear: promisify(api.storage.local, "clear"),
    onChanged: api.storage.onChanged
};

export const runtime = {
    sendMessage: promisify(api.runtime, "sendMessage"),
    getURL: (...args) => api.runtime.getURL(...args),
    onMessage: api.runtime.onMessage,
    onInstalled: api.runtime.onInstalled,
    onStartup: api.runtime.onStartup
};

export const bookmarks = api.bookmarks
    ? {
          getTree: promisify(api.bookmarks, "getTree"),
          getChildren: promisify(api.bookmarks, "getChildren"),
          get: promisify(api.bookmarks, "get"),
          getSubTree: promisify(api.bookmarks, "getSubTree"),
          search: promisify(api.bookmarks, "search"),
          create: promisify(api.bookmarks, "create"),
          move: promisify(api.bookmarks, "move"),
          update: promisify(api.bookmarks, "update"),
          remove: promisify(api.bookmarks, "remove"),
          removeTree: promisify(api.bookmarks, "removeTree"),
          onCreated: api.bookmarks.onCreated,
          onChanged: api.bookmarks.onChanged,
          onMoved: api.bookmarks.onMoved,
          onRemoved: api.bookmarks.onRemoved,
          onChildrenReordered: api.bookmarks.onChildrenReordered
      }
    : null;

export const tabs = api.tabs
    ? { create: promisify(api.tabs, "create") }
    : null;

export const alarms = api.alarms
    ? {
          create: promisify(api.alarms, "create"),
          clear: promisify(api.alarms, "clear"),
          onAlarm: api.alarms.onAlarm
      }
    : null;

export function addListenerSafe(event, listener) {
    if (event && typeof event.addListener === "function") {
        event.addListener(listener);
    }
}
