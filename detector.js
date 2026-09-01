// Skip detection: pose landmarks -> body-relative height signal -> skip count.
// Deliberately free of DOM and MediaPipe references so the same code can be
// replayed frame-by-frame against a recorded session for tuning.

const L_SHOULDER = 11, R_SHOULDER = 12, L_HIP = 23, R_HIP = 24;
const MIN_VISIBILITY = 0.5;

/**
 * Reduce a pose to one number: vertical body position measured in torso
 * lengths, positive upwards.
 *
 * The hip midpoint is used because it is the most stable point on a skipping
 * body — the head bobs and tilts, the arms rotate, the feet leave frame.
 * Dividing by torso length makes the signal body-relative, so the same
 * thresholds hold whether the phone is two metres away or five, and survive
 * the skipper drifting closer or further mid-set.
 */
export function bodySignal(landmarks, videoW, videoH) {
  if (!landmarks) return null;
  const pts = [L_SHOULDER, R_SHOULDER, L_HIP, R_HIP].map((i) => landmarks[i]);
  if (pts.some((p) => !p || (p.visibility !== undefined && p.visibility < MIN_VISIBILITY))) return null;

  const [ls, rs, lh, rh] = pts;
  const shX = ((ls.x + rs.x) / 2) * videoW, shY = ((ls.y + rs.y) / 2) * videoH;
  const hipX = ((lh.x + rh.x) / 2) * videoW, hipY = ((lh.y + rh.y) / 2) * videoH;

  const torso = Math.hypot(shX - hipX, shY - hipY);
  if (!(torso > 12)) return null; // too small/degenerate to trust

  // Landmark y grows downward, so negate to make "up" positive.
  return { height: -hipY / torso, torso, hipX, hipY };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class SkipDetector {
  constructor(overrides = {}) {
    this.p = {
      tauFast: 0.045,     // s — smooths landmark jitter, keeps 1–5 Hz intact
      tauSlow: 0.35,      // s — baseline; two-pole high-pass at ~0.45 Hz
      tauAmp: 1.20,       // s — how fast the amplitude estimate adapts
      threshFrac: 0.35,   // trigger level as a fraction of bounce amplitude
      minAmp: 0.025,      // torso lengths — noise floor; jitter can't look rhythmic
      minInterval: 0.20,  // s between skips — rejects rates above 300 spm
      maxInterval: 0.95,  // s between skips — rejects rhythms below 63 spm
      evenness: 0.35,     // max fractional spread between adjacent intervals
      confirmBeats: 3,    // consecutive in-band bounces needed to open a run
      runTimeout: 1.40,   // s without a skip before the set is considered over
      lostTimeout: 0.50,  // s without a usable pose before we call it "lost"
      ...overrides,
    };
    this.reset();
  }

  reset() {
    this.count = 0;
    this.activeTime = 0;      // seconds actually spent skipping
    this.fast = null;         // fast EMA of the raw height
    this.slow = null;         // slow EMA — the baseline
    this.slow2 = 0;           // second high-pass pole, applied to the first
    this.bp = 0;              // band-passed signal, centred on zero
    this.meanAbs = 0;         // running mean |bp|, for amplitude estimation
    this.thresh = this.p.minAmp;
    this.armed = false;       // Schmitt trigger state: body is up
    this.fires = [];          // recent trigger times, not yet credited
    this.run = false;         // a confirmed skipping rhythm is under way
    this.lastCredited = -Infinity;
    this.lastT = null;
    this.lastSeen = -Infinity;
    this.tracked = false;
    this.setStart = 0;
    this.intervals = [];
    this.firstSkipT = null;
    this.flash = false;       // true on the frame a skip is counted
  }

  /**
   * @param sample result of bodySignal(), or null when no pose was found
   * @param t     seconds, monotonically increasing
   */
  update(sample, t) {
    const p = this.p;
    this.flash = false;
    const gap = t - this.lastSeen;

    if (sample) {
      const raw = sample.height;
      // After losing the body, the old filter state describes a different
      // pose entirely — restart from the new value rather than band-passing
      // the jump, which would look exactly like a bounce.
      if (this.fast === null || gap > p.lostTimeout) {
        this.fast = this.slow = raw;
        this.slow2 = 0;
        this.bp = 0;
        this.armed = false;
      } else {
        const dt = Math.min(Math.max(t - this.lastT, 0), 0.2); // survive stalls
        const aFast = 1 - Math.exp(-dt / p.tauFast);
        const aSlow = 1 - Math.exp(-dt / p.tauSlow);
        const aAmp  = 1 - Math.exp(-dt / p.tauAmp);

        this.fast += aFast * (raw - this.fast);
        this.slow += aSlow * (raw - this.slow);
        // One high-pass pole leaves enough slow residue to shift the signal
        // off zero, which makes low bounces miss a trigger rail. A second pole
        // rolls drift off steeply enough that the rails stay centred.
        const hp = this.fast - this.slow;
        this.slow2 += aSlow * (hp - this.slow2);
        this.bp = hp - this.slow2;

        this.meanAbs += aAmp * (Math.abs(this.bp) - this.meanAbs);
        // For a sine wave mean|x| = 2A/pi, so A ~= 1.571 * mean|x|.
        this.thresh = Math.max(p.threshFrac * 1.571 * this.meanAbs, p.minAmp);

        // Schmitt trigger: one count per full oscillation, immune to the
        // repeated crossings that break naive peak detection.
        if (!this.armed && this.bp > this.thresh) {
          this.armed = true;
        } else if (this.armed && this.bp < -this.thresh) {
          this.armed = false;
          this.#onFire(t);
        }
      }
      this.lastSeen = t;
    } else {
      this.armed = false; // never fire from stale state
    }

    this.tracked = t - this.lastSeen < p.lostTimeout;
    this.lastT = t;

    if (this.run && t - this.lastCredited > p.runTimeout) this.#endRun();
    return this.state(t);
  }

  /**
   * A Schmitt-trigger fire is a candidate bounce, not yet a skip.
   *
   * Skipping is distinguished from every other vertical body motion by being
   * *rhythmic*: a run of evenly spaced bounces inside a plausible cadence
   * band. Requiring that rhythm before crediting anything is what stops slow
   * rocking, a stumble, or someone walking into frame from registering. Once a
   * run is confirmed the buffered bounces are credited retroactively, so the
   * skips at the start of a set are not lost.
   */
  #onFire(t) {
    const p = this.p;
    this.fires.push(t);
    while (this.fires.length > p.confirmBeats) this.fires.shift();

    if (this.run) {
      const interval = t - this.lastCredited;
      if (interval >= p.minInterval && interval <= p.maxInterval) {
        this.#credit(t, interval);
        return;
      }
      this.#endRun(); // rhythm broke — a trip, or the set ended
    }
    this.#tryOpenRun();
  }

  #tryOpenRun() {
    const p = this.p;
    if (this.fires.length < p.confirmBeats) return;

    const gaps = [];
    for (let i = 1; i < this.fires.length; i++) gaps.push(this.fires[i] - this.fires[i - 1]);
    if (gaps.some((g) => g < p.minInterval || g > p.maxInterval)) return;
    // Even spacing: a real cadence, not two unrelated movements.
    const lo = Math.min(...gaps), hi = Math.max(...gaps);
    if ((hi - lo) / hi > p.evenness) return;

    this.run = true;
    this.setStart = this.fires[0];
    this.lastCredited = this.fires[0];
    this.count++;
    this.intervals.length = 0;
    for (const g of gaps) this.#credit(this.lastCredited + g, g);
    this.flash = true;
    this.fires.length = 0;
    if (this.firstSkipT === null) this.firstSkipT = this.setStart;
  }

  #credit(t, interval) {
    this.count++;
    this.flash = true;
    this.lastCredited = t;
    this.intervals.push(interval);
    if (this.intervals.length > 8) this.intervals.shift();
    if (this.firstSkipT === null) this.firstSkipT = t;
  }

  #endRun() {
    if (this.run) this.activeTime += this.lastCredited - this.setStart;
    this.run = false;
  }

  state(t) {
    const p = this.p;
    const skipping = this.run && t - this.lastCredited <= p.maxInterval;
    // Cap the live portion at where the run would time out, so the timer never
    // credits more than the finished set will actually be worth.
    const live = this.run
      ? Math.min(t - this.setStart, this.lastCredited - this.setStart + p.runTimeout)
      : 0;
    return {
      count: this.count,
      activeTime: this.activeTime + live,
      sessionTime: this.firstSkipT === null ? 0 : t - this.firstSkipT,
      cadence: this.intervals.length >= 2 ? 60 / median(this.intervals) : null,
      skipping,
      tracked: this.tracked,
      flash: this.flash,
      bp: this.bp,
      thresh: this.thresh,
    };
  }
}
