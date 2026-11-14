// The service worker must only ever cache same-origin app files and the static map/font CDN, never live API answers.
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "../app/sw.js"), "utf8");
const listeners = {}, puts = [];
const caches = { open: async () => ({ add: async () => {}, put: async (r) => puts.push(r.url) }), match: async () => undefined, keys: async () => [], delete: async () => {} };
class Req { constructor(url, method = "GET") { this.url = url; this.method = method; this.mode = "cors"; } }
const sandbox = { self: { addEventListener: (n, f) => { listeners[n] = f; }, location: { origin: "https://site.example" }, skipWaiting() {}, clients: { claim() {} } }, caches, URL, Response: class { static error() { return {}; } },
  fetch: async (r) => ({ ok: true, type: "basic", url: (r.url || r), clone() { return { url: this.url }; } }) };
vm.runInNewContext(src, sandbox);
const handle = (url, method) => { let responded = false; listeners.fetch({ request: new Req(url, method), respondWith: () => { responded = true; } }); return responded; };

// live API answers and data files are NOT intercepted (they go to the network, so polling sees fresh answers)
for (const u of ["https://agrishift-api.onrender.com/api/recent?lat=1&lon=2", "https://agrishift-api.onrender.com/api/location?lat=1&lon=2", "https://agrishift-api.onrender.com/api/soil?lat=1&lon=2",
  "https://agrishift-api.onrender.com/api/ndvi?lat=1&lon=2", "https://planetarycomputer.microsoft.com/api/sas/v1/token/modiseuwest/modis-061-cogs", "https://files.isric.org/soilgrids/latest/data/x.tif",
  "https://modiseuwest.blob.core.windows.net/modis-061-cogs/a.tif", "https://cmr.earthdata.nasa.gov/search/granules.umm_json", "https://power.larc.nasa.gov/api/x"])
  assert.strictEqual(handle(u), false, "must not intercept " + u);
// non-GET is never handled
assert.strictEqual(handle("https://site.example/anything", "POST"), false);
// the static map library and fonts ARE handled (cache-first, so the map works offline)
for (const u of ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", "https://fonts.googleapis.com/css2?family=Noto", "https://fonts.gstatic.com/s/x.woff2"]) assert.strictEqual(handle(u), true, "should handle " + u);
// same-origin app files are handled (network-first)
assert.strictEqual(handle("https://site.example/app.js"), true);
assert.ok(/rx-v[4-9]|rx-v\d{2,}/.test(src), "the cache version was bumped so old caches holding stale API answers are deleted");
console.log("service worker tests passed");
