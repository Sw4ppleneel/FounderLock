// Face engine shared by the browser app and the Node enrollment/eval scripts.
// SCRFD-500M (detector + 5 landmarks)  ->  similarity-align to 112x112  ->  ArcFace MobileFaceNet (512-d).
// Pure JS apart from the ONNX runtime, so offline enrollment and the live app produce identical embeddings.

/** @typedef {{data: Uint8Array|Uint8ClampedArray, width: number, height: number, channels: 3|4}} RGBImage */
/** @typedef {{box: [number, number, number, number], score: number, kps: number[][]}} Face */

const ARCFACE_DST = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041],
];
const STRIDES = [8, 16, 32];

export class FaceEngine {
  /** @param {any} ort onnxruntime module (node or web) @param {any} det InferenceSession @param {any} rec InferenceSession */
  constructor(ort, det, rec) { this.ort = ort; this.det = det; this.rec = rec; }

  static async create(ort, detModel, recModel, sessionOptions = {}) {
    const det = await ort.InferenceSession.create(detModel, sessionOptions);
    const rec = await ort.InferenceSession.create(recModel, sessionOptions);
    return new FaceEngine(ort, det, rec);
  }

  /**
   * Detect faces. `size` = square network input (multiple of 32); smaller is faster.
   * @param {RGBImage} img @returns {Promise<Face[]>}
   */
  async detect(img, { size = 640, threshold = 0.5, nms = 0.4 } = {}) {
    const scale = Math.min(size / img.width, size / img.height);
    const nw = Math.round(img.width * scale), nh = Math.round(img.height * scale);
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    // Letterbox (top-left aligned, zero padding = -127.5/128) with bilinear resize, RGB, (x-127.5)/128.
    input.fill(-127.5 / 128);
    const { data, width: W, height: H, channels: C } = img;
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(H - 1, (y + 0.5) / scale - 0.5);
      const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(H - 1, y0 + 1), fy = Math.max(0, sy - y0);
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(W - 1, (x + 0.5) / scale - 0.5);
        const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(W - 1, x0 + 1), fx = Math.max(0, sx - x0);
        const i00 = (y0 * W + x0) * C, i01 = (y0 * W + x1) * C, i10 = (y1 * W + x0) * C, i11 = (y1 * W + x1) * C;
        const o = y * size + x;
        for (let c = 0; c < 3; c++) {
          const v = (data[i00 + c] * (1 - fx) + data[i01 + c] * fx) * (1 - fy) + (data[i10 + c] * (1 - fx) + data[i11 + c] * fx) * fy;
          input[c * plane + o] = (v - 127.5) / 128;
        }
      }
    }
    const feeds = { [this.det.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, size, size]) };
    const out = await this.det.run(feeds);
    const names = this.det.outputNames;
    /** @type {Face[]} */
    const cands = [];
    STRIDES.forEach((stride, si) => {
      const scores = out[names[si]].data, boxes = out[names[si + 3]].data, kps = out[names[si + 6]].data;
      const fw = size / stride;
      for (let i = 0; i < scores.length; i++) {
        if (scores[i] < threshold) continue;
        const cell = i >> 1; // 2 anchors per cell
        const cx = (cell % fw) * stride, cy = Math.floor(cell / fw) * stride;
        const b = [cx - boxes[i * 4] * stride, cy - boxes[i * 4 + 1] * stride, cx + boxes[i * 4 + 2] * stride, cy + boxes[i * 4 + 3] * stride].map((v) => v / scale);
        const k = [];
        for (let j = 0; j < 5; j++) k.push([(cx + kps[i * 10 + j * 2] * stride) / scale, (cy + kps[i * 10 + j * 2 + 1] * stride) / scale]);
        cands.push({ box: [b[0], b[1], b[2] - b[0], b[3] - b[1]], score: scores[i], kps: k });
      }
    });
    cands.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const c of cands) if (keep.every((k) => iou(k.box, c.box) < nms)) keep.push(c);
    return keep;
  }

  /** 512-d L2-normalised embedding of one detected face. @param {RGBImage} img @param {Face} face */
  async embed(img, face, { tone = false } = {}) {
    const crop = alignCrop(img, face.kps);
    if (tone) toneNormalise(crop, tone === true ? 0 : tone);
    const out = await this.rec.run({ [this.rec.inputNames[0]]: new this.ort.Tensor('float32', crop, [1, 3, 112, 112]) });
    return l2norm(out[this.rec.outputNames[0]].data);
  }
}

/**
 * Per-face tone normalisation on an aligned 112x112 CHW crop (values in [-1, 1]).
 * Stretches luminance between its 2nd and 98th percentile over the central face region, so a
 * backlit, sun-bleached or dust-hazed face spans the same tonal range as a studio headshot.
 * Colour ratios are kept (one gain/offset for all channels).
 * `onlyBelowRange` > 0 makes it adaptive: only faces whose 2-98% luminance range (0..255 scale)
 * is narrower than this get stretched -- i.e. washed-out (dust, haze, glare) faces.
 */
