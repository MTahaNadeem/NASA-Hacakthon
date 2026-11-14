const assert = require("assert");
const L = require("../app/live.js");
// minimal POWER payload (fixture values are invented, test-only)
const days = {}; for (let y = 2004; y <= 2023; y++) for (const m of ["01", "07"]) for (const d of ["10", "11"]) days[`${y}${m}${d}`] = 1;
const p = { properties: { parameter: { PRECTOTCORR: { ...days, "20040110": 60 }, T2M: days, T2M_MAX: { ...days, "20040710": 40, "20040711": 34 }, T2M_MIN: { ...days, "20040110": -2 } } } };
const c = L.parsePower(p);
assert.strictEqual(c.rain.length, 20); assert.strictEqual(c.extreme_days[0][0], 1);
assert.strictEqual(c.heat_days[0][6], 1);
assert.strictEqual(c.heat_by_dt["0"][0][6], 1); assert.strictEqual(c.heat_by_dt["1"][0][6], 2); assert.deepStrictEqual(c.heat_by_dt["0"], c.heat_days); assert.strictEqual(c.frost_days[0][0], 1);
// ocean / no data is rejected, not scored
const bad = { properties: { parameter: { PRECTOTCORR: Object.fromEntries(Object.keys(days).map(k => [k, -999])), T2M: days, T2M_MAX: days, T2M_MIN: days } } };
assert.throws(() => L.parsePower(bad), /NO_LAND/);
// soil percentiles and d_factor
const s = L.parseSoil({ properties: { layers: [{ name: "phh2o", unit_measure: { d_factor: 10 }, depths: [{ label: "0-5cm", values: { "Q0.05": 70, mean: 75, "Q0.95": 80 } }] }, { name: "other", depths: [] }] } });
assert.deepStrictEqual(s, { ph: { q05: 7, mean: 7.5, q95: 8 } });
// preset suggestion: cold -> corn, hot+some frost -> wheat, frost-free -> tropical
const mk = (frost, heat) => ({ climate: { frost_days: [[frost, ...Array(11).fill(0)]], heat_days: [[heat, ...Array(11).fill(0)]] } });
assert.strictEqual(L.suggestPreset(mk(60, 0)), "temperate_corn");
assert.strictEqual(L.suggestPreset(mk(5, 50)), "south_asia_wheat");
assert.strictEqual(L.suggestPreset(mk(0, 5)), "tropical_maize");
// subtropical wheat belt: real POWER data for Faisalabad (Punjab) is hot in summer, has no hot winter days, and little frost
const fs = require("fs"), path = require("path"), fais = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/faisalabad.json"), "utf8"));
const ames = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/ames_iowa.json"), "utf8"));
assert.strictEqual(L.suggestPreset(fais), "south_asia_wheat");
assert.strictEqual(L.suggestPreset(ames), "temperate_corn");
const hot = (lat) => ({ lat, climate: { frost_days: [Array(12).fill(0)], heat_days: [[0, 0, 0, 10, 20, 20, 15, 10, 5, 0, 0, 0]] } });
assert.strictEqual(L.suggestPreset(hot(30)), "south_asia_wheat");          // hot summer, cool winter, subtropical latitude
assert.strictEqual(L.suggestPreset(hot(-22)), "tropical_maize");           // same climate in the southern hemisphere is not the wheat belt
assert.strictEqual(L.suggestPreset(hot(12)), "tropical_maize");            // too close to the equator
const hotWinter = hot(30); hotWinter.climate.heat_days[0][0] = 5; assert.strictEqual(L.suggestPreset(hotWinter), "tropical_maize");   // hot all year
assert.strictEqual(L.suggestPreset({ climate: { frost_days: [Array(12).fill(0)], heat_days: [[0, 0, 0, 10, 20, 20, 15, 10, 5, 0, 0, 0]] } }), "tropical_maize");   // no latitude: old behaviour
console.log("live tests passed");

