// T1.3 + all circuits: the ported track core against f1-game's own build (tests/goldens/track-<id>.json.gz,
// produced by tools/oracle/track-dump.cjs in the coordinator session; see tests/goldens/README.md).
// Every comparison is Object.is, except that JSON cannot carry -0: where the golden holds 0
// the port may hold -0 (the same double f1-game computed before serialisation).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { BankingOut, TrackSample } from "../../src/contracts/track";
import { trackQuery } from "../../src/track/build/query";
import { CIRCUITS } from "../../src/circuits/index";
import { buildTrack, defById, validateGeometry } from "../../src/track/core/tracks";
import type { SealedGeom, Track, TrackGeometry } from "../../src/track/core/types";

interface XRow { x: number; banking: BankingOut | null; onKerb: number; inPitLane: boolean }
interface QueryRow { s: number; sample: TrackSample; x: XRow[]; wallL: number; wallR: number }
interface Golden {
  header: { sha: string; id: string; n: number; total: number; samples: number };
  scalars: Record<string, number | boolean>;
  arrays: Record<string, number[]>;
  pit: { scalars: Record<string, unknown>; arrays: Record<string, number[]> };
  bankP: { lift: number[]; bsign: number[] } | null;
  queries: QueryRow[];
  meshes: MeshRow[];
}
/** One gfx.createMesh call of f1-game's build (tools/oracle/track-dump.cjs:37). */
interface MeshRow { verts: number; idx: number; pos: string; nrm: string; col: string; idxHash: string; mat: string | null }

const IDS = CIRCUITS.map((c) => c.id);
const load = (id: string): Golden =>
  JSON.parse(gunzipSync(readFileSync(new URL(`../goldens/track-${id}.json.gz`, import.meta.url))).toString()) as Golden;

const same = (a: unknown, b: unknown): boolean => Object.is(a, b) || (b === 0 && a === 0);

/** Index of the first difference, or -1. */
function firstDiff(a: ArrayLike<number> | undefined, b: readonly number[]): number {
  if (!a || a.length !== b.length) return 0;
  for (let i = 0; i < b.length; i++) if (!same(a[i], b[i])) return i;
  return -1;
}
const sha = (a: ArrayLike<number> | undefined, T: Float64ArrayConstructor | Uint32ArrayConstructor): string | null =>
  a ? createHash("sha256").update(new Uint8Array(T.from(a).buffer)).digest("hex") : null;
const meshRow = (g: SealedGeom): MeshRow => ({
  verts: g.pos.length / 3, idx: g.idx.length,
  pos: sha(g.pos, Float64Array)!, nrm: sha(g.nrm, Float64Array)!, col: sha(g.col, Float64Array)!,
  idxHash: sha(g.idx, Uint32Array)!, mat: sha(g.mat, Uint32Array),
});
// f1-game's createMesh order in buildSteps (tracks.js:331-418). props/glass/water carry the
// scenery f1-game bakes into them, so they match only once the scenery lane's PropsBuilder is wired.
const MESH_ORDER: (keyof TrackGeometry)[] = ["floor", "road", "terrain", "props", "glass", "water", "gate", "startline"];
const SCENERY_MESHES = new Set<keyof TrackGeometry>(["props", "glass", "water"]);

const vecSame = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => same(v, b[i]));

// Built by the scenery lane (build-props.js); the port's stub leaves them unset.
const SCENERY_ARRAYS = new Set(["barL", "barR"]);

describe.each(IDS)("track parity: %s", (id) => {
  const g = load(id);
  const track: Track = buildTrack(defById(id)!);
  const arr = track as unknown as Record<string, ArrayLike<number> | undefined>;

  it("centreline scalars", () => {
    expect(track.n).toBe(g.scalars.n);
    expect(Object.is(track.total, g.scalars.total)).toBe(true);
    expect(track.street).toBe(g.scalars.street);
  });

  it.each(Object.keys(g.arrays).filter((k) => !SCENERY_ARRAYS.has(k)))("array %s", (k) => {
    expect(firstDiff(arr[k], g.arrays[k]!)).toBe(-1);
  });

  it("pit model", () => {
    const pit = track.pit as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(g.pit.arrays)) expect(firstDiff(pit[k] as Float32Array, v), `pit.${k}`).toBe(-1);
    for (const [k, v] of Object.entries(g.pit.scalars)) {
      if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") expect(same(pit[k], v), `pit.${k}`).toBe(true);
    }
  });

  it("banking profile", () => {
    if (!g.bankP) { expect(track.bankP).toBeNull(); return; }
    const bp = track.bankP as unknown as Record<string, Float32Array>;
    for (const [k, v] of Object.entries(g.bankP)) expect(firstDiff(bp[k], v), `bankP.${k}`).toBe(-1);
  });

  it("TrackQuery sample / banking / onKerb / inPitLane at 2,000 s x 5 x", () => {
    const q = trackQuery(track);
    const smp: TrackSample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
    const bo: BankingOut = { dy: 0, roll: 0 };
    expect(g.queries.length).toBe(g.header.samples);
    for (const e of g.queries) {
      const s = q.sample(e.s, smp);
      const ok = vecSame(s.p, e.sample.p) && vecSame(s.t, e.sample.t) && vecSame(s.r, e.sample.r) && same(s.hw, e.sample.hw);
      if (!ok) expect.fail(`sample(${e.s})`);
      for (const xe of e.x) {
        const b = q.banking(e.s, xe.x, bo);
        if (xe.banking === null ? b !== null : !(b && same(b.dy, xe.banking.dy) && same(b.roll, xe.banking.roll)))
          expect.fail(`banking(${e.s}, ${xe.x})`);
        if (q.onKerb(e.s, xe.x) !== xe.onKerb) expect.fail(`onKerb(${e.s}, ${xe.x})`);
        if (q.inPitLane(e.s, xe.x) !== xe.inPitLane) expect.fail(`inPitLane(${e.s}, ${xe.x})`);
      }
    }
  });

  it("buffers are well formed", () => {
    for (const [k, geo] of Object.entries(track.geo!)) expect(validateGeometry(geo).ok, k).toBe(true);
  });

  it.each(MESH_ORDER.filter((k) => !SCENERY_MESHES.has(k)))("mesh buffer %s", (k) => {
    expect(g.meshes.length).toBe(MESH_ORDER.length);
    expect(meshRow(track.geo![k])).toEqual(g.meshes[MESH_ORDER.indexOf(k)]);
  });
  it.todo("mesh buffers props / glass / water (TODO(lane-scenery): PropsBuilder)");

  it("TrackQuery wallAt, fed f1-game's barrier arrays (TODO(lane-scenery): build them)", () => {
    const fed: Track = { ...track, barL: new Float32Array(g.arrays.barL!), barR: new Float32Array(g.arrays.barR!) };
    const q = trackQuery(fed);
    for (const e of g.queries) {
      if (!same(q.wallAt(e.s, -1), e.wallL) || !same(q.wallAt(e.s, 1), e.wallR)) expect.fail(`wallAt(${e.s})`);
    }
  });
});
