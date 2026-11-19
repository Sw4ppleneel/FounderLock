import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/800.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';
import { loadVision, Tracker, lightingHint, type Vision, type Track, type Person, type RGBA, type Face } from './vision';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage'), video = $<HTMLVideoElement>('video'), still = $<HTMLImageElement>('still');
const hud = $<HTMLCanvasElement>('hud'), ctx = hud.getContext('2d')!;
const card = $('card'), statusEl = $('status');

const GROUP_LABEL: Record<string, string> = {
  'distinguished-trustees': 'Distinguished Trustee',
  'founders-trustees': 'Founder & Trustee',
  founders: 'Founder',
  leap: 'LEAP · Plaksha',
};
const C = { blue: '#337dff', blueLight: '#669eff', blueVLight: '#99beff', green: '#37ecb3', grey: '#c4c4c4' };

let vision: Vision | null = null;
let tracker: Tracker;
let mode: 'idle' | 'live' | 'photo' = 'idle';
let facing: 'user' | 'environment' = matchMedia('(pointer: coarse)').matches ? 'environment' : 'user';
let mirrored = false;
let stream: MediaStream | null = null;
let selectedKey: number | null = null;     // a tapped reticle
let cardPerson: string | null = null;
let cardLostAt = 0;
let dismissed: string | null = null;        // person whose card was closed; reappears on a new lock
let detSize = 480;
let detAvg = 0;
const frame = document.createElement('canvas');
const fctx = frame.getContext('2d', { willReadFrequently: true })!;

/* ── intro ─────────────────────────────────────────────────────────────── */

function animateWord(el: HTMLElement, text: string) {
  // letters blur in one by one (LEAP HeroText); words stay unbreakable so names wrap between words
  let i = 0;
  const parts: Node[] = [];
  text.split(' ').forEach((word, w) => {
    if (w) parts.push(document.createTextNode(' '));
    const ws = document.createElement('span');
    ws.className = 'word';
    for (const ch of word) {
      const s = document.createElement('span');
      s.className = 'ch'; s.textContent = ch; s.style.animationDelay = `${i++ * 45}ms`;
      ws.append(s);
    }
    parts.push(ws);
  });
  el.replaceChildren(...parts);
}
const words = ['founder', 'trustee', 'builder', 'visionary'];
let wi = 0;
let cycler = 0;
const startCycler = () => { clearInterval(cycler); cycler = window.setInterval(() => { wi = (wi + 1) % words.length; animateWord($('cycle'), words[wi]); }, 2600); };
startCycler();

loadVision((f, label) => {
  $('progress-bar').style.width = `${Math.round(f * 100)}%`;
  $('progress-label').textContent = `${label} · ${Math.round(f * 100)}%`;
}).then((v) => {
  vision = v;
  tracker = new Tracker(v.threshold);
  const n = v.people.filter((p) => p.templates.length).length;
  $('progress-label').textContent = `ready · ${n} people enrolled · ${self.crossOriginIsolated ? 'multi-threaded' : 'single-threaded'}`;
  $<HTMLButtonElement>('btn-start').disabled = false;
}).catch((e) => showError(`Couldn't load the models: ${e.message ?? e}`));

function showError(msg: string) { const el = $('intro-error'); el.textContent = msg; el.hidden = false; }

function leaveIntro() {
  clearInterval(cycler);
  $('intro').classList.add('gone');
  document.querySelector<HTMLElement>('.controls')!.hidden = false;
  if (!history.state?.fl) history.pushState({ fl: 'scan' }, '');
}

/* ── navigation: Back button, logo, swipe and the system back gesture all go
      card -> scanner -> home, one step at a time ─────────────────────────── */

let swallowPop = 0; // popstate events we caused ourselves

