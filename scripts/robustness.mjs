// Field-conditions stress test: re-run held-out founder photos and non-founder faces through
// simulated sun / backlight / dust / shadow / low light / blur, with and without the lighting fixes.
// Usage: node scripts/robustness.mjs [N] [variants,comma,sep] [conditions,comma,sep]
// Live-app settings: frame max side 960, detector input 480, threshold from the gallery (0.45).
import fs from 'node:fs';
import sharp from 'sharp';
import { loadEngine, decode } from './node_engine.mjs';
import { match, autoLevels } from '../src/engine/insight.js';

const T = 0.45, N = +(process.argv[2] || 120);
const engine = await loadEngine();
const { genuine } = JSON.parse(fs.readFileSync('data/eval_cases_insight.json', 'utf8'));
const test = JSON.parse(fs.readFileSync('data/insight_test.json', 'utf8'));
const every = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
const gen = every(genuine.map((g) => ({ file: g.file, label: g.label })), N);
const ref = JSON.parse(fs.readFileSync('data/insight_ref.json', 'utf8'));
const galleryRaw = Object.entries(ref).filter(([, r]) => r.templates.length).map(([id, r]) => ({ id, templates: r.templates }));
const nonFounder = Object.entries(test).filter(([f, r]) => (f.startsWith('data/impostors/') || f.startsWith('data/impostors_web/')) && r.faces?.length === 1
  && match(galleryRaw, r.faces[0].emb).best.sim < 0.40).map(([f]) => f);
const imp = every(nonFounder, N);

// ── degradations on raw RGB (3 ch) ──
const rng = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
const gauss = () => Math.sqrt(-2 * Math.log(rng() + 1e-9)) * Math.cos(2 * Math.PI * rng());
const px = (img, f) => { const d = new Uint8ClampedArray(img.data.length); for (let p = 0; p < img.width * img.height; p++) { const i = p * 3; const [r, g, b] = f(img.data[i], img.data[i + 1], img.data[i + 2], p % img.width, Math.floor(p / img.width), img); d[i] = r; d[i + 1] = g; d[i + 2] = b; } return { ...img, data: d }; };
const blur = async (img, sigma) => { const { data, info } = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 3 } }).blur(sigma).raw().toBuffer({ resolveWithObject: true }); return { ...img, data: new Uint8ClampedArray(data) }; };
const haze = (k, veil = [205, 185, 155]) => (r, g, b) => [r * (1 - k) + veil[0] * k, g * (1 - k) + veil[1] * k, b * (1 - k) + veil[2] * k];
const CONDITIONS = {
  clean: async (i) => i,
  'harsh sun / overexposed': async (i) => px(i, (r, g, b) => [r * 1.7 + 25, g * 1.7 + 25, b * 1.7 + 25]),
  'backlit (sun behind)': async (i) => px(i, (r, g, b) => [r, g, b].map((v) => 255 * (v / 255) ** 2.6 + gauss() * 4)),
  'dust haze': async (i) => blur(px(i, haze(0.5)), 1.4),
  'heavy dust haze': async (i) => blur(px(i, haze(0.68)), 2),
  'hard side shadow': async (i) => px(i, (r, g, b, x, y, im) => { const k = 1 - 0.78 * (x / im.width); return [r * k, g * k, b * k]; }),
  'warm golden-hour cast': async (i) => px(i, (r, g, b) => [r * 1.15 + 10, g * 1.0, b * 0.65]),
  'low light + noise': async (i) => px(i, (r, g, b) => [r, g, b].map((v) => v * 0.28 + gauss() * 7)),
  'motion blur': async (i) => blur(i, 2.6),
  'dusty noon (haze+glare+shadow)': async (i) => px(blur(px(i, haze(0.35)), 1.2).then ? await blur(px(i, haze(0.35)), 1.2) : i, (r, g, b, x, y, im) => { const k = 1.35 * (1 - 0.5 * (x / im.width)); return [r * k + 15, g * k + 15, b * k + 15]; }),
};

