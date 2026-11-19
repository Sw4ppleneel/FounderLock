import * as ort from 'onnxruntime-web/wasm';
// @ts-ignore - plain JS module shared with the Node enrollment scripts
import { FaceEngine, match, faceQuality } from './engine/insight.js';

export type Person = {
  id: string; name: string; group: string; role: string; education: string;
  bio: string[]; links: { label: string; url: string }[]; photo?: string;
  templates: Float32Array[];
};
export type Face = { box: [number, number, number, number]; score: number; kps: number[][] };
export type Match = { best: { id: string | null; sim: number }; second: { id: string | null; sim: number } };
export type Engine = {
  detect(img: RGBA, opts?: { size?: number; threshold?: number }): Promise<Face[]>;
  embed(img: RGBA, face: Face, opts?: { tone?: boolean | number }): Promise<Float32Array>;
};
export type RGBA = { data: Uint8ClampedArray; width: number; height: number; channels: 4 };
export type Quality = { luma: number; range: number; sharp: number };

/**
 * Field-lighting thresholds, calibrated on the verified test photos (scripts/robustness.mjs):
 * clean faces sit at luma 100-160, range 131-204, sharpness >= 0.05.
 */
export const LIGHT = { dark: 60, backlit: 80, glare: 200, flat: 80, blur: 0.035, rescueRange: 170, small: 60 };

/** Plain-language hint for why a face isn't locking, or null if the light is fine. */
export function lightingHint(q: Quality, sceneLuma: number, faceWidth: number): string | null {
  if (q.luma < LIGHT.backlit && sceneLuma - q.luma > 40) return 'BACKLIT · PUT THE SUN BEHIND YOU';
  if (q.luma < LIGHT.dark) return 'TOO DARK · FIND SOME LIGHT';
  if (q.luma > LIGHT.glare) return 'GLARE ON FACE · STEP INTO SHADE';
  if (q.range < LIGHT.flat) return 'HAZY · WIPE THE LENS, MOVE CLOSER';
  if (q.sharp < LIGHT.blur) return 'BLURRY · HOLD STEADY';
  if (faceWidth < LIGHT.small) return 'MOVE CLOSER';
  return null;
}

ort.env.wasm.wasmPaths = '/ort/';
ort.env.logLevel = 'error'; // SCRFD declares a fixed 640 input; smaller inputs work but log shape warnings
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

