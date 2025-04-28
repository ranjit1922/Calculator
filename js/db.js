import { openDB } from 'https://cdn.jsdelivr.net/npm/idb@7/build/esm/index.js';

const dbPromise = openDB('smart-calculator-db', 1, {
  upgrade(db) {
    db.createObjectStore('metadata');
    db.createObjectStore('sync-queue', { keyPath: 'url' });
  }
});

export const db = {
  async set(store, key, val) {
    return (await dbPromise).put(store, val, key);
  },
  async get(store, key) {
    return (await dbPromise).get(store, key);
  },
  async delete(store, key) {
    return (await dbPromise).delete(store, key);
  },
  async clear(store) {
    return (await dbPromise).clear(store);
  },
  async keys(store) {
    return (await dbPromise).getAllKeys(store);
  }
};