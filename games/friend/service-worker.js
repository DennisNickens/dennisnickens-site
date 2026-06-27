/* ============================================================
   You Call Yourself A Friend - service worker
   ------------------------------------------------------------
   Cache the app shell so the PWA installs nicely and the
   landing screens render even on a slow connection. We do NOT
   try to cache /api/* responses; the game is multiplayer and
   the room state must always come from the server.
   ============================================================ */
var CACHE_VERSION = 'ycyf-v32';
var CACHE_NAME = 'ycyf-' + CACHE_VERSION;

function rel(p) { return new URL(p, self.location.href).toString(); }

var APP_SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'cards.json',
  'cards.es.json',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  // Big illustrated cover that anchors the landing page
  '../../images/you-call-yourself-a-friend-cover.jpg'
].map(rel);

var FONT_PRECACHE = [
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,700;0,800;1,500&family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL).then(function () {
        return Promise.all(FONT_PRECACHE.map(function (u) { return cache.add(u).catch(function () {}); }));
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf('ycyf-') === 0 && k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // NEVER cache the multiplayer API; always go to network.
  if (url.pathname.indexOf('/api/friend-') === 0) return;

  var isFont = url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com';
  var sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !isFont) return;

  // Cache-first for the app shell, network-first for everything else.
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        if (req.mode === 'navigate') return caches.match(rel('index.html'));
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