function goHome(fromPop = false) {
  if (!fromPop) {
    const depth = history.state?.fl === 'card' ? 2 : history.state?.fl === 'scan' ? 1 : 0;
    if (depth) { swallowPop++; history.go(-depth); }
  }
  stopCamera();
  mode = 'idle';
  tracker?.reset();
  hideCard(true);
  selectedKey = null; dismissed = null;
  still.hidden = true; still.removeAttribute('src'); video.hidden = false;
  document.querySelector<HTMLElement>('.controls')!.hidden = true;
  $('intro').classList.remove('gone');
  $('intro-error').hidden = true;
  setStatus('idle');
  startCycler();
}

/** Hide the card instantly when switching source (camera <-> photo), keeping history in step. */
function dropCard() {
  hideCard(true);
  dismissed = null; selectedKey = null;
  if (history.state?.fl === 'card') { swallowPop++; history.back(); }
}

/** Close the card on purpose (✕, swipe, Back, face gone) and drop its history entry. */
function closeCard() {
  if (!cardPerson) return;
  if (tracker?.tracks.some((t) => t.lock?.id === cardPerson)) dismissed = cardPerson; // don't pop straight back up
  selectedKey = null;
  hideCard();
  if (history.state?.fl === 'card') { swallowPop++; history.back(); }
}

addEventListener('popstate', (e) => {
  if (swallowPop > 0) { swallowPop--; return; }
  const st = (e.state as { fl?: string } | null)?.fl;
  if (st === 'scan') {
    if (cardPerson) { if (tracker?.tracks.some((t) => t.lock?.id === cardPerson)) dismissed = cardPerson; selectedKey = null; hideCard(); }
  } else if (!st && mode !== 'idle') goHome(true);
});

$('btn-back').addEventListener('click', () => (cardPerson ? closeCard() : goHome()));
$('btn-home').addEventListener('click', () => goHome());

$('btn-start').addEventListener('click', async () => {
  if (await startCamera()) leaveIntro();
});

/* ── camera ────────────────────────────────────────────────────────────── */

