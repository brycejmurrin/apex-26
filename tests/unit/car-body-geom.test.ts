import { describe, expect, it } from "vitest";
import * as M from "../../src/car/materials";
import { create as createGeometry } from "../../src/car/geometry";
import {
  create, type AeroStyle, type Axles, type BodyGeomContext, type CarBodyGeomApi, type Chassis,
  type PartsTiers, type TeamStyle, type WingStyle,
} from "../../src/car/body-geom";
import { newMesh, type MeshOut, type Vec3 } from "../../src/car/types";
import { haveF1, loadF1Car } from "../helpers/f1-car-vm";

// Body geometry builders (f1-game js/car/car-body-geom.js). Bit-exact (Object.is on every
// number) against the VM-loaded original; skipped where f1-game is absent.

// ---- car3d.js:13-66 datums, verbatim (checked against the VM's Car3D below) ----
const AXLES: Axles = Object.freeze({ frontZ: 1.7, rearZ: -1.6, wheelY: 0.34 });
const CHASSIS: Chassis = Object.freeze({
  floor: Object.freeze({ cx: 0, cy: 0.07, cz: -0.3, sx: 1.5, sy: 0.085, sz: 3.2 }),
  nose: Object.freeze([
    Object.freeze({ z: 2.60, y: 0.245, w: 0.115, h: 0.072, t: 0.68 }),
    Object.freeze({ z: 2.00, y: 0.315, w: 0.36, h: 0.235, t: 0.86 }),
    Object.freeze({ z: 1.05, y: 0.350, w: 0.48, h: 0.36, t: 0.82 }),
  ] as const),
  monocoque: Object.freeze([
    Object.freeze({ z: 1.05, y: 0.355, w: 0.48, h: 0.38, t: 0.80 }),
    Object.freeze({ z: 0.05, y: 0.395, w: 0.60, h: 0.48, t: 0.72 }),
  ] as const),
  cockpit: Object.freeze([
    Object.freeze({ z: 0.05, y: 0.415, w: 0.58, h: 0.44, t: 0.68 }),
    Object.freeze({ z: -0.55, y: 0.435, w: 0.50, h: 0.48, t: 0.50 }),
  ] as const),
});
const DEFAULT_WING: WingStyle = Object.freeze({ flaps: 3, arch: 0.70, twist: 0.22, teCurve: 0.10, chordTaper: 0.32, foot: 1.15, canard: 1, tipRise: 0.028 });
const W = (o: Partial<WingStyle>): WingStyle => Object.freeze(Object.assign({}, DEFAULT_WING, o));
const DEFAULT_STYLE: TeamStyle = Object.freeze({ noseTipZ: 0, noseSlim: 1, noseDroop: 0,
  airbox: 1, fin: 0, mirror: 0, inlet: 0, wingStyle: DEFAULT_WING,
  inletH: 0, inletW: 0, undercutD: 0, waist: 0, floorStep: 0, coverCrown: 0 });
