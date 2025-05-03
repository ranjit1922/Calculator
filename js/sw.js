// Service Worker v4
// Enhanced with: Streams, Background Fetch, IndexedDB integration
// Improved offline functionality and performance optimization

const CACHE_NAME = 'site-cache-v4';
const DB_NAME = 'site-db-v4';
const DB_STORE_NAME = 'resources';
const SYNC_TAG = 'site-background-sync';
const PERIODIC_SYNC_TAG = 'site-periodic-sync';
const DEFAULT_NOTIFICATION_ICON = '/images/notification-icon.png';

// Resource configurations for optimized handling
const RESOURCE_CONFIG = {
  images: {
    cacheDuration: 30 * 24 * 60 * 60 * 1000, // 30 days
    useStream: true,
    useIndexedDB: true,
    useBackgroundFetch: true,
    cachePriority: 'low'
  },
  html: {
    cacheDuration: 7 * 24 * 60 * 60 * 1000, // 7 days
    useStream: false,
    useIndexedDB: false,
    useBackgroundFetch: false,
    cachePriority: 'high'
  },
  css: {
    cacheDuration: 14 * 24 * 60 * 60 * 1000, // 14 days
    useStream: false,
    useIndexedDB: true,
    useBackgroundFetch: false,
    cachePriority: 'high'
  },
  js: {
    cacheDuration: 14 * 24 * 60 * 60 * 1000, // 14 days
    useStream: false,
    useIndexedDB: true,
    useBackgroundFetch: false,
    cachePriority: 'high'
  },
  default: {
    cacheDuration: 7 * 24 * 60 * 60 * 1000, // 7 days
    useStream: false,
    useIndexedDB: false,
    useBackgroundFetch: false,
    cachePriority: 'medium'
  }
};

// Critical resources to precache
const PRECACHE_URLS = [
  './index.html',
  './noscript.html',
  './CSS/main.css',
  './js/app.js'
];

// Pending operations tracking
let pendingOperations = {
  updates: 0,
  downloads: 0,
  syncs: 0
};

// Install event - set up cache and IndexedDB
self.addEventListener('install', event => {
  self.skipWaiting();
  
  event.waitUntil(Promise.all([
    setupCache(),
    setupIndexedDB()
  ]));
});

// Set up the cache with critical resources
async function setupCache() {
  try {
    const cache = await caches.open(CACHE_NAME);
    
    return Promise.all(PRECACHE_URLS.map(async url => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
        await cache.put(url, response);
        console.log(`Cached ${url}`);
      } catch (error) {
        console.error(`Failed to cache ${url}: ${error.message}`);
      }
    }));
  } catch (error) {
    console.error('Cache setup failed:', error);
  }
}

// Set up IndexedDB for resource storage
async function setupIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    
    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(DB_STORE_NAME)) {
        db.createObjectStore(DB_STORE_NAME, { keyPath: 'url' });
        console.log('IndexedDB store created');
      }
    };
    
    request.onsuccess = event => {
      console.log('IndexedDB setup complete');
      resolve(event.target.result);
    };
    
    request.onerror = event => {
      console.error('IndexedDB setup failed:', event.target.error);
      reject(event.target.error);
    };
  });
}

// Activate event - clean up old caches and database
self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      // Clean old caches
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== CACHE_NAME) {
              console.log('Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      }),
      
      // Clean old databases (if DB version changed)
      new Promise((resolve) => {
        const request = indexedDB.databases();
        request.onsuccess = () => {
          const databases = request.result || [];
          Promise.all(
            databases
              .filter(db => db.name === DB_NAME && db.version < 1)
              .map(db => new Promise((res) => {
                const deleteRequest = indexedDB.deleteDatabase(db.name);
                deleteRequest.onsuccess = () => {
                  console.log(`Deleted old database: ${db.name}`);
                  res();
                };
                deleteRequest.onerror = () => res();
              }))
          ).then(resolve);
        };
        request.onerror = () => resolve();
      })
    ]).then(() => {
      // Register for periodic sync and push
      registerPeriodicSync();
      subscribeToPushNotifications();
      return self.clients.claim();
    })
  );
});

