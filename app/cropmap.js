/* Agricultural GIS layer for the EXISTING Leaflet map (it adds to the map; nothing is replaced).
 *
 * What it draws is real or it is not drawn: crop polygons come from the backend's /api/crops, which reads USDA's Cropland Data Layer
 * (crop TYPES, USA only) and ESA WorldCover (cropland only, global). Where no crop-type map exists the legend says so instead of
 * inventing wheat or rice areas. Colours come from the dataset itself when it has them (USDA's own table), otherwise a stable
 * generated colour per crop name, and the legend and the polygons share ONE colour function, so they always match. */
(function (root) {
  "use strict";

  var MIN_ZOOM = 13, CELL = 0.04, MAX_CELLS = 12, FILL_OPACITY = 0.55;

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function tr(key, p) { return root.I18N ? root.I18N.t(key, p) : key; }

  /* ---------- colours ---------- */
  var registry = {}, generated = [];
  function hash(s) { var h = 2166136261, i; for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100; var k = function (n) { return (n + h / 30) % 12; }, a = s * Math.min(l, 1 - l), f = function (n) { var v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return ("0" + Math.round(255 * v).toString(16)).slice(-2); };
    return "#" + f(0) + f(8) + f(4);
  }
  function hueGap(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  // The dataset's own colour wins (USDA publishes one per crop). Without one, a stable colour from the name, nudged away from colours already in use.
  function colorFor(crop, official) {
    if (registry[crop]) return registry[crop];
    var c;
    if (official && /^#[0-9a-f]{6}$/i.test(official)) c = official.toLowerCase();
    else if (/^Cropland \(crop type not identified\)/.test(crop)) c = "#d4a017";
    else {
      var hue = hash(crop) % 360, tries = 0, close = function (h) { return generated.some(function (g) { return hueGap(g, h) < 17; }); };
      while (tries++ < 20 && close(hue)) hue = (hue + 19) % 360;
      generated.push(hue); c = hslToHex(hue, 62, 44);
    }
    registry[crop] = c; return c;
  }
  function darker(hex) { var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255, d = function (v) { return ("0" + Math.round(v * 0.62).toString(16)).slice(-2); }; return "#" + d(r) + d(g) + d(b); }

  /* ---------- legend model and filters (pure) ---------- */
  function legendModel(features) {
    var m = {};
    features.forEach(function (f) {
      var p = f.properties, e = m[p.crop] || (m[p.crop] = { crop: p.crop, color: colorFor(p.crop, p.color), count: 0, area: 0, category: p.category || null });
      e.count++; e.area += p.area_ha || 0;
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.area - a.area || (a.crop < b.crop ? -1 : 1); });
  }
  // selected: if any crop is selected only those show; hidden crops never show. Both are plain objects used as sets.
  function isVisible(crop, st) { if (st.hidden[crop]) return false; return !Object.keys(st.selected).length || !!st.selected[crop]; }
  function matchSearch(crop, q) { q = (q || "").trim().toLowerCase(); return !q || crop.toLowerCase().indexOf(q) >= 0; }
  function showAll(st) { st.hidden = {}; st.selected = {}; }
  function clearFilters(st) { st.hidden = {}; st.selected = {}; st.search = ""; }
  function toggleSelected(st, crop) { if (st.selected[crop]) delete st.selected[crop]; else st.selected[crop] = true; if (st.selected[crop]) delete st.hidden[crop]; }
  function toggleHidden(st, crop) { if (st.hidden[crop]) delete st.hidden[crop]; else { st.hidden[crop] = true; delete st.selected[crop]; } }

  /* ---------- tiles of the world: fixed 0.04 degree cells so repeat views hit the cache ---------- */
  function wrapLon(lon) { return ((lon + 540) % 360) - 180; }
  function cellsFor(bounds, center) {
    var w = wrapLon(bounds.west), e = wrapLon(bounds.east); if (e < w) return [];          // a view straddling the antimeridian is not supported
    var out = [], ix, iy;
    for (ix = Math.floor(w / CELL); ix <= Math.floor(e / CELL); ix++) for (iy = Math.floor(bounds.south / CELL); iy <= Math.floor(bounds.north / CELL); iy++) {
      if (iy * CELL < -90 || (iy + 1) * CELL > 90) continue;
      out.push({ key: ix + "_" + iy, west: +(ix * CELL).toFixed(4), south: +(iy * CELL).toFixed(4), east: +((ix + 1) * CELL).toFixed(4), north: +((iy + 1) * CELL).toFixed(4) });
    }
    var cx = center.lon, cy = center.lat;
    out.sort(function (a, b) { return Math.hypot((a.west + a.east) / 2 - cx, (a.south + a.north) / 2 - cy) - Math.hypot((b.west + b.east) / 2 - cx, (b.south + b.north) / 2 - cy); });
    return out;
  }
  function cropsUrl(base, c) { return base.replace(/\/+$/, "") + "/api/crops?west=" + c.west + "&south=" + c.south + "&east=" + c.east + "&north=" + c.north; }

  /* ---------- popup (only what the dataset supports; everything else says so) ---------- */
  function fmtHa(v) { return v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2); }
  function polygonId(p, meta) { var h = hash([p.lat, p.lon, p.area_ha, p.class_code].join("|")).toString(36).toUpperCase(); return ((meta && meta.source) || "x").toUpperCase() + "-" + (p.year || "") + "-" + h; }
  function popupHtml(p, meta, ctx) {
    ctx = ctx || {};
    var na = "<span class='cp-na'>" + esc(tr("crop.p.na")) + "</span>", colour = colorFor(p.crop, p.color);
    var label = function (k) { var t = tr(k), m = t.match(/^(.*?)\s*[(（](.*)[)）]\s*$/); return m ? esc(m[1]) + "<small>(" + esc(m[2]) + ")</small>" : esc(t); };
    var row = function (k, v) { return "<tr><th scope='row'>" + label(k) + "</th><td>" + v + "</td></tr>"; };
    var kind = meta && meta.kind === "model_prediction" ? tr("crop.p.kind") : "";
    var src = meta ? esc(meta.dataset || "") + (meta.year ? ", " + esc(meta.year) : "") + (meta.native_resolution ? " (" + esc(meta.native_resolution) + ")" : "") + "<br><small>" + esc(kind) + "</small>" +
      (meta.credit ? "<br><small>" + esc(meta.credit) + "</small>" : "") : na;
    return "<div class='cp'><h4><span class='sw' style='background:" + colour + "'></span>" + esc(p.crop) + "</h4><table>" +
      row("crop.p.id", esc(polygonId(p, meta))) +
      row("crop.p.cat", p.category ? esc(p.category) : na) +
      row("crop.p.coord", "<bdi dir='ltr'>" + (+p.lat).toFixed(5) + ", " + (+p.lon).toFixed(5) + "</bdi>") +
      row("crop.p.area", p.area_ha != null ? esc(tr("crop.p.ha", { v: fmtHa(p.area_ha) })) : na) +
      row("crop.p.season", ctx.season ? esc(ctx.season) : na) +
      row("crop.p.veg", "<div class='cp-ndvi' data-lat='" + esc(p.lat) + "' data-lon='" + esc(p.lon) + "'>" + (ctx.ndvi ? esc(ctx.ndvi) : "<button type='button' class='btn sm cp-ndvi-btn'>" + esc(tr("crop.p.ndvibtn")) + "</button>") + "</div>") +
      row("crop.p.src", src) + "</table>" +
      "<button type='button' class='btn sm cp-analyse' data-lat='" + esc(p.lat) + "' data-lon='" + esc(p.lon) + "'>" + esc(tr("crop.p.analyse")) + "</button></div>";
  }

  /* ---------- the Leaflet part ---------- */
  function attach(map, baseOsm, opts) {
    opts = opts || {};
    var L = root.L; if (!L || !map) return null;
    var st = { cells: {}, queue: [], active: 0, hidden: {}, selected: {}, search: "", collapsed: root.innerWidth < 640, error: false, tooMany: false, needServer: false, lastMeta: null, retryAfter: {} };
    var canvas = L.canvas({ padding: 0.4, tolerance: 3 }), group = L.layerGroup();

    var esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics (not NASA)" });
    var ndvi = L.tileLayer("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDVI_8Day/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png",
      { maxNativeZoom: 9, maxZoom: 18, opacity: 0.8, attribution: "NASA GIBS / MODIS Terra NDVI 8-day (about 250 m)" });
    var soil = L.tileLayer.wms("https://maps.isric.org/mapserv?map=/map/phh2o.map", { layers: "phh2o_0-5cm_mean", format: "image/png", transparent: true, version: "1.3.0", opacity: 0.7,
      attribution: "ISRIC SoilGrids, soil pH 0-5 cm (a model, not NASA)" });

    var control = null;
    function buildControl() {
      if (control) map.removeControl(control);
      var bases = {}, overlays = {};
      bases[tr("crop.l.osm")] = baseOsm; bases[tr("crop.l.sat")] = esri;
      overlays[tr("crop.l.crop")] = group; overlays[tr("crop.l.ndvi")] = ndvi; overlays[tr("crop.l.soil")] = soil;
      control = L.control.layers(bases, overlays, { position: "topright", collapsed: true }).addTo(map);
    }
    buildControl();

    /* legend */
    var legend = L.control({ position: "bottomleft" }), box = null, listEl = null, noteEl = null, searchEl = null, countEl = null;
    legend.onAdd = function () {
      box = L.DomUtil.create("div", "cropleg"); L.DomEvent.disableClickPropagation(box); L.DomEvent.disableScrollPropagation(box);
      box.innerHTML = "<div class='cl-head'><b class='cl-title'></b><button type='button' class='cl-toggle' aria-expanded='true'></button></div>" +
        "<div class='cl-body'><input type='search' class='cl-search' autocomplete='off'><div class='cl-btns'><button type='button' class='btn sm cl-all'></button><button type='button' class='btn sm cl-clear'></button></div>" +
        "<p class='cl-note' role='status' aria-live='polite'></p><div class='cl-count mini'></div><ul class='cl-list'></ul></div>";
      listEl = box.querySelector(".cl-list"); noteEl = box.querySelector(".cl-note"); searchEl = box.querySelector(".cl-search"); countEl = box.querySelector(".cl-count");
      searchEl.addEventListener("input", function () { st.search = searchEl.value; renderList(); });
      box.querySelector(".cl-all").addEventListener("click", function () { showAll(st); renderList(); redraw(); });
      box.querySelector(".cl-clear").addEventListener("click", function () { clearFilters(st); searchEl.value = ""; renderList(); redraw(); });
      box.querySelector(".cl-toggle").addEventListener("click", function () { st.collapsed = !st.collapsed; applyCollapse(); });
      listEl.addEventListener("click", function (e) {
        var li = e.target.closest("li[data-crop]"); if (!li) return; var crop = li.getAttribute("data-crop");
        if (e.target.classList.contains("cl-vis")) toggleHidden(st, crop); else toggleSelected(st, crop);
        renderList(); redraw();
      });
      renderLegendText(); applyCollapse(); fitLegend(); return box;
    };
    /* keep the legend inside the map: a short map (phones, the 380 px desktop map) gets a shorter legend whose list scrolls */
    function fitLegend() { if (!box) return; var h = map.getSize().y; box.style.maxHeight = Math.max(120, h - 70) + "px"; }
    map.on("resize", fitLegend);
    /* pan an opened popup clear of the legend so the two never overlap */
    function legendClearance() { return box && !st.collapsed && map.hasLayer(group) ? box.offsetWidth + 24 : 20; }
    function allFeatures() { var out = []; Object.keys(st.cells).forEach(function (k) { if (st.cells[k].features) out = out.concat(st.cells[k].features); }); return out; }
    function applyCollapse() {
      if (!box) return; box.classList.toggle("collapsed", st.collapsed);
      var b = box.querySelector(".cl-toggle"); b.setAttribute("aria-expanded", String(!st.collapsed)); b.textContent = st.collapsed ? "+" : "−";
      b.setAttribute("aria-label", tr(st.collapsed ? "crop.legend.open" : "crop.hide")); box.querySelector(".cl-title").textContent = tr("crop.legend");
    }
    function renderLegendText() {
      if (!box) return;
      box.querySelector(".cl-title").textContent = tr("crop.legend"); searchEl.placeholder = tr("crop.search"); searchEl.setAttribute("aria-label", tr("crop.search"));
      box.querySelector(".cl-all").textContent = tr("crop.all"); box.querySelector(".cl-clear").textContent = tr("crop.clear"); applyCollapse(); renderList();
    }
    function pendingCount() { return st.queue.length + st.active; }
    function notice() {
      if (st.needServer) return tr("crop.needserver");
      if (map.getZoom() < MIN_ZOOM) return tr("crop.zoom", { z: MIN_ZOOM });
      var parts = [];
      if (pendingCount()) parts.push(tr("crop.loading", { n: pendingCount() }));
      if (st.error) parts.push(tr("crop.err"));
      if (st.tooMany) parts.push(tr("crop.limit", { n: MAX_CELLS }));
      if (st.lastMeta && st.lastMeta.crop_type_available === false) parts.push(tr("crop.notype"));
      if (!pendingCount() && !allFeatures().length && !st.error) parts.push(tr("crop.none"));
      return parts.join(" ");
    }
    function renderList() {
      if (!box) return;
      noteEl.textContent = notice();
      var model = legendModel(allFeatures()), shown = model.filter(function (e) { return matchSearch(e.crop, st.search); });
      countEl.textContent = model.length ? tr("crop.count", { n: model.length }) : "";
      if (model.length && !shown.length) { listEl.innerHTML = "<li class='cl-empty'>" + esc(tr("crop.nomatch")) + "</li>"; return; }
      listEl.innerHTML = shown.map(function (e) {
        var on = isVisible(e.crop, st), sel = !!st.selected[e.crop];
        return "<li data-crop='" + esc(e.crop) + "' class='" + (sel ? "sel " : "") + (on ? "" : "off") + "'><input type='checkbox' class='cl-vis' " + (st.hidden[e.crop] ? "" : "checked") + " aria-label='" + esc(e.crop) + "'>" +
          "<span class='sw' style='background:" + e.color + "'></span><span class='cl-name'>" + esc(e.crop) + "</span><span class='cl-ha'>" + esc(tr("crop.p.ha", { v: fmtHa(e.area) })) + "</span></li>";
      }).join("");
    }

    /* polygons */
    function redraw() {
      group.clearLayers();
      var meta = function (k) { return st.cells[k].meta; };
      Object.keys(st.cells).forEach(function (k) {
        var c = st.cells[k]; if (!c.features) return;
        var feats = c.features.filter(function (f) { return isVisible(f.properties.crop, st); });
        if (!feats.length) return;
        L.geoJSON({ type: "FeatureCollection", features: feats }, {
          renderer: canvas, bubblingMouseEvents: false,
          style: function (f) { var col = colorFor(f.properties.crop, f.properties.color); return { color: darker(col), weight: 0.7, fillColor: col, fillOpacity: FILL_OPACITY }; },
          onEachFeature: function (f, layer) { layer.on("click", function (e) { L.popup({ maxWidth: Math.max(220, Math.min(320, map.getSize().x - legendClearance() - 40)), maxHeight: Math.max(160, map.getSize().y - 60), autoPanPaddingTopLeft: [legendClearance(), 50], autoPanPaddingBottomRight: [20, 20] }).setLatLng(e.latlng).setContent(popupHtml(f.properties, meta(k), { season: opts.season ? opts.season(f.properties.crop, f.properties.lat, f.properties.lon) : null })).openOn(map); }); }
        }).addTo(group);
      });
    }

    /* loading */
    function pump() {
      while (st.active < 2 && st.queue.length) {
        (function (cell) {
          st.active++; renderList();
          fetch(cropsUrl(opts.backend(), cell)).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function (fc) {
            st.cells[cell.key] = { features: fc.features, meta: fc.meta }; st.lastMeta = fc.meta; st.error = false;
          }).catch(function () { st.error = true; st.retryAfter[cell.key] = Date.now() + 60000; }).then(function () { st.active--; redraw(); renderList(); pump(); });
        })(st.queue.shift());
      }
    }
    function refresh() {
      if (!map.hasLayer(group)) return;
      if (!opts.backend || !opts.backend()) { st.needServer = true; renderList(); return; }
      st.needServer = false; st.tooMany = false;
      if (map.getZoom() < MIN_ZOOM) { renderList(); return; }
      var b = map.getBounds(), cells = cellsFor({ west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() }, { lat: map.getCenter().lat, lon: wrapLon(map.getCenter().lng) });
      if (cells.length > MAX_CELLS) { cells = cells.slice(0, MAX_CELLS); st.tooMany = true; }
      st.queue = cells.filter(function (c) { return !st.cells[c.key] && !(st.retryAfter[c.key] > Date.now()); });
      renderList(); pump();
    }
    var timer = null; function later() { clearTimeout(timer); timer = setTimeout(refresh, 350); }
    map.on("moveend", later);
    map.on("overlayadd", function (e) { if (e.layer === group) { legend.addTo(map); renderLegendText(); refresh(); } });
    map.on("overlayremove", function (e) { if (e.layer === group) { map.removeControl(legend); st.queue = []; } });

    /* popup buttons (delegated: popups are created on demand) */
    map.on("popupopen", function (e) {
      var el = e.popup.getElement(); if (!el) return;
      var nb = el.querySelector(".cp-ndvi-btn"), ab = el.querySelector(".cp-analyse");
      if (nb) nb.addEventListener("click", function () {
        var holder = nb.parentNode, lat = +holder.getAttribute("data-lat"), lon = +holder.getAttribute("data-lon"); nb.disabled = true; nb.textContent = tr("crop.loading", { n: 1 });
        (opts.ndvi ? opts.ndvi(lat, lon) : Promise.reject(new Error("no ndvi"))).then(function (j) {
          var l = j && j.ndvi && j.ndvi.latest; if (!l) throw new Error("no usable NDVI");
          holder.textContent = tr("crop.p.ndvi", { v: (+l.ndvi).toFixed(2), date: l.end });
        }).catch(function () { holder.textContent = tr("crop.p.ndvifail"); });
      });
      if (ab) ab.addEventListener("click", function () { if (opts.analyse) opts.analyse(+ab.getAttribute("data-lat"), +ab.getAttribute("data-lon")); map.closePopup(); });
    });

    var handle = { refresh: function () { buildControl(); renderLegendText(); redraw(); }, state: st, map: map, layers: { crops: group, ndvi: ndvi, soil: soil, satellite: esri } };
    api.instance = handle;      // lets tests and the console reach the map; nothing in the app depends on it
    return handle;
  }

  var api = { attach: attach, colorFor: colorFor, darker: darker, legendModel: legendModel, isVisible: isVisible, matchSearch: matchSearch, showAll: showAll, clearFilters: clearFilters,
              toggleSelected: toggleSelected, toggleHidden: toggleHidden, cellsFor: cellsFor, cropsUrl: cropsUrl, popupHtml: popupHtml, polygonId: polygonId, MIN_ZOOM: MIN_ZOOM, CELL: CELL, _reset: function () { registry = {}; generated = []; } };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CropMap = api;
})(typeof window !== "undefined" ? window : globalThis);
