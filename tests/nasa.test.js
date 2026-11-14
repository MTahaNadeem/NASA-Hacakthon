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

// 7c. recent satellite rain and soil moisture, from the REAL response captured 2026-11-14 (backend, Lahore)
const rec = fx("api_recent_lahore.json"), mr = P.model(loc, ndvi, null, rec), hr = P.html(mr, t, esc);
assert.ok(mr.rec && mr.rec.imerg && mr.rec.smap); assert.strictEqual(mr.rec.imerg.total, "6.6"); assert.strictEqual(mr.rec.smap.date, "2026-11-11");
assert.ok(hr.includes("6.6 mm in 30 days") && hr.includes("on 2 rainy days") && hr.includes("latest 0.204 m³/m³ on 2026-11-11") && hr.includes("readings on 10 of 27 days"));
assert.ok(hr.includes(t("nasa.rec.note")) && /not used in the score/.test(hr), "says plainly that these values are not part of the score");
assert.strictEqual(mr.sources.filter(x => x.label === "nasa.s.imerg" || x.label === "nasa.s.smap").length, 2);
assert.ok(mr.sources.filter(x => /imerg|smap/.test(x.label)).every(x => x.kind === "satellite_estimate" && x.through), "both are labelled satellite estimates with their data age");
assert.ok(/Late run/.test(hr) && /preliminary/.test(hr) && /not the root zone/.test(hr), "the preliminary-run and top-soil-only caveats are shown");
assert.ok(!hr.includes("values are not shown"), "the 'values not shown' notice is gone once real values are shown");
assert.ok(P.html(P.model(loc, ndvi, null, null), t, esc).includes("values are not shown"), "...and is still there when there are no recent values");
const noPass = JSON.parse(JSON.stringify(rec)); noPass.smap.latest = null; noPass.smap.valid_passes = 0;
assert.ok(P.html(P.model(loc, ndvi, null, noPass), t, esc).includes("no valid reading at this place in the last 30 days"), "an empty SMAP window is stated, never filled");
assert.ok(P.html(P.model(loc, ndvi, null, { status: "running" }), t, esc) === P.html(P.model(loc, ndvi), t, esc), "a job that is still running adds nothing");

// 7d. a still-running job that already has the rain shows the rain (and no soil moisture) instead of waiting for both
const partial = { status: "running", window: rec.window, imerg: rec.imerg }, hp = P.html(P.model(loc, ndvi, null, partial), t, esc);
assert.ok(hp.includes("6.6 mm in 30 days") && !hp.includes("Soil moisture (SMAP): latest"), "rain shown, soil moisture not invented while it is still being read");
assert.ok(hp.includes("values are not shown"), "the SMAP 'values not shown' notice stays until its real values arrive");