// Fetch event - implement advanced caching strategy
self.addEventListener('fetch', event => {
  // Skip cross-origin requests
  if (!event.request.url.startsWith(self.location.origin)) return;
  
  const requestURL = new URL(event.request.url);
  const resourceType = getResourceType(requestURL.pathname);
  const config = RESOURCE_CONFIG[resourceType] || RESOURCE_CONFIG.default;
  
  // For POST/PUT/DELETE requests, use sync queue if network fails
  if (event.request.method !== 'GET') {
    event.respondWith(
      fetch(event.request.clone())
        .catch(error => {
          addToSyncQueue(event.request.clone());
          showNotification('Sync Pending', 'Changes will be saved when you reconnect');
          updateOperationCount('syncs', 1);
          
          return new Response(JSON.stringify({ 
            error: 'Network error. Request queued for background sync.' 
          }), {
            headers: { 'Content-Type': 'application/json' },
            status: 503
          });
        })
    );
    return;
  }
  
  // For large resources that support Background Fetch
  if (config.useBackgroundFetch && 'BackgroundFetchManager' in self.registration && isLargeResource(resourceType)) {
    if (tryBackgroundFetch(event)) return;
  }
  
  // Choose appropriate strategy based on resource type
  if (config.useStream && isLargeResource(resourceType)) {
    event.respondWith(streamingStrategy(event.request, config));
  } else if (config.useIndexedDB) {
    event.respondWith(indexedDBFirstStrategy(event.request, config));
  } else {
    event.respondWith(cacheFirstNetworkUpdateStrategy(event.request, config));
  }
});

// Determine resource type from URL
function getResourceType(pathname) {
  if (pathname.includes('/images/')) return 'images';
  if (pathname.endsWith('.html')) return 'html';
  if (pathname.endsWith('.css')) return 'css';
  if (pathname.endsWith('.js')) return 'js';
  return 'default';
}

// Check if resource is likely to be large based on type
function isLargeResource(type) {
  return type === 'images' || type === 'video';
}

// Try using Background Fetch API for large resources
function tryBackgroundFetch(event) {
  const bgFetchOptions = {
    title: 'Downloading content',
    icons: [{
      sizes: '192x192',
      src: '/images/icon-192.png',
      type: 'image/png'
    }],
    downloadTotal: 0
  };

  try {
    // Check if this fetch is already in progress
    event.waitUntil((async () => {
      const registration = await self.registration.backgroundFetch.get(event.request.url);
      if (registration) {
        // Already being handled by background fetch
        event.respondWith(
          caches.match(event.request)
            .then(cachedResponse => {
              return cachedResponse || new Response('Download in progress', {
                headers: { 'Content-Type': 'text/plain' },
                status: 202
              });
            })
        );
        return true;
      }
      
      // Check cache first, if it exists don't use background fetch
      const cachedResponse = await caches.match(event.request);
      if (cachedResponse) return false;
      
      // Start a new background fetch
      await self.registration.backgroundFetch.fetch(
        event.request.url,
        [event.request],
        bgFetchOptions
      );
      
      // Respond with "download started" for now
      event.respondWith(
        new Response('Download started', {
          headers: { 'Content-Type': 'text/plain' },
          status: 202
        })
      );
      
      updateOperationCount('downloads', 1);
      showProgressNotification('Download started', 'Content is being downloaded in the background');
      
      return true;
    })());
    
    return true;
  } catch (err) {
    console.log('Background fetch not supported or failed:', err);
    return false;
  }
}

// Streaming strategy for large resources
async function streamingStrategy(request, config) {
  try {
    // Check cache first
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      // Update cache in background if needed
      const cachedDate = new Date(cachedResponse.headers.get('sw-fetched-on') || 0);
      if (Date.now() - cachedDate > config.cacheDuration) {
        updateCacheInBackground(request);
      }
      return cachedResponse;
    }
    
    // If not in cache, fetch as stream
    const fetchResponse = await fetch(request);
    
    if (!fetchResponse.ok) {
      throw new Error(`Fetch failed with status ${fetchResponse.status}`);
    }
    
    // Clone the response for caching
    const responseToCache = fetchResponse.clone();
    
    // Store response in cache with timestamp
    const cache = await caches.open(CACHE_NAME);
    
    // Create a new response with timestamp header
    const headers = new Headers(responseToCache.headers);
    headers.append('sw-fetched-on', Date.now().toString());
    
    const responseWithTimestamp = new Response(
      responseToCache.body,
      {
        status: responseToCache.status,
        statusText: responseToCache.statusText,
        headers: headers
      }
    );
    
    cache.put(request, responseWithTimestamp);
    
    return fetchResponse;
  } catch (error) {
    console.error('Streaming strategy error:', error);
    // Fall back to any cached version or offline page
    return fallbackResponse(request);
  }
}

