// Node helpers: load the shared engine with onnxruntime-node and decode files via sharp.
import path from 'node:path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { FaceEngine } from '../src/engine/insight.js';

export const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const loadEngine = () => FaceEngine.create(ort,
  path.join(root, 'public/models/insight/det_500m.onnx'), path.join(root, 'public/models/insight/w600k_mbf.onnx'));

export async function decode(fileOrBuf, { flip = false, max = 1280 } = {}) {
  let s = sharp(fileOrBuf, { failOn: 'none' }).rotate();
  if (flip) s = s.flop();
  const { data, info } = await s.resize(max, max, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 3 };
}

/** All faces in an image with embeddings, largest first. */
export async function describeAll(engine, img, opts) {
  const faces = await engine.detect(img, opts);
  const out = [];
  for (const f of faces) out.push({ box: f.box.map(Math.round), score: +f.score.toFixed(3), kps: f.kps, emb: await engine.embed(img, f) });
  return out.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
}
