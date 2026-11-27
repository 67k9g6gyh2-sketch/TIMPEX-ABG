// Offline cache for TIMPEX Gas & Vent. Bump CACHE when you replace any file.
const CACHE = "timpex-gasvent-v16-3";
// Caches are shared by every app on this origin (other TIMPEX apps live beside this one on github.io).
// Delete only this app's own older caches: "timpex-gasvent-vN" and the names it used before ("timpex-abg-vN", "abg-o2-vN").
const OWN = /^(timpex-gasvent|timpex-abg|abg-o2)-v\d+(-\d+)?$/;
function isOldOwnCache(key) { return key !== CACHE && OWN.test(key); }
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter(isOldOwnCache).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page (navigation): network first, so an update shows on the first open when there is signal;
// fall back to the cached copy within 3 s or when offline (poor hospital Wi-Fi, no signal).
// Icons and manifest: cache first, refreshed in the background.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  if (e.request.mode === "navigate") {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(url.origin + url.pathname, { signal: ctrl.signal, cache: "no-store" });
        clearTimeout(timer);
        if (res && res.ok) { cache.put("./index.html", res.clone()); return res; }
        throw new Error("bad response");
      } catch (err) {
        return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
      }
    })());
    return;
  }

  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(e.request).then((hit) => {
        const fresh = fetch(e.request)
          .then((res) => { if (res && res.ok) cache.put(e.request, res.clone()); return res; })
          .catch(() => hit);
        return hit || fresh;
      })
    )
  );
});
