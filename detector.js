// Skip detection: pose landmarks -> per-frame body features -> skip count.
// Deliberately free of DOM and MediaPipe references so the same code can be
// replayed frame-by-frame against a recorded session for tuning
// (see replay.mjs).
//
// The core signal is still the vertical bounce of the trunk, but a bounce is
// only credited when the rest of the body agrees that it is a skip:
//
//   still  — the body stays in place. Walking always travels, either across
//            the frame or toward/away from the camera (the body grows or
//            shrinks). Skipping does not.
//   ratio  — the bounce is mostly vertical. Weight shifting side to side
//            while walking produces horizontal sway as large as the bob.
//   flight — both feet leave the ground in every cycle. This is true of every
//            rope skip in every style, because the rope has to pass under both
//            feet. Walking always keeps one foot down.
//   rope   — motion of the rope itself, sensed as a sharp burst of pixel
//            change just above the head (computed in rope.js). It separates
//            skipping from jumping without a rope, and two bursts in one
//            jump mean a double under.
//
// `still` and `ratio` are enforced. `flight` and `rope` start in "observe"
// mode — measured and shown in the debug readout, not yet blocking — until
// their thresholds are tuned against real recordings.

const NOSE = 0, L_SHOULDER = 11, R_SHOULDER = 12, L_WRIST = 15, R_WRIST = 16;
const L_HIP = 23, R_HIP = 24, L_ANKLE = 27, R_ANKLE = 28, L_HEEL = 29, R_HEEL = 30;
const MIN_VISIBILITY = 0.5;
const LIMB_VISIBILITY = 0.4;

const vis = (p) => (p ? (p.visibility ?? 1) : 0);

/**
 * Reduce a pose to the handful of measurements the detector needs, in video
 * pixels. Returns null when the trunk is not trustworthy.
 */
export function extractFrame(landmarks, videoW, videoH) {
  if (!landmarks) return null;
  const core = [L_SHOULDER, R_SHOULDER, L_HIP, R_HIP].map((i) => landmarks[i]);
  if (core.some((p) => !p || vis(p) < MIN_VISIBILITY)) return null;

  const X = (p) => p.x * videoW, Y = (p) => p.y * videoH;
  const [ls, rs, lh, rh] = core;
  const shX = (X(ls) + X(rs)) / 2, shY = (Y(ls) + Y(rs)) / 2;
  const hipX = (X(lh) + X(rh)) / 2, hipY = (Y(lh) + Y(rh)) / 2;

  const torso = Math.hypot(shX - hipX, shY - hipY);
  if (!(torso > 12)) return null; // too small/degenerate to trust

  // A foot is the mean of ankle and heel, and only when both are confidently
  // seen — mixing different point sets frame to frame would itself look like
  // the foot moving.
  const foot = (a, h) => {
    const pa = landmarks[a], ph = landmarks[h];
    if (vis(pa) < LIMB_VISIBILITY || vis(ph) < LIMB_VISIBILITY) return null;
    return (Y(pa) + Y(ph)) / 2;
  };
  const point = (i) => {
    const p = landmarks[i];
    return vis(p) >= LIMB_VISIBILITY ? { x: X(p), y: Y(p) } : null;
  };

  const nose = point(NOSE);
  // Crown of the head: roughly 0.6x the nose-to-shoulder drop above the nose.
  const headTopY = nose ? nose.y - 0.6 * (shY - nose.y) : shY - 0.75 * torso;

  return {
    // Hips and shoulders together: the whole trunk rises in a skip, and
    // averaging four points halves the independent landmark jitter.
    trunkY: 0.6 * hipY + 0.4 * shY,
    hipX, hipY, shY, torso, headTopY,
    footL: foot(L_ANKLE, L_HEEL),
    footR: foot(R_ANKLE, R_HEEL),
    wristL: point(L_WRIST),
    wristR: point(R_WRIST),
    videoW, videoH,
    rope: null, // filled in by the caller from rope.js, when available
  };
}