async function startCamera(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) {
    showError(location.protocol === 'https:' || location.hostname === 'localhost'
      ? 'This browser has no camera access. Use "Scan a photo" instead.'
      : 'Camera needs HTTPS. Open the hosted link, or use "Scan a photo".');
    return false;
  }
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e: any) {
    showError(e?.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser settings and retry.' : `Camera error: ${e?.message ?? e}`);
    return false;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  const settings = stream.getVideoTracks()[0].getSettings();
  mirrored = settings.facingMode ? settings.facingMode === 'user' : facing === 'user';
  stage.classList.toggle('mirror', mirrored);
  still.hidden = true; video.hidden = false;
  $('btn-live').hidden = true; $('btn-flip').hidden = false;
  tracker.reset(); dropCard();
  frameRot = 0; orient.dims = ''; orient.tiltVotes = 0; orient.lastFaceAt = performance.now();
  mode = 'live';
  setStatus('scanning');
  requestAnimationFrame(liveLoop);
  return true;
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

$('btn-flip').addEventListener('click', () => { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); });
$('btn-live').addEventListener('click', () => startCamera());

/* ── rotation ──────────────────────────────────────────────────────────────
   The face models only work on roughly upright faces (measured: 100% to 30° of tilt, 92% at 45°,
   48% sideways, 0% upside down). So each frame is rotated by `rot` (0/90/180/270, clockwise)
   before detection, keeping every face within 45° of upright whatever way the phone is held.
   Boxes come back in rotated-frame pixels and are mapped back to the source for drawing. */

type Rot = 0 | 90 | 180 | 270;
/** How the processed frame relates to the source: rotation, scaled-source size, original size. */
type Geo = { rot: Rot; SW: number; SH: number; srcW: number; srcH: number };
let geo: Geo = { rot: 0, SW: 1, SH: 1, srcW: 1, srcH: 1 };
const norm = (r: number) => (((Math.round(r / 90) * 90) % 360) + 360) % 360 as Rot;

let sceneLuma = 128;
function grab(src: CanvasImageSource, w: number, h: number, maxSide: number, rot: Rot = 0): { img: RGBA; g: Geo } {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const SW = Math.round(w * s), SH = Math.round(h * s);
  const swap = rot === 90 || rot === 270;
  frame.width = swap ? SH : SW; frame.height = swap ? SW : SH;
  // x' = a·x + c·y + e,  y' = b·x + d·y + f
  if (rot === 90) fctx.setTransform(0, 1, -1, 0, SH, 0);
  else if (rot === 180) fctx.setTransform(-1, 0, 0, -1, SW, SH);
  else if (rot === 270) fctx.setTransform(0, -1, 1, 0, 0, SW);
  else fctx.setTransform(1, 0, 0, 1, 0, 0);
  fctx.drawImage(src, 0, 0, SW, SH);
  fctx.setTransform(1, 0, 0, 1, 0, 0);
  const d = fctx.getImageData(0, 0, frame.width, frame.height);
  let sum = 0, n = 0;
  for (let i = 0; i < d.data.length; i += 4 * 97) { sum += d.data[i] * 0.299 + d.data[i + 1] * 0.587 + d.data[i + 2] * 0.114; n++; }
  sceneLuma = sum / n;
  return { img: { data: d.data, width: d.width, height: d.height, channels: 4 }, g: { rot, SW, SH, srcW: w, srcH: h } };
}

/** Box in processed (rotated) frame pixels -> box in scaled-source pixels. */
function unrotate(b: number[], g: Geo): [number, number, number, number] {
  const back = ([px, py]: number[]) =>
    g.rot === 90 ? [py, g.SH - px] : g.rot === 180 ? [g.SW - px, g.SH - py] : g.rot === 270 ? [g.SW - py, px] : [px, py];
  const a = back([b[0], b[1]]), c = back([b[0] + b[2], b[1] + b[3]]);
  const x = Math.min(a[0], c[0]), y = Math.min(a[1], c[1]);
  return [x, y, Math.abs(c[0] - a[0]), Math.abs(c[1] - a[1])];
}

/** Clockwise tilt of a face in its frame, from the landmarks (mouth -> eyes). 0 = upright. */
function faceRoll(f: Face): number {
  const k = f.kps;
  const ex = (k[0][0] + k[1][0]) / 2, ey = (k[0][1] + k[1][1]) / 2, mx = (k[3][0] + k[4][0]) / 2, my = (k[3][1] + k[4][1]) / 2;
  const a = (Math.atan2(ey - my, ex - mx) * 180) / Math.PI + 90;
  return ((a + 540) % 360) - 180;
}

// live orientation state
let frameRot: Rot = 0;
const orient = { tiltTo: 0 as Rot, tiltVotes: 0, lastProbe: 0, probeIdx: 0, lastFaceAt: 0, dims: '' };
function setRot(r: Rot) {
  if (r === frameRot) return;
  frameRot = r;
  tracker.reset();
  orient.tiltVotes = 0; orient.probeIdx = 0;
}

/**
 * When the current rotation isn't working -- no face found, or a face that won't identify --
 * test one alternate rotation every ~0.5 s in the background (normal tracking keeps running, so
 * nothing flickers). Switch only on hard evidence: a recognised founder, or a clean upright face.
 */
async function probeRotation(now: number) {
  if (!vision || now - orient.lastProbe < 500) return;
  const big = tracker.tracks.filter((t) => t.seen === now).sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
  const noFace = !big && now - orient.lastFaceAt > 700;
  const stuck = big && !tracker.tracks.some((t) => t.lock) && big.votes.length >= 5 && big.votes.every((v) => v === null);
  if (!noFace && !stuck) return;
  orient.lastProbe = now;
  // sideways first (rotation lock + phone held landscape is the common case, upside down the rare
  // one); with no face in view both sideways rotations are tried in the same pass
  const order: number[][] = noFace ? [[90, 270], [180]] : [[90], [270], [180]];
  for (const step of order[orient.probeIdx++ % order.length]) {
    const r = norm(frameRot + step);
    const { img } = grab(video, video.videoWidth, video.videoHeight, 960, r);
    const f = (await vision.engine.detect(img, { size: detSize, threshold: 0.55 }))
      .filter((d) => d.box[2] >= 28).sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
    if (!f) continue;
    if (stuck) {
      const { m } = await vision.identify(img, f);
      if (m.best.sim >= vision.threshold) return setRot(r);
    } else if (Math.abs(faceRoll(f)) < 30 && f.score >= 0.7) return setRot(r);
  }
}

/** Something about the stream changed (rotation, resize): old boxes are in the wrong place. */
function onReorient() {
  if (mode !== 'live') return;
  tracker?.reset();
  if (video.paused) video.play().catch(() => {});
}
screen.orientation?.addEventListener?.('change', onReorient);
addEventListener('orientationchange', onReorient);
addEventListener('resize', () => { if (mode === 'live') tracker?.tracks.forEach((t) => { t.view = [...t.box]; }); });

/* ── exposure on the face (Android Chrome exposes these; elsewhere this silently does nothing) ── */
const exposure = { at: 0, comp: 0, ok: true };
async function meterOnFace(t: Track | undefined, now: number) {
  const track = stream?.getVideoTracks()[0];
  if (!track || !exposure.ok || now - exposure.at < 900) return;
  exposure.at = now;
  const caps: any = (track as any).getCapabilities?.() ?? {};
  const supported: any = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  const adv: any = {};
  if (t) {
    if (supported.pointsOfInterest) {
      const [x, y, w, h] = unrotate(t.box, geo);
      adv.pointsOfInterest = [{ x: (x + w / 2) / geo.SW, y: (y + h / 2) / geo.SH }];
    }
    // nudge compensation so the face, not the sky, is correctly exposed
    if (caps.exposureCompensation && t.q) {
      const { min, max, step } = caps.exposureCompensation;
      const st = Math.max(step || 0.33, 0.33);
      if (t.q.luma < 95) exposure.comp = Math.min(max, exposure.comp + st);
      else if (t.q.luma > 190) exposure.comp = Math.max(min, exposure.comp - st);
      adv.exposureCompensation = exposure.comp;
    }
  } else if (exposure.comp !== 0 && caps.exposureCompensation) {
    exposure.comp = 0; adv.exposureCompensation = 0;
  }
  if (caps.exposureMode?.includes?.('continuous')) adv.exposureMode = 'continuous';
  if (!Object.keys(adv).length) return;
  try { await track.applyConstraints({ advanced: [adv] }); } catch { exposure.ok = false; }
}

let busy = false;
async function liveLoop() {
  if (mode !== 'live' || !vision) return;
  // watchdog: some phones pause the video or end the track when rotated
  const vt = stream?.getVideoTracks()[0];
  if (vt && vt.readyState === 'ended') { startCamera(); return; }
  if (video.paused && !document.hidden) video.play().catch(() => {});
  if (!busy && video.readyState >= 2 && video.videoWidth) {
    busy = true;
    try {
      const dims = `${video.videoWidth}x${video.videoHeight}`;
      if (dims !== orient.dims) { // stream rotated with the screen: start over upright
        orient.dims = dims; frameRot = 0; tracker.reset(); orient.tiltVotes = 0;
      }
      const { img, g } = grab(video, video.videoWidth, video.videoHeight, 960, frameRot);
      const now = performance.now();
      const faces = (await vision.engine.detect(img, { size: detSize, threshold: 0.55 })).filter((f) => f.box[2] >= 28);
      const dt = performance.now() - now;
      detAvg = detAvg ? detAvg * 0.9 + dt * 0.1 : dt;
      if (detAvg > 150 && detSize > 320) { detSize = 320; detAvg = 0; }
      geo = g;
      // a sideways/tilted face reveals its tilt through its landmarks: rotate the frame to match
      const lead = [...faces].sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
      if (lead) {
        orient.lastFaceAt = now;
        const roll = faceRoll(lead);
        if (Math.abs(roll) >= 50) {
          const target = norm(frameRot - roll);
          orient.tiltVotes = target === orient.tiltTo ? orient.tiltVotes + 1 : 1;
          orient.tiltTo = target;
          if (orient.tiltVotes >= 2) { setRot(target); busy = false; requestAnimationFrame(liveLoop); return; }
        } else orient.tiltVotes = 0;
      }
      tracker.update(faces, now);
      for (const t of tracker.due(now)) {
        const { m, q } = await vision.identify(img, t.face);
        t.q = q; t.hint = lightingHint(q, sceneLuma, t.box[2]);
        tracker.vote(t, m, now);
      }
      const biggest = [...tracker.tracks].sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
      meterOnFace(tracker.tracks.find((t) => t.key === selectedKey) ?? biggest, now);
      refreshCard(now);
      await probeRotation(now);
    } catch (e) {
      console.error(e);
    }
    busy = false;
  }
  if (mode === 'live') requestAnimationFrame(liveLoop);
}

/* ── still photo ───────────────────────────────────────────────────────── */

async function scanPhoto(file: File) {
  if (!vision) return;
  mode = 'photo';
  stopCamera();
  leaveIntro();
  setStatus('scanning');
  const url = URL.createObjectURL(file);
  still.src = url;
  await still.decode();
  still.hidden = false; video.hidden = true;
  stage.classList.remove('mirror'); mirrored = false;
  $('btn-live').hidden = false; $('btn-flip').hidden = true;
  tracker.reset(); dropCard();
  const now = performance.now();
  // A photo can be sideways or upside down: try upright first, then the other three rotations,
  // and keep whichever recognises the most people (ties -> higher similarity).
  let best: { tr: Tracker; g: Geo; score: number } | null = null;
  for (const rot of [0, 90, 270, 180] as Rot[]) {
    const { img, g } = grab(still, still.naturalWidth, still.naturalHeight, 1600, rot);
    const faces = (await vision.engine.detect(img, { size: 640, threshold: 0.5 })).filter((f) => f.box[2] >= 20);
    const tr = new Tracker(vision.threshold);
    tr.update(faces, now);
    for (const t of tr.tracks) {
      const { m, q } = await vision.identify(img, t.face);
      t.q = q; t.hint = lightingHint(q, sceneLuma, t.box[2]);
      tr.identifyOnce(t, m, now);
      t.seen = Infinity; // freeze: tracks stay alive in photo mode
    }
    const locks = tr.tracks.filter((t) => t.lock);
    const upright = tr.tracks.filter((t) => Math.abs(faceRoll(t.face)) < 30).length;
    const score = locks.length * 10 + locks.reduce((a, t) => a + t.lock!.sim, 0) + upright * 0.01;
    if (!best || score > best.score) best = { tr, g, score };
    if (rot === 0 && locks.length && locks.every((t) => Math.abs(faceRoll(t.face)) < 30)) break; // upright and recognised
  }
  tracker = best!.tr; geo = best!.g;
  refreshCard(now);
  if (!tracker.tracks.length) setStatus('no face found');
  else if (!tracker.tracks.some((t) => t.lock)) setStatus('no match');
}

for (const id of ['file', 'file-intro']) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) scanPhoto(f);
    (e.target as HTMLInputElement).value = '';
  });
}

