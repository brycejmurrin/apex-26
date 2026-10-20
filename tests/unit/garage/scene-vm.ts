/**
 * Shared harness for the garage SCENE tests: f1-game's js/garage/scene*.js
 * loaded in a Node VM (the load order of f1-game tests/unit/garage-mesh.test.mjs:39-41),
 * a recording renderer facade, a recording 2D canvas and a LiveryTex stub, so
 * the TS port and the original can be driven through the same calls and their
 * logs compared value for value. Mesh payloads are summarised by length and an
 * FNV-1a hash over each array's Float64 bits (bit-exact, -0 and NaN included).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { F1_ROOT } from "../data/f1-vm";

export { F1_ROOT };
export const hasF1Scene = existsSync(path.join(F1_ROOT, "js/garage/scene.js"));

/** f1-game's own scene harness load order, plus the crew. */
export const SCENE_FILES = [
  "js/track/core/geom.js", "js/track/core/pit.js", "js/garage/scene-prims.js", "js/garage/scene-equipment.js",
  "js/garage/scene-live.js", "js/garage/scene-dress.js", "js/garage/experience.js", "js/garage/scene-crew.js",
  "js/garage/scene.js",
];

/** Evaluate `files` in one context seeded with `globals`; returns a binding reader. */
export function f1Scene(globals: Record<string, unknown> = {}, files: readonly string[] = SCENE_FILES): (name: string) => unknown {
  const ctx = createContext({
    console, Math, Object, Array, Number, String, JSON, Float32Array, Float64Array, Int32Array, Uint16Array,
    Uint32Array, Uint8Array, Map, Set, Error, Symbol, Proxy, Infinity, NaN, isFinite, parseFloat, parseInt, Date,
    Log: { info() {}, warn() {}, error() {}, debug() {}, enabled: () => false },
    ...globals,
  });
  for (const f of files) runInContext(readFileSync(path.join(F1_ROOT, f), "utf8"), ctx, { filename: f });
  return (name) => runInContext(name, ctx);
}

