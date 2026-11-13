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
  function fetchSoil(lat, lon) {
    var u = "https://rest.isric.org/soilgrids/v2.0/properties/query?lon=" + lon + "&lat=" + lat +
      ["phh2o", "soc", "sand", "silt", "clay"].map(function (p) { return "&property=" + p; }).join("") +
      ["0-5cm", "5-15cm", "15-30cm"].map(function (d) { return "&depth=" + d; }).join("") +
      ["Q0.05", "mean", "Q0.95"].map(function (v) { return "&value=" + v; }).join("");
    return withTimeout(u, 45000).then(parseSoil);
  }

  // Resolves with a data object shaped like app/data/<id>.json. Soil failure is non-fatal; POWER failure is fatal.
  function fetchLocation(lat, lon, onStatus) {
    onStatus = onStatus || function () {};
    lat = Math.round(lat * 100) / 100; lon = Math.round(lon * 100) / 100;
    onStatus("st.fetchPower");
    return fetchPower(lat, lon).then(function (climate) {
      onStatus("st.fetchSoil");
      return fetchSoil(lat, lon).then(function (soil) { return [climate, soil, null]; }, function (e) { return [climate, null, e.message]; });
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
      if (r[1] && r[1].ph) { d.soil = r[1]; d.soil_units = UNITS; d.sources.soilgrids = "SoilGrids (ISRIC)"; }
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
