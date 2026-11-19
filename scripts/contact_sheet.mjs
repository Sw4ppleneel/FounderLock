// Visual audit: each tile = [reference headshot | face crop from the test photo | (predicted founder's headshot)].
// Usage: node scripts/contact_sheet.mjs <cases.json> <outPrefix>   cases = [{file, label, pred?, sim, box}]
import fs from 'node:fs';
import sharp from 'sharp';
const [casesFile, outPrefix] = process.argv.slice(2);
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
const founders = Object.fromEntries(JSON.parse(fs.readFileSync('data/founders.json', 'utf8')).map((p) => [p.id, p]));
const test = JSON.parse(fs.readFileSync('data/insight_test.json', 'utf8'));
const S = 110, COLS = 4, PER = 24;
const refTile = (id) => founders[id]?.photo ? sharp('data/' + founders[id].photo).resize(S, S, { fit: 'cover' }).png().toBuffer() : null;
for (let p = 0; p * PER < cases.length; p++) {
  const chunk = cases.slice(p * PER, p * PER + PER);
  const W = COLS * (3 * S + 20), rowH = S + 26, H = Math.ceil(chunk.length / COLS) * rowH;
  const comp = [];
  let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="Menlo" font-size="12" fill="#fff">`;
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i], x = (i % COLS) * (3 * S + 20), y = Math.floor(i / COLS) * rowH;
    const r = test[c.file]; const meta = await sharp(c.file, { failOn: 'none' }).rotate().metadata();
    const sc = Math.max(meta.width, meta.height) > 1280 ? 1280 / Math.max(meta.width, meta.height) : 1;
    const [bx, by, bw, bh] = (c.box || r.faces[0].box).map((v) => v / sc);
    const pad = bw * 0.35;
    const left = Math.max(0, Math.round(bx - pad)), top = Math.max(0, Math.round(by - pad));
    const width = Math.min(meta.width - left, Math.round(bw + 2 * pad)), height = Math.min(meta.height - top, Math.round(bh + 2 * pad));
    const crop = await sharp(c.file, { failOn: 'none' }).rotate().extract({ left, top, width, height }).resize(S, S, { fit: 'cover' }).png().toBuffer();
    const a = await refTile(c.label); if (a) comp.push({ input: a, left: x, top: y });
    comp.push({ input: crop, left: x + S, top: y });
    if (c.pred) { const b = await refTile(c.pred); if (b) comp.push({ input: b, left: x + 2 * S, top: y }); }
    svg += `<text x="${x}" y="${y + S + 16}">#${p * PER + i} ${c.label.slice(0, 14)} ${c.sim.toFixed(2)}${c.pred ? ' →' + c.pred.slice(0, 12) : ''}</text>`;
  }
  comp.push({ input: Buffer.from(svg + '</svg>'), left: 0, top: 0 });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#111' } }).composite(comp).jpeg({ quality: 80 }).toFile(`${outPrefix}-${p}.jpg`);
}
console.log(Math.ceil(cases.length / PER), 'sheets');
