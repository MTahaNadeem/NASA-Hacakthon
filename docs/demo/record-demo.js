// Records the 30-second demo against the live site (Playwright). Captions are drawn in the page; no audio.
// Run: NODE_PATH=$(npm root -g) node docs/demo/record-demo.js, then trim the .webm with ffmpeg.
const { chromium } = require('playwright');
const URL = 'https://mtahanadeem.github.io/NASA-Hacakthon/?lang=en';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function run(record) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block', ...(record ? { recordVideo: { dir: 'vid', size: { width: 1280, height: 720 } } } : {}) });
  const p = await ctx.newPage();
  const cap = t => p.evaluate(t => { let d = document.getElementById('democap'); if (!d) { d = document.createElement('div'); d.id = 'democap'; d.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99999;max-width:86%;padding:12px 24px;border-radius:12px;background:rgba(15,40,25,.92);color:#fff;font:600 22px/1.3 Inter,Arial,sans-serif;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35)'; document.body.appendChild(d); } d.textContent = t; d.style.display = t ? 'block' : 'none'; }, t);
  await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForSelector('.hero-in'); await p.waitForTimeout(1500);
  // pre-roll (cut from the video): open the app once and wait until every NASA data step has finished, so the recording shows final results
  await p.click('#site .getstart'); await p.waitForSelector('#ov-rec .ring', { timeout: 120000 });
  await p.waitForFunction(() => !!document.querySelector('#summary .confbox') || /All data loaded|Finished/.test((document.getElementById('lb-note') || {}).textContent || ''), null, { timeout: 150000 }).catch(() => {});
  await p.waitForTimeout(2500);
  await p.evaluate(() => { location.hash = '#/'; window.scrollTo(0, 0); }); await p.waitForTimeout(800);
  const t0 = Date.now();
  await cap('Rotation Explorer: crop rotation advice from NASA Earth data'); await sleep(3600);
  await p.click('#site .getstart'); await p.waitForSelector('#ov-rec .ring');
  await cap('Pick any place: NASA weather, soil and satellite data feed the result'); await sleep(3200);
  await p.evaluate(() => document.querySelector('.d-rec').scrollIntoView({ behavior: 'smooth', block: 'start' })); await cap('Ranked rotations with a fit score and 20 years of climate'); await sleep(4300);
  await p.evaluate(() => { location.hash = '#/app/planner'; }); await sleep(700);
  await cap('Set your priorities: results update instantly, with the evidence');
  await p.evaluate(() => { const s = document.getElementById('sl-water'); s.value = 90; s.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(1800);
  await p.evaluate(() => document.getElementById('step3').scrollIntoView({ behavior: 'smooth' })); await sleep(3600);
  await p.evaluate(() => { location.hash = '#/app'; window.scrollTo(0, 0); }); await sleep(700);
  await p.evaluate(() => { const b = [...document.querySelectorAll('#loclist button')].find(x => /Ames/.test(x.textContent)); if (b) b.click(); }); await sleep(1200);
  await p.evaluate(() => { const m = CropMap.instance.map; m.setView([42.03, -93.62], 14); m.addLayer(CropMap.instance.layers.crops); });
  await cap('Real crop areas from USDA and ESA data, never invented');
  await p.waitForFunction(() => document.querySelectorAll('.cropleg li[data-crop]').length > 3, null, { timeout: 90000 }).catch(() => {}); await sleep(3400);
  await cap('Free, 10 languages, honest about its limits: mtahanadeem.github.io/NASA-Hacakthon'); await sleep(2600);
  const dur = (Date.now() - t0) / 1000; const v = p.video(); await ctx.close(); await b.close();
  if (record) { console.log('actions seconds', dur.toFixed(1), 'startOffset', ((t0 - global.START) / 1000).toFixed(1)); console.log('video', await v.path()); }
}
(async () => {
  
  console.log('recording'); global.START = Date.now(); await run(true);
})().catch(e => { console.error(e); process.exit(1); });
