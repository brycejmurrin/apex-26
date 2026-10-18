import { describe, expect, it } from "vitest";
import { Helmets, type HelmetBuildOptions, type HelmetDesign } from "../../src/car/helmets";
import { SURFACES } from "../../src/car/materials";
import { newMesh, type MeshOut, type Vec3 } from "../../src/car/types";
import { haveF1, loadF1Car, plain } from "../helpers/f1-car-vm";

// Helmet designs and the painted shell (f1-game js/car/helmets.js). Bit-exact against the
// VM-loaded original (Object.is per number, so -0 and NaN count); skipped where f1-game
// is absent.
type Fn = (...a: unknown[]) => unknown;
type Ref = Record<string, Fn> & Record<string, unknown>;

/** Deep compare with Object.is on numbers; arrays/objects from another realm are walked. */
function bitsEqual(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" || typeof b === "number") {
    return Object.is(a, b) ? null : `${path}: ${String(a)} !== ${String(b)}`;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return a === b ? null : `${path}: ${String(a)} !== ${String(b)}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const x: unknown = a[i], y: unknown = b[i];
      if (typeof x === "number" && typeof y === "number") { if (!Object.is(x, y)) return `${path}[${i}]: ${x} !== ${y}`; continue; }
      const r = bitsEqual(x, y, `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined).sort();
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined).sort();
  if (ka.join() !== kb.join()) return `${path}: keys ${ka.join()} vs ${kb.join()}`;
  for (const k of ka) {
    const r = bitsEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (r) return r;
  }
  return null;
}
const same = (mine: unknown, ref: unknown): void => expect(bitsEqual(mine, ref)).toBeNull();

const GRID = [1, 3, 5, 6, 10, 11, 12, 14, 16, 18, 23, 27, 30, 31, 41, 43, 44, 55, 63, 77, 81, 87];
const TEAM_C: (Vec3 | null | undefined)[] = [
  null, undefined, [0.85, 0.09, 0.11], [0.9, 0.35, 0.05], [0.07, 0.07, 0.08], [0.05, 0.10, 0.32],
  [0.78, 0.92, 0.15], [0.93, 0.94, 0.96], [0.13, 0.14, 0.16], [0.5, 0.5, 0.5],
];
const S: HelmetBuildOptions = { paint: SURFACES.paint, glass: SURFACES.visor };
// What car3d.js:1268-1271 passes (player, field/silhouette) plus the test-only switches.
const OPTION_SETS: HelmetBuildOptions[] = [
  { ...S, maxSplit: undefined, simplePaint: false },
  { ...S, maxSplit: 0, simplePaint: true },
  { ...S, maxSplit: 0, aero: false },
  { ...S, maxSplit: 2 },
  { ...S, simplePaint: true, aero: false },
];

