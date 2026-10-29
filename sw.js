const VERSION = "wtl-v5";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "schema.json",
  "css/app.css",
  "css/fonts.css",
  "js/app.js",
  "js/calc.js",
  "js/data.js",
  "js/form.js",
  "js/geo.js",
  "js/map.js",
  "js/similar.js",
  "js/store.js",
  "js/util.js",
  "js/views.js",
  "js/world.js",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "data/world/countries.geojson",
  "data/world/indicators.json",
  "icons/icon.svg",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("wtl-") && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req, { cache: "no-cache" }).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    if (hit) {
      e.waitUntil(net.catch(() => {}));
      return hit;
    }
    return net.catch(() => cache.match("index.html"));
  }));
});
