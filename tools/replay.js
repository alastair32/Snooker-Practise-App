// Replay saved detections (from dump-detections.js) through the tracker and a scorer, printing what happens.
// Usage: node tools/replay.js <detections.jsonl> <drill: lineup|colours> [--quiet]
const fs = require("fs");
const E = require("../camera/engine.js");
const V = require("../camera/vision.js");
const [file, drillName, flag] = process.argv.slice(2);
const DRILLS = {
  lineup: { metric: "break", expect: { red: 15, yellow: 1, green: 1, brown: 1, blue: 1, pink: 1, black: 1 } },
  colours: { metric: "break", expect: { yellow: 1, green: 1, brown: 1, blue: 1, pink: 1, black: 1 } },
};
const drill = DRILLS[drillName];
const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
const meta = lines[0].meta;
// the spot offsets vision learnt during the dump are saved on the last line
if (lines[lines.length - 1].spotOff) meta.spotOff = lines.pop().spotOff;
const tracker = new E.TableTracker(meta, { expect: drill.expect });
const scorer = new E.DrillScorer(drill, a => console.log(`ATTEMPT ${a.start.toFixed(1)}-${a.end.toFixed(1)}s score ${a.score} [${a.pots.join(" ")}] ended: ${a.why}`));
if (flag === "--spots") tracker.debug = d => { if (d.type && d.type.startsWith("spot")) console.log(`  ${d.t.toFixed(1)}s ${d.type} ${d.colour}`); };
if (flag === "--debug") tracker.debug = d => console.log("  dbg", JSON.stringify(d));
scorer.attach(tracker);
tracker.on(e => {
  scorer.feed(e);
  if (flag === "--quiet") return;
  if (e.type === "shot") console.log(`${e.t.toFixed(1)}s shot ${e.result}${e.pots.length ? " " + e.pots.map(p => p.type + (p.wrongPocket ? "(wrong pocket)" : "")).join(",") : ""}`);
  else console.log(`${e.t.toFixed(1)}s ${e.type} ${(e.balls || []).join(",")}`);
});
for (const f of lines.slice(1)) {
  tracker.feed(f.t, {
    balls: f.balls.map(([x, y, area, L, a, b]) => ({ x, y, area, L, a, b, white: V.isWhite({ L, a, b }) })),
    spots: f.spots && f.spots.map(s => s && { fg: s[0], L: s[1], a: s[2], b: s[3], covered: !!s[4] }),
    blobs: f.blobs.map(([x0, y0, x1, y1, area, edge, L, a, b]) => ({ x0, y0, x1, y1, area, edge: !!edge, L, a, b, x: (x0 + x1) / 2, y: (y0 + y1) / 2 })),
  });
}
scorer.finish(lines[lines.length - 1].t);
console.log("attempts:", scorer.attempts.map(a => a.score).join(", "));
