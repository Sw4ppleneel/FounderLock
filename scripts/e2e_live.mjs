// Headless end-to-end check of the live camera path: each test photo becomes a fake webcam
// stream (Chrome --use-file-for-fake-video-capture) in its own browser session.
// Usage: [PHONE=1] [BASE=https://...] node scripts/e2e_live.mjs <workdir> <expectedId|none>=<image> ...   (needs `vite preview --port 4173`)
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
const [dir, ...cases] = process.argv.slice(2);
const results = [];
for (const [i, c] of cases.entries()) {
  const [expect, img] = c.split('=');
  const png = `${dir}/case${i}.png`, y4m = `${dir}/case${i}.y4m`;
  await sharp(img, { failOn: 'none' }).rotate().resize(1280, 720, { fit: 'contain', background: '#202020' }).png().toFile(png);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', png, '-t', '2', '-vf', 'fps=15,format=yuv420p', y4m]);
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] });
  const phone = process.env.PHONE === '1'; // emulate a phone: touch, small viewport, DPR 3
  const page = await browser.newPage(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, permissions: ['camera'] }
    : { viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.BASE || 'http://localhost:4173/');
  await page.waitForSelector('#btn-start:not([disabled])', { timeout: 120000 });
  await page.click('#btn-start');
  const t0 = Date.now(); let lockedAt = null, who = '', seen = new Set();
  while (Date.now() - t0 < 6000) {
    const st = await page.textContent('#status b');
    const name = await page.evaluate(() => document.getElementById('card').hidden ? '' : document.getElementById('c-name').textContent);
    if (st === 'locked' && name) { seen.add(name); if (!lockedAt) { lockedAt = Date.now() - t0; who = name; } }
    await page.waitForTimeout(150);
  }
  await page.screenshot({ path: `${dir}/case${i}-shot.png` });
  results.push({ expect, img: img.split('/').slice(-2).join('/'), locked: who || '-', lockMs: lockedAt ?? '-', namesShown: [...seen].join(', '), errors: errors.length });
  await browser.close();
}
console.table(results);
