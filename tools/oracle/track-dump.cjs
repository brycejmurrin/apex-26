#!/usr/bin/env node
// Track goldens from f1-game's real track engine (TRACK_VM in a Node vm, via
// f1-game tools/track/verify-track.cjs buildContext). Run by the coordinator,
// which is allowed to execute f1-game code; lane sessions consume the output.
//
//   node tools/oracle/track-dump.cjs --f1 ../f1-game --out tests/goldens monza spa ...
//
// Output tests/goldens/track-<id>.json.gz: { header, arrays, queries }.
//   arrays  — every typed array on the built track object (+ pit typed arrays)
//   queries — sample/banking/onKerb/wallAt/inPitLane at N s × 5 lateral x (x = k·hw)
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execSync } = require("child_process");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const F1 = path.resolve(opt("--f1", process.env.F1_GAME || path.join(__dirname, "../../../f1-game")));
const OUT = path.resolve(opt("--out", path.join(__dirname, "../../tests/goldens")));
const N = Number(opt("--samples", "2000"));
const ALL = args.includes("--all") ? (args.splice(args.indexOf("--all"), 1), true) : false;
const SKIP = (opt("--skip", "") || "").split(",").filter(Boolean);
let ids = args.length ? args : ["monza"];
const XS = [-1, -0.5, 0, 0.5, 1];

const { buildContext } = require(path.join(F1, "tools/track/verify-track.cjs"));
const Tracks = buildContext(null, { quiet: true });
if (ALL) ids = Tracks.LIST.map((d) => d.id).filter((id) => !SKIP.includes(id));
// Record every gfx.createMesh call the build makes: order, lengths and a sha256 of each
// buffer (pos/nrm/col as Float64 little-endian, idx/mat as Uint32), so the port can prove
// buffer parity without shipping the buffers.
const ctx = Tracks._vmContext;
let meshLog = null;
const origCreate = ctx.GLX.createMesh;
const h = (arr, T) => (arr ? crypto.createHash("sha256").update(Buffer.from(T.from(arr).buffer)).digest("hex") : null);
ctx.GLX.createMesh = function (buf) {
  if (meshLog) meshLog.push({
    verts: buf && buf.pos ? buf.pos.length / 3 : 0, idx: buf && buf.idx ? buf.idx.length : 0,
    pos: h(buf && buf.pos, Float64Array), nrm: h(buf && buf.nrm, Float64Array), col: h(buf && buf.col, Float64Array),
    idxHash: h(buf && buf.idx, Uint32Array), mat: h(buf && buf.mat, Uint32Array),
  });
  return origCreate.apply(this, arguments);
};
let sha = "unknown";
try { sha = execSync("git rev-parse HEAD", { cwd: F1 }).toString().trim(); } catch (_) {}

function typed(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) out[k] = Array.from(v);
    else if (Array.isArray(v) && v.length && v.every((e) => typeof e === "number")) out[k] = v.slice();
  }
  return out;
}
const scalars = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => typeof v === "number" || typeof v === "boolean" || typeof v === "string"));

fs.mkdirSync(OUT, { recursive: true });
for (const id of ids) {
  const def = Tracks.LIST.find((d) => d.id === id);
  if (!def) throw new Error(`unknown track ${id}`);
  meshLog = [];
  const track = Tracks.build(def, {});
  const meshes = meshLog; meshLog = null;
  const L = track.total;
  const queries = [];
  for (let i = 0; i < N; i++) {
    const s = (i / N) * L;
    const sm = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0] };
    Tracks.sample(track, s, sm);
    const row = { s, sample: sm, x: [] };
    for (const k of XS) {
      const x = k * (sm.hw !== undefined ? sm.hw : track.hw[Math.floor((s / L) * track.n) % track.n]);
      const bk = {};
      const bres = Tracks.banking(track, s, x, bk);
      row.x.push({ x, banking: bres === null ? null : bk, onKerb: Tracks.onKerb(track, s, x), inPitLane: Tracks.inPitLane(track, s, x) });
    }
    row.wallL = Tracks.wallAt(track, s, -1);
    row.wallR = Tracks.wallAt(track, s, 1);
    queries.push(row);
  }
  const doc = {
    header: { source: "f1-game", sha, id, n: track.n, total: L, samples: N, xs: XS,
      engine: crypto.createHash("sha256").update(fs.readFileSync(path.join(F1, "js/track/tracks.js"))).digest("hex") },
    scalars: scalars(track),
    arrays: typed(track),
    pit: track.pit ? { scalars: scalars(track.pit), arrays: typed(track.pit) } : null,
    bankP: track.bankP ? typed(track.bankP) : null,
    meshes,
    queries,
  };
  const file = path.join(OUT, `track-${id}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(doc), { level: 9 }));
  console.log(`${id}: n=${track.n} total=${L.toFixed(1)} arrays=${Object.keys(doc.arrays).length} meshes=${meshes.length} → ${path.relative(process.cwd(), file)} ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
