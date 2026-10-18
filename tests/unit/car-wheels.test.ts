import { describe, expect, it } from "vitest";
import * as M from "../../src/car/materials";
import { create as createGeometry } from "../../src/car/geometry";
import { CarShade } from "../../src/car/shade";
import { CarWheels, create, tints, type BrakeStyle, type TyreStyle, type WheelStyle } from "../../src/car/wheels";
import { newMesh, type MeshOut, type Vec3 } from "../../src/car/types";
import { haveF1, loadF1Car } from "../helpers/f1-car-vm";

// f1-game js/car/car-wheels.js. Bit-exact against the VM-loaded original: JSON with -0
// kept apart from 0 (JSON round-trips every other double exactly).
type Fn = (...a: unknown[]) => unknown;
type Api = Record<string, Fn>;
const exact = (v: unknown): string | undefined =>
  v === undefined ? undefined : JSON.stringify(v, (_k, x: unknown) => (Object.is(x, -0) ? "-0" : x));

const geometry = createGeometry(M);
const deps = { geometry, SURFACES: M.SURFACES, TYRE: M.TYRE, INTAKE: M.INTAKE };

// One recipe per branch of addWheel: shoulders, grooves, cover (open / peeks / vanes /
// dish / ribs), rotor detail and disc faces, sidewall rings and ink, nut / gun nut,
// spokes (wheel, tyre, default), tape, dish (open and cover), duct, caliper levels.
type Recipe = [w: number | null, band: Vec3 | null, cal: Vec3 | null, rim: Vec3 | null, grooved: boolean,
  tyre: TyreStyle | null, brake: BrakeStyle | null, wheel: WheelStyle | null, ink?: Vec3 | null];
const RECIPES: Recipe[] = [
  [null, null, null, null, false, null, null, null],
  [0.34, [0.85, 0.10, 0.08], null, null, true, null, null, null],
  [0.32, [0.92, 0.92, 0.90], [0.75, 0.08, 0.05], [0.6, 0.6, 0.62], false,
    { shoulder: 1, grooves: 2, grooveDepth: 0.06, bandWidth: 0.05, sidewall: 2 }, { rotor: 1, caliperPos: 0.4, caliper: 1, rotorScale: 1.2 },
    { spokes: 6, nut: [0.9, 0.8, 0.1], tape: true }],
  [0.38, [0.95, 0.15, 0.05], [0.1, 0.3, 0.9], null, false,
    { shoulder: 2, cover: true, coverVanes: 8, gunNut: 1, dish: 1 }, { rotor: 2, discFace: 1, coverOpen: 1, caliper: 2, duct: 0.5, caliperPos: -0.6 },
    null, [1, 1, 1]],
  [0.32, null, [0.9, 0.9, 0.1], [0.2, 0.2, 0.22], false,
    { cover: 1, spokes: 5, sidewall: 1 }, { discFace: 2, coverOpen: 2, rotorScale: 1.5 },
    { cover: true, dish: 2, gunNut: true, spokes: 0 }],
  [0.38, [0.92, 0.92, 0.90], null, [0.8, 0.7, 0.2], false,
    { grooves: 0, nut: [0.2, 0.9, 0.3], spokes: 4, dish: 2, coverVanes: 12 }, { caliper: 2 },
    { dish: 1, tape: 1, nut: null }, [0.1, 0.9, 0.1]],
  [0.34, [0.92, 0.92, 0.90], [0.75, 0.08, 0.05], null, true,
    { shoulder: 1.6, sidewall: 3 }, { rotor: 3, discFace: 1.4, duct: 2, caliper: 0 }, { spokes: 12 }],
];

const call = (w: Api, out: MeshOut, r: Recipe, fixed: MeshOut | null, cx: number, cz: number) =>
  w["addWheel"]!(out, cx, 0.34, cz, 0.34, r[0] || 0.34, r[1], r[2], r[3], r[4], r[5], fixed, r[6], r[7], r[8]);

function drive(w: Api): unknown[] {
  const res: unknown[] = [];
  for (const r of RECIPES) {
    res.push(w["buildWheel"]!(...r));
    res.push(w["buildWheelLayers"]!(...r));
    const out = newMesh(), fixed = newMesh();
    call(w, out, r, null, 0.79, 1.8);       // car3d.js:2129: front, calipers on the body mesh
    call(w, out, r, fixed, -0.76, -1.75);   // rear, calipers split off
    res.push(out, fixed);
  }
  return res;
}