// IndexedDB-first strategy
async function indexedDBFirstStrategy(request, config) {
  try {
    // Try IndexedDB first
    const dbResponse = await getFromIndexedDB(request.url);
    
    if (dbResponse) {
      // Check if we need to update in the background
      if (Date.now() - dbResponse.timestamp > config.cacheDuration) {
        updateResourceInBackground(request, config);
      }
      
      // Return the stored response
      return new Response(dbResponse.data, {
        headers: dbResponse.headers,
        status: 200
      });
    }
    
    // Not in IndexedDB, try cache
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      // Update in background if needed
      const cachedDate = new Date(cachedResponse.headers.get('sw-fetched-on') || 0);
      if (Date.now() - cachedDate > config.cacheDuration) {
        updateResourceInBackground(request, config);
      }
      return cachedResponse;
    }
    
    // Not in cache or IndexedDB, fetch from network
    const networkResponse = await fetch(request);
    
    if (!networkResponse.ok) {
      throw new Error(`Network response not ok: ${networkResponse.status}`);
    }
    
    // Store in both cache and IndexedDB
    const responseToStore = networkResponse.clone();
    
    // Add to IndexedDB
    const buffer = await responseToStore.arrayBuffer();
    const headers = Object.fromEntries(responseToStore.headers.entries());
    headers['sw-fetched-on'] = Date.now().toString();
    
    saveToIndexedDB({
      url: request.url,
      data: buffer,
      headers: headers,
      timestamp: Date.now()
    });
    
    // Add to cache too for redundancy
    const cache = await caches.open(CACHE_NAME);
    const headersWithTimestamp = new Headers(responseToStore.headers);
    headersWithTimestamp.append('sw-fetched-on', Date.now().toString());
    
    const responseWithTimestamp = new Response(
      buffer,
      {
        status: responseToStore.status,
        statusText: responseToStore.statusText,
        headers: headersWithTimestamp
      }
    );
    
    cache.put(request, responseWithTimestamp);
    
    return networkResponse;
  } catch (error) {
    console.error('IndexedDB strategy error:', error);
    return fallbackResponse(request);
  }
}

// Cache-first with network update strategy
async function cacheFirstNetworkUpdateStrategy(request, config) {
  try {
    // Check cache first
    const cachedResponse = await caches.match(request);
    
    if (cachedResponse) {
      // Update in background if needed
      const cachedDate = new Date(cachedResponse.headers.get('sw-fetched-on') || 0);
      if (Date.now() - cachedDate > config.cacheDuration) {
        updateCacheInBackground(request);
      }
      return cachedResponse;
    }
    
    // If not in cache, fetch from network
    const networkResponse = await fetch(request);
    
    if (!networkResponse.ok) {
      throw new Error(`Network response not ok: ${networkResponse.status}`);
    }
    
    // Store in cache
    const responseToCache = networkResponse.clone();
    const cache = await caches.open(CACHE_NAME);
    
    // Add timestamp header
    const headers = new Headers(responseToCache.headers);
    headers.append('sw-fetched-on', Date.now().toString());
    
    const responseWithTimestamp = new Response(
      responseToCache.body,
      {
        status: responseToCache.status,
        statusText: responseToCache.statusText,
        headers: headers
      }
    );
    
    cache.put(request, responseWithTimestamp);
    
    return networkResponse;
  } catch (error) {
    console.error('Cache strategy error:', error);
    return fallbackResponse(request);
  }
}

// Update resource in background (for both cache and IndexedDB)
async function updateResourceInBackground(request, config) {
  updateOperationCount('updates', 1);
  
  try {
    // Create a new request with cache-busting
    const fetchOptions = {
      cache: 'no-cache',
      headers: new Headers(request.headers)
    };
    
    // Add conditional headers if available from cache
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      if (cachedResponse.headers.has('ETag')) {
        fetchOptions.headers.set('If-None-Match', cachedResponse.headers.get('ETag'));
      }
      
      if (cachedResponse.headers.has('Last-Modified')) {
        fetchOptions.headers.set('If-Modified-Since', cachedResponse.headers.get('Last-Modified'));
      }
    }
    
    // Fetch updated resource
    const response = await fetch(request.url, fetchOptions);
    
    // If not modified, just update timestamp
    if (response.status === 304) {
      if (config.useIndexedDB) {
        const dbResponse = await getFromIndexedDB(request.url);
        if (dbResponse) {
          dbResponse.timestamp = Date.now();
          await saveToIndexedDB(dbResponse);
        }
      }
      
      if (cachedResponse) {
        const cache = await caches.open(CACHE_NAME);
        const headers = new Headers(cachedResponse.headers);
        headers.set('sw-fetched-on', Date.now().toString());
        
        const updatedResponse = new Response(
          cachedResponse.clone().body,
          {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers: headers
          }
        );
        
        await cache.put(request, updatedResponse);
      }
    } 
    // Otherwise, update with new content
    else if (response.ok) {
      // Update cache
      const cache = await caches.open(CACHE_NAME);
      const headers = new Headers(response.headers);
      headers.set('sw-fetched-on', Date.now().toString());
      
      const responseToCache = new Response(
        response.clone().body,
        {
          status: response.status,
          statusText: response.statusText,
          headers: headers
        }
      );
      
      await cache.put(request, responseToCache);
      
      // Update IndexedDB if needed
      if (config.useIndexedDB) {
        const buffer = await response.clone().arrayBuffer();
        const headerObj = Object.fromEntries(headers.entries());
        
        await saveToIndexedDB({
          url: request.url,
          data: buffer,
          headers: headerObj,
          timestamp: Date.now()
        });
      }
      
      // Notify about update
      const resourceType = getResourceType(new URL(request.url).pathname);
      if (resourceType !== 'images' || Math.random() < 0.1) { // Limit image notifications to 10%
        showNotification('Content Updated', `${resourceType} resource updated`);
      }
    }
  } catch (error) {
    console.error('Background update failed:', error);
  } finally {
    updateOperationCount('updates', -1);
  }
}

