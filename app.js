import { SkipDetector, extractFrame } from './detector.js';
import { ropeRegions, ropeEnergies, toLuma } from './rope.js';

// MediaPipe is bundled into vendor/ and models/ by `npm run build`, so the
// iOS app and the hosted site work offline and start fast. A plain checkout
// has no vendor folder, so it falls back to the CDN.
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
const here = (p) => new URL(p, location.href).href;
let vision, LOCAL = true;
try { vision = await import('./vendor/tasks-vision/vision_bundle.mjs'); }
catch { vision = await import(`${CDN}/vision_bundle.mjs`); LOCAL = false; }
const { FilesetResolver, PoseLandmarker } = vision;

// Running inside the App Store build (Capacitor) rather than a browser.
const NATIVE = !!window.Capacitor?.isNativePlatform?.();

// ------------------------------------------------------------- settings ----
// Field-testing switches, all in the URL so the home-screen app needs no UI:
//   ?model=lite|full|heavy   pose model (default full: steadier on busy backgrounds)
//   ?flight=enforce          require both feet off the floor
//   ?rope=enforce            require the rope to be seen
const params = new URLSearchParams(location.search);
const MODEL_NAME = ['lite', 'full', 'heavy'].includes(params.get('model')) ? params.get('model') : 'full';
const WASM  = LOCAL ? here('./vendor/tasks-vision/wasm') : `${CDN}/wasm`;
const MODEL = LOCAL && MODEL_NAME !== 'heavy'
  ? here(`./models/pose_landmarker_${MODEL_NAME}.task`)
  : 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/'
    + `pose_landmarker_${MODEL_NAME}/float16/1/pose_landmarker_${MODEL_NAME}.task`;
const overrides = {};
if (params.get('flight')) overrides.flightGate = params.get('flight');
if (params.get('rope')) overrides.ropeGate = params.get('rope');

const $ = (id) => document.getElementById(id);
const video = $('cam'), glow = $('glow'), panel = $('panel');
const poseCv = $('pose'), poseCtx = poseCv.getContext('2d');
const graphCv = $('graph'), graphCtx = graphCv.getContext('2d');

const det = new SkipDetector(overrides);
let landmarker = null;
let lastTimestamp = 0;

// ---------------------------------------------------------------- model ----
// Start the download immediately; the user still has to tap Start, so the
// wait usually costs nothing.
const modelReady = (async () => {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    // Stricter presence and tracking: on a cluttered background a weak pose
    // is more often a coat on a chair than a person.
    minPosePresenceConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
  try { landmarker = await make('GPU'); }
  catch { landmarker = await make('CPU'); }
})();

modelReady.then(
  () => { $('start').disabled = false; $('start').textContent = 'Start'; },
  (e) => { $('err').textContent = `Model failed to load — ${e.message}`; },
);
$('r-model').textContent = MODEL_NAME;

// The store build opens on the counter alone: the signal graph stays one tap
// away, and recording sessions for tuning is a developer tool.
if (NATIVE) {
  $('debug').classList.add('off');
  $('toggle').textContent = 'Show graph';
  $('rec').hidden = true;
}

// ------------------------------------------------------------ wake lock ----
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not fatal — the screen may just dim */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock) keepAwake();
});

// ---------------------------------------------------------------- camera ----
async function start() {
  $('gate').classList.add('hidden');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 },
               frameRate: { ideal: 30 } },
    });
    video.srcObject = stream;
    await video.play();
    layoutPanel();
    keepAwake();
    await modelReady;
    video.requestVideoFrameCallback(onFrame);
  } catch (e) {
    $('gate').classList.remove('hidden');
    $('err').textContent = `${e.name}: ${e.message}`;
  }
}

/**
 * Fit the panel to the stream's aspect ratio inside whatever space the flex
 * column leaves. Matching it exactly means `object-fit: cover` never crops,
 * which is what keeps normalised landmark coordinates mapping linearly onto
 * the skeleton overlay.
 */
