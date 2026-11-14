/* Rotation Explorer UI. Reads cached static files (data/*.json, rotations.json, places.json); other points use live.js.
 * All visible text goes through I18N.t() so the language switcher can re-render everything. */
(function () {
  "use strict";
  var t = I18N.t;
  var SRC = ["power", "soilgrids", "modis", "smap", "imerg"], SRC_NAME = { power: "NASA POWER", soilgrids: "SoilGrids", modis: "MODIS", smap: "SMAP", imerg: "GPM IMERG" };
  var TABS = ["profile", "cal", "whatif", "rules", "mine", "cmp"];
  var state = { cfgRaw: null, cfgBase: null, cfg: null, index: [], places: [], loc: null, data: null, presetKey: null,
    sl: { water: .5, income: .5, soil: .5 }, rainDelta: 0, tempDelta: 0, irr: "u", overrides: {},
    map: null, markers: {}, customMarker: null, pin: null, loading: false, loadToken: 0, tab: "rot", status: null,
    cmp: null, cmpToken: 0, printOpen: [], urlTimer: null };
  state.tab = "profile"; state.mine = [];
  var $ = function (id) { return document.getElementById(id); };
  var mean = Scoring.mean;
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function f2(x) { return x == null || isNaN(x) ? "n/a" : x.toFixed(2); }
  function getJSON(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }); }
  function irrMode() { return state.irr === "y" ? "irrigated" : (state.irr === "n" ? "rainfed" : undefined); }
  function rank(cfg, d, ids) { return Scoring.rankRotations(cfg, d, ids, state.sl, { irrigation: irrMode() }); }
  function scen(d) { return Scoring.applyScenario(d, state.rainDelta, state.tempDelta); }

  /* ---------- names, months, gaps ---------- */
  function cropName(id) { return t("crop." + id); }
  function cycleLabel(c) {
    var plan = function (p) { return p.map(cropName).join(" + "); };
    if (c.length === 1) return c[0].length === 1 ? t("rot.mono", { c: cropName(c[0][0]) }) : plan(c[0]);
    return t("rot.cycle", { list: c.map(plan).join(c.length === 2 ? " \u2194 " : " \u2192 ") });
  }
  function rotLabel(id) { return id === "mine" ? t("mine.label") + ": " + cycleLabel(state.mine) : cycleLabel(state.cfgRaw.rotations[id].cycle); }
  // ids of the rotations being compared: the place's set, plus the user's own rotation if they built one
  function currentIds() { return state.loc ? state.loc.rotation_ids.concat(state.mine.length ? ["mine"] : []) : []; }
  function monthNames(style) {
    try { var f = new Intl.DateTimeFormat(I18N.lang(), { month: style }), o = []; for (var m = 0; m < 12; m++) o.push(f.format(new Date(2000, m, 15))); return o; }
    catch (e) { return style === "narrow" ? "JFMAMJJASOND".split("") : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]; }
  }
  function months() { return monthNames("narrow"); }
  var GAPS = [[/^PLACEHOLDER/, "gap.synth"], [/^MODIS NDVI missing/, "gap.modis"], [/^SMAP missing/, "gap.smap"], [/^IMERG missing/, "gap.imerg"], [/^SoilGrids missing/, "gap.soilmissing"],
    [/^Live location: MODIS/, "gap.live.modis"], [/^Live location: SMAP/, "gap.live.smap"], [/^Live location: GPM IMERG/, "gap.live.imerg"], [/^SoilGrids unavailable/, "gap.live.soil"], [/^Soil values come from/, "gap.soil.moved"]];
  function gapText(g) {
    for (var i = 0; i < GAPS.length; i++) if (GAPS[i][0].test(g)) { var m = /\((.*)\)/.exec(g), k = /about ([\d.]+) km/.exec(g); return t(GAPS[i][1], { why: m ? m[1] : "", km: k ? k[1] : "" }); }
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

  /* ---------- configuration: hemisphere shift, then the user's crop-rule edits ---------- */
  function regionFor(lat, lon) {
    var R = state.cfgRaw.regions || {};
    for (var k in R) { var b = R[k].box; if (lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]) return k; }
    return "generic";
  }
  // Month calendars come from a sourced regional calendar where we have one (Pakistan's Punjab, Iowa). Everywhere else they are
  // Northern Hemisphere templates, shifted by 6 months south of 10 degrees S (near the equator seasons are not simply flipped). Always returns a copy.
  function effectiveCfg(lat, lon) {
    var c = JSON.parse(JSON.stringify(state.cfgRaw)), region = regionFor(lat, lon), sh = function (m) { return (m - 1 + 6) % 12 + 1; };
    Object.keys(c.crops).forEach(function (id) {
      var k = c.crops[id], cal = k.calendars && k.calendars[region];
      if (cal) { k.sow = cal.sow; k.harvest = cal.harvest; k.cal_info = { region: region, status: cal.status, ids: cal.ids, note: cal.note }; }
      else {
        if (lat < -10) { k.sow = sh(k.sow); k.harvest = sh(k.harvest); ["heat_months", "frost_months", "rain_months"].forEach(function (f) { k[f] = k[f].map(sh); }); }
        k.cal_info = { region: "generic", status: "team", ids: [], note: "" };
      }
    });
    return c;
  }
  function withOverrides(base) {
    var ov = state.overrides; if (!Object.keys(ov).length) return base;
    var c = JSON.parse(JSON.stringify(base));
    Object.keys(ov).forEach(function (id) {
      var k = c.crops[id], o = ov[id]; if (!k) return;
      if (o.water_mm != null) k.water_mm = o.water_mm; if (o.sow != null) k.sow = o.sow; if (o.harvest != null) k.harvest = o.harvest;
      if (o.ph0 != null) k.ph[0] = o.ph0; if (o.ph1 != null) k.ph[1] = o.ph1; if (o.source) k.source = o.source;
    });
    return c;
  }
  function applyMine(cfg) { if (state.mine.length) cfg.rotations.mine = { cycle: state.mine }; else delete cfg.rotations.mine; }
  function buildCfg(lat, lon) { state.cfgBase = effectiveCfg(lat, lon); applyMine(state.cfgBase); state.cfg = withOverrides(state.cfgBase); }

  /* ---------- share link: the whole view lives in the URL ---------- */
  function writeUrl(now) {
    clearTimeout(state.urlTimer);
    var go = function () {
      var q = new URLSearchParams(); q.set("lang", I18N.lang());
      var l = state.loc;
      if (l && l.placeId) q.set("loc", l.placeId);
      else if (l && l.id === "custom") { q.set("lat", l.lat.toFixed(4)); q.set("lon", l.lon.toFixed(4)); if (state.presetKey) q.set("preset", state.presetKey); }
      q.set("w", Math.round(state.sl.water * 100)); q.set("i", Math.round(state.sl.income * 100)); q.set("s", Math.round(state.sl.soil * 100));
      if (state.irr !== "u") q.set("irr", state.irr);
      if (state.rainDelta) q.set("rain", state.rainDelta);
      if (state.tempDelta) q.set("dt", state.tempDelta);
      if (state.tab !== "rot") q.set("tab", state.tab);
      if (state.cmp && state.cmp.placeId) q.set("cmp", state.cmp.placeId);
      if (Object.keys(state.overrides).length) q.set("r", JSON.stringify(state.overrides));
      if (state.mine.length) q.set("mine", state.mine.map(function (p) { return p.join("+"); }).join(";"));
      try { history.replaceState(null, "", "?" + q.toString()); } catch (e) {}
    };
    if (now) go(); else state.urlTimer = setTimeout(go, 300);
  }
  function readUrl() {
    var q = new URLSearchParams(location.search), num = function (k) { var v = parseFloat(q.get(k)); return isNaN(v) ? null : v; };
    [["w", "water"], ["i", "income"], ["s", "soil"]].forEach(function (m) { var v = num(m[0]); if (v != null) state.sl[m[1]] = Math.min(1, Math.max(0, v / 100)); });
    if (q.get("irr") === "y" || q.get("irr") === "n") state.irr = q.get("irr");
    var r = num("rain"); if (r != null) state.rainDelta = Math.min(20, Math.max(-40, Math.round(r / 5) * 5));
    var d = num("dt"); if (d != null) state.tempDelta = Math.min(4, Math.max(0, Math.round(d)));
    if (TABS.indexOf(q.get("tab")) >= 0) state.tab = q.get("tab");
    try {
      var o = JSON.parse(q.get("r") || "{}");
      Object.keys(o).forEach(function (id) {
        var k = state.cfgRaw.crops[id]; if (!k || typeof o[id] !== "object" || o[id] === null) return; var clean = {};
        ["water_mm", "sow", "harvest", "ph0", "ph1"].forEach(function (f) { if (typeof o[id][f] === "number" && isFinite(o[id][f])) clean[f] = o[id][f]; });
        if (typeof o[id].source === "string") clean.source = o[id].source.slice(0, 200);
        if (Object.keys(clean).length) state.overrides[id] = clean;
      });
    } catch (e) {}
    state.mine = parseMine(q.get("mine"));
    return { loc: q.get("loc"), lat: num("lat"), lon: num("lon"), preset: q.get("preset"), cmp: q.get("cmp") };
  }
  // "wheat+chickpea;corn" -> [["wheat","chickpea"],["corn"]], keeping only known crops, at most 3 years of 2 crops
  function parseMine(str) {
    if (!str) return [];
    return str.split(";").slice(0, 3).map(function (y) { return y.split("+").filter(function (c, i, a) { return state.cfgRaw.crops[c] && a.indexOf(c) === i; }).slice(0, 2); }).filter(function (p) { return p.length; });
  }
  function syncControls() {
    ["water", "income", "soil"].forEach(function (k) { $("sl-" + k).value = Math.round(state.sl[k] * 100); $("o-" + k).textContent = Math.round(state.sl[k] * 100) + "%"; });
    Array.prototype.forEach.call(document.querySelectorAll("input[name=irr]"), function (r) { r.checked = r.value === state.irr; }); $("sl-rain").value = state.rainDelta; $("sl-temp").value = state.tempDelta;
    $("o-rain").textContent = (state.rainDelta > 0 ? "+" : "") + state.rainDelta + "%"; $("o-temp").textContent = "+" + state.tempDelta + " °C";
    $("sl-water").disabled = state.irr === "n"; $("sl-water").parentNode.classList.toggle("off", state.irr === "n");
  }

  /* ---------- status + map bar ---------- */
  function setStatus(key, params, isErr) { state.status = key ? { key: key, params: params, err: !!isErr } : null; renderStatus(); }
  function renderStatus() {
    var el = $("status"), s = state.status, txt = s ? t(s.key, s.params) : ""; el.className = "status" + (s && s.err ? " err" : "");
    el.textContent = txt;
    var ms = $("mapstatus"); ms.className = s && s.err ? "err" : ""; ms.textContent = txt || (state.pin ? "" : t("map.nopin"));
    renderMapBar();
  }
  function renderMapBar() {
    var pin = state.pin;
    $("pincoords").textContent = pin ? t("map.pin", { lat: pin.lat.toFixed(4), lon: pin.lon.toFixed(4) }) : "";
    $("analyse").disabled = !pin || state.loading;
    $("viewres").hidden = !state.data || state.loading;
  }

  /* ---------- static text, language ---------- */
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
      I18N.remember(I18N.lang()); applyStatic(); buildPresetOptions(); buildLocationList(); buildCmpOptions(); renderStatus(); renderMapTips(); renderHow(); renderRules(); renderMine();
      if (state.data) { renderBanner(); renderProfile(); renderAll(); }
      writeUrl();
    });
  }

  /* ---------- decorative hero art (no data) ---------- */
  function buildArt() {
    var cols = ["#bfe3c9", "#8fcca3", "#f1d58a", "#6fb88a", "#d9eedf", "#e8c46a"], h = "", i;
    for (i = 0; i < 36; i++) h += "<i style='background:" + cols[(i * 7 + Math.floor(i / 6) * 3) % cols.length] + ";opacity:" + (0.65 + ((i * 13) % 5) / 14) + "'></i>";
    $("art").innerHTML = h;
  }

  /* ---------- init ---------- */
  function init() {
    buildArt(); buildLangSelect();
    var code = I18N.detect();
    Promise.all([getJSON("rotations.json"), getJSON("data/index.json"), I18N.set(code), getJSON("places.json")]).then(function (r) {
      state.cfgRaw = r[0]; state.cfg = r[0]; state.cfgBase = r[0]; state.index = r[1]; state.places = r[3];
      var u = readUrl();
      applyStatic(); buildPresetOptions(); buildLocationList(); buildCmpOptions(); buildMap(); bindInputs(); bindTabs(); bindShare(); bindPwa(); renderHow(); renderMine(); syncControls(); setTab(state.tab, true);
      var place = u.loc && findPlace(u.loc);
      if (place) selectPlace(place);
      else if (u.lat != null && u.lon != null) loadCustom(u.lat, u.lon, { preset: u.preset && state.cfgRaw.presets[u.preset] ? u.preset : null });
      else selectPlace(state.places.filter(function (p) { return p.hero; })[0] || state.places[0]);
      if (u.cmp && findPlace(u.cmp)) loadCompare(u.cmp);
    }).catch(function (e) { $("profile").textContent = "Could not load data: " + e.message; });
  }

  function buildPresetOptions() {
    var sel = $("preset"), v = sel.value; sel.innerHTML = "";
    Object.keys(state.cfgRaw.presets).forEach(function (k) { var o = document.createElement("option"); o.value = k; o.textContent = t("preset." + k); sel.appendChild(o); });
    if (v) sel.value = v;
  }
  function buildCmpOptions() {
    var sel = $("cmpsel"), v = sel.value; sel.innerHTML = "";
    var o0 = document.createElement("option"); o0.value = ""; o0.textContent = t("cmp.choose"); sel.appendChild(o0);
    state.places.forEach(function (p) { var o = document.createElement("option"); o.value = p.id; o.textContent = placeName(p); sel.appendChild(o); });
    sel.value = state.cmp && state.cmp.placeId ? state.cmp.placeId : v;
  }

  /* ---------- quick picks and map ---------- */
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
  // One draggable pin marks the chosen point. It is moved by clicks, drags, search, quick picks and GPS.
  function placePin(lat, lon, recenter) {
    state.pin = { lat: lat, lon: lon };
    if (state.map) {
      if (state.customMarker) state.customMarker.setLatLng([lat, lon]);
      else {
        state.customMarker = L.marker([lat, lon], { icon: pinIcon(), draggable: true, zIndexOffset: 1000, keyboard: false }).addTo(state.map);
        state.customMarker.on("dragend", function () { var ll = state.customMarker.getLatLng(); loadCustom(ll.lat, ll.lng, { fromMap: true }); });
      }
      if (recenter) state.map.setView([lat, lon], Math.max(state.map.getZoom(), 5));
    }
    renderMapBar();
  }
  // Quick-pick markers would swallow clicks when you zoom in close, so hide them there.
  function syncMarkers() {
    if (!state.map) return;
    var show = state.map.getZoom() < 9;
    state.places.forEach(function (p) {
      var m = state.markers[p.id]; if (!m) return;
      if (show && !state.map.hasLayer(m)) m.addTo(state.map); else if (!show && state.map.hasLayer(m)) state.map.removeLayer(m);
    });
  }
  function pinIcon() { return L.divIcon({ className: "pin", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 22] }); }
  // OpenStreetMap standard tiles need no API key (CARTO's free tiles now do). Dark mode is handled with a CSS filter.
  var TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png", TILE_ATTR = "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors";
  function buildMap() {
    if (!window.L) { $("map").textContent = t("loc.map.fail"); $("map").style.padding = "16px"; $("maphint").hidden = true; return; }
    state.map = L.map("map", { worldCopyJump: true }).setView([25, 50], 2);
    L.tileLayer(TILES, { maxZoom: 18, attribution: TILE_ATTR }).addTo(state.map);
    state.places.forEach(function (p) { state.markers[p.id] = L.marker([p.lat, p.lon], { icon: pinIcon(), keyboard: false }).addTo(state.map).on("click", function () { selectPlace(p); }); });
    state.map.on("click", function (e) { loadCustom(e.latlng.lat, e.latlng.lng, { fromMap: true }); });
    state.map.on("zoomend", syncMarkers);
    renderMapTips();
  }
  function renderMapTips() {
    if (!state.map) return;
    state.places.forEach(function (p) { state.markers[p.id].unbindTooltip().bindTooltip(placeName(p)); });
  }

  /* ---------- selecting locations ---------- */
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
      state.loadToken++; state.data = d; state.loc = Object.assign({}, l, { placeId: id }); state.presetKey = null;
      buildCfg(d.lat, d.lon); $("presetrow").hidden = true; setStatus(null);
      markPressed(id); placePin(d.lat, d.lon, true);
      renderBanner(); renderProfile(); renderRules(); renderAll(); renderMapBar();
    });
  }
  function applyPreset(key) {
    var p = state.cfgRaw.presets[key]; state.presetKey = key;
    state.loc = Object.assign({}, state.loc, { current_rotation: p.current, rotation_ids: p.ids });
    renderRules(); renderAll();
  }
  // opts: { label, placeId, preset, mine, fromMap }
  function loadCustom(lat, lon, opts) {
    opts = opts || {};
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90) { setStatus("st.badcoord", null, true); return; }
    lon = ((lon + 540) % 360) - 180;
    var token = ++state.loadToken;
    markPressed(opts.placeId || null);
    placePin(lat, lon, !opts.fromMap);   // clicking or dragging must not move the map under the user's cursor
    $("lat").value = lat.toFixed(2); $("lon").value = lon.toFixed(2);
    state.loading = true; setStatus("st.fetchPower");
    if (!state.data) $("cards").innerHTML = "<p class='mini'>" + esc(t("st.fetchPower")) + "</p>";
    LiveData.fetchLocation(lat, lon, function (key) { if (token === state.loadToken) setStatus(key); }).then(function (d) {
      if (token !== state.loadToken) return;
      state.loading = false; state.data = d; buildCfg(d.lat, d.lon);
      var key = opts.preset || LiveData.suggestPreset(d); $("preset").value = key; $("presetrow").hidden = false;
      state.loc = { id: "custom", placeId: opts.placeId || null, label: opts.label || null, mine: !!opts.mine, name: "", lat: d.lat, lon: d.lon };
      renderBanner(); renderProfile(); applyPreset(key);
      // Weather is in, so show the answer now. Soil arrives later (SoilGrids is slow) and the page updates itself.
      if (d.soilDone) setStatus("st.loaded", { name: locName() });
      else {
        setStatus("st.fetchSoil");
        d.soilPromise.then(function () {
          if (token !== state.loadToken || state.data !== d) return;   // the user has moved on
          setStatus("st.loaded", { name: locName() }); renderProfile(); renderAll();
        });
      }
    }).catch(function (e) {
      if (token !== state.loadToken) return;
      state.loading = false;
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

  /* ---------- inputs ---------- */
  function bindInputs() {
    $("preset").addEventListener("change", function () { applyPreset($("preset").value); });
    $("coordform").addEventListener("submit", function (e) { e.preventDefault(); loadCustom(parseFloat($("lat").value), parseFloat($("lon").value)); });
    bindSearch(); bindGps();
    $("analyse").addEventListener("click", function () { if (state.pin) loadCustom(state.pin.lat, state.pin.lon, { fromMap: true }); });
    $("viewres").addEventListener("click", function () { $("step3").scrollIntoView({ behavior: "smooth", block: "start" }); });
    ["water", "income", "soil"].forEach(function (k) {
      $("sl-" + k).addEventListener("input", function (e) { state.sl[k] = e.target.value / 100; $("o-" + k).textContent = e.target.value + "%"; renderAll(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll("input[name=irr]"), function (r) { r.addEventListener("change", function () { if (r.checked) { state.irr = r.value; syncControls(); renderHow(); renderAll(); } }); });
    $("sl-rain").addEventListener("input", function (e) { state.rainDelta = +e.target.value; $("o-rain").textContent = (state.rainDelta > 0 ? "+" : "") + state.rainDelta + "%"; renderAll(); });
    $("sl-temp").addEventListener("input", function (e) { state.tempDelta = +e.target.value; $("o-temp").textContent = "+" + state.tempDelta + " °C"; renderAll(); });
    $("cmpsel").addEventListener("change", function () { loadCompare($("cmpsel").value); });
    renderMapBar();
  }

  // Wide tables and charts scroll sideways on small screens: make them reachable by keyboard whenever they really overflow.
  function markScrollers() {
    Array.prototype.forEach.call(document.querySelectorAll(".tablewrap, .chart"), function (el) {
      if (el.scrollWidth > el.clientWidth + 1) el.tabIndex = 0; else el.removeAttribute("tabindex");
    });
  }
  window.addEventListener("resize", function () { clearTimeout(markScrollers.t); markScrollers.t = setTimeout(markScrollers, 150); });

  /* ---------- tabs ---------- */
  function setTab(tab, silent) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) { var on = b.dataset.tab === tab; b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; });
    TABS.forEach(function (k) { $("p-" + k).hidden = k !== tab; });
    markScrollers();
    if (!silent) writeUrl();
  }
  function bindTabs() {
    var btns = Array.prototype.slice.call(document.querySelectorAll(".tabs button"));
    btns.forEach(function (b, i) {
      b.addEventListener("click", function () { setTab(b.dataset.tab); });
      b.addEventListener("keydown", function (e) {
        var rtl = I18N.dir() === "rtl", next = e.key === "ArrowRight" ? (rtl ? -1 : 1) : e.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
        if (e.key === "Home") next = -i; if (e.key === "End") next = btns.length - 1 - i;
        if (!next) return; e.preventDefault(); var n = btns[(i + next + btns.length) % btns.length]; n.focus(); setTab(n.dataset.tab);
      });
    });
  }

  /* ---------- share, print, install, offline ---------- */
  function bindShare() {
    $("copylink").addEventListener("click", function () {
      writeUrl(true);
      var msg = $("sharemsg"), done = function (ok) { msg.textContent = t(ok ? "share.copied" : "share.fail"); setTimeout(function () { msg.textContent = ""; }, 3500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(function () { done(true); }, function () { done(false); });
      else done(false);
    });
    $("printbtn").addEventListener("click", function () { window.print(); });
    window.addEventListener("beforeprint", function () {
      var d = new Date(), date = ""; try { date = d.toLocaleDateString(I18N.lang(), { year: "numeric", month: "long", day: "numeric" }); } catch (e) { date = d.toDateString(); }
      $("printhead").innerHTML = "<h1>" + esc(t("print.title")) + "</h1><p><b><bdi>" + esc(locName()) + "</bdi></b> · <bdi dir='ltr'>" + (state.loc ? state.loc.lat.toFixed(2) + ", " + state.loc.lon.toFixed(2) : "") + "</bdi></p><p>" +
        esc(t("print.date", { date: date })) + " · " + esc(t("print.link")) + ": <bdi dir='ltr'>" + esc(location.href) + "</bdi></p><p class='disc'>" + esc(t("print.disclaimer")) + "</p>";
      writeUrl(true); $("p-cmp").classList.toggle("has-cmp", !!(state.cmp && state.cmp.data));
      state.printOpen = []; Array.prototype.forEach.call(document.querySelectorAll("#step3 details"), function (el) { state.printOpen.push([el, el.open]); el.open = true; });
    });
    window.addEventListener("afterprint", function () { state.printOpen.forEach(function (p) { p[0].open = p[1]; }); state.printOpen = []; });
  }
  function bindPwa() {
    var deferred = null, inst = $("install");
    window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; inst.hidden = false; });
    inst.addEventListener("click", function () { if (!deferred) return; deferred.prompt(); deferred.userChoice.then(function () { deferred = null; inst.hidden = true; }); });
    window.addEventListener("appinstalled", function () { inst.hidden = true; });
    var sync = function () { $("offline").hidden = navigator.onLine !== false; };
    window.addEventListener("online", sync); window.addEventListener("offline", sync); sync();
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  /* ---------- results header + profile ---------- */
  function renderHead() {
    var d = state.data;
    $("resname").textContent = locName();
    $("resmeta").innerHTML = state.loc ? "<bdi dir='ltr'>" + state.loc.lat.toFixed(2) + ", " + state.loc.lon.toFixed(2) + "</bdi>" : "";
    $("cov").innerHTML = SRC.map(function (k) {
      var on = d.sources && d.sources[k] && d.sources[k] !== "synthetic" && (k !== "soilgrids" || (d.soil && d.soil.ph));
      return "<li class='" + (on ? "on" : "") + "' title='" + esc(t(on ? "cov.on" : "cov.off")) + "'>" + SRC_NAME[k] + "</li>";
    }).join("");
  }
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
  function sumYears(s) { return s.map(function (r) { return r.reduce(function (a, b) { return a + b; }, 0); }); }
  function profileStats(d) { return { rain: mean(sumYears(d.climate.rain)), heat: mean(sumYears(d.climate.heat_days)), frost: mean(sumYears(d.climate.frost_days)) }; }

  function renderProfile() {
    var d = state.data; if (!d) return;
    renderHead();
    var nY = d.years.length, annual = sumYears(d.climate.rain), sorted = annual.slice().sort(function (a, b) { return a - b; }), ps = profileStats(d);
    var h = "<div class='grid'>" +
      stat(Math.round(ps.rain) + " mm", t("pf.mean", { y0: d.years[0], y1: d.years[nY - 1] })) +
      stat(Math.round(Scoring.pct(sorted, .1)) + "–" + Math.round(Scoring.pct(sorted, .9)) + " mm", t("pf.range")) +
      stat(ps.heat.toFixed(0), t("pf.heat")) + stat(ps.frost.toFixed(0), t("pf.frost")) + "</div>";
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
    $("profile").innerHTML = h; markScrollers();
  }

  /* ---------- vulnerability calendar ---------- */
  function renderCalendar() {
    var d = scen(state.data), cfg = state.cfg, thr = cfg.bare_ndvi_threshold, ML = months();
    var heatM = monthStats(d.climate.heat_days).map(function (s) { return s[1]; });
    var extM = d.climate.extreme_days[0].map(function (_, m) { return mean(d.climate.extreme_days.map(function (r) { return r[m]; })); });
    var h = "<div class='chart'><div class='cal'><div></div>" + ML.map(function (m) { return "<div class='m'>" + esc(m) + "</div>"; }).join("");
    currentIds().forEach(function (rid) {
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

  /* ---------- insights, summary, cards ---------- */
  function insights(rot, res, d, fb) {
    var cfg = state.cfg, crops = {}; rot.cycle.forEach(function (p) { p.forEach(function (c) { crops[c] = cfg.crops[c]; }); });
    var benefits = [], risks = [], flags = [], ids = Object.keys(crops);
    ids.forEach(function (id) { var c = crops[id], s = t("ben." + c.type, { crop: cropName(id) }); if (benefits.indexOf(s) < 0) benefits.push(s); });
    if (rot.cycle.length === 1 && rot.cycle[0].length === 1) risks.push(t("risk.mono"));
    else if (ids.every(function (id) { return crops[id].type === "cereal"; })) risks.push(t("risk.cereals"));
    if (fb.water != null && fb.water < .5) risks.push(t(state.irr === "n" ? "risk.water.rain" : "risk.water"));
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
  function confPill(c) { return "<span class='pill conf conf-" + c.level + "'>" + esc(t("conf.badge", { level: t("conf." + c.level) })) + "</span>"; }

  // ---- plain-language layer: turn the six factor scores into short sentences a farmer can read ----
  function plain(fb) {
    var pos = [], neg = [];
    Scoring.FACTORS.forEach(function (f) { var v = fb[f.id]; if (v == null) return; if (v >= .7) pos.push([f.id, v]); else if (v <= .5) neg.push([f.id, v]); });
    pos.sort(function (a, b) { return b[1] - a[1]; }); neg.sort(function (a, b) { return a[1] - b[1]; });
    return { pos: pos.slice(0, 3).map(function (p) { return t("p." + p[0] + ".pos"); }),
             neg: neg.slice(0, 3).map(function (p) { return t(p[0] === "water" && state.irr === "n" ? "p.water.neg.rain" : "p." + p[0] + ".neg"); }) };
  }
  function fitInfo(r, top) { var g = top.mean - r.mean; return r.rank === 1 ? ["best", "fit.best"] : g < .04 ? ["close", "fit.close"] : g < .12 ? ["good", "fit.good"] : ["weak", "fit.weak"]; }
  function fitRow(r) {
    var n = Math.round(r.mean * 100), txt = esc(t("fit.label", { n: n }));
    return "<div class='fitrow'><div class='fitbar' role='img' aria-label='" + txt + "'><i style='width:" + n + "%'></i></div><b>" + txt + "</b></div>";
  }
  function whyBlock(p) {
    if (!p.pos.length && !p.neg.length) return "";
    return "<div class='why2'>" + (p.pos.length ? "<div class='plus'><h4>" + esc(t("why.plus")) + "</h4><ul>" + li(p.pos) + "</ul></div>" : "") +
      (p.neg.length ? "<div class='minus'><h4>" + esc(t("why.minus")) + "</h4><ul>" + li(p.neg) + "</ul></div>" : "") + "</div>";
  }

  function renderSummary(out, d) {
    var cfg = state.cfg, top = out.results[0], cur = out.results.filter(function (r) { return r.id === state.loc.current_rotation; })[0];
    var conf = Scoring.confidence(top, d), rot = cfg.rotations[top.id], fb = Scoring.factorBreakdown(rot, cfg, d), ins = insights(rot, top, d, fb);
    var line = (cur && top.id === cur.id) ? t("sum.vs.cur") : (cur ? t("sum.vs.up", { d: Math.max(1, Math.round(100 * (top.mean - cur.mean))), cur: rotLabel(cur.id) }) : "");
    var nb = top.noClearWinner ? out.results.filter(function (r) { return r.id !== top.id && r.noClearWinner; })[0] : null;
    var ask = ins.flags.filter(function (f) { return f !== t("flag.synth"); }).slice(0, 3);
    $("summary").innerHTML = "<div class='summary'><p class='kick'>" + esc(t("sum.best")) + "</p><div class='sumtop'><h3><bdi>" + esc(rotLabel(top.id)) + "</bdi></h3>" + confPill(conf) + "</div>" +
      fitRow(top) + "<p>" + esc(line) + "</p>" + (nb ? "<p class='flag'>" + esc(t("sum.close", { a: rotLabel(top.id), b: rotLabel(nb.id) })) + "</p>" : "") +
      whyBlock(plain(fb)) +
      "<p class='why'><b>" + esc(t("sum.why")) + ":</b> " + esc((conf.reasons.length ? conf.reasons.map(function (k) { return t(k); }).join("; ") : t("conf.r.none"))) + "</p>" +
      "<div class='ask'><h4>" + esc(t("sum.ask")) + "</h4><ul>" + li(ask) + "</ul></div></div>";
  }

  function renderAll() {
    if (!state.data || !state.loc) return;
    renderHead(); renderCalendar();
    var d = scen(state.data), cfg = state.cfg, out = rank(cfg, d, currentIds()), h = "", top = out.results[0];
    var gaps = (d.gaps || []).map(gapText);
    if (!(d.soil && d.soil.ph) && !(d.gaps || []).some(function (g) { return /^SoilGrids/.test(g); })) gaps.push(t("gap.soilmissing"));
    gaps = gaps.concat([t("gap.static1"), t("gap.static2")]);
    renderSummary(out, d);
    out.results.forEach(function (r) {
      var rot = cfg.rotations[r.id], fb = Scoring.factorBreakdown(rot, cfg, d), x = insights(rot, r, d, fb), isCur = r.id === state.loc.current_rotation, fi = fitInfo(r, top);
      var gap = Math.round(Scoring.irrigationNeed(rot, cfg, d) / 10) * 10;
      h += "<article class='card" + (r.rank === 1 ? " top" : "") + "'><div class='head'><span class='rank'>" + r.rank + "</span><div><h3><bdi>" + esc(rotLabel(r.id)) + "</bdi></h3><div class='pills'>" +
        "<span class='pill " + (fi[0] === "best" ? "best" : "") + "'>" + esc(t(fi[1])) + "</span>" + (isCur ? "<span class='pill cur'>" + esc(t("card.current")) + "</span>" : "") +
        (r.noClearWinner ? "<span class='pill tie'>" + esc(t("card.tie")) + "</span>" : "") + confPill(Scoring.confidence(r, d)) + "</div></div></div>" +
        fitRow(r) + whyBlock(plain(fb)) +
        "<details><summary>" + esc(t("card.more")) + "</summary>" +
        "<div class='bar' role='img' aria-label='" + f2(r.low) + " – " + f2(r.high) + "'><div class='rng' style='left:" + r.low * 100 + "%;width:" + Math.max(1, (r.high - r.low) * 100) + "%'></div><div class='tick' style='left:" + r.mean * 100 + "%'></div></div>" +
        "<div class='axis'><span>0</span><span dir='auto'>" + esc(t("card.range", { lo: f2(r.low), hi: f2(r.high) })) + "</span><span>1</span></div>" +
        "<p class='mini irr'>" + esc(t("card.irr", { mm: gap })) + "</p>" +
        "<h4 class='sh'>" + esc(t("card.ev")) + "</h4><p class='mini'>" + esc(t("card.ev.hint")) + "</p><div class='ev'>" +
        Scoring.FACTORS.map(function (f) {
          var v = fb[f.id];
          return "<div class='evrow" + (v == null ? " na" : "") + "'><div>" + esc(t("f." + f.id + ".label")) + "<small>" + esc(t("f." + f.id + ".data")) + "</small></div><div class='evbar'><i style='width:" + (v == null ? 0 : v * 100) + "%'></i></div><b>" + f2(v) + "</b></div>";
        }).join("") + "</div>" +
        "<h4 class='sh'>" + esc(t("card.br")) + "</h4><ul>" + li(x.benefits) + x.risks.map(function (z) { return "<li class='flag'>" + esc(t("card.risk", { t: z })) + "</li>"; }).join("") + "</ul>" +
        "<h4 class='sh'>" + esc(t("card.gaps")) + "</h4><ul>" + li(gaps) + "</ul>" +
        "<h4 class='sh flag'>" + esc(t("card.agro")) + "</h4><ul>" + li(x.flags) + "</ul></details></article>";
    });
    $("cards").innerHTML = h;
    renderFlip(); renderCompare(); markScrollers(); writeUrl();
  }

  // Where would the top choice change? Rain and temperature are swept separately against the unchanged record.
  function renderFlip() {
    var el = $("flip"), ids = currentIds(), canT = Scoring.hasTemperatureScenario(state.data);
    var topId = function (rainP, dT) { return rank(state.cfg, Scoring.applyScenario(state.data, rainP, dT), ids).results[0].id; };
    var base = topId(0, 0), lines = [], p, dT, hit = null;
    for (p = -5; p >= -40 && !hit; p -= 5) { var a = topId(p, 0); if (a !== base) hit = { top: a, p: -p }; }
    lines.push(hit ? t("sc.flip", { a: rotLabel(base), b: rotLabel(hit.top), p: hit.p }) : t("sc.noflip"));
    $("tempna").hidden = canT; $("sl-temp").disabled = !canT; $("sl-temp").parentNode.classList.toggle("off", !canT);
    if (canT) {
      hit = null;
      for (dT = 1; dT <= 4 && !hit; dT++) { var b = topId(0, dT); if (b !== base) hit = { top: b, p: dT }; }
      lines.push(hit ? t("sc.flipT", { a: rotLabel(base), b: rotLabel(hit.top), p: hit.p }) : t("sc.noflipT"));
    }
    el.textContent = lines.join("\n");
  }

  /* ---------- crop rules editor ---------- */
  var RULE_RANGE = { water_mm: [50, 1500], ph0: [3, 10], ph1: [3, 10] };
  function usedCrops() {
    var seen = {}, out = []; if (!state.loc) return out;
    currentIds().forEach(function (rid) { (rid === "mine" ? state.mine : state.cfgRaw.rotations[rid].cycle).forEach(function (p) { p.forEach(function (c) { if (!seen[c]) { seen[c] = 1; out.push(c); } }); }); });
    return out;
  }
  function ruleValue(cfg, id, f) { var k = cfg.crops[id]; return f === "ph0" ? k.ph[0] : f === "ph1" ? k.ph[1] : k[f]; }
  function renderRules() {
    var box = $("rules"); if (!state.loc || !state.cfg) { box.innerHTML = ""; return; }
    var ML = monthNames("long"), opts = function (sel) { return ML.map(function (n, i) { return "<option value='" + (i + 1) + "'" + (sel === i + 1 ? " selected" : "") + ">" + esc(n) + "</option>"; }).join(""); };
    var h = "<div class='tablewrap'><table><tr><th>" + esc(t("rules.crop")) + "</th><th>" + esc(t("rules.water")) + "</th><th>" + esc(t("rules.sow")) + "</th><th>" + esc(t("rules.harvest")) + "</th><th colspan='2'>" + esc(t("rules.ph")) + "</th><th>" + esc(t("rules.src")) + "</th></tr>";
    usedCrops().forEach(function (id) {
      var k = state.cfg.crops[id], edited = !!state.overrides[id], nm = cropName(id);
      var num = function (f, v, step, lab) { return "<td class='num'><input type='number' step='" + step + "' data-crop='" + id + "' data-field='" + f + "' value='" + v + "' aria-label='" + esc(nm + ": " + lab) + "'></td>"; };
      h += "<tr data-row='" + id + "' class='" + (edited ? "edited" : "") + "'><td><b data-edited='" + esc(t("rules.edited")) + "'>" + esc(nm) + "</b></td>" + num("water_mm", k.water_mm, 10, t("rules.water")) +
        "<td><select data-crop='" + id + "' data-field='sow' aria-label='" + esc(nm + ": " + t("rules.sow")) + "'>" + opts(k.sow) + "</select></td><td><select data-crop='" + id + "' data-field='harvest' aria-label='" + esc(nm + ": " + t("rules.harvest")) + "'>" + opts(k.harvest) + "</select></td>" +
        num("ph0", k.ph[0], 0.1, t("rules.ph") + " min") + num("ph1", k.ph[1], 0.1, t("rules.ph") + " max") +
        "<td><input type='text' maxlength='200' data-crop='" + id + "' data-field='source' value='" + esc(k.source || "") + "' placeholder='" + esc(t("rules.src.ph")) + "' aria-label='" + esc(nm + ": " + t("rules.src")) + "'></td></tr>";
    });
    box.innerHTML = h + "</table></div><div class='rulesbar'><button type='button' id='rulesreset' class='btn sm'>" + esc(t("rules.reset")) + "</button><span id='rulesmsg' role='alert'></span></div>"; markScrollers();
    renderHow();   // the sources table follows the place, the rotation set and the user's own rotation
  }
  function onRuleChange(el) {
    var id = el.dataset.crop, f = el.dataset.field, msg = $("rulesmsg"); if (msg) msg.textContent = "";
    var cur = state.cfg.crops[id], val = f === "source" ? el.value.trim() : parseFloat(el.value);
    if (f !== "source" && !isFinite(val)) { el.value = ruleValue(state.cfg, id, f); return; }
    if (RULE_RANGE[f]) val = Math.min(RULE_RANGE[f][1], Math.max(RULE_RANGE[f][0], val));
    var ph0 = f === "ph0" ? val : cur.ph[0], ph1 = f === "ph1" ? val : cur.ph[1];
    if ((f === "ph0" || f === "ph1") && ph0 >= ph1) { if (msg) msg.textContent = t("rules.bad"); el.value = ruleValue(state.cfg, id, f); return; }
    var o = state.overrides[id] || (state.overrides[id] = {});
    if (f === "source") { if (val) o.source = val; else delete o.source; }
    else if (val === ruleValue(state.cfgBase, id, f)) delete o[f]; else o[f] = val;
    if (!Object.keys(o).length) delete state.overrides[id];
    state.cfg = withOverrides(state.cfgBase);
    var row = document.querySelector("tr[data-row='" + id + "']"); if (row) row.classList.toggle("edited", !!state.overrides[id]);
    renderHow(); renderAll();
  }

  /* ---------- compare two places ---------- */
  function loadCompare(placeId) {
    var p = placeId && findPlace(placeId), token = ++state.cmpToken;
    if (!p) { state.cmp = null; renderCompare(); writeUrl(); return; }
    state.cmp = { placeId: p.id, loading: true }; renderCompare();
    var cached = state.index.filter(function (l) { return l.id === p.id; })[0];
    (cached ? getJSON("data/" + p.id + ".json") : LiveData.fetchLocation(p.lat, p.lon, function () {})).then(function (d) {
      if (token !== state.cmpToken) return;
      var ps = state.cfgRaw.presets[p.preset || LiveData.suggestPreset(d)];
      state.cmp = { placeId: p.id, data: d, ids: cached ? cached.rotation_ids : ps.ids, current: cached ? cached.current_rotation : ps.current };
      renderCompare(); writeUrl();
      if (d.soilPromise && !d.soilDone) d.soilPromise.then(function () { if (token === state.cmpToken) renderCompare(); });
    }).catch(function (e) {
      if (token !== state.cmpToken) return;
      state.cmp = { placeId: p.id, error: e.message === "NO_LAND" ? t("st.noland") : e.message }; renderCompare();
    });
  }
  function cmpColumn(name, d, cfg, ids, current) {
    var dd = scen(d), out = rank(cfg, dd, ids), top = out.results[0], conf = Scoring.confidence(top, dd), ps = profileStats(d);
    return "<div class='cmpcol'><h3><bdi>" + esc(name) + "</bdi></h3><p class='mini'>" + esc(t("cmp.rain")) + ": " + Math.round(ps.rain) + " mm · " + esc(t("cmp.heat")) + ": " + ps.heat.toFixed(0) + "</p>" +
      "<span class='mini'>" + esc(t("cmp.top")) + "</span><span class='big'><bdi>" + esc(rotLabel(top.id)) + "</bdi></span><div class='pills'><span class='pill cur'>" + f2(top.mean) + "</span>" + confPill(conf) + "</div>" +
      "<ul class='cmplist'>" + out.results.map(function (r) {
        return "<li><span><bdi>" + esc(rotLabel(r.id)) + "</bdi>" + (r.id === current ? " <span class='mini'>(" + esc(t("card.current")) + ")</span>" : "") + "</span><b>" + f2(r.mean) + "</b><div class='bar'><div class='rng' style='left:" + r.low * 100 + "%;width:" + Math.max(1, (r.high - r.low) * 100) + "%'></div><div class='tick' style='left:" + r.mean * 100 + "%'></div></div></li>";
      }).join("") + "</ul></div>";
  }
  function renderCompare() {
    var box = $("compare"), c = state.cmp; $("cmpsel").value = c && c.placeId ? c.placeId : "";
    var p = c && findPlace(c.placeId);
    if (!c || !p) { box.innerHTML = "<p class='mini'>" + esc(t("cmp.empty")) + "</p>"; return; }
    if (c.loading) { box.innerHTML = "<p class='mini'>" + esc(t("cmp.loading", { name: placeName(p) })) + "</p>"; return; }
    if (c.error) { box.innerHTML = "<div class='cmpcol err'>" + esc(t("cmp.err", { msg: c.error })) + "</div>"; return; }
    if (!state.data || !state.loc) { box.innerHTML = "<p class='mini'>" + esc(t("cmp.empty")) + "</p>"; return; }
    box.innerHTML = "<div class='cmpgrid'>" + cmpColumn(t("cmp.here") + ": " + locName(), state.data, state.cfg, currentIds(), state.loc.current_rotation) +
      cmpColumn(placeName(p), c.data, withOverrides(effectiveCfg(c.data.lat, c.data.lon)), c.ids, c.current) + "</div>";
  }

  /* ---------- build your own rotation ---------- */
  function readMine() {
    var plans = [];
    for (var y = 1; y <= 3; y++) {
      var p = [$("mine-" + y + "-1").value, $("mine-" + y + "-2").value].filter(function (c, i, a) { return c && a.indexOf(c) === i; });
      if (p.length) plans.push(p);
    }
    return plans;
  }
  function renderMine() {
    var box = $("mine"); if (!box || !state.cfgRaw) return;
    var ids = Object.keys(state.cfgRaw.crops).sort(function (a, b) { return cropName(a).localeCompare(cropName(b), I18N.lang()); });
    var opts = function (sel) { return "<option value=''>" + esc(t("mine.none")) + "</option>" + ids.map(function (id) { return "<option value='" + id + "'" + (sel === id ? " selected" : "") + ">" + esc(cropName(id)) + "</option>"; }).join(""); };
    var h = "<div class='minegrid'>";
    for (var y = 1; y <= 3; y++) {
      var p = state.mine[y - 1] || [];
      h += "<fieldset class='mineyear'><legend>" + esc(t("mine.year", { n: y })) + "</legend>" +
        "<label>" + esc(t("mine.crop1")) + "<select id='mine-" + y + "-1' data-mine='1'>" + opts(p[0]) + "</select></label>" +
        "<label>" + esc(t("mine.crop2")) + "<select id='mine-" + y + "-2' data-mine='1'>" + opts(p[1]) + "</select></label></fieldset>";
    }
    box.innerHTML = h + "</div><div class='rulesbar'><button type='button' id='mineclear' class='btn sm'>" + esc(t("mine.clear")) + "</button></div>";
  }
  function setMine(plans) {
    state.mine = plans;
    if (!state.loc) { writeUrl(); return; }
    applyMine(state.cfgBase); state.cfg = withOverrides(state.cfgBase);
    renderRules(); renderHow(); renderAll();
  }

  /* ---------- scoring explainer + where every crop rule comes from ---------- */
  function renderHow() {
    var h = "<div class='tablewrap'><table><tr><th>" + esc(t("th.rule")) + "</th><th>" + esc(t("th.data")) + "</th><th>" + esc(t("th.slider")) + "</th><th>" + esc(t("th.how")) + "</th></tr>";
    Scoring.FACTORS.forEach(function (f) {
      h += "<tr><td><b>" + esc(t("f." + f.id + ".label")) + "</b></td><td>" + esc(t("f." + f.id + ".data")) + "</td><td>" + esc(t("pri." + Scoring.sliderOf(f, irrMode()))) + "</td><td>" + esc(t("f." + f.id + ".rule")) + "</td></tr>";
    });
    h += "</table></div><p class='mini'>" + esc(t("sc2.note")) + " <a href='rotations.json'>rotations.json</a></p>";
    var cfg = state.cfg || state.cfgRaw, ids = state.loc ? usedCrops() : Object.keys(cfg.crops), MS = monthNames("short"), SRC = state.cfgRaw.sources || {};
    var badge = function (st) { return "<span class='pill st-" + st + "'>" + esc(t("src." + st)) + "</span>"; };
    h += "<h3 class='srch'>" + esc(t("how.src")) + "</h3><p class='mini'>" + esc(t("how.src.hint")) + "</p><div class='tablewrap'><table class='srctable'><tr><th>" + esc(t("rules.crop")) + "</th><th>" + esc(t("how.src")) + "</th></tr>";
    ids.forEach(function (id) {
      var k = cfg.crops[id], ci = k.cal_info || { region: "generic", status: "team", ids: [], note: "" }, wi = k.water || { range: null, ids: [], status: "team" }, seen = {}, links = "";
      ci.ids.concat(wi.ids).forEach(function (sid) {
        var so = SRC[sid]; if (!so || seen[sid]) return; seen[sid] = 1;
        links += "<li><a href='" + esc(so.url) + "' target='_blank' rel='noopener' title='" + esc(so.quote || "") + "'>" + esc(so.title) + "</a> <span class='mini'>(" + esc(t(so.read ? "src.read" : "src.notread")) + ")</span></li>";
      });
      h += "<tr><td><b>" + esc(cropName(id)) + "</b></td><td>" +
        "<div title='" + esc(ci.note || "") + "'>" + esc(t("src.cal.line", { region: t("region." + ci.region), from: MS[k.sow - 1], to: MS[k.harvest - 1] })) + " " + badge(ci.status) + "</div>" +
        "<div>" + esc(wi.range ? t("src.water.line", { mm: k.water_mm, lo: wi.range[0], hi: wi.range[1] }) : t("src.water.team", { mm: k.water_mm })) + " " + badge(wi.status) + "</div>" +
        (links ? "<ul class='srclinks'>" + links + "</ul>" : "") + (k.source ? "<div class='mini'>" + esc(k.source) + "</div>" : "") + "</td></tr>";
    });
    $("how").innerHTML = h + "</table></div>"; markScrollers();
  }

  // crop-rule edits use event delegation so the inputs keep focus while the ranking re-renders
  document.addEventListener("change", function (e) { var el = e.target; if (el.dataset && el.dataset.crop && el.dataset.field) onRuleChange(el); else if (el.dataset && el.dataset.mine) setMine(readMine()); });
  document.addEventListener("click", function (e) {
    if (e.target.id === "mineclear") { setMine([]); renderMine(); }
    if (e.target.id === "rulesreset") { state.overrides = {}; state.cfg = state.cfgBase; renderRules(); renderHow(); renderAll(); }
  });

  init();
})();