// Fallback response when all strategies fail
async function fallbackResponse(request) {
  // For navigate requests, try to return the offline page
  if (request.mode === 'navigate') {
    const cache = await caches.open(CACHE_NAME);
    const offlineResponse = await cache.match('./index.html');
    if (offlineResponse) return offlineResponse;
  }
  
  // For non-critical resources, return an empty response
  return new Response('Resource temporarily unavailable', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' }
  });
}

// IndexedDB helpers
async function getFromIndexedDB(url) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    
    request.onerror = event => {
      console.error('IndexedDB open error:', event.target.error);
      resolve(null);
    };
    
    request.onsuccess = event => {
      const db = event.target.result;
      const transaction = db.transaction([DB_STORE_NAME], 'readonly');
      const store = transaction.objectStore(DB_STORE_NAME);
      const getRequest = store.get(url);
      
      getRequest.onerror = () => resolve(null);
      getRequest.onsuccess = () => resolve(getRequest.result);
      
      transaction.oncomplete = () => db.close();
    };
  });
}

async function saveToIndexedDB(resource) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    
    request.onerror = event => {
      console.error('IndexedDB open error:', event.target.error);
      resolve(false);
    };
    
    request.onsuccess = event => {
      const db = event.target.result;
      const transaction = db.transaction([DB_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(DB_STORE_NAME);
      const putRequest = store.put(resource);
      
      putRequest.onerror = () => resolve(false);
      putRequest.onsuccess = () => resolve(true);
      
      transaction.oncomplete = () => db.close();
    };
  });
}

// Background sync implementation for non-GET requests
async function addToSyncQueue(request) {
  try {
    // Store request in IndexedDB for sync
    const bodyText = await request.text();
    const requestData = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      credentials: request.credentials,
      body: bodyText,
      timestamp: Date.now(),
      id: Date.now().toString()
    };
    
    await saveToSyncQueue(requestData);
    
    // Register for background sync
    if ('sync' in self.registration) {
      await self.registration.sync.register(SYNC_TAG);
    }
  } catch (error) {
    console.error('Failed to add request to sync queue:', error);
  }
}

async function saveToSyncQueue(requestData) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    
    request.onerror = event => resolve(false);
    
    request.onsuccess = event => {
      const db = event.target.result;
      
      // Check if store exists, create if not
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.close();
        const upgradeRequest = indexedDB.open(DB_NAME, db.version + 1);
        
        upgradeRequest.onupgradeneeded = e => {
          const upgradeDb = e.target.result;
          upgradeDb.createObjectStore('syncQueue', { keyPath: 'id' });
        };
        
        upgradeRequest.onsuccess = e => {
          const upgradeDb = e.target.result;
          const transaction = upgradeDb.transaction(['syncQueue'], 'readwrite');
          const store = transaction.objectStore('syncQueue');
          
          store.add(requestData);
          upgradeDb.close();
          resolve(true);
        };
        
        return;
      }
      
      const transaction = db.transaction(['syncQueue'], 'readwrite');
      const store = transaction.objectStore('syncQueue');
      
      store.add(requestData);
      db.close();
      resolve(true);
    };
  });
}

