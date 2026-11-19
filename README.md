# FounderLock

**Live:** https://founderlock-two.vercel.app

Point a camera at a Plaksha founder. FounderLock locks onto their face and shows their profile.
Built for LEAP (AI Club at Plaksha). It is styled after LEAP's site (`LeapWebsite2024`: black background,
Inter + JetBrains Mono, blue `#337dff`/`#669eff`, green `#37ecb3`) and uses the glass panels from `Leverage_2026`.

**Everything runs on the device.** Camera frames never leave the browser. The site is static
files plus one data file that holds each person's face template.

## Stack

| Layer | What | Why |
|---|---|---|
| App | Vite 6 + vanilla TypeScript, no framework | one screen, small bundle (~22 KB gzipped JS), fast on phones |
| Inference | [onnxruntime-web](https://onnxruntime.ai) 1.20, WASM SIMD, multi-threaded | runs in every modern browser, including iOS Safari |
| Face detector | InsightFace **SCRFD-500M** (2.5 MB) | boxes + 5 landmarks in one pass |
| Face recogniser | InsightFace **ArcFace MobileFaceNet**, w600k (13.6 MB, 512-d) | measured 97% recall vs 64% for face-api.js on the same photos |
| UI | Canvas 2D HUD + DOM card, `@fontsource` Inter / JetBrains Mono | self-hosted fonts, so the page can be cross-origin isolated |
| Hosting | Vercel, static | COOP/COEP headers enable threaded WASM; HTTPS is required for the camera |
| Tooling (Node) | onnxruntime-node, sharp, Python stdlib scraper, Playwright | enrollment, evaluation and headless end-to-end tests |

## How it works

```
                    ┌──────────────── offline (Node, scripts/) ────────────────┐
plaksha.edu.in ──►  scrape_founders.py ──► founders.json + headshots
                    build_gallery.mjs  ──► detect → align → ArcFace → int8 templates
                                           └──► public/data/gallery.json  (312 KB, 229 templates)
                    └──────────────────────────────────────────────────────────┘

                    ┌──────────────── live (browser, src/) ────────────────────┐
camera frame (≤960 px)
  └► SCRFD @480 ──► face boxes + 5 landmarks
       └► tracker (IoU) ──► per face, round-robin:
            align to 112×112 ─► ArcFace ─► 512-d ─► cosine vs every template
              └ fails + washed out? retry once with tone normalisation (haze rescue)
            vote: lock when the same person scores ≥ 0.45 on 2 reads in a row (or 3 of 5)
  └► HUD brackets snap in ─► profile card (name, role, education, bio, links)
                    └──────────────────────────────────────────────────────────┘
```

1. **Enrollment (offline).** `scripts/scrape_founders.py` pulls all 117 founding members from
   `plaksha.edu.in/founding-members`. `scripts/build_gallery.mjs` runs each headshot (and its mirror image)
   through the same face engine the browser uses. It stores the 512-d embeddings as int8 with a
   per-vector scale (≤ 0.001 cosine error). 112 founders have photos and are recognisable. Extra people
   (currently Swapneel) are added from public photos through `data/extras.json`.
2. **One engine, two runtimes.** `src/engine/insight.js` is plain JS: SCRFD decoding + NMS, Umeyama
   similarity alignment, bilinear warp, ArcFace preprocessing, matching. Node (`onnxruntime-node`) and the
   browser (`onnxruntime-web`) run the same file, so offline and live embeddings are identical.
3. **Live loop.** Each frame is downscaled to ≤960 px and detected at 480 (drops to 320 if a phone is
   slow). Faces are tracked by IoU. Up to 3 faces per frame are identified, oldest-first, so every face
   in a crowd gets checked. Locked faces are re-verified every ~650 ms.
4. **Lock-on voting.** A face locks only after the same person clears cosine **0.45** on 2 consecutive
   reads, or on 3 of the last 5. It unlocks after 3 disagreeing reads in a row. A single bad frame can't
   lock or unlock anyone.
5. **Field lighting.**
   - Haze rescue: a washed-out face that fails gets one tone-normalised retry.
   - Exposure metered on the face (Android Chrome `pointsOfInterest` + `exposureCompensation`).
   - On-screen hints: `BACKLIT`, `TOO DARK`, `GLARE`, `HAZY`, `BLURRY`, `MOVE CLOSER`. The thresholds are
     calibrated on the test set (`LIGHT` in `src/vision.ts`).
6. **Any phone orientation.** The models only handle roughly upright faces (measured: 100% up to 30° of
   tilt, 92% at 45°, 48% sideways, 0% upside down). So each frame is rotated by 0/90/180/270° before
   detection, keeping faces within 45° of upright:
   - A sideways face shows its tilt through its eye/mouth landmarks, and the frame turns to match within 2 frames.
   - If no face is found, or a face won't identify, alternate rotations are probed in the background,
     sideways first. A switch needs a recognised founder or a clean upright face. This covers a phone
     held upside down, where the landmarks give no signal.
   - Rotating mid-session resets tracking. A watchdog resumes or restarts the camera if the phone pauses it.
   - Photo scans try all four rotations.
   - Rotated non-founder faces: 0 false accepts in 1,155 reads (max similarity 0.402).
7. **Layout follows the phone.** Portrait uses a bottom sheet and landscape a side panel. The card
   opens on the side away from the face and moves if the face ends up under it. The face's label
   never sits under the card. The intro scrolls instead of clipping on short screens, and notch
   insets are respected.
8. **Navigation.** The card closes with ✕, a swipe, the Back button, or the phone's back gesture.
   The next back goes home and stops the camera. Implemented with the History API.

## Measured accuracy (held-out photos, not the enrollment headshots)

Test material was collected with Bing Images: 934 web photos of the founders, 59 Plaksha faculty
headshots, and 739 generic "Indian CEO / professor / student" images (1,431 faces).
Any photo where the search label and the model disagreed was checked by eye. That audit found that
search results often show a *different* founder than the one searched for, so labels were corrected.
The verdicts are in `data/labels.json`.

| | result |
|---|---|
| Verified founder photos recognised (single frame, T=0.45) | **358 / 368 (97.3%)** |
| Recognised as the wrong founder | **0** |
| Plaksha faculty falsely matched | **0 / 59** (closest 0.389) |
| Generic non-founder faces falsely matched | **0 / 1,431** at 0.45. The 19 hits ≥ 0.45 were all real founders, checked by eye. |

An earlier attempt with face-api.js (dlib-style 128-d) got 64% recall before faculty started
matching. It was dropped.

### Field conditions (sun, dust, shadow), `scripts/robustness.mjs`

Simulated on all 368 verified founder photos and 500 non-founders. Single frame, live-app settings:

| condition | recall | wrong founder | false accepts |
|---|---|---|---|
| clean | 97.6% | 0 | 0/500 |
| harsh sun / overexposed | 90.8% | 0 | 0/500 |
| heavy dust haze | 90.5% (87.2% without the haze rescue) | 0 | 0/500 |

On a 120-photo sample: backlit 96%, light dust 97%, hard side shadow 97%, golden-hour cast 98%,
low light + noise 93%, motion blur 87%, dusty noon (haze + glare + shadow) 97%. There were 0 wrong
founders and 0 false accepts in every condition.

These are **per-frame** figures. Live mode votes across frames, so a hard frame only delays a lock.

Known limits: faces under ~28 px in the processed frame (people far back in a crowd) are ignored.
Overexposure that clips the face to white can't be recovered in software, so step into shade.
iOS Safari doesn't expose camera exposure controls, so face metering is Android-only.

## Repo layout

```
index.html, src/main.ts      UI: intro, camera, HUD, card, navigation
src/vision.ts                model loading, identify() + haze rescue, tracker + lock voting, lighting hints
src/engine/insight.js        shared face engine (detect, align, embed, match, tone tools)
src/styles.css               LEAP tokens, glass card, phone/outdoor styles
public/models/insight/       SCRFD + ArcFace ONNX
public/ort/                  onnxruntime-web WASM
public/data/                 gallery.json + card photos (generated)
data/                        scraped founders, headshots, extras.json, labels.json, eval outputs
scripts/                     scraper, gallery builder, harvesters, evaluation, robustness, e2e tests
```

## Run

```bash
npm install
npm run dev          # http://localhost:5173 (camera works on localhost; phones need HTTPS)
npm run build && npm run preview
```

## Update the gallery

```bash
npm run scrape                     # re-scrape plaksha.edu.in → data/founders.json + data/photos/
node scripts/build_gallery.mjs     # → public/data/gallery.json + card photos
```

To add someone else, put a public photo in `data/` and add an entry to `data/extras.json`
(`sources[].face` = index of the face, largest first). Then rebuild.

## Re-run the evaluation

```bash
python3 -I scripts/harvest_test_photos.py 8   # web photos of founders + faculty (local only, gitignored)
python3 -I scripts/harvest_impostors.py       # generic non-founder faces
node scripts/insight_describe.mjs             # embeddings for all test photos
node scripts/evaluate_insight.mjs             # accuracy table (uses data/labels.json)
node scripts/robustness.mjs 500 base,rescue   # field conditions
npx vite preview --port 4173 &
node scripts/e2e_live.mjs <dir> <id>=<image> ...   # live camera path via a fake webcam (PHONE=1 | LANDSCAPE=1, BASE=url)
node scripts/e2e_nav.mjs <dir> <face-image>        # every way out of a locked card
node scripts/e2e_rotate.mjs <dir> <face-image>     # landscape start + portrait<->landscape mid-lock
```

## Deploy

```bash
vercel deploy --prod --yes
```

`vercel.json` sets COOP/COEP for multi-threaded WASM and long-lived caching for the models.
`.vercelignore` keeps `data/` and `scripts/` off the server. Its entries must stay root-anchored
(`/data`), or `public/data` gets dropped as well.

## Licences and data

- Face models: InsightFace `buffalo_s` (SCRFD-500M, ArcFace w600k MobileFaceNet). InsightFace's
  pretrained models are released for **non-commercial research use**. That fits a student-club
  demo, but don't ship this commercially without replacing them.
- Profile text and photos come from Plaksha's public Founding Members pages and link back to them.
- Web test photos are kept locally for evaluation only. They are not committed or deployed (`.gitignore`).
