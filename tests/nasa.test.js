// The NASA panel is rendered from REAL backend responses captured on 2026-11-14 (tests/fixtures/api_*.json).
const assert = require("assert"), fs = require("fs"), path = require("path");
const P = require("../app/nasa.js");
const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8"));
const loc = fx("api_location_lahore.json"), ndvi = fx("api_ndvi_lahore.json");
const en = {}; require("vm").runInNewContext(fs.readFileSync(path.join(__dirname, "../app/i18n/en.js"), "utf8"), { I18N: { add: (c, d) => Object.assign(en, d) } });
const t = (k, p) => { let s = en[k]; if (s == null) throw new Error("missing i18n key " + k); return p ? s.replace(/\{(\w+)\}/g, (m, x) => p[x] != null ? p[x] : m) : s; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 1. the model carries real numbers from the API, not constants
const m = P.model(loc, ndvi);
assert.ok(m.recent && m.recent.rain != null && m.recent.norm != null && m.recent.t != null);
assert.strictEqual(m.recent.rain, String(Math.round(loc.indicators.recent_vs_normal.rain_mm)));
assert.ok(m.trend && +m.trend.b > 0 && +m.trend.a > 0);
assert.ok(m.ndvi && m.ndvi.total > 0 && m.ndvi.valid <= m.ndvi.total && m.ndvi.series.length === m.ndvi.total);
assert.strictEqual(m.sources.length, 4);                                    // climate, soil, indicators, ndvi

// 2. SMAP / IMERG are shown as 'values not available', never as numbers
assert.strictEqual(m.smap.values, false); assert.strictEqual(m.imerg.values, false);
const h = P.html(m, t, esc);
assert.ok(h.includes(t("nasa.smap")) && h.includes(t("nasa.imerg")));
assert.ok(h.includes(m.smap.date), "shows the real newest satellite pass date");
assert.ok(/needs a NASA login that a public website cannot safely keep/.test(h));

// 3. every source is labelled with its kind, and soil wetness is NOT labelled an observation
assert.ok(h.includes("k-reanalysis") && h.includes("k-satellite_estimate") && h.includes("k-calculated"));
const soil = m.sources.find(s => s.label === "nasa.s.soil"); assert.strictEqual(soil.kind, "reanalysis");
assert.ok(!m.sources.some(s => s.kind === "observation"), "nothing here is a direct observation");

// 4. honesty: never claims to be live, always says how old the data is
assert.ok(h.includes(t("nasa.notlive")));
assert.ok(!/\blive\b|real-time data from/i.test(h.replace(t("nasa.notlive"), "")), "no 'live' claims");
assert.ok(/newest data \d{4}-\d{2}-\d{2}, \d+ days ago/.test(h));
assert.ok(h.includes(t("nasa.cell")));

// 5. gaps are shown, and blanks stay blank in the chart
const n2 = JSON.parse(JSON.stringify(ndvi)); n2.ndvi.series[3].ndvi = null; n2.ndvi.series[4].ndvi = null; n2.ndvi.valid_count -= 2;
const g = P.html(P.model(loc, n2), t, esc); assert.ok(/satellite passes had no usable value/.test(g));
assert.ok((P.spark([0.5, null, 0.6]).match(/M/g) || []).length === 2, "a gap breaks the line instead of being bridged");

// 6. escaping: server text can never inject markup
const evil = JSON.parse(JSON.stringify(loc)); evil.climate.provenance.dataset = "<img src=x onerror=alert(1)>"; evil.soil_moisture.smap.newest_acquisition = '"><script>1</script>';
const eh = P.html(P.model(evil, null), t, esc); assert.ok(!/<img|<script/i.test(eh));

// 7. partial data does not crash
assert.strictEqual(P.html(P.model(null, null), t, esc), "");
assert.doesNotThrow(() => P.html(P.model(loc, null), t, esc));
assert.doesNotThrow(() => P.html(P.model({ climate: {} }, { ndvi: { series: [], valid_count: 0, total_count: 0 } }), t, esc));

// 7b. soil is listed too, and labelled NOT NASA
const ms = P.model(loc, ndvi, fx("api_soil_ames.json")); assert.strictEqual(ms.sources.length, 5);
const sg = ms.sources.find(x => x.label === "nasa.s.soilgrids"); assert.strictEqual(sg.kind, "third_party");
const hs = P.html(ms, t, esc); assert.ok(hs.includes("k-third_party") && hs.includes(t("nasa.k.third_party")) && hs.includes("not NASA"));

// 8. disabled without a backend URL; no credentials in the client
assert.strictEqual(P.enabled(), false);
global.window = undefined;
const src = fs.readFileSync(path.join(__dirname, "../app/nasa.js"), "utf8") + fs.readFileSync(path.join(__dirname, "../app/config.js"), "utf8");
assert.ok(!/token|password|bearer|earthdata/i.test(src.replace(/NASA Earthdata logins and tokens belong ONLY[^*]*/i, "").replace(/Earthdata/g, "")) , "no secrets or auth in the client");

// 9. backend asleep or down: the browser engine takes over, and is not used when the backend answers
(async () => {
  const calls = []; global.AGRISHIFT = { backendUrl: "http://backend.example" };
  global.DirectData = { available: () => true, soil: async () => (calls.push("direct.soil"), { soil: { ph: 1 }, from: "browser" }), ndvi: async () => (calls.push("direct.ndvi"), { from: "browser" }), status: async () => (calls.push("direct.status"), { from: "browser" }) };
  global.fetch = async () => { throw new Error("backend asleep"); };
  assert.strictEqual(P.mode(), "backend");
  assert.strictEqual((await P.fetchSoil(1, 2)).from, "browser"); assert.strictEqual((await P.fetchNdvi(1, 2)).from, "browser"); assert.strictEqual((await P.fetchLocation(1, 2)).from, "browser");
  calls.length = 0; global.fetch = async () => ({ ok: true, json: async () => ({ from: "backend" }) });
  assert.strictEqual((await P.fetchSoil(1, 2)).from, "backend"); assert.deepStrictEqual(calls, [], "browser engine not used while the backend answers");
  delete global.DirectData; global.fetch = async () => { throw new Error("backend asleep"); };
  await assert.rejects(() => P.fetchSoil(1, 2), /backend asleep/);   // nothing to fall back on: the error is reported, never hidden
  delete global.AGRISHIFT; delete global.fetch;
  console.log("nasa panel tests passed");
})();