async function fetchWithProgress(url: string, onBytes: (n: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Could not load ${url} (${res.status})`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length; onBytes(value.length);
  }
  const out = new Uint8Array(total);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function dequantise(t: { s: number; q: string }): Float32Array {
  const bin = atob(t.q);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) { const b = bin.charCodeAt(i); out[i] = (b > 127 ? b - 256 : b) * t.s; }
  // re-normalise after quantisation
  let n = 0; for (const v of out) n += v * v; n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

export async function loadVision(onProgress: (fraction: number, label: string) => void) {
  const sizes = { det: 2_524_817, rec: 13_616_099, gal: 320_000 }; // for the progress bar only
  const totalBytes = sizes.det + sizes.rec + sizes.gal;
  let loaded = 0;
  const tick = (label: string) => (n: number) => { loaded += n; onProgress(Math.min(1, loaded / totalBytes), label); };

  const [det, rec, galBytes] = await Promise.all([
    fetchWithProgress('/models/insight/det_500m.onnx', tick('loading face detector')),
    fetchWithProgress('/models/insight/w600k_mbf.onnx', tick('loading recogniser')),
    fetchWithProgress('/data/gallery.json', tick('loading founders')),
  ]);
  onProgress(1, 'warming up');
  const engine: Engine = await FaceEngine.create(ort, det, rec, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const raw = JSON.parse(new TextDecoder().decode(galBytes));
  const people: Person[] = raw.people.map((p: any) => ({ ...p, templates: p.templates.map(dequantise) }));
  const recognisable = people.filter((p) => p.templates.length);
  const byId = new Map(people.map((p) => [p.id, p]));
  // warm-up pass so the first real frame isn't slow
  const blank: RGBA = { data: new Uint8ClampedArray(64 * 64 * 4), width: 64, height: 64, channels: 4 };
  await engine.detect(blank, { size: 160 });

  return {
    engine,
    people,
    byId,
    threshold: raw.threshold as number,
    built: raw.built as string,
    match: (emb: Float32Array): Match => match(recognisable, emb),
    /**
     * Identify one face. If it fails and the face is washed out (dust, haze, glare), retry once
     * with tone normalisation -- measured to recover hazy faces with no extra false accepts.
     */
    async identify(img: RGBA, face: Face): Promise<{ m: Match; q: Quality }> {
      const q: Quality = faceQuality(img, face);
      let m: Match = match(recognisable, await engine.embed(img, face));
      if (m.best.sim < raw.threshold && q.range < LIGHT.rescueRange) {
        const r: Match = match(recognisable, await engine.embed(img, face, { tone: LIGHT.rescueRange }));
        if (r.best.sim > m.best.sim) m = r;
      }
      return { m, q };
    },
  };
}

export type Vision = Awaited<ReturnType<typeof loadVision>>;

/* ── tracking + lock-on voting ───────────────────────────────────────────── */

export type Track = {
  key: number;
  box: [number, number, number, number];   // latest detection (frame px)
  view: [number, number, number, number];  // smoothed box for drawing
  face: Face;
  born: number; seen: number; lastEmbed: number;
  votes: (string | null)[]; sims: number[];
  lock: { id: string; sim: number; at: number } | null;
  q?: Quality; hint?: string | null;
};

const iou = (a: number[], b: number[]) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return i / (a[2] * a[3] + b[2] * b[3] - i);
};

export class Tracker {
  tracks: Track[] = [];
  private next = 1;
  constructor(private threshold: number) {}

  reset() { this.tracks = []; }

  /** Associate detections with existing tracks (greedy IoU). */
  update(faces: Face[], now: number) {
    const free = new Set(this.tracks);
    for (const f of faces) {
      let best: Track | null = null, bestIou = 0.2;
      for (const t of free) { const v = iou(t.box, f.box); if (v > bestIou) { bestIou = v; best = t; } }
      if (best) {
        free.delete(best);
        best.box = f.box; best.face = f; best.seen = now;
      } else {
        this.tracks.push({ key: this.next++, box: f.box, view: [...f.box], face: f, born: now, seen: now, lastEmbed: 0, votes: [], sims: [], lock: null });
      }
    }
    // keep a lost track briefly so a blink or a missed frame doesn't drop the lock
    this.tracks = this.tracks.filter((t) => now - t.seen < 700);
  }

  /** Tracks that should be (re-)identified this frame. */
  due(now: number, max = 3) {
    return this.tracks
      .filter((t) => t.seen === now && now - t.lastEmbed > (t.lock ? 650 : 0))
      // round-robin: the face that waited longest goes first, so every face in a crowd gets read
      .sort((a, b) => a.lastEmbed - b.lastEmbed || b.box[2] * b.box[3] - a.box[2] * a.box[3])
      .slice(0, max);
  }

  /**
   * Record one recognition result. Lock = same person on 2 consecutive reads (or 3 of the
   * last 5) above threshold; unlock after 3 reads in a row that disagree.
   */
  vote(t: Track, m: Match, now: number) {
    t.lastEmbed = now;
    const id = m.best.sim >= this.threshold ? m.best.id : null;
    t.votes.push(id); t.sims.push(m.best.sim);
    if (t.votes.length > 5) { t.votes.shift(); t.sims.shift(); }
    const n = t.votes.length;
    if (t.lock) {
      if (id === t.lock.id) t.lock.sim = 0.6 * t.lock.sim + 0.4 * m.best.sim;
      else if (n >= 3 && t.votes.slice(-3).every((v) => v !== t.lock!.id)) t.lock = null;
    }
    if (!t.lock && id) {
      const consecutive = n >= 2 && t.votes[n - 2] === id;
      const majority = t.votes.filter((v) => v === id).length >= 3;
      if (consecutive || majority) t.lock = { id, sim: m.best.sim, at: now };
    }
  }

  /** Single-shot identification for still photos (no temporal evidence available). */
  identifyOnce(t: Track, m: Match, now: number) {
    t.lastEmbed = now; t.votes = [m.best.sim >= this.threshold ? m.best.id : null]; t.sims = [m.best.sim];
    t.lock = t.votes[0] ? { id: t.votes[0], sim: m.best.sim, at: now } : null;
  }
}
