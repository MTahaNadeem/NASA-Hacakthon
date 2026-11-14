/* Overview dashboard: turns the data the app already holds into the numbers and charts on the Overview page.
 * Everything here is a plain calculation on the loaded record (20-year monthly climate, SMAP climatology or recent SMAP, the top-ranked
 * rotation). Nothing is invented: a value that is not in the data is returned as null and shown as "n/a". */
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.Overview = factory(); })(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  function mean(a) { var v = a.filter(function (x) { return x != null && isFinite(x); }); return v.length ? v.reduce(function (s, x) { return s + x; }, 0) / v.length : null; }
  // average of one month across all years, or null when no year has it
  function monthly(series) { var out = []; for (var m = 0; m < 12; m++) out.push(mean(series.map(function (r) { return r[m]; }))); return out; }
  function monthsFor(period, nowMonth) { var n = period === "6m" ? 6 : 12, out = []; for (var i = 0; i < n; i++) out.push((nowMonth + i) % 12); return out; }
  var ICON = { wheat: "cereal", oats: "cereal", rice: "cereal", corn: "corn", sugarcane: "corn", soy: "bean", chickpea: "bean", mungbean: "bean", bean: "bean", groundnut: "bean" };
  function iconFor(id) { return ICON[id] || "leaf"; }


  // small line icons (24x24 viewBox) used by the dashboard
  var PATHS = {
    cereal: '<path d="M12 21V9"/><path d="M12 9c-2.5-.5-4-2-4-4.5 2.5.3 4 1.8 4 4.5zM12 9c2.5-.5 4-2 4-4.5-2.5.3-4 1.8-4 4.5zM12 14c-2.5-.5-4-2-4-4.5 2.5.3 4 1.8 4 4.5zM12 14c2.5-.5 4-2 4-4.5-2.5.3-4 1.8-4 4.5zM12 19c-2.5-.5-4-2-4-4.5 2.5.3 4 1.8 4 4.5zM12 19c2.5-.5 4-2 4-4.5-2.5.3-4 1.8-4 4.5zM12 4.5V2"/>',
    corn: '<path d="M12 22c-3.5-1-5-5-5-10C7 7 9 3 12 2c3 1 5 5 5 10 0 5-1.5 9-5 10z"/><path d="M9.5 8h5M8.5 12h7M9 16h6M12 2v20"/><path d="M7 22c-2-1-3-3-3-5M17 22c2-1 3-3 3-5"/>',
    bean: '<path d="M4 15c2-6 8-11 16-11-1 8-6 14-12 16-2 .5-4-1-4-3 0-.7 0-1.4 0-2z"/><circle cx="10" cy="11" r="1"/><circle cx="14" cy="8" r="1"/><circle cx="8" cy="15" r="1"/>',
    leaf: '<path d="M5 19c0-8 5-14 15-14 0 9-5 15-13 15"/><path d="M5 19c3-5 6-8 11-10"/>',
    temp: '<path d="M10 14V5a2 2 0 114 0v9a4 4 0 11-4 0z"/><path d="M12 9v7"/>',
    rain: '<path d="M7 16a4 4 0 010-8 5 5 0 019.6-1A4.5 4.5 0 0117 16"/><path d="M9 19l-1 2M13 19l-1 2M17 19l-1 2"/>',
    soil: '<path d="M12 3s6 6.5 6 11a6 6 0 11-12 0c0-4.5 6-11 6-11z"/>',
    arrow: '<path d="M3 12h17M15 6l6 6-6 6"/>', repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 01-4 4H4"/>'
  };
  function iconSvg(kind, size) { size = size || 24; return "<svg viewBox='0 0 24 24' width='" + size + "' height='" + size + "' aria-hidden='true' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>" + (PATHS[kind] || PATHS.leaf) + "</svg>"; }

  // d: loaded data object; top: best-ranked result {id, mean, low, high}; cfg: rotation config; opts: {period, nowMonth, recentSmap}
  function model(d, top, cfg, opts) {
    opts = opts || {}; if (!d || !d.climate) return null;
    var rainM = monthly(d.climate.rain), tempM = d.climate.tmean ? monthly(d.climate.tmean) : null, idx = monthsFor(opts.period, opts.nowMonth == null ? 0 : opts.nowMonth);
    var rain = rainM.every(function (v) { return v == null; }) ? null : idx.reduce(function (s, m) { return s + (rainM[m] || 0); }, 0);
    var temp = tempM ? mean(idx.map(function (m) { return tempM[m]; })) : null;
    var moist = null;
    if (d.smap_clim) { var v = mean(idx.map(function (m) { return d.smap_clim[m]; })); if (v != null) moist = { pct: v * 100, source: "climatology" }; }
    if (!moist && opts.recentSmap != null && isFinite(opts.recentSmap)) moist = { pct: opts.recentSmap * 100, source: "recent" };
    var plan = [];
    if (top && cfg && cfg.rotations && cfg.rotations[top.id]) cfg.rotations[top.id].cycle.forEach(function (year) { year.forEach(function (c) { plan.push(c); }); });
    return {
      score: top ? Math.round(top.mean * 100) : null, low: top ? Math.round(top.low * 100) : null, high: top ? Math.round(top.high * 100) : null,
      rotId: top ? top.id : null, plan: plan, temp: temp, rain: rain, moist: moist,
      trend: { rain: rainM, temp: tempM, years: d.years ? [d.years[0], d.years[d.years.length - 1]] : null }
    };
  }

  // Two-axis line chart: monthly mean temperature (left, orange) and rainfall (right, blue). Returns an SVG string.
  function trendSvg(trend, labels, t, esc) {
    if (!trend || !trend.temp) return "";
    var W = 560, H = 210, pl = 34, pr = 40, pt = 14, pb = 24, n = 12, x = function (i) { return pl + (W - pl - pr) * i / (n - 1); };
    var tv = trend.temp.filter(function (v) { return v != null; }), rv = trend.rain.filter(function (v) { return v != null; });
    if (!tv.length || !rv.length) return "";
    var tmin = Math.floor(Math.min.apply(null, tv) / 5) * 5, tmax = Math.ceil(Math.max.apply(null, tv) / 5) * 5 || tmin + 5, rmax = Math.max(10, Math.ceil(Math.max.apply(null, rv) / 20) * 20);
    var yt = function (v) { return pt + (H - pt - pb) * (1 - (v - tmin) / ((tmax - tmin) || 1)); }, yr = function (v) { return pt + (H - pt - pb) * (1 - v / rmax); };
    var line = function (arr, f, col) { var p = [], i; for (i = 0; i < arr.length; i++) if (arr[i] != null) p.push((p.length ? "L" : "M") + x(i).toFixed(1) + " " + f(arr[i]).toFixed(1)); return "<path d='" + p.join(" ") + "' fill='none' stroke='" + col + "' stroke-width='2.2' stroke-linejoin='round' stroke-linecap='round'/>"; };
    var s = "<svg viewBox='0 0 " + W + " " + H + "' width='100%' role='img' aria-label='" + esc(t("ov.trend.aria")) + "' direction='ltr' class='trendsvg'>";
    for (var k = 0; k <= 4; k++) {
      var gy = pt + (H - pt - pb) * k / 4;
      s += "<line x1='" + pl + "' x2='" + (W - pr) + "' y1='" + gy + "' y2='" + gy + "' stroke='currentColor' opacity='.12'/>";
      s += "<text x='" + (pl - 6) + "' y='" + (gy + 4) + "' text-anchor='end' fill='#c27a12'>" + Math.round(tmax - (tmax - tmin) * k / 4) + "</text>";
      s += "<text x='" + (W - pr + 6) + "' y='" + (gy + 4) + "' fill='#2a6fb0'>" + Math.round(rmax - rmax * k / 4) + "</text>";
    }
    s += line(trend.rain, yr, "#2a6fb0") + line(trend.temp, yt, "#e08a1a");
    for (var i = 0; i < n; i++) s += "<text x='" + x(i) + "' y='" + (H - 6) + "' text-anchor='middle'>" + esc(labels[i]) + "</text>";
    return s + "</svg>";
  }
  return { model: model, monthly: monthly, monthsFor: monthsFor, iconFor: iconFor, trendSvg: trendSvg, iconSvg: iconSvg, mean: mean };
});
