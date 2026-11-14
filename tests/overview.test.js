const assert = require("assert");
const O = require("../app/overview.js");
const fs = require("fs"), path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/rotations.json")));
const d = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/ames_iowa.json")));
const top = { id: Object.keys(cfg.rotations)[1], mean: 0.642, low: 0.5, high: 0.78 };
const m = O.model(d, top, cfg, { period: "year", nowMonth: 10 });
assert.strictEqual(m.score, 64); assert.strictEqual(m.low, 50); assert.strictEqual(m.high, 78);
assert.ok(m.plan.length >= 1 && m.plan.every(c => cfg.crops[c]), "plan holds real crop ids from the rotation");
// annual rain is the sum of the 12 monthly means of the real record, and equals the mean of yearly totals
const yearly = d.climate.rain.map(r => r.reduce((a, b) => a + (b || 0), 0)), meanYearly = yearly.reduce((a, b) => a + b, 0) / yearly.length;
assert.ok(Math.abs(m.rain - meanYearly) < 1, "annual rain matches the record " + m.rain + " vs " + meanYearly);
assert.ok(m.temp > -30 && m.temp < 45, "temperature is in a sane range: " + m.temp);
// next six months from November wraps over the year end and uses only those months
const six = O.model(d, top, cfg, { period: "6m", nowMonth: 10 }), rm = O.monthly(d.climate.rain);
assert.deepStrictEqual(O.monthsFor("6m", 10), [10, 11, 0, 1, 2, 3]);
assert.ok(Math.abs(six.rain - [10, 11, 0, 1, 2, 3].reduce((s, i) => s + rm[i], 0)) < 1e-9);
assert.ok(six.rain < m.rain);
// soil moisture: climatology when the place has one, else the recent SMAP mean, else nothing (never invented)
assert.strictEqual(m.moist.source, "climatology");
const noClim = Object.assign({}, d); delete noClim.smap_clim;
assert.strictEqual(O.model(noClim, top, cfg, { recentSmap: 0.31 }).moist.source, "recent");
assert.ok(Math.abs(O.model(noClim, top, cfg, { recentSmap: 0.31 }).moist.pct - 31) < 1e-9);
assert.strictEqual(O.model(noClim, top, cfg, {}).moist, null);
// missing temperature series gives null, not zero
const noT = JSON.parse(JSON.stringify(d)); delete noT.climate.tmean; assert.strictEqual(O.model(noT, top, cfg, {}).temp, null);
assert.strictEqual(O.model(null, top, cfg, {}), null);
// chart: one path per series, twelve month labels, escaped text
const svg = O.trendSvg(m.trend, "JFMAMJJASOND".split(""), k => k, s => String(s));
assert.strictEqual((svg.match(/<path /g) || []).length, 2); assert.strictEqual((svg.match(/text-anchor='middle'/g) || []).length, 12);
assert.strictEqual(O.trendSvg({ temp: null, rain: [] }, [], k => k, s => s), "");
assert.strictEqual(O.iconFor("wheat"), "cereal"); assert.strictEqual(O.iconFor("corn"), "corn"); assert.strictEqual(O.iconFor("soy"), "bean"); assert.strictEqual(O.iconFor("mustard"), "leaf");
console.log("overview tests passed");
