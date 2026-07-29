const CACHE_NAME = "rumble-capability-lab-v0.4.0";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./styles.css?v=0.4.0",
  "./app.js",
  "./app.js?v=0.4.0",
  "./player-lab.html",
  "./player-lab.js",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./poster.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./silence.mp3",
];

let diagnosticsEnabled = true;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "set-diagnostics") diagnosticsEnabled = Boolean(event.data.enabled);
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});

async function notifyObservedFetch(event) {
  if (!diagnosticsEnabled) return;
  const request = event.request;
  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  client?.postMessage({
    type: "sw-fetch-observed",
    url: request.url,
    method: request.method,
    mode: request.mode,
    destination: request.destination,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
    hasRange: request.headers.has("range"),
    range: request.headers.get("range"),
    at: new Date().toISOString(),
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Observe all requests, but never intercept cross-origin media or player traffic.
  event.waitUntil(notifyObservedFetch(event));

  if (url.origin !== self.location.origin) return;
  if (request.method !== "GET") return;

  // Never cache or rewrite media/range requests. This avoids broken seeking and 206 handling.
  if (["audio", "video", "track"].includes(request.destination) || request.headers.has("range")) return;

  if (["script", "style"].includes(request.destination)) {
    event.respondWith((async () => {
      try {
        const network = await fetch(request);
        if (network.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, network.clone()).catch(() => {});
        }
        return network;
      } catch {
        return (await caches.match(request)) || Response.error();
      }
    })());
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const network = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put("./index.html", network.clone()).catch(() => {});
        return network;
      } catch {
        return (await caches.match("./index.html")) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  })());
});
