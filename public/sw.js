// Pullio Production PWA Service Worker v6
const CACHE_VERSION = 'v6';
const STATIC_CACHE = `pullio-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `pullio-dynamic-${CACHE_VERSION}`;
const MAX_DYNAMIC_ENTRIES = 50;

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
  '/favicon.svg',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.png',
  '/apple-touch-icon.png'
];

// Helper to prune cache and prevent quota exhaustion attacks
async function limitCacheEntries(cacheName, maxItems = MAX_DYNAMIC_ENTRIES) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      await cache.delete(keys[0]);
      await limitCacheEntries(cacheName, maxItems);
    }
  } catch (err) {
    // Ignore quota pruning errors
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
          .map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Strictly skip non-GET and cross-origin requests
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  const pathLower = url.pathname.toLowerCase();

  // Security: Never cache API endpoints, media downloads, websockets, or internal tools
  if (
    pathLower.startsWith('/api') ||
    pathLower.startsWith('/ws') ||
    pathLower.includes('/socket') ||
    pathLower.startsWith('/@') ||
    pathLower.startsWith('/src/') ||
    pathLower.startsWith('/node_modules/') ||
    url.searchParams.has('t') ||
    url.searchParams.has('import')
  ) {
    return;
  }

  // Strategy A: Network-First for Navigation / HTML requests
  if (request.mode === 'navigate' || request.headers.get('Accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Verify response is safe and valid before caching
          if (response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
            const resClone = response.clone();
            caches.open(DYNAMIC_CACHE).then(async (cache) => {
              await cache.put(request, resClone);
              limitCacheEntries(DYNAMIC_CACHE, MAX_DYNAMIC_ENTRIES);
            });
          }
          return response;
        })
        .catch(async () => {
          // Preserve shortcut/share-target query parameters while falling back
          // to the cached app shell for the same route.
          const cached = await caches.match(request, { ignoreSearch: true });
          if (cached) return cached;
          const offlinePage = await caches.match('/offline.html');
          return offlinePage || new Response('Offline - No Network Connection', { 
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // Strategy B: Cache-First for static assets (CSS, JS, Fonts, Images)
  if (url.pathname.match(/\.(css|js|svg|ico|png|jpg|jpeg|webp|woff2|woff|ttf)$/i)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
            const resClone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, resClone));
          }
          return response;
        });
      })
    );
    return;
  }
});
