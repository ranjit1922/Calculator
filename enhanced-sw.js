const CACHE_NAME = 'site-cache-v2';
const DB_NAME = 'sync-db-v2';
const SYNC_TAG = 'background-sync';
const PERIODIC_SYNC_TAG = 'periodic-content-sync';
const DEFAULT_ICON = '/images/icon-192.png';
const OFFLINE_PAGE = '/index.html';
const CACHE_PATHS = [
  '/',
  '/index.html',
  '/js/',
  '/json/',
  '/images/',
  '/css/'
];

const RESOURCE_TYPES = {
  text: {
    extensions: ['html', 'js', 'json', 'css', 'txt'],
    compress: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    strategy: 'network-first'
  },
  image: {
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'],
    compress: false,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    strategy: 'cache-first'
  },
  font: {
    extensions: ['woff', 'woff2', 'ttf', 'otf', 'eot'],
    compress: false,
    maxAge: 90 * 24 * 60 * 60 * 1000,
    strategy: 'cache-first'
  }
};

let pendingOperations = {
  updates: 0,
  syncs: 0
};

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(setupCache());
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    cleanOldCaches(),
    registerPeriodicSync(),
    setupDatabase(),
    self.clients.claim()
  ]));
});

self.addEventListener('fetch', event => {
  if (!event.request.url.startsWith(self.location.origin)) return;
  
  if (event.request.method === 'GET' && shouldHandleRequest(event.request)) {
    event.respondWith(handleFetch(event.request));
  } else if (event.request.method !== 'GET') {
    event.respondWith(handleNonGetRequest(event.request));
  }
});

self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(processPendingOperations());
  }
});

self.addEventListener('periodicsync', event => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(updateCachedContent());
  }
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(cleanAllCaches());
  }
});

async function setupDatabase() {
  if (!('indexedDB' in self)) {
    return setupLocalStorageFallback();
  }
  
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, 2);
      
      request.onerror = () => {
        setupLocalStorageFallback().then(resolve).catch(reject);
      };
      
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = event => {
        const db = event.target.result;
        
        if (!db.objectStoreNames.contains('syncQueue')) {
          db.createObjectStore('syncQueue', { keyPath: 'id' });
        }
        
        if (!db.objectStoreNames.contains('etagStore')) {
          db.createObjectStore('etagStore', { keyPath: 'url' });
        }
      };
    } catch (error) {
      setupLocalStorageFallback().then(resolve).catch(reject);
    }
  });
}

function setupLocalStorageFallback() {
  return new Promise(resolve => {
    self._useLocalStorageFallback = true;
    
    if (!self._localStorageData) {
      try {
        const storedData = localStorage.getItem('sw-data');
        self._localStorageData = storedData ? JSON.parse(storedData) : {
          syncQueue: [],
          etagStore: {}
        };
      } catch (error) {
        self._localStorageData = {
          syncQueue: [],
          etagStore: {}
        };
      }
    }
    
    resolve();
  });
}

