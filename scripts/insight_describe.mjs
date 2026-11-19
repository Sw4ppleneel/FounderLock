// Embed reference headshots (+mirror) and every harvested test photo with the ArcFace pipeline.
import fs from 'node:fs';
import path from 'node:path';
import { root, loadEngine, decode, describeAll } from './node_engine.mjs';
const engine = await loadEngine();
const round = (e) => Array.from(e, (v) => +v.toFixed(5));

const founders = JSON.parse(fs.readFileSync(path.join(root, 'data/founders.json'), 'utf8'));
const ref = {};
for (const p of founders) {
  if (!p.photo) continue;
  const f = path.join(root, 'data', p.photo);
  const a = await describeAll(engine, await decode(f));
  const b = await describeAll(engine, await decode(f, { flip: true }));
  ref[p.id] = { faces: a.length, templates: [a[0], b[0]].filter(Boolean).map((x) => round(x.emb)) };
  if (!a.length) console.log('no face in reference:', p.id);
}
fs.writeFileSync(path.join(root, 'data/insight_ref.json'), JSON.stringify(ref));

const outFile = path.join(root, 'data/insight_test.json');
const cache = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
const files = [];
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['data/web', 'data/impostors'];
const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).forEach((x) => walk(path.join(p, x))) : /\.(img|jpe?g|png|webp)$/i.test(p) && files.push(path.relative(root, p));
dirs.forEach((d) => walk(path.join(root, d)));
let n = 0;
for (const f of files) {
  if (cache[f]) continue;
  try {
    const img = await decode(path.join(root, f));
    const faces = await describeAll(engine, img);
    cache[f] = { w: img.width, h: img.height, faces: faces.map((x) => ({ box: x.box, score: x.score, emb: round(x.emb) })) };
  } catch (e) { cache[f] = { error: String(e.message || e).slice(0, 100) }; }
  if (++n % 100 === 0) { fs.writeFileSync(outFile, JSON.stringify(cache)); process.stderr.write(n + ' '); }
}
fs.writeFileSync(outFile, JSON.stringify(cache));
const v = Object.values(cache);
console.log(`\nref ${Object.keys(ref).length}; test ${v.length}: no-face ${v.filter((x) => x.faces && !x.faces.length).length}, one ${v.filter((x) => x.faces?.length === 1).length}, multi ${v.filter((x) => x.faces?.length > 1).length}, err ${v.filter((x) => x.error).length}`);
