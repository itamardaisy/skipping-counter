// Phase 1 — de-risk the iOS unknowns: camera in Home Screen (standalone) mode,
// inline playback, real stream framerate, and screen wake lock.

const $ = (id) => document.getElementById(id);
const video = $('cam');
const glow = $('glow');

const set = (id, text) => { $(id).textContent = text; };
const fail = (msg) => { $('err').textContent = msg; glow.className = 'bad'; };

// --- standalone detection ------------------------------------------------
// iOS reports Home Screen launches via navigator.standalone; the media query
// is the cross-browser equivalent. Either one counts.
const isStandalone =
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
set('d-standalone', isStandalone ? 'yes — Home Screen' : 'no — browser tab');

// --- screen wake lock ----------------------------------------------------
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator)) { set('d-wake', 'unsupported'); return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    set('d-wake', 'held');
    wakeLock.addEventListener('release', () => set('d-wake', 'released'));
  } catch (e) {
    set('d-wake', 'denied — ' + e.name);
  }
}
// iOS drops the lock whenever the app is backgrounded; re-take it on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock === null) keepAwake();
});

// --- framerate meter -----------------------------------------------------
// requestVideoFrameCallback fires once per *decoded camera frame*, so it
// measures the real capture rate rather than the display refresh rate.
let frames = 0, windowStart = 0;
function onFrame(now) {
  frames++;
  if (!windowStart) windowStart = now;
  const elapsed = now - windowStart;
  if (elapsed >= 500) {
    set('d-fps', (frames * 1000 / elapsed).toFixed(1));
    frames = 0; windowStart = now;
  }
  video.requestVideoFrameCallback(onFrame);
}

// --- camera --------------------------------------------------------------
async function startCamera() {
  set('d-cam', 'requesting…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        // 640x480 is plenty for pose landmarks and keeps the framerate high;
        // extra pixels cost inference time and buy no accuracy.
        width:  { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      },
    });

    video.srcObject = stream;
    await video.play();

    const s = stream.getVideoTracks()[0].getSettings();
    set('d-cam', 'live');
    set('d-res', `${s.width}x${s.height} @${s.frameRate ? Math.round(s.frameRate) : '?'}`);
    glow.className = 'ok';

    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
    else set('d-fps', 'rVFC unsupported');

    keepAwake();
  } catch (e) {
    set('d-cam', 'failed');
    fail(`${e.name}: ${e.message}`);
  }
}

// iOS only grants camera access from inside a user gesture.
$('start').addEventListener('click', () => {
  $('gate').classList.add('hidden');
  startCamera();
}, { once: true });

if (!window.isSecureContext) fail('Not a secure context — camera needs HTTPS.');
