const CACHE_NAME = "openbalance-offline-shell-v1";
const OFFLINE_ROUTE = "/offline";

async function cacheOfflineShell() {
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch(OFFLINE_ROUTE, { cache: "reload", credentials: "same-origin" });
  if (!response.ok) throw new Error("Offline shell request failed");
  await cache.put(OFFLINE_ROUTE, response.clone());
  const html = await response.text();
  const assets = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
    const path = match[1];
    if (path?.startsWith("/_next/static/")) assets.add(path);
  }
  await Promise.all(
    [...assets].map(async (asset) => {
      const assetResponse = await fetch(asset, { cache: "reload", credentials: "same-origin" });
      if (!assetResponse.ok) throw new Error(`Offline asset request failed: ${asset}`);
      await cache.put(asset, assetResponse);
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheOfflineShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("openbalance-offline-shell-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === OFFLINE_ROUTE && event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = await caches.match(OFFLINE_ROUTE);
        if (!cached) throw new Error("Offline shell is not installed");
        return cached;
      }),
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
  }
});
