/* eslint-disable no-restricted-globals */
/** Public app assets only. Private API responses and development modules never
 * enter CacheStorage. Navigation uses fresh HTML with a public shell fallback;
 * immutable production bundles and icons can work offline. Updates retain the
 * existing user-controlled reload notification in shell/sw-update.ts. */
const CACHE_VERSION = "v5";
const STATIC_CACHE = `harness-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `harness-runtime-${CACHE_VERSION}`;
const PRECACHE_URLS = [
  "/", "/manifest.json", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await Promise.all(PRECACHE_URLS.map((url) =>
      cache.add(new Request(url, { cache: "reload" })).catch(() => {
        // An unavailable optional icon must not prevent an update.
      }),
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // CacheStorage is shared by the whole origin. Retire only this worker's
    // exact versioned namespace, including old URL-keyed private API entries.
    await Promise.all(keys.filter((key) => /^harness-(?:static|runtime)-v\d+$/.test(key)
      && key !== STATIC_CACHE && key !== RUNTIME_CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isDevelopmentModule(url) {
  return url.pathname.startsWith("/src/") || url.pathname.startsWith("/@")
    || url.pathname.startsWith("/node_modules/") || url.pathname.startsWith("/shared/");
}

function isPublicAsset(url) {
  return url.pathname.startsWith("/icons/") || url.pathname === "/manifest.json"
    || /^\/assets\/[^/]+-[\w-]{8,}\.(?:js|css|mjs|png|svg|ico|jpg|jpeg|gif|webp|woff2?|ttf|eot)$/i.test(url.pathname);
}

function isStream(req, url) {
  return (req.headers.get("accept") ?? "").includes("text/event-stream")
    || (url.pathname.startsWith("/api/run/") && url.pathname.endsWith("/stream"));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isStream(req, url)
    || url.pathname === "/api" || url.pathname.startsWith("/api/")
    || isDevelopmentModule(url)) return;

  // The document owner is the root SPA shell. Other navigations may be
  // downloads or authenticated documents and have no public-shell fallback.
  if (req.mode === "navigate" && url.pathname === "/") {
    event.respondWith(networkFirst(req, event));
  } else if (isPublicAsset(url)) {
    event.respondWith(cacheFirst(req, event));
  }
  // Everything else is network-only. No catch-all can cache user files,
  // authenticated responses or mutable unversioned module graphs.
});

function persistResponse(event, cacheName, req, response) {
  // Persistence is optional work owned by this fetch event, never a gate on
  // delivering a successful network response. Observe failure once and settle.
  const stored = response.clone();
  event.waitUntil(caches.open(cacheName).then(cache => cache.put(req, stored))
    .catch(error => console.warn("Public asset cache write failed", cacheName, error)));
}

async function cacheFirst(req, event) {
  try {
    const cached = await (await caches.open(STATIC_CACHE)).match(req);
    if (cached) return cached;
  } catch (error) {
    console.warn("Public asset cache read failed", STATIC_CACHE, error);
  }
  try {
    const response = await fetch(req);
    if (response.ok) persistResponse(event, STATIC_CACHE, req, response);
    return response;
  } catch {
    return new Response("Offline and not cached.", { status: 504, statusText: "Gateway Timeout" });
  }
}

async function networkFirst(req, event) {
  try {
    const response = await fetch(req);
    if (response.ok && !response.redirected && response.headers.get("content-type")?.includes("text/html")
      && !response.headers.has("content-disposition")
      && !/(?:private|no-store)/i.test(response.headers.get("cache-control") ?? "")) {
      // App state lives in existing stores, not in separate documents. All
      // root query variants share this one public HTML shell cache entry.
      persistResponse(event, RUNTIME_CACHE, "/", response);
    }
    return response;
  } catch {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match("/");
    if (cached) return cached;
    const shell = await (await caches.open(STATIC_CACHE)).match("/");
    return shell ?? new Response("Offline and not cached.", { status: 504, statusText: "Gateway Timeout" });
  }
}
