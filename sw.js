// ProSewa service worker — membolehkan app di-install & dibuka laju
const CACHE = 'prosewa-v9';
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
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin || /\.apk$/i.test(new URL(req.url).pathname)) return;
  e.respondWith(fetch(req).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
  }).catch(() => caches.match(req, {ignoreSearch: true}).then(r => r || caches.match(new URL(req.url).pathname.endsWith('penyewa.html') ? './penyewa.html' : './index.html'))));
});
// Push notification (Firebase Cloud Messaging) — dipaparkan walaupun app/browser ditutup
self.addEventListener('push', e => {
  let p = {}; try { p = e.data ? e.data.json() : {}; } catch (x) { p = {notification: {title: 'ProSewa', body: e.data ? e.data.text() : ''}}; }
  const n = p.notification || {}, d = p.data || {};
  const title = n.title || d.title || 'ProSewa', body = n.body || d.body || '';
  const tenant = /penyewa/.test(d.url || '');
  if (self.navigator && self.navigator.setAppBadge) self.navigator.setAppBadge().catch(() => {});   // titik pada ikon app
  e.waitUntil(self.registration.showNotification(title, {body, icon: tenant ? 'icon-t-192.png' : 'icon-192.png', badge: 'icon-192.png', data: {url: d.url || './'}, tag: title + body}));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window'}).then(cs => { const u = e.notification.data?.url || './', c = cs.find(x => (u.includes('penyewa') ? /penyewa/ : /index|\/$/).test(x.url)); return c ? c.focus() : self.clients.openWindow(u); }));
});
