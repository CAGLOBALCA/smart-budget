const CACHE = 'sbp-v2';
const FILES = ['./', 'index.html', 'app.js', 'i18n.js', 'sbp-core.js', 'style.css', 'layouts.json', 'model/digits.json', 'vendor/xlsx.full.min.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'demo/sample-tracker.jpg', 'demo/sample-budget.jpg'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => { if (e.request.method !== 'GET') return; e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request))); });
