# Skipping Counter

A zero-install iPhone web app that watches you skip through the front camera and
counts your skips and your actual training time.

Open the page, tap **Add to Home Screen**, prop the phone on the floor a few
metres away, and skip. No App Store, no expiry, no cost.

## How it works

MediaPipe `PoseLandmarker` tracks body landmarks each frame. The vertical
position of the **hip midpoint** — the most stable point on a skipping body —
is divided by the shoulder-to-hip distance, so the signal is body-relative and
works at any distance from the camera. That signal is band-passed and fed to a
Schmitt trigger, which counts exactly one skip per bounce cycle. The timer runs
only while skips are actually landing, so it measures real training time
rather than wall clock.

## Files

| file | role |
| --- | --- |
| `index.html` | markup and styles |
| `app.js` | camera, pose loop, timer, UI |
| `detector.js` | signal processing and skip counting (isolated so it can be replayed against recorded video) |

## Development

Static files, no build step. Serve locally with:

    python3 -m http.server 8000

Camera access needs a secure context, so `localhost` works on a desktop
browser but testing on the phone requires the deployed HTTPS URL.
