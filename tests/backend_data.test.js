// Backend soil / MODIS data feeding the scoring engine. Inputs are REAL API responses captured 2026-11-14 (tests/fixtures).
const assert = require("assert"), fs = require("fs"), path = require("path");
const L = require("../app/live.js"), S = require("../app/scoring.js");
const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8"));
const base = () => JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/faisalabad.json"), "utf8"));   // real POWER-only data

// 1. before: weather only, so three factors; after: soil + MODIS add three more
let d = base(); delete d.soil; delete d.ndvi_clim;
assert.deepStrictEqual(S.availableFactors(d).sort(), ["heat", "rain", "water"]);
const soil = fx("api_soil_ames.json"), lahore = fx("api_ndvi36_lahore.json");
assert.strictEqual(L.applySoil(d, soil), true);
assert.strictEqual(d.soil.ph.mean, 6.4); assert.ok(d.soil.ph.q05 < d.soil.ph.mean && d.soil.ph.mean < d.soil.ph.q95, "uncertainty range kept");
assert.ok(d.gaps.some(g => /about 2 km from the pin/.test(g)), "the 2 km search distance is disclosed");
assert.ok(d.sources.soilgrids);
assert.strictEqual(L.applyNdvi(d, lahore), true);
assert.strictEqual(d.ndvi_clim.length, 12);
assert.deepStrictEqual(S.availableFactors(d).sort(), ["bare", "fit", "heat", "rain", "soc", "water"]);
assert.ok(d.gaps.some(g => /last three years/.test(g)), "the short MODIS record is disclosed");
assert.ok(!d.gaps.some(g => /^Live location: MODIS NDVI is not used/.test(g)), "the obsolete 'not used' gap is removed");

// 2. existing data is never overwritten
const keep = base(); const before = JSON.stringify(keep.soil || null);
keep.soil = { ph: { q05: 1, mean: 2, q95: 3 }, clay: { q05: 1, mean: 2, q95: 3 } };
assert.strictEqual(L.applySoil(keep, soil), false); assert.strictEqual(keep.soil.ph.mean, 2);
const withN = base(); withN.ndvi_clim = Array(12).fill(0.5); assert.strictEqual(L.applyNdvi(withN, lahore), false); assert.strictEqual(withN.ndvi_clim[0], 0.5);

// 3. too little satellite data is refused rather than scored
const thin = JSON.parse(JSON.stringify(lahore)); thin.ndvi.monthly_mean = thin.ndvi.monthly_mean.map((v, i) => i < 4 ? v : null);
const d3 = base(); delete d3.ndvi_clim; assert.strictEqual(L.applyNdvi(d3, thin), false); assert.strictEqual(d3.ndvi_clim, undefined);
assert.strictEqual(L.applyNdvi(base(), { ndvi: { monthly_mean: [1, 2, 3] } }), false);       // wrong length
assert.strictEqual(L.applySoil(base(), { soil: {} }), false);                                // empty soil
assert.strictEqual(L.applySoil(base(), null), false); assert.strictEqual(L.applyNdvi(base(), null), false);

// 4. cloudy places keep their gaps: months that had too few composites are blank, not invented
const nairobi = fx("api_ndvi36_nairobi.json").ndvi;
assert.strictEqual(nairobi.monthly_mean.length, 12);
assert.ok(nairobi.valid_count < nairobi.total_count, "Nairobi really is cloudy: some composites unusable");

// 5. ranking really changes once the extra factors exist (the scoring uses them, they are not decoration)
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/rotations.json"), "utf8"));
const ids = cfg.presets.south_asia_wheat.ids, sl = { water: .5, income: .5, soil: .5 };
const only = base(); delete only.soil; delete only.ndvi_clim; delete only.sources.soilgrids;
const full = base(); delete full.ndvi_clim; L.applySoil(full, soil); L.applyNdvi(full, lahore);
const r1 = S.rankRotations(cfg, only, ids, sl, { irrigation: "u" }).results, r2 = S.rankRotations(cfg, full, ids, sl, { irrigation: "u" }).results;
assert.notDeepStrictEqual(r1.map(r => r.mean), r2.map(r => r.mean), "soil + MODIS change the scores");
const rot = cfg.rotations[ids[0]], fb1 = S.factorBreakdown(rot, cfg, only), fb2 = S.factorBreakdown(rot, cfg, full);
["fit", "soc", "bare"].forEach(f => { assert.strictEqual(fb1[f], null, f + " has no score without the data"); assert.ok(fb2[f] != null && fb2[f] >= 0 && fb2[f] <= 1, f + " is scored from the real data"); });

// 6. backend soil is tried first; the slow SoilGrids API is only a fallback
(async () => {
  const days = {}; for (let y = 2004; y <= 2023; y++) for (const m of ["01", "07"]) days[`${y}${m}10`] = 1;
  const power = { properties: { parameter: { PRECTOTCORR: days, T2M: days, T2M_MAX: days, T2M_MIN: days } } };
  const restSoil = { properties: { layers: ["phh2o", "soc", "sand", "silt", "clay"].map(n => ({ name: n, unit_measure: { d_factor: 10 }, depths: [{ label: "0-5cm", values: { "Q0.05": 70, mean: 75, "Q0.95": 80 } }] })) } };
  const run = async (soilSource) => {
    const urls = [];
    global.fetch = async (url) => { urls.push(url); if (/power\.larc/.test(url)) return { ok: true, json: async () => power }; if (/rest\.isric/.test(url)) return { ok: true, json: async () => restSoil }; throw new Error("unexpected " + url); };
    const d = await L.fetchLocation(10, 10, () => {}, soilSource ? { soilSource } : {});
    await d.soilPromise; return { d, urls };
  };
  const ok = await run(async () => ({ soil: soil.soil, km: 2 }));
  assert.strictEqual(ok.d.soil.ph.mean, 6.4); assert.ok(!ok.urls.some(u => /rest\.isric/.test(u)), "slow REST API NOT called when the backend answers");
  const fail = await run(async () => { throw new Error("backend down"); });
  assert.ok(fail.urls.some(u => /rest\.isric/.test(u)) && fail.d.soil && fail.d.soil.ph, "falls back to the REST API when the backend fails");
  const empty = await run(async () => ({ soil: {}, km: 0 }));
  assert.ok(empty.urls.some(u => /rest\.isric/.test(u)), "falls back when the backend has no soil");
  const none = await run(null); assert.ok(none.urls.some(u => /rest\.isric/.test(u)), "no backend configured: behaves exactly as before");
  console.log("backend data tests passed");
})().catch(e => { console.error(e); process.exit(1); });