async function setupCache() {
  if (!('caches' in self)) {
    return setupMemoryCacheFallback();
  }
  
  try {
    const cache = await caches.open(CACHE_NAME);
    const promises = CACHE_PATHS.map(async path => {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to fetch ${path}`);
        await cache.put(path, await processResponse(response));
      } catch (error) {
        console.error(`Cache setup failed for ${path}:`, error);
      }
    });
    
    await Promise.all(promises);
    showNotification('Cache Ready', 'Application is ready for offline use');
  } catch (error) {
    console.error('Cache setup failed:', error);
    await setupMemoryCacheFallback();
  }
}

async function setupMemoryCacheFallback() {
  if (!self._memoryCache) {
    self._memoryCache = new Map();
    self._useMemoryCacheFallback = true;
    
    try {
      const cachedData = localStorage.getItem('sw-cache-data');
      if (cachedData) {
        const parsedData = JSON.parse(cachedData);
        for (const [key, value] of Object.entries(parsedData)) {
          self._memoryCache.set(key, new Response(
            value.body, 
            {
              status: 200,
              headers: new Headers(value.headers)
            }
          ));
        }
      }
    } catch (error) {
      console.error('Memory cache restoration failed:', error);
    }
    
    await Promise.all(CACHE_PATHS.map(async path => {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (response.ok) {
          const clone = response.clone();
          const blob = await clone.blob();
          const headers = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
          
          self._memoryCache.set(new URL(path, self.location).href, response);
          
          try {
            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onloadend = () => {
              try {
                const cacheData = JSON.parse(localStorage.getItem('sw-cache-data') || '{}');
                cacheData[new URL(path, self.location).href] = {
                  body: reader.result,
                  headers
                };
                localStorage.setItem('sw-cache-data', JSON.stringify(cacheData));
              } catch (e) {
                // Storage quota exceeded or other localStorage error
              }
            };
          } catch (e) {
            // FileReader or localStorage error
          }
        }
      } catch (error) {
        console.error(`Memory cache setup failed for ${path}:`, error);
      }
    }));
  }
}

async function cleanOldCaches() {
  const keys = await caches.keys();
  return Promise.all(keys.map(key => {
    if (key !== CACHE_NAME && key.startsWith('site-cache')) {
      return caches.delete(key);
    }
  }).filter(Boolean));
}

async function cleanAllCaches() {
  const keys = await caches.keys();
  return Promise.all(keys.map(key => caches.delete(key)));
}

async function handleFetch(request) {
  const type = getResourceType(request.url);
  const config = RESOURCE_TYPES[type] || RESOURCE_TYPES.text;
  
  try {
    if (self._useMemoryCacheFallback) {
      return await handleMemoryCacheFetch(request, config.strategy);
    }
    
    if (config.strategy === 'cache-first') {
      return await handleCacheFirst(request);
    } else {
      return await handleNetworkFirst(request);
    }
  } catch (error) {
    return handleOfflineFallback(request);
  }
}

async function handleMemoryCacheFetch(request, strategy) {
  const url = new URL(request.url).href;
  
  if (strategy === 'cache-first') {
    const cachedResponse = self._memoryCache.get(url);
    if (cachedResponse) {
      // Try to update in background
      updateMemoryCacheIfNeeded(url).catch(() => {});
      return cachedResponse.clone();
    }
    
    try {
      const response = await fetch(request);
      if (response.ok) {
        self._memoryCache.set(url, response.clone());
        saveToLocalStorageCache(url, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      // If network fails, we have no cached response
      return new Response('Offline', { status: 503 });
    }
  } else { // network-first
    try {
      const response = await fetch(request);
      if (response.ok) {
        self._memoryCache.set(url, response.clone());
        saveToLocalStorageCache(url, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      const cachedResponse = self._memoryCache.get(url);
      if (cachedResponse) {
        return cachedResponse.clone();
      }
      
      return new Response('Offline', { status: 503 });
    }
  }
}

async function saveToLocalStorageCache(url, response) {
  try {
    const blob = await response.blob();
    const reader = new FileReader();
    
    return new Promise((resolve, reject) => {
      reader.onloadend = () => {
        try {
          const headers = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
          
          const cacheData = JSON.parse(localStorage.getItem('sw-cache-data') || '{}');
          cacheData[url] = {
            body: reader.result,
            headers
          };
          
          localStorage.setItem('sw-cache-data', JSON.stringify(cacheData));
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('Failed to save to localStorage cache:', error);
  }
}

async function updateMemoryCacheIfNeeded(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (response.ok) {
      self._memoryCache.set(url, response.clone());
      await saveToLocalStorageCache(url, response.clone());
    }
  } catch (error) {
    // Silently fail
  }
}

async function handleCacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  
  if (cached) {
    const networkPromise = updateResourceIfNeeded(request, cached);
    networkPromise.catch(() => {}); // Handle silently
    return cached;
  }
  
  try {
    const response = await fetch(request);
    if (!response.ok) throw new Error('Network response was not ok');
    
    await cache.put(request, await processResponse(response.clone()));
    return response;
  } catch (error) {
    throw error;
  }
}

async function handleNetworkFirst(request) {
  try {
    const etag = await getStoredEtag(request.url);
    const headers = new Headers(request.headers);
    
    if (etag) {
      headers.append('If-None-Match', etag.etag);
      if (etag.lastModified) {
        headers.append('If-Modified-Since', etag.lastModified);
      }
    }
    
    const fetchRequest = new Request(request, { headers });
    const response = await fetch(fetchRequest);
    
    if (response.status === 304) {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request);
      if (cachedResponse) return cachedResponse;
    }
    
    if (!response.ok) throw new Error('Network response was not ok');
    
    const processedResponse = await processResponse(response.clone());
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, processedResponse);
    
    const newEtag = response.headers.get('ETag');
    const lastModified = response.headers.get('Last-Modified');
    
    if (newEtag || lastModified) {
      await storeEtag(request.url, newEtag, lastModified);
    }
    
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function handleNonGetRequest(request) {
  try {
    const response = await fetch(request);
    if (!response.ok) throw new Error('Network response was not ok');
    return response;
  } catch (error) {
    await addToSyncQueue(request);
    showNotification('Offline Action Queued', 'Will complete when online');
    
    return new Response(JSON.stringify({
      error: 'offline',
      message: 'Request queued for background sync'
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 503
    });
  }
}

async function addToSyncQueue(request) {
  pendingOperations.syncs++;
  updateBadge();
  
  const id = Date.now().toString();
  const data = {
    id,
    url: request.url,
    method: request.method,
    headers: Array.from(request.headers.entries()),
    body: await request.clone().text(),
    timestamp: Date.now()
  };
  
  await saveToSyncQueue(data);
  
  if ('sync' in self.registration) {
    await self.registration.sync.register(SYNC_TAG);
  } else {
    // Fallback for browsers without Background Sync API
    setTimeout(() => {
      processPendingOperations().catch(console.error);
    }, 5000); // Try to process after 5 seconds
  }
}

async function saveToSyncQueue(data) {
  if (self._useLocalStorageFallback) {
    return saveToLocalStorageSyncQueue(data);
  }
  
  try {
    const db = await openDB();
    const tx = db.transaction('syncQueue', 'readwrite');
    await tx.objectStore('syncQueue').add(data);
    await tx.complete;
    db.close();
  } catch (error) {
    console.error('Failed to save to IndexedDB queue:', error);
    return saveToLocalStorageSyncQueue(data);
  }
}

async function saveToLocalStorageSyncQueue(data) {
  try {
    self._localStorageData.syncQueue.push(data);
    localStorage.setItem('sw-data', JSON.stringify(self._localStorageData));
  } catch (error) {
    console.error('Failed to save to localStorage queue:', error);
  }
}

async function getSyncQueue() {
  if (self._useLocalStorageFallback) {
    return self._localStorageData.syncQueue;
  }
  
  try {
    const db = await openDB();
    const tx = db.transaction('syncQueue', 'readonly');
    const items = await tx.objectStore('syncQueue').getAll();
    db.close();
    return items;
  } catch (error) {
    console.error('Failed to get from IndexedDB queue:', error);
    return self._localStorageData?.syncQueue || [];
  }
}

async function removeFromSyncQueue(id) {
  if (self._useLocalStorageFallback) {
    return removeFromLocalStorageSyncQueue(id);
  }
  
  try {
    const db = await openDB();
    const tx = db.transaction('syncQueue', 'readwrite');
    await tx.objectStore('syncQueue').delete(id);
    await tx.complete;
    db.close();
  } catch (error) {
    console.error('Failed to remove from IndexedDB queue:', error);
    return removeFromLocalStorageSyncQueue(id);
  }
}

async function removeFromLocalStorageSyncQueue(id) {
  try {
    const index = self._localStorageData.syncQueue.findIndex(item => item.id === id);
    if (index !== -1) {
      self._localStorageData.syncQueue.splice(index, 1);
      localStorage.setItem('sw-data', JSON.stringify(self._localStorageData));
    }
  } catch (error) {
    console.error('Failed to remove from localStorage queue:', error);
  }
}

async function storeEtag(url, etag, lastModified) {
  if (self._useLocalStorageFallback) {
    return storeLocalStorageEtag(url, etag, lastModified);
  }
  
  try {
    const db = await openDB();
    const tx = db.transaction('etagStore', 'readwrite');
    await tx.objectStore('etagStore').put({
      url,
      etag,
      lastModified,
      timestamp: Date.now()
    });
    await tx.complete;
    db.close();
  } catch (error) {
    console.error('Failed to store ETag in IndexedDB:', error);
    return storeLocalStorageEtag(url, etag, lastModified);
  }
}

async function storeLocalStorageEtag(url, etag, lastModified) {
  try {
    self._localStorageData.etagStore[url] = {
      url,
      etag,
      lastModified,
      timestamp: Date.now()
    };
    localStorage.setItem('sw-data', JSON.stringify(self._localStorageData));
  } catch (error) {
    console.error('Failed to store ETag in localStorage:', error);
  }
}

async function getStoredEtag(url) {
  if (self._useLocalStorageFallback) {
    return self._localStorageData.etagStore[url];
  }
  
  try {
    const db = await openDB();
    const tx = db.transaction('etagStore', 'readonly');
    const item = await tx.objectStore('etagStore').get(url);
    db.close();
    return item;
  } catch (error) {
    console.error('Failed to get ETag from IndexedDB:', error);
    return self._localStorageData?.etagStore?.[url];
  }
}

async function processPendingOperations() {
  const queue = await getSyncQueue();
  let successCount = 0;
  
  for (const item of queue) {
    try {
      const response = await fetch(new Request(item.url, {
        method: item.method,
        headers: new Headers(item.headers),
        body: item.body,
        mode: 'same-origin'
      }));
      
      if (response.ok) {
        await removeFromSyncQueue(item.id);
        successCount++;
        pendingOperations.syncs--;
      }
    } catch (error) {
      console.error('Sync operation failed:', error);
    }
  }
  
  updateBadge();
  if (successCount > 0) {
    showNotification('Sync Complete', `${successCount} operations completed`);
  }
  
  return successCount;
}

function openDB() {
  if (self._useLocalStorageFallback) {
    return Promise.resolve({
      transaction: () => ({
        objectStore: () => ({
          add: data => Promise.resolve(saveToLocalStorageSyncQueue(data)),
          put: data => Promise.resolve(storeLocalStorageEtag(data.url, data.etag, data.lastModified)),
          get: url => Promise.resolve(self._localStorageData.etagStore[url]),
          getAll: () => Promise.resolve(self._localStorageData.syncQueue),
          delete: id => Promise.resolve(removeFromLocalStorageSyncQueue(id))
        }),
        complete: Promise.resolve()
      }),
      close: () => {}
    });
  }
  
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME);
      request.onerror = () => {
        self._useLocalStorageFallback = true;
        setupLocalStorageFallback().then(() => {
          resolve({
            transaction: () => ({
              objectStore: () => ({
                add: data => Promise.resolve(saveToLocalStorageSyncQueue(data)),
                put: data => Promise.resolve(storeLocalStorageEtag(data.url, data.etag, data.lastModified)),
                get: url => Promise.resolve(self._localStorageData.etagStore[url]),
                getAll: () => Promise.resolve(self._localStorageData.syncQueue),
                delete: id => Promise.resolve(removeFromLocalStorageSyncQueue(id))
              }),
              complete: Promise.resolve()
            }),
            close: () => {}
          });
        }).catch(reject);
      };
      request.onsuccess = () => resolve(request.result);
    } catch (error) {
      self._useLocalStorageFallback = true;
      setupLocal

async function processResponse(response) {
  const type = getResourceType(response.url);
  const config = RESOURCE_TYPES[type] || RESOURCE_TYPES.text;
  
  if (!config.compress) return response;
  
  try {
    const blob = await response.blob();
    const compressed = await compressData(blob);
    
    const headers = new Headers(response.headers);
    headers.set('Content-Length', compressed.size.toString());
    headers.set('X-Compressed', 'true');
    headers.set('X-Cached-On', Date.now().toString());
    
    return new Response(compressed, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch (error) {
    return response;
  }
}

async function compressData(blob) {
  if ('CompressionStream' in self) {
    try {
      const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
      return new Blob([await new Response(stream).arrayBuffer()]);
    } catch (error) {
      console.error('Compression failed:', error);
    }
  }
  
  return blob;
}

function getResourceType(url) {
  const extension = url.split('.').pop()?.toLowerCase();
  if (!extension) return 'text';
  
  for (const [type, config] of Object.entries(RESOURCE_TYPES)) {
    if (config.extensions.includes(extension)) {
      return type;
    }
  }
  
  return 'text';
}

async function updateResourceIfNeeded(request, cached) {
  const cachedDate = parseInt(cached.headers.get('X-Cached-On') || '0');
  const type = getResourceType(request.url);
  const maxAge = RESOURCE_TYPES[type]?.maxAge || RESOURCE_TYPES.text.maxAge;
  
  if (Date.now() - cachedDate > maxAge) {
    return updateResource(request.url);
  }
  
  return null;
}

async function updateResource(url) {
  try {
    const etag = await getStoredEtag(url);
    const headers = new Headers();
    
    if (etag) {
      headers.append('If-None-Match', etag.etag);
      if (etag.lastModified) {
        headers.append('If-Modified-Since', etag.lastModified);
      }
    }
    
    const response = await fetch(url, {
      cache: 'no-store',
      headers
    });
    
    if (response.status === 304) {
      return null;
    }
    
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      const processedResponse = await processResponse(response);
      await cache.put(url, processedResponse);
      
      const newEtag = response.headers.get('ETag');
      const lastModified = response.headers.get('Last-Modified');
      
      if (newEtag || lastModified) {
        await storeEtag(url, newEtag, lastModified);
      }
      
      return processedResponse;
    }
  } catch (error) {
    console.error(`Update failed for ${url}:`, error);
  }
  
  return null;
}

async function updateCachedContent() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const updatePromises = keys.map(async request => {
    const cached = await cache.match(request);
    return updateResourceIfNeeded(request, cached);
  });
  
  await Promise.all(updatePromises);
}

async function handleOfflineFallback(request) {
  if (request.mode === 'navigate') {
    if (self._useMemoryCacheFallback) {
      const offlinePage = self._memoryCache.get(new URL(OFFLINE_PAGE, self.location).href);
      if (offlinePage) {
        return offlinePage.clone();
      }
      
      const indexPage = self._memoryCache.get(new URL('/index.html', self.location).href);
      if (indexPage) {
        return indexPage.clone();
      }
      
      return new Response('<html><body><h1>Offline</h1><p>The app is currently offline.</p></body></html>', {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    try {
      const cache = await caches.open(CACHE_NAME);
      const offlinePage = await cache.match(OFFLINE_PAGE);
      
      if (offlinePage) {
        return offlinePage;
      }
      
      return cache.match('/index.html') || new Response('<html><body><h1>Offline</h1><p>The app is currently offline.</p></body></html>', {
        headers: { 'Content-Type': 'text/html' }
      });
    } catch (error) {
      return new Response('<html><body><h1>Offline</h1><p>The app is currently offline.</p></body></html>', {
        headers: { 'Content-Type': 'text/html' }
      });
    }
  }
  
  if (request.destination === 'image') {
    if (self._useMemoryCacheFallback) {
      const fallbackImage = self._memoryCache.get(new URL('/images/offline-image.png', self.location).href);
      if (fallbackImage) {
        return fallbackImage.clone();
      }
    } else {
      try {
        const cache = await caches.open(CACHE_NAME);
        const fallbackImage = await cache.match('/images/offline-image.png');
        if (fallbackImage) return fallbackImage;
      } catch (error) {
        // Continue to default response
      }
    }
  }
  
  return new Response('Offline content unavailable', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' }
  });
}

function showNotification(title, body, options = {}) {
  if (!('Notification' in self) || Notification.permission !== 'granted') {
    // Fallback for browsers without Notification API
    self.clients.matchAll().then(clients => {
      if (clients.length > 0) {
        clients[0].postMessage({
          type: 'SW_NOTIFICATION',
          payload: {
            title,
            body,
            timestamp: Date.now()
          }
        });
      }
    }).catch(() => {});
    return;
  }
  
  return self.registration.showNotification(title, {
    body,
    icon: DEFAULT_ICON,
    badge: DEFAULT_ICON,
    tag: options.tag || 'default',
    data: {
      timestamp: Date.now(),
      ...options.data
    },
    actions: options.actions || []
  });
}

function updateBadge() {
  if ('setAppBadge' in navigator) {
    const total = pendingOperations.updates + pendingOperations.syncs;
    total > 0 ? navigator.setAppBadge(total) : navigator.clearAppBadge();
  } else {
    // Fallback for browsers without Badge API
    self.clients.matchAll().then(clients => {
      if (clients.length > 0) {
        const total = pendingOperations.updates + pendingOperations.syncs;
        if (total > 0) {
          clients[0].postMessage({
            type: 'SW_BADGE',
            payload: {
              count: total
            }
          });
        }
      }
    }).catch(() => {});
  }
}

async function registerPeriodicSync() {
  if ('periodicSync' in self.registration) {
    try {
      const permissions = await navigator.permissions.query({
        name: 'periodic-background-sync'
      });
      
      if (permissions.state === 'granted') {
        await self.registration.periodicSync.register(PERIODIC_SYNC_TAG, {
          minInterval: 24 * 60 * 60 * 1000
        });
      }
    } catch (error) {
      console.error('Periodic sync registration failed:', error);
      // Fallback for browsers without Periodic Sync API
      setupPeriodicSyncFallback();
    }
  } else {
    // Fallback for browsers without Periodic Sync API
    setupPeriodicSyncFallback();
  }
}

function setupPeriodicSyncFallback() {
  // Check if we already have a fallback interval
  if (self._periodicSyncFallbackId) {
    return;
  }
  
  // Create an interval that checks for updates every hour when the page is open
  const HOUR = 60 * 60 * 1000;
  
  self._periodicSyncFallbackId = setInterval(() => {
    self.clients.matchAll().then(clients => {
      if (clients.length > 0) {
        // Only update if a client is open
        updateCachedContent().catch(console.error);
      }
    }).catch(() => {});
  }, HOUR);
  
  // Also register for client message events to handle manual sync requests
  self.addEventListener('message', event => {
    if (event.data && event.data.type === 'MANUAL_SYNC') {
      event.waitUntil(updateCachedContent());
    }
  });
}

function shouldHandleRequest(request) {
  const url = new URL(request.url);
  return CACHE_PATHS.some(path => 
    url.pathname === path || 
    url.pathname.startsWith(path.replace('*', ''))
  );
}