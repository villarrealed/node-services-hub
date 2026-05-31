// js/cache.js — IndexedDB wrapper for lookups, tasks, events, legs, searches.

const DB_NAME = "wxcc-explorer";
const DB_VERSION = 1;

const STORES = {
  lookups:  { keyPath: "key",   indexes: [["resource","resource"], ["fetchedAt","fetchedAt"]] },
  searches: { keyPath: "key",   indexes: [["fetchedAt","fetchedAt"]] },
  tasks:    { keyPath: "id",    indexes: [["createdTime","createdTime"], ["ani","ani"], ["dnis","dnis"], ["fetchedAt","fetchedAt"]] },
  events:   { keyPath: "key",   indexes: [["taskId","taskId"], ["eventName","eventName"], ["timestamp","timestamp"]] },
  legs:     { keyPath: "id",    indexes: [["taskId","taskId"], ["legType","legType"]] },
  settings: { keyPath: "key",   indexes: [] },
};

const TTL = {
  lookups:  24 * 60 * 60 * 1000,
  searches:      60 * 60 * 1000,
  tasks:    24 * 60 * 60 * 1000,
  events:   24 * 60 * 60 * 1000,
  legs:     24 * 60 * 60 * 1000,
};

let _db;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: def.keyPath });
          for (const [idxName, idxKey] of def.indexes) store.createIndex(idxName, idxKey);
        }
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = "readonly") {
  return openDB().then(db => db.transaction(store, mode).objectStore(store));
}

function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Put a row, stamping fetchedAt. */
export async function put(store, row) {
  const s = await tx(store, "readwrite");
  return asPromise(s.put({ ...row, fetchedAt: Date.now() }));
}

export async function putMany(store, rows) {
  const s = await tx(store, "readwrite");
  await Promise.all(rows.map(r => asPromise(s.put({ ...r, fetchedAt: Date.now() }))));
}

/** Get a row, returning null if missing or stale. */
export async function get(store, key) {
  const s = await tx(store);
  const row = await asPromise(s.get(key));
  if (!row) return null;
  const ttl = TTL[store];
  if (ttl && Date.now() - (row.fetchedAt || 0) > ttl) return null;
  return row;
}

/** Get all rows from a store (no TTL filter — caller decides). */
export async function getAll(store) {
  const s = await tx(store);
  return asPromise(s.getAll());
}

/** Get all rows for an index value (e.g. all events for a taskId). */
export async function getAllByIndex(store, indexName, value) {
  const s = await tx(store);
  const idx = s.index(indexName);
  return asPromise(idx.getAll(value));
}

/** Wipe one store. */
export async function clearStore(store) {
  const s = await tx(store, "readwrite");
  return asPromise(s.clear());
}

/** Wipe everything. */
export async function clearAll() {
  for (const name of Object.keys(STORES)) await clearStore(name);
}
