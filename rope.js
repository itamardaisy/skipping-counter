// Rope sensing from raw pixels.
//
// The pose model never sees the rope, but the camera does: each time the rope
// sweeps over the head it leaves a thin, fast, motion-blurred streak across a
// region the body never enters. Frame-to-frame pixel change in that region
// spikes once per rope turn — twice per jump for a double under.
//
// The strongest row of change is used rather than the region's mean, because
// the rope crosses as a near-horizontal line: one bright row in an otherwise
// quiet patch. A control region beside it, at the same height, measures change
// that has nothing to do with the rope — the phone shaking on the floor when
// the skipper lands, auto-exposure, someone walking past — so it can be
// subtracted.
//
// Pure functions: frame buffers in, numbers out. app.js feeds it a small
// greyscale copy of each video frame.

/**
 * Regions to watch, as normalised {x0, y0, x1, y1} rectangles in video
 * coordinates, given a frame from extractFrame(). Any region that would fall
 * mostly outside the picture is null.
 */
export function ropeRegions(f) {
  if (!f) return { top: null, bot: null, ctrl: null };
  const { videoW: W, videoH: H, torso } = f;

  // Width: the rope spans the hands, which sit a little outside the hips.
  let half = 0.75 * torso;
  for (const w of [f.wristL, f.wristR]) if (w) half = Math.max(half, Math.abs(w.x - f.hipX) + 0.25 * torso);
  const x0 = f.hipX - half, x1 = f.hipX + half;

  const clip = (r, minH) => {
    const c = { x0: Math.max(0, r.x0), x1: Math.min(W, r.x1), y0: Math.max(0, r.y0), y1: Math.min(H, r.y1) };
    if (c.x1 - c.x0 < 0.5 * (r.x1 - r.x0) || c.y1 - c.y0 < minH) return null;
    return { x0: c.x0 / W, x1: c.x1 / W, y0: c.y0 / H, y1: c.y1 / H };
  };

  // Above the head, with a margin so the head's own bob stays out.
  const topR = { x0, x1, y0: f.headTopY - 0.75 * torso, y1: f.headTopY - 0.10 * torso };
  const top = clip(topR, 0.15 * torso);

  // Below the lower foot: the rope slaps the floor here.
  const feet = [f.footL, f.footR].filter((y) => y !== null);
  const footY = feet.length ? Math.max(...feet) : f.hipY + 2.2 * torso;
  const bot = clip({ x0, x1, y0: footY + 0.05 * torso, y1: footY + 0.40 * torso }, 0.12 * torso);

  // Control: same height as `top`, beside it, on whichever side has room.
  const w = x1 - x0, gapX = 0.35 * torso;
  const left = { x0: x0 - gapX - w, x1: x0 - gapX, y0: topR.y0, y1: topR.y1 };
  const right = { x0: x1 + gapX, x1: x1 + gapX + w, y0: topR.y0, y1: topR.y1 };
  const [first, second] = x0 >= W - x1 ? [left, right] : [right, left];
  const ctrl = clip(first, 0.15 * torso) ?? clip(second, 0.15 * torso);

  return { top, bot, ctrl };
}

/** RGBA bytes -> 8-bit luma. Reuses `out` when it is the right size. */
export function toLuma(rgba, w, h, out) {
  const n = w * h;
  if (!out || out.length !== n) out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return out;
}

/**
 * Strongest row of frame-to-frame change inside a region: the mean absolute
 * luma difference along each row, maximised over rows. Returns null when the
 * region is missing or smaller than a couple of pixels.
 */
export function regionEnergy(cur, prev, w, h, r) {
  if (!r || !cur || !prev || cur.length !== prev.length) return null;
  const x0 = Math.floor(r.x0 * w), x1 = Math.ceil(r.x1 * w);
  const y0 = Math.floor(r.y0 * h), y1 = Math.ceil(r.y1 * h);
  if (x1 - x0 < 3 || y1 - y0 < 2) return null;
  let best = 0;
  for (let y = y0; y < y1; y++) {
    let s = 0;
    const row = y * w;
    for (let x = x0; x < x1; x++) s += Math.abs(cur[row + x] - prev[row + x]);
    best = Math.max(best, s / (x1 - x0));
  }
  return best;
}

/** All three regions at once, rounded for compact recordings. */
export function ropeEnergies(cur, prev, w, h, regions) {
  const r = (v) => (v === null ? null : Math.round(v * 100) / 100);
  return {
    top: r(regionEnergy(cur, prev, w, h, regions.top)),
    bot: r(regionEnergy(cur, prev, w, h, regions.bot)),
    ctrl: r(regionEnergy(cur, prev, w, h, regions.ctrl)),
  };
}
