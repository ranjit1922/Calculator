// Smart Calculator Service Worker
const CACHE_NAME = 'smart-calculator-v1';

// Assets that should be pre-cached
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/noscript.html',
  '/css/style.css',
  '/css/media.css',
  '/css/utils.css',
  '/js/script.js',
  '/js/ui.js',
  '/manifest.json',
  '/images/icon/icon-192.png',
  '/images/icon/icon-512.png',
  '/images/icon/icon.webp',
  '/images/favicon/favicon.ico'
];

// Assets that should be dynamically cached
const DYNAMIC_CACHE_EXTENSIONS = [
  'css',
  'js',
  'html',
  'json',
  'png',
  'jpg',
  'jpeg',
  'svg',
  'webp',
  'ico',
  'woff',
  'woff2',
  'ttf'
];

// Network timeout before falling back to cache
const NETWORK_TIMEOUT = 3000;

// Install event - Pre-cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[Service Worker] Pre-caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[Service Worker] Pre-caching complete');
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('[Service Worker] Pre-caching failed:', error);
      })
  );
});

// Activate event - Clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => name !== CACHE_NAME)
            .map(name => {
              console.log('[Service Worker] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('[Service Worker] Now ready to handle fetches!');
        return self.clients.claim();
      })
  );
});

// Fetch event - Smart caching strategy
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  
  // Skip cross-origin requests
  if (requestUrl.origin !== location.origin) {
    return;
  }
  
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Extract file extension from URL
  const fileExtension = requestUrl.pathname.split('.').pop().toLowerCase();
  
  // Check if this is the root page or an HTML file
  const isNavigationRequest = event.request.mode === 'navigate';
  const isHTMLRequest = event.request.headers.get('accept').includes('text/html');
  
  if (isNavigationRequest || isHTMLRequest) {
    // For HTML navigation requests: Network first, cache fallback strategy
    event.respondWith(
      handleNavigationRequest(event.request)
    );
  } else if (DYNAMIC_CACHE_EXTENSIONS.includes(fileExtension)) {
    // For CSS, JS, images: Stale-while-revalidate strategy
    event.respondWith(
      handleAssetRequest(event.request)
    );
  } else {
    // For other requests: Network first, no cache
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response('Network error', { status: 408 }))
    );
  }
});

/**
 * Handle navigation requests with network-first strategy
 * but with a timeout fallback to cache
 */
async function handleNavigationRequest(request) {
  try {
    // Try network first with timeout
    const networkPromise = fetchWithTimeout(request);
    
    try {
      // Try to get from network
      const networkResponse = await networkPromise;
      
      // If successful, cache the response and return it
      await updateCache(request, networkResponse.clone());
      return networkResponse;
    } catch (error) {
      console.log('[Service Worker] Network request failed, falling back to cache', error);
      
      // If network failed, try cache
      const cachedResponse = await caches.match(request);
      
      if (cachedResponse) {
        return cachedResponse;
      }
      
      // If nothing in cache, try with '/index.html'
      if (request.url.endsWith('/')) {
        return caches.match('/index.html');
      }
      
      // If all fails, return a custom offline page
      return caches.match('/noscript.html');
    }
  } catch (error) {
    console.error('[Service Worker] Fatal error in navigation handler:', error);
    return new Response('Service worker error', { status: 500 });
  }
}

/**
 * Handle asset requests with stale-while-revalidate strategy
 */
async function handleAssetRequest(request) {
  try {
    // Check cache first
    const cachedResponse = await caches.match(request);
    
    // Start network fetch in background
    const fetchPromise = fetch(request)
      .then(networkResponse => {
        // Update cache with fresh response
        updateCache(request, networkResponse.clone());
        return networkResponse;
      })
      .catch(error => {
        console.log('[Service Worker] Network fetch failed for asset:', error);
        return null;
      });
    
    // Return cached response immediately if available
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Otherwise wait for network response
    const networkResponse = await fetchPromise;
    if (networkResponse) {
      return networkResponse;
    }
    
    // If both cache and network fail, return error response
    return new Response('Resource not available offline', { status: 404 });
  } catch (error) {
    console.error('[Service Worker] Error in asset handler:', error);
    return new Response('Service worker error', { status: 500 });
  }
}

/**
 * Fetch with timeout to prevent hanging requests
 */
function fetchWithTimeout(request, timeout = NETWORK_TIMEOUT) {
  return new Promise((resolve, reject) => {
    // Set timeout
    const timeoutId = setTimeout(() => {
      reject(new Error('Network request timeout'));
    }, timeout);
    
    // Normal fetch
    fetch(request)
      .then(response => {
        clearTimeout(timeoutId);
        resolve(response);
      })
      .catch(error => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

/**
 * Update cache with new response
 */
async function updateCache(request, response) {
  // Don't cache non-successful responses
  if (!response || response.status !== 200 || response.type !== 'basic') {
    return;
  }
  
  try {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response);
  } catch (error) {
    console.error('[Service Worker] Cache update failed:', error);
  }
}

// Handle messages from the main thread
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
