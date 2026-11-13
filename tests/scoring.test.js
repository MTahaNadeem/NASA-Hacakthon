const assert = require("assert");
const S = require("../app/scoring.js");
const fs = require("fs"), path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/rotations.json")));
const load = id => JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/" + id + ".json")));
const eq = { water: 1/3, income: 1/3, soil: 1/3 };

// growing months wrap the year end
assert.deepStrictEqual(S.growingMonths(cfg.crops.wheat), [11, 12, 1, 2, 3, 4]);

// weights sum to 1 and respect sliders
let w = S.weightsFromSliders(eq, S.FACTORS.map(f => f.id));
assert(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9);
let wWater = S.weightsFromSliders({ water: 1, income: 0, soil: 0 }, S.FACTORS.map(f => f.id));
assert.strictEqual(wWater.water, 1); assert.strictEqual(wWater.heat, 0);
// all-zero sliders fall back to equal weights, never NaN
let w0 = S.weightsFromSliders({ water: 0, income: 0, soil: 0 }, S.FACTORS.map(f => f.id));
assert(Object.values(w0).every(v => Math.abs(v - 1/6) < 1e-9));

// every score is within 0..1, ranges are ordered, for all demo locations and rotation sets
for (const loc of JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/index.json")))) {
  const data = load(loc.id);
  assert(loc.rotation_ids.length >= 3, "need >=3 rotations");
  assert(loc.rotation_ids.includes(loc.current_rotation), "current rotation must be compared");
  const r = S.rankRotations(cfg, data, loc.rotation_ids, eq);
  assert.strictEqual(r.results.length, loc.rotation_ids.length);
  r.results.forEach(x => {
    assert(x.mean >= 0 && x.mean <= 1, loc.id + " mean in 0..1: " + x.mean);
    assert(x.low <= x.mean + 1e-9 && x.mean <= x.high + 1e-9, loc.id + " low<=mean<=high " + JSON.stringify([x.low, x.mean, x.high]));
    x.yearScores.forEach(v => assert(!isNaN(v) && v >= 0 && v <= 1));
  });
}

// a missing data source drops its factor and scoring still works
const d = JSON.parse(JSON.stringify(load("faisalabad"))); delete d.ndvi_clim; delete d.soil;
const r = S.rankRotations(cfg, d, ["wheat_fallow", "wheat_chickpea", "wheat_mustard"], eq);
assert(!r.availableFactors.includes("bare") && !r.availableFactors.includes("soc") && r.results.every(x => !isNaN(x.mean)));

// sliders change the ranking inputs: water-only vs soil-only weights give different means
const fb = load("faisalabad"), ids = ["wheat_fallow", "wheat_chickpea", "wheat_mustard"];
const a = S.rankRotations(cfg, fb, ids, { water: 1, income: 0, soil: 0 }), b = S.rankRotations(cfg, fb, ids, { water: 0, income: 0, soil: 1 });
assert.notDeepStrictEqual(a.results.map(x => x.mean), b.results.map(x => x.mean));

// overlap logic
assert.strictEqual(S.rangesOverlap({ low: 0, high: 1 }, { low: 2, high: 3 }), 0);
assert.strictEqual(S.rangesOverlap({ low: 0, high: 1 }, { low: 0, high: 1 }), 1);
console.log("scoring tests passed");

