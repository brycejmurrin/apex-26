/**
 * f1-game's track build plus its camera modules, headless in a Node VM, for the
 * camera parity tests.
 *
 * Loads the engine as f1-game's own harness does (f1-game
 * tools/lib/track-build-vm.cjs:24-152: tools/manifest.cjs TRACK_VM, the circuit
 * defs, LAZY_SCENERY closures, build-props.js, tracks.js; the same loader as
 * tests/unit/scenery/f1vm.ts), then js/ui/track-maps.js, js/data/circuit-lore.js
 * and js/camera/{flyby-sight,flyby-seq,cam-avoid,trackside}.js on top.
 *
 * The parity tests feed BOTH sides the same built track (the VM's, with its
 * props registry): f1-game's FlybySeq reads it through f1-game's Tracks, the
 * port through src/track/core. Compared at the camera-input boundary, so a
 * difference is the camera port's (or a track-core sample/project/terrainY
 * difference, which the track lane's own goldens cover).
 *
 * Skipped where f1-game is absent (CI): set F1_GAME or keep f1-game at
 * /home/f1-game or beside the repo.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import type { FlybyCorner, FlybyTrack } from "../../../src/camera/flyby-seq";
import type { BuiltDef } from "../../../src/track/core/def";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CANDIDATES = process.env["F1_GAME"] ? [process.env["F1_GAME"]] : ["/home/f1-game", path.resolve(ROOT, "../f1-game")];
export const F1 = CANDIDATES.find((p): p is string => !!p && fs.existsSync(path.join(p, "tools/manifest.cjs"))) ?? "";
export const haveF1 = F1 !== "" && fs.existsSync(path.join(F1, "js/camera/flyby-seq.js"));

interface Manifest {
  readonly TRACK_VM: readonly string[];
  readonly CIRCUITS: readonly string[];
  readonly LAZY_SCENERY: readonly string[];
  circuitPath(id: string): string;
}

/** The f1-game globals the camera tests call. VM-realm objects, loosely typed. */
export interface F1Cam {
  readonly sandbox: Record<string, unknown>;
  /** f1-game's FlybySeq / FlybySight / CamAvoid / TracksideCams / Tracks / TrackMaps / TrackMesh. */
  readonly F: VmFlyby;
  readonly S: Record<string, (...a: never[]) => unknown> & { GROUND_OK: number; NEAR_M: number };
  readonly A: Record<string, (...a: never[]) => unknown>;
  readonly TS: Record<string, (...a: never[]) => unknown>;
  readonly Tracks: { LIST: readonly BuiltDef[]; build(def: BuiltDef, opts: unknown): FlybyTrack } & Record<string, (...a: never[]) => unknown>;
  readonly TrackMaps: { corners(def: BuiltDef): readonly FlybyCorner[] };
  readonly TrackMesh: { gridSlot(track: FlybyTrack, i: number): { s: number; x: number } };
  /** Build circuit `id` once (cached): the VM track both sides read. */
  track(id: string): FlybyTrack;
}

// eslint-style escape hatch for a VM object whose API we call by name.
export type VmFlyby = Record<string, (...a: never[]) => unknown> & { DEFAULT: unknown[]; FENCE: number };

const BUILD_PROPS = "js/track/scenery/build-props.js";
const TRACKS = "js/track/tracks.js";
const EXTRA = [
  "js/ui/track-maps.js",
  "js/data/circuit-lore.js",
  "js/camera/flyby-sight.js",
  "js/camera/flyby-seq.js",
  "js/camera/cam-avoid.js",
  "js/camera/trackside.js",
];

let shared: F1Cam | null = null;

/** One VM per test process: the track builds are the slow part (~2 s each). */
export function f1Cam(): F1Cam {
  if (shared) return shared;
  const req = createRequire(path.join(F1, "tools/manifest.cjs"));
  const M = req("./manifest.cjs") as Manifest;
  const noop = (): void => {};
  const capture = (buf: unknown): Record<string, unknown> => {
    const b = buf as { pos?: { length: number }; idx?: { length: number } } | null;
    return { verts: b && b.pos ? b.pos.length / 3 : 0, idxCount: b && b.idx ? b.idx.length : 0 };
  };
  const sandbox: Record<string, unknown> = {
    Math, Array, Float32Array, Float64Array, Uint16Array, Uint32Array, Int32Array, Uint8Array,
    Object, JSON, Map, Set, WeakMap, isNaN, isFinite, parseInt, parseFloat,
    GLX: { createMesh: capture, createChunkedMesh: capture },
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop, trace: noop },
    setTimeout: () => 0, clearTimeout: noop,
  };
  sandbox["window"] = sandbox;
  sandbox["Assets"] = (req("./lib/pack-assets.cjs") as { packAssets(): unknown }).packAssets();
  const ctx = vm.createContext(sandbox);
  const run = (rel: string): void => {
    const src = fs.readFileSync(path.join(F1, rel), "utf8");
    vm.runInContext(src.replace(/^const\b/gm, "var"), ctx, { filename: rel });
  };
  for (const f of M.TRACK_VM) if (f !== "@circuits" && f !== TRACKS && f !== BUILD_PROPS) run(f);
  for (const id of M.CIRCUITS) run(M.circuitPath(id));
  for (const f of M.LAZY_SCENERY) run(f);
  run(BUILD_PROPS);
  run(TRACKS);
  for (const f of EXTRA) run(f);
  const g = <T>(name: string): T => {
    const v = sandbox[name];
    if (v === undefined) throw new Error(`f1-game global ${name} missing`);
    return v as T;
  };
  const Tracks = g<F1Cam["Tracks"]>("Tracks");
  const built = new Map<string, FlybyTrack>();
  shared = {
    sandbox,
    F: g("FlybySeq"),
    S: g("FlybySight"),
    A: g("CamAvoid"),
    TS: g("TracksideCams"),
    Tracks,
    TrackMaps: g("TrackMaps"),
    TrackMesh: g("TrackMesh"),
    track(id) {
      let t = built.get(id);
      if (!t) {
        const def = Tracks.LIST.find((d) => d.id === id);
        if (!def) throw new Error(`no such circuit: ${id}`);
        t = Tracks.build(def, {});
        built.set(id, t);
      }
      return t;
    },
  };
  return shared;
}

/** Every number of `a` and `b` equal under Object.is (structure compared too); the first mismatches. */
export function bitDiff(a: unknown, b: unknown, at = "$", out: string[] = []): string[] {
  if (out.length >= 8) return out;
  if (typeof a === "number" || typeof b === "number") {
    if (!Object.is(a, b)) out.push(`${at}: ${String(a)} vs ${String(b)}`);
    return out;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b) out.push(`${at}: ${String(a)} vs ${String(b)}`);
    return out;
  }
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined).sort();
  if (ka.join() !== kb.join()) { out.push(`${at}: keys ${ka.join()} vs ${kb.join()}`); return out; }
  for (const k of ka) bitDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`, out);
  return out;
}