const TEAM_STYLE: Readonly<Record<string, TeamStyle>> = Object.freeze({
  mercedes:    Object.freeze({ noseTipZ:  0.08, noseSlim: 0.84, noseDroop: -0.028,  airbox: 1.00, fin: 0, mirror: 1, inlet: -0.022, inletH:  0.000, inletW: -0.055, undercutD:  0.045, waist: -0.040, floorStep:  0.020, coverCrown:  0.010, wingStyle: W({ arch: 0.48, twist: 0.16, teCurve: 0.070, chordTaper: 0.24, foot: 1.00, tipRise: 0.018 }) }),
  ferrari:     Object.freeze({ noseTipZ:  0,    noseSlim: 1.04, noseDroop: -0.024,  airbox: 0.82, fin: 0, mirror: 0, inlet:  0.018, inletH:  0.020, inletW:  0.015, undercutD:  0.010, waist: -0.015, floorStep: -0.010, coverCrown:  0.025, wingStyle: W({ arch: 0.88, twist: 0.26, teCurve: 0.12, chordTaper: 0.34, foot: 1.22, tipRise: 0.036 }) }),
  mclaren:     Object.freeze({ noseTipZ: -0.06, noseSlim: 0.92, noseDroop:  0.040,  airbox: 1.00, fin: 0, mirror: 2, inlet: -0.028, inletH: -0.035, inletW:  0.055, undercutD:  0.015, waist:  0.010, floorStep: -0.020, coverCrown:  0.050, wingStyle: W({ arch: 0.64, twist: 0.28, teCurve: 0.13, chordTaper: 0.36, canard: 2, tipRise: 0.032 }) }),
  redbull:     Object.freeze({ noseTipZ:  0.06, noseSlim: 0.88, noseDroop: -0.012,  airbox: 0.92, fin: 0, mirror: 0, inlet:  0,     inletH:  0.050, inletW: -0.015, undercutD:  0.025, waist: -0.050, floorStep:  0.015, coverCrown:  0.035, wingStyle: W({ flaps: 2, arch: 0.52, twist: 0.17, teCurve: 0.075, foot: 1.05, tipRise: 0.020 }) }),
  alpine:      Object.freeze({ noseTipZ:  0,    noseSlim: 1.10, noseDroop:  0,      airbox: 1.00, fin: 1, mirror: 1, inlet:  0.014, inletH:  0.015, inletW:  0.025, undercutD: -0.015, waist:  0.020, floorStep:  0.005, coverCrown: -0.010, wingStyle: W({ arch: 0.92, twist: 0.25, teCurve: 0.11, foot: 1.24, canard: 2, tipRise: 0.034 }) }),
  racingbulls: Object.freeze({ noseTipZ:  0.04, noseSlim: 0.95, noseDroop:  0,      airbox: 1.10, fin: 0, mirror: 0, inlet: -0.024, inletH:  0.030, inletW: -0.035, undercutD:  0.020, waist: -0.025, floorStep: -0.015, coverCrown:  0.015, wingStyle: W({ flaps: 2, arch: 0.50, twist: 0.18, teCurve: 0.080, tipRise: 0.022 }) }),
  haas:        Object.freeze({ noseTipZ: -0.04, noseSlim: 1.10, noseDroop: -0.012,  airbox: 1.04, fin: 0, mirror: 0, inlet:  0.028, inletH:  0.005, inletW:  0.030, undercutD: -0.040, waist:  0.045, floorStep:  0.030, coverCrown:  0.000, wingStyle: W({ flaps: 2, arch: 0.42, twist: 0.14, teCurve: 0.058, chordTaper: 0.22, foot: 0.95, canard: 1, tipRise: 0.016 }) }),
  williams:    Object.freeze({ noseTipZ: -0.10, noseSlim: 1.16, noseDroop: -0.022,  airbox: 0.96, fin: 1, mirror: 1, inlet:  0.012, inletH: -0.020, inletW:  0.040, undercutD: -0.020, waist:  0.030, floorStep: -0.025, coverCrown: -0.015, wingStyle: W({ arch: 0.80, twist: 0.22, teCurve: 0.10, foot: 1.26, tipRise: 0.030 }) }),
  audi:        Object.freeze({ noseTipZ: -0.05, noseSlim: 1.08, noseDroop:  0,      airbox: 1.12, fin: 1, mirror: 2, inlet:  0.020, inletH:  0.035, inletW:  0.010, undercutD:  0.005, waist:  0.000, floorStep:  0.010, coverCrown:  0.040, wingStyle: W({ arch: 0.72, twist: 0.23, teCurve: 0.090, canard: 2, tipRise: 0.026 }) }),
  astonmartin: Object.freeze({ noseTipZ:  0.05, noseSlim: 0.96, noseDroop: -0.030,  airbox: 0.96, fin: 0, mirror: 1, inlet: -0.030, inletH: -0.010, inletW: -0.040, undercutD:  0.035, waist: -0.030, floorStep:  0.025, coverCrown:  0.020, wingStyle: W({ arch: 0.50, twist: 0.27, teCurve: 0.115, chordTaper: 0.34, tipRise: 0.030 }) }),
  cadillac:    Object.freeze({ noseTipZ: -0.02, noseSlim: 1.02, noseDroop:  0,      airbox: 1.00, fin: 1, mirror: 2, inlet:  0.010, inletH:  0.010, inletW: -0.020, undercutD: -0.010, waist:  0.015, floorStep: -0.005, coverCrown: -0.020, wingStyle: W({ arch: 0.70, twist: 0.20, teCurve: 0.086, canard: 2, foot: 1.16, tipRise: 0.024 }) }),
});
const teamStyleOf = (teamId?: string | null): TeamStyle => (teamId && TEAM_STYLE[teamId]) || DEFAULT_STYLE;