// Process sync queue for Background Sync API
async function processSyncQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    
    request.onerror = () => resolve(false);
    
    request.onsuccess = async event => {
      const db = event.target.result;
      
      // Check if store exists
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.close();
        resolve(false);
        return;
      }
      
      const transaction = db.transaction(['syncQueue'], 'readonly');
      const store = transaction.objectStore('syncQueue');
      const getAllRequest = store.getAll();
      
      getAllRequest.onsuccess = async () => {
        const requests = getAllRequest.result;
        db.close();
        
        if (requests.length === 0) {
          resolve(false);
          return;
        }
        
        showProgressNotification('Syncing Data', `Syncing ${requests.length} pending requests...`);
        updateOperationCount('syncs', requests.length);
        
        let successCount = 0;
        let failCount = 0;
        
        for (const requestData of requests) {
          try {
            // Recreate the request
            const request = new Request(requestData.url, {
              method: requestData.method,
              headers: requestData.headers,
              credentials: requestData.credentials,
              body: requestData.body
            });
            
            // Try to send the request
            const response = await fetch(request);
            
            if (response.ok) {
              // Remove from queue on success
              await removeFromSyncQueue(requestData.id);
              successCount++;
              updateOperationCount('syncs', -1);
            } else {
              failCount++;
            }
          } catch (error) {
            console.error('Sync failed for request:', error);
            failCount++;
          }
        }
        
        // Notify about sync result
        if (successCount > 0) {
          showNotification(
            'Sync Complete', 
            `${successCount} request${successCount !== 1 ? 's' : ''} synced successfully` +
            (failCount > 0 ? `. ${failCount} failed.` : '.')
          );
        }
        
        resolve(successCount > 0);
      };
      
      getAllRequest.onerror = () => {
        db.close();
        resolve(false);
      };
    };
  });
}

async function removeFromSyncQueue(id) {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME);
    
    request.onerror = () => resolve(false);
    
    request.onsuccess = event => {
      const db = event.target.result;
      
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.close();
        resolve(false);
        return;
      }
      
      const transaction = db.transaction(['syncQueue'], 'readwrite');
      const store = transaction.objectStore('syncQueue');
      const deleteRequest = store.delete(id);
      
      deleteRequest.onsuccess = () => resolve(true);
      deleteRequest.onerror = () => resolve(false);
      
      transaction.oncomplete = () => db.close();
    };
  });
}

// Background sync event handler
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(processSyncQueue());
  }
});

// Background fetch event handlers
self.addEventListener('backgroundfetchsuccess', event => {
  const bgFetch = event.registration;
  
  event.waitUntil(async function() {
    try {
      // Get the fetched resources
      const records = await bgFetch.matchAll();
      
      // Process and cache each resource
      const cache = await caches.open(CACHE_NAME);
      
      for (const record of records) {
        const response = await record.responseReady;
        const request = record.request;
        
        // Add timestamp header
        const headers = new Headers(response.headers);
        headers.set('sw-fetched-on', Date.now().toString());
        
        const responseToCache = new Response(
          response.clone().body,
          {
            status: response.status,
            statusText: response.statusText,
            headers: headers
          }
        );
        
        // Store in cache
        await cache.put(request, responseToCache);
        
        // Store in IndexedDB if it's a large resource
        const resourceType = getResourceType(new URL(request.url).pathname);
        const config = RESOURCE_CONFIG[resourceType] || RESOURCE_CONFIG.default;
        
        if (config.useIndexedDB) {
          const buffer = await response.clone().arrayBuffer();
          const headerObj = Object.fromEntries(headers.entries());
          
          await saveToIndexedDB({
            url: request.url,
            data: buffer,
            headers: headerObj,
            timestamp: Date.now()
          });
        }
      }
      
      // Show notification
      showNotification(
        'Download Complete', 
        `${records.length} file${records.length !== 1 ? 's' : ''} downloaded successfully`
      );
      
      updateOperationCount('downloads', -1);
    } catch (error) {
      console.error('Error handling background fetch success:', error);
      showNotification('Download Error', 'Some downloaded files could not be processed');
      updateOperationCount('downloads', -1);
    }
  }());
});

self.addEventListener('backgroundfetchfail', event => {
  console.error('Background fetch failed:', event);
  showNotification('Download Failed', 'Please check your connection and try again');
  updateOperationCount('downloads', -1);
});

self.addEventListener('backgroundfetchabort', event => {
  console.log('Background fetch aborted:', event);
  showNotification('Download Cancelled', 'The download was cancelled');
  updateOperationCount('downloads', -1);
});

// Register for periodic background sync
async function registerPeriodicSync() {
  if ('periodicSync' in self.registration) {
    try {
      const status = await navigator.permissions.query({
        name: 'periodic-background-sync',
      });
      
      if (status.state === 'granted') {
        await self.registration.periodicSync.register(PERIODIC_SYNC_TAG, {
          minInterval: 24 * 60 * 60 * 1000, // Daily check
        });
        console.log('Periodic background sync registered');
      }
    } catch (error) {
      console.error('Failed to register periodic background sync:', error);
    }
  }
}

