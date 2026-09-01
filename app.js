import { FilesetResolver, PoseLandmarker }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs';
import { SkipDetector, bodySignal } from './detector.js';

const WASM  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/'
            + 'pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const $ = (id) => document.getElementById(id);
const video = $('cam'), glow = $('glow'), panel = $('panel');
const poseCv = $('pose'), poseCtx = poseCv.getContext('2d');
const graphCv = $('graph'), graphCtx = graphCv.getContext('2d');

const det = new SkipDetector();
let landmarker = null;
let lastTimestamp = 0;

// ---------------------------------------------------------------- model ----
// Start the 6 MB download immediately; the user still has to tap Start, so the
// wait usually costs nothing.
const modelReady = (async () => {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try { landmarker = await make('GPU'); }
  catch { landmarker = await make('CPU'); }
})();

modelReady.then(
  () => { $('start').disabled = false; $('start').textContent = 'Start'; },
  (e) => { $('err').textContent = `Model failed to load — ${e.message}`; },
);

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

  const signal = bodySignal(landmarks, video.videoWidth, video.videoHeight);
  const state = det.update(signal, t);

  history.push({ t, bp: state.bp, thresh: state.thresh, flash: state.flash });
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

let hitUntil = 0;
function render(s, landmarks) {
  $('count').textContent = s.count;
  $('time').textContent = mmss(s.activeTime);
  $('session').textContent = mmss(s.sessionTime);
  $('cadence').textContent = s.cadence ? Math.round(s.cadence) : '—';

  if (s.flash) hitUntil = performance.now() + 140;
  $('count').classList.toggle('hit', performance.now() < hitUntil);

  glow.className = !s.tracked ? 'bad' : s.skipping ? 'ok' : 'warn';
  $('r-fps').textContent = fps.toFixed(0);
  $('r-amp').textContent = Math.abs(s.bp).toFixed(3);
  $('r-thr').textContent = s.thresh.toFixed(3);
  $('r-state').textContent = !s.tracked ? 'no body' : s.skipping ? 'skipping' : 'idle';

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
  fitCanvas(poseCv);
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

  // where skips were counted
  graphCtx.fillStyle = '#fff';
  for (const p of history) {
    if (!p.flash) continue;
    graphCtx.beginPath();
    graphCtx.arc(x(p.t), y(p.bp), 2.6 * dpr, 0, Math.PI * 2);
    graphCtx.fill();
  }
}

// -------------------------------------------------------------- controls ----
$('reset').addEventListener('click', () => { det.reset(); history.length = 0; });
$('toggle').addEventListener('click', (e) => {
  const hidden = $('debug').classList.toggle('off');
  e.target.textContent = hidden ? 'Show graph' : 'Hide graph';
});
