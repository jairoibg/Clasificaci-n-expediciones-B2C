// Cache version: BUMPEAR esta cifra cada vez que se haga un deploy
// para forzar la invalidación de caché viejo en navegadores de operarios.
const CACHE_NAME = 'expediciones-v4-2026-07-15-fluidez';
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
// - API: pass-through (sin cachear)
// - HTML/JS/CSS y resto: network-first, PERO cae a caché tanto si la red falla
//   COMO si el servidor responde 5xx (p.ej. el 502 "Application failed to respond"
//   de Railway cuando el índice se reconstruye tras el sync). Antes .catch() solo
//   capturaba fallo de red y dejaba pasar la página de error 502 → el operario la
//   veía. Ahora la app sigue viva desde caché y el escaneo no se interrumpe.
async function networkFirstWithCache(request, opts) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, opts);
    // 5xx (o error del proxy) → tratar como caído: servir la última copia buena
    if (response.status >= 500) {
      const cached = await cache.match(request);
      if (cached) return cached;
    }
    // Respuesta buena → refrescar caché (solo 200 GET) para tener fallback futuro
    if (response.ok) {
      try { cache.put(request, response.clone()); } catch (_) {}
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;

  // API: no interceptar (el cliente gestiona timeouts/reintentos)
  if (url.includes('/api/')) return;

  const isAppShell = url.endsWith('.html') || url.endsWith('.js') || url.endsWith('.css') || url.endsWith('/');
  // App shell: red fresca (no-store) pero con fallback a caché en 5xx/offline.
  event.respondWith(networkFirstWithCache(event.request, isAppShell ? { cache: 'no-store' } : undefined));
});
