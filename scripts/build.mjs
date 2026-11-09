// Assemble the deployable app in www/: the web files plus MediaPipe's code,
// wasm runtime and pose models, so nothing is fetched from a CDN at run time.
// The same folder is served by Firebase Hosting and bundled into the iOS app.
//
//   npm run build
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const cache = join(root, '.cache', 'models');

const WEB_FILES = [
  'index.html', 'app.js', 'detector.js', 'rope.js', 'manifest.json',
  'apple-touch-icon.png', 'icon-512.png', 'privacy.html', 'support.html',
];
// lite and full ship with the app; heavy is optional (?model=heavy) and
// stays on Google's CDN rather than adding ~30 MB to every install.
const MODELS = ['lite', 'full'];
const modelUrl = (m) => 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/'
  + `pose_landmarker_${m}/float16/1/pose_landmarker_${m}.task`;

const exists = (p) => stat(p).then(() => true, () => false);

async function fetchModel(name) {
  const file = join(cache, `pose_landmarker_${name}.task`);
  if (await exists(file)) return file;
  process.stdout.write(`downloading pose_landmarker_${name}.task … `);
  const res = await fetch(modelUrl(name));
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  await mkdir(cache, { recursive: true });
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  console.log('done');
  return file;
}

const vision = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
if (!(await exists(vision))) {
  console.error('MediaPipe is not installed — run `npm install` first.');
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'vendor', 'tasks-vision'), { recursive: true });
await mkdir(join(out, 'models'), { recursive: true });

for (const f of WEB_FILES) await cp(join(root, f), join(out, f));
await cp(join(vision, 'vision_bundle.mjs'), join(out, 'vendor', 'tasks-vision', 'vision_bundle.mjs'));
await cp(join(vision, 'wasm'), join(out, 'vendor', 'tasks-vision', 'wasm'), { recursive: true });
for (const m of MODELS) {
  await cp(await fetchModel(m), join(out, 'models', `pose_landmarker_${m}.task`));
}
console.log('built www/');
