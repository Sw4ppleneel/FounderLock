// Navigation check: every way out of a locked card must work, on a phone viewport.
// Usage: [BASE=url] node scripts/e2e_nav.mjs <workdir> <face-image>   (needs `vite preview --port 4173` for local)
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
const [dir, img] = process.argv.slice(2);
await sharp(img).rotate().resize(1280, 720, { fit: 'contain', background: '#202020' }).png().toFile(`${dir}/nav.png`);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', `${dir}/nav.png`, '-t', '2', '-vf', 'fps=15,format=yuv420p', `${dir}/nav.y4m`]);
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${dir}/nav.y4m`] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
const state = () => page.evaluate(() => ({
  intro: !document.getElementById('intro').classList.contains('gone'),
  card: !document.getElementById('card').hidden && !document.getElementById('card').classList.contains('out'),
  camera: !!document.getElementById('video').srcObject && document.getElementById('video').srcObject.active,
  status: document.querySelector('#status b').textContent,
}));
const waitCard = () => page.waitForFunction(() => !document.getElementById('card').hidden && !document.getElementById('card').classList.contains('out'), null, { timeout: 8000 });
const settle = () => page.waitForTimeout(600);
const results = [];
const check = async (step, expect) => {
  const s = await state();
  const ok = Object.entries(expect).every(([k, v]) => s[k] === v);
  results.push({ step, ok: ok ? 'PASS' : 'FAIL', ...s });
};
await page.goto(process.env.BASE || 'http://localhost:4173/');
await page.waitForSelector('#btn-start:not([disabled])', { timeout: 120000 });

await page.click('#btn-start'); await waitCard(); await check('start -> lock shows card', { intro: false, card: true });
await page.goBack(); await settle(); await check('system back #1 closes card', { intro: false, card: false, camera: true });
await page.waitForTimeout(1500); await check('dismissed card stays closed while same face in view', { card: false });
await page.goBack(); await settle(); await check('system back #2 returns home, camera off', { intro: true, card: false, camera: false });

await page.click('#btn-start'); await waitCard(); await check('restart -> lock again', { intro: false, card: true });
await page.click('#c-close'); await settle(); await check('✕ closes card', { card: false, intro: false });
await page.mouse.click(195, 300); await page.waitForTimeout(300);
const reopened = (await state()).card;
results.push({ step: 'tap reticle reopens card', ok: reopened ? 'PASS' : 'FAIL (tap missed the face box?)' });
if (!reopened) { /* fine either way; continue */ }
await page.click('#btn-back'); await settle();
if (reopened) { await check('Back button closes card', { card: false, intro: false }); await page.click('#btn-back'); await settle(); }
await check('Back button returns home', { intro: true, camera: false });

await page.click('#btn-start'); await waitCard();
// swipe down on the card
const box = await page.locator('#card').boundingBox();
await page.evaluate(async ({ x, y }) => {
  const el = document.getElementById('card');
  const t = (yy) => new Touch({ identifier: 1, target: el, clientX: x, clientY: yy });
  el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(y)], bubbles: true }));
  for (let d = 10; d <= 140; d += 10) el.dispatchEvent(new TouchEvent('touchmove', { touches: [t(y + d)], bubbles: true }));
  el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
}, { x: box.x + box.width / 2, y: box.y + 30 });
await settle(); await check('swipe down dismisses card', { card: false, intro: false });
await page.click('#btn-home'); await settle(); await check('logo returns home', { intro: true, camera: false });

// photo flow
await page.setInputFiles('#file-intro', img); await waitCard(); await check('photo scan -> card', { intro: false, card: true });
await page.goBack(); await settle(); await check('photo: back closes card', { card: false, intro: false });
await page.click('#btn-live'); await page.waitForTimeout(1500); await check('photo -> Camera resumes live', { intro: false, camera: true });
await page.goBack(); await settle();
const s = await state(); if (s.card) { await page.goBack(); await settle(); }
await page.goBack(); await settle(); await check('back from live returns home', { intro: true });
console.table(results);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
