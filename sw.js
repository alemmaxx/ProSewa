// ProSewa service worker — membolehkan app di-install & dibuka laju
const CACHE = 'prosewa-v7';
const SHELL = ['./', './index.html', './penyewa.html', './manifest.webmanifest', './manifest-penyewa.webmanifest', './icon-192.png', './icon-512.png', './icon-t-192.png', './icon-t-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network dahulu (supaya update terus nampak), cache bila offline
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
  }).catch(() => caches.match(req, {ignoreSearch: true}).then(r => r || caches.match(new URL(req.url).pathname.endsWith('penyewa.html') ? './penyewa.html' : './index.html'))));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window'}).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow(e.notification.data?.url || './')));
});
