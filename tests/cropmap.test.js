// Crop map logic, checked against REAL polygons (USDA Cropland Data Layer near Ames, ESA WorldCover near Lahore), captured 2026-11-14.
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm");
const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8"));
const AMES = fx("crops_ames_cdl2021.json"), LAHORE = fx("crops_lahore_worldcover2021.json");
const en = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/i18n/en.js"), "utf8"), { I18N: { add: (c, d) => Object.assign(en, d) } });
global.I18N = { t: (k, p) => { if (!(k in en)) throw new Error("missing key " + k); return p ? en[k].replace(/\{(\w+)\}/g, (m, x) => p[x] != null ? p[x] : m) : en[k]; } };
const C = require("../app/cropmap.js");

// 1. colours: the dataset's own colour wins, and the legend and the polygons use the SAME function
const lm = C.legendModel(AMES.features);
assert.ok(lm.length >= 5 && lm.every((e, i, a) => i === 0 || a[i - 1].area >= e.area), "legend lists every crop in the data, largest first");
const corn = lm.find(e => e.crop === "Corn"), soy = lm.find(e => e.crop === "Soybeans");
assert.strictEqual(corn.color, "#ffd200"); assert.strictEqual(soy.color, "#256f00");          // USDA's published colours
AMES.features.forEach(f => assert.strictEqual(C.colorFor(f.properties.crop, f.properties.color), lm.find(e => e.crop === f.properties.crop).color, "polygon colour == legend colour"));
const total = AMES.features.reduce((a, f) => a + f.properties.area_ha, 0), legendTotal = lm.reduce((a, e) => a + e.area, 0);
assert.ok(Math.abs(total - legendTotal) < 1e-6, "the legend's areas add up to the map's area");