describe("CarWheels sanity", () => {
  it("builds a default wheel and its layers", () => {
    const w = create(deps);
    const out = w.buildWheel(0.34, null, null, null, false, null, null, null);
    expect(out.pos.length % 9).toBe(0);
    expect(out.pos.length / 3).toBe(out.mat.length);
    expect(new Set(out.mat)).toEqual(new Set([M.SURFACES.rubber, M.SURFACES.metal, M.SURFACES.carbon]));
    const { rotating, fixed } = w.buildWheelLayers(0.32, null, [0.75, 0.08, 0.05], null, false, null, { caliper: 1 }, null);
    expect(rotating.idx.length).toBeGreaterThan(0);
    expect(fixed.idx.length).toBeGreaterThan(0);
    // tread normals follow the shoulder only when the shade module is supplied and on
    const a = create({ ...deps, shade: CarShade }).buildWheel(null, null, null, null, false, null, null, null);
    expect(a.pos).toEqual(out.pos);
    expect(a.nrm).not.toEqual(out.nrm);
    expect(CarWheels.create).toBe(create);
  });
  it("tints parses arrays and hex, memoises per livery", () => {
    expect(tints(null)).toBe(tints({}));
    expect(tints({}).key).toBe("");
    const liv = { rimTint: "#ff8000", caliperTint: [0.5, 0.25, 1, 9], sidewallInk: "nope" };
    const t = tints(liv);
    expect(t).toBe(tints(liv));
    expect(t.rim).toEqual([1, 128 / 255, 0]);
    expect(t.cal).toEqual([0.5, 0.25, 1]);
    expect(t.ink).toBeNull();
    expect(t.key).toBe("|w255,128,0;128,64,255");
    expect(Object.isFrozen(t)).toBe(true);
  });
});

describe.skipIf(!haveF1)("CarWheels matches f1-game bit for bit", () => {
  const load = (smooth: boolean) => {
    const g = loadF1Car();
    if (!smooth) (g["CarShade"] as Api)["set"]!("0");   // CarShade.any() false: the plain radial tread
    const VM = g["CarMaterials"] as Record<string, unknown>;
    const vmGeo = (g["CarGeometry"] as { create(c: unknown): unknown }).create(VM);
    // car3d.js:102
    return (g["CarWheels"] as { create(c: unknown): Api; tints: Fn }).create({ geometry: vmGeo, SURFACES: VM["SURFACES"], TYRE: VM["TYRE"], INTAKE: VM["INTAKE"] });
  };

  it("with CarShade on (f1-game's default): shade dependency supplied", () => {
    const mine = create({ ...deps, shade: CarShade }) as unknown as Api;
    expect(exact(drive(mine))).toBe(exact(drive(load(true))));
  });

  it("with CarShade off / absent: no shade dependency", () => {
    const ref = exact(drive(load(false)));
    expect(exact(drive(create(deps) as unknown as Api))).toBe(ref);
    const off = { any: () => false, vertexNormals: CarShade.vertexNormals };
    expect(exact(drive(create({ ...deps, shade: off }) as unknown as Api))).toBe(ref);
  });

  it("tints", () => {
    const ref = (loadF1Car()["CarWheels"] as { tints: Fn }).tints;
    const livs: unknown[] = [null, undefined, 3, "x", {}, { rimTint: [0.2, 0.3, 0.4] }, { rimTint: [0.2, 0.3] }, { rimTint: [0.2, NaN, 0.3] },
      { caliperTint: "#0a0B0c" }, { caliperTint: "0a0b0c" }, { caliperTint: "#0a0b0" }, { sidewallInk: [1, 1, 1] },
      { rimTint: "#123456", caliperTint: [0.9, 0.1, 0.05], sidewallInk: "#ffffff" }, { rimTint: 0, caliperTint: "", sidewallInk: null }];
    for (const liv of livs) expect(exact(tints(liv)), String(JSON.stringify(liv))).toBe(exact(ref(liv)));
  });
});