/* ── card ──────────────────────────────────────────────────────────────── */

function pickTrack(): Track | null {
  const locked = tracker?.tracks.filter((t) => t.lock) ?? [];
  if (!locked.length) return null;
  const sel = locked.find((t) => t.key === selectedKey);
  if (sel) return sel;
  return locked.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
}

function refreshCard(now: number) {
  const t = pickTrack();
  const tracks = tracker?.tracks ?? [];
  const allUnknown = tracks.length > 0 && tracks.every((x) => x.votes.length >= 4 && x.votes.every((v) => v === null));
  setStatus(t ? 'locked' : (mode === 'photo' && tracks.length) || allUnknown ? 'no match' : 'scanning');
  if (t) {
    cardLostAt = 0;
    if (dismissed && dismissed !== t.lock!.id) dismissed = null;
    if (dismissed === t.lock!.id) return;
    if (cardPerson !== t.lock!.id) showCard(vision!.byId.get(t.lock!.id)!);
    $('c-match').textContent = `● LOCKED · similarity ${t.lock!.sim.toFixed(2)}`;
  } else if (cardPerson && mode === 'live') {
    if (!cardLostAt) cardLostAt = now;
    else if (now - cardLostAt > 3000) closeCard();
  } else if (cardPerson && mode === 'photo') closeCard();
}