function layoutPanel() {
  const box = $('viewport');
  const ar = (video.videoWidth || 3) / (video.videoHeight || 4);
  const width = Math.min(box.clientWidth, box.clientHeight * ar);
  panel.style.width = `${Math.round(width)}px`;
  panel.style.height = `${Math.round(width / ar)}px`;
}

$('start').addEventListener('click', start, { once: true });
addEventListener('resize', layoutPanel);
addEventListener('orientationchange', () => setTimeout(layoutPanel, 250));

// ------------------------------------------------------------ rope pixels ----
// A small greyscale copy of each frame is enough to see the rope's streak and
// costs well under a millisecond.
const small = document.createElement('canvas');
const smallCtx = small.getContext('2d', { willReadFrequently: true });
let luma = null, prevLuma = null, spare = null;
let regions = null;

function sampleRope(frame) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const k = 192 / Math.max(vw, vh);
  const w = Math.round(vw * k), h = Math.round(vh * k);
  if (small.width !== w || small.height !== h) {
    small.width = w; small.height = h;
    luma = prevLuma = spare = null;
  }
  smallCtx.drawImage(video, 0, 0, w, h);
  const next = toLuma(smallCtx.getImageData(0, 0, w, h).data, w, h, spare);
  spare = prevLuma; prevLuma = luma; luma = next;
  regions = frame ? ropeRegions(frame) : null;
  if (!frame || !prevLuma) return null;
  return ropeEnergies(luma, prevLuma, w, h, regions);
}

// ----------------------------------------------------------------- loop ----
const history = [];          // recent samples, for the debug graph
const GRAPH_SECONDS = 4;
let frames = 0, fpsWindow = 0, fps = 0;

function onFrame(now) {
  const t = now / 1000;

  // detectForVideo demands strictly increasing timestamps.
  const ts = Math.max(lastTimestamp + 1, Math.round(now));
  lastTimestamp = ts;

  let landmarks = null;
  try {
    landmarks = landmarker.detectForVideo(video, ts).landmarks?.[0] ?? null;
  } catch { /* transient decode hiccup — treat as a dropped frame */ }

  const frame = extractFrame(landmarks, video.videoWidth, video.videoHeight);
  let rope = null;
  try { rope = sampleRope(frame); } catch { /* canvas read refused — run without rope */ }
  if (frame) frame.rope = rope;
  const state = det.update(frame, t);

  if (rec.on) recordFrame(t, landmarks, rope);

  history.push({ t, bp: state.bp, thresh: state.thresh, flash: state.flash, du: state.duFlash });
  while (history.length && t - history[0].t > GRAPH_SECONDS) history.shift();

  frames++;
  if (!fpsWindow) fpsWindow = t;
  if (t - fpsWindow >= 0.5) { fps = frames / (t - fpsWindow); frames = 0; fpsWindow = t; }

  render(state, landmarks);
  video.requestVideoFrameCallback(onFrame);
}

