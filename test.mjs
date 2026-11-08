// Synthetic-body tests for the detector. Each scenario drives a full set of
// pose landmarks (trunk, head, wrists, feet) plus rope-region energies, so the
// gates are exercised the same way real frames exercise them.
//
//   node test.mjs
import { SkipDetector, extractFrame } from './detector.js';

const FPS = 30, W = 480, H = 640;
const TORSO = 110; // px — a skipper a few metres from a phone on the floor

// deterministic noise, so a failure reproduces
let seed = Number(process.env.SEED ?? 7);
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => { let s = 0; for (let i = 0; i < 4; i++) s += rand(); return (s - 2) * 1.73; };

/** Build 33 normalised landmarks for a simple upright body. */
function pose({ x = 240, y = 360, scale = 1, up = 0, liftL = 0, liftR = 0, wobble = 1, jitter = 1.5 }) {
  const T = TORSO * scale;
  const lm = Array.from({ length: 33 }, () => ({ x: x / W, y: y / H, z: 0, visibility: 0.2 }));
  const set = (i, px, py, v = 0.95) => {
    lm[i] = { x: (px + jitter * gauss()) / W, y: (py + jitter * gauss()) / H, z: 0, visibility: v };
  };
  const hy = y - up * T;
  const ground = y + 2.0 * T;
  set(23, x - 0.18 * T, hy); set(24, x + 0.18 * T, hy);
  set(11, x - 0.30 * T, hy - T * wobble); set(12, x + 0.30 * T, hy - T * wobble);
  set(0, x, hy - T * wobble - 0.45 * T);
  set(15, x - 0.65 * T, hy + 0.05 * T); set(16, x + 0.65 * T, hy + 0.05 * T);
  set(27, x - 0.15 * T, ground - (0.08 + liftL) * T); set(29, x - 0.15 * T, ground - (0.03 + liftL) * T);
  set(28, x + 0.15 * T, ground - (0.08 + liftR) * T); set(30, x + 0.15 * T, ground - (0.03 + liftR) * T);
  return lm;
}

/**
 * Run a list of segments through a detector. A segment is
 * { dur, body: (t, phase, k) => pose args, hz, rope: 'none'|'single'|'double'|null, lost }
 * `phase` advances at `hz`; `k` is the cycle index.
 */
function run(segments, overrides = {}) {
  const det = new SkipDetector(overrides);
  let t = 0, phase = 0, out = null, truth = 0, truthDU = 0;
  for (const seg of segments) {
    const n = Math.round(seg.dur * FPS);
    for (let i = 0; i < n; i++) {
      t += 1 / FPS;
      const prevFrac = (phase / (2 * Math.PI)) % 1;
      const prevK = Math.floor(phase / (2 * Math.PI));
      if (seg.hz) phase += 2 * Math.PI * seg.hz / FPS;
      const frac = (phase / (2 * Math.PI)) % 1, k = Math.floor(phase / (2 * Math.PI));
      if (seg.hz && seg.jumps && k > prevK) { truth++; if (seg.rope === 'double') truthDU++; }
      let f = null;
      if (!seg.lost) {
        f = extractFrame(pose((seg.body ?? (() => ({})))(t, phase, k)), W, H);
        if (seg.rope) {
          const crossed = (at) => k > prevK ? (prevFrac < at || frac >= at) : prevFrac < at && frac >= at;
          const passes = seg.rope === 'single' ? [0.75] : seg.rope === 'double' ? [0.55, 0.95] : [];
          const pass = passes.some(crossed);
          // landing shakes the phone: both regions see it equally
          const shake = frac < 0.12 ? 3 : 0;
          const top = 1 + 0.6 * rand() + shake + (pass ? 12 : 0);
          f.rope = { top, bot: 1, ctrl: 1 + 0.6 * rand() + shake };
        }
      }
      out = det.update(f, t);
    }
  }
  return { ...out, truth, truthDU };
}

// --- bodies ------------------------------------------------------------------
const still = () => ({});
// Two-foot bounce: trunk oscillates, both feet clear the floor together.
const bounce = (amp) => (t, ph) => ({ up: amp * Math.sin(ph), liftL: Math.max(0, 1.4 * amp * Math.sin(ph)), liftR: Math.max(0, 1.4 * amp * Math.sin(ph)) });
// Alternate foot: both clear the floor, the free foot higher on alternate beats, hips sway.
const alternate = (amp) => (t, ph, k) => {
  const s = Math.max(0, Math.sin(ph));
  return { x: 240 + 0.04 * TORSO * Math.sin(ph / 2), up: amp * Math.sin(ph),
           liftL: 1.2 * amp * s + (k % 2 ? 0.10 * s : 0), liftR: 1.2 * amp * s + (k % 2 ? 0 : 0.10 * s) };
};
// Walking: hip bobs once per step, feet alternate, one is always down.
const gait = (ph) => ({ up: 0.07 * Math.sin(ph), liftL: 0.30 * Math.max(0, Math.sin(ph / 2)), liftR: 0.30 * Math.max(0, -Math.sin(ph / 2)) });
const tri = (t, period) => { const u = (t / period) % 1; return u < 0.5 ? 4 * u - 1 : 3 - 4 * u; }; // -1..1
const walkAcross = (speed) => (t, ph) => ({ ...gait(ph), x: 240 + 2 * TORSO * tri(t, (8 * TORSO / (speed * TORSO))) });
const walkToward = (legSec) => (t, ph) => { const s = 1 + 0.3 * (1 + tri(t, 2 * legSec)); return { ...gait(ph), scale: s, y: 360 + 30 * (s - 1) }; };
const wobble = (pct) => (t) => ({ wobble: 1 + pct * Math.sin(2 * Math.PI * 1.8 * t) });

