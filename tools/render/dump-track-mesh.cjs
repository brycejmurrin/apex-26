#!/usr/bin/env node
// Dump a circuit's track mesh buffers from f1-game's headless track build
// (f1-game tools/lib/track-build-vm.cjs `buildContext`, the TRACK_VM harness) into
// artifacts/track-mesh/<id>/, for the render demo until the track lane's builder
// lands (PLAN T1.7). Each mesh slot becomes `<key>.<channel>.bin` (raw little-endian
// Float32 / Uint32) plus one `manifest.json`.
//
//   node tools/render/dump-track-mesh.cjs [circuit=monza] [--f1=../f1-game]
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--")) || "monza";
const f1Arg = args.find((a) => a.startsWith("--f1="));
const F1 = path.resolve(f1Arg ? f1Arg.slice(5) : path.join(__dirname, "../../../f1-game"));
const OUT = path.resolve(__dirname, "../../artifacts/track-mesh", id);

const { buildContext } = require(path.join(F1, "tools/lib/track-build-vm.cjs"));
const env = buildContext({ compact: true });
const def = env.Tracks.LIST.find((d) => d.id === id);
if (!def) throw new Error(`unknown circuit ${id}`);

// Capture the full upload buffer for every createMesh call (tracks.js:259 takes the
// backend from opts.gfx), keyed by the slot tracks.js assigns it to.
const uploads = [];
const gfx = {
  createMesh(geo) { const h = { geo, verts: geo.pos.length / 3 }; uploads.push(h); return h; },
};
const track = env.Tracks.build(def, { night: false, gfx });

const KEYS = ["road", "terrain", "floor", "props", "glass", "water", "gate", "startline"];
const unwrap = (a) => (a && a._data ? a._data.subarray(0, a.length) : a);
fs.mkdirSync(OUT, { recursive: true });
const manifest = { id, source: "f1-game tools/lib/track-build-vm.cjs", meshes: {} };
for (const key of KEYS) {
  const h = track.meshes[key];
  if (!h || !h.geo || !h.geo.pos || h.geo.pos.length === 0) continue;
  const g = h.geo;
  const entry = { verts: h.verts, channels: {} };
  for (const ch of ["pos", "nrm", "col", "idx", "mat", "trk"]) {
    const src = unwrap(g[ch]);
    if (!src || src.length === 0) continue;
    const arr = ch === "idx" ? Uint32Array.from(src) : Float32Array.from(src);
    fs.writeFileSync(path.join(OUT, `${key}.${ch}.bin`), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    entry.channels[ch] = arr.length;
  }
  manifest.meshes[key] = entry;
}
// The centreline (tracks.js node arrays px/py/pz, tangent tx/ty/tz), so the demo can
// place a camera on the road.
for (const ch of ["px", "py", "pz", "tx", "ty", "tz"]) {
  const arr = Float32Array.from(track[ch]);
  fs.writeFileSync(path.join(OUT, `centre.${ch}.bin`), Buffer.from(arr.buffer));
}
manifest.centre = { n: track.n, total: track.total };
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`${id}: ${Object.keys(manifest.meshes).map((k) => `${k}=${manifest.meshes[k].verts}`).join(" ")} -> ${OUT}`);