type Flags = { round: boolean; coverHi: boolean };

function tsCtx(flags: Flags): BodyGeomContext {
  return {
    SURFACES: M.SURFACES, CARBON: M.CARBON, DARK: M.DARK, INTAKE: M.INTAKE, PANEL: M.PANEL,
    TYRE_BAND: M.TYRE_BAND, BRAKE_CALIPER: M.BRAKE_CALIPER,
    AXLES, CHASSIS, DEFAULT_STYLE, DEFAULT_WING, TEAM_STYLE, teamStyleOf,
    geometry: createGeometry(M), shadeFlags: flags,
  };
}

// ---- Bit-exact structural compare (VM values come from another realm) ----
function diff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b) ? null : `${path}: ${a} !== ${b}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
    return a === b ? null : `${path}: ${String(a)} !== ${String(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const A = a as Record<string, unknown>, B = b as Record<string, unknown>;
  const ka = Object.keys(A).sort(), kb = Object.keys(B).sort();
  if (ka.join() !== kb.join()) return `${path}: keys [${ka.join()}] vs [${kb.join()}]`;
  for (const k of ka) { const d = diff(A[k], B[k], `${path}.${k}`); if (d) return d; }
  return null;
}

const TEAMS = [undefined, "mercedes", "ferrari", "mclaren", "redbull", "alpine", "racingbulls", "haas",
  "williams", "audi", "astonmartin", "cadillac", "nope"] as const;
const LEVELS = [0, 1, 2, 3, 3.55, 4] as const;
const TIER_MAPS: PartsTiers[] = [
  {},
  { engine: 0, aero: 0, suspension: 0, brakes: 0, tyres: 0, ers: 0, gearbox: 0, fuel: 0 },
  { engine: 2, aero: 2, suspension: 2, brakes: 2, tyres: 2, ers: 2, gearbox: 2, fuel: 2 },
  { engine: 1, aero: 2, _visual: {
    engine: { podWidth: 1.2, coke: 1.3, tailWidth: 0.9, coverHeight: 1.1, undercut: 1.3, shoulderHeight: 0.8 },
    aero: { lvl: 3.55, drs: 0, plate: 3, frontSweep: 0.15, frontTaper: 0.84, frontRise: 0.13, rearSweep: 0.16, rearTaper: 0.84, fin: 1.36 },
    brakes: { cal: [0.95, 0.45, 0.05], caliper: 1 }, fuel: { filler: 1 }, cockpit: { mirror: 1.2 },
  } },
  { engine: 2, aero: 0, _visual: { engine: { coke: 0.9, podWidth: 0.7, coverHeight: 1.3 }, aero: { lvl: 0, drs: 1, plate: 0 } } },
];
const ZS = [3, 2.3, 2.0, 1.5, 0.62, 0.3, 0, -0.2, -0.38, -0.55, -0.8, -1.05, -1.3, -1.6, -2.0, -2.4];

/** Every public builder and helper, exercised identically on either implementation. */
function drive(g: CarBodyGeomApi, pal: { CARBON: Vec3; PANEL: Vec3 }, flags: Flags,
               teamStyleOf: (id?: string | null) => TeamStyle): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  const mesh = (f: (out: MeshOut) => unknown): unknown => { const out = newMesh(); const ret = f(out); return { out, ret }; };
  const red: Vec3 = [0.86, 0, 0], accent: Vec3 = [1.2, 0.9, 0.1];
  const styles = (T: PartsTiers, team?: string): AeroStyle => Object.assign({}, g.aeroStyleOf(T), { wingStyle: g.wingOf(teamStyleOf(team)) });

  r["consts"] = { REAR_TYRE_CROWN: g.REAR_TYRE_CROWN, REAR_WING_TOP: g.REAR_WING_TOP, FW_MOVEABLE: g.FW_MOVEABLE,
    FW_SPAN: g.FW_SPAN, WING_BAND: g.WING_BAND, CAR_HALF: g.CAR_HALF, COVER_CROWN: g.COVER_CROWN,
    COVER_SHOULDER: g.COVER_SHOULDER, COVER_DROP: g.COVER_DROP, COVER_STACK: g.COVER_STACK,
    FIN_SHAPES: g.FIN_SHAPES, FIN_SHAPE_IDS: g.FIN_SHAPE_IDS, FIN: g.FIN, COVER_VENT_IDS: g.COVER_VENT_IDS,
    SPINE_HEIGHT_IDS: g.SPINE_HEIGHT_IDS };
  r["nose"] = TEAMS.map((t) => g.styledNoseStations(teamStyleOf(t)));
  r["nose0"] = g.styledNoseStations(null);
  r["halo"] = [g.haloHoopPath(0.2, 0.62, -0.25, 0.26, 0.2, 0.92, 0.55), g.haloHoopPath(0.21, 0.6, -0.3, 0.25, 0.25, 0.9, 0.6, 9)];
  r["cascade"] = LEVELS.map((a) => [g.frontCascade(a), g.frontBakedCount(a), g.frontHalf(a)]);
  r["noseUnder"] = Array.from({ length: 41 }, (_, i) => g.noseUnderAt(1.9 + i * 0.008));
  const rec = g.elemRecord([2.5, 0.092], [2.24, 0.146], 0.02, 0.52);
  r["elem"] = [rec, g.elemPoint(rec, 0.1, 0.3), g.elemTopAt(rec, 0.05, 2.4), g.elemTopAt(rec, 0, 3)];
  r["spine"] = ["standard", "raised", "high", "dorsal", undefined, "x"].map((s) => g.spineRise(s));

  const aeroStyles: (AeroStyle | number | undefined)[] = [undefined, 2];
  // The flap solve is a search (car-body-geom.js:387): one team per tier map keeps this fast.
  TIER_MAPS.forEach((T, i) => aeroStyles.push(styles(T, ["mercedes", "redbull", undefined, "ferrari", "haas"][i])));
  // The VM original runs the search ~10x slower: every level on the default recipe,
  // a spread of levels across the rest.
  const aeroLevels: readonly (readonly number[])[] = [LEVELS, LEVELS, [4], [3.55, 4], [1], [2], [0, 3]];
  r["aero"] = aeroStyles.map((st, si) => aeroLevels[si]!.map((a) => {
    const flaps = g.aeroFlapsGeom(a, st);
    return {
      endplate: g.endplateGeom(a, st), number: g.numberBoard(a, st), band: g.wingBandGeom(a, st),
      plate: [0, 1, 2, 3, null].map((p) => g.frontPlateGeom(a, { plate: p })),
      flaps, solved: si === 3 && a === 4 ? g.solveFlapsGeom(a, st) : null,
      aim: [g.aeroFlapAim(a, "front", st), g.aeroFlapAim(a, "rear", st)],
      sig: typeof st === "object" ? g.flapSig(st) : null,
      flapGeom: flaps.map((el) => [g.buildFlapGeom(el, red), g.buildFlapGeom(el, red, "satin"),
        g.buildFlapGeom(el, red, "chrome", "carbon"), g.buildFlapGeom(el, red, "gloss")]),
    };
  }));
  r["plateDefault"] = [g.frontPlateGeom(null, null), g.frontPlateGeom(undefined)];
  r["band0"] = [g.wingBandGeom(null), g.numberBoard(null), g.endplateGeom(undefined)];
  r["wingFoil"] = TEAMS.map((t) => [0, 1, 2, 3, 4].map((i) => g.wingFoilOf(teamStyleOf(t), i)));
  r["wingFoilRaw"] = [g.wingFoilOf(null, 1), g.wingFoilOf(DEFAULT_WING, 3), g.wingFoilOf(g.aeroStyleOf({}), 2)];

  r["recipes"] = TIER_MAPS.map((T) => [g.buildPartRecipes(T, accent), g.aeroLevelOf(T), g.aeroStyleOf(T)]);
  r["recipes0"] = [g.aeroLevelOf(null), g.aeroStyleOf(undefined), g.buildPartRecipes({ ers: 2 })];

  const fins = [undefined, 0.5, 1, 1.3, 2];
  const shapes = [undefined, "standard", "swept", "stub", "stepped", "none"];
  r["fin"] = shapes.map((s) => fins.map((f) => [g.finOf(s), g.finTop(f, s), g.sharkFinRoot(null, f, s),
    g.sharkFinPanel(null, null, f, s), g.sharkFinPanel(0.1, 0.004, f, s), g.sharkFinBadge(null, f, s)]));

  r["mirror"] = TEAMS.map((t) => [undefined, 0.7, 1, 1.2, 2].map((m) => [g.mirrorLightAnchors(t, m), g.mirrorLightAnchors(t, m)]));
  r["ckMirror"] = [undefined, 0.7, 1, 1.2, 1.2, 2, null].map((m) => g.cockpitMirrorGlass(m));

  const pods = g.sidepodStations(g.buildPartRecipes(TIER_MAPS[3]!).engine, teamStyleOf("mclaren"));
  r["pods"] = [pods, g.sidepodStations(g.buildPartRecipes({}).engine), g.sidepodStation(-1, 0.2, 0.3, 0.6, 0.2, 0.25, 0.45, 0.46),
    ZS.map((z) => g.sampleStations(pods, z))];

  const anchorsOut: unknown[] = [];
  for (const T of [...TIER_MAPS, null]) for (const t of TEAMS) for (const spine of [undefined, "raised", "dorsal"]) for (const round of [false, true]) {
    const A = g.bodyAnchors(T, t, spine, round);
    const B = g.buildBodyAnchors(T, t, g.spineRise(spine), round);
    const ser = (x: typeof A) => ({ key: x.key, podStations: x.podStations,
      pod: ZS.map((z) => x.podAt(z)), cover: ZS.map((z) => x.coverAt(z)), nose: ZS.map((z) => x.noseAt(z)) });
    const cov = [-0.55, -0.9, -1.3, -1.675, -2.0].map((z) => x2(A.coverAt(z)));
    function x2(c: ReturnType<typeof A.coverAt>) {
      return [g.coverProfile(c), g.coverProfile(c, true), [0.2, 0.4, 0.6, 0.8, 1.0].map((y) => g.coverFlankX(c, y)),
        [0, 0.03, 0.06, 0.1, 0.15, -0.2, 0.4].map((x) => g.coverSurfaceY(c, x))];
    }
    const root = g.sharkFinRoot(A, 1.2, "standard");
    anchorsOut.push([ser(A), ser(B), cov, root, g.sharkFinPanel(null, null, 1.2, "stepped", root), g.sharkFinBadge(null, 1.2, "stub", root)]);
  }
  r["anchors"] = anchorsOut;

  // Mesh builders, flat and rounded.
  const meshes: unknown[] = [];
  for (const round of [false, true]) for (const coverHi of [true, false]) {
    flags.round = round; flags.coverHi = coverHi;
    const edgeAt = (z: number): number => 0.7 - 0.05 * z;
    for (const t of ["ferrari", "astonmartin", undefined]) for (const ckpt of [false, true]) for (const ride of [0, 0.06, -0.048]) {
      meshes.push(mesh((out) => g.buildSharedChassis(out, red, ride, g.styledNoseStations(teamStyleOf(t)), ckpt, edgeAt)));
    }
    meshes.push(mesh((out) => g.buildSharedChassis(out, red, 0, null, false, edgeAt)));
    meshes.push(mesh((out) => g.bodySpan(out, CHASSIS.nose[0], CHASSIS.nose[1], red, 0.022)));
    for (const T of TIER_MAPS) for (const t of ["redbull", "haas", undefined]) for (const spine of [undefined, "high"]) {
      const eng = g.buildPartRecipes(T).engine, A = g.bodyAnchors(T, t, spine, round);
      meshes.push(mesh((out) => g.buildSidepodBodywork(out, red, eng, A)));
      for (const [sideMark, trimAft] of [[false, null], [true, null], [true, -1.4], [0, -1.1]] as const) {
        meshes.push(mesh((out) => g.buildEngineCoverBodywork(out, red, accent, eng, A, g.spineRise(spine), sideMark, trimAft)));
      }
    }
    meshes.push(mesh((out) => g.buildSidepodBodywork(out, red, g.buildPartRecipes({}).engine)));
    meshes.push(mesh((out) => g.buildSidepodBodywork(out, red, { podWidth: 1.2, coke: 1.3 }, null)));
  }
  flags.round = false; flags.coverHi = true;
  meshes.push(mesh((out) => {
    g.addInletMouth(out, 0.45, 0.33, 0.62, 0.14, 0.2, pal.PANEL);
    g.addInletMouth(out, -0.45, 0.33, 0.62, 0.14, 0.2, pal.CARBON, 0.07, 0);
    g.addInletMouth(out, -0.45, 0.33, 0.62, 0.14, 0.2, red, null, 0.02);
  }));
  r["meshes"] = meshes;
  return r;
}

