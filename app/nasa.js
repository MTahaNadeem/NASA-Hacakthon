/* Client + panel for the NASA data backend. No credentials here: the browser only sends lat/lon.
 * Rendering is pure (model() and html() take plain data), so it is unit-tested against real API responses. */
(function (root) {
  "use strict";

  function backendUrl() { var c = (root.AGRISHIFT || {}).backendUrl || ""; return String(c).replace(/\/+$/, ""); }
  // "backend": the optional server in backend/ (faster, adds weather indicators). "browser": no server; the page reads NASA and soil
  // files itself (direct.js). null: neither is possible (e.g. tests), so the NASA tab stays hidden.
  function mode() { if (backendUrl()) return "backend"; return root.DirectData && root.DirectData.available() ? "browser" : null; }
  function enabled() { return mode() !== null; }

  function get(path, timeoutMs) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 45000) : null;
    return fetch(backendUrl() + path, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) { if (timer) clearTimeout(timer); return j; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }
  function q(lat, lon) { return "?lat=" + encodeURIComponent(lat.toFixed(4)) + "&lon=" + encodeURIComponent(lon.toFixed(4)); }
  // Soil and satellite data come from two routes that are raced, because neither is fast everywhere:
  //  * the optional backend: a small JSON request, usually 0.5-15 s (shared cache, fast server link), but a free host can be asleep for about a minute;
  //  * the browser reading the files itself: about 5-10 s on a fast connection but 90+ s on a slow one (about 95 small requests for soil), and
  //    impossible in Firefox (it sends a CORS check for range requests that ISRIC's server does not answer) or on networks that block the file hosts.
  // The backend is asked at once. The browser route starts 2.5 s later if the backend has not answered, or immediately if the backend fails.
  // The first success wins. With no backend only the browser route exists; with no browser route only the backend. Errors are never hidden.
  var directBroken = false, RACE_DELAY_MS = 2500;
  function direct() { return !directBroken && root.DirectData && root.DirectData.available() ? root.DirectData : null; }
  function race(run, path, ms) {
    var d = direct(), hasBackend = !!backendUrl();
    if (!hasBackend) return d ? run(d) : Promise.reject(new Error("this browser cannot read the data files and no backend is configured"));
    if (!d) return get(path, ms);
    return new Promise(function (resolve, reject) {
      var done = false, started = false, errs = [], timer = null;
      function ok(v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } }
      function bad(e) { errs.push(e); if (errs.length === 2 && !done) { done = true; reject(errs[0]); } }
      function startDirect() { if (started || done) return; started = true; clearTimeout(timer); run(d).then(ok, function (e) { directBroken = true; bad(e); }); }
      get(path, ms).then(ok, function (e) { bad(e); startDirect(); });
      timer = setTimeout(startDirect, RACE_DELAY_MS);
    });
  }
  function fetchLocation(lat, lon) {
    if (mode() !== "backend") return root.DirectData.status();
    return get("/api/location" + q(lat, lon), 90000).catch(function (e) { if (!(root.DirectData && root.DirectData.available())) throw e; return root.DirectData.status(); });
  }
  function fetchNdvi(lat, lon) { return race(function (d) { return d.ndvi(lat, lon, 36); }, "/api/ndvi" + q(lat, lon) + "&months=36", 150000); }
  function fetchSoil(lat, lon) { return race(function (d) { return d.soil(lat, lon); }, "/api/soil" + q(lat, lon), 120000); }
  // Free hosts sleep when idle; touching /api/health as soon as the page opens starts the wake-up while the visitor is still choosing a place.
  function wake() { if (mode() === "backend") get('/api/health', 70000).catch(function () {}); }

  function num(x, d) { return x == null || isNaN(x) ? null : (+x).toFixed(d == null ? 0 : d); }
  function signed(x, d) { var s = num(x, d); return s == null ? null : (x > 0 ? "+" : "") + s; }

  function prov(label, p) {
    if (!p) return null;
    return { label: label, kind: p.kind, through: p.data_through || null, days: p.data_age_days, cached: !!p.served_from_cache,
             detail: { dataset: p.dataset, kind_text: p.kind_text, resolution: p.spatial_resolution, period: p.period, note: p.note } };
  }

  /* Turn API responses into what the panel shows. Everything is optional: a missing block is simply not drawn. */
  function model(loc, ndvi, soil) {
    var m = { recent: null, trend: null, sources: [], smap: null, imerg: null, ndvi: null };
    if (loc) {
      var r = loc.indicators && loc.indicators.recent_vs_normal;
      if (r) m.recent = { start: r.window_start, end: r.window_end, rain: num(r.rain_mm), norm: num(r.rain_normal_mm), pct: signed(r.rain_anomaly_pct),
                          t: num(r.t_mean_c, 1), d: signed(r.t_anomaly_c, 1), state: loc.soil_moisture && loc.soil_moisture.modelled && loc.soil_moisture.modelled.recent_state || null };
      var tr = loc.indicators && loc.indicators.trends;
      if (tr && tr.earlier_mean_rain_mm != null && tr.later_mean_rain_mm != null) m.trend = { a: num(tr.earlier_mean_rain_mm), b: num(tr.later_mean_rain_mm) };
      [prov("nasa.s.climate", loc.climate && loc.climate.provenance), prov("nasa.s.soil", loc.soil_moisture && loc.soil_moisture.modelled && loc.soil_moisture.modelled.provenance),
       prov("nasa.s.ind", loc.indicators && loc.indicators.provenance)].forEach(function (x) { if (x) m.sources.push(x); });
      var sm = loc.soil_moisture && loc.soil_moisture.smap, im = loc.rainfall && loc.rainfall.imerg;
      if (sm) m.smap = { date: sm.newest_acquisition, values: !!sm.values_available };
      if (im) m.imerg = { date: im.newest_acquisition, values: !!im.values_available };
    }
    if (ndvi && ndvi.ndvi) {
      var n = ndvi.ndvi, lat = n.latest;
      m.ndvi = { latest: lat ? num(lat.ndvi, 2) : null, date: lat ? lat.end : null, valid: n.valid_count, total: n.total_count,
                 series: (n.series || []).map(function (s) { return s.ndvi; }) };
      var p = prov("nasa.s.ndvi", n.provenance); if (p) m.sources.push(p);
    }
    if (soil && soil.provenance) { var sp = prov("nasa.s.soilgrids", soil.provenance); if (sp) m.sources.push(sp); }
    return m;
  }

  function spark(vals) {
    var W = 320, H = 64, n = vals.length; if (n < 2) return "";
    var path = "", pen = false;
    vals.forEach(function (v, i) {
      if (v == null) { pen = false; return; }
      var x = (i / (n - 1)) * W, y = H - 4 - Math.max(0, Math.min(1, v)) * (H - 8);
      path += (pen ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + " "; pen = true;
    });
    return path ? '<svg class="spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + path + '" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>' : "";
  }

  function html(m, t, esc) {
    var out = [];
    if (m.recent) {
      var r = m.recent, lines = [];
      if (r.rain != null && r.norm != null && r.pct != null) lines.push(t("nasa.rain", { mm: r.rain, norm: r.norm, pct: r.pct }));
      if (r.t != null && r.d != null) lines.push(t("nasa.temp", { t: r.t, d: r.d }));
      if (r.state) lines.push(t("nasa.soil", { state: t("nasa.st." + r.state) }));
      out.push('<div class="nasa-card"><h4>' + esc(t("nasa.recent")) + ' <small dir="ltr">' + esc(r.start + " → " + r.end) + "</small></h4><ul>" +
               lines.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul>" +
               (m.trend ? '<p class="mini">' + esc(t("nasa.trend", m.trend)) + "</p>" : "") + "</div>");
    }
    if (m.ndvi) {
      var v = m.ndvi;
      out.push('<div class="nasa-card"><h4>' + esc(t("nasa.ndvi")) + "</h4>" + spark(v.series) +
               (v.latest != null ? '<p class="mini">' + esc(t("nasa.ndviNow", { v: v.latest, date: v.date })) + "</p>" : "") +
               (v.valid < v.total ? '<p class="mini">' + esc(t("nasa.ndviGap", { n: v.total - v.valid, total: v.total })) + "</p>" : "") + "</div>");
    }
    [["nasa.smap", m.smap], ["nasa.imerg", m.imerg]].forEach(function (x) {
      if (x[1] && !x[1].values) out.push('<div class="nasa-card"><h4>' + esc(t(x[0])) + "</h4><p class='mini'>" + (x[1].date ? esc(t("nasa.pending", { date: x[1].date })) : "") + "</p></div>");
    });
    if (m.sources.length) {
      out.push('<div class="nasa-card"><h4>' + esc(t("nasa.src")) + '</h4><ul class="nasa-src">' + m.sources.map(function (s) {
        return '<li><span class="kind k-' + esc(s.kind) + '">' + esc(t("nasa.k." + s.kind)) + "</span> <b>" + esc(t(s.label)) + "</b>" +
          (s.through ? ' <small>' + esc(t("nasa.age", { date: s.through, days: s.days })) + "</small>" : "") +
          (s.cached ? ' <small>· ' + esc(t("nasa.cache")) + "</small>" : "") + "</li>";
      }).join("") + "</ul><p class='mini'>" + esc(t("nasa.notlive")) + " " + esc(t("nasa.cell")) + "</p>" +
        "<details><summary>" + esc(t("nasa.tech")) + "</summary><ul class='nasa-tech'>" + m.sources.map(function (s) {
          var d = s.detail; return "<li><b>" + esc(d.dataset || "") + "</b> — " + esc(d.kind_text || "") + (d.resolution ? "; " + esc(d.resolution) : "") +
            (d.period ? "; " + esc(d.period) : "") + (d.note ? ". " + esc(d.note) : "") + "</li>";
        }).join("") + "</ul></details></div>");
    }
    return out.join("");
  }

  var api = { _reset: function () { directBroken = false; }, _delay: function (ms) { RACE_DELAY_MS = ms; }, wake: wake, mode: mode, enabled: enabled, fetchLocation: fetchLocation, fetchNdvi: fetchNdvi, fetchSoil: fetchSoil, model: model, html: html, spark: spark };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.NasaPanel = api;
})(typeof window !== "undefined" ? window : globalThis);
