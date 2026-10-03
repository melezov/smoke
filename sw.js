// Offline: the page's files are cached, so the installed app opens without a connection.
// Online, the network is asked first and the cache refreshed, so a new version of the app arrives by itself
// the next time the page is opened; offline, the cached copy is served.
const CACHE = "smoke";
const FILES = ["./", "index.html", "app.js", "products.json", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(async (cache) => {
        await cache.addAll(FILES.map((file) => new Request(file, { cache: "no-cache" })));
        // Every pack picture of the product list, so the settings list and any selection work offline too.
        const products = await (await fetch("products.json")).json();
        await Promise.all(products.map((product) => cache.add(product.image).catch(() => {})));
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    // "no-cache": always ask the server whether the file changed. GitHub Pages lets the browser reuse a file
    // for ten minutes without asking, so right after a deploy the page could run a new index.html with an old
    // app.js (2026-10-03: the settings button did nothing, the old script looked for an element the new page
    // no longer had).
    fetch(event.request.url, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
