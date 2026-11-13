/* Rotation Explorer UI. Reads only cached static files (data/*.json, rotations.json). */
(function () {
  "use strict";
  var MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  var state = { cfgRaw: null, loadToken: 0, customMarker: null, cfg: null, index: [], loc: null, data: null, sl: { water: .5, income: .5, soil: .5 }, rainDelta: 0, map: null, markers: {} };
  var $ = function (id) { return document.getElementById(id); };
  var mean = Scoring.mean;
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function f2(x) { return x == null || isNaN(x) ? "n/a" : x.toFixed(2); }

  function getJSON(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }); }

  // Apply the rainfall scenario to a copy of the data (rain only; see page note).
  function scenarioData(d, pct) {
    if (!pct) return d;
    var c = JSON.parse(JSON.stringify(d)), k = 1 + pct / 100;
    c.climate.rain = c.climate.rain.map(function (r) { return r.map(function (v) { return v * k; }); });
    return c;
  }

  function init() {
    Promise.all([getJSON("rotations.json"), getJSON("data/index.json")]).then(function (r) {
      state.cfgRaw = r[0]; state.cfg = r[0]; state.index = r[1];
      buildLocationPicker();
      bindLocationInputs();
      bindSliders();
      renderHow();
      var hero = state.index.filter(function (l) { return l.hero; })[0] || state.index[0];
      selectLocation(hero.id);
    }).catch(function (e) { $("profile").textContent = "Could not load data: " + e.message; });
  }

  function buildLocationPicker() {
    var list = $("loclist");
    state.index.forEach(function (l) {
      var b = document.createElement("button");
      b.type = "button"; b.dataset.id = l.id; b.innerHTML = "<b>" + esc(l.name) + "</b><br><span class='hint'>" + l.lat.toFixed(2) + ", " + l.lon.toFixed(2) + (l.hero ? " - hero case" : "") + "</span>";
      b.addEventListener("click", function () { selectLocation(l.id); });
      list.appendChild(b);
    });
    if (window.L) {
      state.map = L.map("map").setView([25, 20], 2);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 8, attribution: "&copy; OpenStreetMap contributors" }).addTo(state.map);
      state.index.forEach(function (l) {
        state.markers[l.id] = L.marker([l.lat, l.lon]).addTo(state.map).bindTooltip(l.name).on("click", function () { selectLocation(l.id); });
      });
    } else { $("map").textContent = "Map could not load (offline). Use the list."; $("map").style.padding = "12px"; }
  }

  // Crop calendars are Northern Hemisphere templates: shift every month list by 6 for the Southern Hemisphere.
  function effectiveCfg(lat) {
    if (lat >= 0) return state.cfgRaw;
    var c = JSON.parse(JSON.stringify(state.cfgRaw)), sh = function (m) { return (m - 1 + 6) % 12 + 1; };
    Object.keys(c.crops).forEach(function (id) {
      var k = c.crops[id]; k.sow = sh(k.sow); k.harvest = sh(k.harvest);
      ["heat_months", "frost_months", "rain_months"].forEach(function (f) { k[f] = k[f].map(sh); });
    });
    return c;
  }

  function setStatus(msg, isErr) { var el = $("status"); el.textContent = msg || ""; el.className = isErr ? "hint err" : "hint"; }

  function applyPreset(key) {
    var p = state.cfgRaw.presets[key];
    state.loc = { id: "custom", name: state.loc.name, lat: state.loc.lat, lon: state.loc.lon, hero: false, current_rotation: p.current, rotation_ids: p.ids };
    renderAll();
  }

  function loadCustom(lat, lon, label) {
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90) { setStatus("Enter a latitude between -90 and 90 and a longitude between -180 and 180.", true); return; }
    lon = ((lon + 540) % 360) - 180;
    var token = ++state.loadToken;
    Array.prototype.forEach.call($("loclist").children, function (b) { b.setAttribute("aria-pressed", "false"); });
    if (state.map) {
      if (state.customMarker) state.customMarker.setLatLng([lat, lon]); else state.customMarker = L.marker([lat, lon]).addTo(state.map);
      state.map.setView([lat, lon], Math.max(state.map.getZoom(), 5));
    }
    $("lat").value = lat.toFixed(2); $("lon").value = lon.toFixed(2);
    setStatus("Loading...");
    LiveData.fetchLocation(lat, lon, setStatus).then(function (d) {
      if (token !== state.loadToken) return;
      d.name = label || ("Custom location (" + lat.toFixed(2) + ", " + lon.toFixed(2) + ")");
      state.data = d; state.cfg = effectiveCfg(d.lat);
      var key = LiveData.suggestPreset(d), sel = $("preset"); sel.value = key; $("presetrow").hidden = false;
      state.loc = { name: d.name, lat: d.lat, lon: d.lon };
      $("banner").hidden = true; setStatus("Loaded " + d.name + ".");
      renderProfile(); applyPreset(key);
    }).catch(function (e) {
      if (token !== state.loadToken) return;
      setStatus("Could not load data for this point: " + e.message + ". The NASA POWER service may be busy or blocked on this network. Try again, or pick a demo location.", true);
    });
  }

  function bindLocationInputs() {
    var sel = $("preset");
    Object.keys(state.cfgRaw.presets).forEach(function (k) { var o = document.createElement("option"); o.value = k; o.textContent = state.cfgRaw.presets[k].label; sel.appendChild(o); });
    sel.addEventListener("change", function () { applyPreset(sel.value); });
    $("coordform").addEventListener("submit", function (e) { e.preventDefault(); loadCustom(parseFloat($("lat").value), parseFloat($("lon").value)); });
    $("searchform").addEventListener("submit", function (e) {
      e.preventDefault(); var q = $("q").value.trim(); if (!q) return;
      setStatus("Searching for " + q + "...");
      fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (res) {
        if (!res.length) { setStatus("No place found for '" + q + "'. Try a nearby town or type coordinates.", true); return; }
        loadCustom(parseFloat(res[0].lat), parseFloat(res[0].lon), res[0].display_name.split(",").slice(0, 2).join(",").trim());
      }).catch(function () { setStatus("Place search is unavailable. Type coordinates or click the map instead.", true); });
    });
    if (state.map) state.map.on("click", function (e) { loadCustom(e.latlng.lat, e.latlng.lng); });
  }

  function selectLocation(id) {
    getJSON("data/" + id + ".json").then(function (d) {
      state.loadToken++; state.data = d; state.loc = state.index.filter(function (l) { return l.id === id; })[0];
      state.cfg = effectiveCfg(d.lat); $("presetrow").hidden = true; setStatus("");
      if (state.customMarker && state.map) { state.map.removeLayer(state.customMarker); state.customMarker = null; }
      Array.prototype.forEach.call($("loclist").children, function (b) { b.setAttribute("aria-pressed", b.dataset.id === id); });
      if (state.map) state.map.setView([d.lat, d.lon], 5);
      var ban = $("banner");
      if (d.synthetic) { ban.hidden = false; ban.textContent = "PLACEHOLDER DATA: these numbers are synthetic, not from NASA. Run the pipeline (see README) to load real data."; }
      else ban.hidden = true;
      renderProfile(); renderAll();
    });
  }

  function bindSliders() {
    ["water", "income", "soil"].forEach(function (k) {
      var el = $("sl-" + k);
      el.addEventListener("input", function () { state.sl[k] = el.value / 100; $("o-" + k).textContent = el.value + "%"; renderAll(); });
      $("o-" + k).textContent = el.value + "%";
    });
    $("sl-rain").addEventListener("input", function (e) { state.rainDelta = +e.target.value; $("o-rain").textContent = (state.rainDelta > 0 ? "+" : "") + state.rainDelta + "%"; renderAll(); });
    $("o-rain").textContent = "0%";
  }

  /* ---------- field profile ---------- */
  function monthStats(series) { // [year][12] -> per-month p10, median, p90
    var out = [];
    for (var m = 0; m < 12; m++) {
      var col = series.map(function (r) { return r[m]; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
      out.push([Scoring.pct(col, .1), Scoring.pct(col, .5), Scoring.pct(col, .9)]);
    }
    return out;
  }

  function rainChart(d) {
    var st = monthStats(d.climate.rain), W = 560, H = 170, pl = 34, pb = 20, pt = 8;
    var max = Math.max.apply(null, st.map(function (s) { return s[2]; })) * 1.1 || 1;
    var bw = (W - pl) / 12, y = function (v) { return pt + (H - pt - pb) * (1 - v / max); };
    var s = "<svg viewBox='0 0 " + W + " " + H + "' width='100%' role='img' aria-label='Monthly rainfall, median with 10th to 90th percentile range'>";
    for (var t = 0; t <= 4; t++) { var v = max * t / 4; s += "<line x1='" + pl + "' x2='" + W + "' y1='" + y(v) + "' y2='" + y(v) + "' stroke='currentColor' opacity='.12'/><text x='2' y='" + (y(v) + 4) + "'>" + Math.round(v) + "</text>"; }
    st.forEach(function (m, i) {
      var x = pl + i * bw + bw * .15, w = bw * .7;
      s += "<rect x='" + x + "' y='" + y(m[1]) + "' width='" + w + "' height='" + (y(0) - y(m[1])) + "' fill='var(--crop)'/>";
      s += "<line x1='" + (x + w / 2) + "' x2='" + (x + w / 2) + "' y1='" + y(m[0]) + "' y2='" + y(m[2]) + "' stroke='var(--fg)' stroke-width='1.5'/>";
      s += "<text x='" + (x + w / 2 - 3) + "' y='" + (H - 5) + "'>" + MONTHS[i] + "</text>";
    });
    return s + "</svg>";
  }

  function renderProfile() {
    var d = state.data, nY = d.years.length;
    var annual = d.climate.rain.map(function (r) { return r.reduce(function (a, b) { return a + b; }, 0); });
    var heat = mean(d.climate.heat_days.map(function (r) { return r.reduce(function (a, b) { return a + b; }, 0); }));
    var frost = mean(d.climate.frost_days.map(function (r) { return r.reduce(function (a, b) { return a + b; }, 0); }));
    var sorted = annual.slice().sort(function (a, b) { return a - b; });
    var h = "<div class='grid'>" +
      stat(Math.round(mean(annual)) + " mm", "mean annual rain (" + d.years[0] + "-" + d.years[nY - 1] + ")") +
      stat(Math.round(Scoring.pct(sorted, .1)) + "-" + Math.round(Scoring.pct(sorted, .9)) + " mm", "annual rain, 10th-90th percentile") +
      stat(heat.toFixed(0), "heat days per year (Tmax >= 35 C)") +
      stat(frost.toFixed(0), "frost days per year (Tmin <= 0 C)") + "</div>";
    h += "<div class='chart'><b>Monthly rainfall (mm)</b> <span class='hint'>bar = median, line = 10th-90th percentile</span>" + rainChart(d) + "</div>";
    if (d.soil) {
      h += "<div class='chart'><b>Soil baseline</b> <span class='hint'>SoilGrids topsoil 0-30 cm, 5th / mean / 95th percentile</span><table><tr><th>Property</th><th>5th</th><th>Mean</th><th>95th</th></tr>";
      Object.keys(d.soil).forEach(function (k) { var q = d.soil[k]; h += "<tr><td>" + k.toUpperCase() + " (" + esc(d.soil_units[k]) + ")</td><td>" + q.q05 + "</td><td>" + q.mean + "</td><td>" + q.q95 + "</td></tr>"; });
      h += "</table></div>";
    }
    h += "<p class='hint'>" + esc(d.resolution_note) + "</p>";
    if (d.rain_crosscheck) h += "<p class='hint'>Rain cross-check: " + esc(d.rain_crosscheck.note) + "</p>";
    $("profile").innerHTML = h;
  }
  function stat(b, s) { return "<div class='stat'><b>" + b + "</b><span>" + s + "</span></div>"; }

  /* ---------- vulnerability calendar ---------- */
  function renderCalendar() {
    var d = state.data, cfg = state.cfg, thr = cfg.bare_ndvi_threshold;
    var heatM = monthStats(d.climate.heat_days).map(function (s) { return s[1]; });
    var extM = d.climate.extreme_days[0].map(function (_, m) { return mean(d.climate.extreme_days.map(function (r) { return r[m]; })); });
    var h = "<div class='chart'><div class='cal'><div></div>" + MONTHS.map(function (m) { return "<div class='m'>" + m + "</div>"; }).join("");
    state.loc.rotation_ids.forEach(function (rid) {
      var rot = cfg.rotations[rid];
      rot.cycle.forEach(function (plan, pi) {
        var covered = {}, heatCrit = {};
        plan.forEach(function (cid) {
          var c = cfg.crops[cid]; Scoring.growingMonths(c).forEach(function (m) { covered[m] = cid; });
          c.heat_months.forEach(function (m) { heatCrit[m] = true; });
        });
        h += "<div class='lab'>" + esc(rot.label.replace(/ \(current\)/, "")) + (rot.cycle.length > 1 ? " <span class='hint'>yr " + (pi + 1) + "</span>" : "") + "</div>";
        for (var m = 1; m <= 12; m++) {
          var cls = "ok", tip = "";
          if (covered[m]) { cls = "crop"; tip = cfg.crops[covered[m]].label; }
          else if (d.ndvi_clim && d.ndvi_clim[m - 1] != null && d.ndvi_clim[m - 1] < thr) { cls = "bare"; tip = "Bare field (NDVI " + d.ndvi_clim[m - 1].toFixed(2) + ")"; }
          var fl = "";
          if (heatCrit[m] && covered[m] && heatM[m - 1] >= 5) { fl += "H"; tip += "; heat stress in a sensitive month"; }
          if (covered[m] && extM[m - 1] >= .3) { fl += "R"; tip += "; extreme-rain risk"; }
          h += "<div class='c " + cls + "' title='" + esc(tip) + "'><span class='f flag'>" + fl + "</span></div>";
        }
      });
    });
    h += "</div><div class='legend'><span><i class='sw' style='background:var(--crop)'></i>Crop in field</span>" +
      (d.ndvi_clim ? "<span><i class='sw' style='background:var(--bare)'></i>Bare (low NDVI, no crop)</span>" : "<span>Bare-field windows unavailable (no MODIS data)</span>") +
      "<span><b class='flag'>H</b> heat stress in sensitive month</span><span><b class='flag'>R</b> extreme-rain risk</span></div></div>";
    $("calendar").innerHTML = h;
  }

  /* ---------- rotation cards ---------- */
  var BENEFIT = {
    legume: "Legume: fixes nitrogen and tends to build soil organic carbon.",
    cereal: "Cereal: dependable staple; residues return some carbon.",
    oilseed: "Oilseed: diversifies income and breaks cereal disease cycles."
  };
  function risksAndFlags(rot, res, d, fb) {
    var cfg = state.cfg, crops = {}; rot.cycle.forEach(function (p) { p.forEach(function (c) { crops[c] = cfg.crops[c]; }); });
    var benefits = [], risks = [], flags = [];
    Object.keys(crops).forEach(function (id) {
      var c = crops[id], b = BENEFIT[c.type];
      if (b && benefits.indexOf(c.label + " - " + b) < 0) benefits.push(c.label + " - " + b);
    });
    var allCereal = Object.keys(crops).every(function (id) { return crops[id].type === "cereal"; });
    if (rot.cycle.length === 1 && rot.cycle[0].length === 1) risks.push("Same crop every year: pest and disease build-up and continued soil-carbon drain.");
    else if (allCereal) risks.push("Cereals only: little diversity.");
    if (fb.water != null && fb.water < .5) risks.push("Rain alone covers under half of crop water need in a typical year; this rotation depends on irrigation.");
    if (fb.heat != null && fb.heat < .6) risks.push("Frequent heat or frost days in sensitive months.");
    if (fb.rain != null && fb.rain < .7) risks.push("Extreme-rain days fall in sensitive months.");
    if (fb.bare != null && fb.bare < .75) risks.push("Fields sit bare in low-NDVI months (erosion and evaporation).");
    if (fb.fit != null && fb.fit < .7) risks.push("Soil pH or clay is outside this crop's preferred range.");
    // agronomist flags
    flags.push("Confirm irrigation water availability and quality: the tool cannot see irrigation practice.");
    if (d.soil && d.soil.ph && d.soil.ph.mean > 8) flags.push("Soil pH above 8: check for salinity or sodicity locally before changing crops.");
    if (d.soil && d.soil.soc && d.soil.soc.mean < 6) flags.push("Low soil organic carbon: ask an agronomist how quickly a legume would change it on your soil.");
    if (Object.keys(crops).some(function (id) { return crops[id].type === "legume"; })) flags.push("Confirm legume variety, seed supply and inoculant locally.");
    if (res.high - res.low > .25) flags.push("Wide range between good and bad years: results are uncertain.");
    if (res.noClearWinner) flags.push("Close to another rotation: the data cannot separate them.");
    if (d.synthetic) flags.push("This view uses placeholder data, not real measurements.");
    return { benefits: benefits, risks: risks, flags: flags };
  }

  function renderAll() {
    if (!state.data) return;
    renderCalendar();
    var d = scenarioData(state.data, state.rainDelta), cfg = state.cfg;
    var out = Scoring.rankRotations(cfg, d, state.loc.rotation_ids, state.sl);
    var h = "";
    out.results.forEach(function (r) {
      var rot = cfg.rotations[r.id], fb = Scoring.factorBreakdown(rot, cfg, d), x = risksAndFlags(rot, r, d, fb);
      var isCur = r.id === state.loc.current_rotation;
      h += "<article class='card" + (r.rank === 1 ? " top" : "") + "'><div class='head'><span class='rank'>" + r.rank + "</span><div><h3>" + esc(rot.label) + "</h3><div class='pills'>" +
        (isCur ? "<span class='pill cur'>current rotation</span>" : "") + (r.rank === 1 ? "<span class='pill cur'>top for your priorities</span>" : "") +
        (r.noClearWinner ? "<span class='pill tie'>no clear winner vs. neighbours</span>" : "") + "</div></div>" +
        "<div class='score'><b>" + f2(r.mean) + "</b><span>mean score</span></div></div>" +
        "<div class='bar' role='img' aria-label='Score range " + f2(r.low) + " to " + f2(r.high) + ", mean " + f2(r.mean) + "'><div class='rng' style='left:" + r.low * 100 + "%;width:" + Math.max(1, (r.high - r.low) * 100) + "%'></div><div class='tick' style='left:" + r.mean * 100 + "%'></div></div>" +
        "<div class='axis'><span>0</span><span>range " + f2(r.low) + " to " + f2(r.high) + " across years and soil uncertainty</span><span>1</span></div>" +
        "<details><summary>Evidence</summary><table><tr><th>Factor</th><th>Mean</th><th>Data</th></tr>" +
        Scoring.FACTORS.map(function (f) { return "<tr><td>" + esc(f.label) + "</td><td>" + f2(fb[f.id]) + "</td><td>" + esc(f.data) + "</td></tr>"; }).join("") + "</table></details>" +
        "<details><summary>Benefits and risks</summary><ul>" + x.benefits.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + x.risks.map(function (t) { return "<li class='flag'>Risk: " + esc(t) + "</li>"; }).join("") + "</ul></details>" +
        "<details><summary>Data gaps</summary><ul>" + gapList(d).map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul></details>" +
        "<details open><summary class='flag'>Check with a local agronomist</summary><ul>" + x.flags.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul></details></article>";
    });
    $("cards").innerHTML = h;
    renderFlip();
  }

  function gapList(d) {
    var g = (d.gaps || []).slice();
    g.push("Irrigation practice, local pest pressure, market prices and farm economics are not in any dataset used.");
    g.push("Crop parameters are team-chosen rules of thumb, not measured for this field.");
    return g;
  }

  // Find the first rainfall cut at which the top-ranked rotation changes.
  function renderFlip() {
    var base = Scoring.rankRotations(state.cfg, state.data, state.loc.rotation_ids, state.sl).results[0].id, el = $("flip");
    for (var p = -5; p >= -40; p -= 5) {
      var top = Scoring.rankRotations(state.cfg, scenarioData(state.data, p), state.loc.rotation_ids, state.sl).results[0].id;
      if (top !== base) { el.textContent = "With the current sliders, the top choice changes from '" + state.cfg.rotations[base].label + "' to '" + state.cfg.rotations[top].label + "' once rainfall falls by about " + (-p) + "%."; return; }
    }
    el.textContent = "With the current sliders, the top choice does not change for rainfall cuts up to 40%.";
  }

  /* ---------- how scored ---------- */
  function renderHow() {
    var h = "<p>Each rotation is scored 0-1 for every historical year on six rules. The sliders set how much each group counts: <code>S = sum(w x s)</code>, weights add up to 1. The range shown on each card is the 10th-90th percentile across years, widened by the 5th-95th percentile soil values. No machine learning is used.</p><div class='tablewrap'><table><tr><th>Rule</th><th>Data</th><th>Slider</th><th>How it is scored</th></tr>";
    Scoring.FACTORS.forEach(function (f) { h += "<tr><td>" + esc(f.label) + "</td><td>" + esc(f.data) + "</td><td>" + f.slider + "</td><td>" + esc(f.rule) + "</td></tr>"; });
    h += "</table></div><p class='hint'>Crop parameters (water need, sensitive months, pH range, soil-carbon effect) are in <a href='rotations.json'>rotations.json</a> and are the team's rules of thumb, to be confirmed by an agronomist.</p>";
    $("how").innerHTML = h;
  }

  init();
})();
