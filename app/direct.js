/* Direct-from-the-browser data engine: no backend, no account, no key, no cost.
 *
 * Soil (ISRIC SoilGrids, NOT NASA) and MODIS NDVI (NASA, hosted by Microsoft Planetary Computer) are published as Cloud-Optimized
 * GeoTIFFs on servers that allow browser access (CORS), so the page reads the one pixel it needs with HTTP range requests.
 * Results have the same shape as backend/app, so the rest of the app does not care where they came from.
 *
 * Honest limits: SMAP and IMERG files need an Earthdata login that a public website cannot safely hold, so only their newest
 * acquisition DATE is fetched (public CMR search); their values are never shown. */
(function (root) {
  "use strict";

  var ISRIC = "https://files.isric.org/soilgrids/latest/data/";
  var PROPS = { ph: "phh2o", soc: "soc", sand: "sand", silt: "silt", clay: "clay" };
  var DEPTHS = [["0-5cm", 5], ["5-15cm", 10], ["15-30cm", 15]];       // weights = layer thickness (cm)
  var STATS = [["q05", "Q0.05"], ["mean", "mean"], ["q95", "Q0.95"]];
  var D_FACTOR = 10, NODATA = -32768, SEARCH_KM = [0, 2, 4, 8, 12, 16, 20, 25];
  var GT = [-19949750, 250, 0, 8361000, 0, -250], SIZE = [159246, 58034];
  var STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
  var TOKEN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/token/modiseuwest/modis-061-cogs";
  var MODIS_HOST = "modiseuwest.blob.core.windows.net", MODIS_R = 6371007.181;
  var CMR = "https://cmr.earthdata.nasa.gov/search/granules.umm_json";
  var MIN_COMPOSITES_PER_MONTH = 2, GOOD_RELIABILITY = [0, 1];

  function available() { return typeof window !== "undefined" && typeof fetch === "function"; }

  /* ---------- small utilities ---------- */
  function mapLimit(items, limit, fn) {
    var out = new Array(items.length), next = 0;
    function worker() { var i = next++; if (i >= items.length) return Promise.resolve(); return Promise.resolve(fn(items[i], i)).then(function (r) { out[i] = r; return worker(); }); }
    var ws = []; for (var k = 0; k < Math.min(limit, items.length); k++) ws.push(worker());
    return Promise.all(ws).then(function () { return out; });
  }
  function getJSON(url, opts, ms) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null, timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || 60000) : null;
    return fetch(url, Object.assign({ signal: ctl ? ctl.signal : undefined }, opts || {})).then(function (r) {
      if (timer) clearTimeout(timer); if (!r.ok) throw new Error("HTTP " + r.status + " from " + new URL(url).host); return r.json();
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }
  // Results are kept in this browser for a while so a revisit is instant. Storage can be blocked, so every access is guarded.
  function stash(key, ttlMs, loader) {
    var k = "agri.direct.v1:" + key, now = Date.now();
    try { var s = JSON.parse(localStorage.getItem(k) || "null"); if (s && now - s.t < s.ttl) { s.v.__cached = true; return Promise.resolve(s.v); } } catch (e) { /* ignore */ }
    return loader().then(function (v) { try { localStorage.setItem(k, JSON.stringify({ t: now, ttl: ttlMs, v: v })); } catch (e) { /* full or blocked: fine */ } return v; });
  }
  var libPromise = null;
  function lib() {   // the GeoTIFF reader is 300 KB, so it is only fetched the first time a place needs satellite data
    if (root.GeoTIFF) return Promise.resolve(root.GeoTIFF);
    if (!libPromise) libPromise = new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = "vendor/geotiff.js"; s.onload = function () { res(root.GeoTIFF); };
      s.onerror = function () { libPromise = null; rej(new Error("could not load the GeoTIFF reader")); }; document.head.appendChild(s);
    });
    return libPromise;
  }
  var images = {};
  function openImage(url) {
    if (!images[url]) images[url] = lib().then(function (G) { return G.fromUrl(url, { allowFullFile: false }); }).then(function (t) { return t.getImage(); })
      .catch(function (e) { delete images[url]; throw e; });
    return images[url];
  }
  function readPixel(image, col, row) {
    return image.readRasters({ window: [col, row, col + 1, row + 1], samples: [0], interleave: false }).then(function (r) { return r[0][0]; });
  }

  /* ---------- soil: ISRIC SoilGrids (not NASA) ---------- */
  function uniq(a) { return a[0] === a[1] ? [a[0]] : a; }
  var tileIdx = {};
  function tileIndex(prop) {
    if (!tileIdx[prop]) tileIdx[prop] = getJSON("data/soilgrids/tiles_" + PROPS[prop] + ".json", null, 90000).then(function (raw) {
      var step = 0, buckets = {};
      raw.tiles.forEach(function (t) { if (t[2] > step) step = t[2]; });
      raw.tiles.forEach(function (t) {   // a tile can straddle bucket edges, so it is listed in every bucket it touches
        var bxs = uniq([Math.floor(t[0] / step), Math.floor((t[0] + t[2] - 1) / step)]), bys = uniq([Math.floor(t[1] / step), Math.floor((t[1] + t[3] - 1) / step)]);
        bxs.forEach(function (bx) { bys.forEach(function (by) { var k = bx + "," + by; (buckets[k] = buckets[k] || []).push(t); }); });
      });
      return { step: step, buckets: buckets };
    }).catch(function (e) { delete tileIdx[prop]; throw e; });
    return tileIdx[prop];
  }
  function pixel(lat, lon) {
    var p = root.IGH.forward(lon, lat), col = Math.floor((p[0] - GT[0]) / GT[1]), row = Math.floor((p[1] - GT[3]) / GT[5]);
    return (col >= 0 && col < SIZE[0] && row >= 0 && row < SIZE[1]) ? [col, row] : null;
  }
  function tileFor(prop, col, row) {
    return tileIndex(prop).then(function (ix) {
      var list = ix.buckets[Math.floor(col / ix.step) + "," + Math.floor(row / ix.step)] || [];
      for (var i = 0; i < list.length; i++) { var t = list[i]; if (t[0] <= col && col < t[0] + t[2] && t[1] <= row && row < t[1] + t[3]) return { x: t[0], y: t[1], dir: t[4], sub: t[5] }; }
      return null;    // no tile = SoilGrids has no data here (sea, ice, ...)
    });
  }
  function layerUrl(prop, depth, stat, t) { var name = PROPS[prop] + "_" + depth + "_" + stat; return ISRIC + PROPS[prop] + "/" + name + "/" + t.dir + "/" + t.dir + "_" + t.sub + ".tif"; }
  function readValue(prop, depth, stat, col, row) {
    return tileFor(prop, col, row).then(function (t) {
      if (!t) return null;
      return openImage(layerUrl(prop, depth, stat, t)).then(function (img) { return readPixel(img, col - t.x, row - t.y); }).then(function (v) { return v === NODATA ? null : v; });
    });
  }
  function combine(raw) {
    var soil = {};
    Object.keys(PROPS).forEach(function (p) {
      var rec = {}, ok = true;
      STATS.forEach(function (s) {
        if (!ok) return; var acc = 0, ws = 0;
        DEPTHS.forEach(function (d) { var v = raw[p + "|" + d[0] + "|" + s[0]]; if (v == null) { ok = false; return; } acc += d[1] * v / D_FACTOR; ws += d[1]; });
        if (ok) rec[s[0]] = Math.round(acc / ws * 100) / 100;
      });
      if (ok) soil[p] = rec;
    });
    return soil;
  }
  function offsetPixel(lat, lon, km, bearing) {
    var b = bearing * Math.PI / 180;
    return pixel(lat + km / 111.32 * Math.cos(b), lon + km / (111.32 * Math.max(0.05, Math.cos(lat * Math.PI / 180))) * Math.sin(b));
  }
  // The requested pixel if SoilGrids has data there, else the nearest mapped pixel within 25 km (towns, water and ice are masked).
  // A pixel is accepted only if all five properties are mapped there.
  function nearestMapped(lat, lon) {
    function probe(c) { return Promise.all(Object.keys(PROPS).map(function (p) { return readValue(p, "0-5cm", "mean", c[0], c[1]); })).then(function (v) { return v.every(function (x) { return x != null; }); }); }
    function ring(i) {
      if (i >= SEARCH_KM.length) return Promise.resolve(null);
      var km = SEARCH_KM[i], cands = km === 0 ? [pixel(lat, lon)] : [0, 45, 90, 135, 180, 225, 270, 315].map(function (b) { return offsetPixel(lat, lon, km, b); });
      cands = cands.filter(Boolean); if (!cands.length) return ring(i + 1);
      return mapLimit(cands, 8, probe).then(function (ok) { for (var k = 0; k < cands.length; k++) if (ok[k]) return { col: cands[k][0], row: cands[k][1], km: km }; return ring(i + 1); });
    }
    return ring(0);
  }
  function prov(source, dataset, kind, extra) {
    var kinds = { observation: "Direct NASA observation", satellite_estimate: "NASA satellite-derived estimate", reanalysis: "NASA model / reanalysis estimate (not a direct measurement)", calculated: "Calculated by this app from the data above", third_party: "Not NASA" };
    var p = { source: source, dataset: dataset, kind: kind, kind_text: kinds[kind], is_live: false, data_through: null, data_age_days: null, served_from_cache: false, authentication_needed_by_farmer: false };
    return Object.assign(p, extra || {});
  }
  function ageDays(iso) { var d = Date.parse(iso); return isNaN(d) ? null : Math.max(0, Math.floor((Date.now() - d) / 86400000)); }

  function soil(lat, lon) {
    var px = pixel(lat, lon); if (!px) return Promise.reject(new Error("point is outside the SoilGrids map"));
    return stash("soil:" + px[0] + ":" + px[1], 90 * 86400000, function () {
      return nearestMapped(lat, lon).then(function (f) {
        if (!f) return { soil: {}, distance_km: null, reason: "SoilGrids has no soil data within 25 km (sea, ice, or an unmapped area)." };
        var jobs = []; Object.keys(PROPS).forEach(function (p) { DEPTHS.forEach(function (d) { STATS.forEach(function (s) { jobs.push([p, d[0], s]); }); }); });
        return mapLimit(jobs, 16, function (j) { return readValue(j[0], j[1], j[2][1], f.col, f.row); }).then(function (vals) {
          var raw = {}; jobs.forEach(function (j, i) { raw[j[0] + "|" + j[1] + "|" + j[2][0]] = vals[i]; });
          return { soil: combine(raw), distance_km: f.km, reason: null };
        });
      });
    }).then(function (rec) {
      var gaps = []; if (rec.reason) gaps.push(rec.reason); else if (rec.distance_km) gaps.push("No soil is mapped at the exact point (towns, water and ice are masked). Using the nearest mapped land " + rec.distance_km + " km away.");
      return { soil: rec.soil, distance_km: rec.distance_km, gaps: gaps, provenance: prov("ISRIC SoilGrids 2.0 (not NASA)", "SoilGrids mean, 5th and 95th percentile maps, 0-30 cm depth-weighted", "third_party",
        { units: "pH; organic carbon g/kg; clay, sand, silt %", spatial_resolution: "250 m", temporal_resolution: "static map", served_from_cache: !!rec.__cached,
          note: "A machine-learning prediction of soil properties, not a measurement of this field. The 5th-95th range shows its uncertainty." }) };
    });
  }

  /* ---------- MODIS NDVI (NASA) via the anonymous Planetary Computer STAC ---------- */
  function classify(raw, rel) {
    if (raw === -3000 || raw < -2000 || raw > 10000) return { ndvi: null, reliability: rel, reason: "no data (cloud, water or fill)" };
    if (rel != null && GOOD_RELIABILITY.indexOf(rel) < 0) return { ndvi: null, reliability: rel, reason: "pixel reliability too low (rank " + rel + ")" };
    return { ndvi: Math.round(raw * 0.0001 * 1e4) / 1e4, reliability: rel, reason: null };
  }
  function hostOk(href) { try { return new URL(href).hostname === MODIS_HOST; } catch (e) { return false; } }
  function parseItems(payload) {
    var out = [];
    (payload.features || []).forEach(function (f) {
      var p = f.properties || {}, a = f.assets || {}, nd = a["250m_16_days_NDVI"], rel = a["250m_16_days_pixel_reliability"];
      if (!nd || !hostOk(nd.href)) return;
      out.push({ id: f.id, sensor: f.id.indexOf("MOD") === 0 ? "Terra" : "Aqua", start: String(p.start_datetime || p.datetime || "").slice(0, 10), end: String(p.end_datetime || "").slice(0, 10),
        ndvi_href: nd.href, reliability_href: rel && hostOk(rel.href) ? rel.href : null });
    });
    out.sort(function (a, b) { return a.start < b.start ? 1 : -1; }); return out;
  }
  function sinu(lat, lon) { var la = lat * Math.PI / 180; return [MODIS_R * lon * Math.PI / 180 * Math.cos(la), MODIS_R * la]; }
  function modisValue(url, lat, lon) {
    return openImage(url).then(function (img) {
      var o = img.getOrigin(), r = img.getResolution(), xy = sinu(lat, lon), col = Math.floor((xy[0] - o[0]) / r[0]), row = Math.floor((xy[1] - o[1]) / r[1]);
      if (col < 0 || row < 0 || col >= img.getWidth() || row >= img.getHeight()) return { out: true };
      return readPixel(img, col, row).then(function (v) { return { v: v, col: col, row: row }; });
    });
  }
  function monthlyNdvi(rows) {
    var b = []; for (var m = 0; m < 12; m++) b.push([]);
    rows.forEach(function (r) { if (r.ndvi == null || !r.start) return; var d = new Date(Date.parse(r.start) + 8 * 86400000); b[d.getUTCMonth()].push(r.ndvi); });
    return { mean: b.map(function (v) { return v.length >= MIN_COMPOSITES_PER_MONTH ? Math.round(v.reduce(function (x, y) { return x + y; }, 0) / v.length * 1e4) / 1e4 : null; }), count: b.map(function (v) { return v.length; }) };
  }
  function ndvi(lat, lon, months) {
    months = months || 36;
    var key = "ndvi:" + Math.round(lat / 0.002) + ":" + Math.round(lon / 0.002) + ":" + months;
    return stash(key, 12 * 3600000, function () {
      var end = new Date(), start = new Date(end.getTime() - months * 30.5 * 86400000), iso = function (d) { return d.toISOString().slice(0, 10); };
      var body = { collections: ["modis-13Q1-061"], intersects: { type: "Point", coordinates: [lon, lat] }, datetime: iso(start) + "T00:00:00Z/" + iso(end) + "T23:59:59Z", limit: 200, sortby: [{ field: "datetime", direction: "desc" }] };
      return Promise.all([getJSON(STAC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 60000), getJSON(TOKEN_URL, null, 30000)]).then(function (r) {
        var items = parseItems(r[0]), tok = r[1].token; if (!tok) throw new Error("no MODIS read token");
        return mapLimit(items, 10, function (it) {
          return Promise.all([modisValue(it.ndvi_href + "?" + tok, lat, lon), it.reliability_href ? modisValue(it.reliability_href + "?" + tok, lat, lon) : Promise.resolve(null)]).then(function (v) {
            if (v[0].out) return { item_id: it.id, sensor: it.sensor, start: it.start, end: it.end, ndvi: null, reliability: null, reason: "point outside tile" };
            var c = classify(v[0].v, v[1] && !v[1].out ? v[1].v : null);
            return { item_id: it.id, sensor: it.sensor, start: it.start, end: it.end, ndvi: c.ndvi, reliability: c.reliability, reason: c.reason };
          }, function (e) { return { item_id: it.id, sensor: it.sensor, start: it.start, end: it.end, ndvi: null, reliability: null, reason: "read failed: " + (e && e.name || "error") }; });
        });
      });
    }).then(function (rows) {
      var cached = !!rows.__cached; rows = rows.slice ? rows : [];
      rows.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
      var good = rows.filter(function (r) { return r.ndvi != null; }), through = good.reduce(function (m, r) { return r.end > m ? r.end : m; }, ""), clim = monthlyNdvi(rows);
      var latest = good.length ? good.slice().sort(function (a, b) { return a.end < b.end ? -1 : 1; }).pop() : null;
      return { ndvi: { provenance: prov("NASA MODIS (hosted by Microsoft Planetary Computer)", "MOD13Q1 / MYD13Q1 v061 NDVI, 16-day composite", "satellite_estimate",
          { units: "NDVI (-1 to 1)", spatial_resolution: "250 m", temporal_resolution: "16-day composites (Terra and Aqua interleaved)", period: "last " + months + " months", data_through: through || null, data_age_days: through ? ageDays(through) : null, served_from_cache: cached,
            note: "Greenness from satellite reflectance, not a measurement of crop health. One 250 m pixel can mix fields, trees and buildings. Composites are typically weeks old." }),
        series: rows, latest: latest, valid_count: good.length, total_count: rows.length, monthly_mean: clim.mean, monthly_count: clim.count,
        monthly_note: "Average NDVI per calendar month over the last " + months + " months only. Not a long-term climatology." }, gaps: [] };
    });
  }
  /* ---------- SMAP / IMERG: newest acquisition date only (public CMR search) ---------- */
  function cmrLatest(shortName) {
    return stash("cmr:" + shortName, 3 * 3600000, function () {
      return getJSON(CMR + "?short_name=" + shortName + "&sort_key=-start_date&page_size=1", null, 30000).then(function (j) {
        var it = (j.items || [])[0]; if (!it) return { end: null };
        var r = (it.umm.TemporalExtent || {}).RangeDateTime || {}; return { end: String(r.EndingDateTime || "").slice(0, 10) || null, granule: it.umm.GranuleUR };
      });
    });
  }
  function status() {
    return Promise.all([cmrLatest("SPL3SMP_E").catch(function () { return null; }), cmrLatest("GPM_3IMERGDL").catch(function () { return null; })]).then(function (r) {
      return { soil_moisture: { smap: { newest_acquisition: r[0] && r[0].end, values_available: false, status: "discovery_only" } },
               rainfall: { imerg: { newest_acquisition: r[1] && r[1].end, values_available: false, status: "discovery_only" } } };
    });
  }

  var api = { available: available, soil: soil, ndvi: ndvi, status: status, _t: { combine: combine, classify: classify, parseItems: parseItems, monthlyNdvi: monthlyNdvi, sinu: sinu, pixel: pixel } };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DirectData = api;
})(typeof window !== "undefined" ? window : globalThis);