export function toneNormalise(crop, onlyBelowRange = 0) {
  const P = 12544, hist = new Uint32Array(256);
  let n = 0;
  for (let y = 24; y < 104; y++) for (let x = 20; x < 92; x++) { // skin + features, not background
    const i = y * 112 + x;
    const l = 0.299 * crop[i] + 0.587 * crop[P + i] + 0.114 * crop[2 * P + i];
    hist[Math.max(0, Math.min(255, Math.round((l + 1) * 127.5)))]++; n++;
  }
  const pct = (q) => { let c = 0; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= q * n) return v; } return 255; };
  const lo = pct(0.02), hi = pct(0.98);
  if (hi - lo < 8) return crop; // flat patch: nothing sensible to stretch
  if (onlyBelowRange && hi - lo >= onlyBelowRange) return crop; // adaptive: contrast is fine, leave it
  const gain = 230 / (hi - lo), off = 12 - lo * gain; // map [lo,hi] -> [12,242] in 0..255 space
  for (let i = 0; i < crop.length; i++) {
    const v = (crop[i] + 1) * 127.5 * gain + off;
    crop[i] = Math.max(0, Math.min(255, v)) / 127.5 - 1;
  }
  return crop;
}

/**
 * Frame-level auto-levels for the detector: if the frame's luminance is squeezed (haze, glare,
 * underexposure), stretch its 1st..99th percentile to full range. Returns a new image or the input.
 */
export function autoLevels(img) {
  const { data, width, height, channels: C } = img;
  const hist = new Uint32Array(256), step = Math.max(1, Math.floor((width * height) / 40000));
  let n = 0;
  for (let p = 0; p < width * height; p += step) { const i = p * C; hist[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++; n++; }
  const pct = (q) => { let c = 0; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= q * n) return v; } return 255; };
  const lo = pct(0.01), hi = pct(0.99);
  if (hi - lo > 200 || hi - lo < 8) return img; // already full-range (or blank)
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  const out = new (data.constructor)(data.length);
  for (let i = 0; i < data.length; i++) out[i] = (C === 4 && i % 4 === 3) ? data[i] : lut[data[i]];
  return { data: out, width, height, channels: C };
}

/**
 * Lighting/sharpness read-out for one face, measured on the aligned 112x112 crop so it is
 * independent of how big the face is in the frame.
 *   luma  - mean brightness 0..255 of the central face region
 *   range - 2nd..98th percentile luminance spread (low = washed out / hazy / flat)
 *   sharp - mean |Laplacian| / range (low = motion blur or defocus)
 */
export function faceQuality(img, face) {
  const crop = alignCrop(img, face.kps), P = 12544;
  const L = new Float32Array(P);
  for (let i = 0; i < P; i++) L[i] = (0.299 * crop[i] + 0.587 * crop[P + i] + 0.114 * crop[2 * P + i] + 1) * 127.5;
  const vals = [];
  let sum = 0, lap = 0, nl = 0;
  for (let y = 24; y < 104; y++) for (let x = 20; x < 92; x++) {
    const i = y * 112 + x; vals.push(L[i]); sum += L[i];
    lap += Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - 112] - L[i + 112]); nl++;
  }
  vals.sort((a, b) => a - b);
  const range = vals[Math.floor(vals.length * 0.98)] - vals[Math.floor(vals.length * 0.02)];
  return { luma: sum / vals.length, range, sharp: lap / nl / Math.max(range, 1) };
}

/** Similarity transform (Umeyama) mapping src points onto ARCFACE_DST; returns [a, b, tx, ty] with x' = a*x - b*y + tx, y' = b*x + a*y + ty. */
export function similarity(src, dst = ARCFACE_DST) {
  const n = src.length;
  let mxs = 0, mys = 0, mxd = 0, myd = 0;
  for (let i = 0; i < n; i++) { mxs += src[i][0]; mys += src[i][1]; mxd += dst[i][0]; myd += dst[i][1]; }
  mxs /= n; mys /= n; mxd /= n; myd /= n;
  let sxx = 0, sxy = 0, var_s = 0;
  for (let i = 0; i < n; i++) {
    const xs = src[i][0] - mxs, ys = src[i][1] - mys, xd = dst[i][0] - mxd, yd = dst[i][1] - myd;
    sxx += xs * xd + ys * yd;  // sum of dot products
    sxy += xs * yd - ys * xd;  // sum of cross products
    var_s += xs * xs + ys * ys;
  }
  const a = sxx / var_s, b = sxy / var_s;
  return [a, b, mxd - (a * mxs - b * mys), myd - (b * mxs + a * mys)];
}

/** Warp the face to the 112x112 ArcFace template; returns CHW float32 RGB normalised to [-1, 1]. */
export function alignCrop(img, kps) {
  const [a, b, tx, ty] = similarity(kps);
  // inverse of [[a,-b],[b,a]] is 1/(a²+b²) * [[a,b],[-b,a]]
  const det = a * a + b * b;
  const out = new Float32Array(3 * 112 * 112);
  const { data, width: W, height: H, channels: C } = img;
  for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) {
    const u = x - tx, v = y - ty;
    const sx = (a * u + b * v) / det, sy = (-b * u + a * v) / det;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const o = y * 112 + x;
    for (let c = 0; c < 3; c++) {
      const p = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : data[(yy * W + xx) * C + c]);
      const val = (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy;
      out[c * 12544 + o] = (val - 127.5) / 127.5;
    }
  }
  return out;
}

export function l2norm(v) {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}

export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

/**
 * Match one embedding against the gallery. Gallery entry = {id, templates: Float32Array[]}.
 * Score per person = best cosine over their templates.
 */
export function match(gallery, emb) {
  let best = { id: null, sim: -1 }, second = { id: null, sim: -1 };
  for (const g of gallery) {
    let s = -1; for (const t of g.templates) { const c = cosine(emb, t); if (c > s) s = c; }
    if (s > best.sim) { second = best; best = { id: g.id, sim: s }; } else if (s > second.sim) second = { id: g.id, sim: s };
  }
  return { best, second };
}
