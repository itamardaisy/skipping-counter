// Replay recorded sessions (from the app's Record button) through the
// detector and compare with what really happened.
//
//   node replay.mjs recordings/*.json
//   node replay.mjs recordings/*.json --set flightGate=enforce --set flightMin=0.03
//   node replay.mjs recordings/walk.json --cycles      # per-bounce gate values
//
// Every detector parameter can be overridden with --set, so thresholds can be
// tuned against the whole library of recordings at once.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { SkipDetector, extractFrame } from './detector.js';

const args = process.argv.slice(2);
const files = [], overrides = {};
let showCycles = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set') {
    const [k, v] = args[++i].split('=');
    overrides[k] = Number.isNaN(Number(v)) ? v : Number(v);
  } else if (args[i] === '--cycles') showCycles = true;
  else files.push(args[i]);
}
if (!files.length) {
  console.log('usage: node replay.mjs <recording.json>... [--set key=value]... [--cycles]');
  process.exit(1);
}

const SKIPPING = new Set(['basic', 'alternate', 'double-under', 'mixed', 'high-knees', 'criss-cross']);
const rows = [];
let absErr = 0, truthSum = 0, falsePos = 0;

for (const file of files) {
  const { meta, frames } = JSON.parse(readFileSync(file, 'utf8'));
  const det = new SkipDetector(overrides);
  let s = null, lastCycle = null;
  const fails = { still: 0, ratio: 0, flight: 0, rope: 0, cycles: 0 };
  for (const fr of frames) {
    const lm = fr.lm && fr.lm.map(([x, y, z, v]) => ({ x, y, z, visibility: v }));
    const f = extractFrame(lm, meta.videoW, meta.videoH);
    if (f) f.rope = fr.rope ?? null;
    s = det.update(f, fr.t);
    const c = det.lastCycle;
    if (c && c !== lastCycle) {
      lastCycle = c;
      fails.cycles++;
      if (!c.still) fails.still++;
      if (!c.ratio) fails.ratio++;
      if (c.flight !== null && c.flight < det.p.flightMin) fails.flight++;
      if (c.spikes !== null && c.spikes < 1) fails.rope++;
      if (showCycles) {
        console.log(`${basename(file)}  t=${c.t.toFixed(2)}  V=${c.ampV.toFixed(3)} H=${c.ampH.toFixed(3)}`
          + `  still=${c.still} ratio=${c.ratio} flight=${c.flight?.toFixed(3) ?? '-'}`
          + `  passes=${c.spikes ?? '-'}${c.double ? ' DOUBLE' : ''}  count=${det.count}`);
      }
    }
  }
  const expected = meta.expected ?? (SKIPPING.has(meta.activity) ? null : 0);
  if (expected !== null) {
    absErr += Math.abs(s.count - expected);
    truthSum += expected;
    if (!SKIPPING.has(meta.activity)) falsePos += s.count;
  }
  const pct = (n) => (fails.cycles ? `${Math.round((100 * n) / fails.cycles)}%` : '-');
  rows.push({
    file: basename(file).replace(/^skips-/, '').replace(/\.json$/, ''),
    activity: meta.activity,
    expected: expected ?? '?',
    got: s.count,
    'app-then': meta.appCount,
    du: `${s.du}/${meta.expectedDU ?? '?'}`,
    bounces: fails.cycles,
    'not still': pct(fails.still),
    sideways: pct(fails.ratio),
    'no flight': pct(fails.flight),
    'no rope': pct(fails.rope),
    secs: frames.length ? Math.round(frames[frames.length - 1].t) : 0,
  });
}

console.table(rows);
if (truthSum || falsePos) {
  console.log(`total |error| ${absErr} over ${truthSum} real skips`
    + (truthSum ? ` (${((100 * absErr) / truthSum).toFixed(1)}%)` : '')
    + ` · counted during non-skipping recordings: ${falsePos}`);
}
if (Object.keys(overrides).length) console.log('overrides:', overrides);