// Periodic background sync handler
self.addEventListener('periodicsync', event => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(performPeriodicSync());
  }
});

// Perform periodic sync of high-priority resources
async function performPeriodicSync() {
  try {
    showProgressNotification('Checking for Updates', 'Looking for new content...');
    
    // Prioritize critical resources first
    const highPriorityResources = [
      './index.html',
      './CSS/main.css',
      './js/app.js'
    ];
    
    // Update high-priority resources
    let updatedCount = 0;
    
    for (const url of highPriorityResources) {
      try {
        const request = new Request(url);
        const cachedResponse = await caches.match(request);
        
        if (cachedResponse) {
          // Create fetch options with conditional headers
          const fetchOptions = {
            cache: 'no-cache',
            headers: {}
          };
          
          if (cachedResponse.headers.has('ETag')) {
            fetchOptions.headers['If-None-Match'] = cachedResponse.headers.get('ETag');
          }
          
          if (cachedResponse.headers.has('Last-Modified')) {
            fetchOptions.headers['If-Modified-Since'] = cachedResponse.headers.get('Last-Modified');
          }
          
          const response = await fetch(request, fetchOptions);
          
          if (response.status === 304) {
            // Not modified, just update timestamp
            const cache = await caches.open(CACHE_NAME);
            const headers = new Headers(cachedResponse.headers);
            headers.set('sw-fetched-on', Date.now().toString());
            
            const updatedResponse = new Response(
              cachedResponse.clone().body,
              {
                status: cachedResponse.status,
                statusText: cachedResponse.statusText,
                headers: headers
              }
            );
            
            await cache.put(request, updatedResponse);
          } 
          else if (response.ok) {
            // Content changed, update cache
            const cache = await caches.open(CACHE_NAME);
            const headers = new Headers(response.headers);
            headers.set('sw-fetched-on', Date.now().toString());
            
            const responseToCache = new Response(
              response.clone().body,
              {
                status: response.status,
                statusText: response.statusText,
                headers: headers
              }
            );
            
            await cache.put(request, responseToCache);
            updatedCount++;
          }
        }
      } catch (error) {
        console.error(`Failed to update ${url}:`, error);
      }
    }
    
    // Then check cache for other resources that might need updates
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    
    for (const request of requests) {
      // Skip already processed high-priority resources
      if (highPriorityResources.includes(request.url)) continue;
      
      const resourceType = getResourceType(new URL(request.url).pathname);
      const config = RESOURCE_CONFIG[resourceType] || RESOURCE_CONFIG.default;
      
      try {
        const cachedResponse = await cache.match(request);
        const cachedDate = new Date(cachedResponse.headers.get('sw-fetched-on') || 0);
        
        // Only update resources that are stale based on their config
        if (Date.now() - cachedDate > config.cacheDuration) {
          // Only update a subset of resources each time (20%) to reduce load
          if (Math.random() < 0.2) {
            await updateResourceInBackground(request, config);
            updatedCount++;
          }
        }
      } catch (error) {
        console.error(`Failed to process ${request.url}:`, error);
      }
    }
    
    if (updatedCount > 0) {
      showNotification('Update Complete', `${updatedCount} resources updated`);
    }
    
    // Clean up old entries from IndexedDB
    await cleanIndexedDB();
    
    return updatedCount;
  } catch (error) {
    console.error('Periodic sync error:', error);
    return 0;
  }
}

// Clean up old resources from IndexedDB
async function cleanIndexedDB() {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME);
    
    request.onerror = () => resolve();
    
    request.onsuccess = event => {
      const db = event.target.result;
      
      if (!db.objectStoreNames.contains(DB_STORE_NAME)) {
        db.close();
        resolve();
        return;
      }
      
      const transaction = db.transaction([DB_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(DB_STORE_NAME);
      const cursorRequest = store.openCursor();
      const now = Date.now();
      const deleted = [];
      
      cursorRequest.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) {
          const resource = cursor.value;
          const resourceType = getResourceType(new URL(resource.url).pathname);
          const config = RESOURCE_CONFIG[resourceType] || RESOURCE_CONFIG.default;
          
          // Delete if older than cacheDuration
          if (now - resource.timestamp > config.cacheDuration) {
            deleted.push(cursor.delete());
          }
          
          cursor.continue();
        }
      };
      
      transaction.oncomplete = () => {
        db.close();
        if (deleted.length > 0) {
          console.log(`Cleaned ${deleted.length} old resources from IndexedDB`);
        }
        resolve();
      };
    };
  });
}

