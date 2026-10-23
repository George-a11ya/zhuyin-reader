// 離線快取：App 檔案先用快取；字型用快取並在背景更新。改版時調高 VERSION。
const VERSION = 'v1';
const CACHE = 'zhuyin-reader-' + VERSION;
const FILES = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/store.js', 'js/zhuyin.js',
  'js/stories.js', 'js/zhuyin-dict.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png',
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
  e.respondWith(caches.match(e.request).then((hit) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
