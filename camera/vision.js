// Snooker table vision: finds the cloth, finds balls, and counts colour clearances.
// Plain JS with no dependencies, so it runs in the browser (camera or video file) and in Node (tests).
// Works on RGBA frames: { data: Uint8ClampedArray, width, height }.
(function (root) {
  "use strict";

  // Ball and table sizes below are tuned at "1080 scale": the near cushion of the table about 594 px wide.
  // Frames are cropped to the table and scaled to that size before counting (see Calibration).
  const NEAR_WIDTH = 594;
  // Spots in table mm from the far-left corner, camera at the black end: the baulk colours are furthest away.
  const SPOT_NAMES = ["yellow", "green", "brown", "blue", "pink", "black"];
  // Pixel tests (OpenCV Lab) for picking out each colour among touching balls, e.g. the black against reds.
  const SPOT_LIKE = { black: (L, a) => L < 140 && a < 110, pink: (L, a) => L > 200 && a > 128, blue: (L, a, b) => b < 125,
    yellow: (L, a, b) => b > 180, green: (L, a) => a < 100, brown: (L, a) => a > 115 && L < 200 };
  const SPOT_MM = (() => { const W = 1778, L = 3569;
    return { yellow: [W / 2 - 292, 737], brown: [W / 2, 737], green: [W / 2 + 292, 737], blue: [W / 2, L / 2], pink: [W / 2, L * 3 / 4], black: [W / 2, L - 324] }; })();
  const TABLE_MM = [1778, 3569];

  // ---- colour ----------------------------------------------------------------------------
  // sRGB -> CIE Lab in OpenCV's 8-bit convention (L 0-255, a and b offset by 128), so the
  // thresholds match the Python prototype.
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function toLab(data, n) {
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = LIN[data[p]], g = LIN[data[p + 1]], b = LIN[data[p + 2]];
      const x = f((0.412453 * r + 0.357580 * g + 0.180423 * b) / 0.950456);
      const y = (0.212671 * r + 0.715160 * g + 0.072169 * b);
      const z = f((0.019334 * r + 0.119193 * g + 0.950227 * b) / 1.088754);
      const fy = f(y);
      L[i] = (y > 0.008856 ? 116 * fy - 16 : 903.3 * y) * 2.55;
      A[i] = 500 * (x - fy) + 128;
      B[i] = 200 * (fy - z) + 128;
    }
    return { L, A, B };
  }
  // OpenCV-style HSV (H 0-180, S and V 0-255).
  function hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 30; if (h < 0) h += 180;
    return [h, mx ? (d / mx) * 255 : 0, mx];
  }

  // ---- geometry --------------------------------------------------------------------------
  function hull(pts) {
    pts = pts.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  // Reduce a convex polygon to 4 corners by repeatedly dropping the vertex that loses the least area.
  function toQuad(poly) {
    poly = poly.slice();
    const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    while (poly.length > 4) {
      let best = 0, bi = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = tri(poly[(i - 1 + poly.length) % poly.length], poly[i], poly[(i + 1) % poly.length]);
        if (i === 0 || a < best) { best = a; bi = i; }
      }
      poly.splice(bi, 1);
    }
    return orderQuad(poly);
  }
  // Order corners as far-left, far-right, near-right, near-left (camera at one end, table going away from it).
  function orderQuad(q) {
    const s = q.slice().sort((p, r) => p[1] - r[1]);
    const far = s.slice(0, 2).sort((p, r) => p[0] - r[0]), near = s.slice(2).sort((p, r) => p[0] - r[0]);
    return [far[0], far[1], near[1], near[0]];
  }
  // Perspective transform mapping 4 src points to 4 dst points (3x3, row-major).
  function homography(src, dst) {
    const M = [], v = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, w] = dst[i];
      M.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); v.push(u);
      M.push([0, 0, 0, x, y, 1, -w * x, -w * y]); v.push(w);
    }
    for (let c = 0; c < 8; c++) {            // Gauss-Jordan
      let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]]; [v[c], v[p]] = [v[p], v[c]];
      for (let r = 0; r < 8; r++) if (r !== c) {
        const k = M[r][c] / M[c][c];
        for (let j = c; j < 8; j++) M[r][j] -= k * M[c][j];
        v[r] -= k * v[c];
      }
    }
    return v.map((x, i) => x / M[i][i]).concat(1);
  }
  const apply = (H, [x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };

  // ---- finding the table -----------------------------------------------------------------
  // Returns the 4 cloth corners [far-left, far-right, near-right, near-left] in frame pixels, or null.
  function findTable(img) {
    const { data, width: W, height: H } = img;
    const step = Math.max(1, Math.round(W / 540));            // work at about 540 px wide
    const w = Math.floor(W / step), h = Math.floor(H / step);
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = ((y * step) * W + x * step) * 4;
      const [hh, s, v] = hsv(data[p], data[p + 1], data[p + 2]);
      m[y * w + x] = hh >= 60 && hh <= 90 && s >= 170 && v >= 120 ? 1 : 0;
    }
    // largest green component
    const lab = new Int32Array(w * h); let best = 0, bestId = 0, id = 0; const stack = [];
    for (let i = 0; i < w * h; i++) {
      if (!m[i] || lab[i]) continue;
      id++; let n = 0; stack.push(i); lab[i] = id;
      while (stack.length) {
        const j = stack.pop(); n++;
        const x = j % w, y = (j / w) | 0;
        if (x > 0 && m[j - 1] && !lab[j - 1]) { lab[j - 1] = id; stack.push(j - 1); }
        if (x < w - 1 && m[j + 1] && !lab[j + 1]) { lab[j + 1] = id; stack.push(j + 1); }
        if (y > 0 && m[j - w] && !lab[j - w]) { lab[j - w] = id; stack.push(j - w); }
        if (y < h - 1 && m[j + w] && !lab[j + w]) { lab[j + w] = id; stack.push(j + w); }
      }
      if (n > best) { best = n; bestId = id; }
    }
    if (best < w * h * 0.02) return null;
    const pts = [];
    for (let y = 0; y < h; y++) {                              // left- and right-most pixel of each row
      let a = -1, b = -1;
      for (let x = 0; x < w; x++) if (lab[y * w + x] === bestId) { if (a < 0) a = x; b = x; }
      if (a >= 0) { pts.push([a * step, y * step]); pts.push([(b + 1) * step, y * step]); }
    }
    return toQuad(hull(pts));
  }

  // ---- calibration -----------------------------------------------------------------------
  // Everything needed to count balls on frames cropped to the table and scaled to 1080 scale.
  function calibrate(quad) {
    const nearW = Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1]);
    const scale = NEAR_WIDTH / nearW;
    const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
    const pad = 20 / scale;
    const sx = Math.max(0, Math.min(...xs) - pad), sy = Math.max(0, Math.min(...ys) - pad);
    const sw = Math.max(...xs) + pad - sx, sh = Math.max(...ys) + pad - sy;
    const W = Math.round(sw * scale / 2) * 2, H = Math.round(sh * scale / 2) * 2;
    const q = quad.map(([x, y]) => [(x - sx) * scale, (y - sy) * scale]);
    // inside mask: inside the quad and at least 3.5 px from its edges (like a 7x7 erosion)
    const inside = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let ok = true;
      for (let i = 0; i < 4 && ok; i++) {
        const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
        const cr = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / Math.hypot(bx - ax, by - ay);
        if (cr < 3.5) ok = false;                               // corners are ordered clockwise on screen
      }
      inside[y * W + x] = ok ? 1 : 0;
    }
    // pixels on the rim of the inside mask: a big blob touching it comes from outside the table (player, cue)
    const rim = new Uint8Array(W * H);
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
      const i = y * W + x; if (!inside[i]) continue;
      if (!inside[i - 2] || !inside[i + 2] || !inside[i - 2 * W] || !inside[i + 2 * W]) rim[i] = 1;
    }
    const Hm = homography([[0, 0], [TABLE_MM[0], 0], TABLE_MM, [0, TABLE_MM[1]]], q);
    const [TW, TL] = TABLE_MM;
    const pockets = [[0, 0], [TW, 0], [0, TL / 2], [TW, TL / 2], [0, TL], [TW, TL]].map(p => apply(Hm, p));
    // colour spots, with the camera at the black end (baulk furthest away)
    const spots = SPOT_NAMES.map(c => apply(Hm, SPOT_MM[c]));
    return { quad, crop: { sx, sy, sw, sh }, W, H, scale, inside, rim, pockets, spots, Hm, Hinv: homography(q, [[0, 0], [TABLE_MM[0], 0], TABLE_MM, [0, TABLE_MM[1]]]), cloth: null };
  }

  // ---- counting balls in one frame -------------------------------------------------------
  const median = v => { const s = v.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  function boxBlur(L, W, H, r) {                                // mean over a (2r+1)^2 window via an integral image
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) { s += L[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s; } }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      out[y * W + x] = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
    return out;
  }
  function morph(m, W, H, keepIf) {                             // 3x3 erode (keepIf=9) or dilate (keepIf=1)
    const o = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += m[(y + dy) * W + x + dx];
      o[y * W + x] = s >= keepIf ? 1 : 0;
    }
    return o;
  }
  const isBall = (b, cloth) => Math.hypot(b.a - cloth[0], b.b - cloth[1]) >= 20 || b.L < 90;   // not just a shadow
  const isWhite = b => b.L > 175 && b.a > 92 && b.a < 120 && b.b > 128 && b.b < 155;

  // img: the table crop already scaled to cal.W x cal.H. Returns the balls seen, big blobs (a cluster of
  // touching balls inside the table, or the player/cue reaching in from the edge) and how much is covered.
  function detectFrame(cal, img) {
    const { W, H, inside } = cal, n = W * H;
    const { L, A, B } = toLab(img.data, n);
    if (!cal.cloth) {                                           // cloth colour: median a, b inside the table
      const as = [], bs = [];
      for (let i = 0; i < n; i += 7) if (inside[i]) { as.push(A[i]); bs.push(B[i]); }
      as.sort((x, y) => x - y); bs.sort((x, y) => x - y);
      cal.cloth = [as[as.length >> 1], bs[bs.length >> 1]];
    }
    const [ca, cb] = cal.cloth;
    const Lbg = boxBlur(L, W, H, 15);
    let m = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!inside[i]) continue;
      const d = Math.hypot(A[i] - ca, B[i] - cb);
      m[i] = d > 22 || L[i] < Lbg[i] - 30 || L[i] > Lbg[i] + 40 ? 1 : 0;
    }
    // what is on each colour spot: share of non-cloth pixels in a 7x7 patch (the spot's projection can be a
    // few px off the ball's centre) and the mean colour of those pixels, i.e. of the ball sitting there
    // Until each spot's true image position is known (see the end of this function) report nothing for it.
    const spots = (cal.spots || []).map(([sx, sy], i) => {
      const off = cal.spotOff ? cal.spotOff[i] : null;
      if (!off) return null;
      const x = Math.round(sx + off[0]), y = Math.round(sy + off[1]);
      let k = 0, f = 0, sL = 0, sA = 0, sB = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const j = (y + dy) * W + x + dx; if (j < 0 || j >= n) continue;
        k++; if (m[j]) { f++; sL += L[j]; sA += A[j]; sB += B[j]; }
      }
      return k ? { fg: f / k, L: f ? sL / f : 0, a: f ? sA / f : 0, b: f ? sB / f : 0 } : null;
    });
    const fgRaw = m;
    m = morph(morph(m, W, H, 9), W, H, 1);                       // opening removes speckle
    const lab = new Int32Array(n), stack = []; let id = 0, big = 0; const balls = [], blobs = [];
    for (let i = 0; i < n; i++) {
      if (!m[i] || lab[i]) continue;
      id++; lab[i] = id; stack.push(i);
      let area = 0, sx = 0, sy = 0, sL = 0, sA = 0, sB = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, edge = false;
      while (stack.length) {
        const j = stack.pop(), x = j % W, y = (j / W) | 0;
        area++; sx += x; sy += y; sL += L[j]; sA += A[j]; sB += B[j]; if (cal.rim[j]) edge = true;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const k of [j - 1, j + 1, j - W, j + W]) if (k >= 0 && k < n && m[k] && !lab[k] && Math.abs((k % W) - x) <= 1) { lab[k] = id; stack.push(k); }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (area > 450 || bw > 40 || bh > 40) {
        big += area;
        blobs.push({ x0, y0, x1, y1, area, x: sx / area, y: sy / area, L: sL / area, a: sA / area, b: sB / area, edge });
        continue;
      }
      if (area < 35) continue;
      const cx = sx / area, cy = sy / area;
      if (Math.min(...cal.pockets.map(p => Math.hypot(p[0] - cx, p[1] - cy))) < 14) continue;   // pocket mouths
      const b = { x: cx, y: cy, area, L: sL / area, a: sA / area, b: sB / area };
      if (!isBall(b, cal.cloth)) continue;
      b.white = isWhite(b);
      balls.push(b);
    }
    // A ball's centre shows a few px from its spot: it sits above the cloth and the cloth corners are not exact,
    // by different amounts at each end. Over the first frames find each colour near its spot: a single ball
    // within 12 px, or else (inside a cluster, like the black or pink against the reds) the place nearby with
    // the most pixels of that colour. Each spot takes the median of what was found.
    if (cal.spots && !cal.spotOff) {
      const votes = cal.spotVotes = cal.spotVotes || cal.spots.map(() => []);
      cal.spots.forEach(([x, y], i) => {
        let best = null, bd = 12;
        for (const b of balls) { const d = Math.hypot(b.x - x, b.y - y); if (d < bd && !b.white) { bd = d; best = [b.x - x, b.y - y]; } }
        if (!best) {
          const like = SPOT_LIKE[SPOT_NAMES[i]]; let bs = 7;
          for (let oy = -8; oy <= 8; oy++) for (let ox = -8; ox <= 8; ox++) {
            let c = 0;
            for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
              if (dx * dx + dy * dy > 9) continue;
              const j = (Math.round(y) + oy + dy) * W + Math.round(x) + ox + dx;
              if (j >= 0 && j < n && fgRaw[j] && like(L[j], A[j], B[j])) c++;
            }
            if (c > bs || (c === bs && best && ox * ox + oy * oy < best[0] ** 2 + best[1] ** 2)) { bs = c; best = [ox, oy]; }
          }
        }
        if (best) votes[i].push(best);
      });
      cal.spotFrames = (cal.spotFrames || 0) + 1;
      if (cal.spotFrames >= 10) cal.spotOff = votes.map(v => v.length >= 5 ? [median(v.map(o => o[0])), median(v.map(o => o[1]))] : [0, 0]);
    }
    spots.forEach((sp, i) => { if (!sp) return; const x = cal.spots[i][0] + cal.spotOff[i][0], y = cal.spots[i][1] + cal.spotOff[i][1];
      sp.covered = blobs.some(o => o.edge && x >= o.x0 - 3 && x <= o.x1 + 3 && y >= o.y0 - 3 && y <= o.y1 + 3); });
    return { balls, blobs, big, spots };
  }
  function countFrame(cal, img) {
    const r = detectFrame(cal, img);
    return { balls: r.balls, colours: r.balls.filter(b => !b.white).length, white: r.balls.filter(b => b.white).length, big: r.big };
  }

  // ---- colour clearance counting ---------------------------------------------------------
  // Feed it frame results with their time. It takes the median number of colours each second (skipping
  // seconds where the player covers the table). A clearance is the table emptying of colours after an
  // attempt with 3+ colours was under way; one stray reading of 1-2 (often the cue ball misread) is allowed
  // just before it. Nothing more counts until the colours are re-spotted.
  class ClearanceCounter {
    constructor(opts = {}) {
      this.maxBig = opts.maxBig ?? 3000; this.minSamples = opts.minSamples ?? 3;
      this.sec = null; this.samples = []; this.armed = false; this.lastNonZero = null;
      this.colours = null; this.clearances = []; this.attemptStart = null; this.timeline = [];
    }
    add(t, r) {
      const s = Math.floor(t);
      if (this.sec !== null && s !== this.sec) this._closeSecond();
      this.sec = s;
      if (r.big <= this.maxBig) this.samples.push(r.colours);
    }
    finish() { if (this.sec !== null) this._closeSecond(); }
    _closeSecond() {
      const v = this.samples; this.samples = [];
      if (v.length < this.minSamples) return;
      v.sort((a, b) => a - b); const c = v[v.length >> 1], s = this.sec;
      this.colours = c; this.timeline.push([s, c]);
      if (c >= 3 && !this.armed) { this.armed = true; if (c >= 5 && this.clearances.length) this.attemptStart = s; }
      if (c === 0) {
        if (this.armed && this.lastNonZero !== null && this.lastNonZero <= 2) {
          this.clearances.push({ at: s, took: this.attemptStart !== null ? s - this.attemptStart : null });
          this.armed = false; this.attemptStart = null;
        }
      } else this.lastNonZero = c;
    }
  }

  const api = { findTable, calibrate, detectFrame, countFrame, isWhite, ClearanceCounter, homography, apply, toLab, NEAR_WIDTH, SPOT_NAMES, SPOT_MM };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SnookerVision = api;
})(typeof self !== "undefined" ? self : this);