// Push notification support
async function subscribeToPushNotifications() {
  if (!('PushManager' in self)) return;
  
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    
    if (subscription) return;
    
    // Create a new subscription with VAPID key
    await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
      )
    });
    
    console.log('Push notification subscription created');
  } catch (error) {
    console.error('Push subscription failed:', error);
  }
}

// Convert base64 to Uint8Array for applicationServerKey
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Push event handler
self.addEventListener('push', event => {
  let data = { 
    title: 'New Update', 
    body: 'Check for new content',
    icon: DEFAULT_NOTIFICATION_ICON
  };
  
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }
  
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || DEFAULT_NOTIFICATION_ICON,
      badge: data.badge || DEFAULT_NOTIFICATION_ICON,
      vibrate: [100, 50, 100],
      data: {
        url: data.url || self.location.origin,
        actions: data.actions || []
      },
      actions: data.notificationActions || []
    })
  );
});

// Notification click handler
self.addEventListener('notificationclick', event => {
  event.notification.close();
  
  // Handle action buttons if clicked
  if (event.action) {
    // Handle specific actions
    const actionHandlers = {
      'view': () => self.clients.openWindow(event.notification.data.url),
      'dismiss': () => {}, // Just close, which we already did
      'retry': () => {
        if (event.notification.data.requestId) {
          // Retry specific failed request
          retryRequest(event.notification.data.requestId);
        } else {
          // Retry all pending requests
          processSyncQueue();
        }
      }
    };
    
    if (actionHandlers[event.action]) {
      event.waitUntil(actionHandlers[event.action]());
      return;
    }
    
    // Custom action handling through data
    if (event.notification.data.actions && 
        event.notification.data.actions[event.action]) {
      const action = event.notification.data.actions[event.action];
      if (action.url) {
        event.waitUntil(self.clients.openWindow(action.url));
        return;
      }
    }
  }
  
  // Default behavior - open or focus window
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clientList => {
      const url = event.notification.data.url || self.location.origin;
      
      // Focus existing client if available
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      
      // Open new window if no client exists
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});

// Enhanced notification system
function showNotification(title, body, options = {}) {
  if (Notification.permission !== 'granted') return;
  
  const notificationOptions = {
    body: body,
    icon: options.icon || DEFAULT_NOTIFICATION_ICON,
    badge: options.badge || DEFAULT_NOTIFICATION_ICON,
    vibrate: options.vibrate || [100, 50, 100],
    tag: options.tag || 'site-notification',
    renotify: options.renotify || false,
    requireInteraction: options.requireInteraction || false,
    data: {
      url: options.url || self.location.origin,
      timestamp: Date.now(),
      ...options.data
    }
  };
  
  // Add actions if provided
  if (options.actions && options.actions.length) {
    notificationOptions.actions = options.actions;
  }
  
  // Show the notification
  return self.registration.showNotification(title, notificationOptions);
}

// Show progress notification for longer operations
function showProgressNotification(title, body, options = {}) {
  return showNotification(title, body, {
    ...options,
    tag: 'progress-notification',
    renotify: true,
    requireInteraction: true,
    actions: [
      {
        action: 'dismiss',
        title: 'Dismiss'
      }
    ]
  });
}

// Update operation counts and badge
function updateOperationCount(type, delta) {
  pendingOperations[type] += delta;
  
  // Ensure counts never go below zero
  if (pendingOperations[type] < 0) pendingOperations[type] = 0;
  
  // Update badge with total pending operations
  const totalPending = 
    pendingOperations.updates + 
    pendingOperations.downloads + 
    pendingOperations.syncs;
  
  updateBadge(totalPending);
}

// Update app badge
async function updateBadge(count) {
  if (!('setAppBadge' in navigator)) return;
  
  try {
    if (count > 0) {
      await navigator.setAppBadge(count);
    } else {
      await navigator.clearAppBadge();
    }
  } catch (error) {
    console.error('Failed to update badge:', error);
  }
}

// Cache helpers
async function updateCacheInBackground(request) {
  updateOperationCount('updates', 1);
  
  try {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(request);
    
    // Create fetch options with conditional headers
    const fetchOptions = {
      cache: 'no-cache',
      headers: {}
    };
    
    if (cachedResponse) {
      if (cachedResponse.headers.has('ETag')) {
        fetchOptions.headers['If-None-Match'] = cachedResponse.headers.get('ETag');
      }
      
      if (cachedResponse.headers.has('Last-Modified')) {
        fetchOptions.headers['If-Modified-Since'] = cachedResponse.headers.get('Last-Modified');
      }
    }
    
    const response = await fetch(request, fetchOptions);
    
    if (response.status === 304) {
      // Not modified, just update timestamp
      const headers = new Headers(cachedResponse.headers);
      headers.set('sw-fetched-on', Date.now().toString());
      
      const updatedResponse = new Response(
        cachedResponse.clone().body,
        {
          status: cachedResponse.status,
          statusText: cachedResponse.statusText,
          headers: headers
        }
      );
      
      await cache.put(request, updatedResponse);
    } 
    else if (response.ok) {
      // Resource changed, update cache
      const headers = new Headers(response.headers);
      headers.set('sw-fetched-on', Date.now().toString());
      
      const responseToCache = new Response(
        response.clone().body,
        {
          status: response.status,
          statusText: response.statusText,
          headers: headers
        }
      );
      
      await cache.put(request, responseToCache);
      
      // Notify about important updates
      const url = new URL(request.url);
      const resourceType = getResourceType(url.pathname);
      
      if (PRECACHE_URLS.includes(url.pathname) || request.mode === 'navigate') {
        showNotification('Content Updated', 'New content is available');
      }
    }
  } catch (error) {
    console.error('Cache update failed:', error);
  } finally {
    updateOperationCount('updates', -1);
  }
}

// Handle specific request retry
async function retryRequest(requestId) {
  try {
    const request = indexedDB.open(DB_NAME);
    
    request.onsuccess = async event => {
      const db = event.target.result;
      
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.close();
        return;
      }
      
      const transaction = db.transaction(['syncQueue'], 'readonly');
      const store = transaction.objectStore('syncQueue');
      const getRequest = store.get(requestId);
      
      getRequest.onsuccess = async () => {
        const requestData = getRequest.result;
        db.close();
        
        if (!requestData) return;
        
        try {
          showProgressNotification('Retrying Request', 'Attempting to resend data...');
          
          // Recreate the request
          const request = new Request(requestData.url, {
            method: requestData.method,
            headers: requestData.headers,
            credentials: requestData.credentials,
            body: requestData.body
          });
          
          // Try to send the request
          const response = await fetch(request);
          
          if (response.ok) {
            // Remove from queue on success
            await removeFromSyncQueue(requestData.id);
            showNotification('Request Complete', 'Your data has been sent successfully');
          } else {
            showNotification('Request Failed', 'Could not complete the request. Will retry later.');
          }
        } catch (error) {
          console.error('Request retry failed:', error);
          showNotification('Connection Error', 'Could not connect to the server. Will retry later.');
        }
      };
      
      getRequest.onerror = () => db.close();
    };
    
    request.onerror = () => {};
  } catch (error) {
    console.error('Retry request error:', error);
  }
}