/** FNV-1a over the Float64 bits of every element. */
export function fnv(a: ArrayLike<number>): string {
  const dv = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  for (let k = 0; k < a.length; k++) {
    dv.setFloat64(0, a[k]!);
    for (let i = 0; i < 8; i++) h = Math.imul(h ^ dv.getUint8(i), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

type Arrs = { pos?: ArrayLike<number>; nrm?: ArrayLike<number>; col?: ArrayLike<number>; mat?: ArrayLike<number>; uv?: ArrayLike<number>; idx?: ArrayLike<number> };
/** Lengths and hashes of a mesh accumulator's arrays. */
export function summary(m: Arrs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["pos", "nrm", "col", "mat", "uv", "idx"] as const) {
    const a = m[k];
    if (a) out[k] = `${a.length}:${fnv(a)}`;
  }
  return out;
}

/** JSON of a plain value with cross-realm objects flattened. */
const js = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  (x instanceof Float32Array || (x && typeof x === "object" && (x as { constructor?: { name?: string } }).constructor?.name === "Float32Array"))
    ? Array.from(x as ArrayLike<number>) : x);

/** A recording renderer facade: every call lands in `log`; handles are numbered by creation. */
export function recordingGfx(opts: { failTexture?: () => boolean } = {}) {
  const log: string[] = [];
  const meshes: Arrs[] = [], live = new Set<object>();
  let n = 0;
  const handle = (kind: string): { id: number; kind: string } => { const h = { id: ++n, kind }; live.add(h); return h; };
  const id = (h: unknown): string => (h && typeof h === "object" && "id" in h ? `#${(h as { id: unknown }).id}` : `?${js(h)}`);
  const gfx = {
    createMesh(d: Arrs) { meshes.push(d); const h = handle("mesh"); log.push(`mesh ${id(h)} ${js(summary(d))}`); return h; },
    createTexMesh(d: Arrs) { meshes.push(d); const h = handle("tex"); log.push(`texmesh ${id(h)} ${js(summary(d))}`); return h; },
    createTexture(cv: { width: number; height: number }) {
      if (opts.failTexture && opts.failTexture()) { log.push("texture FAIL"); throw new Error("injected texture failure"); }
      const h = handle("texture"); log.push(`texture ${id(h)} ${cv.width}x${cv.height}`); return h;
    },
    freeMesh(h: object) { live.delete(h); log.push(`free ${id(h)}`); },
    freeTexture(h: object) { live.delete(h); log.push(`freeTex ${id(h)}`); },
    draw(h: unknown, m: ArrayLike<number>, o: unknown) { log.push(`draw ${id(h)} ${fnv(m)} ${js(o)}`); },
    drawDecal(h: unknown, m: ArrayLike<number>, t: unknown, o: unknown) { log.push(`decal ${id(h)} ${fnv(m)} ${id(t)} ${js(o)}`); },
    drawGlow() {},
  };
  return { gfx, log, meshes, live };
}

/**
 * A recording 2D canvas: property writes and method calls with their
 * arguments, in order. Gradients are numbered and record their stops.
 */
export function recordingCanvas() {
  const ops: string[] = [];
  let nGrad = 0, nCanvas = 0;
  const ctx2d = (cid: number) => {
    const state: Record<string, unknown> = {};
    return new Proxy(state, {
      get(_t, k) {
        if (typeof k === "symbol") return undefined;
        if (k === "measureText") return (s: string) => { ops.push(`c${cid}.measureText(${js(s)})`); return { width: 10 * String(s).length }; };
        if (k === "createRadialGradient" || k === "createLinearGradient") return (...a: unknown[]) => {
          const g = ++nGrad; ops.push(`c${cid}.${k}(${js(a)})=g${g}`);
          return { _g: g, addColorStop: (o: number, c: string) => ops.push(`g${g}.stop(${o},${c})`) };
        };
        if (k in state) return state[k];
        return (...a: unknown[]) => { ops.push(`c${cid}.${k}(${js(a)})`); };
      },
      set(t, k, v) {
        const shown = v && typeof v === "object" && "_g" in (v as object) ? `g${(v as { _g: number })._g}` : js(v);
        ops.push(`c${cid}.${String(k)}=${shown}`); t[k as string] = v; return true;
      },
    });
  };
  const make = (w = 0, h = 0) => {
    const cid = ++nCanvas, c = ctx2d(cid);
    return { width: w, height: h, getContext: () => c, _cid: cid };
  };
  return { ops, createCanvas: (w: number, h: number) => make(w, h), document: { createElement: () => make() } };
}

/** A LiveryTex stub whose calls land in `ops` (the canvas argument is not printed). */
export function liveryStub(ops: string[]) {
  return {
    paintTeamMark: (_ctx: unknown, id: unknown, liv: unknown, R: unknown, field: unknown, o: unknown) =>
      ops.push(`paintTeamMark(${js([id, liv, R, field, o])})`),
    inkOn: (c: unknown) => { ops.push(`inkOn(${js(c)})`); return [0.97, 0.97, 0.98]; },
    contrast: (a: unknown, b: unknown) => { ops.push(`contrast(${js([a, b])})`); return 1.5; },
    markOnField: (id: unknown) => { ops.push(`markOnField(${js(id)})`); return [[0.1, 0.12, 0.14], [0.9, 0.2, 0.1]]; },
    LOGOS: {},
    SPONSORS: { mclaren: ["PAPAYA", "OCEAN", "CHIPS"] },
    SPONSOR_PACKS: { clean: ["CLEAN A", "CLEAN B"] },
  };
}

export const TEAM = { id: "mclaren", name: "McLaren", short: "MCL",
  drivers: [{ name: "A", code: "AAA", num: 4 }, { name: "B", code: "BBB", num: 81 }] };
export const LIV = { c1: [0.95, 0.45, 0.05], c2: [0.05, 0.05, 0.06], accent: [0.1, 0.7, 0.9] };
export const TEAM2 = { id: "ferrari", name: "Ferrari", short: "FER", legend: null,
  drivers: [{ name: "C", code: "CCC", num: 16 }, { name: "D", code: "DDD", num: 44 }],
  stats: { speed: 90, accel: 88, cornering: 86, braking: 84 } };
export const LIV2 = { c1: [0.8, 0.05, 0.05], c2: [1, 0.9, 0.1], sponsors: "clean" };
