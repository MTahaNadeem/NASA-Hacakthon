const assert = require("assert");
const L = require("../app/live.js");
// minimal POWER payload (fixture values are invented, test-only)
const days = {}; for (let y = 2004; y <= 2023; y++) for (const m of ["01", "07"]) for (const d of ["10", "11"]) days[`${y}${m}${d}`] = 1;
const p = { properties: { parameter: { PRECTOTCORR: { ...days, "20040110": 60 }, T2M: days, T2M_MAX: { ...days, "20040710": 40 }, T2M_MIN: { ...days, "20040110": -2 } } } };
const c = L.parsePower(p);
assert.strictEqual(c.rain.length, 20); assert.strictEqual(c.extreme_days[0][0], 1);
assert.strictEqual(c.heat_days[0][6], 1); assert.strictEqual(c.frost_days[0][0], 1);
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
console.log("live tests passed");
