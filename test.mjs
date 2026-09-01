import { SkipDetector } from './detector.js';

const FPS = 30;
// Simulate a skipper: sine bounce of `amp` torso-lengths at `hz`, on a drifting
// baseline, with landmark jitter. Returns the detector's final state.
function run(segments, { jitter = 0.004, drift = 0.10, fps = FPS } = {}) {
  const det = new SkipDetector();
  let t = 0, phase = 0, out = null;
  for (const seg of segments) {
    const n = Math.round(seg.dur * fps);
    for (let i = 0; i < n; i++) {
      t += 1 / fps;
      let sample = null;
      if (!seg.lost) {
        // slow drift stands in for the skipper edging toward/away from camera
        let h = -3.2 + drift * Math.sin(2 * Math.PI * 0.07 * t);
        if (seg.hz) { phase += 2 * Math.PI * seg.hz / fps; h += seg.amp * Math.sin(phase); }
        h += jitter * (Math.random() * 2 - 1);
        sample = { height: h, torso: 90 };
      }
      out = det.update(sample, t);
    }
  }
  return out;
}

const cycles = (dur, hz) => Math.round(dur * hz);
let failures = 0;
const check = (label, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(38)} got ${String(got).padStart(6)}  want ~${want}`);
};

// --- counting accuracy across realistic cadences -------------------------
for (const [hz, amp] of [[1.6, 0.10], [2.0, 0.09], [2.6, 0.07], [3.2, 0.055]]) {
  const dur = 20;
  const s = run([{ dur: 2 }, { dur, hz, amp }, { dur: 3 }]);
  check(`${(hz * 60).toFixed(0)} spm, amp ${amp}`, s.count, cycles(dur, hz), 1);
}

// --- must NOT count -------------------------------------------------------
check('standing still',        run([{ dur: 20 }]).count, 0, 0);
check('slow sway (0.4 Hz)',    run([{ dur: 20, hz: 0.4, amp: 0.15 }]).count, 0, 0);
check('body lost then back',   run([{ dur: 4 }, { dur: 3, lost: true }, { dur: 4 }]).count, 0, 0);

// --- two sets: active time must exclude the rest --------------------------
const two = run([{ dur: 2 }, { dur: 15, hz: 2, amp: 0.09 }, { dur: 8 }, { dur: 15, hz: 2, amp: 0.09 }, { dur: 3 }]);
check('two sets: count',       two.count, cycles(30, 2), 2);
check('two sets: active time', Math.round(two.activeTime), 30, 2);
check('two sets: cadence',     Math.round(two.cadence), 120, 4);
check('rest excluded',         two.activeTime < 32, true, 0);

// --- amplitude that decays as the skipper tires ---------------------------
const tired = run([{ dur: 2 }, { dur: 12, hz: 2.2, amp: 0.10 }, { dur: 12, hz: 2.2, amp: 0.045 }, { dur: 3 }]);
check('fading amplitude',      tired.count, cycles(24, 2.2), 2);

console.log(failures ? `\n${failures} FAILING` : '\nall green');