// --------------------------------------------------------------- render ----
const mmss = (s) => {
  const total = Math.floor(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const mark = (ok) => (ok === null || ok === undefined ? '·' : ok ? '✓' : '✗');

let hitUntil = 0, duUntil = 0;
function render(s, landmarks) {
  $('count').textContent = s.count;
  $('time').textContent = mmss(s.activeTime);
  $('session').textContent = mmss(s.sessionTime);
  $('cadence').textContent = s.cadence ? Math.round(s.cadence) : '—';
  $('du').textContent = s.du;

  const nowMs = performance.now();
  if (s.flash) hitUntil = nowMs + 140;
  if (s.duFlash) duUntil = nowMs + 400;
  $('count').classList.toggle('hit', nowMs < hitUntil);
  $('du-wrap').classList.toggle('hit', nowMs < duUntil);

  glow.className = !s.tracked ? 'bad' : s.skipping ? 'ok' : 'warn';
  $('r-fps').textContent = fps.toFixed(0);
  $('r-amp').textContent = Math.abs(s.bp).toFixed(3);
  $('r-thr').textContent = s.thresh.toFixed(3);
  $('r-state').textContent = s.reason ?? (s.skipping ? 'skipping' : 'idle');
  $('g-still').textContent = mark(s.still);
  $('g-flight').textContent = s.flight === null ? '·' : s.flight.toFixed(3);
  $('g-rope').textContent = `${s.ropeE.toFixed(1)} ${mark(s.ropeSeen)}`;
  $('g-spikes').textContent = s.spikes ?? '·';

  if (rec.on) $('rec').textContent = `■ ${mmss((nowMs - rec.wall0) / 1000)}`;

  drawPose(landmarks, s);
  drawGraph();
}

function fitCanvas(cv) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return dpr;
}

function drawPose(landmarks, s) {
  const dpr = fitCanvas(poseCv);
  const { width: w, height: h } = poseCv;
  poseCtx.clearRect(0, 0, w, h);
  if (!landmarks) return;

  poseCtx.strokeStyle = s.skipping ? '#3ddc84' : 'rgba(255,255,255,.55)';
  poseCtx.lineWidth = Math.max(2, w / 200);
  poseCtx.lineCap = 'round';
  poseCtx.beginPath();
  for (const { start, end } of PoseLandmarker.POSE_CONNECTIONS) {
    const a = landmarks[start], b = landmarks[end];
    if (!a || !b) continue;
    poseCtx.moveTo(a.x * w, a.y * h);
    poseCtx.lineTo(b.x * w, b.y * h);
  }
  poseCtx.stroke();

  // Where the rope is being looked for — only while the debug panel is open.
  if (regions && !$('debug').classList.contains('off')) {
    poseCtx.lineWidth = dpr;
    for (const [r, style] of [[regions.top, 'rgba(90,200,255,.8)'], [regions.bot, 'rgba(90,200,255,.45)'],
                              [regions.ctrl, 'rgba(255,255,255,.3)']]) {
      if (!r) continue;
      poseCtx.strokeStyle = style;
      poseCtx.setLineDash(r === regions.ctrl ? [4 * dpr, 4 * dpr] : []);
      poseCtx.strokeRect(r.x0 * w, r.y0 * h, (r.x1 - r.x0) * w, (r.y1 - r.y0) * h);
    }
    poseCtx.setLineDash([]);
  }
}

function drawGraph() {
  const dpr = fitCanvas(graphCv);
  const { width: w, height: h } = graphCv;
  graphCtx.clearRect(0, 0, w, h);
  if (history.length < 2) return;

  const now = history[history.length - 1].t;
  const scale = Math.max(0.06, ...history.map((p) => Math.abs(p.bp) * 1.15));
  const x = (t) => w * (1 - (now - t) / GRAPH_SECONDS);
  const y = (v) => h / 2 - (v / scale) * (h / 2 - 4 * dpr);

  // trigger rails
  const thr = history[history.length - 1].thresh;
  graphCtx.strokeStyle = 'rgba(255,255,255,.18)';
  graphCtx.lineWidth = dpr;
  graphCtx.setLineDash([3 * dpr, 3 * dpr]);
  for (const v of [thr, -thr]) {
    graphCtx.beginPath(); graphCtx.moveTo(0, y(v)); graphCtx.lineTo(w, y(v)); graphCtx.stroke();
  }
  graphCtx.setLineDash([]);

  // the band-passed body-height signal
  graphCtx.strokeStyle = '#3ddc84';
  graphCtx.lineWidth = 1.8 * dpr;
  graphCtx.beginPath();
  history.forEach((p, i) => (i ? graphCtx.lineTo(x(p.t), y(p.bp)) : graphCtx.moveTo(x(p.t), y(p.bp))));
  graphCtx.stroke();

  // where skips (white) and double unders (amber) were counted
  for (const p of history) {
    if (!p.flash) continue;
    graphCtx.fillStyle = p.du ? '#ffb020' : '#fff';
    graphCtx.beginPath();
    graphCtx.arc(x(p.t), y(p.bp), (p.du ? 3.6 : 2.6) * dpr, 0, Math.PI * 2);
    graphCtx.fill();
  }
}

// ------------------------------------------------------------- recording ----
// Records every frame's landmarks and rope energies (plus, optionally, the
// video) so sessions can be replayed against the detector with replay.mjs.
const rec = { on: false, frames: [], t0: 0, wall0: 0, startCount: 0, startDU: 0,
              mr: null, chunks: [], videoBlob: null, mime: '' };
const r4 = (v) => Math.round(v * 1e4) / 1e4;

function recordFrame(t, landmarks, rope) {
  rec.frames.push({
    t: Math.round((t - rec.t0) * 1000) / 1000,
    lm: landmarks ? landmarks.map((p) => [r4(p.x), r4(p.y), r4(p.z ?? 0), Math.round((p.visibility ?? 1) * 100) / 100]) : null,
    rope,
  });
}

function startRec() {
  if (!video.srcObject) return;
  // rVFC's `now` shares performance.now()'s clock, so frame times line up.
  Object.assign(rec, { on: true, frames: [], t0: performance.now() / 1000,
                       wall0: performance.now(), startCount: det.count, startDU: det.du,
                       chunks: [], videoBlob: null, mime: '' });
  $('rec').classList.add('on');
  if ($('rec-video').checked && 'MediaRecorder' in window) {
    const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
    try {
      rec.mr = new MediaRecorder(video.srcObject, { ...(mime && { mimeType: mime }), videoBitsPerSecond: 1_500_000 });
      rec.mime = rec.mr.mimeType || mime || 'video/mp4';
      rec.mr.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
      rec.mr.start(1000);
    } catch { rec.mr = null; }
  }
}

function stopRec() {
  rec.on = false;
  $('rec').classList.remove('on');
  $('rec').textContent = 'Record';
  const finish = () => {
    if (rec.chunks.length) rec.videoBlob = new Blob(rec.chunks, { type: rec.mime });
    $('app-count').textContent = det.count - rec.startCount;
    $('app-du').textContent = det.du - rec.startDU;
    $('sheet').classList.remove('hidden');
  };
  if (rec.mr && rec.mr.state !== 'inactive') { rec.mr.onstop = finish; rec.mr.stop(); }
  else finish();
  rec.mr = null;
}

function download(files) {
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  }
}

