# Skipping Counter

A zero-install iPhone web app that watches you skip through the front camera and
counts your skips, your double unders and your actual training time.

Open the page, tap **Add to Home Screen**, prop the phone on the floor a few
metres away, angled up so your whole body is in frame with some space above
your head, and skip. No App Store, no expiry, no cost.

## How it works

MediaPipe `PoseLandmarker` (the `full` model by default) tracks body landmarks
each frame. The vertical position of the trunk, measured in torso lengths, is
band-passed and fed to a Schmitt trigger that fires once per bounce cycle.

Walking also bobs the hips at a skipping cadence, so a bounce is only credited
when the rest of the body agrees it is a skip:

| gate | what it checks | status |
| --- | --- | --- |
| **still** | the body is not travelling across the frame or growing/shrinking (walking toward/away) | enforced |
| **ratio** | the bounce is mostly vertical, not side-to-side sway | enforced |
| **flight** | both feet leave the floor every cycle — true of every rope skip, never of walking | measured; enforce with `?flight=enforce` |
| **rope** | a sharp burst of pixel motion just above the head as the rope passes | measured; enforce with `?rope=enforce` |

Bounces must also come in an even rhythm (four in a row to open a set), and
every bounce inside a set is re-checked. A tracker that suddenly jumps to a
different target (another person, a coat on a chair) resets the filters
instead of being counted.

**Double unders** are two rope passes about half a jump apart, in a jump
clearly higher than your single unders. The app learns your single-under
height from the first few skips, so start a double-under set with a few
singles.

The timer runs only while skips are landing, so it measures real training time.

## Field-testing switches

Add to the URL:

- `?model=lite|full|heavy` — pose model (`full` default; `lite` is faster on older phones)
- `?flight=enforce` — require both feet off the floor
- `?rope=enforce` — require the rope to be seen

The debug panel shows each gate live: `still ✓/✗`, `flight` (how high the lower
foot cleared the floor, in torso lengths), `rope` (motion energy above the
head, ✓ when the rope is being seen) and `passes` (rope passes in the last jump).
The blue boxes on the video are where the rope is being looked for.

## Recording sessions for tuning

1. Tap **Record**, do one thing (a set of skips, walking around, …), tap again.
2. Pick what you were doing and enter the real counts, then **Save / Share** —
   on iPhone, AirDrop to the Mac or save to Files.
3. Put the `.json` files (and videos) in `recordings/` and run:

       node replay.mjs recordings/*.json
       node replay.mjs recordings/*.json --set flightGate=enforce --set flightMin=0.03
       node replay.mjs recordings/some-set.json --cycles

`replay.mjs` reruns the detector over each recording and prints the counts
against the truth, plus what fraction of bounces failed each gate.

## Files

| file | role |
| --- | --- |
| `index.html` | markup and styles |
| `app.js` | camera, pose loop, rope pixel sampling, recorder, timer, UI |
| `detector.js` | body features, gates and skip counting (no DOM, replayable) |
| `rope.js` | rope regions and frame-difference energy (no DOM) |
| `test.mjs` | synthetic-body tests: skipping styles, walking, double unders |
| `replay.mjs` | runs recorded sessions through the detector |
| `privacy.html`, `support.html` | pages the App Store links to |
| `scripts/build.mjs` | assembles `www/` with MediaPipe bundled |
| `scripts/ios-setup.sh` | one-time native tweaks after `npx cap add ios` |
| `capacitor.config.json` | iOS shell: bundle ID, app name, web folder |
| `firebase.json` | hosting for `www/` |

## Development

Needs Node 22+. The source files run as they are (MediaPipe then loads from
the CDN); `npm run build` assembles `www/` with MediaPipe's code, wasm and the
lite/full pose models bundled, which is what the site and the iOS app ship.

    npm install
    npm test            # synthetic detector tests
    npm run serve       # build, then serve www/ on http://localhost:8000

Camera access needs a secure context, so `localhost` works on a desktop
browser but testing on the phone requires the deployed HTTPS URL.

## Web: Firebase Hosting (GCP project `skipping-counter-app`)

One-time:

    npm install -g firebase-tools
    firebase login
    firebase projects:addfirebase skipping-counter-app

Deploy by hand with `npm run deploy:web`. To deploy on every push instead,
add a service-account key as the repository secret `FIREBASE_SERVICE_ACCOUNT`
(`firebase init hosting:github` does this for you); until then the GitHub
Action builds and tests but skips the deploy. Privacy and support pages are at
`/privacy` and `/support`.

## iOS app (Capacitor)

The same web app, bundled into a native shell. One-time, on a Mac with Xcode:

    npm install
    npm run ios:setup   # build www/, create ios/, camera text, icon, portrait, iPhone-only, screen stays on

Then, after every change to the web files:

    npm run ios         # rebuild, copy into the iOS project, open Xcode

Commit the generated `ios/` folder. Store listing text is in
`store/app-store.md`; the app icon and launch screen are in `resources/`.