async function faces(img, { levels }) {
  const im = levels ? autoLevels(img) : img;
  const dets = await engine.detect(im, { size: 480, threshold: 0.55 });
  return { im, dets: dets.filter((d) => d.box[2] >= 28).sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]) };
}

// gallery per variant, from the Plaksha headshots (+mirror), same pipeline as the probe
const ALL_VARIANTS = { base: { levels: false, tone: false }, tone: { levels: false, tone: true }, 'levels+tone': { levels: true, tone: true },
  'adaptive<140': { levels: false, tone: 140 }, 'adaptive<170': { levels: false, tone: 170 },
  // base pipeline; a face that fails AND is washed out gets one retry with tone normalisation
  rescue: { levels: false, tone: false, rescue: 170 } };
const pickV = (process.argv[3] || 'base,tone,levels+tone').split(',');
const VARIANTS = Object.fromEntries(pickV.map((k) => [k, ALL_VARIANTS[k]]));
const founders = JSON.parse(fs.readFileSync('data/founders.json', 'utf8')).filter((p) => p.photo);
const galleries = {};
for (const [vn, v] of Object.entries(VARIANTS)) {
  galleries[vn] = [];
  for (const p of founders) {
    const t = [];
    for (const flip of [false, true]) {
      const img = await decode('data/' + p.photo, { flip });
      const { im, dets } = await faces(img, v);
      if (dets[0]) t.push(await engine.embed(im, dets[0], { tone: v.tone }));
    }
    if (t.length) galleries[vn].push({ id: p.id, templates: t });
  }
}

async function ident(vn, v, im, d) {
  const g = galleries[vn];
  const m = match(g, await engine.embed(im, d, { tone: v.tone }));
  if (!v.rescue || m.best.sim >= T) return m;
  return match(g, await engine.embed(im, d, { tone: v.rescue })); // no-op unless the face is washed out
}
const rows = [];
const cache = new Map();
const pickC = process.argv[4] ? process.argv[4].split(',') : Object.keys(CONDITIONS);
for (const [cn, fn] of Object.entries(CONDITIONS).filter(([c]) => pickC.includes(c))) {
  const stats = Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, { det: 0, ok: 0, wrong: 0, fa: 0, n: 0, ni: 0 }]));
  for (const [kind, list] of [['gen', gen], ['imp', imp]]) {
    for (const item of list) {
      const file = kind === 'gen' ? item.file : item;
      if (!cache.has(file)) cache.set(file, await decode(file, { max: 960 }));
      const img = await fn(cache.get(file));
      const perDet = {};
      for (const [vn, v] of Object.entries(VARIANTS)) {
        const key = v.levels ? 'L' : 'R';
        perDet[key] ??= await faces(img, v);
        const { im, dets } = perDet[key];
        const s = stats[vn];
        if (kind === 'gen') {
          s.n++;
          if (!dets.length) continue;
          s.det++;
          const m = await ident(vn, v, im, dets[0]);
          if (m.best.sim >= T) { if (m.best.id === item.label) s.ok++; else s.wrong++; }
        } else {
          s.ni++;
          for (const d of dets.slice(0, 3)) { const m = await ident(vn, v, im, d); if (m.best.sim >= T) { s.fa++; break; } }
        }
      }
    }
  }
  for (const [vn, s] of Object.entries(stats)) rows.push({ condition: cn, variant: vn, detected: `${s.det}/${s.n}`, recognised: `${s.ok}/${s.n}`, recall: +(s.ok / s.n).toFixed(3), wrongFounder: s.wrong, falseAccept: `${s.fa}/${s.ni}` });
  process.stderr.write(`${cn} done\n`);
}
console.table(rows);
fs.writeFileSync(`data/robustness-${pickV.join('_').replace(/[^a-z0-9_+-]/gi, '')}.json`, JSON.stringify(rows, null, 1));
