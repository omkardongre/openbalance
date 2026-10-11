// Serves the offline service worker with this build's identifier baked in. Browsers re-check the
// worker script on every navigation and install a new one only when its bytes change, so a fixed
// file (as before) kept the first saved app forever: a phone that had cached /offline once kept
// showing that old page offline after every deploy. A per-build cache name fixes that, and the
// activate step drops every older copy.

export const dynamic = "force-static";

const BUILD_ID = process.env.OPENBALANCE_BUILD_ID ?? "dev";

/** Pages a customer needs with no signal: the wallet (one link to remember) and Pay offline. */
const SHELL_ROUTES = ["/account", "/offline"];
const STATIC_FILES = ["/manifest.webmanifest", "/openbalance-icon.svg"];

const WORKER = `"use strict";
const CACHE_PREFIX = "openbalance-offline-shell-";
const CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(BUILD_ID)};
const SHELL_ROUTES = ${JSON.stringify(SHELL_ROUTES)};
const STATIC_FILES = ${JSON.stringify(STATIC_FILES)};
// Venue networks often "connect" but pass nothing; past this, a page loads from the saved copy.
const NETWORK_TIMEOUT_MS = 3000;

async function fetchOk(path) {
  const response = await fetch(path, { cache: "reload", credentials: "same-origin" });
  if (!response.ok) throw new Error("Offline copy request failed: " + path);
  return response;
}

// Saves each page together with the exact scripts and styles it references, all from this build,
// so a saved page never runs against another build's code. Any failure fails the install and the
// previous complete copy stays in use.
async function saveShell() {
  const cache = await caches.open(CACHE_NAME);
  const assets = new Set(STATIC_FILES);
  for (const route of SHELL_ROUTES) {
    const response = await fetchOk(route);
    const html = await response.clone().text();
    await cache.put(route, response);
    for (const match of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
      if (match[1] && match[1].startsWith("/_next/static/")) assets.add(match[1]);
    }
  }
  await Promise.all(
    [...assets].map(async (asset) => cache.put(asset, await fetchOk(asset))),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(saveShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Network timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Saved pages: the live page when the network answers, the saved copy when it does not.
  if (request.mode === "navigate" && SHELL_ROUTES.includes(url.pathname)) {
    event.respondWith(
      withTimeout(fetch(request), NETWORK_TIMEOUT_MS).catch(async () => {
        const cached = await caches.match(url.pathname, { cacheName: CACHE_NAME });
        return cached || Response.error();
      }),
    );
    return;
  }

  // Build files are content-hashed and never change, so the saved copy is always correct. One a
  // page loads later (not named in its HTML) is saved the first time it comes from the network.
  if (url.pathname.startsWith("/_next/static/") || STATIC_FILES.includes(url.pathname)) {
    event.respondWith(
      caches.match(request, { cacheName: CACHE_NAME }).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok && url.pathname.startsWith("/_next/static/")) {
              const copy = response.clone();
              event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
            }
            return response;
          }),
      ),
    );
  }
});
`;

export function GET() {
  return new Response(WORKER, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Always revalidate, so a deploy reaches phones on their next visit.
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
