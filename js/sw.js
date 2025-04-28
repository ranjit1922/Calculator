importScripts('/js/idb-keyval.js');

const CACHE_VERSION = 'v1';
const CACHE_NAME = `smart-calculator-cache-${CACHE_VERSION}`;
const EXPIRY_DAYS = 10;

const STATIC_ASSETS = [
  '/', '/index.html', '/css/style.css', '/css/media.css', '/css/utils.css', '/js/script.js', '/js/ui.js', '/images/favicon/favicon.ico'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await cache.addAll(STATIC_ASSETS);
      await idbKeyval.set('cacheTimestamp', Date.now());
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(event.request);
    const cacheTimestamp = await idbKeyval.get('cacheTimestamp') || 0;
    const now = Date.now();

    if (cachedResponse) {
      if (now - cacheTimestamp > EXPIRY_DAYS * 86400000 && navigator.onLine) {
        try {
          const fresh = await fetch(event.request);
          cache.put(event.request, fresh.clone());
          await idbKeyval.set('cacheTimestamp', now);
          return fresh;
        } catch (e) {
          return cachedResponse;
        }
      }
      return cachedResponse;
    } else {
      try {
        const network = await fetch(event.request);
        cache.put(event.request, network.clone());
        await idbKeyval.set('cacheTimestamp', now);
        return network;
      } catch (e) {
        return await caches.match('/index.html');
      }
    }
  })());
});

self.addEventListener('sync', async (event) => {
  if (event.tag === 'sync-cache') {
    try {
      const cache = await caches.open(CACHE_NAME);
      for (let url of STATIC_ASSETS) {
        const res = await fetch(url);
        cache.put(url, res.clone());
      }
      await idbKeyval.set('cacheTimestamp', Date.now());
      self.registration.showNotification('Smart Calculator Updated!', { body: 'Latest assets cached.', icon: '/images/icon/icon-192x192.png' });
    } catch (e) {
      console.error('Background sync failed', e);
    }
  }
});
