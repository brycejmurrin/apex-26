#!/usr/bin/env node
// Editor goldens from f1-game's real track designer core (js/editor/* in the
// verify-track VM: buildContext + customContext). Run by the coordinator, which
// may execute f1-game code; lane sessions consume the output.
//
//   node tools/oracle/editor-dump.cjs --f1 ../f1-game --out tests/goldens
//
// Output tests/goldens/editor-codec.json.gz: { header, themes, designs, badCodes, badSanitize }.
// Per design: sanitize → encode → decode → fileEnvelope/fromFile → customDef →
// Tracks.build (scalars, typed arrays, mesh hashes) → TrackThemes.defFields for
// every theme. Deterministic: Date.now is pinned inside the VM (sanitize stamps
// created/updated with it) and fileEnvelope's exportedAt is dropped.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const vm = require("vm");
const crypto = require("crypto");
const { execSync } = require("child_process");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const F1 = path.resolve(opt("--f1", process.env.F1_GAME || path.join(__dirname, "../../../f1-game")));
const OUT = path.resolve(opt("--out", path.join(__dirname, "../../tests/goldens")));
const NOW = 1700000000000;   // the VM's Date.now(): CustomTracks.sanitize defaults created/updated to it

const { buildContext, customContext, customDef } = require(path.join(F1, "tools/track/verify-track.cjs"));
const Tracks = buildContext(null, { quiet: true });
const ctx = customContext(Tracks);
vm.runInContext(`Date.now = function () { return ${NOW}; };`, ctx);
const { TrackCodec, CustomTracks, TrackThemes, TrackRandom, TrackValidate } = ctx;

// Mesh hashing exactly as track-dump.cjs: every gfx.createMesh call in order,
// sha256 of pos/nrm/col as Float64 LE and idx/mat as Uint32.
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
/** Plain-data copy of a VM value: functions dropped, typed arrays as arrays, cycles marked. */
function plain(v, seen = new Set()) {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
  if (v === null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) return Array.from(v);
  if (seen.has(v)) return { $cycle: true };
  seen.add(v);
  let out;
  if (Array.isArray(v)) out = v.map((e) => { const p = plain(e, seen); return p === undefined ? null : p; });
  else { out = {}; for (const k of Object.keys(v)) { const p = plain(v[k], seen); if (p !== undefined) out[k] = p; } }
  seen.delete(v);
  return out;
}
const err = (e) => ({ $error: String((e && e.message) || e) });
const tryIt = (fn) => { try { return plain(fn()); } catch (e) { return err(e); } };
async function tryAsync(fn) { try { return plain(await fn()); } catch (e) { return err(e); } }

// ── designs ────────────────────────────────────────────────────────────────
const lat = (v) => Math.round(v * 4) / 4;
const ring = (n, fx, fz) => Array.from({ length: n }, (_, i) => { const t = (i / n) * 2 * Math.PI; return [lat(fx(t)), lat(fz(t))]; });
const BASE = { created: 0, updated: 0 };
const designs = [];
designs.push({ label: "oval", input: { ...BASE, name: "Simple Oval", theme: "parkland", baseHW: 7, seed: 1,
  pts: ring(40, (t) => 600 * Math.cos(t), (t) => 300 * Math.sin(t)) } });
designs.push({ label: "minimal-octagon", input: { ...BASE, name: "min", theme: "parkland", baseHW: 6, seed: 2,
  pts: ring(8, (t) => 200 * Math.cos(t), (t) => 200 * Math.sin(t)) } });
designs.push({ label: "figure8-bridge", input: { ...BASE, name: "Figure 8", theme: "tilke", baseHW: 7, seed: 3,
  pts: ring(64, (t) => 700 * Math.sin(t), (t) => 350 * Math.sin(t) * Math.cos(t)),
  bridges: [{ s: 0.5, halfM: 220, rise: 9 }] } });
