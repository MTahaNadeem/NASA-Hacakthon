// Every language must define exactly the English keys, with the same {placeholders}.
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm");
const dir = path.join(__dirname, "../app/i18n"), I18N = require("../app/i18n.js");
const ph = s => (s.match(/\{\w+\}/g) || []).sort().join(",");
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".js"))) vm.runInNewContext(fs.readFileSync(path.join(dir, f), "utf8"), { I18N });
const en = I18N._dicts.en, problems = [];
assert.strictEqual(Object.keys(I18N._dicts).length, I18N.LANGS.length, "a language in LANGS has no dictionary, or vice versa");
for (const l of I18N.LANGS) {
  const d = I18N._dicts[l.code]; if (!d) { problems.push(l.code + ": missing dictionary"); continue; }
  for (const k of Object.keys(en)) {
    if (!(k in d)) problems.push(`${l.code}: missing ${k}`);
    else { if (typeof d[k] !== "string" || !d[k].trim()) problems.push(`${l.code}: empty ${k}`); if (ph(d[k]) !== ph(en[k])) problems.push(`${l.code}: placeholders differ in ${k} (${ph(d[k])} vs ${ph(en[k])})`); }
  }
  for (const k of Object.keys(d)) if (!(k in en)) problems.push(`${l.code}: extra key ${k}`);
}
// every static key used by the app exists in English
const src = fs.readFileSync(path.join(__dirname, "../app/app.js"), "utf8") + fs.readFileSync(path.join(__dirname, "../app/index.html"), "utf8");
const used = new Set([...src.matchAll(/(?:\bt\(|data-i18n(?:-ph)?=)["']([a-z0-9_.]+[a-z0-9_])["']/gi)].map(m => m[1]));
for (const k of used) if (!(k in en)) problems.push("app uses unknown key " + k);
// dynamic keys: crops, locations, presets, factors, sliders, benefit types must all be translated
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/rotations.json"), "utf8"));
const S = require("../app/scoring.js");
const dyn = [].concat(Object.keys(cfg.crops).map(c => "crop." + c), Object.keys(cfg.presets).map(p => "preset." + p), 
  S.FACTORS.flatMap(f => ["label", "data", "rule"].map(x => `f.${f.id}.${x}`)), S.SLIDERS.map(x => "pri." + x),
  [...new Set(Object.values(cfg.crops).map(c => c.type))].map(x => "ben." + x), ["ph", "clay", "soc", "sand", "silt"].map(x => "prop." + x));
for (const k of dyn) if (!(k in en)) problems.push("dynamic key missing in English: " + k);
if (problems.length) { console.log(problems.join("\n")); process.exit(1); }
console.log(`i18n tests passed: ${I18N.LANGS.length} languages x ${Object.keys(en).length} keys`);