// Listen for messages from clients
self.addEventListener('message', event => {
  const message = event.data;
  
  if (!message || !message.type) return;
  
  const messageHandlers = {
    'SKIP_WAITING': () => self.skipWaiting(),
    
    'FORCE_UPDATE': () => {
      event.waitUntil(updateAllCachedResources());
    },
    
    'CLEAR_BADGE': () => {
      updateBadge(0);
    },
    
    'CHECK_RESOURCE': () => {
      if (message.url) {
        const request = new Request(message.url);
        const resourceType = getResourceType(new URL(message.url).pathname);
        const config = RESOURCE_CONFIG[resourceType] || RESOURCE_CONFIG.default;
        
        event.waitUntil(updateResourceInBackground(request, config));
      }
    },
    
    'PROCESS_SYNC_QUEUE': () => {
      event.waitUntil(processSyncQueue());
    },
    
    'CLEAN_CACHE': () => {
      event.waitUntil(cleanCache());
    }
  };
  
  if (messageHandlers[message.type]) {
    messageHandlers[message.type]();
  }
});

// Clean old cache entries
async function cleanCache() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    const now = Date.now();
    const deleted = [];
    
    for (const request of requests) {
      const cachedResponse = await cache.match(request);
      const cachedDate = new Date(cachedResponse.headers.get('sw-fetched-on') || 0);
      const resourceType = getResourceType(new URL(request.url).pathname);
      const config = RESOURCE_CONFIG[resourceType] || RESOURCE_CONFIG.default;
      
      // Delete if older than cacheDuration and not in PRECACHE_URLS
      if ((now - cachedDate > config.cacheDuration * 2) && 
          !PRECACHE_URLS.includes(new URL(request.url).pathname)) {
        await cache.delete(request);
        deleted.push(request.url);
      }
    }
    
    if (deleted.length > 0) {
      console.log(`Cleaned ${deleted.length} resources from cache`);
    }
    
    return deleted.length;
  } catch (error) {
    console.error('Clean cache error:', error);
    return 0;
  }
}