// 8. disabled without a backend URL; no credentials in the client
assert.strictEqual(P.enabled(), false);
global.window = undefined;
const src = fs.readFileSync(path.join(__dirname, "../app/nasa.js"), "utf8") + fs.readFileSync(path.join(__dirname, "../app/config.js"), "utf8");
for (const [why, re] of [["an auth header", /["']Authorization["']/i], ["a bearer token", /\bBearer\s/], ["a password", /\bpassw(or)?d\b/i], ["an Earthdata env var", /EARTHDATA_[A-Z]+/], ["the Earthdata login host", /urs\.earthdata\.nasa\.gov/i]])
  assert.ok(!re.test(src), "the client must not contain " + why);
assert.ok(/\bAuthorization\b|Bearer /.test("fetch(u,{headers:{'Authorization':'Bearer x'}})"), "the pattern list above really matches what it should catch");

// 9. soil / satellite: the browser goes first; the backend only after a delay or a failure; first success wins; failures are never hidden
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms)); P._delay(80);
  let backendCalls = 0; global.AGRISHIFT = { backendUrl: "http://backend.example" };
  const direct = (impl) => ({ available: () => true, soil: async () => impl(), ndvi: async () => impl(), status: async () => ({ from: "browser-status" }) });
  const directOk = (delay = 0) => direct(async () => { await wait(delay); return { from: "browser" }; });
  const directBad = () => direct(async () => { throw new Error("NetworkError"); });
  const backend = (impl) => { global.fetch = async () => { backendCalls++; return impl(); }; };
  const backendFast = () => backend(async () => ({ ok: true, json: async () => ({ from: "backend" }) }));
  const backendDown = () => backend(async () => { throw new Error("backend asleep"); });
  const reset = () => { P._reset(); backendCalls = 0; };

  // a) browser finishes before the delay: it wins and the backend is never asked (the small free server is spared)
  reset(); global.DirectData = directOk(); backendFast();
  assert.strictEqual((await P.fetchSoil(1, 2)).from, "browser"); await wait(150); assert.strictEqual(backendCalls, 0);
  // b) slow connection: the browser is still busy after the delay, so the backend is asked and answers first
  reset(); global.DirectData = directOk(600); backendFast();
  assert.strictEqual((await P.fetchSoil(1, 2)).from, "backend"); assert.strictEqual(backendCalls, 1);
  // c) browser cannot read the files (Firefox, blocked network): the backend is asked AT ONCE, and the browser route is not retried afterwards
  reset(); P._delay(5000); global.DirectData = directBad(); backendFast(); const t0 = Date.now();
  assert.strictEqual((await P.fetchNdvi(1, 2)).from, "backend"); assert.ok(Date.now() - t0 < 1000, "did not wait for the delay"); P._delay(80);
  const before = backendCalls; assert.strictEqual((await P.fetchSoil(1, 2)).from, "backend"); assert.strictEqual(backendCalls, before + 1, "goes straight to the backend; no wasted browser attempt");
  // d) browser fails and the backend is down: the error is reported
  reset(); global.DirectData = directBad(); backendDown(); await assert.rejects(() => P.fetchSoil(1, 2), /NetworkError|backend asleep/);
  // e) slow browser AND a failing backend: the browser's late answer still wins
  reset(); global.DirectData = directOk(300); backendDown(); assert.strictEqual((await P.fetchSoil(1, 2)).from, "browser");
  // f) no backend configured: browser only, its own error is reported
  reset(); delete global.AGRISHIFT; global.DirectData = directOk(); assert.strictEqual((await P.fetchSoil(1, 2)).from, "browser");
  reset(); global.DirectData = directBad(); await assert.rejects(() => P.fetchSoil(1, 2), /NetworkError/);
  // g) no browser engine: backend only
  reset(); global.AGRISHIFT = { backendUrl: "http://backend.example" }; delete global.DirectData; backendFast(); assert.strictEqual((await P.fetchSoil(1, 2)).from, "backend");
  // i) weather indicators: backend, falling back to the satellite freshness when it is asleep
  reset(); global.DirectData = directOk(); backendDown(); assert.strictEqual((await P.fetchLocation(1, 2)).from, "browser-status"); backendFast(); assert.strictEqual((await P.fetchLocation(1, 2)).from, "backend");
  // j) recent values: asked again until ready; token-less server and failures are told apart; never available without a backend
  P._poll(5); let asked = 0; global.AGRISHIFT = { backendUrl: "http://backend.example" };
  global.fetch = async () => ({ ok: true, json: async () => (++asked < 3 ? { status: "running" } : { status: "ready", from: "backend" }) });
  assert.strictEqual((await P.fetchRecent(1, 2)).from, "backend"); assert.strictEqual(asked, 3, "polled until ready");
  global.fetch = async () => ({ ok: true, json: async () => ({ status: "not_configured" }) });
  await assert.rejects(() => P.fetchRecent(1, 2), e => e.code === "not_configured");
  global.fetch = async () => ({ ok: true, json: async () => ({ status: "error", reason: "NASA said no" }) });
  await assert.rejects(() => P.fetchRecent(1, 2), /NASA said no/);
  delete global.AGRISHIFT; await assert.rejects(() => P.fetchRecent(1, 2), e => e.code === "no_backend");
  // k) partial results are handed to the page while the job is still running
  P._poll(5); global.AGRISHIFT = { backendUrl: "http://backend.example" }; const seen = []; let n2 = 0;
  global.fetch = async () => ({ ok: true, json: async () => (++n2 === 1 ? { status: "running" } : n2 === 2 ? { status: "running", imerg: { total_mm: 1 } } : { status: "ready", imerg: { total_mm: 1 }, smap: {} }) });
  await P.fetchRecent(1, 2, j => seen.push(Object.keys(j).filter(k => k === "imerg" || k === "smap").join("+")));
  assert.deepStrictEqual(seen, ["imerg"], "the page is told about the rain as soon as it exists");
  P._poll(3000);
  delete global.AGRISHIFT; delete global.fetch; delete global.DirectData; P._reset(); P._delay(12000);
  console.log("nasa panel tests passed");
})();
