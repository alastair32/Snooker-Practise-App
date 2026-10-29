# Snooker Practice Log

An installable web app for snooker practice: design drills with table diagrams, run timed sessions with per-attempt scoring, and track averages and bests over time. Works offline once installed.

- `index.html`, `manifest.webmanifest`, `sw.js`, `icons/`: the app as served by GitHub Pages.
- `src/snooker-practice.html`: the page source.
- `tools/build-pwa.py`: rebuilds `index.html` from the source: `python3 tools/build-pwa.py src/snooker-practice.html index.html`

- `camera/`: camera tracking. `vision.js` finds the table and the balls in a frame; `engine.js` keeps track of which ball is which (starting from the drill diagram, watching the colour spots, following the respot rules), spots pots and misses, and scores attempts by the drill's metric (`DrillScorer`) or a two-player frame (`MatchScorer`). The app uses both when "Track with camera" is on. `camera/index.html` is the older colour-clearance test page.
- `tools/dump-detections.js` saves a video's detections to JSON lines; `tools/replay.js` runs the tracker and scorer over them (`node tools/replay.js det.jsonl lineup`), which is how the engine is checked against recorded drills.
- `android-app/`: the Android app (APK), the same web app wrapped with Capacitor. `.github/workflows/android.yml` builds it on every push (download it from the run's artifacts) and, from `main`, attaches `practice-log.apk` to the `android-latest` release. To sign every build with the same key (so a new APK installs over the old one and keeps its data), add repository secrets `ANDROID_KEYSTORE_BASE64` (the keystore file, base64) and `ANDROID_KEYSTORE_PASSWORD`, with key alias `practicelog`; without them each build gets a throwaway debug key. The app keeps its own data, separate from the browser version: move it across with History, then Backup.

Watch on another screen: on a laptop choose Watch a session (Today) to get a pairing code; on the phone tap Show on another screen in the session or match. The phone sends its camera and the score card directly to the laptop (WebRTC via PeerJS, `camera/peerjs.min.js`, MIT); the PeerJS broker is only used to find each other.

Camera tips: put the phone behind the black end, high enough to see all four pockets, and keep clear of the table for a few seconds while it finds the table.

Data is stored on the device. Use History, then Backup, to copy or restore it.
