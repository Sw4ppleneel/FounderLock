// Held-out evaluation for the ArcFace pipeline.
//   genuine  = single-face web photos found by searching a founder's name (label may be noisy)
//   impostor = Plaksha faculty headshots (must never match)
// labels.json (optional) = manual verdicts per photo: "same" | "other" | "dup"
import fs from 'node:fs';
import { match } from '../src/engine/insight.js';
const ref = JSON.parse(fs.readFileSync('data/insight_ref.json', 'utf8'));
const test = JSON.parse(fs.readFileSync('data/insight_test.json', 'utf8'));
const labels = fs.existsSync('data/labels.json') ? JSON.parse(fs.readFileSync('data/labels.json', 'utf8')) : {};
const gallery = Object.entries(ref).filter(([, r]) => r.templates.length).map(([id, r]) => ({ id, templates: r.templates }));
const cos = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

export const genuine = [], impostor = [], group = [];
for (const [file, r] of Object.entries(test)) {
  if (!r.faces?.length) continue;
  let m = file.match(/^data\/web\/([^/]+)\//);
  if (m) {
    const v = labels[file];
    if (v?.startsWith('is:')) m = [null, v.slice(3)]; // photo shows a different founder than the one searched
    if (!ref[m[1]]?.templates.length) continue;
    if (v === 'other' || v === 'dup') continue;
    if (r.faces.length === 1) {
      const own = cos(r.faces[0].emb, ref[m[1]].templates[0]);
      if (own > 0.9) continue; // the reference headshot re-hosted elsewhere -> not an independent test
      genuine.push({ file, label: m[1], own, ...match(gallery, r.faces[0].emb), verified: !!v });
    } else group.push({ file, label: m[1], res: r.faces.map((f) => match(gallery, f.emb)) });
  } else if (file.startsWith('data/impostors/')) {
    impostor.push({ file, ...match(gallery, r.faces[0].emb) });
  }
}
const rows = [0.25, 0.28, 0.3, 0.32, 0.35, 0.38, 0.4, 0.45].map((T) => {
  const ok = genuine.filter((g) => g.best.id === g.label && g.best.sim >= T).length;
  const wrong = genuine.filter((g) => g.best.id !== g.label && g.best.sim >= T).length;
  return { T, genuine: genuine.length, correct: ok, wrongPerson: wrong, rejected: genuine.length - ok - wrong,
    recall: +(ok / genuine.length).toFixed(3), falseAccept: `${impostor.filter((i) => i.best.sim >= T).length}/${impostor.length}`,
    groupFound: `${group.filter((g) => g.res.some((x) => x.best.id === g.label && x.best.sim >= T)).length}/${group.length}` };
});
if (process.argv[1].endsWith('evaluate_insight.mjs')) {
  console.table(rows);
  const imp = impostor.map((i) => i.best.sim).sort((a, b) => b - a);
  console.log('top faculty similarities:', imp.slice(0, 5).map((x) => x.toFixed(3)).join(' '));
  fs.writeFileSync('data/eval_cases_insight.json', JSON.stringify({ genuine, impostor }, null, 1));
}
