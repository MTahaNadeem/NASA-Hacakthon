// Integrity of the crop rules and their sources: every claim must point at a real, correctly labelled source.
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/rotations.json"), "utf8"));
const places = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/places.json"), "utf8"));
const pipe = JSON.parse(fs.readFileSync(path.join(__dirname, "../pipeline/locations.json"), "utf8")).locations;
const I18N = require("../app/i18n.js"); vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/i18n/en.js"), "utf8"), { I18N }); const en = I18N._dicts.en;
const STATUS = ["sourced", "partial", "team"], TYPES = new Set(Object.values(cfg.crops).map(c => c.type));
const isMonth = m => Number.isInteger(m) && m >= 1 && m <= 12;

for (const [id, s] of Object.entries(cfg.sources)) { assert(/^https:\/\//.test(s.url) && s.title && typeof s.read === "boolean", "source " + id); }
for (const [id, c] of Object.entries(cfg.crops)) {
  assert(isMonth(c.sow) && isMonth(c.harvest), id + " template months");
  ["heat_months", "frost_months", "rain_months"].forEach(f => c[f].forEach(m => assert(isMonth(m), id + " " + f)));
  assert(c.ph[0] < c.ph[1] && c.clay[0] < c.clay[1], id + " ranges"); assert(c.water_mm > 0, id + " water");
  assert("crop." + id in en && ("ben." + c.type) in en, id + " needs translations (crop name, benefit text)");
  const w = c.water; assert(w && STATUS.includes(w.status), id + " water status");
  w.ids.forEach(s => assert(cfg.sources[s], id + " water source " + s));
  if (w.status === "sourced") {
    assert(w.ids.some(s => cfg.sources[s].read), id + ": 'sourced' water needs a source we actually read");
    assert(w.range && w.range[0] < w.range[1], id + " range"); assert.strictEqual(c.water_mm, Math.round((w.range[0] + w.range[1]) / 2), id + ": water_mm must be the midpoint of the cited range");
  } else assert(!w.range && !w.ids.length, id + ": team estimate must not cite a range or source");
  for (const [r, cal] of Object.entries(c.calendars || {})) {
    assert(cfg.regions[r], id + " calendar for unknown region " + r); assert(isMonth(cal.sow) && isMonth(cal.harvest), id + "/" + r + " months");
    assert(STATUS.includes(cal.status) && cal.ids.length, id + "/" + r + " status and sources"); cal.ids.forEach(s => assert(cfg.sources[s], id + "/" + r + " source " + s));
    if (cal.status === "sourced") assert(cal.ids.some(s => cfg.sources[s].read), id + "/" + r + ": 'sourced' needs a source we actually read");
  }
}
for (const [r, v] of Object.entries(cfg.regions)) { assert(("region." + r) in en, "region name " + r); assert(v.box[0] < v.box[2] && v.box[1] < v.box[3]); }
assert("region.generic" in en);
for (const [id, r] of Object.entries(cfg.rotations)) r.cycle.forEach(p => { assert(p.length >= 1 && p.length <= 2, id); p.forEach(c => assert(cfg.crops[c], id + " crop " + c)); });
for (const [k, p] of Object.entries(cfg.presets)) { p.ids.forEach(i => assert(cfg.rotations[i], k + " " + i)); assert(p.ids.includes(p.current) && p.ids.length >= 3, k); }
pipe.forEach(l => l.rotation_ids.forEach(i => assert(cfg.rotations[i], l.id + " rotation " + i)));
["rice_wheat", "cotton_wheat", "sugarcane_only"].forEach(i => assert(cfg.rotations[i] && cfg.presets.south_asia_wheat.ids.includes(i), i + " must be offered for Punjab"));
// region detection (same box test as app.js)
const region = (lat, lon) => { for (const [k, v] of Object.entries(cfg.regions)) { const b = v.box; if (lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]) return k; } return "generic"; };
const want = { lahore: "pk_punjab", islamabad: "pk_punjab", rawalpindi: "pk_punjab", faisalabad: "pk_punjab", ames_iowa: "us_iowa", ludhiana: "generic", nairobi: "generic", dhaka: "generic", londrina: "generic", toowoomba: "generic" };
pipe.forEach(l => assert.strictEqual(region(l.lat, l.lon), want[l.id], l.id + " region"));
// every Punjab crop with a sourced calendar must really be one we read; headline wheat and Iowa crops are fully sourced
assert.strictEqual(cfg.crops.wheat.calendars.pk_punjab.status, "sourced"); ["corn", "soy", "oats"].forEach(c => assert.strictEqual(cfg.crops[c].calendars.us_iowa.status, "sourced"));
console.log(`crops tests passed: ${Object.keys(cfg.crops).length} crops, ${Object.keys(cfg.sources).length} sources, ${Object.keys(cfg.rotations).length} rotations, ${TYPES.size} crop types`);
