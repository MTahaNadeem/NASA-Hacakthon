const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block', recordVideo: { dir: 'vid3', size: { width: 1280, height: 720 } } }); const p = await ctx.newPage(); const T0 = Date.now();
  await p.goto('https://mtahanadeem.github.io/NASA-Hacakthon/?lang=en#/app/planner', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#loadbar:not([hidden])', { timeout: 60000 }); const tShow = (Date.now() - T0) / 1000; await p.evaluate(() => document.getElementById('step3').scrollIntoView({ block: 'start' }));
  await p.waitForFunction(() => /All data loaded|Finished/.test((document.getElementById('lb-note') || {}).textContent || ''), null, { timeout: 120000 }).catch(() => {});
  const tDone = (Date.now() - T0) / 1000; await new Promise(r => setTimeout(r, 2500)); console.log('loadbar visible at', tShow.toFixed(1), 'done at', tDone.toFixed(1));
  const v = p.video(); await ctx.close(); await b.close(); console.log(await v.path());
})();
