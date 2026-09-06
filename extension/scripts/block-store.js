// Block records live here, keyed one per block, rather than inside the cache
// object in chrome.storage.local.
//
// The cache used to hold every block under a single storage key, so a refresh
// rewrote the whole payload once per channel and a new tab deserialized all of
// it to draw one block. Measured on a 49-channel account (8,282 blocks, ~36 MB)
// that cost 31s of writes per sync and 192ms of render-blocking read per tab.
// Keyed records make both proportional to what is actually touched: a channel
// checkpoint writes only its own blocks, and a new tab reads only the handful it
// is about to show.
//
// What stays in chrome.storage.local is the index — which ids exist, which
// channel each belongs to, when it was fetched. That is small, and every caller
// that only needs a count keeps reading it exactly as before.

const DB_NAME = "arenaBlockCache";
const DB_VERSION = 1;
const STORE = "blocks";

// Are.na ids arrive as numbers from the API but reach us as strings through the
// cache index, and IndexedDB treats those as different keys. Everything is
// coerced on the way in and out so a block written as 12345 is found as "12345".
const asKey = (id) => String(id);

let dbPromise = null;

const openDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "key" });
        }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the block store"));
});

const database = () => {
    if (!dbPromise) {
        // A failed open must not be cached, or every later call inherits it.
        dbPromise = openDatabase().catch((error) => {
            dbPromise = null;
            throw error;
        });
    }
    return dbPromise;
};

const asPromise = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Block store request failed"));
});

const settled = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Block store transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("Block store transaction aborted"));
});

export const putBlocks = async (blocks) => {
    if (!blocks?.length) {
        return;
    }
    const db = await database();
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const block of blocks) {
        store.put({ key: asKey(block.id), block });
    }
    await settled(transaction);
};

// Missing ids are dropped rather than reported: the index is written after the
// blocks it names, so a gap means an interrupted write, and a short render is a
// better answer than a failed one.
export const getBlocks = async (ids) => {
    if (!ids?.length) {
        return [];
    }
    const db = await database();
    const transaction = db.transaction(STORE, "readonly");
    const store = transaction.objectStore(STORE);
    const records = await Promise.all(ids.map((id) => asPromise(store.get(asKey(id)))));
    await settled(transaction);
    return records.filter(Boolean).map((record) => record.block);
};

// Called once a pass completes, not per checkpoint: reconciling on every channel
// would walk every key each time, which is the cost this store exists to avoid.
export const retainBlocks = async (ids) => {
    const db = await database();
    const keep = new Set((ids || []).map(asKey));
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const stored = await asPromise(store.getAllKeys());
    let removed = 0;
    for (const key of stored) {
        if (!keep.has(key)) {
            store.delete(key);
            removed += 1;
        }
    }
    await settled(transaction);
    return removed;
};

export const clearBlocks = async () => {
    const db = await database();
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    await settled(transaction);
};

export const countBlocks = async () => {
    const db = await database();
    const transaction = db.transaction(STORE, "readonly");
    const total = await asPromise(transaction.objectStore(STORE).count());
    await settled(transaction);
    return total;
};
