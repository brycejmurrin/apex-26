/**
 * f1-game's track build, headless in a Node VM, for scenery parity tests.
 *
 * Loads the engine exactly as f1-game's own harness does (f1-game
 * tools/lib/track-build-vm.cjs:24-152: tools/manifest.cjs TRACK_VM, the
 * circuit defs, LAZY_SCENERY closures, then build-props.js and tracks.js) with
 * a GLX stub that keeps every uploaded buffer. A test swaps one f1-game global
 * (a kit, TrackBuildProps, a circuit's TrackScenery closure) for the TS port,
 * builds, and compares the digest with an unmodified build: the engine stays
 * f1-game's, so any difference is the port's.
 *
 * Skipped where f1-game is absent (CI): set F1_GAME or keep f1-game beside the
 * repo, as tests/unit/circuits.test.ts does.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import type { SceneryCore } from "../../../src/track/scenery/core";

const ROOT = path.resolve(import.meta.dirname, "../../..");
export const F1 = process.env["F1_GAME"] ?? path.resolve(ROOT, "../f1-game");
export const haveF1 = fs.existsSync(path.join(F1, "tools/manifest.cjs"));

interface Manifest {
  readonly TRACK_VM: readonly string[];
  readonly CIRCUITS: readonly string[];
  readonly LAZY_SCENERY: readonly string[];
  circuitPath(id: string): string;
}

/** The VM's global object; f1-game's IIFE globals hang off it. */
export type Sandbox = Record<string, unknown>;

type Fn = (...args: never[]) => unknown;

interface TracksApi {
  readonly LIST: readonly { readonly id: string }[];
  build(def: unknown, opts: unknown): Record<string, unknown>;
  setKeepGeometry(v: boolean): void;
  setCompactProps(v: boolean): void;
}

export interface F1Vm {
  readonly sandbox: Sandbox;
  /** f1-game's engine as a `SceneryCore`, for injecting into TS kits. */
  readonly core: SceneryCore;
  /** f1-game global `name` (e.g. "SceneryNature"). */
  global<T = unknown>(name: string): T;
  /**
   * Build circuit `id` with the given globals replaced for this build only, and
   * return a digest per top-level track field plus one per uploaded mesh.
   */
  build(id: string, overrides?: Record<string, unknown>): Digest;
}

export type Digest = Record<string, string>;

const BUILD_PROPS = "js/track/scenery/build-props.js";
const TRACKS = "js/track/tracks.js";

export function createF1Vm(): F1Vm {
  const req = createRequire(path.join(F1, "tools/manifest.cjs"));
  const M = req("./manifest.cjs") as Manifest;
  const meshes: unknown[] = [];
  const capture = (buf: unknown): Record<string, unknown> => {
    meshes.push(buf);
    const b = buf as { pos?: { length: number }; idx?: { length: number } } | null;
    return { verts: b && b.pos ? b.pos.length / 3 : 0, idxCount: b && b.idx ? b.idx.length : 0 };
  };
  const noop = () => {};
  const sandbox: Sandbox = {
    Math, Array, Float32Array, Float64Array, Uint16Array, Uint32Array, Int32Array, Uint8Array,
    Object, JSON, Map, Set, isNaN, isFinite, parseInt, parseFloat,
    GLX: { createMesh: capture, createChunkedMesh: capture },
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop, trace: noop },
  };
  sandbox["window"] = sandbox;
  sandbox["Assets"] = (req("./lib/pack-assets.cjs") as { packAssets(): unknown }).packAssets();
  const ctx = vm.createContext(sandbox);
  const run = (rel: string) => {
    const src = fs.readFileSync(path.join(F1, rel), "utf8");
    vm.runInContext(src.replace(/^const\b/gm, "var"), ctx, { filename: rel });
  };
  for (const f of M.TRACK_VM) if (f !== "@circuits" && f !== TRACKS && f !== BUILD_PROPS) run(f);
  for (const id of M.CIRCUITS) run(M.circuitPath(id));
  for (const f of M.LAZY_SCENERY) run(f);
  run(BUILD_PROPS);
  run(TRACKS);
  const Tracks = sandbox["Tracks"] as TracksApi;
  Tracks.setCompactProps(true);
  Tracks.setKeepGeometry(true);

  const g = <T>(name: string): T => {
    const v = sandbox[name];
    if (v === undefined) throw new Error(`f1-game global ${name} missing`);
    return v as T;
  };
  const M4 = g<{ lerp: Fn; clamp: Fn }>("M4");
  const core = {
    geom: g("TrackGeom"),
    mesh: g("TrackMesh"),
    space: g("TrackSpace"),
    pit: g("TrackPit"),
    spline: g("TrackSpline"),
    surface: g("TrackSurface"),
    scalar: { lerp: M4.lerp, clamp: M4.clamp },
    assets: sandbox["Assets"] ?? null,
    glx: sandbox["GLX"] ?? null,
    garage: sandbox["GarageScene"] ?? null,
  } as unknown as SceneryCore;

  // f1-game quirk: a scenery closure may `Object.assign(pal, ATM.x)`, which
  // mutates `def.palette`, so a circuit's FIRST build paints road/terrain from
  // the authored palette and every later build from the mutated one (redbull).
  // Build each circuit once, unmodified, before the first digest, so every
  // compared build starts from the same def.
  const warmed = new Set<string>();

  return {
    sandbox,
    core,
    global: g,
    build(id, overrides = {}) {
      const saved = new Map<string, unknown>();
      for (const [k, v] of Object.entries(overrides)) { saved.set(k, sandbox[k]); sandbox[k] = v; }
      meshes.length = 0;
      try {
        const def = Tracks.LIST.find((d) => d.id === id);
        if (!def) throw new Error(`no such circuit: ${id}`);
        if (!warmed.has(id)) {
          const swapped = new Map<string, unknown>();
          for (const k of saved.keys()) { swapped.set(k, sandbox[k]); sandbox[k] = saved.get(k); }
          Tracks.build(def, {});
          for (const [k, v] of swapped) sandbox[k] = v;
          warmed.add(id);
        }
        meshes.length = 0;
        const track = Tracks.build(def, {});
        const out: Digest = {};
        for (const key of Object.keys(track).sort()) {
          if (key === "_gfx" || key === "def" || key === "meshes" || key === "buildProfile") continue;
          out[key] = digest(track[key]);
        }
        meshes.forEach((m, i) => { out[`mesh#${i}`] = digest(m); });
        return out;
      } finally {
        for (const [k, v] of saved) sandbox[k] = v;
        meshes.length = 0;
      }
    },
  };
}

