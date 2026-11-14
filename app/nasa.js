/* Client + panel for the NASA data backend. No credentials here: the browser only sends lat/lon.
 * Rendering is pure (model() and html() take plain data), so it is unit-tested against real API responses. */
(function (root) {
  "use strict";

  function backendUrl() { var c = (root.AGRISHIFT || {}).backendUrl || ""; return String(c).replace(/\/+$/, ""); }
  function enabled() { return !!backendUrl(); }

  function get(path, timeoutMs) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 45000) : null;
    return fetch(backendUrl() + path, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) { if (timer) clearTimeout(timer); return j; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }
  function q(lat, lon) { return "?lat=" + encodeURIComponent(lat.toFixed(4)) + "&lon=" + encodeURIComponent(lon.toFixed(4)); }
  function fetchLocation(lat, lon) { return get("/api/location" + q(lat, lon)); }
  function fetchNdvi(lat, lon) { return get("/api/ndvi" + q(lat, lon) + "&months=36", 150000); }
  // Free hosts sleep when idle; touching /api/health as soon as the page opens starts the wake-up while the visitor is still choosing a place.
  function wake() { if (enabled()) get('/api/health', 70000).catch(function () {}); }
  function fetchSoil(lat, lon) { return get("/api/soil" + q(lat, lon), 90000); }

  function num(x, d) { return x == null || isNaN(x) ? null : (+x).toFixed(d == null ? 0 : d); }
  function signed(x, d) { var s = num(x, d); return s == null ? null : (x > 0 ? "+" : "") + s; }

  function prov(label, p) {
    if (!p) return null;
    return { label: label, kind: p.kind, through: p.data_through || null, days: p.data_age_days, cached: !!p.served_from_cache,
             detail: { dataset: p.dataset, kind_text: p.kind_text, resolution: p.spatial_resolution, period: p.period, note: p.note } };
  }

  /* Turn API responses into what the panel shows. Everything is optional: a missing block is simply not drawn. */
  function model(loc, ndvi) {
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

  var api = { wake: wake, enabled: enabled, fetchLocation: fetchLocation, fetchNdvi: fetchNdvi, fetchSoil: fetchSoil, model: model, html: html, spark: spark };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.NasaPanel = api;
})(typeof window !== "undefined" ? window : globalThis);