const fixedFlags = (): Flags => ({ round: false, coverHi: true });

describe("car body geometry", () => {
  it("bakes the right cascade, memoises solves and anchors, and builds finite meshes", () => {
    const flags = fixedFlags();
    const g = create(tsCtx(flags));
    expect(LEVELS.map((a) => g.frontBakedCount(a))).toEqual([1, 1, 1, 2, 2, 3]);
    const st = Object.assign({}, g.aeroStyleOf({ aero: 2 }), { wingStyle: DEFAULT_WING });
    const flaps = g.aeroFlapsGeom(4, st);
    expect(g.aeroFlapsGeom(4, st)).toBe(flaps);
    expect(flaps.map((f) => f.id)).toEqual(["front3", "front4", "rearMid", "rear"]);   // drs: 1 bakes the top plane
    expect(flaps.every((f) => Number.isFinite(f.zAngle) && Number.isFinite(f.xAngle))).toBe(true);
    const T: PartsTiers = { engine: 1 };
    expect(g.bodyAnchors(T, "mercedes")).toBe(g.bodyAnchors(T, "mercedes"));
    expect(g.bodyAnchors(T, "mercedes", "dorsal").coverAt(-0.55).top - g.bodyAnchors(T, "mercedes").coverAt(-0.55).top)
      .toBeCloseTo(0.13, 12);
    for (const round of [false, true]) {
      flags.round = round;
      const out = newMesh();
      g.buildSharedChassis(out, [0.86, 0, 0], 0, null, false, () => 0.7);
      g.buildEngineCoverBodywork(out, [0.86, 0, 0], [1, 1, 0], g.buildPartRecipes(T).engine, g.bodyAnchors(T, "ferrari", null, round));
      expect(out.idx.length).toBeGreaterThan(300);
      expect(out.pos.every(Number.isFinite)).toBe(true);
      expect(out.mat.length * 3).toBe(out.pos.length);
    }
    expect(g.coverSurfaceY(g.bodyAnchors(T).coverAt(-1), 0)).toBe(g.bodyAnchors(T).coverAt(-1).top);
  });

  it.skipIf(!haveF1)("datums match f1-game car3d.js", () => {
    const vm = loadF1Car();
    const car = vm["Car3D"] as { AXLES: unknown; CHASSIS: unknown; TEAM_STYLE: unknown; teamStyleOf(id?: string): unknown };
    expect(diff(AXLES, car.AXLES)).toBeNull();
    expect(diff(CHASSIS, car.CHASSIS)).toBeNull();
    expect(diff(TEAM_STYLE, car.TEAM_STYLE)).toBeNull();
    expect(diff(DEFAULT_STYLE, car.teamStyleOf())).toBeNull();
  });

  it.skipIf(!haveF1)("matches f1-game bit for bit", () => {
    const vm = loadF1Car();
    const VM = vm["CarMaterials"] as Record<string, unknown> & { CARBON: Vec3; PANEL: Vec3 };
    const car = vm["Car3D"] as { AXLES: unknown; CHASSIS: unknown; TEAM_STYLE: unknown; teamStyleOf(id?: string): { wingStyle: unknown } };
    const geomVM = (vm["CarGeometry"] as { create(c: unknown): unknown }).create(VM);
    const vmFlags = fixedFlags();
    const ref = (vm["CarBodyGeom"] as { create(c: unknown): unknown }).create({
      ...VM, AXLES: car.AXLES, CHASSIS: car.CHASSIS, TEAM_STYLE: car.TEAM_STYLE, teamStyleOf: car.teamStyleOf,
      DEFAULT_STYLE: car.teamStyleOf(), DEFAULT_WING: car.teamStyleOf().wingStyle,
      geometry: geomVM, shadeFlags: vmFlags,
    }) as CarBodyGeomApi;
    const tsFlags = fixedFlags();
    const mine = create(tsCtx(tsFlags));
    const a = drive(mine, M, tsFlags, teamStyleOf), b = drive(ref, VM, vmFlags, car.teamStyleOf as (id?: string | null) => TeamStyle);
    for (const k of Object.keys(b)) expect(diff(a[k], b[k], k)).toBeNull();
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  }, 120_000);
});