designs.push({ label: "full-featured", input: { ...BASE, name: "Kitchen Sink ç", country: "Italy", theme: "alpine", baseHW: 7.5, seed: 77,
  pts: ring(48, (t) => 800 * Math.cos(t) + 120 * Math.cos(3 * t), (t) => 450 * Math.sin(t)),
  heights: Array.from({ length: 48 }, (_, i) => lat(6 * Math.sin((i / 48) * 4 * Math.PI))),
  hwZones: [{ s0: 0.1, s1: 0.2, hw: 6, ease: 0.05 }, { s0: 0.6, s1: 0.7, hw: 8 }],
  bankZones: [{ frac: 0.25, angleDeg: 12, widthM: 200 }, { frac: 0.75, angleDeg: 8, widthM: 150 }],
  elevations: [{ s: 0.4, halfM: 300, rise: 10 }],
  look: { time: "dusk", trees: "many", crowd: "packed" }, kerbStyle: "sausage", berms: false,
  turns: [0.1, 0.35, 0.6],
  props: [{ kind: "stand", s: 0.05, side: 1, gap: 4 }, { kind: "trees", s: 0.3, side: -1, gap: 10 }, { kind: "lake", s: 0.55, side: 1, gap: 30 }] } });
designs.push({ label: "zoned-plain-code", input: { ...BASE, name: "Zones", theme: "harbour", baseHW: 5, seed: 0xffffffff,
  pts: ring(30, (t) => 500 * Math.cos(t), (t) => 500 * Math.sin(t)),
  hwZones: [{ s0: 0.9, s1: 0.05, hw: 7.2 }], bankZones: [{ frac: 1, angleDeg: 30, widthM: 600 }], kerbStyle: "rumble" } });

const validGen = (seed, theme) => TrackRandom.generateValid(seed, (pts) => TrackValidate.check({ theme, baseHW: 7, seed, pts }).red === 0, 12);
const RANDOM_SEEDS = [1, 42, 1234, 99999, 3141592653];
const randomGen = [];
for (const seed of RANDOM_SEEDS) {
  const g = TrackRandom.generate(seed);
  randomGen.push({ seed, generate: plain(g) });
  designs.push({ label: "random-" + seed, input: { ...BASE, name: "RANDOM " + seed, theme: TrackThemes.ORDER[seed % TrackThemes.ORDER.length], baseHW: 7, seed, pts: g.pts } });
}
for (const theme of TrackThemes.ORDER) {
  const g = validGen(7, theme);
  designs.push({ label: "theme-" + theme, generateValidOk: g.ok, input: { ...BASE, name: theme.toUpperCase() + " 7", theme, baseHW: 7, seed: 7, pts: g.pts } });
}

async function dumpDesign(d) {
  const row = { label: d.label, input: plain(d.input) };
  if (d.generateValidOk !== undefined) row.generateValidOk = d.generateValidOk;
  const it = CustomTracks.sanitize(d.input);
  row.sanitized = plain(it);
  if (!it) return row;
  row.canonical = CustomTracks.canonical(it);
  row.validate = tryIt(() => TrackValidate.check(it));
  row.code = await tryAsync(() => TrackCodec.encode(it));
  row.codeFromInput = await tryAsync(() => TrackCodec.encode(d.input));
  row.encodeBytes = tryIt(() => TrackCodec.encodeBytes(it, true));
  row.encodeBytesNoName = tryIt(() => TrackCodec.encodeBytes(it, false));
  row.decoded = typeof row.code === "string" ? await tryAsync(() => TrackCodec.decode(row.code)) : null;
  row.shareUrl = typeof row.code === "string" ? TrackCodec.shareUrl(row.code, "https://example.test/") : null;
  row.fromHash = row.shareUrl ? TrackCodec.fromHash("#" + row.shareUrl.split("#")[1]) : null;
  const env = TrackCodec.fileEnvelope(it, typeof row.code === "string" ? row.code : null);
  const envPlain = plain(env); delete envPlain.exportedAt;
  row.fileEnvelope = envPlain;   // exportedAt (wall-clock ISO string) dropped
  row.fromFile = tryIt(() => TrackCodec.fromFile(JSON.parse(JSON.stringify(env))));
  row.fromFileDesignOnly = tryIt(() => TrackCodec.fromFile({ format: TrackCodec.FILE_FORMAT, v: 1, design: plain(it) }));
  row.raw = tryIt(() => CustomTracks.toRaw(it));
  row.defFields = {};
  for (const id of TrackThemes.ORDER) row.defFields[id] = tryIt(() => TrackThemes.defFields(id, it));
  let def;
  try { def = customDef(Tracks, it); } catch (e) { row.def = err(e); return row; }
  row.def = plain(def);
  meshLog = [];
  try {
    const track = Tracks.build(def, {});
    row.track = { scalars: scalars(track), arrays: typed(track),
      pit: track.pit ? { scalars: scalars(track.pit), arrays: typed(track.pit) } : null,
      bankP: track.bankP ? typed(track.bankP) : null,
      geometryDiagnostics: plain(track.geometryDiagnostics || null), meshes: meshLog };
  } catch (e) { row.track = Object.assign(err(e), { meshes: meshLog }); }
  meshLog = null;
  return row;
}

