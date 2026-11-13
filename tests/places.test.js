const assert = require("assert"), fs = require("fs"), path = require("path");
const places = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/places.json"), "utf8"));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/rotations.json"), "utf8"));
const pipe = JSON.parse(fs.readFileSync(path.join(__dirname, "../pipeline/locations.json"), "utf8")).locations;
const langs = require("../app/i18n.js").LANGS.map(l => l.code);
const ids = places.map(p => p.id);
assert.strictEqual(new Set(ids).size, ids.length, "duplicate place ids");
assert.strictEqual(places.filter(p => p.hero).length, 1, "exactly one hero place");
for (const need of ["lahore", "islamabad", "rawalpindi"]) assert(ids.includes(need), need + " must be a quick pick");
assert(!ids.includes("faisalabad"), "faisalabad was removed from quick picks");
assert(places.some(p => p.lat < 0), "needs a southern-hemisphere example");
assert(places.filter(p => !/Pakistan/.test(p.names.en)).length >= 4, "needs several foreign cities");
for (const p of places) {
  assert(p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180, p.id + " coords");
  assert(p.names && p.names.en, p.id + " needs an English name");
  Object.keys(p.names).forEach(l => assert(langs.includes(l), p.id + " has a name for unknown language " + l));
  assert(cfg.presets[p.preset], p.id + " unknown preset " + p.preset);
  assert(pipe.some(l => l.id === p.id), p.id + " missing from pipeline/locations.json (cannot be cached)");
}
console.log("places tests passed:", ids.length, "quick picks");
