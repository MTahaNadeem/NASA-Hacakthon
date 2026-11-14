// Our homolosine projection against PROJ's own output (real ground truth, computed with pyproj).
const assert = require("assert"), fs = require("fs"), path = require("path");
const IGH = require("../app/igh.js");
const pts = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/igh_truth.json"), "utf8"));
let worst = 0; pts.forEach(([lon, lat, x, y]) => { const [px, py] = IGH.forward(lon, lat); worst = Math.max(worst, Math.hypot(px - x, py - y)); });
assert.ok(worst < 125, "worst error " + worst.toFixed(1) + " m must be under half a 250 m pixel");
// the pixels measured on the real SoilGrids files
const gt = [-19949750, 250, 0, 8361000, 0, -250], px = (lat, lon) => { const [x, y] = IGH.forward(lon, lat); return [Math.floor((x - gt[0]) / 250), Math.floor((y - gt[3]) / -250)]; };
assert.deepStrictEqual(px(38.5, -98.0), [35968, 16300]); assert.deepStrictEqual(px(31.45, 74.10), [109909, 19440]); assert.deepStrictEqual(px(42.03, -93.62), [37397, 14731]);
console.log("igh tests passed: " + pts.length + " PROJ points, worst error " + worst.toFixed(1) + " m");
