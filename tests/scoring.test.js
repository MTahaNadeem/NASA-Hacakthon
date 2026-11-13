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
