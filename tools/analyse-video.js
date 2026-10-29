// Run the camera page's vision code on a video file with Node + ffmpeg, to test it on recorded sessions.
// Usage: node tools/analyse-video.js <video> [calibration-time-seconds] [frames-per-second]
const { execFileSync, spawn } = require("child_process");
// Frame size after ffmpeg applies the phone's rotation flag (ffprobe reports the stored size).
function frameSize(video) {
  const ppm = execFileSync("ffmpeg", ["-v", "error", "-i", video, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "ppm", "-"], { maxBuffer: 1 << 28 });
  const [, w, h] = ppm.subarray(0, 32).toString("latin1").split(/\s+/);
  return [+w, +h];
}
const V = require("../camera/vision.js");

const [video, calT = "10", fps = "6"] = process.argv.slice(2);
const [FW, FH] = frameSize(video);
const still = execFileSync("ffmpeg", ["-v", "error", "-ss", calT, "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 });
const quad = V.findTable({ data: still, width: FW, height: FH });
if (!quad) { console.error("No table found"); process.exit(1); }
const cal = V.calibrate(quad);
const { sx, sy, sw, sh } = cal.crop;
console.log("table corners", quad.map(p => p.map(Math.round)), "-> processing", cal.W, "x", cal.H);

const ff = spawn("ffmpeg", ["-v", "error", "-i", video, "-vf",
  `fps=${fps},crop=${Math.round(sw)}:${Math.round(sh)}:${Math.round(sx)}:${Math.round(sy)},scale=${cal.W}:${cal.H}`,
  "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
const size = cal.W * cal.H * 4; let buf = Buffer.alloc(0), k = 0;
const counter = new V.ClearanceCounter();
ff.stdout.on("data", d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= size) {
    const r = V.countFrame(cal, { data: buf.subarray(0, size), width: cal.W, height: cal.H });
    counter.add(k / Number(fps), r); k++; buf = buf.subarray(size);
  }
});
ff.on("close", () => {
  counter.finish();
  console.log("colours per second:", counter.timeline.map(([s, c]) => `${s}:${c}`).join(" "));
  console.log(`${counter.clearances.length} clearances:`, counter.clearances.map(c => `${c.at}s${c.took !== null ? ` (took ${c.took}s)` : ""}`).join(", "));
});