/* ── keep the card off the face it describes ─────────────────────────────
   Portrait phones: sheet at the bottom or top. Landscape/desktop: panel on the right or left.
   Chosen away from the face when the card opens; flips if the face sits under it for 0.5 s. */
const portraitPhone = matchMedia('(max-width: 720px) and (orientation: portrait)');
let side: 'bottom' | 'top' | 'right' | 'left' = 'right';
let coveredSince = 0;
function sideAwayFrom(t: Track | null) {
  const vertical = portraitPhone.matches;
  if (!t) return vertical ? 'bottom' : 'right';
  const [x, y, w, h] = toScreen(t.view);
  if (vertical) return y + h / 2 > hud.clientHeight * 0.55 ? 'top' : 'bottom';
  return x + w / 2 > hud.clientWidth * 0.55 ? 'left' : 'right';
}
function setSide(s2: typeof side) { side = s2; document.body.dataset.side = s2; }
function keepCardClear(now: number) {
  const t = pickTrack();
  if (!cardPerson || card.hidden || !t) { coveredSince = 0; return; }
  const [x, y, w, h] = toScreen(t.view);
  const c = card.getBoundingClientRect();
  const ix = Math.max(0, Math.min(x + w, c.right) - Math.max(x, c.left));
  const iy = Math.max(0, Math.min(y + h, c.bottom) - Math.max(y, c.top));
  if ((ix * iy) / Math.max(1, w * h) > 0.35) {
    if (!coveredSince) coveredSince = now;
    else if (now - coveredSince > 500) { setSide(sideAwayFrom(t)); coveredSince = 0; }
  } else coveredSince = 0;
}
portraitPhone.addEventListener?.('change', () => setSide(sideAwayFrom(pickTrack())));

