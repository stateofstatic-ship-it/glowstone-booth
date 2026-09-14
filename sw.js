const VERSION = 'gs-ops-v0.7.7';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './css/giveaways.css',
  './js/giveaway-core.js',
  './js/giveaway-store.js',
  './js/giveaway-metrics.js',
  './js/giveaway-ui.js',
  './js/app.js',
  './js/runtime.js',
  './js/views.js',
  './js/actions.js',
  './js/store.js',
  './js/zettle.js',
  './js/sync.js',
  './js/pricing.js',
  './js/planner.js',
  './js/event-suggestions.js',
  './vendor/xlsx.full.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gs-ops-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.registration.scope)) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) e.waitUntil(cache.put(e.request, res.clone()).catch(() => {}));
      return res;
    })
  );
});
