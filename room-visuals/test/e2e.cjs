// End-to-end check: plays each demo preset in headless Chromium and prints what the analyzer hears.
// Files are served from disk via request interception, so no server is needed:
//   node room-visuals/test/e2e.cjs [preset-filter]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const URL = 'http://room-visuals.test/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const OUT = process.env.OUT || '.';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route('http://room-visuals.test/**', (route) => {
    let rel = new globalThis.URL(route.request().url()).pathname;
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto(URL);
  const only = process.argv[2];
  const presets = await page.$$eval('#presets button', (bs) => bs.map((b) => b.textContent));
  for (const [i, label] of presets.entries()) {
    if (only && !label.toLowerCase().includes(only)) continue;
    if (await page.isVisible('#btn-stop')) await page.click('#btn-stop');
    if (!(await page.isVisible(`#presets button:nth-child(${i + 1})`))) await page.click('summary');
    await page.click(`#presets button:nth-child(${i + 1})`);
    // Tap the analyzer's event stream to report phrase lengths and rhythm event counts.
    await page.evaluate(() => {
      const a = window.__analyzer, log = (window.__log = []);
      const emit = a.emit.bind(a);
      a.emit = (type, data) => { log.push({ type, t: a.ctx.currentTime, ...data }); emit(type, data); };
    });
    const samples = [];
    for (let s = 0; s < 6; s++) {
      await page.waitForTimeout(5000);
      samples.push(await page.evaluate(() => {
        const s = window.__state, a = window.__analyzer;
        return {
          bpm: s.bpm && +s.bpm.toFixed(1), conf: +s.bpmConfidence.toFixed(2), key: s.key.name,
          genre: s.genre.slice(0, 3).map((g) => `${g.genre} ${g.p.toFixed(2)}`).join(', '),
          phrases: s.melody.phraseIndex,
          feats: Object.fromEntries(Object.entries(a.features).map(([k, v]) => [k, +v.toFixed(2)])),
        };
      }));
    }
    const ev = await page.evaluate(() => {
      const counts = {}, durs = [];
      for (const e of window.__log) { counts[e.type] = (counts[e.type] || 0) + 1; if (e.type === 'phraseEnd') durs.push(+e.duration.toFixed(1)); }
      return { counts, phraseDurations: durs.slice(0, 12), resolved: window.__log.filter((e) => e.type === 'phraseEnd' && e.resolved).length };
    });
    console.log('\n==', label);
    console.log('events', JSON.stringify(ev));
    for (const x of samples.slice(2)) console.log(JSON.stringify(x));
    await page.screenshot({ path: `${OUT}/shot-${i}.png` });
  }
  console.log('errors:', errors);
  await browser.close();
})();
