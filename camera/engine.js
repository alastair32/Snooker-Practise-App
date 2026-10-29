// Ball tracking and scoring on top of vision.js detections.
//
// TableTracker keeps a model of every ball on the table with its identity (cue, red, yellow ... black).
// Identities start from where balls are expected (colours on their spots, as in the drill diagram) and are
// then carried by position: a ball that hasn't moved keeps its name, so a pink is never mistaken for a red
// just because they look alike. Each time the table settles it compares the new picture with the model:
//   - a ball still where it was keeps its identity;
//   - a ball under the player or inside a cluster of touching balls is assumed still there;
//   - a ball that moved is matched to the most similar missing ball;
//   - a ball that vanished during a shot was potted (moving balls are also followed into pockets);
//   - a ball that appears without a shot was placed by hand; on a colour spot it is a re-spot.
// Re-spots follow the rules: a colour goes on its own spot, or if that is covered, the highest-value
// free spot. So a ball appearing on the pink spot is the black if the black spot was covered.
//
// Scorers turn shots into attempts: DrillScorer for the app's drill metrics and MatchScorer for free play.
(function (root) {
  "use strict";
  const TW = 1778, TL = 3569;
  // Spots in table mm, origin at the far-left (baulk end) corner as seen from the camera at the black end.
  // The app's diagrams put the black at the top (y = 324); in camera space the baulk is far (y small).
  const SPOT_MM = { yellow: [TW / 2 - 292, 737], brown: [TW / 2, 737], green: [TW / 2 + 292, 737], blue: [TW / 2, TL / 2], pink: [TW / 2, TL * 3 / 4], black: [TW / 2, TL - 324] };
  const COLOURS = ["yellow", "green", "brown", "blue", "pink", "black"];
  const SPOT_ORDER = ["yellow", "green", "brown", "blue", "pink", "black"];   // order of det.spots (vision.js SPOT_NAMES)
  const VALUE = { red: 1, yellow: 2, green: 3, brown: 4, blue: 5, pink: 6, black: 7 };
  // Starting colour prototypes (OpenCV Lab); replaced by what the camera sees once the balls are identified.
  const PROTO = { cue: [225, 104, 141], red: [141, 158, 153], yellow: [225, 118, 205], brown: [168, 132, 158], green: [180, 82, 132],
    blue: [165, 100, 118], pink: [180, 140, 145], black: [105, 95, 146] };

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const labDist = (lab, p) => Math.sqrt(0.3 * (lab[0] - p[0]) ** 2 + (lab[1] - p[1]) ** 2 + (lab[2] - p[2]) ** 2);
  const inBox = (p, b, pad) => p.x >= b.x0 - pad && p.x <= b.x1 + pad && p.y >= b.y0 - pad && p.y <= b.y1 + pad;

  function apply(H, x, y) { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; }

  // Watches the pixels on each colour spot, so a colour leaving or coming back to its spot is seen even when
  // the ball touches others (the black and pink next to a line of reds don't show up as separate balls).
  // A spot is "on" while enough of it is ball and that ball looks like the colour it had at the start
  // (a red rolling next to the pink spot doesn't count as the pink). A change must last 6 uncovered frames.
  class SpotWatch {
    constructor(names) { this.names = names; this.s = names.map(() => ({ state: null, sig: null, run: [] })); }
    feed(t, spots) {
      const ev = [];
      spots.forEach((sp, i) => {
        if (!sp || sp.covered) return;
        const S = this.s[i], lab = [sp.L, sp.a, sp.b];
        if (!S.state) {                                       // first view: take what is there as the ball's look
          S.run.push([t, lab, sp.fg]); if (S.run.length < 6) return;
          const on = S.run.filter(r => r[2] >= 0.12);
          S.state = on.length >= 4 ? "on" : "off";
          S.sig = on.length >= 4 ? mean(on.map(r => r[1])) : PROTO[this.names[i]].slice();
          S.fg = on.length >= 4 ? on.reduce((a, r) => a + r[2], 0) / on.length : 0.8; S.run = []; return;
        }
        // how unlike a reading is to a remembered look: colour, plus how much of the patch is ball
        const d = (l, f) => labDist(lab, l) + 40 * Math.abs(sp.fg - f);
        const present = S.state === "on" ? sp.fg >= 0.12 && d(S.sig, S.fg) < 20
          : sp.fg >= 0.12 && d(S.sig, S.fg) < 30 && (!S.off || d(S.sig, S.fg) < d(S.off, S.offFg));
        // a colour already marked off whose spot now shows bare cloth: it has gone for certain
        if (S.state === "off" && !S.empty && sp.fg < 0.12) {
          S.erun = (S.erun || 0) + 1;
          if (S.erun >= 6) { S.empty = true; S.erun = 0; ev.push({ type: "spot-off", t, colour: this.names[i], empty: true, again: true }); }
        } else S.erun = 0;
        if (present === (S.state === "on")) {
          S.run = [];
          if (present) { S.sig = S.sig.map((v, j) => 0.95 * v + 0.05 * lab[j]); S.fg = 0.95 * S.fg + 0.05 * sp.fg; }   // follow slow light changes
          return;
        }
        S.run.push([t, lab, sp.fg]);
        if (S.run.length < 6) return;
        const at = S.run[0][0], now = mean(S.run.map(r => r[1])), fg = S.run.reduce((a, r) => a + r[2], 0) / S.run.length; S.run = [];
        if (present) { S.state = "on"; S.sig = now; S.fg = fg; } else { S.state = "off"; S.off = now; S.offFg = fg; S.empty = fg < 0.12; }
        ev.push({ type: present ? "spot-on" : "spot-off", t: at, colour: this.names[i], empty: !present && fg < 0.12 });
      });
      return ev;
    }
    on(c) { const S = this.s[this.names.indexOf(c)]; return !!S && S.state === "on"; }
    // the ball was only nudged on its spot: take its new look as its look
    keep(c) { const S = this.s[this.names.indexOf(c)]; if (S && S.state === "off" && S.off) { S.state = "on"; S.sig = S.off; S.fg = S.offFg; S.empty = false; } }
    pending() { return this.s.some(S => S.state && S.run.length > 0); }
  }
  const mean = arr => arr.reduce((a, l) => a.map((v, j) => v + l[j] / arr.length), [0, 0, 0]);

  class TableTracker {
    // cal: from SnookerVision.calibrate. opts.expect: counts of balls the drill starts with, e.g. { red: 15, yellow: 1, ... }.
    // opts.drillMode: true = a ball only counts in the pocket it was sent towards (no doubles), false = any pocket.
    constructor(cal, opts = {}) {
      this.cal = cal; this.opts = opts; this.expect = opts.expect || null; this.drillMode = opts.drillMode !== false;
      this.proto = JSON.parse(JSON.stringify(PROTO));
      // colour spots in the image: vision's spot positions with the offsets it learnt (where the balls really sit)
      this.spots = {}; for (const c of COLOURS) { const [x, y] = apply(cal.Hm, ...SPOT_MM[c]); this.spots[c] = { x, y }; }
      this._spotsFixed = false;
      this.pockets = cal.pockets.map(([x, y]) => ({ x, y }));
      this.prad = [16, 16, 18, 18, 26, 26];
      this.world = null;           // [{ id, type, x, y, lab, hidden }]
      this.potted = [];            // types currently off the table (potted, waiting for a re-spot)
      this.prev = null; this.hist = []; this.still = 0; this.active = false; this.activeSince = 0;
      this.tracks = []; this.nid = 0; this.events = []; this.listeners = [];
      this.STILL_FRAMES = opts.stillFrames || 8;   // frames with nothing moving before the table counts as settled
      this.spotWatch = new SpotWatch(SPOT_ORDER); this.spotLog = []; this.spotSince = 0;
    }
    on(fn) { this.listeners.push(fn); }
    emit(e) { this.events.push(e); for (const fn of this.listeners) fn(e); }

    // ---- per frame ----
    feed(t, det) {
      if (!this._spotsFixed && this.cal.spotOff) {
        SPOT_ORDER.forEach((c, i) => { const [x, y] = apply(this.cal.Hm, ...SPOT_MM[c]); this.spots[c] = { x: x + this.cal.spotOff[i][0], y: y + this.cal.spotOff[i][1] }; });
        this._spotsFixed = true;
      }
      const balls = det.balls.map(b => ({ x: b.x, y: b.y, lab: [b.L, b.a, b.b], white: b.white, area: b.area }));
      const occ = det.blobs.filter(b => b.edge), clusters = det.blobs.filter(b => !b.edge);
      // motion: a ball not within 2.5 px of any ball in the previous frame
      let moving = 0;
      if (this.prev) for (const b of balls) {
        let m = 1e9; for (const p of this.prev) m = Math.min(m, dist(b, p));
        if (m > 2.5 && !occ.some(o => inBox(b, o, 8))) moving++;
      }
      this._trackMoving(t, balls, occ);
      if (det.spots) for (const e of this.spotWatch.feed(t, det.spots)) { this.spotLog.push(e); if (this.debug) this.debug(e); }
      this.prev = balls;
      if (moving) { this.still = 0; if (!this.active) { this.active = true; this.activeSince = t; this.cueStart = this.world && this.world.find(w => w.type === "cue"); } }
      else this.still++;
      this.hist.push({ t, balls, occ, clusters }); if (this.hist.length > this.STILL_FRAMES) this.hist.shift();
      // settle once still; wait (up to 4 s more) while a colour spot is changing, so a pot off a spot lands in this shot
      if (this.still >= this.STILL_FRAMES && !this.settledNow && (!this.spotWatch.pending() || this.still >= this.STILL_FRAMES + 40)) { this.settledNow = true; this._settled(t); }
      if (this.still === 0) this.settledNow = false;
    }

    // Follow moving balls from frame to frame, so a ball running into a pocket can be seen going there.
    _trackMoving(t, balls, occ) {
      const used = new Set();
      for (const tr of this.tracks) {
        if (tr.done) continue;
        const pred = { x: tr.x + tr.vx, y: tr.y + tr.vy };
        // fast balls cover 50+ px between frames: wide gate until the track has a speed to predict with
        let bi = -1, bd = tr.path.length > 1 ? 45 : 80;
        // the cue ball hands over to the object ball at contact: never join a white ball onto a coloured track or back
        const wasWhite = tr.recentWhite > 1;
        balls.forEach((b, i) => { if (used.has(i) || (tr.path.length >= 3 && !!b.white !== wasWhite)) return; const d = dist(b, pred); if (d < bd) { bd = d; bi = i; } });
        if (bi >= 0) {
          const b = balls[bi]; used.add(bi);
          tr.vx = 0.5 * tr.vx + 0.5 * (b.x - tr.x); tr.vy = 0.5 * tr.vy + 0.5 * (b.y - tr.y);
          tr.x = b.x; tr.y = b.y; tr.last = t; tr.path.push([t, b.x, b.y, occ.some(o => inBox(b, o, 4)) ? 1 : 0]); tr.labs.push(b.lab); if (b.white) tr.white++;
          tr.recentWhite = Math.min(3, Math.max(0, tr.recentWhite + (b.white ? 1 : -1)));
        } else if (t - tr.last > 0.35) {
          tr.done = true; tr.endOccluded = occ.some(o => inBox(tr, o, 10));
        }
      }
      balls.forEach((b, i) => {
        if (used.has(i)) return;
        this.tracks.push({ id: this.nid++, x: b.x, y: b.y, vx: 0, vy: 0, first: t, last: t, path: [[t, b.x, b.y, occ.some(o => inBox(b, o, 4)) ? 1 : 0]], labs: [b.lab], white: b.white ? 1 : 0, recentWhite: b.white ? 3 : 0, done: false });
      });
      this.tracks = this.tracks.filter(tr => !tr.done || t - tr.last < 30);
    }
    // Tracks that ran into a pocket while the table was moving.
    _potTracks(since) {
      const out = [];
      for (const tr of this.tracks) {
        if (!tr.done || tr.last < since || tr.endOccluded || tr.used) continue;
        const [, x0, y0] = tr.path[0], travel = Math.hypot(tr.x - x0, tr.y - y0);
        if (tr.path.length < 3 || travel < 25) continue;
        // where it was lost, or up to 3 frames further on at its last speed (a fast ball can vanish short of the pocket)
        const n = tr.path.length, [, xa, ya] = tr.path[n - 2], vx = tr.x - xa, vy = tr.y - ya, sp = Math.hypot(vx, vy);
        let k = -1, kd = 1e9;
        for (let f = 0; f <= (sp > 6 ? 3 : 0); f++) {
          const q = { x: tr.x + vx * f, y: tr.y + vy * f };
          this.pockets.forEach((p, i) => { const d = dist(q, p) - this.prad[i]; if (d < kd) { kd = d; k = i; } });
        }
        if (kd > 6) continue;
        const aim = this._aimedPocket(tr);
        out.push({ tr, pocket: k, aimed: aim, start: { x: x0, y: y0 }, white: tr.white > tr.path.length / 2,
          lab: tr.labs.slice(0, 3).reduce((a, l) => a.map((v, j) => v + l[j] / Math.min(3, tr.labs.length)), [0, 0, 0]) });
      }
      return out;
    }
    // The pocket a moving ball was first heading for: its opening direction, in table mm, extended to the cushion.
    _aimedPocket(tr) {
      // from where it last sat still (a track can start with the ball being put down by hand)
      let i0 = 0;
      for (let i = tr.path.length - 1; i >= 4; i--) {
        const q = tr.path[i], still = [1, 2, 3, 4].every(k => Math.hypot(tr.path[i - k][1] - q[1], tr.path[i - k][2] - q[2]) < 3);
        if (still) { i0 = i; break; }
      }
      const mm = tr.path.slice(i0).map(([, x, y]) => apply(this.cal.Hinv, x, y));
      const a = mm[0], b = mm.find(p => Math.hypot(p[0] - a[0], p[1] - a[1]) > 250) || mm[mm.length - 1];
      const d = [b[0] - a[0], b[1] - a[1]], n = Math.hypot(...d); if (!n) return -1;
      const P = [[0, 0], [TW, 0], [0, TL / 2], [TW, TL / 2], [0, TL], [TW, TL]];
      let best = -1, bp = 220;
      P.forEach((p, i) => { const v = [p[0] - a[0], p[1] - a[1]]; if (v[0] * d[0] + v[1] * d[1] <= 0) return; const perp = Math.abs(v[0] * d[1] - v[1] * d[0]) / n; if (perp < bp) { bp = perp; best = i; } });
      return best;
    }

    // ---- the table has settled: compare with the model ----
    _settled(t) {
      // positions: the last frame; covered areas: union over the still frames
      const last = this.hist[this.hist.length - 1];
      const D = last.balls.map(b => Object.assign({}, b)), occ = this.hist.flatMap(h => h.occ), clusters = last.clusters;
      if (!this.world) { this._init(t, D, clusters); this.prevClusters = clusters; this.prevOcc = occ; this.active = false; return; }
      const wasActive = this.active; this.active = false;
      const W = this.world, before = W.map(w => ({ x: w.x, y: w.y }));
      // 1. balls that haven't moved keep their identity
      const free = new Set(D.map((_, i) => i)), missing = [];
      for (const w of W) {
        let bi = -1, bd = 7;
        for (const i of free) { const d = dist(w, D[i]); if (d < bd && this._compatible(w.type, D[i])) { bd = d; bi = i; } }
        if (bi >= 0) { free.delete(bi); Object.assign(w, { x: D[bi].x, y: D[bi].y, hidden: false }); w.lab = D[bi].lab; }
        else if (COLOURS.includes(w.type) && dist(w, this.spots[w.type]) < 10 && this.spotWatch.on(w.type)) w.hidden = true;   // its spot still shows it
        else if (occ.some(o => inBox(w, o, 6)) || clusters.some(c => inBox(w, c, 4))) w.hidden = true;   // can't see it: assume it's there
        else missing.push(w);
      }
      // 2. balls that moved: match new positions to missing balls by colour (cue ball by whiteness)
      const pairs = [];
      // (a ball sitting on another colour's spot, which still shows that colour, is that colour)
      const onOtherSpot = (type, d) => COLOURS.some(c => c !== type && dist(d, this.spots[c]) < 8 && this.spotWatch.on(c));
      for (const w of missing) for (const i of free) if (!onOtherSpot(w.type, D[i])) pairs.push([this._colourCost(w.type, D[i]), w, i]);
      pairs.sort((a, b) => a[0] - b[0]);
      const moved = new Set();
      for (const [c, w, i] of pairs) {
        if (c > 60 || moved.has(w) || !free.has(i)) continue;
        moved.add(w); free.delete(i); Object.assign(w, { x: D[i].x, y: D[i].y, hidden: false }); w.lab = D[i].lab;
      }
      const gone = missing.filter(w => !moved.has(w));
      if (this.debug) this.debug({ t, wasActive, D: D.map(d => [Math.round(d.x), Math.round(d.y), d.white ? "W" : this._classify(d)]), occ: occ.length,
        missing: missing.map(w => w.type + "@" + Math.round(w.x) + "," + Math.round(w.y)), moved: [...moved].map(w => w.type), gone: gone.map(w => w.type), free: [...free].length });
      // A shot: a ball that was at rest on the table rolled away freely (3+ frames, 40+ px). Hands, the cue and
      // a ball carried by hand don't start from a resting ball's position, or are hidden while they move.
      const restingAt = (p, r = 12) => before.some(w => Math.hypot(w.x - p[1], w.y - p[2]) < r) ||
        this.prevClusters.some(c => p[1] >= c.x0 - r + 2 && p[1] <= c.x1 + r - 2 && p[2] >= c.y0 - r + 2 && p[2] <= c.y1 + r - 2);
      const since = this.activeSince - 0.5;
      const rolled = !wasActive ? [] : this.tracks.filter(tr => {
        if (tr.last < since) return false;
        let i0 = tr.path.findIndex(q => q[0] >= since); if (i0 < 0) return false; i0 = Math.max(0, i0 - 1);
        const seg = tr.path.slice(i0); if (seg.length < 3) return false;
        const far = Math.max(...seg.map(q => Math.hypot(q[1] - seg[0][1], q[2] - seg[0][2])));
        // rolling in the open (not brushing the player), and not just a blob that slid onto another resting ball
        const nearPlayer = seg.filter(q => q[3]).length / seg.length;
        const end = seg[seg.length - 1];
        const ontoOther = before.some(w => Math.hypot(w.x - end[1], w.y - end[2]) < 12 && Math.hypot(w.x - seg[0][1], w.y - seg[0][2]) > 12);
        // an object ball starts a little way from where it rested (it is merged with the cue ball at contact)
        return far >= 40 && restingAt(seg[0], tr.white < tr.path.length / 2 ? 25 : 12) && nearPlayer <= 0.3 && !ontoOther;
      });
      // a ball that rattled in the jaws and stayed out is back on the table near where its track was lost
      const potTracks = (wasActive ? this._potTracks(this.activeSince - 0.5) : [])
        .filter(p => {
          // it came from where a ball was resting: one of its first points, or a frame before it was first seen
          const P = p.tr.path, back = P.length > 1 ? [0, 2 * P[0][1] - P[1][1], 2 * P[0][2] - P[1][2]] : P[0];
          return P.slice(0, 3).some(q => restingAt(q, 25)) || restingAt(back, 25);
        })
        .filter(p => !D.some(d => dist(d, p.tr) < 45 && !before.some(b => dist(b, d) < 7)) &&
          !this.tracks.some(o => o !== p.tr && o.path.length >= 5 && o.first > p.tr.last - 0.2 && o.first < p.tr.last + 2 && Math.hypot(o.path[0][1] - p.tr.x, o.path[0][2] - p.tr.y) < 45));
      // colours that left their spot since the last settle (seen on the spot pixels, even inside a cluster)
      const spotOff = [], spotOn = [];
      for (const e of this.spotLog) {
        if (e.t < this.spotSince - 1) continue;
        if (e.type === "spot-on") { spotOn.push(e.colour); continue; }
        // A spot that changed but still shows a ball: potted with a red taking its place, or just nudged by a
        // red going past. The drill order decides: when a red is due, the colour was only nudged.
        // (and when a red is due, a colour going is never a pot in a break anyway: it was moved by hand)
        if (this.prefer === "red") { if (!e.empty) this.spotWatch.keep(e.colour); continue; }
        // clearing the colours: only the colour due can go, so another spot that merely changed was brushed
        if (this.due && e.colour !== this.due && !e.empty) continue;
        if (e.again && this.lastSpotPot && this.lastSpotPot.colour === e.colour && this.lastSpotPot.t > e.t - 30) continue;   // already counted
        if (!spotOff.includes(e.colour)) spotOff.push(e.colour);
      }
      this.spotLog = []; this.spotSince = t;
      const objMoved = rolled.some(tr => tr.white < tr.path.length / 2) || spotOff.length > 0;
      const shot = objMoved || potTracks.some(p => !p.white);
      if (this.debug) this.debug({ t, since: this.activeSince, spotOff, spotOn, rolled: rolled.map(tr => [tr.first, tr.last, tr.path.length, Math.round(tr.path[0][1]), Math.round(tr.path[0][2]), Math.round(tr.x), Math.round(tr.y), tr.white]),
        pots: potTracks.map(p => [p.tr.first, p.tr.last, p.pocket, Math.round(p.start.x), Math.round(p.start.y)]),
        recent: this.tracks.filter(tr => tr.last >= this.activeSince - 0.5 && tr.path.length >= 3).map(tr => [tr.first, tr.last, tr.path.length, Math.round(tr.path[0][1]), Math.round(tr.path[0][2]), Math.round(tr.x), Math.round(tr.y)]) });
      // 3. pots: colours gone from their spot and not seen elsewhere, balls gone after a shot, and balls
      //    followed into a pocket that were hidden in a cluster
      const pots = [];
      if (shot) {
        const offSpots = [];
        // a colour off its spot with nothing struck on the table was moved by hand (e.g. setting up again)
        // (a cue ball that potted a colour off its spot may only be picked up after contact, so any ball rolling
        // freely in the open for a second counts as a stroke too)
        const freeRoll = wasActive && this.tracks.some(tr => {
          if (tr.last < since || tr.path.length < 10) return false;
          const seg = tr.path.filter(q => q[0] >= since); if (seg.length < 10) return false;
          return Math.hypot(seg[seg.length - 1][1] - seg[0][1], seg[seg.length - 1][2] - seg[0][2]) >= 60 && seg.filter(q => q[3]).length <= seg.length * 0.1;
        });
        const struck = rolled.length > 0 || potTracks.length > 0 || freeRoll;
        for (const c of struck ? spotOff : []) {
          const w = W.filter(w => w.type === c).sort((x, y) => dist(x, this.spots[c]) - dist(y, this.spots[c]))[0];
          const fromSpot = potTracks.some(p => !p.used && !p.white && dist(p.start, this.spots[c]) < 30);
          if (w && moved.has(w) && dist(w, this.spots[c]) > 20 && !fromSpot) continue;   // knocked off its spot, still on the table
          const near = potTracks.filter(p => !p.used && !p.white && dist(p.start, this.spots[c]) < 60).sort((a, b) => dist(a.start, this.spots[c]) - dist(b.start, this.spots[c]));
          const pt = near[0] || null; if (pt) pt.used = true;
          pots.push(this._pot(w || { type: c }, pt)); offSpots.push(this.spots[c]); this.lastSpotPot = { colour: c, t };
        }
        for (const w of gone) {
          if (pots.some(p => p.ball === w)) continue;
          // the cue ball only counts as potted when it is seen going into a pocket; otherwise the player hides it
          if (w.type === "cue" && !potTracks.some(p => p.white && !p.used)) { w.hidden = true; continue; }
          if (offSpots.some(sp => dist(sp, w) < 15)) { this.world = this.world.filter(x => x !== w); continue; }   // was that colour all along
          const pt = potTracks.find(p => !p.used && dist(p.start, w) < 25) || null;
          // reds placed by guesswork inside a cluster are only potted when seen going into a pocket
          if (!pt && w.guessed) { w.hidden = true; continue; }
          if (pt) pt.used = true;
          pots.push(this._pot(w, pt));
        }
        for (const pt of potTracks) {
          if (pt.used || pt.white) continue;
          // a ball that ran into a pocket from inside a cluster (e.g. a red off the line): take the nearest hidden ball
          const cand = this._hiddenSource(W, pt, pots);
          if (cand) { pt.used = true; pots.push(this._pot(cand, pt)); }
        }
        for (const p of pots) { this.world = this.world.filter(w => w !== p.ball); if (p.type !== "red" && p.type !== "cue") this.potted.push(p.type); }
        this.colourPots = (this.colourPots || 0) + pots.filter(p => COLOURS.includes(p.type)).length;
      } else {
        // no shot: balls that disappeared were picked up by hand
        for (const w of gone) this.world = this.world.filter(x => x !== w);
        if (gone.length) this.emit({ type: "removed", t, balls: gone.map(w => w.type) });
      }
      // 4. new balls: placed by hand (re-spots, or a reset of the drill)
      const added = [...free].map(i => D[i]);
      const placed = added.map(b => this._identifyPlaced(b)).filter(Boolean);
      for (const c of spotOn) {
        const k = this.potted.indexOf(c); if (k < 0 || this.world.some(w => w.type === c)) continue;
        this.potted.splice(k, 1);
        const w = { id: this.nid++, type: c, x: this.spots[c].x, y: this.spots[c].y, lab: this.proto[c], hidden: true };
        this.world.push(w); placed.push(w);
      }
      if (shot) {
        const res = { type: "shot", t, start: this.activeSince, pots: pots.map(p => ({ type: p.type, value: VALUE[p.type] || 0, pocket: p.pocket, aimed: p.aimed, wrongPocket: p.wrongPocket })),
          inOff: pots.some(p => p.type === "cue") };
        res.legalPots = res.pots.filter(p => p.type !== "cue" && !(this.drillMode && p.wrongPocket));
        res.result = res.legalPots.length ? "pot" : "miss";
        this.emit(res);
      }
      if (placed.length) this.emit({ type: "placed", t, balls: placed.map(p => p.type) });
      this.prevClusters = clusters; this.prevOcc = occ;
      if (this._isReset()) { this.colourPots = 0; this.emit({ type: "reset", t }); }
    }
    // Which hidden ball (in a cluster or under the player) a ball followed into a pocket came from.
    // Moving balls blur into the cloth, so only the broad colour family is trusted: reddish (red, pink,
    // brown, yellow) versus dark or cold (black, blue, green). Red against pink is decided by what the
    // drill expects next (this.prefer, set by the scorer: "red" or "colour"), then by distance.
    _hiddenSource(W, pt, pots) {
      const warm = pt.lab[1] >= 108;
      const fam = t => ["red", "pink", "brown", "yellow"].includes(t) === warm;
      const cands = W.filter(w => w.hidden && w.type !== "cue" && !pots.some(p => p.ball === w) && fam(w.type) && dist(w, pt.start) < 60 &&
        !(COLOURS.includes(w.type) && this.spotWatch.on(w.type)));
      const pref = t => this.prefer === "colour" ? (t === "red" ? 1 : 0) : this.prefer === "red" ? (t === "red" ? 0 : 1) : 0;
      return cands.sort((a, b) => pref(a.type) - pref(b.type) || dist(a, pt.start) - dist(b, pt.start))[0] || null;
    }
    _pot(w, pt) {
      const r = { ball: w, type: w.type, pocket: pt ? pt.pocket : null, aimed: pt ? pt.aimed : null };
      r.wrongPocket = pt && pt.aimed >= 0 && pt.pocket !== pt.aimed;
      return r;
    }
    _compatible(type, d) { return type === "cue" ? d.white : !d.white || type === "pink" || type === "yellow"; }
    _colourCost(type, d) {
      if (type === "cue") return d.white ? 0 : 999;
      if (d.white) return 999;
      // reds and pink look alike: fine, any match of a moved ball is by colour distance
      return labDist(d.lab, this.proto[type]);
    }
    // A ball put down by hand: on a colour spot it is a re-spot of a potted colour (own spot first, else the
    // highest-value free spot); the cue ball if white; otherwise the potted colour it looks most like, or a red.
    _identifyPlaced(b) {
      let type = null;
      if (b.white) type = "cue";
      else {
        const spot = COLOURS.find(c => dist(b, this.spots[c]) < 12);
        const potted = this.potted.slice();
        if (spot && potted.includes(spot)) type = spot;
        else if (spot && potted.length) {
          // own spot was covered: it is a potted colour whose own spot is occupied, placed on the highest free spot
          const covered = potted.filter(c => this.world.some(w => dist(w, this.spots[c]) < 10));
          const cands = covered.length ? covered : potted;
          type = cands.sort((x, y) => labDist(b.lab, this.proto[x]) - labDist(b.lab, this.proto[y]))[0];
        } else if (potted.length && !spot) {
          // no free spot: placed as near its own spot as possible towards the top cushion
          const near = potted.filter(c => dist(b, this.spots[c]) < 40);
          if (near.length) type = near.sort((x, y) => dist(b, this.spots[x]) - dist(b, this.spots[y]))[0];
        }
        if (!type) type = this._classify(b);
      }
      const k = this.potted.indexOf(type); if (k >= 0) this.potted.splice(k, 1);
      const w = { id: this.nid++, type, x: b.x, y: b.y, lab: b.lab, hidden: false };
      this.world.push(w); return w;
    }
    _classify(b) {
      if (b.white) return "cue";
      let best = "red", bd = 1e9;
      for (const c of ["red", ...COLOURS]) { const d = labDist(b.lab, this.proto[c]); if (d < bd) { bd = d; best = c; } }
      return best;
    }
    // The drill's starting layout is back: after two or more colours were potted, every colour the drill
    // starts with is on the table again (used for colours-only drills; drills with reds end attempts on a miss).
    _isReset() {
      if (!this.expect || this.expect.red || this.colourPots < 2) return false;
      // (one spot may be misread, e.g. still marked off after the cue ball brushed it)
      const want = COLOURS.filter(c => this.expect[c]);
      const back = want.filter(c => this.spotWatch.on(c) || this.world.some(w => w.type === c && dist(w, this.spots[c]) < 10));
      return back.length >= want.length - 1 && back.includes("black");
    }

    // First settled view: colours by their spots (as the drill diagram says), cue ball by whiteness, the rest reds.
    _init(t, D, clusters) {
      const W = [], left = D.slice();
      const take = (pred) => { const i = left.findIndex(pred); return i >= 0 ? left.splice(i, 1)[0] : null; };
      const cueB = left.filter(b => b.white).sort((a, b) => b.lab[0] - a.lab[0])[0];
      if (cueB) { left.splice(left.indexOf(cueB), 1); W.push({ id: this.nid++, type: "cue", x: cueB.x, y: cueB.y, lab: cueB.lab }); this.proto.cue = cueB.lab; }
      const want = this.expect ? COLOURS.filter(c => this.expect[c]) : COLOURS;
      for (const c of want) {
        const s = this.spots[c];
        const b = left.filter(b => dist(b, s) < 14).sort((a, b) => dist(a, s) - dist(b, s))[0];
        if (b) { left.splice(left.indexOf(b), 1); W.push({ id: this.nid++, type: c, x: b.x, y: b.y, lab: b.lab }); this.proto[c] = b.lab; }
        else if (clusters.some(cl => inBox(s, cl, 4))) W.push({ id: this.nid++, type: c, x: s.x, y: s.y, lab: this.proto[c], hidden: true });
      }
      // wait (up to 20 s) for the drill's layout: every colour it starts with on its spot
      this.firstSeen = this.firstSeen ?? t;
      if (W.filter(w => w.type !== "cue").length < want.length && t - this.firstSeen < 20) return false;
      const reds = left.filter(b => labDist(b.lab, this.proto.red) < 45);
      for (const b of reds) W.push({ id: this.nid++, type: "red", x: b.x, y: b.y, lab: b.lab });
      if (reds.length) this.proto.red = reds.map(r => r.lab).reduce((a, l) => a.map((v, j) => v + l[j] / reds.length), [0, 0, 0]);
      // reds the drill expects but that can't be seen one by one: inside clusters (e.g. a line of touching reds)
      const missingReds = this.expect && this.expect.red ? Math.max(0, this.expect.red - reds.length) : 0;
      const redClusters = clusters.filter(c => labDist([c.L, c.a, c.b], this.proto.red) < 50 || c.a > 130);
      for (let k = 0; k < missingReds && redClusters.length; k++) {
        const c = redClusters[k % redClusters.length], f = (k + 0.5) / missingReds;
        W.push({ id: this.nid++, type: "red", x: c.x0 + (c.x1 - c.x0) * f, y: c.y1 - (c.y1 - c.y0) * f, lab: this.proto.red, hidden: true, guessed: true });
      }
      for (const w of W) w.hidden = !!w.hidden;
      this.world = W; this.colourPots = 0;
      this.emit({ type: "init", t, balls: W.map(w => w.type) });
    }
  }

  const E_VALUE = VALUE;
  // ---- scoring ----------------------------------------------------------------------------
  // metric "break": points per attempt (red 1 ... black 7), "score": balls potted in a row, "outof": pots out of `per` shots.
  // An attempt ends at a miss (break / score), after `per` shots (outof), or when the drill is set up again.
  class DrillScorer {
    constructor(drill, onAttempt) {
      this.metric = drill.metric; this.per = +drill.per || 10; this.onAttempt = onAttempt || (() => {});
      this.cur = null; this.attempts = [];
    }
    _start(t) { this.cur = { start: t, score: 0, shots: 0, pots: [] }; }
    _end(t, why) {
      if (!this.cur || !this.cur.shots) { this.cur = null; return; }
      const a = Object.assign(this.cur, { end: t, why }); this.attempts.push(a); this.cur = null; this.onAttempt(a);
    }
    // Tell the tracker what this drill expects next, to settle red-or-pink when a ball comes out of a cluster.
    attach(tracker) { this.tracker = tracker; this._expect([]); }
    _expect(pots) {
      if (!this.tracker) return;
      const ex = this.tracker.expect, last = pots[pots.length - 1];
      if (ex && !ex.red) {                                            // a colours-only drill: they go in order
        this.tracker.prefer = "colour";
        this.tracker.due = ["yellow", "green", "brown", "blue", "pink", "black"].find(c => ex[c] && !pots.includes(c)) || null;
        return;
      }
      this.tracker.prefer = !last ? "red" : last === "red" ? "colour" : "red";
    }
    feed(e) {
      if (e.type === "reset") { if (this.cur && this.metric !== "outof") this._end(e.t, "reset"); this._expect([]); return; }
      if (e.type !== "shot") return;
      if (!this.cur) this._start(e.start);
      const a = this.cur; a.shots++;
      const legal = e.legalPots;
      if (this.metric === "outof") {
        if (legal.length) a.score++;
        a.pots.push(...legal.map(p => p.type));
        if (a.shots >= this.per) this._end(e.t, "shots");
        return;
      }
      if (!legal.length || e.inOff) { this._end(e.t, e.inOff ? "in-off" : "miss"); this._expect([]); return; }
      // clearing the colours they must go in order, so a pot is the colour due (whatever the camera took it for)
      const due = this.tracker && this.tracker.due;
      const got = due ? [{ type: due, value: E_VALUE[due] }] : legal;
      for (const p of got) { a.pots.push(p.type); a.score += this.metric === "break" ? p.value : 1; }
      this._expect(a.pots);
    }
    finish(t) { this._end(t, "time"); }
  }

  // Free play: two players, the break passes on a miss; fouls are entered by hand.
  class MatchScorer {
    constructor(names = ["Player 1", "Player 2"]) {
      this.players = names.map(n => ({ name: n, score: 0, best: 0 })); this.turn = 0; this.break = 0; this.log = [];
      this.expectRed = true;
    }
    feed(e) {
      if (e.type !== "shot") return;
      const p = this.players[this.turn];
      if (e.inOff) { this.foul(4); return; }
      const pots = e.pots.filter(x => x.type !== "cue");
      if (!pots.length) { this._endBreak(e.t); return; }
      for (const x of pots) { this.break += x.value; p.score += x.value; }
      p.best = Math.max(p.best, this.break);
      this.log.push({ t: e.t, player: this.turn, pots: pots.map(x => x.type), break: this.break });
    }
    _endBreak(t) { this.log.push({ t, player: this.turn, endBreak: this.break }); this.break = 0; this.turn = 1 - this.turn; }
    foul(points) { this.players[1 - this.turn].score += points; this.log.push({ foul: points, player: this.turn }); this.break = 0; this.turn = 1 - this.turn; }
    switchTurn() { this.break = 0; this.turn = 1 - this.turn; }
  }

  // Ball counts a drill starts with, from its diagram.
  function expectFromDiagram(dg) {
    const out = {};
    for (const b of (dg && dg.balls) || []) if (b.t !== "cue") out[b.t] = (out[b.t] || 0) + 1;
    return out;
  }

  const api = { TableTracker, DrillScorer, MatchScorer, expectFromDiagram, VALUE, COLOURS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SnookerEngine = api;
})(typeof self !== "undefined" ? self : this);