// ---- irrigation mode, water gap, confidence, scenarios ----
{
  const S2 = require("../app/scoring.js"), c2 = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/rotations.json")));
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/index.json")))[0];
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/" + d.id + ".json")));
  const ids = d.rotation_ids, base = { water: .5, income: .5, soil: .5 };
  // rain-fed: the water-saving slider no longer has any effect, and the water factor moves under income
  assert.strictEqual(S2.sliderOf({ id: "water", slider: "water" }, "rainfed"), "income");
  assert.strictEqual(S2.sliderOf({ id: "water", slider: "water" }, "irrigated"), "water");
  const m = (sl, irr) => S2.rankRotations(c2, data, ids, sl, { irrigation: irr }).results.map(x => x.id + ":" + x.mean.toFixed(6)).sort().join();
  assert.strictEqual(m({ ...base, water: 0 }, "rainfed"), m({ ...base, water: 1 }, "rainfed"), "water slider must be inert when rain-fed");
  assert.notStrictEqual(m({ ...base, water: 0 }, "irrigated"), m({ ...base, water: 1 }, "irrigated"), "water slider must work when irrigated");
  assert.strictEqual(m(base, "irrigated"), m(base, undefined), "unknown behaves like irrigated");
  const ws = S2.weightsFromSliders(base, S2.FACTORS.map(f => f.id), "rainfed"); assert(Math.abs(Object.values(ws).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // water gap: more rain -> smaller gap; a thirsty crop has a bigger gap than a light one
  const gap = (dd, id) => S2.irrigationNeed(c2.rotations[id], c2, dd);
  const wet = JSON.parse(JSON.stringify(data)); wet.climate.rain = wet.climate.rain.map(r => r.map(v => v * 5));
  ids.forEach(id => { assert(gap(data, id) >= 0 && gap(wet, id) <= gap(data, id), id); });
  assert(S2.irrigationNeed(c2.rotations.wheat_fallow, c2, wet) < S2.irrigationNeed(c2.rotations.wheat_fallow, c2, data));
  // confidence: never "high" with fewer than 3 data sources; tie / wide range / no soil lower it
  const few = { sources: { power: "NASA POWER", soilgrids: "x" }, soil: { ph: {} } };
  assert.notStrictEqual(S2.confidence({ low: .5, high: .55, noClearWinner: false }, few).level, "high");
  const many = { sources: { power: 1, soilgrids: 1, modis: 1, smap: 1 }, soil: { ph: {} } };
  assert.strictEqual(S2.confidence({ low: .5, high: .55, noClearWinner: false }, many).level, "high");
  assert.deepStrictEqual(S2.confidence({ low: .1, high: .9, noClearWinner: true }, { sources: {} }).reasons.sort(), ["conf.r.fewdata", "conf.r.nosoil", "conf.r.tie", "conf.r.wide"]);
  assert.strictEqual(S2.confidence({ low: .1, high: .9, noClearWinner: true }, { sources: {} }).level, "low");
  // scenarios: rain scales; warming swaps in the stored threshold counts; missing counts degrade safely
  const sc = S2.applyScenario(data, -20, 0); assert(Math.abs(sc.climate.rain[0][6] - data.climate.rain[0][6] * .8) < 1e-9); assert.strictEqual(S2.applyScenario(data, 0, 0), data);
  const t0 = JSON.parse(JSON.stringify(data)); t0.climate.heat_by_dt = { "0": t0.climate.heat_days, "2": t0.climate.heat_days.map(r => r.map(v => v + 3)) }; t0.climate.frost_by_dt = { "0": t0.climate.frost_days, "2": t0.climate.frost_days.map(r => r.map(() => 0)) };
  const w2 = S2.applyScenario(t0, 0, 2); assert.strictEqual(w2.climate.heat_days[0][0], t0.climate.heat_days[0][0] + 3); assert.strictEqual(w2.climate.frost_days[0][0], 0);
  assert.strictEqual(S2.applyScenario(t0, 0, 3), t0, "no counts for +3 -> unchanged");
  assert.strictEqual(S2.applyScenario(data, 0, 2), data, "data without threshold counts -> unchanged"); assert.strictEqual(S2.hasTemperatureScenario(data), !!(data.climate.heat_by_dt));
  // more heat never improves a heat-sensitive crop's heat score
  const hot = S2.rankRotations(c2, S2.applyScenario(t0, 0, 2), ids, base).results, cool = S2.rankRotations(c2, t0, ids, base).results;
  assert(hot.reduce((a, x) => a + x.mean, 0) <= cool.reduce((a, x) => a + x.mean, 0) + 1e-9);
  console.log("irrigation/confidence/scenario tests passed");
}
