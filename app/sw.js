/* Rotation Explorer service worker: makes the app installable and usable offline for pages/places already visited.
 * Same-origin files are network-first (so you always get fresh code online, and the cached copy offline).
 * Live data APIs and map tiles are never cached here. */
const VERSION = "rx-v3", SHELL = ["./", "index.html", "style.css", "app.js", "scoring.js", "live.js", "config.js", "igh.js", "direct.js", "nasa.js", "i18n.js", "i18n/en.js", "places.json", "rotations.json", "data/index.json", "manifest.webmanifest", "icon.svg"];
const CDN = ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"];
const LIVE = /power\.larc\.nasa\.gov|rest\.isric\.org|geocoding-api\.open-meteo\.com|tile\.openstreetmap\.org/;

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    await Promise.all(CDN.map(u => fetch(u, { mode: "no-cors" }).then(r => c.put(u, r)).catch(() => {})));  // opaque copies so the map script works offline
    try { const idx = await (await fetch("data/index.json", { cache: "no-store" })).json(); await Promise.all(idx.map(l => c.add("data/" + l.id + ".json").catch(() => {}))); } catch (_) {}
  })());
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => { for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k); await self.clients.claim(); })());
});
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url); if (LIVE.test(url.host)) return;
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))));
  } else {
    // Leaflet from unpkg and the font files: cache-first so the map still loads offline
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })));
  }
});
