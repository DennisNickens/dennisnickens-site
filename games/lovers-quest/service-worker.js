/* ============================================================
   Lovers Quest service worker
   Cache-first for the app shell so the game works fully offline.
   Bump CACHE_VERSION to invalidate old caches on the next load.
   ============================================================ */
var CACHE_VERSION = 'lq-v2';
var CACHE_NAME = 'lovers-quest-' + CACHE_VERSION;

// Resolve all paths relative to this worker's location so the app is
// portable (works at /games/lovers-quest/ and any other base path).
var SCOPE = self.registration ? self.registration.scope : (self.location.href.replace(/service-worker\.js.*$/, ''));
function rel(p) { return new URL(p, self.location.href).toString(); }

var APP_SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'cards.json',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
].map(rel);

// Google Fonts (CSS + woff2). Cached opportunistically; the runtime fetch
// handler also caches any font files requested after install.
var FONT_PRECACHE = [
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500;1,600&family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Inter:wght@300;400;500;600&display=swap'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // App shell must all cache for offline to count as reliable.
      return cache.addAll(APP_SHELL).then(function () {
        // Fonts are best-effort: do not fail install if a font CDN hiccups.
        return Promise.all(FONT_PRECACHE.map(function (u) {
          return cache.add(u).catch(function () {});
        }));
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  var isFont = url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com';
  var sameOrigin = url.origin === self.location.origin;

  // Only handle our own app shell + the Google Fonts we depend on.
  if (!sameOrigin && !isFont) return;

  // Cache-first: serve from cache, fall back to network and cache the result.
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        // Cache successful responses (incl. opaque font responses) for next time.
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // Offline and not cached: for navigations, fall back to the app shell.
        if (req.mode === 'navigate') return caches.match(rel('index.html'));
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
