// Detect balls in every analysed frame of a video and save them as JSON lines, so the tracking and scoring
// code can be developed and tested quickly without decoding the video again.
// Usage: node tools/dump-detections.js <video> <out.jsonl> [frames-per-second]
const { execFileSync, spawn } = require("child_process");
// Frame size after ffmpeg applies the phone's rotation flag (ffprobe reports the stored size).
function frameSize(video) {
  const ppm = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "ppm", "-"], { maxBuffer: 1 << 28 });
  const [, w, h] = ppm.subarray(0, 32).toString("latin1").split(/\s+/);
  return [+w, +h];
}
const fs = require("fs");
const V = require("../camera/vision.js");

const [video, out, fps = "10"] = process.argv.slice(2);
const [FW, FH] = frameSize(video);
const dur = +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).toString().trim();

// Calibrate on the per-pixel median of 9 frames across the video, so a player walking past doesn't matter.
const stills = [];
for (let k = 1; k <= 9; k++) {
  stills.push(execFileSync("ffmpeg", ["-v", "error", "-ss", String(dur * k / 10), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 }));
}
const med = Buffer.alloc(FW * FH * 4), tmp = new Uint8Array(9);
for (let i = 0; i < med.length; i++) { for (let k = 0; k < 9; k++) tmp[k] = stills[k][i]; tmp.sort(); med[i] = tmp[4]; }
const quad = V.findTable({ data: med, width: FW, height: FH });
if (!quad) { console.error("No table found"); process.exit(1); }
const cal = V.calibrate(quad);
const { sx, sy, sw, sh } = cal.crop;
const { inside, rim, ...meta } = cal;
const ws = fs.createWriteStream(out);
ws.write(JSON.stringify({ meta: { ...meta, video, fps: +fps, frame: [FW, FH] } }) + "\n");

const ff = spawn("ffmpeg", ["-v", "error", "-i", video, "-vf",
  `fps=${fps},crop=${Math.round(sw)}:${Math.round(sh)}:${Math.round(sx)}:${Math.round(sy)},scale=${cal.W}:${cal.H}`,
  "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
const size = cal.W * cal.H * 4; let buf = Buffer.alloc(0), k = 0;
const r1 = v => Math.round(v * 10) / 10;
ff.stdout.on("data", d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= size) {
    const r = V.detectFrame(cal, { data: buf.subarray(0, size), width: cal.W, height: cal.H });
    ws.write(JSON.stringify({ t: r1(k / fps),
      balls: r.balls.map(b => [r1(b.x), r1(b.y), b.area, Math.round(b.L), Math.round(b.a), Math.round(b.b), b.white ? 1 : 0]),
      blobs: r.blobs.map(b => [b.x0, b.y0, b.x1, b.y1, b.area, b.edge ? 1 : 0, Math.round(b.L), Math.round(b.a), Math.round(b.b)]),
      spots: r.spots.map(s => s && [r1(s.fg), Math.round(s.L), Math.round(s.a), Math.round(s.b), s.covered ? 1 : 0]) }) + "\n");
    k++; buf = buf.subarray(size);
  }
});
ff.on("close", () => { ws.end(JSON.stringify({ spotOff: cal.spotOff }) + "\n"); console.log("spot offsets", JSON.stringify(cal.spotOff)); console.log(out, k, "frames; corners", quad.map(p => p.map(Math.round))); });
