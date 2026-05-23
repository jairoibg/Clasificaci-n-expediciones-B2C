// Cache version: BUMPEAR esta cifra cada vez que se haga un deploy
// para forzar la invalidación de caché viejo en navegadores de operarios.
const CACHE_NAME = 'expediciones-v3-2026-05-24-multipalet-fix1';
const urlsToCache = [
  '/',
  '/manifest.json'
];

// Instalación
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Activación
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch strategy:
// - HTML, JS, CSS: SIEMPRE network (sin caché) para que operarios vean la última versión
// - API: pass-through (sin cachear)
// - Otros recursos estáticos: network-first con fallback a caché
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;

  // API: no interceptar
  if (url.includes('/api/')) return;

  // HTML/JS/CSS: SIEMPRE network, sin caché
  if (url.endsWith('.html') || url.endsWith('.js') || url.endsWith('.css') || url.endsWith('/')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Otros (imágenes, fonts, manifest): network-first con fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
