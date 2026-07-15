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
//      * immutable static assets (scripts/styles/images/fonts, /_next/static/*,
//                   and our icons/manifest) -> cache-first, then network.
//      * everything else (RSC/data payloads, and any non-allowlisted GET) ->
//                   straight to network, never cache-first. This matters
//                   because App Router client navigations / router.refresh()
//                   fetch RSC/data payloads for routes that read the LIVE
//                   local checkout (e.g. /pipeline); caching those would serve
//                   a stale tracker/report even though /api/* is never cached.
//
// Bump CACHE_VERSION to force old caches out on the next activate.
const CACHE_VERSION = "career-ops-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

// Only these paths are safe to cache-first — they're immutable/static and never
// reflect live-checkout state.
const STATIC_PATHS = new Set([
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
]);

function isImmutableStatic(url, request) {
  // Build assets are content-hashed and immutable.
  if (url.pathname.startsWith("/_next/static/")) return true;
  // Our PWA icons.
  if (/^\/icon-.*\.png$/.test(url.pathname)) return true;
  if (STATIC_PATHS.has(url.pathname)) return true;
  // Classic static asset destinations (scripts/styles/images/fonts). Note:
  // documents and "" (RSC/data fetches) are intentionally excluded.
  return ["script", "style", "image", "font"].includes(request.destination);
}

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

  // Immutable static assets: cache-first, then network (and populate cache).
  if (isImmutableStatic(url, request)) {
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
    return;
  }

  // Everything else (RSC/data payloads and any non-allowlisted GET): straight
  // to network. No cache-first, no stale fallback — these may reflect the live
  // local checkout.
});