// 2. a dynamic palette: crops with no official colour get stable, DISTINCT colours (20 made-up NAMES, used only to test the palette)
C._reset(); const names = Array.from({ length: 20 }, (_, i) => "Test crop " + i), cols = names.map(n => C.colorFor(n));
assert.strictEqual(new Set(cols).size, 20, "20 crops, 20 different colours");
const again = names.map(n => C.colorFor(n)); assert.deepStrictEqual(again, cols, "stable within a session");
assert.ok(cols.every(c => /^#[0-9a-f]{6}$/.test(c)));
assert.strictEqual(C.colorFor("Cropland (crop type not identified)"), "#d4a017");

// 3. filters: select one, select several, hide, show all, clear
const st = () => ({ hidden: {}, selected: {}, search: "" });
let s = st(); assert.ok(lm.every(e => C.isVisible(e.crop, s)), "everything visible at the start");
C.toggleSelected(s, "Corn"); assert.ok(C.isVisible("Corn", s) && !C.isVisible("Soybeans", s), "selecting a crop shows only that crop");
C.toggleSelected(s, "Soybeans"); assert.ok(C.isVisible("Corn", s) && C.isVisible("Soybeans", s) && !C.isVisible("Oats", s), "several crops can be selected at once");
C.toggleSelected(s, "Corn"); C.toggleSelected(s, "Soybeans"); assert.ok(C.isVisible("Oats", s), "deselecting everything shows everything again");
C.toggleHidden(s, "Oats"); assert.ok(!C.isVisible("Oats", s) && C.isVisible("Corn", s), "a crop can be hidden on its own");
C.toggleHidden(s, "Oats"); assert.ok(C.isVisible("Oats", s), "...and shown again");
C.toggleSelected(s, "Corn"); C.toggleHidden(s, "Corn"); assert.ok(!C.isVisible("Corn", s), "hiding wins over selecting");
s.search = "soy"; C.showAll(s); assert.ok(lm.every(e => C.isVisible(e.crop, s)) && s.search === "soy", "Show All crops: everything visible, search kept");
C.toggleHidden(s, "Rye"); C.toggleSelected(s, "Corn"); C.clearFilters(s); assert.deepStrictEqual(s, st(), "Clear Filters resets selection, hiding and search");
assert.ok(C.matchSearch("Winter Wheat", "wheat") && C.matchSearch("Winter Wheat", "  WHEAT ") && !C.matchSearch("Corn", "rice") && C.matchSearch("Corn", ""), "search is case-insensitive and ignores spaces");

// 4. the legend follows the data: a newly loaded crop appears with no code change
const extra = JSON.parse(JSON.stringify(AMES.features.slice(0, 1))); extra[0].properties.crop = "Newly Classified Crop"; extra[0].properties.color = null;
assert.ok(C.legendModel(AMES.features.concat(extra)).some(e => e.crop === "Newly Classified Crop"));

// 5. 0.04 degree cells: stable keys (so views hit the cache), nearest first, correct URL
const cells = C.cellsFor({ west: -93.66, east: -93.58, south: 42.0, north: 42.06 }, { lat: 42.03, lon: -93.62 });
assert.ok(cells.length >= 4 && cells.every(c => c.east - c.west > 0.0399 && c.east - c.west < 0.0401 && c.north - c.south > 0.0399 && c.north - c.south < 0.0401));
assert.strictEqual(new Set(cells.map(c => c.key)).size, cells.length);
const d = c => Math.hypot((c.west + c.east) / 2 + 93.62, (c.south + c.north) / 2 - 42.03); assert.ok(cells.every((c, i) => i === 0 || d(cells[i - 1]) <= d(c) + 1e-9), "nearest to the centre first");
assert.strictEqual(C.cropsUrl("https://x.example/", cells[0]), "https://x.example/api/crops?west=" + cells[0].west + "&south=" + cells[0].south + "&east=" + cells[0].east + "&north=" + cells[0].north);
assert.strictEqual(C.cellsFor({ west: 10, east: 9, south: 0, north: 1 }, { lat: 0, lon: 0 }).length, 0, "an inverted view yields no cells instead of a bad request");

// 6. popups show only what the dataset supports, and say so for the rest
const f = AMES.features.find(x => x.properties.crop === "Corn"), p = f.properties;
let h = C.popupHtml(p, AMES.meta, {});
for (const need of ["Corn", "Cereal", String(p.lat.toFixed(5)), "ha", "USDA NASS Cropland Data Layer", "2021", "30 m", "Model prediction from satellite imagery, not a field survey", "Load NDVI (MODIS 250 m)", "Analyse this location"]) assert.ok(h.includes(need), "popup shows " + need);
assert.ok(h.includes("Not available in this dataset"), "unsupported fields (growing season here) say so instead of being invented");
assert.ok(/Polygon ID<small>\(made by this app; the dataset has no field IDs\)<\/small>/.test(h) && !/Field ID/.test(h), "never presents an invented Field ID as real");
assert.ok(C.popupHtml(p, AMES.meta, { season: "Sowing May, harvest October. Source: USDA" }).includes("Sowing May, harvest October"), "a sourced season is shown when the project has one");
const lp = LAHORE.features[0].properties, hl = C.popupHtml(lp, LAHORE.meta, {});
assert.ok(hl.includes("Cropland (crop type not identified)") && hl.includes("ESA WorldCover") && hl.includes("10 m"), "WorldCover polygons say plainly they are cropland of unknown type");
// untrusted text is escaped
const evil = Object.assign({}, p, { crop: "<img src=x onerror=alert(1)>", category: "<b>x</b>" }); const he = C.popupHtml(evil, Object.assign({}, AMES.meta, { dataset: "<script>1</script>" }), {});
assert.ok(!/<img|<script|<b>/.test(he), "dataset text cannot inject markup");
// the id is stable for a polygon and differs between polygons
assert.strictEqual(C.polygonId(p, AMES.meta), C.polygonId(p, AMES.meta)); assert.notStrictEqual(C.polygonId(p, AMES.meta), C.polygonId(AMES.features[1].properties, AMES.meta));
console.log("cropmap tests passed: " + AMES.features.length + " real CDL polygons, " + lm.length + " crops");
