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