describe("helmets", () => {
  it("knows the 2026 grid and shifts a lid off its own car's paint", () => {
    expect(Object.keys(Helmets.DESIGNS).map(Number).sort((a, b) => a - b)).toEqual(GRID);
    expect(Helmets.designFor(1, null).name).toBe("NOR");
    const lec = Helmets.designFor(16, Helmets.COLORS.white);
    expect(lec.shifted).toBe(true);
    expect(lec.base).toBe(Helmets.COLORS.navy);
    const gen = Helmets.designFor(99, null);
    expect(gen.generated).toBe(true);
    expect(gen.alt).not.toBe(gen.base);
    expect(Helmets.designFor(1, null, "FAN").name).toBe("FAN");
    expect(Object.isFrozen(Helmets)).toBe(true);
  });

  it("builds a closed shell of unit-normal triangles", () => {
    const out = newMesh();
    Helmets.build(out, 0, 0.715, -0.075, Helmets.designFor(44, null), { ...S, aero: false, maxSplit: 0 });
    expect(out.idx.length).toBe(Helmets.RINGS * Helmets.SLICES * 2 * 3);
    for (let i = 0; i < out.nrm.length; i += 3) {
      expect(Math.hypot(out.nrm[i]!, out.nrm[i + 1]!, out.nrm[i + 2]!)).toBeCloseTo(1, 6);
    }
    expect(new Set(out.mat)).toEqual(new Set([SURFACES.paint, SURFACES.visor]));
  });

  describe.skipIf(!haveF1)("matches f1-game bit for bit", () => {
    const ref = (haveF1 ? loadF1Car()["Helmets"] : {}) as Ref;
    const mine = Helmets as unknown as Ref;
    const refDesign = (num: unknown, c?: unknown, key?: unknown): HelmetDesign =>
      ref["designFor"]!(num, c, key) as HelmetDesign;

    it("exports the same members and constants", () => {
      expect(Object.keys(mine).sort()).toEqual(Object.keys(ref).sort());
      for (const k of ["DESIGNS", "COLORS", "SHAPE", "RINGS", "SLICES", "FIELD_RINGS", "FIELD_SLICES", "MAX_SPLIT"]) {
        same(mine[k], ref[k]);
      }
      expect(Object.keys(mine["ZONES"] as object)).toEqual(Object.keys(ref["ZONES"] as object));
    });

    it("designFor: every grid number, unknown numbers, keys and team colours", () => {
      const nums: (number | null | undefined)[] = [...GRID, 0, 2, 7, 13, 99, 100, 101, -5, 3.7, 2147483647, -2147483648, null, undefined];
      const keys: (string | number | null | undefined)[] = [undefined, null, "FAN", "SEN", "custom#44", "", 77];
      const a: unknown[] = [], b: unknown[] = [];
      for (const n of nums) for (const c of TEAM_C) for (const k of keys) {
        a.push(Helmets.designFor(n, c, k)); b.push(refDesign(n, c, k));
      }
      same(a, b);
      // Every grid design shifted by its own base.
      for (const n of GRID) {
        const b = Helmets.DESIGNS[n]!.base;
        same(Helmets.designFor(n, b), refDesign(n, [...b]));
      }
    });

    it("generated, keyNum, ringT", () => {
      for (const n of [0, 1, 2, 3, 4, 5, 11, 12, 13, 99, -7, 1e9, 2.5]) {
        same(Helmets.generated(n), ref["generated"]!(n));
        same(Helmets.generated(n, "ABC"), ref["generated"]!(n, "ABC"));
      }
      for (const s of ["", "FAN", "SEN", "custom#1", "Ünïcødé", "a".repeat(300)]) {
        expect(Helmets.keyNum(s)).toBe(ref["keyNum"]!(s));
      }
      for (let i = -1; i <= Helmets.RINGS + 1; i++) expect(Object.is(Helmets.ringT(i), ref["ringT"]!(i))).toBe(true);
    });

    it("painter, shell, isVisor and every zone over a (t, az) grid", { timeout: 60_000 }, () => {
      const designs = [...GRID.map((n) => Helmets.designFor(n, null)), Helmets.generated(0), Helmets.generated(1),
        Helmets.generated(2), Helmets.generated(3)];
      const ts: number[] = [], azs: number[] = [];
      for (let t = -0.05; t <= 1.06; t += 0.0137) ts.push(t);
      for (let az = -400; az <= 760; az += 7.3) azs.push(az);
      for (const d of designs) {
        const pm = Helmets.painter(d), pr = ref["painter"]!(plain(d)) as (t: number, az: number) => unknown;
        const sm = Helmets.shell(d), sr = ref["shell"]!(plain(d)) as (t: number, az: number) => unknown;
        const a: unknown[] = [], b: unknown[] = [];
        for (const t of ts) for (const az of azs) { a.push(pm(t, az), sm(t, az)); b.push(pr(t, az), sr(t, az)); }
        same(a, b);
      }
      const va: unknown[] = [], vb: unknown[] = [];
      for (const t of ts) for (const az of azs) { va.push(Helmets.isVisor(t, az)); vb.push(ref["isVisor"]!(t, az)); }
      same(va, vb);
      const zones = [
        { k: "cap", t1: 0.3, c: [1, 0, 0] }, { k: "band", t0: 0.2, t1: 0.5, c: [1, 0, 0] },
        { k: "stripe", az: 350, w: 12, c: [1, 0, 0] }, { k: "wedge", az0: 300, az1: 40, c: [1, 0, 0] },
        { k: "wedge", az0: 20, az1: 140, c: [1, 0, 0] }, { k: "chevron", az: 0, w: 40, t0: 0.2, t1: 0.66, c: [1, 0, 0] },
        { k: "spot", az: 90, t: 0.3, r: 0.12, c: [1, 0, 0] }, { k: "patch", az: 270, w: 20, t0: 0.2, t1: 0.6, c: [1, 0, 0] },
        { k: "flash", az: 90, w0: 6, w1: 20, t0: 0.1, t1: 0.6, sweep: 24, c: [1, 0, 0] },
        { k: "mottle", t0: 0.05, t1: 0.95, sc: 5, w: 0.48, seed: 3, c: [1, 0, 0] },
      ] as const;
      const zm = Helmets.ZONES as unknown as Record<string, Fn>, zr = ref["ZONES"] as unknown as Record<string, Fn>;
      const za: unknown[] = [], zb: unknown[] = [];
      for (const zz of zones) for (const t of ts) for (const az of azs) {
        za.push(zm[zz.k]!(zz, t, az)); zb.push(zr[zz.k]!(zz, t, az));
      }
      same(za, zb);
      // A design with an unknown zone kind and no zones list paints the base.
      const odd = { name: "X", base: [0.2, 0.3, 0.4], visor: [0, 0, 0], zones: [{ k: "nope", c: [1, 1, 1] }] };
      same((mine["painter"]!(odd) as Fn)(0.3, 10), (ref["painter"]!(odd) as Fn)(0.3, 10));
    });

    it("pointAt and surfAt", () => {
      const a: unknown[] = [], b: unknown[] = [];
      for (let t = -0.1; t <= 1.1; t += 0.0071) {
        for (let az = -190; az <= 370; az += 3.7) {
          a.push(Helmets.pointAt(t, az * Math.PI / 180), Helmets.surfAt(t, az));
          b.push(ref["pointAt"]!(t, az * Math.PI / 180), ref["surfAt"]!(t, az));
        }
      }
      same(a, b);
    });

    it("build() for designs x option sets (what car3d passes, plus test switches)", () => {
      const designs: HelmetDesign[] = [
        Helmets.designFor(1, [0.9, 0.35, 0.05]), Helmets.designFor(44, null), Helmets.designFor(16, [0.85, 0.09, 0.11]),
        Helmets.designFor(10, null), Helmets.designFor(27, [0.07, 0.07, 0.08]), Helmets.designFor(99, null),
        Helmets.designFor(1, null, "FAN"), Helmets.generated(2), Helmets.generated(3),
        { name: "FLAT", base: [1, 1, 1], alt: [1, 1, 1], visor: [0, 0, 0], zones: [] },
        { name: "HDR", base: [1.6, 0.2, 0.1], visor: [2, 2, 2], zones: [{ k: "cap", t1: 0.3, c: [3, 0.5, 0] }] },
      ];
      for (const d of designs) for (const o of OPTION_SETS) {
        const a: MeshOut = newMesh(), b: MeshOut = newMesh();
        Helmets.build(a, 0, 0.715, -0.075, d, o);
        ref["build"]!(b, 0, 0.715, -0.075, plain(d), { ...o });
        same(a, b);
      }
    }, 60_000);

    it("buildAero() direct, both paint modes", () => {
      for (const d of [Helmets.designFor(44, null), Helmets.designFor(81, null), Helmets.generated(7)]) {
        for (const simple of [false, true, undefined]) {
          const a = newMesh(), b = newMesh();
          Helmets.buildAero(a, 0.1, 0.7, -0.08, d, S, simple);
          ref["buildAero"]!(b, 0.1, 0.7, -0.08, plain(d), { ...S }, simple);
          same(a, b);
        }
      }
    });
  });
});
