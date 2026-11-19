// Build public/data/gallery.json: one entry per person with profile data + quantised ArcFace templates.
//  - founders: Plaksha headshot (+ mirrored copy) -- data/founders.json from scrape_founders.py
//  - extras:   data/extras.json, people enrolled from public photos (each face picked by hand)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { root, loadEngine, decode, describeAll } from './node_engine.mjs';

const engine = await loadEngine();
const out = path.join(root, 'public/data');
fs.mkdirSync(path.join(out, 'photos'), { recursive: true });

// int8 with a per-vector scale: 512 B/template instead of ~4 KB of JSON floats.
const quantise = (e) => {
  let m = 0; for (const v of e) m = Math.max(m, Math.abs(v));
  const q = Int8Array.from(e, (v) => Math.round((v / m) * 127));
  return { s: +(m / 127).toPrecision(6), q: Buffer.from(q.buffer).toString('base64') };
};
const card = (src, dest, region) => {
  let s = sharp(src, { failOn: 'none' }).rotate();
  if (region) s = s.extract(region);
  return s.resize(360, 360, { fit: 'cover', position: 'attention' }).jpeg({ quality: 84, mozjpeg: true }).toFile(dest);
};

const people = [];
for (const p of JSON.parse(fs.readFileSync(path.join(root, 'data/founders.json'), 'utf8'))) {
  const rec = {
    id: p.id, name: p.name, group: p.category, role: p.role, education: p.education,
    bio: (p.bio || []).map((b) => b.replace(/^Bio\s+/, '')).filter((b) => !/^Bio$/.test(b)),
    links: [...(p.links || []).map((u) => ({ label: /linkedin/.test(u) ? 'LinkedIn' : 'X', url: u.replace(/\?$/, '') })),
      { label: 'Plaksha profile', url: p.profileUrl }],
    templates: [],
  };
  if (p.photo) {
    const f = path.join(root, 'data', p.photo);
    for (const flip of [false, true]) {
      const faces = await describeAll(engine, await decode(f, { flip }));
      if (faces[0]) rec.templates.push(quantise(faces[0].emb));
    }
    rec.photo = `photos/${p.id}.jpg`;
    await card(f, path.join(out, rec.photo));
  }
  people.push(rec);
}

// Extras: each source lists the image and which face in it (index into faces sorted largest-first).
const extrasFile = path.join(root, 'data/extras.json');
for (const x of fs.existsSync(extrasFile) ? JSON.parse(fs.readFileSync(extrasFile, 'utf8')) : []) {
  const rec = { id: x.id, name: x.name, group: x.group, role: x.role, education: x.education, bio: x.bio, links: x.links, templates: [] };
  for (const s of x.sources) {
    for (const flip of s.mirror ? [false, true] : [false]) {
      const img = await decode(path.join(root, s.file), { flip, max: 1600 });
      const faces = await describeAll(engine, img);
      // after a mirror the face order by size is unchanged
      const face = faces[s.face];
      if (!face) throw new Error(`no face #${s.face} in ${s.file}`);
      rec.templates.push(quantise(face.emb));
    }
  }
  rec.photo = `photos/${x.id}.jpg`;
  await card(path.join(root, x.cardPhoto), path.join(out, rec.photo));
  people.push(rec);
}

fs.writeFileSync(path.join(out, 'gallery.json'), JSON.stringify({ built: new Date().toISOString().slice(0, 10), threshold: 0.45, people }));
const n = people.filter((p) => p.templates.length).length;
console.log(`${people.length} people, ${n} recognisable, ${people.reduce((s, p) => s + p.templates.length, 0)} templates`);
console.log('without a photo:', people.filter((p) => !p.templates.length).map((p) => p.name).join(', '));