// ---- progressive loading: weather must not wait for slow soil ----
(async () => {
  const L2 = require("../app/live.js"), a2 = require("assert");
  const days2 = {}; for (let y = 2004; y <= 2023; y++) for (const m of ["01", "07"]) days2[`${y}${m}10`] = 1;
  const power = { properties: { parameter: { PRECTOTCORR: days2, T2M: days2, T2M_MAX: days2, T2M_MIN: days2 } } };
  const soilOk = { properties: { layers: ["phh2o", "soc", "sand", "silt", "clay"].map(n => ({ name: n, unit_measure: { d_factor: 10 }, depths: [{ label: "0-5cm", values: { "Q0.05": 70, mean: 75, "Q0.95": 80 } }] })) } };
  const run = async (soilBehaviour) => {
    global.fetch = async (url) => {
      if (/power\.larc/.test(url)) return { ok: true, json: async () => power };
      await new Promise(r => setTimeout(r, 150));                     // slow soil server
      if (soilBehaviour === "fail") throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => soilOk };
    };
    const t0 = Date.now(), d = await L2.fetchLocation(31.55, 74.34, () => {}), tWeather = Date.now() - t0;
    a2(tWeather < 120, "weather result must arrive before the slow soil does (" + tWeather + " ms)");
    a2.strictEqual(d.soilDone, false); a2(!d.soil, "no soil yet"); a2(d.sources.power && !d.sources.soilgrids);
    const same = await d.soilPromise; a2.strictEqual(same, d, "soilPromise resolves with the same object"); a2.strictEqual(d.soilDone, true);
    return d;
  };
  const ok = await run("ok"); a2(ok.soil && ok.soil.ph && ok.sources.soilgrids, "soil is added when it arrives");
  const bad = await run("fail"); a2(!bad.soil && bad.gaps[0].startsWith("SoilGrids unavailable"), "a soil failure is recorded as a gap, never thrown");
  console.log("progressive-loading tests passed");
})().catch(e => { console.error(e); process.exit(1); });

// ---- recent SMAP / IMERG feed the score as a small, capped nudge ----
(() => {
  const a = require("assert"), Sc = require("../app/scoring.js"), Lv = require("../app/live.js");
  const clone = o => JSON.parse(JSON.stringify(o));
  const mk = () => ({ years: [2020], climate: { rain: [[10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]] }, sources: { power: "NASA POWER" }, gaps: ["Live location: SMAP soil moisture is not used, so ...", "Live location: GPM IMERG is not used, so ..."] });
  const crop = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "../app/rotations.json"))).crops.wheat;
  const base = Sc.effectiveSupply(crop, mk(), 0);
  const loc = { indicators: { recent_vs_normal: { rain_mm: 60, window_start: "2026-10-01", window_end: "2026-10-30" } } };       // 2 mm/day
  const rec = (mm, mean, passes) => ({ window: { days: 30 }, imerg: { valid_days: 30, total_mm: mm }, smap: { valid_passes: passes, mean } });
  // no recent data: score input unchanged
  a.strictEqual(Sc.effectiveSupply(crop, Object.assign(mk(), { recent_adj: {} }), 0), base);
  // wetter soil than neutral raises supply, drier lowers it, both within half the full SMAP range (+-7.5%)
  const wet = mk(), dry = mk(); Lv.applyRecent(wet, rec(60, 0.45, 8), loc); Lv.applyRecent(dry, rec(60, 0.05, 8), loc);
  a(Sc.effectiveSupply(crop, wet, 0) > base && Sc.effectiveSupply(crop, dry, 0) < base, "SMAP moves the water supply the right way");
  a(Sc.effectiveSupply(crop, wet, 0) <= base * 1.0751 && Sc.effectiveSupply(crop, dry, 0) >= base * 0.9249, "SMAP nudge is capped at 7.5%");
  // IMERG heavier than POWER raises supply, but never by more than 7.5%
  const rainy = mk(); Lv.applyRecent(rainy, rec(600, null, 0), loc);
  a(rainy.recent_adj.imerg_ratio > 1.5 && rainy.sources.imerg, "IMERG used"); a(Sc.effectiveSupply(crop, rainy, 0) <= base * 1.0751 && Sc.effectiveSupply(crop, rainy, 0) > base);
  // a few SMAP passes are not enough evidence; IMERG with too few days is ignored; both leave the old gap notes in place
  const thin = mk(); a.strictEqual(Lv.applyRecent(thin, { window: { days: 30 }, imerg: { valid_days: 4, total_mm: 9 }, smap: { valid_passes: 2, mean: 0.4 } }, loc), false);
  a(!thin.sources.smap && !thin.sources.imerg && thin.gaps.length === 2, "thin evidence is not used and the gap notes stay");
  // used sources are listed and the stale 'not used' gap notes are replaced by an honest capped-adjustment note
  const both = mk(); a.strictEqual(Lv.applyRecent(both, rec(60, 0.3, 8), loc), true);
  a(both.sources.smap && both.sources.imerg && both.gaps.length === 1 && /nudge the water supply by at most 7.5%/.test(both.gaps[0]), JSON.stringify(both.gaps));
  a.strictEqual(Lv.applyRecent(both, rec(60, 0.3, 8), loc), false, "same input again changes nothing, so no needless re-render");
  // places with a bundled SMAP climatology keep their own full-weight adjustment
  const clim = mk(); clim.smap_clim = Array(12).fill(0.45); Lv.applyRecent(clim, rec(60, 0.05, 8), loc);
  a(Sc.effectiveSupply(crop, clim, 0) > base * 1.08, "bundled climatology wins over the 30-day reading");
  // survives the scenario clone
  a.strictEqual(Sc.applyScenario(both, 10, 0).recent_adj.imerg_ratio, both.recent_adj.imerg_ratio);
  console.log("recent SMAP/IMERG scoring tests passed");
})();
