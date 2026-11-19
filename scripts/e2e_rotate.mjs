// Rotation check: landscape start, lock, then rotate portrait <-> landscape mid-lock.
// Each step: still locked, card visible and not covering the face, no page errors.
// Usage: [BASE=url] node scripts/e2e_rotate.mjs <workdir> <face-image>
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
const [dir, img] = process.argv.slice(2);
await sharp(img).rotate().resize(1280, 720, { fit: 'contain', background: '#202020' }).png().toFile(`${dir}/rot.png`);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', `${dir}/rot.png`, '-t', '2', '-vf', 'fps=15,format=yuv420p', `${dir}/rot.y4m`]);
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${dir}/rot.y4m`] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, permissions: ['camera'] });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
const rows = [];
const snap = async (step, file) => {
  await page.waitForTimeout(1200);
  const d = await page.evaluate(() => window.__fl());
  let overlap = '-';
  if (d.face && d.card) {
    const [x, y, w, h] = d.face, [cx, cy, cw, ch] = d.card;
    const ix = Math.max(0, Math.min(x + w, cx + cw) - Math.max(x, cx)), iy = Math.max(0, Math.min(y + h, cy + ch) - Math.max(y, cy));
    overlap = Math.round((100 * ix * iy) / (w * h)) + '%';
  }
  const ok = d.locked && d.card && (overlap === '-' || parseInt(overlap) <= 35);
  rows.push({ step, ok: ok ? 'PASS' : 'FAIL', locked: d.locked, side: d.side, faceUnderCard: overlap, frameRot: d.rot });
  await page.screenshot({ path: `${dir}/${file}.png` });
};
await page.goto(process.env.BASE || 'http://localhost:4173/');
await page.waitForSelector('#btn-start:not([disabled])', { timeout: 120000 });
const b = await page.locator('#btn-start').boundingBox();
rows.push({ step: 'landscape intro: Start button on screen', ok: b && b.y + b.height <= 390 ? 'PASS' : 'needs scroll', locked: '', side: '', faceUnderCard: '', frameRot: '' });
await page.screenshot({ path: `${dir}/0-intro-landscape.png` });
await page.locator('#btn-start').click();
await page.waitForFunction(() => window.__fl().locked, null, { timeout: 8000 });
await snap('landscape: lock', '1-landscape');
await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => dispatchEvent(new Event('orientationchange')));
await snap('rotate -> portrait', '2-portrait');
await page.setViewportSize({ width: 844, height: 390 }); await page.evaluate(() => dispatchEvent(new Event('orientationchange')));
await snap('rotate -> landscape', '3-landscape-again');
await page.setViewportSize({ width: 390, height: 844 });
await snap('rotate -> portrait (no event)', '4-portrait-noevent');
console.table(rows);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
