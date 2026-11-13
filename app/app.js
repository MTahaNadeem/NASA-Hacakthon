/* Rotation Explorer UI. Reads cached static files (data/*.json, rotations.json); other points use live.js.
 * All visible text goes through I18N.t() so the language switcher can re-render everything. */
(function () {
  "use strict";
  var t = I18N.t;
  var SRC = ["power", "soilgrids", "modis", "smap", "imerg"], SRC_NAME = { power: "NASA POWER", soilgrids: "SoilGrids", modis: "MODIS", smap: "SMAP", imerg: "GPM IMERG" };
  var state = { cfgRaw: null, cfg: null, index: [], loc: null, data: null, sl: { water: .5, income: .5, soil: .5 }, rainDelta: 0,
    map: null, markers: {}, customMarker: null, loadToken: 0, tab: "rot", status: null, places: [] };
  var $ = function (id) { return document.getElementById(id); };
  var mean = Scoring.mean;
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function f2(x) { return x == null || isNaN(x) ? "n/a" : x.toFixed(2); }
  function getJSON(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }); }

  /* ---------- helpers: names, months, gaps ---------- */
  function cropName(id) { return t("crop." + id); }
  function rotLabel(id) {
    var c = state.cfgRaw.rotations[id].cycle, plan = function (p) { return p.map(cropName).join(" + "); };
    if (c.length === 1) return c[0].length === 1 ? t("rot.mono", { c: cropName(c[0][0]) }) : plan(c[0]);
    return t("rot.cycle", { list: c.map(plan).join(c.length === 2 ? " ↔ " : " → ") });
  }
  function months() {
    try { var f = new Intl.DateTimeFormat(I18N.lang(), { month: "narrow" }); var o = []; for (var m = 0; m < 12; m++) o.push(f.format(new Date(2000, m, 15))); return o; }
    catch (e) { return "JFMAMJJASOND".split(""); }
  }
  var GAPS = [[/^PLACEHOLDER/, "gap.synth"], [/^MODIS NDVI missing/, "gap.modis"], [/^SMAP missing/, "gap.smap"], [/^IMERG missing/, "gap.imerg"], [/^SoilGrids missing/, "gap.soilmissing"],
    [/^Live location: MODIS/, "gap.live.modis"], [/^Live location: SMAP/, "gap.live.smap"], [/^Live location: GPM IMERG/, "gap.live.imerg"], [/^SoilGrids unavailable/, "gap.live.soil"]];
  function gapText(g) {
    for (var i = 0; i < GAPS.length; i++) if (GAPS[i][0].test(g)) {
      var m = /\((.*)\)/.exec(g); return t(GAPS[i][1], { why: m ? m[1] : "" });
    }
    return g;
  }
  function placeName(p) { var n = p.names || {}; return n[I18N.lang()] || n.en || p.id; }
  function findPlace(id) { return state.places.filter(function (p) { return p.id === id; })[0]; }
  function locName() {
    var l = state.loc; if (!l) return "";
    var p = l.placeId && findPlace(l.placeId); if (p) return placeName(p);
    if (l.mine) return t("loc.mine", { lat: l.lat.toFixed(2), lon: l.lon.toFixed(2) });
    if (l.label) return l.label;
    if (l.id === "custom") return t("loc.custom", { lat: l.lat.toFixed(2), lon: l.lon.toFixed(2) });
    var k = "loc." + l.id, v = t(k); return v === k ? l.name : v;
  }

  /* ---------- status ---------- */
  function setStatus(key, params, isErr) { state.status = key ? { key: key, params: params, err: !!isErr } : null; renderStatus(); }
  function renderStatus() {
    var el = $("status"), s = state.status; el.className = "status" + (s && s.err ? " err" : "");
    el.textContent = s ? t(s.key, s.params) : "";
  }

  /* ---------- static text ---------- */
  function applyStatic() {
    var code = I18N.lang();
    document.documentElement.lang = code; document.documentElement.dir = I18N.dir();
    document.title = t("meta.title");
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (e) { e.textContent = t(e.getAttribute("data-i18n")); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-ph]"), function (e) { e.placeholder = t(e.getAttribute("data-i18n-ph")); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-aria]"), function (e) { e.setAttribute("aria-label", t(e.getAttribute("data-i18n-aria"))); });
    $("lang").value = code;
  }

  function buildLangSelect() {
    var sel = $("lang");
    I18N.LANGS.forEach(function (l) { var o = document.createElement("option"); o.value = l.code; o.textContent = l.name; sel.appendChild(o); });
    sel.addEventListener("change", function () { setLang(sel.value); });
  }
  function setLang(code) {
    return I18N.set(code).then(function () {
      I18N.remember(I18N.lang()); applyStatic(); buildPresetOptions(); buildLocationList(); renderStatus(); renderMapTips(); renderHow();
      if (state.data) { renderBanner(); renderProfile(); renderAll(); }
    });
  }

  /* ---------- decorative hero art (no data) ---------- */
  function buildArt() {
    var cols = ["#2f7d52", "#3f9b69", "#e3a53b", "#1f5a3b", "#7fc28f", "#b98a2e"], h = "", i;
    for (i = 0; i < 40; i++) h += "<i style='background:" + cols[(i * 7 + Math.floor(i / 8) * 3) % cols.length] + ";animation-delay:" + ((i % 8) * 0.35) + "s;opacity:" + (0.55 + ((i * 13) % 5) / 12) + "'></i>";
    $("art").innerHTML = h;
  }

  /* ---------- scenario ---------- */
  function scenarioData(d, pct) {
    if (!pct) return d;
    var c = JSON.parse(JSON.stringify(d)), k = 1 + pct / 100;
    c.climate.rain = c.climate.rain.map(function (r) { return r.map(function (v) { return v * k; }); });
    return c;
  }

  /* ---------- init ---------- */
  function init() {
    buildArt(); buildLangSelect();
    var code = I18N.detect();
    Promise.all([getJSON("rotations.json"), getJSON("data/index.json"), I18N.set(code), getJSON("places.json")]).then(function (r) {
      state.cfgRaw = r[0]; state.cfg = r[0]; state.index = r[1]; state.places = r[3];
      applyStatic(); buildPresetOptions(); buildLocationList(); buildMap(); bindInputs(); bindTabs(); renderHow();
      selectPlace(state.places.filter(function (p) { return p.hero; })[0] || state.places[0]);
    }).catch(function (e) { $("profile").textContent = "Could not load data: " + e.message; });
  }

  function buildPresetOptions() {
    var sel = $("preset"), v = sel.value; sel.innerHTML = "";
    Object.keys(state.cfgRaw.presets).forEach(function (k) { var o = document.createElement("option"); o.value = k; o.textContent = t("preset." + k); sel.appendChild(o); });
    if (v) sel.value = v;
  }

  function markPressed(id) {
    Array.prototype.forEach.call($("loclist").children, function (b) { b.setAttribute("aria-pressed", b.dataset.id === id ? "true" : "false"); });
  }
  function buildLocationList() {
    var list = $("loclist"); list.innerHTML = "";
    state.places.forEach(function (p) {
      var b = document.createElement("button"); b.type = "button"; b.dataset.id = p.id;
      b.innerHTML = "<b><bdi>" + esc(placeName(p)) + "</bdi></b><small><bdi dir='ltr'>" + p.lat.toFixed(2) + ", " + p.lon.toFixed(2) + "</bdi>" + (p.hero ? " · " + esc(t("loc.hero")) : "") + "</small>";
      b.setAttribute("aria-pressed", state.loc && state.loc.placeId === p.id ? "true" : "false");
      b.addEventListener("click", function () { selectPlace(p); });
      list.appendChild(b);
    });
  }

  function pinIcon() { return L.divIcon({ className: "pin", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 22] }); }
  // OpenStreetMap standard tiles need no API key (CARTO's free tiles now do). Dark mode is handled with a CSS filter.
  var TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png", TILE_ATTR = "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors";
  function buildMap() {
    if (!window.L) { $("map").textContent = t("loc.map.fail"); $("map").style.padding = "16px"; $("maphint").hidden = true; return; }
    state.map = L.map("map", { worldCopyJump: true }).setView([25, 50], 2);
    L.tileLayer(TILES, { maxZoom: 18, attribution: TILE_ATTR }).addTo(state.map);
    state.places.forEach(function (p) { state.markers[p.id] = L.marker([p.lat, p.lon], { icon: pinIcon() }).addTo(state.map).on("click", function () { selectPlace(p); }); });
    state.map.on("click", function (e) { loadCustom(e.latlng.lat, e.latlng.lng); });
    renderMapTips();
  }
  function renderMapTips() {
    if (!state.map) return;
    state.places.forEach(function (p) { state.markers[p.id].unbindTooltip().bindTooltip(placeName(p)); });
  }

  /* ---------- selecting locations ---------- */
  function effectiveCfg(lat) {
    if (lat >= 0) return state.cfgRaw;
    var c = JSON.parse(JSON.stringify(state.cfgRaw)), sh = function (m) { return (m - 1 + 6) % 12 + 1; };
    Object.keys(c.crops).forEach(function (id) {
      var k = c.crops[id]; k.sow = sh(k.sow); k.harvest = sh(k.harvest);
      ["heat_months", "frost_months", "rain_months"].forEach(function (f) { k[f] = k[f].map(sh); });
    });
    return c;
  }
  function renderBanner() {
    var ban = $("banner"), d = state.data;
    if (d && d.synthetic) { ban.hidden = false; ban.textContent = t("banner.synth"); } else ban.hidden = true;
  }

  // Quick picks use cached data when it exists (all NASA sources); otherwise they load live like any map click.
  function selectPlace(p) {
    if (state.index.some(function (l) { return l.id === p.id; })) selectLocation(p.id);
    else loadCustom(p.lat, p.lon, { placeId: p.id, preset: p.preset });
  }

  function selectLocation(id) {
    getJSON("data/" + id + ".json").then(function (d) {
      var l = state.index.filter(function (x) { return x.id === id; })[0];
      state.loadToken++; state.data = d; state.loc = Object.assign({}, l, { placeId: id });
      state.cfg = effectiveCfg(d.lat); $("presetrow").hidden = true; setStatus(null);
      if (state.customMarker && state.map) { state.map.removeLayer(state.customMarker); state.customMarker = null; }
      markPressed(id);
      if (state.map) state.map.setView([d.lat, d.lon], 5);
      renderBanner(); renderProfile(); renderAll();
    });
  }

  function applyPreset(key) {
    var p = state.cfgRaw.presets[key];
    state.loc = Object.assign({}, state.loc, { current_rotation: p.current, rotation_ids: p.ids });
    renderAll();
  }

  // opts: { label, placeId, preset, mine }
  function loadCustom(lat, lon, opts) {
    opts = opts || {};
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90) { setStatus("st.badcoord", null, true); return; }
    lon = ((lon + 540) % 360) - 180;
    var token = ++state.loadToken;
    markPressed(opts.placeId || null);
    if (state.map) {
      if (state.customMarker) state.customMarker.setLatLng([lat, lon]); else state.customMarker = L.marker([lat, lon], { icon: pinIcon() }).addTo(state.map);
      state.map.setView([lat, lon], Math.max(state.map.getZoom(), 5));
    }
    $("lat").value = lat.toFixed(2); $("lon").value = lon.toFixed(2);
    setStatus("st.fetchPower");
    if (!state.data) $("cards").innerHTML = "<p class='mini'>" + esc(t("st.fetchPower")) + "</p>";
    LiveData.fetchLocation(lat, lon, function (key) { if (token === state.loadToken) setStatus(key); }).then(function (d) {
      if (token !== state.loadToken) return;
      state.data = d; state.cfg = effectiveCfg(d.lat);
      var key = opts.preset || LiveData.suggestPreset(d); $("preset").value = key; $("presetrow").hidden = false;
      state.loc = { id: "custom", placeId: opts.placeId || null, label: opts.label || null, mine: !!opts.mine, name: "", lat: d.lat, lon: d.lon };
      renderBanner(); setStatus("st.loaded", { name: locName() }); renderProfile(); applyPreset(key);
    }).catch(function (e) {
      if (token !== state.loadToken) return;
      if (!state.data) $("cards").innerHTML = "";
      setStatus("st.err", { msg: e.message === "NO_LAND" ? t("st.noland") : e.message }, true);
    });
  }

  /* ---------- place search with suggestions (Open-Meteo geocoding: free, no key, built for as-you-type) ---------- */
  var sug = { items: [], active: -1, token: 0, timer: null };
  function geoLabel(r) { return [r.name, r.admin1, r.country].filter(function (x, i, a) { return x && a.indexOf(x) === i; }).join(", "); }
  function geoSearch(q, count) {
    return fetch("https://geocoding-api.open-meteo.com/v1/search?format=json&count=" + count + "&language=" + I18N.lang() + "&name=" + encodeURIComponent(q))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function (j) { return j.results || []; });
  }
  function closeSuggest() {
    sug.items = []; sug.active = -1; var ul = $("suggest"); ul.hidden = true; ul.innerHTML = "";
    $("q").setAttribute("aria-expanded", "false"); $("q").removeAttribute("aria-activedescendant");
  }
  function renderSuggest() {
    var ul = $("suggest");
    ul.innerHTML = sug.items.length ? sug.items.map(function (r, i) {
      return "<li role='option' id='sg" + i + "' data-i='" + i + "' aria-selected='" + (i === sug.active) + "'><b><bdi>" + esc(r.name) + "</bdi></b><small><bdi>" + esc([r.admin1, r.country].filter(Boolean).join(", ")) + "</bdi></small></li>";
    }).join("") : "<li class='none' role='option' aria-disabled='true'>" + esc(t("loc.suggest.none")) + "</li>";
    ul.hidden = false; $("q").setAttribute("aria-expanded", "true");
    if (sug.active >= 0) $("q").setAttribute("aria-activedescendant", "sg" + sug.active); else $("q").removeAttribute("aria-activedescendant");
  }
  function pickSuggest(i) {
    var r = sug.items[i]; if (!r) return;
    closeSuggest(); $("q").value = r.name; loadCustom(r.latitude, r.longitude, { label: geoLabel(r) });
  }
  function bindSearch() {
    var q = $("q");
    q.addEventListener("input", function () {
      clearTimeout(sug.timer); var v = q.value.trim();
      if (v.length < 2) { sug.token++; closeSuggest(); return; }
      var token = ++sug.token;
      sug.timer = setTimeout(function () {
        geoSearch(v, 6).then(function (res) { if (token !== sug.token) return; sug.items = res; sug.active = -1; renderSuggest(); })
          .catch(function () { if (token === sug.token) closeSuggest(); });
      }, 250);
    });
    q.addEventListener("keydown", function (e) {
      if (!sug.items.length) { if (e.key === "Escape") closeSuggest(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); sug.active = (sug.active + 1) % sug.items.length; renderSuggest(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sug.active = (sug.active - 1 + sug.items.length) % sug.items.length; renderSuggest(); }
      else if (e.key === "Escape") closeSuggest();
    });
    $("suggest").addEventListener("mousedown", function (e) { var li = e.target.closest("li[data-i]"); if (li) { e.preventDefault(); pickSuggest(+li.dataset.i); } });
    document.addEventListener("click", function (e) { if (!e.target.closest(".sugwrap")) closeSuggest(); });
    $("searchform").addEventListener("submit", function (e) {
      e.preventDefault();
      if (sug.active >= 0) { pickSuggest(sug.active); return; }
      var v = q.value.trim(); if (!v) return;
      clearTimeout(sug.timer); sug.token++; closeSuggest(); setStatus("st.searching", { q: v });
      geoSearch(v, 1).then(function (res) {
        if (!res.length) { setStatus("st.nofound", { q: v }, true); return; }
        loadCustom(res[0].latitude, res[0].longitude, { label: geoLabel(res[0]) });
      }).catch(function () { setStatus("st.searchfail", null, true); });
    });
  }

  /* ---------- "use my location" ---------- */
  function bindGps() {
    $("gps").addEventListener("click", function () {
      if (!navigator.geolocation) { setStatus("st.gps.nosupport", null, true); return; }
      if (window.isSecureContext === false) { setStatus("st.gps.insecure", null, true); return; }
      setStatus("st.gps.wait");
      navigator.geolocation.getCurrentPosition(
        function (pos) { loadCustom(pos.coords.latitude, pos.coords.longitude, { mine: true }); },
        function (err) { setStatus(err.code === 1 ? "st.gps.denied" : err.code === 3 ? "st.gps.timeout" : "st.gps.unavail", null, true); },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
    });
  }

  function bindInputs() {
    $("preset").addEventListener("change", function () { applyPreset($("preset").value); });
    $("coordform").addEventListener("submit", function (e) { e.preventDefault(); loadCustom(parseFloat($("lat").value), parseFloat($("lon").value)); });
    bindSearch(); bindGps();
    ["water", "income", "soil"].forEach(function (k) {
      var el = $("sl-" + k);
      el.addEventListener("input", function () { state.sl[k] = el.value / 100; $("o-" + k).textContent = el.value + "%"; renderAll(); });
      $("o-" + k).textContent = el.value + "%";
    });
    $("sl-rain").addEventListener("input", function (e) { state.rainDelta = +e.target.value; $("o-rain").textContent = (state.rainDelta > 0 ? "+" : "") + state.rainDelta + "%"; renderAll(); });
    $("o-rain").textContent = "0%";
  }

  function bindTabs() {
    Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) {
      b.addEventListener("click", function () {
        state.tab = b.dataset.tab;
        Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (x) { x.setAttribute("aria-selected", x === b ? "true" : "false"); });
        ["rot", "profile", "cal"].forEach(function (k) { $("p-" + k).hidden = k !== state.tab; });
      });
    });
  }

  /* ---------- results header ---------- */
  function renderHead() {
    var d = state.data;
    $("resname").textContent = locName();
    $("resmeta").innerHTML = state.loc ? "<bdi dir='ltr'>" + state.loc.lat.toFixed(2) + ", " + state.loc.lon.toFixed(2) + "</bdi>" : "";
    $("cov").innerHTML = SRC.map(function (k) {
      var on = d.sources && d.sources[k] && d.sources[k] !== "synthetic" && (k !== "soilgrids" || (d.soil && d.soil.ph));
      return "<li class='" + (on ? "on" : "") + "' title='" + esc(t(on ? "cov.on" : "cov.off")) + "'>" + SRC_NAME[k] + "</li>";
    }).join("");
  }

  /* ---------- field profile ---------- */
  function monthStats(series) {
    var out = [];
    for (var m = 0; m < 12; m++) {
      var col = series.map(function (r) { return r[m]; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
      out.push([Scoring.pct(col, .1), Scoring.pct(col, .5), Scoring.pct(col, .9)]);
    }
    return out;
  }
  function rainChart(d) {
    var st = monthStats(d.climate.rain), W = 600, H = 190, pl = 34, pb = 22, pt = 10, ML = months();
    var max = Math.max.apply(null, st.map(function (s) { return s[2]; })) * 1.1 || 1;
    var bw = (W - pl) / 12, y = function (v) { return pt + (H - pt - pb) * (1 - v / max); };
    var s = "<svg viewBox='0 0 " + W + " " + H + "' width='100%' role='img' aria-label='" + esc(t("pf.chart")) + "' direction='ltr'>";
    for (var k = 0; k <= 4; k++) { var v = max * k / 4; s += "<line x1='" + pl + "' x2='" + W + "' y1='" + y(v) + "' y2='" + y(v) + "' stroke='currentColor' opacity='.12'/><text x='2' y='" + (y(v) + 4) + "'>" + Math.round(v) + "</text>"; }
    st.forEach(function (m, i) {
      var x = pl + i * bw + bw * .15, w = bw * .7;
      s += "<rect x='" + x + "' y='" + y(m[1]) + "' width='" + w + "' height='" + (y(0) - y(m[1])) + "' rx='3' fill='var(--crop)'/>";
      s += "<line x1='" + (x + w / 2) + "' x2='" + (x + w / 2) + "' y1='" + y(m[0]) + "' y2='" + y(m[2]) + "' stroke='var(--fg)' stroke-width='1.5'/>";
      s += "<text x='" + (x + w / 2) + "' y='" + (H - 6) + "' text-anchor='middle'>" + esc(ML[i]) + "</text>";
    });
    return s + "</svg>";
  }
  function stat(b, s) { return "<div class='stat'><b>" + b + "</b><span>" + esc(s) + "</span></div>"; }

  function renderProfile() {
    var d = state.data; if (!d) return;
    renderHead();
    var nY = d.years.length, sum = function (s) { return s.map(function (r) { return r.reduce(function (a, b) { return a + b; }, 0); }); };
    var annual = sum(d.climate.rain), sorted = annual.slice().sort(function (a, b) { return a - b; });
    var h = "<div class='grid'>" +
      stat(Math.round(mean(annual)) + " mm", t("pf.mean", { y0: d.years[0], y1: d.years[nY - 1] })) +
      stat(Math.round(Scoring.pct(sorted, .1)) + "–" + Math.round(Scoring.pct(sorted, .9)) + " mm", t("pf.range")) +
      stat(mean(sum(d.climate.heat_days)).toFixed(0), t("pf.heat")) + stat(mean(sum(d.climate.frost_days)).toFixed(0), t("pf.frost")) + "</div>";
    h += "<div class='chart'><b>" + esc(t("pf.chart")) + "</b> <span class='mini'>" + esc(t("pf.chart.hint")) + "</span>" + rainChart(d) + "</div>";
    if (d.soil && d.soil.ph) {
      h += "<div class='chart'><b>" + esc(t("pf.soil")) + "</b> <span class='mini'>" + esc(t("pf.soil.hint")) + "</span><table><tr><th>" + esc(t("pf.prop")) + "</th><th>" + esc(t("pf.p5")) + "</th><th>" + esc(t("pf.mean2")) + "</th><th>" + esc(t("pf.p95")) + "</th></tr>";
      ["ph", "clay", "soc", "sand", "silt"].forEach(function (k) { var q = d.soil[k]; if (q) h += "<tr><td>" + esc(t("prop." + k)) + "</td><td>" + q.q05 + "</td><td>" + q.mean + "</td><td>" + q.q95 + "</td></tr>"; });
      h += "</table></div>";
    }
    h += "<p class='mini'>" + esc(t(d.synthetic ? "res.synth" : (d.live ? "res.live" : "res.std"))) + "</p>";
    var xc = d.rain_crosscheck, xt = "";
    if (d.synthetic) xt = t("xc.synth"); else if (d.live) xt = t("xc.live");
    else if (xc && xc.power_vs_imerg_pct_diff != null) xt = t("xc.diff", { pct: xc.power_vs_imerg_pct_diff }) + (Math.abs(xc.power_vs_imerg_pct_diff) > 25 ? " " + t("xc.big") : "");
    else xt = t("xc.none");
    h += "<p class='mini'>" + esc(t("xc.title")) + ": " + esc(xt) + "</p>";
    $("profile").innerHTML = h;
  }

  /* ---------- vulnerability calendar ---------- */
  function renderCalendar() {
    var d = state.data, cfg = state.cfg, thr = cfg.bare_ndvi_threshold, ML = months();
    var heatM = monthStats(d.climate.heat_days).map(function (s) { return s[1]; });
    var extM = d.climate.extreme_days[0].map(function (_, m) { return mean(d.climate.extreme_days.map(function (r) { return r[m]; })); });
    var h = "<div class='chart'><div class='cal'><div></div>" + ML.map(function (m) { return "<div class='m'>" + esc(m) + "</div>"; }).join("");
    state.loc.rotation_ids.forEach(function (rid) {
      var rot = cfg.rotations[rid];
      rot.cycle.forEach(function (plan, pi) {
        var covered = {}, heatCrit = {};
        plan.forEach(function (cid) {
          var c = cfg.crops[cid]; Scoring.growingMonths(c).forEach(function (m) { covered[m] = cid; });
          c.heat_months.forEach(function (m) { heatCrit[m] = true; });
        });
        h += "<div class='lab'><bdi>" + esc(rotLabel(rid)) + "</bdi>" + (rot.cycle.length > 1 ? " <span class='mini'>· " + esc(t("cal.yr", { n: pi + 1 })) + "</span>" : "") + "</div>";
        for (var m = 1; m <= 12; m++) {
          var cls = "", tip = "";
          if (covered[m]) { cls = "crop"; tip = cropName(covered[m]); }
          else if (d.ndvi_clim && d.ndvi_clim[m - 1] != null && d.ndvi_clim[m - 1] < thr) { cls = "bare"; tip = t("cal.tipbare", { v: d.ndvi_clim[m - 1].toFixed(2) }); }
          var fl = "";
          if (heatCrit[m] && covered[m] && heatM[m - 1] >= 5) { fl += "H"; tip += "; " + t("cal.heat"); }
          if (covered[m] && extM[m - 1] >= .3) { fl += "R"; tip += "; " + t("cal.rain"); }
          h += "<div class='c " + cls + "' title='" + esc(tip) + "'><span class='f'>" + fl + "</span></div>";
        }
      });
    });
    h += "</div><div class='legend'><span><i class='sw' style='background:var(--crop)'></i>" + esc(t("cal.crop")) + "</span>" +
      (d.ndvi_clim ? "<span><i class='sw' style='background:var(--bare)'></i>" + esc(t("cal.bare")) + "</span>" : "<span>" + esc(t("cal.nobare")) + "</span>") +
      "<span><b class='flag'>H</b> " + esc(t("cal.heat")) + "</span><span><b class='flag'>R</b> " + esc(t("cal.rain")) + "</span></div></div>";
    $("calendar").innerHTML = h;
  }

  /* ---------- rotation cards ---------- */
  function insights(rot, res, d, fb) {
    var cfg = state.cfg, crops = {}; rot.cycle.forEach(function (p) { p.forEach(function (c) { crops[c] = cfg.crops[c]; }); });
    var benefits = [], risks = [], flags = [], ids = Object.keys(crops);
    ids.forEach(function (id) { var c = crops[id], s = t("ben." + c.type, { crop: cropName(id) }); if (benefits.indexOf(s) < 0) benefits.push(s); });
    if (rot.cycle.length === 1 && rot.cycle[0].length === 1) risks.push(t("risk.mono"));
    else if (ids.every(function (id) { return crops[id].type === "cereal"; })) risks.push(t("risk.cereals"));
    if (fb.water != null && fb.water < .5) risks.push(t("risk.water"));
    if (fb.heat != null && fb.heat < .6) risks.push(t("risk.heat"));
    if (fb.rain != null && fb.rain < .7) risks.push(t("risk.rain"));
    if (fb.bare != null && fb.bare < .75) risks.push(t("risk.bare"));
    if (fb.fit != null && fb.fit < .7) risks.push(t("risk.fit"));
    flags.push(t("flag.irrig"));
    if (d.soil && d.soil.ph && d.soil.ph.mean > 8) flags.push(t("flag.ph"));
    if (d.soil && d.soil.soc && d.soil.soc.mean < 6) flags.push(t("flag.soc"));
    if (ids.some(function (id) { return crops[id].type === "legume"; })) flags.push(t("flag.legume"));
    if (res.high - res.low > .25) flags.push(t("flag.wide"));
    if (res.noClearWinner) flags.push(t("flag.tie"));
    if (d.synthetic) flags.push(t("flag.synth"));
    return { benefits: benefits, risks: risks, flags: flags };
  }
  function li(a, cls) { return a.map(function (x) { return "<li" + (cls ? " class='" + cls + "'" : "") + ">" + esc(x) + "</li>"; }).join(""); }

  function renderAll() {
    if (!state.data || !state.loc) return;
    renderHead(); renderCalendar();
    var d = scenarioData(state.data, state.rainDelta), cfg = state.cfg;
    var out = Scoring.rankRotations(cfg, d, state.loc.rotation_ids, state.sl), h = "";
    var gaps = (d.gaps || []).map(gapText);
    if (!(d.soil && d.soil.ph) && !(d.gaps || []).some(function (g) { return /^SoilGrids/.test(g); })) gaps.push(t("gap.soilmissing"));
    gaps = gaps.concat([t("gap.static1"), t("gap.static2")]);
    out.results.forEach(function (r) {
      var rot = cfg.rotations[r.id], fb = Scoring.factorBreakdown(rot, cfg, d), x = insights(rot, r, d, fb), isCur = r.id === state.loc.current_rotation;
      h += "<article class='card" + (r.rank === 1 ? " top" : "") + "'><div class='head'><span class='rank'>" + r.rank + "</span><div><h3><bdi>" + esc(rotLabel(r.id)) + "</bdi></h3><div class='pills'>" +
        (isCur ? "<span class='pill cur'>" + esc(t("card.current")) + "</span>" : "") + (r.rank === 1 ? "<span class='pill cur'>" + esc(t("card.top")) + "</span>" : "") +
        (r.noClearWinner ? "<span class='pill tie'>" + esc(t("card.tie")) + "</span>" : "") + "</div></div>" +
        "<div class='score'><b>" + f2(r.mean) + "</b><span>" + esc(t("card.score")) + "</span></div></div>" +
        "<div class='bar' role='img' aria-label='" + f2(r.low) + " – " + f2(r.high) + "'><div class='rng' style='left:" + r.low * 100 + "%;width:" + Math.max(1, (r.high - r.low) * 100) + "%'></div><div class='tick' style='left:" + r.mean * 100 + "%'></div></div>" +
        "<div class='axis'><span>0</span><span dir='auto'>" + esc(t("card.range", { lo: f2(r.low), hi: f2(r.high) })) + "</span><span>1</span></div>" +
        "<details><summary>" + esc(t("card.ev")) + "</summary><p class='mini'>" + esc(t("card.ev.hint")) + "</p><div class='ev'>" +
        Scoring.FACTORS.map(function (f) {
          var v = fb[f.id];
          return "<div class='evrow" + (v == null ? " na" : "") + "'><div>" + esc(t("f." + f.id + ".label")) + "<small>" + esc(t("f." + f.id + ".data")) + "</small></div><div class='evbar'><i style='width:" + (v == null ? 0 : v * 100) + "%'></i></div><b>" + f2(v) + "</b></div>";
        }).join("") + "</div></details>" +
        "<details><summary>" + esc(t("card.br")) + "</summary><ul>" + li(x.benefits) + x.risks.map(function (z) { return "<li class='flag'>" + esc(t("card.risk", { t: z })) + "</li>"; }).join("") + "</ul></details>" +
        "<details><summary>" + esc(t("card.gaps")) + "</summary><ul>" + li(gaps) + "</ul></details>" +
        "<details open><summary class='flag'>" + esc(t("card.agro")) + "</summary><ul>" + li(x.flags) + "</ul></details></article>";
    });
    $("cards").innerHTML = h;
    renderFlip();
  }

  function renderFlip() {
    var el = $("flip"), ids = state.loc.rotation_ids, base = Scoring.rankRotations(state.cfg, state.data, ids, state.sl).results[0].id;
    for (var p = -5; p >= -40; p -= 5) {
      var top = Scoring.rankRotations(state.cfg, scenarioData(state.data, p), ids, state.sl).results[0].id;
      if (top !== base) { el.textContent = t("sc.flip", { a: rotLabel(base), b: rotLabel(top), p: -p }); return; }
    }
    el.textContent = t("sc.noflip");
  }

  /* ---------- scoring explainer ---------- */
  function renderHow() {
    var h = "<div class='tablewrap'><table><tr><th>" + esc(t("th.rule")) + "</th><th>" + esc(t("th.data")) + "</th><th>" + esc(t("th.slider")) + "</th><th>" + esc(t("th.how")) + "</th></tr>";
    Scoring.FACTORS.forEach(function (f) {
      h += "<tr><td><b>" + esc(t("f." + f.id + ".label")) + "</b></td><td>" + esc(t("f." + f.id + ".data")) + "</td><td>" + esc(t("pri." + f.slider)) + "</td><td>" + esc(t("f." + f.id + ".rule")) + "</td></tr>";
    });
    $("how").innerHTML = h + "</table></div><p class='mini'>" + esc(t("sc2.note")) + " <a href='rotations.json'>rotations.json</a></p>";
  }

  init();
})();