// ── malformed share codes and bad sanitize inputs ─────────────────────────
async function badCodes(goodCode) {
  const body = goodCode.split(".")[2];
  const flip = (s, i) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
  const cases = [
    ["null", null], ["number", 42], ["empty", ""], ["spaces", "   "], ["garbage", "hello world"],
    ["no-body", "APXT1.p."], ["bad-mode", "APXT1.x.AAAA"], ["version-9", "APXT9.p.AAAAAAAAAAAAAAAAAA"],
    ["bad-b64-char", "APXT1.p.AAAA*AAA"], ["too-short", "APXT1.p.AQ"],
    ["flipped-char", "APXT1.p." + flip(body, 10)], ["truncated", "APXT1.p." + body.slice(0, body.length - 4)],
    ["outer-v2-inner-v1", "APXT2.p." + body], ["whitespace-padded", "  " + goodCode + "\n"],
    ["bad-deflate", "APXT1.z.AAAAAAAAAAAAAAAA"], ["deflate-junk", "APXT1.z.____________"],
    ["oversize", "APXT1.p." + "A".repeat(5000)], ["lowercase-magic", goodCode.toLowerCase()],
  ];
  // Hand-built byte records that pass the FNV check but break a field.
  const mk = (bytes) => { const b = Uint8Array.from(bytes); const all = new Uint8Array(b.length + 2); all.set(b); const c = TrackCodec.fnv16(b, b.length); all[b.length] = c & 0xff; all[b.length + 1] = c >> 8; return "APXT" + bytes[0] + ".p." + TrackCodec.b64url(all); };
  const pts8 = [0, 0, 0, 0, 200, 0, 0, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  cases.push(["theme-out-of-range", mk([1, 0, 200, 70, 1, 8].concat(pts8))]);
  cases.push(["width-out-of-range", mk([1, 0, 0, 99, 1, 8].concat(pts8))]);
  cases.push(["n-too-small", mk([1, 0, 0, 70, 1, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
  cases.push(["unknown-version-byte", mk([3, 0, 0, 70, 1, 8].concat(pts8))]);
  cases.push(["degenerate-geometry", mk([1, 0, 0, 70, 1, 8].concat(pts8))]);
  cases.push(["trailing-junk", mk([1, 0, 0, 70, 1, 8].concat(pts8, [9, 9]))]);
  cases.push(["bad-surface-byte", mk([1, 0, 0, 70, 1, 8].concat(pts8, [7]))]);
  const out = [];
  for (const [label, code] of cases) out.push({ label, code, result: await tryAsync(() => TrackCodec.decode(code)) });
  out.push({ label: "fromFile-wrong-format", result: tryIt(() => TrackCodec.fromFile({ format: "nope", code: "x" })) });
  out.push({ label: "fromFile-empty", result: tryIt(() => TrackCodec.fromFile({ format: TrackCodec.FILE_FORMAT })) });
  out.push({ label: "fromFile-null", result: tryIt(() => TrackCodec.fromFile(null)) });
  out.push({ label: "fromHash-bad-escape", result: tryIt(() => TrackCodec.fromHash("#track=%E0%A4%A")) });
  out.push({ label: "fromHash-mixed", result: tryIt(() => TrackCodec.fromHash("#a=1&track=APXT1.p.AAAA&b=2")) });
  out.push({ label: "withoutTrack", result: tryIt(() => TrackCodec.withoutTrack("#a=1&track=APXT1.p.AAAA&b=2")) });
  out.push({ label: "decodeBytes-null", result: tryIt(() => TrackCodec.decodeBytes(null)) });
  return out;
}
function badSanitize() {
  const sq = ring(8, (t) => 200 * Math.cos(t), (t) => 200 * Math.sin(t));
  const P = { ...BASE, theme: "parkland", baseHW: 7, seed: 5, pts: sq };
  const cases = [
    ["null", null], ["number", 42], ["string", "track"], ["empty-object", {}],
    ["pts-not-array", { ...P, pts: "x" }], ["pts-7", { ...P, pts: sq.slice(0, 7) }],
    ["pts-201", { ...P, pts: ring(201, (t) => 3000 * Math.cos(t), (t) => 2000 * Math.sin(t)) }],
    ["pts-nan", { ...P, pts: sq.map((p, i) => (i === 3 ? [NaN, 0] : p)) }],
    ["pts-coord-over", { ...P, pts: sq.map((p, i) => (i === 3 ? [20000, 0] : p)) }],
    ["pts-short-tuple", { ...P, pts: sq.map((p, i) => (i === 3 ? [1] : p)) }],
    ["pts-string-numbers", { ...P, pts: sq.map((p) => [String(p[0]), String(p[1])]) }],
    ["spacing-too-close", { ...P, pts: sq.concat([[sq[7][0] + 2, sq[7][1]]]) }],
    ["loop-too-small", { ...P, pts: ring(8, (t) => 50 * Math.cos(t), (t) => 50 * Math.sin(t)) }],
    ["loop-too-small-loose", { ...P, pts: ring(8, (t) => 50 * Math.cos(t), (t) => 50 * Math.sin(t)) }, { loose: true }],
    ["loop-too-long", { ...P, pts: ring(40, (t) => 2500 * Math.cos(t), (t) => 2500 * Math.sin(t)) }],
    ["loop-too-long-loose", { ...P, pts: ring(40, (t) => 2500 * Math.cos(t), (t) => 2500 * Math.sin(t)) }, { loose: true }],
    ["unknown-theme", { ...P, theme: "mars" }], ["baseHW-99", { ...P, baseHW: 99 }], ["baseHW-nan", { ...P, baseHW: "wide" }],
    ["seed-negative-float", { ...P, seed: -3.7 }], ["seed-missing", { ...P, seed: undefined }],
    ["name-unicode-long", { ...P, name: "  ñame   with\ttabs and émoji 🏁 that is far too long  " }], ["name-empty", { ...P, name: "" }],
    ["country-junk", { ...P, country: "<b>Italy</b>!!" }], ["country-number", { ...P, country: 7 }],
    ["heights-short-and-huge", { ...P, heights: [100, -100, "x", 1.13] }],
    ["zones-garbage", { ...P, hwZones: [null, 5, { s0: 0.1 }, { s0: 0.2, s1: 0.3, hw: 99, ease: 0 }], bankZones: [{ frac: 0.5, angleDeg: 0, widthM: 5 }, { frac: 0.5, angleDeg: -5, widthM: 100 }], elevations: [{ s: 1.5, halfM: 20, rise: 60 }], bridges: "x" }],
    ["zones-25", { ...P, elevations: Array.from({ length: 25 }, (_, i) => ({ s: i / 25, halfM: 50, rise: 1 })) }],
    ["frac-rounds-to-one", { ...P, bankZones: [{ frac: 0.9999995, angleDeg: 10, widthM: 100 }] }],
    ["lengthM-implausible", { ...P, lengthM: 1 }], ["lengthM-plausible", { ...P, lengthM: 1300 }],
    ["look-unknown", { ...P, look: { time: "noon", trees: "few", crowd: 3 } }], ["look-defaults", { ...P, look: { time: "auto", trees: "normal", crowd: "normal" } }],
    ["kerb-bogus-berms-string", { ...P, kerbStyle: "bogus", berms: "false" }],
    ["props-invalid", { ...P, props: [{ kind: "ufo", s: 0.1, side: 1, gap: 4 }, { kind: "stand", s: "x" }, null, { kind: "stand", s: 0.2, side: -5, gap: 999 }] }],
    ["turns-mixed", { ...P, turns: [0.1, "x", 1.25, -0.25, null] }],
    ["created-missing", { theme: "parkland", baseHW: 7, seed: 5, pts: sq }],
  ];
  return cases.map(([label, input, o]) => ({ label, input: plain(input), opts: o || null, result: tryIt(() => CustomTracks.sanitize(input, o)) }));
}

// ── JSON with exact doubles (as tools/oracle/lib.mjs encode) ──────────────
function encode(value) {
  return JSON.stringify(value, function (k, v) {
    const raw = this[k];
    if (typeof raw === "number") {
      if (Object.is(raw, -0)) return { $n: "-0" };
      if (Number.isNaN(raw)) return { $n: "NaN" };
      if (raw === Infinity) return { $n: "Infinity" };
      if (raw === -Infinity) return { $n: "-Infinity" };
    }
    return v;
  });
}

(async () => {
  const rows = [];
  for (const d of designs) {
    const r = await dumpDesign(d);
    rows.push(r);
    const t = r.track;
    console.log(`${d.label}: ${r.sanitized ? r.sanitized.id : "REJECTED"} code=${typeof r.code === "string" ? r.code.slice(0, 8) + "… " + r.code.length : JSON.stringify(r.code)}` +
      (t ? (t.$error ? ` build ERROR ${t.$error}` : ` n=${t.scalars.n} meshes=${t.meshes.length}`) : ""));
  }
  const good = rows.find((r) => typeof r.code === "string" && r.code.includes(".p."));
  const editorFiles = ["js/core/hash32.js", "js/editor/track-themes.js", "js/editor/props.js", "js/editor/custom-tracks.js", "js/editor/codec.js", "js/editor/randomise.js", "js/editor/shape.js", "js/editor/validate.js", "js/track/tracks.js"];
  const doc = {
    header: { source: "f1-game", sha, clock: NOW, designs: rows.length,
      files: Object.fromEntries(editorFiles.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(F1, f))).digest("hex")])),
      notes: "Date.now pinned to clock in the VM; fileEnvelope.exportedAt dropped; {$error} = thrown message; functions dropped from def/raw." },
    themes: { ORDER: plain(TrackThemes.ORDER), LOOK: plain(TrackThemes.LOOK) },
    codec: { MAGIC: TrackCodec.MAGIC, VERSION: TrackCodec.VERSION, VERSION_PROPS: TrackCodec.VERSION_PROPS, FLAG: plain(TrackCodec.FLAG), ZONE_CAPS: plain(TrackCodec.ZONE_CAPS), MAX_CODE: TrackCodec.MAX_CODE, MAX_BYTES: TrackCodec.MAX_BYTES, FILE_FORMAT: TrackCodec.FILE_FORMAT },
    limits: plain(CustomTracks.LIMITS),
    randomGenerate: randomGen,
    designs: rows,
    badCodes: await badCodes(good.code),
    badSanitize: badSanitize(),
  };
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "editor-codec.json.gz");
  const text = encode(doc) + "\n";
  fs.writeFileSync(file, zlib.gzipSync(text, { level: 9 }));
  console.log(`${rows.length} designs → ${path.relative(process.cwd(), file)} ${(fs.statSync(file).size / 1024).toFixed(0)} KB (json ${(text.length / 1048576).toFixed(1)} MB)`);
})().catch((e) => { console.error(e); process.exit(1); });
