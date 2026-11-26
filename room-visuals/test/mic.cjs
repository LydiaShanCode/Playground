// Checks the microphone path end to end with Chromium's fake capture device (a steady beep).
//   node room-visuals/test/mic.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.grantPermissions(['microphone']);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // https origin so getUserMedia is allowed; files come from disk.
  await page.route('https://room-visuals.test/**', (route) => {
    let rel = new URL(route.request().url()).pathname;
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto('https://room-visuals.test/');
  await page.click('#btn-mic');
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({
    hud: !document.getElementById('hud').hidden,
    error: document.getElementById('error').textContent,
    level: window.__state?.level, note: window.__state?.melody.note, onsets: window.__state ? 'ok' : 'no state',
  }));
  console.log(JSON.stringify(r), 'errors:', errors);
  await browser.close();
  process.exit(r.hud && !r.error && !errors.length ? 0 : 1);
})();