/**
 * A structural hash, realm-agnostic (VM and host objects hash alike). Numbers
 * hash by their float64 bits (so -0, NaN and the last ulp count), typed arrays
 * by element type plus contents, objects by sorted own keys. Functions are
 * skipped; a revisited object hashes as a back-reference. Keys in WALL_CLOCK
 * hold timings (the hidden-face and compaction passes stamp `ms`) and are
 * skipped, so two identical builds hash alike.
 */
const WALL_CLOCK = new Set(["ms"]);

export function digest(value: unknown): string {
  let h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0;
  const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  const mix = (x: number) => {
    h1 = Math.imul(h1 ^ x, 0x01000193);
    h2 = Math.imul(h2 ^ (x + 0x9e3779b9), 0x85ebca6b) ^ (h2 >>> 13);
  };
  const num = (x: number) => { f64[0] = x; mix(u32[0] as number); mix(u32[1] as number); };
  const str = (s: string) => { mix(s.length); for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); };
  const seen = new Map<object, number>();
  const walk = (v: unknown): void => {
    if (v === null) { mix(1); return; }
    switch (typeof v) {
      case "undefined": mix(2); return;
      case "boolean": mix(v ? 3 : 4); return;
      case "number": mix(5); num(v); return;
      case "string": mix(6); str(v); return;
      case "function": mix(7); return;
      case "bigint": case "symbol": mix(8); str(String(v)); return;
    }
    const o = v as object;
    const ref = seen.get(o);
    if (ref !== undefined) { mix(9); mix(ref); return; }
    seen.set(o, seen.size);
    if (ArrayBuffer.isView(o)) {
      const ta = o as unknown as { length: number; [i: number]: number };
      mix(10); str(o.constructor.name); mix(ta.length);
      for (let i = 0; i < ta.length; i++) num(ta[i] as number);
      return;
    }
    if (Array.isArray(o)) { mix(11); mix(o.length); for (const x of o) walk(x); return; }
    if (o instanceof Map || Object.prototype.toString.call(o) === "[object Map]") {
      mix(12); for (const [k, x] of o as Map<unknown, unknown>) { walk(k); walk(x); } return;
    }
    if (Object.prototype.toString.call(o) === "[object Set]") {
      mix(13); for (const x of o as Set<unknown>) walk(x); return;
    }
    // An accumulator (models.js makeAccum) exposes its storage as `_data`.
    const acc = o as { _data?: unknown; length?: unknown };
    if (acc._data && ArrayBuffer.isView(acc._data) && typeof acc.length === "number") {
      const d = acc._data as unknown as { [i: number]: number };
      mix(14); mix(acc.length);
      for (let i = 0; i < acc.length; i++) num(d[i] as number);
      return;
    }
    mix(15);
    const rec = o as Record<string, unknown>;
    for (const k of Object.keys(rec).sort()) { if (!WALL_CLOCK.has(k)) { str(k); walk(rec[k]); } }
  };
  walk(value);
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** Keys whose digests differ between two builds (empty = identical). */
export function diffDigests(a: Digest, b: Digest): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}