function showCard(p: Person) {
  if (!cardPerson) setSide(sideAwayFrom(pickTrack()));
  if (history.state?.fl === 'scan') history.pushState({ fl: 'card' }, '');
  cardPerson = p.id;
  card.style.transform = '';
  card.hidden = false;
  card.classList.remove('out');
  card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
  $<HTMLImageElement>('c-photo').src = p.photo ? `/data/${p.photo}` : '/icon.svg';
  const tag = $('c-group');
  tag.textContent = GROUP_LABEL[p.group] ?? p.group;
  tag.classList.toggle('leap', p.group === 'leap');
  animateWord($('c-name'), p.name);
  $('c-role').textContent = p.role;
  $('c-edu').textContent = p.education;
  $('c-edu').hidden = !p.education;
  $('c-bio').textContent = p.bio.join(' ');
  $('c-bio').classList.remove('open');
  $('c-bio').hidden = !p.bio.length;
  $('c-links').replaceChildren(...p.links.map((l) => {
    const a = document.createElement('a');
    a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = `${l.label} ↗`;
    return a;
  }));
}

function hideCard(instant = false) {
  if (!cardPerson) return;
  cardPerson = null; cardLostAt = 0;
  if (instant) { card.hidden = true; return; }
  card.classList.add('out');
  setTimeout(() => { if (!cardPerson) card.hidden = true; }, 350);
}

$('c-bio').addEventListener('click', () => $('c-bio').classList.toggle('open'));
$('c-close').addEventListener('click', () => closeCard());

// swipe the card down to dismiss it (touch); only starts when the card is scrolled to the top
let dragY: number | null = null, dragDy = 0;
card.addEventListener('touchstart', (e) => { if (card.scrollTop <= 0) { dragY = e.touches[0].clientY; dragDy = 0; card.classList.remove('snap'); } }, { passive: true });
card.addEventListener('touchmove', (e) => {
  if (dragY === null) return;
  const dir = side === 'top' ? -1 : 1; // swipe toward the edge the card lives on
  dragDy = Math.max(0, dir * (e.touches[0].clientY - dragY));
  if (dragDy > 6) { card.classList.add('dragging'); card.style.transform = `translateY(${dir * dragDy}px)`; }
}, { passive: true });
card.addEventListener('touchend', () => {
  if (dragY === null) return;
  dragY = null; card.classList.remove('dragging');
  if (dragDy > 80) { card.style.transform = ''; closeCard(); }
  else { card.classList.add('snap'); card.style.transform = ''; }
});

