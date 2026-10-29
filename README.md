# Snooker Practice Log

An installable web app for snooker practice: design drills with table diagrams, run timed sessions with per-attempt scoring, and track averages and bests over time. Works offline once installed.

- `index.html`, `manifest.webmanifest`, `sw.js`, `icons/`: the app as served by GitHub Pages.
- `src/snooker-practice.html`: the page source.
- `tools/build-pwa.py`: rebuilds `index.html` from the source: `python3 tools/build-pwa.py src/snooker-practice.html index.html`

- `camera/`: test page for camera tracking (open `camera/` on the site). It finds the table and counts colour clearances live from the phone camera, or from a video file. `camera/vision.js` holds the vision code. `tools/analyse-video.js` runs the same code on a video with Node and ffmpeg: `node tools/analyse-video.js session.mp4`

Data is stored on the device. Use History, then Backup, to copy or restore it.
