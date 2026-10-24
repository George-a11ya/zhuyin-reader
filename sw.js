// 離線快取：有網路時先抓最新版並更新快取，沒網路才用快取。改版時調高 VERSION。
const VERSION = 'v3';
const CACHE = 'zhuyin-reader-' + VERSION;
const FILES = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/store.js', 'js/zhuyin.js',
  'js/stories.js', 'js/zhuyin-dict.js', 'js/zip.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok || res.type === 'opaque') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request)));
});
