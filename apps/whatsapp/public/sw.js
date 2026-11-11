'use strict';
// QA velocidad 1c: los ~2,3 MB de estáticos se sirven de caché al instante en cada
// visita (stale-while-revalidate: la red refresca en segundo plano, a lo sumo una
// visita de retraso tras un deploy — el HTML del shell sigue no-store y manda).
// /api, /auth y el HTML no pasan por aquí: nada de datos ni de sesión en caché.
const CACHE = 'wa-static-v1';
const STATIC = /\.(?:js|mjs|css|woff2|svg|png|ico|webmanifest)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !STATIC.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request);
    const fresh = fetch(event.request).then(response => {
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    }).catch(() => hit);
    return hit || fresh;
  })());
});
