// Pure parts of the browser data engine, checked against REAL captured responses (STAC search, SoilGrids pixel values, PROJ).
const assert = require("assert"), fs = require("fs"), path = require("path");
global.IGH = require("../app/igh.js"); const D = require("../app/direct.js"), T = D._t;
const stac = JSON.parse(fs.readFileSync(path.join(__dirname, "../backend/tests/fixtures/stac_modis13q1_lahore.json"), "utf8"));

// STAC items: newest first, allowed host only
const items = T.parseItems(stac); assert.ok(items.length > 0 && items[0].start >= items[items.length - 1].start);
assert.ok(items.every(i => /^https:\/\/modiseuwest\.blob\.core\.windows\.net\//.test(i.ndvi_href)) && /pixel_reliability/.test(items[0].reliability_href));
const evil = JSON.parse(JSON.stringify(stac)); evil.features[0].assets["250m_16_days_NDVI"].href = "https://evil.example.com/x.tif";
assert.strictEqual(T.parseItems(evil).length, items.length - 1, "a file on another host is ignored");
const sneaky = JSON.parse(JSON.stringify(stac)); sneaky.features[0].assets["250m_16_days_NDVI"].href = "https://modiseuwest.blob.core.windows.net.evil.com/x.tif";
assert.strictEqual(T.parseItems(sneaky).length, items.length - 1, "look-alike host is ignored");

// NDVI quality rules (same values as backend/tests)
assert.deepStrictEqual(T.classify(5315, 0), { ndvi: 0.5315, reliability: 0, reason: null });   // raw 5315 was read live for Lahore farmland
assert.strictEqual(T.classify(5315, 3).ndvi, null); assert.strictEqual(T.classify(-3000, 0).ndvi, null); assert.strictEqual(T.classify(12000, 0).ndvi, null);

// monthly climatology: mid-date month, >= 2 composites per month
const m = T.monthlyNdvi([{ start: "2025-12-25", ndvi: 0.4 }, { start: "2026-01-02", ndvi: 0.6 }, { start: "2026-01-10", ndvi: 0.5 }, { start: "2026-01-26", ndvi: 0.9 }, { start: "2026-03-01", ndvi: null }]);
assert.strictEqual(m.mean[0], 0.5); assert.strictEqual(m.count[0], 3); assert.strictEqual(m.mean[1], null, "one composite is too thin to define a month"); assert.strictEqual(m.mean[2], null);

// soil: depth weighting, units, and a property with a missing layer is left out
const raw = {}; ["ph", "soc", "sand", "silt", "clay"].forEach(p => ["0-5cm", "5-15cm", "15-30cm"].forEach(d => ["q05", "mean", "q95"].forEach(s => raw[`${p}|${d}|${s}`] = 100)));
raw["ph|0-5cm|mean"] = 60; raw["ph|5-15cm|mean"] = 70; raw["ph|15-30cm|mean"] = 80;
let soil = T.combine(raw); assert.strictEqual(soil.ph.mean, Math.round((5 * 6 + 10 * 7 + 15 * 8) / 30 * 100) / 100); assert.strictEqual(soil.clay.mean, 10);
raw["soc|5-15cm|q05"] = null; soil = T.combine(raw); assert.ok(!("soc" in soil) && "ph" in soil);

// the same pixels the backend and the real VRT gave
assert.deepStrictEqual(T.pixel(38.5, -98.0), [35968, 16300]); assert.deepStrictEqual(T.pixel(31.45, 74.10), [109909, 19440]);
// MODIS sinusoidal: equator/prime meridian is the origin, longitude shrinks with latitude
assert.deepStrictEqual(T.sinu(0, 0), [0, 0]); assert.ok(T.sinu(60, 10)[0] < T.sinu(0, 10)[0] * 0.51);
assert.strictEqual(D.available(), false);   // not in a browser
console.log("direct engine tests passed");
