/* Live data for any location on Earth: NASA POWER (climate) + SoilGrids (soil), fetched in the browser.
 * MODIS, SMAP and IMERG need an Earthdata login and queued jobs, so they are NOT available live;
 * the resulting data object lists them under "gaps" and the scoring drops the factors that need them.
 * Mirrors pipeline/build_cache.py so live and cached locations are scored the same way. */
(function (root) {
  "use strict";
  var Y0 = 2004, Y1 = 2023, HEAT_C = 35, FROST_C = 0, EXTREME_MM = 50;
  var DEPTH_W = { "0-5cm": 5, "5-15cm": 10, "15-30cm": 15 };
  var PROPS = { phh2o: "ph", soc: "soc", sand: "sand", silt: "silt", clay: "clay" };
  var UNITS = { ph: "pH", soc: "g/kg", sand: "%", silt: "%", clay: "%" };

  function withTimeout(url, ms) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, ms);
    return fetch(url, { signal: ctl.signal }).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); },
      function (e) { clearTimeout(t); throw e.name === "AbortError" ? new Error("timed out") : e; });
  }
  function grid() { var g = []; for (var y = 0; y <= Y1 - Y0; y++) g.push(new Array(12).fill(0)); return g; }
  function r2(g) { return g.map(function (r) { return r.map(function (v) { return Math.round(v * 100) / 100; }); }); }

  function parsePower(json) {
    var p = json.properties.parameter, rain = grid(), ts = grid(), tc = grid(), ext = grid(), validRain = 0, total = 0, d;
    var heatDt = [0, 1, 2, 3, 4].map(grid), frostDt = [0, 1, 2, 3, 4].map(grid);
    function each(name, fn) { var s = p[name]; Object.keys(s).forEach(function (k) { var v = s[k], y = +k.slice(0, 4), m = +k.slice(4, 6) - 1; if (y >= Y0 && y <= Y1) fn(y - Y0, m, v); }); }
    each("PRECTOTCORR", function (y, m, v) { total++; if (v > -990) { validRain++; rain[y][m] += v; if (v >= EXTREME_MM) ext[y][m]++; } });
    each("T2M", function (y, m, v) { if (v > -990) { ts[y][m] += v; tc[y][m]++; } });
    each("T2M_MAX", function (y, m, v) { if (v > -990) for (d = 0; d < 5; d++) if (v >= HEAT_C - d) heatDt[d][y][m]++; });
    each("T2M_MIN", function (y, m, v) { if (v > -990) for (d = 0; d < 5; d++) if (v <= FROST_C - d) frostDt[d][y][m]++; });
    if (!total || validRain / total < 0.9) throw new Error("NO_LAND");
    var tmean = ts.map(function (r, y) { return r.map(function (s, m) { return tc[y][m] ? Math.round(s / tc[y][m] * 10) / 10 : null; }); });
    var by = function (a) { var o = {}; a.forEach(function (g, i) { o[String(i)] = g; }); return o; };
    return { rain: r2(rain), tmean: tmean, heat_days: heatDt[0], frost_days: frostDt[0], extreme_days: ext, heat_by_dt: by(heatDt), frost_by_dt: by(frostDt) };
  }

  function pick(vals, name) { for (var k in (vals || {})) if (String(k).toLowerCase() === name) return vals[k]; return null; }
  function parseSoil(json) {
    var soil = {};
    ((json.properties && json.properties.layers) || []).forEach(function (layer) {
      var key = PROPS[layer.name]; if (!key) return;
      var df = (layer.unit_measure && layer.unit_measure.d_factor) || 1, acc = { q05: 0, mean: 0, q95: 0 }, ws = 0;
      (layer.depths || []).forEach(function (d) {
        var v = d.values || {}, mean = pick(v, "mean"); if (mean == null) return;
        var lo = pick(v, "q0.05"), hi = pick(v, "q0.95"); if (lo == null || hi == null) { lo = hi = mean; }
        var r = d.range || {}, w = (r.top_depth != null && r.bottom_depth != null) ? r.bottom_depth - r.top_depth : DEPTH_W[String(d.label).replace(/ /g, "")];
        if (w > 0) { acc.q05 += w * lo / df; acc.mean += w * mean / df; acc.q95 += w * hi / df; ws += w; }
      });
      if (ws) soil[key] = { q05: Math.round(acc.q05 / ws * 100) / 100, mean: Math.round(acc.mean / ws * 100) / 100, q95: Math.round(acc.q95 / ws * 100) / 100 };
    });
    return soil;
  }

  function fetchPower(lat, lon) {
    var u = "https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,T2M,T2M_MAX,T2M_MIN&community=AG&format=JSON" +
      "&latitude=" + lat + "&longitude=" + lon + "&start=" + Y0 + "0101&end=" + Y1 + "1231";
    return withTimeout(u, 90000).then(parsePower);
  }
  var SOIL_ALL = { props: ["phh2o", "soc", "sand", "silt", "clay"], depths: ["0-5cm", "5-15cm", "15-30cm"], vals: ["Q0.05", "mean", "Q0.95"] };
  function soilUrl(lat, lon, o) {
    return "https://rest.isric.org/soilgrids/v2.0/properties/query?lon=" + lon + "&lat=" + lat +
      o.props.map(function (p) { return "&property=" + p; }).join("") + o.depths.map(function (d) { return "&depth=" + d; }).join("") + o.vals.map(function (v) { return "&value=" + v; }).join("");
  }
  function kmBetween(a, b, c, d) { var p = Math.PI / 180, x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); }
  // SoilGrids has no values under built-up land or water (city centres!). Try the 4 neighbours at ~11 km, then ~22 km, and use the nearest farmland cell.
  function nearbySoil(lat, lon) {
    var rings = [0.1, 0.2], dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]], k = Math.max(0.2, Math.cos(lat * Math.PI / 180));
    function ring(i) {
      if (i >= rings.length) return Promise.resolve({ soil: null, km: 0 });
      var c = dirs.map(function (d) { return [Math.round((lat + d[0] * rings[i]) * 1e4) / 1e4, Math.round((lon + d[1] * rings[i] / k) * 1e4) / 1e4]; });
      return Promise.all(c.map(function (p) { return withTimeout(soilUrl(p[0], p[1], { props: ["phh2o"], depths: ["0-5cm"], vals: ["mean"] }), 25000).then(function (j) { return !!parseSoil(j).ph; }, function () { return false; }); })).then(function (oks) {
        var n = oks.indexOf(true); if (n < 0) return ring(i + 1);
        return withTimeout(soilUrl(c[n][0], c[n][1], SOIL_ALL), 45000).then(parseSoil).then(function (s) { return s.ph ? { soil: s, km: Math.round(kmBetween(lat, lon, c[n][0], c[n][1]) * 10) / 10 } : ring(i + 1); });
      });
    }
    return ring(0);
  }
  function fetchSoil(lat, lon) {
    return withTimeout(soilUrl(lat, lon, SOIL_ALL), 45000).then(parseSoil).then(function (s) { return s.ph ? { soil: s, km: 0 } : nearbySoil(lat, lon); });
  }

  // Resolves with a data object shaped like app/data/<id>.json. Soil failure is non-fatal; POWER failure is fatal.
  function fetchLocation(lat, lon, onStatus) {
    onStatus = onStatus || function () {};
    lat = Math.round(lat * 100) / 100; lon = Math.round(lon * 100) / 100;
    onStatus("st.fetchPower");
    return fetchPower(lat, lon).then(function (climate) {
      onStatus("st.fetchSoil");
      return fetchSoil(lat, lon).then(function (r) { return [climate, r, null]; }, function (e) { return [climate, null, e.message]; });
    }).then(function (r) {
      var years = []; for (var y = Y0; y <= Y1; y++) years.push(y);
      var gaps = [
        "Live location: MODIS NDVI is not used, so the bare-field factor is dropped.",
        "Live location: SMAP soil moisture is not used, so no soil-moisture adjustment is applied to the water factor.",
        "Live location: GPM IMERG is not used, so extreme-rain days come from POWER rainfall and rain is not cross-checked."
      ];
      var d = { synthetic: false, live: true, id: "custom", name: "Custom location", lat: lat, lon: lon, years: years, climate: r[0],
        gaps: gaps, sources: { power: "NASA POWER" },
        rain_crosscheck: { power_vs_imerg_pct_diff: null, note: "Live location: POWER was not cross-checked against IMERG." },
        resolution_note: "POWER ~0.5 deg (~50 km); SoilGrids 250 m. Results describe the surrounding area, not one field." };
      if (r[1] && r[1].soil && r[1].soil.ph) {
        d.soil = r[1].soil; d.soil_units = UNITS; d.sources.soilgrids = "SoilGrids (ISRIC)";
        if (r[1].km) gaps.push("Soil values come from a farmland cell about " + r[1].km + " km from the pin, because the pin is on built-up land or water where SoilGrids has no data.");
      }
      else gaps.unshift("SoilGrids unavailable for this point (" + (r[2] || "no soil data, e.g. water or urban area") + "): soil fit and soil-carbon factors are dropped.");
      return d;
    });
  }

  // Rough starting suggestion only; the user can switch the rotation set.
  function suggestPreset(d) {
    function yr(s) { return s.reduce(function (a, r) { return a + r.reduce(function (x, y) { return x + y; }, 0); }, 0) / s.length; }
    var frost = yr(d.climate.frost_days), heat = yr(d.climate.heat_days);
    if (frost > 30) return "temperate_corn";
    if (frost >= 2 && heat >= 30) return "south_asia_wheat";
    return "tropical_maize";
  }

  var api = { fetchLocation: fetchLocation, parsePower: parsePower, parseSoil: parseSoil, suggestPreset: suggestPreset };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.LiveData = api;
})(typeof window !== "undefined" ? window : globalThis);