function closeSheet() {
  $('sheet').classList.add('hidden');
  rec.frames = []; rec.chunks = []; rec.videoBlob = null;
}

// Built synchronously inside the tap, because iOS only allows the share
// sheet while the user gesture is still live.
$('save').addEventListener('click', () => {
  const num = (id) => ($(id).value === '' ? null : Number($(id).value));
  const activity = $('activity').value;
  const meta = {
    version: 1,
    activity,
    expected: num('truth'),
    expectedDU: num('truth-du'),
    note: $('note').value,
    appCount: det.count - rec.startCount,
    appDU: det.du - rec.startDU,
    model: MODEL_NAME,
    videoW: video.videoWidth,
    videoH: video.videoHeight,
    detector: det.p,
    userAgent: navigator.userAgent,
    recordedAt: new Date().toISOString(),
  };
  const stamp = meta.recordedAt.slice(0, 19).replace(/[:T]/g, '-');
  const base = `skips-${activity}-${stamp}`;
  const files = [new File([JSON.stringify({ meta, frames: rec.frames })], `${base}.json`, { type: 'application/json' })];
  if (rec.videoBlob) {
    const ext = rec.mime.includes('mp4') ? 'mp4' : 'webm';
    files.push(new File([rec.videoBlob], `${base}.${ext}`, { type: rec.mime }));
  }
  if (navigator.canShare?.({ files })) {
    navigator.share({ files, title: base }).then(closeSheet, (e) => {
      if (e.name !== 'AbortError') { download(files); closeSheet(); }
    });
  } else {
    download(files);
    closeSheet();
  }
});
$('discard').addEventListener('click', closeSheet);

// -------------------------------------------------------------- controls ----
$('reset').addEventListener('click', () => { det.reset(); history.length = 0; });
$('rec').addEventListener('click', () => (rec.on ? stopRec() : startRec()));
$('toggle').addEventListener('click', (e) => {
  const hidden = $('debug').classList.toggle('off');
  e.target.textContent = hidden ? 'Show graph' : 'Hide graph';
});