function setStatus(s: string) {
  statusEl.className = `status ${s.split(' ')[0]}`;
  statusEl.querySelector('b')!.textContent = s;
}

/* ── HUD ───────────────────────────────────────────────────────────────── */

/** frame-pixel box -> screen-pixel box, honouring object-fit and mirroring */
/** processed-frame box -> screen box: undo the frame rotation, then object-fit + mirroring */
function toScreen(b: number[]): [number, number, number, number] {
  const W = hud.clientWidth, H = hud.clientHeight;
  const sw = mode === 'photo' ? still.naturalWidth : video.videoWidth || geo.srcW;
  const sh = mode === 'photo' ? still.naturalHeight : video.videoHeight || geo.srcH;
  const k = sw / geo.SW;
  const s = mode === 'photo' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  const ox = (W - sw * s) / 2, oy = (H - sh * s) / 2;
  const [bx, by, bw, bh] = unrotate(b, geo);
  let x = ox + bx * k * s;
  const y = oy + by * k * s, w = bw * k * s, h = bh * k * s;
  if (mirrored) x = W - x - w;
  return [x, y, w, h];
}

const easeOutBack = (x: number) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;

function brackets(x: number, y: number, w: number, h: number, color: string, lw: number, len: number) {
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
    ctx.moveTo(cx, cy + dy * len); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * len, cy);
  }
  ctx.stroke();
}

const coarse = matchMedia('(pointer: coarse)').matches;
const TOPBAR = () => (document.querySelector('.topbar') as HTMLElement).offsetHeight;
/** Label above the box; flips below it when the box is under the top bar. */
function chip(text: string, x: number, y: number, bg: string, fg: string, below: number) {
  ctx.font = `700 ${coarse ? 13 : 12}px "JetBrains Mono", monospace`;
  const tw = ctx.measureText(text).width;
  const W = hud.clientWidth;
  if (y - 22 < TOPBAR() + 4) y = Math.min(below, TOPBAR() + 30); // tuck inside the box, under the top bar
  let cx = Math.max(6, Math.min(W - tw - 22, x));
  // never draw the label under the card
  const c = cardRect;
  if (c && cx < c.right && cx + tw + 16 > c.left && y - 23 < c.bottom && y - 1 > c.top) {
    if (side === 'right') cx = Math.max(6, c.left - tw - 22);
    else if (side === 'left') cx = Math.min(W - tw - 22, c.right + 6);
    else if (side === 'top') y = Math.max(y, c.bottom + 26);
    else y = Math.min(y, c.top - 4);
  }
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(cx, y - 23, tw + 16, 22, 6); ctx.fill();
  ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.fillText(text, cx + 8, y - 12);
}

