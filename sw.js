// Offline cache for the ABG O2 app. Bump CACHE when you replace any file.
const CACHE = "timpex-abg-v4";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve from cache first so the app opens instantly on poor hospital Wi-Fi;
// refresh the cached copy in the background when the network is there.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const key = e.request.mode === "navigate" ? "./index.html" : e.request;
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(key).then((hit) => {
        const fresh = fetch(e.request)
          .then((res) => { if (res && res.ok) cache.put(key, res.clone()); return res; })
          .catch(() => hit);
        return hit || fresh;
      })
    )
  );
});