/** Back-compat helper: the old one-number signal, now on a stable scale. */
export function bodySignal(landmarks, videoW, videoH) {
  const f = extractFrame(landmarks, videoW, videoH);
  return f && { height: -f.trunkY / f.torso, torso: f.torso, hipX: f.hipX, hipY: f.hipY };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const ema = (prev, x, a) => prev + a * (x - prev);

export const DEFAULTS = {
  // band-pass on the trunk height
  tauFast: 0.030,      // s — light: the median-of-3 already removes spikes
  tauSlow: 0.35,       // s — baseline; two-pole high-pass at ~0.45 Hz
  tauAmp: 1.20,        // s — how fast the amplitude estimate adapts
  threshFrac: 0.35,    // trigger level as a fraction of bounce amplitude
  minAmp: 0.020,      // torso lengths — noise floor
  // rhythm
  minInterval: 0.20,   // s between skips — rejects rates above 300 spm
  maxInterval: 0.95,   // s between skips — rejects rhythms below 63 spm
  evenness: 0.30,      // max fractional spread between intervals to open a run
  confirmBeats: 4,     // consecutive good bounces needed to open a run
  rhythmLo: 0.55,      // inside a run, an interval must be within these
  rhythmHi: 1.70,      //   multiples of the run's median (double unders are slower)
  maxMisses: 2,        // consecutive rejected bounces that end a run
  runTimeout: 1.40,    // s without a skip before the set is considered over
  lostTimeout: 0.50,   // s without a usable pose before we call it "lost"
  // scale and tracking
  tauScale: 1.0,       // s — torso length smoothing. The raw length wobbles
                       //   with shoulder sway and must never reach the signal.
  jumpReset: 0.6,      // torso lengths moved in one frame = tracker switched target
  scaleJump: 0.30,     // fractional torso change in one frame = switched target
  // still: walking travels
  tauDrift: 0.5,       // s
  maxDrift: 0.35,      // torso lengths/s of sustained sideways travel
  maxScaleRate: 0.12,  // /s of sustained growth or shrink (walking toward/away)
  stillFrac: 0.8,      // fraction of a cycle's frames that must be still
  // ratio: the bounce is vertical
  minVHRatio: 1.0,
  // flight: both feet off the ground
  groundWindow: 2.5,   // s of foot history used to find the floor
  groundQuantile: 0.85,
  flightMin: 0.02,     // torso lengths both feet must clear
  flightFrac: 0.6,     // fraction of recent cycles that must show flight
  flightGate: 'observe', // 'observe' | 'enforce'
  // rope: motion bursts above the head
  ropeGate: 'observe', // 'observe' | 'enforce'
  ropeCtrlK: 1.0,      // how much of the control region's motion to subtract
  ropeK: 4.0,          // burst must exceed baseline by this many deviations
  ropeMinE: 2.5,       // ...and this absolute energy (luma levels)
  ropeRefractory: 0.12,// s between two bursts
  ropeTau: 1.5,        // s — baseline adaptation
  ropeFrac: 0.5,       // fraction of recent cycles with a burst = rope present
  doubleGap: [0.3, 0.7], // two bursts this far apart, as a fraction of the jump = double under
  doubleLift: 1.25,    // ...in a jump at least this much bigger than a single under
  recentCycles: 6,
};

export class SkipDetector {
  constructor(overrides = {}) {
    this.p = { ...DEFAULTS, ...overrides };
    this.reset();
  }

  reset() {
    this.count = 0;
    this.du = 0;
    this.activeTime = 0;
    this.#resetFilters();
    this.cycles = [];          // candidate bounces waiting to open a run
    this.recent = [];          // last few cycles, credited or not, for gate fractions
    this.run = false;
    this.lastCredited = -Infinity;
    this.lastFire = -Infinity;
    this.misses = 0;
    this.lastT = null;
    this.lastSeen = -Infinity;
    this.tracked = false;
    this.setStart = 0;
    this.intervals = [];
    this.firstSkipT = null;
    this.flash = false;
    this.duFlash = false;
    this.switches = 0;
    this.lastCycle = null;
    // rope baseline survives pose loss: it describes the scene, not the body
    this.ropeBase = null;
    this.ropeDev = 1;
    this.ropeE = 0;
    this.lastSpike = -Infinity;
    this.singleAmps = [];      // bounce size of recent single unders, the DU reference
  }

  #resetFilters() {
    this.raw3 = [];
    this.fast = this.slow = null;
    this.slow2 = 0;
    this.bp = 0;
    this.meanAbs = 0;
    this.thresh = this.p.minAmp;
    this.armed = false;
    this.fastX = this.slowX = null;
    this.slow2X = 0;
    this.bpH = 0;
    this.meanAbsH = 0;
    this.torsoS = null;
    this.xDrift = null; this.vx = 0;
    this.lnScale = null; this.scaleRate = 0;
    this.prev = null;
    this.feet = { L: [], R: [] };
    this.prevFlight = null;
    this.#resetCycle();
  }

  #resetCycle() {
    this.cyc = { vMax: -Infinity, vMin: Infinity, hMax: -Infinity, hMin: Infinity,
                 frames: 0, still: 0, flight: -Infinity, feetSeen: 0,
                 spikes: 0, spikeT: [], ropeSeen: 0 };
  }

  /**
   * @param f result of extractFrame() (optionally with f.rope), or null
   * @param t seconds, monotonically increasing
   */
  update(f, t) {
    const p = this.p;
    this.flash = false;
    this.duFlash = false;
    const gap = t - this.lastSeen;

    if (f && this.prev && gap <= p.lostTimeout && this.torsoS) {
      // A tracker that hops onto a different body (or a chair, or a poster)
      // produces a jump no human can make in one frame. Treat it as a fresh
      // start rather than band-passing the step, which would look like a bounce.
      const moved = Math.hypot(f.hipX - this.prev.hipX, f.hipY - this.prev.hipY) / this.torsoS;
      const grew = Math.abs(f.torso / this.torsoS - 1);
      if (moved > p.jumpReset || grew > p.scaleJump) {
        this.switches++;
        this.#resetFilters();
        this.armed = false;
      }
    }

    if (f) {
      if (this.fast === null || gap > p.lostTimeout) {
        this.#resetFilters();
        this.torsoS = f.torso;
        const v = -f.trunkY / f.torso;
        this.raw3 = [v];
        this.fast = this.slow = v;
        this.fastX = this.slowX = this.xDrift = f.hipX / f.torso;
        this.lnScale = Math.log(f.torso);
      } else {
        const dt = Math.min(Math.max(t - this.lastT, 1e-3), 0.2); // survive stalls
        const a = (tau) => 1 - Math.exp(-dt / tau);
        const aFast = a(p.tauFast), aSlow = a(p.tauSlow), aAmp = a(p.tauAmp);

        // The scale is smoothed hard. Dividing a pixel position by a raw,
        // wobbling torso length multiplies the wobble by the position —
        // a 2% wobble became a skip-sized fake bounce.
        this.torsoS = ema(this.torsoS, f.torso, a(p.tauScale));

        // --- vertical: median-of-3 kills single-frame spikes, then band-pass
        this.raw3.push(-f.trunkY / this.torsoS);
        if (this.raw3.length > 3) this.raw3.shift();
        const v = median(this.raw3);
        this.fast = ema(this.fast, v, aFast);
        this.slow = ema(this.slow, v, aSlow);
        const hp = this.fast - this.slow;
        this.slow2 = ema(this.slow2, hp, aSlow);
        this.bp = hp - this.slow2;
        this.meanAbs = ema(this.meanAbs, Math.abs(this.bp), aAmp);
        this.thresh = Math.max(p.threshFrac * 1.571 * this.meanAbs, p.minAmp);

        // --- horizontal, same band: sway that competes with the bounce
        const x = f.hipX / this.torsoS;
        this.fastX = ema(this.fastX, x, aFast);
        this.slowX = ema(this.slowX, x, aSlow);
        const hpX = this.fastX - this.slowX;
        this.slow2X = ema(this.slow2X, hpX, aSlow);
        this.bpH = hpX - this.slow2X;
        this.meanAbsH = ema(this.meanAbsH, Math.abs(this.bpH), aAmp);

        // --- travel: sustained sideways drift and growth/shrink rate
        const xd = ema(this.xDrift, x, a(p.tauDrift));
        this.vx = ema(this.vx, (xd - this.xDrift) / dt, a(p.tauDrift));
        this.xDrift = xd;
        const ls = ema(this.lnScale, Math.log(f.torso), a(0.25));
        this.scaleRate = ema(this.scaleRate, (ls - this.lnScale) / dt, a(p.tauDrift));
        this.lnScale = ls;

        // --- feet and rope, accumulated over the current cycle
        const still = Math.abs(this.vx) <= p.maxDrift && Math.abs(this.scaleRate) <= p.maxScaleRate;
        const c = this.cyc;
        c.frames++;
        if (still) c.still++;
        c.vMax = Math.max(c.vMax, this.bp); c.vMin = Math.min(c.vMin, this.bp);
        c.hMax = Math.max(c.hMax, this.bpH); c.hMin = Math.min(c.hMin, this.bpH);
        const fl = this.#flight(f, t);
        if (fl !== null) {
          c.feetSeen++;
          // Require both feet up on two consecutive frames, so one jittery
          // ankle cannot fake a flight.
          if (this.prevFlight !== null) c.flight = Math.max(c.flight, Math.min(fl, this.prevFlight));
        }
        this.prevFlight = fl;
        if (f.rope) this.#rope(f.rope, t);

        // Schmitt trigger: one count per full oscillation.
        if (!this.armed && this.bp > this.thresh) {
          this.armed = true;
        } else if (this.armed && this.bp < -this.thresh) {
          this.armed = false;
          this.#onFire(t);
        }
      }
      this.prev = f;
      this.lastSeen = t;
    } else {
      this.armed = false; // never fire from stale state
    }

    this.tracked = t - this.lastSeen < p.lostTimeout;
    this.lastT = t;

    if (this.run && t - this.lastCredited > p.runTimeout) this.#endRun();
    return this.state(t);
  }

  /** Height of the lower foot above the floor, in torso lengths, or null. */
  #flight(f, t) {
    const p = this.p;
    if (f.footL === null || f.footR === null) return null;
    const lift = (hist, y) => {
      hist.push([t, y]);
      while (hist.length && t - hist[0][0] > p.groundWindow) hist.shift();
      if (hist.length < 10) return null;
      // y grows downward: the floor is where the foot spends its lowest time.
      const ground = quantile(hist.map((h) => h[1]), p.groundQuantile);
      return (ground - y) / this.torsoS;
    };
    const l = lift(this.feet.L, f.footL), r = lift(this.feet.R, f.footR);
    return l === null || r === null ? null : Math.min(l, r);
  }

  #rope(r, t) {
    const p = this.p;
    if (r.top == null) return;
    const e = Math.max(0, r.top - p.ropeCtrlK * (r.ctrl ?? 0));
    this.ropeE = e;
    this.cyc.ropeSeen++;
    if (this.ropeBase === null) { this.ropeBase = e; return; }
    const a = 1 - Math.exp(-(1 / 30) / p.ropeTau);
    const spike = e > this.ropeBase + p.ropeK * Math.max(this.ropeDev, 0.5)
               && e > p.ropeMinE && t - this.lastSpike > p.ropeRefractory;
    if (spike) {
      this.lastSpike = t;
      this.cyc.spikes++;
      this.cyc.spikeT.push(t);
    } else {
      // Only quiet frames teach the baseline, so bursts don't raise the bar.
      this.ropeDev = ema(this.ropeDev, Math.abs(e - this.ropeBase), a);
      this.ropeBase = ema(this.ropeBase, e, a);
    }
  }

  /** Close the cycle that just ended at a trigger fire and judge it. */
  #onFire(t) {
    const p = this.p, c = this.cyc;
    const cycle = {
      t,
      ampV: c.vMax - c.vMin,
      ampH: Math.max(0, c.hMax - c.hMin),
      still: c.frames > 0 && c.still / c.frames >= p.stillFrac,
      flight: c.feetSeen >= Math.max(3, c.frames * 0.5) && c.flight > -Infinity ? c.flight : null,
      spikes: c.ropeSeen >= Math.max(3, c.frames * 0.5) ? c.spikes : null,
    };
    cycle.ratio = cycle.ampV >= p.minVHRatio * cycle.ampH;
    // A double under is two rope passes about half a jump apart — the rope
    // turns at an even speed. Two passes a whole cycle apart are just single
    // unders either side of the trigger point; two bursts at random spacing are
    // background (a screen, a passer-by) rather than the rope.
    const len = t - this.lastFire;
    cycle.double = cycle.spikes !== null && c.spikeT.slice(1).some((s, i) => {
      const gap = (s - c.spikeT[i]) / len;
      return gap >= p.doubleGap[0] && gap <= p.doubleGap[1];
    });
    this.#resetCycle();

    this.recent.push(cycle);
    while (this.recent.length > p.recentCycles) this.recent.shift();
    this.lastCycle = cycle;

    const prevFire = this.lastFire;
    this.lastFire = t;

    if (this.run) {
      const interval = t - prevFire;
      const med = this.intervals.length ? median(this.intervals) : interval;
      const inRhythm = interval >= p.minInterval && interval <= p.maxInterval
        && interval >= p.rhythmLo * med && interval <= p.rhythmHi * med;
      if (inRhythm && this.#cycleOk(cycle)) {
        this.misses = 0;
        this.#credit(cycle, interval);
        return;
      }
      if (++this.misses < p.maxMisses && interval <= p.maxInterval) return;
      this.#endRun(); // rhythm or posture broke — a trip, walking off, or the set ended
    }
    this.cycles.push(cycle);
    while (this.cycles.length > p.confirmBeats) this.cycles.shift();
    this.#tryOpenRun();
  }

  #cycleOk(c) {
    const p = this.p;
    if (!c.still || !c.ratio) return false;
    if (p.flightGate === 'enforce' && this.gateFraction('flight') < p.flightFrac) return false;
    if (p.ropeGate === 'enforce' && this.gateFraction('rope') < p.ropeFrac) return false;
    return true;
  }

  /** Share of recent cycles passing a soft gate; unknown cycles count as passing. */
  gateFraction(name) {
    const p = this.p;
    if (!this.recent.length) return 0;
    const pass = this.recent.filter((c) =>
      name === 'flight' ? c.flight === null || c.flight >= p.flightMin
                        : c.spikes === null || c.spikes >= 1);
    return pass.length / this.recent.length;
  }

  /** True when the rope detector is seeing the rope often enough to trust it. */
  ropeReliable() {
    const known = this.recent.filter((c) => c.spikes !== null);
    return known.length >= 3 && known.filter((c) => c.spikes >= 1).length / known.length >= this.p.ropeFrac;
  }

  #tryOpenRun() {
    const p = this.p, cs = this.cycles;
    if (cs.length < p.confirmBeats) return;

    const gaps = [];
    for (let i = 1; i < cs.length; i++) gaps.push(cs[i].t - cs[i - 1].t);
    if (gaps.some((g) => g < p.minInterval || g > p.maxInterval)) return;
    // Even spacing: a real cadence, not unrelated movements.
    const lo = Math.min(...gaps), hi = Math.max(...gaps);
    if ((hi - lo) / hi > p.evenness) return;
    if (!cs.every((c) => this.#cycleOk(c))) return;

    this.run = true;
    this.misses = 0;
    this.setStart = cs[0].t;
    this.intervals.length = 0;
    // Credit the buffered bounces retroactively so the start of a set isn't lost.
    this.lastCredited = cs[0].t;
    this.#creditCount(cs[0]);
    for (let i = 1; i < cs.length; i++) this.#credit(cs[i], gaps[i - 1]);
    this.cycles.length = 0;
    if (this.firstSkipT === null) this.firstSkipT = this.setStart;
  }

  #credit(cycle, interval) {
    this.lastCredited = cycle.t;
    this.intervals.push(interval);
    if (this.intervals.length > 8) this.intervals.shift();
    this.#creditCount(cycle);
  }

  #creditCount(cycle) {
    this.count++;
    this.flash = true;
    if (this.firstSkipT === null) this.firstSkipT = cycle.t;
    if (cycle.spikes === 1 && !cycle.double) {
      this.singleAmps.push(cycle.ampV);
      if (this.singleAmps.length > 20) this.singleAmps.shift();
    }
    // Two rope passes in one jump. Only trusted while the rope detector is
    // reliably seeing single passes too, and only in a jump clearly higher
    // than this skipper's single unders — so background flicker in the region
    // above the head cannot invent them on ordinary bounces.
    const ref = this.singleAmps.length >= 3 ? median(this.singleAmps) : null;
    if (cycle.double && this.ropeReliable() && ref !== null && cycle.ampV >= this.p.doubleLift * ref) {
      this.du++;
      this.duFlash = true;
    }
  }

  #endRun() {
    if (this.run) this.activeTime += this.lastCredited - this.setStart;
    this.run = false;
    this.misses = 0;
    this.cycles.length = 0;
  }

  state(t) {
    const p = this.p;
    const skipping = this.run && t - this.lastCredited <= p.maxInterval;
    const live = this.run
      ? Math.min(t - this.setStart, this.lastCredited - this.setStart + p.runTimeout)
      : 0;
    const still = Math.abs(this.vx) <= p.maxDrift && Math.abs(this.scaleRate) <= p.maxScaleRate;
    const c = this.lastCycle;
    // Why we are not counting, for the debug readout.
    let reason = null;
    if (!this.tracked) reason = 'no body';
    else if (!skipping && c && t - c.t < 1.5) {
      if (!still || !c.still) reason = 'moving';
      else if (!c.ratio) reason = 'sideways';
      else if (p.flightGate === 'enforce' && this.gateFraction('flight') < p.flightFrac) reason = 'no flight';
      else if (p.ropeGate === 'enforce' && this.gateFraction('rope') < p.ropeFrac) reason = 'no rope';
    }
    return {
      count: this.count,
      du: this.du,
      activeTime: this.activeTime + live,
      sessionTime: this.firstSkipT === null ? 0 : t - this.firstSkipT,
      cadence: this.intervals.length >= 2 ? 60 / median(this.intervals) : null,
      skipping,
      tracked: this.tracked,
      flash: this.flash,
      duFlash: this.duFlash,
      bp: this.bp,
      bpH: this.bpH,
      thresh: this.thresh,
      still,
      drift: this.vx,
      scaleRate: this.scaleRate,
      flight: c ? c.flight : null,
      spikes: c ? c.spikes : null,
      ropeE: this.ropeE,
      ropeSeen: this.ropeReliable(),
      reason,
    };
  }
}
