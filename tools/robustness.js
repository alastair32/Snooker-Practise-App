// Robustness test: run each test video through the tracker with its frames changed the way a different room
// or phone would change them (darker, brighter, tinted, noisy, blurred), and compare the attempt scores with
// the true ones. Based on the corruption benchmarks used in vision research (Hendrycks & Dietterich 2019).
// Usage: node tools/robustness.js <work-dir> [variant ...]
//   Videos are read from <work-dir>/<name>.mp4 (names and Google Drive ids in tools/robustness-videos.json;
//   fetch with https://drive.usercontent.google.com/download?id=<id>&export=download&confirm=t).
//   Detections are cached in <work-dir>/det/<name>-<variant>.jsonl; delete them after changing vision.js.
const { execFileSync, spawn } = require("child_process");
const fs = require("fs"), path = require("path");
const VARIANTS = {
  base: "",
  dark15: "colorchannelmixer=rr=.85:gg=.85:bb=.85",
  dark30: "colorchannelmixer=rr=.7:gg=.7:bb=.7",
  bright15: "colorchannelmixer=rr=1.15:gg=1.15:bb=1.15",
  warm: "colorchannelmixer=rr=1.06:bb=.9",
  cool: "colorchannelmixer=rr=.92:bb=1.08",
  noise: "noise=alls=10:allf=t",
  blur: "gblur=sigma=1.2",
};
const [dir, ...picked] = process.argv.slice(2);
if (!dir) { console.error("usage: node tools/robustness.js <work-dir> [variant ...]"); process.exit(1); }
const variants = picked.length ? picked : Object.keys(VARIANTS);
const videos = JSON.parse(fs.readFileSync(path.join(__dirname, "robustness-videos.json"), "utf8"));
fs.mkdirSync(path.join(dir, "det"), { recursive: true });
const det = (v, p) => path.join(dir, "det", `${v}-${p}.jsonl`);
const done = f => fs.existsSync(f) && fs.readFileSync(f, "utf8").trimEnd().split("\n").pop().includes("spotOff");

// how many true attempt scores were found in order (longest common subsequence), and how many extra
function compare(truth, got) {
  const d = Array.from({ length: truth.length + 1 }, () => new Array(got.length + 1).fill(0));
  for (let i = 1; i <= truth.length; i++) for (let j = 1; j <= got.length; j++)
    d[i][j] = truth[i - 1] === got[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1]);
  const right = d[truth.length][got.length];
  return { right, wrong: got.length - right, exact: right === truth.length && got.length === truth.length };
}

const jobs = [];
for (const v of Object.keys(videos)) for (const p of variants) if (!done(det(v, p))) jobs.push([v, p]);
const parallel = Math.max(1, require("os").cpus().length - 1);
let running = 0;
function next() {
  if (!jobs.length) { if (!running) report(); return; }
  const [v, p] = jobs.shift(); running++;
  console.error(`detecting ${v} ${p} ...`);
  const c = spawn("node", [path.join(__dirname, "dump-detections.js"), path.join(dir, `${v}.mp4`), det(v, p), "10"],
    { env: { ...process.env, PRE_VF: VARIANTS[p] }, stdio: "ignore" });
  c.on("close", () => { running--; next(); });
  if (running < parallel) next();
}
function report() {
  let exact = 0, right = 0, wrong = 0, total = 0, runs = 0;
  for (const [v, { drill, truth }] of Object.entries(videos)) {
    const row = [v.padEnd(4)];
    for (const p of variants) {
      const out = execFileSync("node", [path.join(__dirname, "replay.js"), det(v, p), drill, "--quiet"]).toString().trim().split("\n").pop();
      const got = out.replace("attempts:", "").split(",").map(s => s.trim()).filter(Boolean).map(Number);
      const r = compare(truth, got);
      exact += r.exact; right += r.right; wrong += r.wrong; total += truth.length; runs++;
      row.push(`${p}:${r.right}/${truth.length}${r.wrong ? `+${r.wrong}` : ""}${r.exact ? "*" : ""}`);
    }
    console.log(row.join("  "));
  }
  console.log(`\nexact runs ${exact}/${runs}; true scores found ${right}/${total}; extra wrong scores ${wrong}  (* = exact, +n = extra wrong scores)`);
}
next();