let cardRect: DOMRect | null = null;
function draw(now: number) {
  cardRect = cardPerson && !card.hidden ? card.getBoundingClientRect() : null;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = hud.clientWidth, H = hud.clientHeight;
  if (hud.width !== Math.round(W * dpr) || hud.height !== Math.round(H * dpr)) { hud.width = Math.round(W * dpr); hud.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (mode !== 'idle' && tracker) {
    for (const t of tracker.tracks) {
      for (let i = 0; i < 4; i++) t.view[i] += (t.box[i] - t.view[i]) * (mode === 'photo' ? 1 : 0.35);
      const pad = 0.12;
      let [x, y, w, h] = toScreen(t.view);
      x -= w * pad; y -= h * pad * 1.4; w *= 1 + 2 * pad; h *= 1 + 2 * pad * 1.2;
      const len = Math.max(12, Math.min(w, h) * 0.2);
      if (t.lock) {
        const p = Math.min(1, (now - t.lock.at) / 450);
        const grow = (1 - easeOutBack(p)) * 0.35;  // brackets snap in from 35% out
        const gx = x - w * grow, gy = y - h * grow, gw = w * (1 + 2 * grow), gh = h * (1 + 2 * grow);
        const sel = pickTrack() === t;
        if (p < 1) { ctx.globalAlpha = 1 - p; ctx.fillStyle = 'rgba(55,236,179,0.18)'; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; }
        ctx.shadowColor = C.green; ctx.shadowBlur = 14;
        brackets(gx, gy, gw, gh, C.green, sel ? 3 : 2, len);
        ctx.shadowBlur = 0;
        // centre ticks
        ctx.strokeStyle = 'rgba(55,236,179,0.6)'; ctx.lineWidth = 1.5; ctx.beginPath();
        ctx.moveTo(x + w / 2, y - 6); ctx.lineTo(x + w / 2, y + 6); ctx.moveTo(x + w / 2, y + h - 6); ctx.lineTo(x + w / 2, y + h + 6);
        ctx.moveTo(x - 6, y + h / 2); ctx.lineTo(x + 6, y + h / 2); ctx.moveTo(x + w - 6, y + h / 2); ctx.lineTo(x + w + 6, y + h / 2);
        ctx.stroke();
        const person = vision!.byId.get(t.lock.id)!;
        chip(`${person.name.toUpperCase()} · ${t.lock.sim.toFixed(2)}`, x, y - 4, C.green, '#000', y + h);
      } else {
        const age = now - t.born;
        const unknown = t.votes.length >= 4 && t.votes.every((v) => v === null);
        const col = unknown ? 'rgba(196,196,196,0.75)' : C.blueLight;
        brackets(x, y, w, h, col, 2, len);
        if (!unknown && mode === 'live') {
          // sweeping scan line
          const sy = y + ((age / 900) % 1) * h;
          const g = ctx.createLinearGradient(0, sy - 18, 0, sy);
          g.addColorStop(0, 'rgba(102,158,255,0)'); g.addColorStop(1, 'rgba(102,158,255,0.45)');
          ctx.fillStyle = g; ctx.fillRect(x + 2, Math.max(y, sy - 18), w - 4, Math.min(18, sy - y));
          ctx.fillStyle = C.blueVLight; ctx.fillRect(x + 2, sy, w - 4, 1.5);
        }
        const dots = '.'.repeat(1 + (Math.floor(now / 300) % 3));
        // after a second without a lock, say why if the light is the problem
        const hint = (age > 1000 || mode === 'photo') ? t.hint : null;
        const label = hint ?? (unknown || mode === 'photo' ? 'NOT A FOUNDER' : `SCANNING${dots}`);
        chip(label, x, y - 4, hint ? 'rgba(236,94,70,0.92)' : unknown || mode === 'photo' ? 'rgba(59,59,59,0.9)' : 'rgba(33,102,222,0.92)', '#fff', y + h);
      }
    }
  }
  keepCardClear(now);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// read-only hook for the headless tests (scripts/e2e_rotate.mjs)
(window as any).__fl = () => {
  const t = pickTrack();
  const c = card.getBoundingClientRect();
  return { face: t ? toScreen(t.view) : null, card: card.hidden ? null : [c.left, c.top, c.width, c.height], side, rot: frameRot, locked: t?.lock?.id ?? null };
};

// tap a reticle to pull up that person's card
hud.addEventListener('click', (e) => {
  const r = hud.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  for (const t of tracker?.tracks ?? []) {
    const [x, y, w, h] = toScreen(t.view);
    if (px >= x && px <= x + w && py >= y && py <= y + h && t.lock) {
      selectedKey = t.key; dismissed = null; cardPerson = null;
      refreshCard(performance.now());
      return;
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'live') { stopCamera(); mode = 'idle'; }
  else if (!document.hidden && mode === 'idle' && $('intro').classList.contains('gone')) startCamera();
});