// --- harness -----------------------------------------------------------------
let failures = 0;
const check = (label, got, want, tol = 0) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} got ${String(got).padStart(5)}  want ${want}${tol ? ` ±${tol}` : ''}`);
};
const S = (dur, extra = {}) => ({ dur, body: still, ...extra });
const J = (dur, hz, body, extra = {}) => ({ dur, hz, body, jumps: true, ...extra });

console.log('— counting —');
for (const [hz, amp] of [[1.6, 0.10], [2.0, 0.09], [2.6, 0.07], [3.2, 0.055]]) {
  const r = run([S(2), J(20, hz, bounce(amp)), S(3)]);
  check(`two-foot ${(hz * 60).toFixed(0)} spm, amp ${amp}`, r.count, r.truth, 1);
}
{ const r = run([S(2), J(20, 2.5, alternate(0.05)), S(3)]);
  check('alternate foot 150 spm, hip sway', r.count, r.truth, 1); }
{ const r = run([S(2), J(20, 2.2, (t, ph) => ({ ...bounce(0.07)(t, ph), x: 240 + 0.08 * TORSO * t })), S(3)]);
  check('skipper drifting sideways slowly', r.count, r.truth, 1); }
{ const r = run([S(2), J(12, 2.2, bounce(0.10)), J(12, 2.2, bounce(0.045)), S(3)]);
  check('fading amplitude', r.count, r.truth, 2); }

console.log('— must not count —');
check('standing still', run([S(20)]).count, 0);
check('slow sway (0.4 Hz)', run([{ dur: 20, hz: 0.4, body: (t, ph) => ({ up: 0.15 * Math.sin(ph) }) }]).count, 0);
check('body lost then back', run([S(4), S(3, { lost: true }), S(4)]).count, 0);
check('torso-length wobble 3%, no motion', run([{ dur: 20, body: wobble(0.03) }]).count, 0);
check('walking back and forth across frame', run([{ dur: 30, hz: 1.8, body: walkAcross(1.2) }]).count, 0);
check('slow walk across (0.6 torso/s)', run([{ dur: 30, hz: 1.6, body: walkAcross(0.6) }]).count, 0);
check('walking toward/away from camera', run([{ dur: 30, hz: 1.8, body: walkToward(2.5) }]).count, 0);

console.log('— sets and timing —');
{ const r = run([S(2), J(15, 2, bounce(0.09)), S(8), J(15, 2, bounce(0.09)), S(3)]);
  check('two sets: count', r.count, r.truth, 2);
  check('two sets: active time', Math.round(r.activeTime), 30, 2);
  check('two sets: cadence', Math.round(r.cadence), 120, 4); }
{ const r = run([S(2), J(12, 2, bounce(0.08)), { dur: 12, hz: 1.8, body: walkAcross(1.2) }]);
  check('skip, then walk away: walking adds nothing', r.count, r.truth, 2); }
{ const hop = (t, ph) => ({ ...bounce(0.08)(t, ph), ...(t > 8 && t < 8.3 ? { x: 400 } : {}) });
  const r = run([S(2), J(16, 2, hop), S(3)]);
  check('tracker jumps to another target mid-set', r.count, r.truth, 3); }

console.log('— flight gate (enforce) —');
{ const enf = { flightGate: 'enforce' };
  const r = run([S(2), J(20, 2.2, bounce(0.06)), S(3)], enf);
  check('two-foot skipping still counts', r.count, r.truth, 1);
  const a = run([S(2), J(20, 2.5, alternate(0.05)), S(3)], enf);
  check('alternate-foot skipping still counts', a.count, a.truth, 1);
  check('walking in place', run([{ dur: 20, hz: 1.9, body: gait }], enf).count, 0); }

console.log('— rope gate (enforce) and double unders —');
{ const enf = { ropeGate: 'enforce' };
  const r = run([S(2), J(20, 2.2, bounce(0.06), { rope: 'single' }), S(3)], enf);
  check('skipping with rope counts', r.count, r.truth, 1);
  check('...and no double unders', r.du, 0);
  check('jumping without a rope', run([S(2), J(20, 2.2, bounce(0.06), { rope: 'none' }), S(3)], enf).count, 0);
  const d = run([S(2), J(10, 2.2, bounce(0.06), { rope: 'single' }), J(10, 1.7, bounce(0.12), { rope: 'double' }), S(3)], enf);
  check('mixed set: total jumps', d.count, d.truth, 2);
  check('mixed set: double unders', d.du, d.truthDU, 2); }
{ const d = run([S(2), J(10, 2.2, bounce(0.06), { rope: 'single' }), J(10, 1.7, bounce(0.12), { rope: 'double' }), S(3)]);
  check('double unders counted in observe mode too', d.du, d.truthDU, 3); }

console.log(failures ? `\n${failures} FAILING` : '\nall green');
process.exitCode = failures ? 1 : 0;
