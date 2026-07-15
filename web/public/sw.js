// Minimal, hand-rolled service worker for career-ops PWA.
//
// Strategy:
//  - install: pre-cache a tiny app shell + known static assets.
//  - activate: drop any caches that aren't the current version.
//  - fetch:
//      * /api/*  -> ALWAYS network, never cached. These routes read the LIVE
//                   local career-ops checkout (careerOpsRoot()); a stale cache
//                   would serve wrong data. No offline fallback for them.
//      * navigations (HTML) -> network-first with a cached-shell fallback so a
//                   fresh deploy is picked up immediately when online, and the
//                   app still opens offline.
//      * everything else (static assets) -> stale-while-revalidate-ish:
//                   serve cache if present, otherwise network + cache.
//
// Bump CACHE_VERSION to force old caches out on the next activate.
const CACHE_VERSION = "career-ops-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {
        // Best-effort precache; a missing asset must not block install.
      })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle same-origin GETs; let the browser deal with the rest.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // CRITICAL: never cache API routes — they read the live checkout.
  if (url.pathname.startsWith("/api/")) {
    return; // fall through to default network handling
  }

  // Network-first for navigations, with cached-shell fallback offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("/"))
        )
    );
    return;
  }

  // Static assets: cache-first, then network (and populate the cache).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
