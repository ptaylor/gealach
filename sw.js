// sw.js
//
// Service worker: cache the app shell (cache-first) and API responses
// (network-first with a short TTL). Every cached API response carries an
// "x-gealach-fetched" header so the UI can show an honest "as of" timestamp
// instead of a silently stale number.
//
// A service worker only runs over HTTPS or localhost — see AGENTS.md.

const VERSION = "v0.8";
const SHELL_CACHE = `gealach-shell-${VERSION}`;
const API_CACHE = `gealach-api-${VERSION}`;

const SHELL_URLS = [
  "./",
  "./index.html",
  "./js/app.js",
  "./js/sources.js",
  "./js/tide.js",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/icon-180.png",
];

const API_HOSTS = [
  "erddap.marine.ie",
  "marine-api.open-meteo.com",
  "geocoding-api.open-meteo.com",
  "api.tidesandcurrents.noaa.gov",
];

const API_TTL_MS = 5 * 60 * 1000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) =>
                (k.startsWith("taoidi-") || k.startsWith("gealach-")) &&
                k !== SHELL_CACHE &&
                k !== API_CACHE,
            )
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (API_HOSTS.includes(url.hostname)) {
    event.respondWith(apiRespond(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(shellRespond(request));
  }
});

async function shellRespond(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put(request, fresh.clone());
    return fresh;
  } catch {
    return new Response("Offline and not cached.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

async function apiRespond(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      const stamped = stamp(fresh);
      await cache.put(request, stamped.clone());
      return stamped;
    }
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (!cached) {
      return new Response(JSON.stringify({ error: "offline and not cached" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Return the last thing we saw; the x-gealach-fetched header lets the UI
    // label it as old rather than pretending it is fresh.
    return cached;
  }
}

function stamp(response) {
  const headers = new Headers(response.headers);
  headers.set("x-gealach-fetched", new Date().toUTCString());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
