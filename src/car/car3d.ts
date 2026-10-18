// Procedural 2026 F1 car. build(color, color2, opts) -> plain {pos,nrm,col,mat,idx}
// for gfx.createMesh. Local space: +Z forward, +Y up, origin on the ground under the
// cockpit. Geometry builders live in ./body-geom; surfaces/finishes/palette in
// ./materials. Ported verbatim from f1-game js/car/car3d.js:1-2217.
//
// f1-game reads four optional globals behind `typeof` guards (LiveryTex, Legends,
// Teams, Log). Here they are an explicit dependency bag set with configureCar3D();
// leaving a member unset reproduces the original's undefined-global branch exactly.
// Log calls are dropped (car3d.js:131).
import * as CarMaterials from "./materials";
import {
  SURFACES, FINISH_SURFACE,
  DARK, CARBON, VISOR, PANEL, TYRE, RIM, HUB, INTAKE, HALO,
  TYRE_BAND, BRAKE_CALIPER,
  TCAM_IDS,
  type TeamDrivers, type FinishLivery, type Section,
} from "./materials";
import { create as createGeometry, type Station } from "./geometry";
import { create as createWheels, CarWheels } from "./wheels";
import { create as createBodyGeom } from "./body-geom";
import { CarShade } from "./shade";
import { Helmets } from "./helmets";
import type { MeshOut, MVec3, Vec3 } from "./types";

// ---------------------------------------------------------------------------
// Optional f1-game globals as a typed dependency bag.

/** The slice of f1-game's LiveryTex (js/car/liverytex.js) that build() reads. */
export interface LiveryTexHooks {
  /** car3d.js:183 */
  resolveFinPaint?: ((teamId: string | null | undefined, liv: Livery, coverC: Vec3, bandProxy: Vec3, c1: Vec3, c2: Vec3) => Vec3) | undefined;
  /** car3d.js:416 */
  airboxMeshColour?: ((teamId: string | null | undefined, liv: Livery, coverC: Vec3) => Vec3 | null | undefined) | undefined;
  /** car3d.js:440 */
  SPINE_SIDE_IDS?: readonly string[] | undefined;
  /** car3d.js:441-443 */
  FLANK_SEEN?: number | undefined;
  FLANK?: { zF: number; zLen: number } | undefined;
}

/** The slice of f1-game's Legends (js/legends.js) helmetKey() reads (car3d.js:111-120). */
export interface LegendsLookup {
  byId(id: string): { code: string } | null | undefined;
  LIST: readonly { code: string; num?: number | undefined }[];
}

export interface Car3DDeps {
  liveryTex?: LiveryTexHooks | undefined;
  legends?: LegendsLookup | undefined;
  /** f1-game Teams.LIST, for the "auto" T-cam pick (car-materials.js:52). */
  teams?: readonly TeamDrivers[] | undefined;
}

let deps: Car3DDeps = {};
/** Install (or with no argument clear) the optional LiveryTex / Legends / Teams hooks. */
export function configureCar3D(next: Car3DDeps = {}): void {
  deps = next;
}

// ---------------------------------------------------------------------------
// Category-neutral chassis datums (car3d.js:11-40). Parts may dress and reshape
// bodywork around these, but the wheel/physics reference points never move.

export const AXLES = Object.freeze({ frontZ: 1.7, rearZ: -1.6, wheelY: 0.34 });
export const CHASSIS = Object.freeze({
  floor: Object.freeze({ cx: 0, cy: 0.07, cz: -0.3, sx: 1.5, sy: 0.085, sz: 3.2 }),
  nose: Object.freeze([
    // NOSE TIP. It was z 3.18 — 460 mm AHEAD of the front wing's main-plane
    // leading edge (frontCascade's first element leads at z 2.72) and 400 mm
    // ahead of the endplate (z 2.66), so the car's frontmost bodywork was a
    // pencil of nose hanging in clear air with nothing under it. No F1 car
    // has ever been shaped that way: the front wing leads, and the nose tip
    // lands ON the cascade, roughly over the first flap (LE z 2.50). It also
    // made the car 5.87 m long against a 3.30 m wheelbase (AXLES 1.7/−1.6);
    // the 2026 regulations cap the wheelbase at 3400 mm and the cars that
    // result are ~5.4 m overall. 2.60 puts the tip 120 mm behind the wing LE
    // and takes the car to 2.72 → −2.69 = 5.41 m. TEAM_STYLE.noseTipZ still
    // swings ±0.10 around it, so the longest nose on the grid (williams,
    // +0.10 → 2.70) still sits behind the wing it should sit behind.
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

/** 2026 front-wing cascade recipe (#1026), car3d.js:42. */
export interface WingStyleDef {
  readonly flaps: number; readonly arch: number; readonly twist: number; readonly teCurve: number;
  readonly chordTaper: number; readonly foot: number; readonly canard: number; readonly tipRise: number;
}
/** Per-team chassis relief (car3d.js:44-47). */
export interface TeamStyleDef {
  readonly noseTipZ: number; readonly noseSlim: number; readonly noseDroop: number;
  readonly airbox: number; readonly fin: number; readonly mirror: number; readonly inlet: number;
  readonly wingStyle: WingStyleDef;
  readonly inletH: number; readonly inletW: number; readonly undercutD: number; readonly waist: number;
  readonly floorStep: number; readonly coverCrown: number;
}

export const DEFAULT_WING: WingStyleDef = Object.freeze({ flaps: 3, arch: 0.70, twist: 0.22, teCurve: 0.10, chordTaper: 0.32, foot: 1.15, canard: 1, tipRise: 0.028 });
const W = (o: Partial<WingStyleDef>): WingStyleDef => Object.freeze(Object.assign({}, DEFAULT_WING, o));
export const DEFAULT_STYLE: TeamStyleDef = Object.freeze({ noseTipZ: 0, noseSlim: 1, noseDroop: 0,
  airbox: 1, fin: 0, mirror: 0, inlet: 0, wingStyle: DEFAULT_WING,
  inletH: 0, inletW: 0, undercutD: 0, waist: 0, floorStep: 0, coverCrown: 0 });
// Chassis relief on the STOCK garage recipe. inletH/inletW/undercutD/waist/
// floorStep/coverCrown are metres (or metre-scale offsets) so a 4 cm pair
// gap is a real silhouette change, not a paint swap. Showcase: Mercedes
// narrow + deep undercut, Red Bull tall inlet, McLaren wide low mouth,
// Haas slab. Every constructor gets a distinct combo; My Team stays 0.
// wingStyle is the 2026 front-wing cascade recipe (#1026); both live on TEAM_STYLE.
export const TEAM_STYLE: Readonly<Record<string, TeamStyleDef>> = Object.freeze({
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
/** The eleven ids TEAM_STYLE carries. */
export const TEAM_STYLE_IDS = Object.freeze(Object.keys(TEAM_STYLE));

// car3d.js:59
export function teamStyleOf(teamId: string | null | undefined): TeamStyleDef {
  return (teamId && TEAM_STYLE[teamId]) || DEFAULT_STYLE;
}

// ---------------------------------------------------------------------------
// Inputs.

/** Every livery field build() reads (`liv.*`, car3d.js:156-2121). Colours are linear RGB. */
export interface Livery extends FinishLivery {
  accent?: Vec3 | null | undefined;
  nose?: Vec3 | null | undefined;
  pod?: Vec3 | null | undefined;
  /** Flap colour (front + rear). */
  wing?: Vec3 | null | undefined;
  /** "carbon": every flap in bare weave. */
  wingCarbon?: string | null | undefined;
  rearWing?: Vec3 | null | undefined;
  cover?: Vec3 | null | undefined;
  spineTint?: Vec3 | null | undefined;
  fin?: Vec3 | null | undefined;
  /** "lr": left c1 / right c2 body. */
  bodySplit?: string | null | undefined;
  halo?: Vec3 | null | undefined;
  spineHeight?: string | null | undefined;
  spineSide?: string | null | undefined;
  spineLogo?: string | null | undefined;
  /** One of TCAM_IDS. */
  tcam?: string | undefined;
  stripe?: Vec3 | null | undefined;
  noseStripe?: Vec3 | null | undefined;
  lower?: Vec3 | null | undefined;
  upper?: Vec3 | null | undefined;
  mirrorTint?: Vec3 | null | undefined;
  /** One of FIN_SHAPE_IDS or "none". */
  finShape?: string | null | undefined;
  /** One of COVER_VENT_IDS. */
  coverVents?: string | null | undefined;
  /** Read by CarWheels.tints (car-wheels.js:20). */
  rimTint?: Vec3 | null | undefined;
  caliperTint?: Vec3 | null | undefined;
  [extra: string]: unknown;
}

type BodyGeom = ReturnType<typeof createBodyGeom>;
/** Part tier map (0/1/2 per id) plus the optional `_visual` recipes, as buildPartRecipes reads it. */
export type PartTiers = Parameters<BodyGeom["buildPartRecipes"]>[0];

/** Every opts field build() reads (`opts.*`, car3d.js:127-2165). */
export interface BuildOptions {
  noWheels?: boolean | undefined;
  teamId?: string | undefined;
  /** Field AI body (mid/far LOD): cheap cover, no helmet paint splits. */
  field?: boolean | undefined;
  /** Shadow-caster path. */
  silhouette?: boolean | undefined;
  /** First-person build. */
  cockpit?: boolean | undefined;
  /** standard | sculpted | wide | tapered | stepped (cockpit only). */
  cockpitBody?: string | undefined;
  livery?: Livery | null | undefined;
  parts?: PartTiers | null | undefined;
  ownHalo?: boolean | undefined;
  /** Force CarShade rounding on/off; unset follows CarShade.on(teamId). */
  smooth?: boolean | null | undefined;
  /** Cockpit halo choice: 0 none, 1-3 thickness, 4 faired, true default. */
  halo?: number | boolean | undefined;
  num?: number | undefined;
  noDriver?: boolean | undefined;
  helmetKey?: string | null | undefined;
  measure?: boolean | undefined;
}

/** Flap recipe build() leaves for buildComplete / the live flap mesh (car3d.js:1203). */
export interface FlapInfo {
  aLvl: number;
  style: ReturnType<BodyGeom["aeroStyleOf"]> & { wingStyle: ReturnType<BodyGeom["wingOf"]> };
  col: Vec3;
  finish: string | null;
  surface: "carbon" | "paint";
}

export interface CarMesh extends MeshOut {
  flapInfo: FlapInfo | null;
}

// ---------------------------------------------------------------------------

/* WHO WEARS THE LID, for a team whose number is not a 2026 seat. A legend or a
   MY TEAM driver must never inherit a grid driver's design through a shared
   number (ten legends carry the neutral 1 = Norris), so those teams key the
   helmet on the person: opts.helmetKey, else the legend's code, else the typed
   custom number. A 2026 team returns null and keeps its hand-made design. */
function helmetKey(opts: BuildOptions | null | undefined): string | null {
  if (!opts) return null;
  if (opts.helmetKey != null) return opts.helmetKey;
  const id = opts.teamId;
  if (id === "custom") return "custom#" + opts.num;
  const Legends = deps.legends;
  if (Legends === undefined) return null;
  if (typeof id === "string" && id.indexOf("legend_") === 0) {
    const l = Legends.byId(id.slice(7));
    return l ? l.code : null;
  }
  if (id === "legends") {
    // The player's slot carries only a number: a unique one names the legend.
    const hit = Legends.LIST.filter((l) => (l.num || 1) === (opts.num || 1));
    return hit.length === 1 ? hit[0]!.code : "LGD#" + (opts.num || 1);
  }
  return null;
}

const geometry = createGeometry({ SURFACES, CARBON, DARK, INTAKE, TYRE, RIM, HUB, HALO, VISOR, PANEL });
const { addTri, addQuad, addLoft, addBox, addBlock, addSpan,
  addWingFoil, addStationLoft, addBeveledSpan, addBeamBetween,
  addFairedArm, addWishboneWeb, addTube } = geometry;

// shadeFlags.round / coverHi: mutated for one build(), then reset (was _round / _coverHi).
const shadeFlags = { round: false, coverHi: true };

const { addWheel, buildWheel, buildWheelLayers } = createWheels({
  geometry, SURFACES, TYRE, INTAKE, shade: CarShade,   // f1-game: the typeof-guarded CarShade global, always loaded
});

const body = createBodyGeom({
  SURFACES, CARBON, DARK, INTAKE, PANEL,
  TYRE_BAND, BRAKE_CALIPER,
  AXLES, CHASSIS, DEFAULT_STYLE, DEFAULT_WING, TEAM_STYLE, teamStyleOf,
  geometry, shadeFlags,
});
const {
  styledNoseStations, bodySpan, haloHoopPath,
  endplateGeom, wingOf, wingFoilOf, frontCascade, frontBakedCount, frontHalf, frontPlateGeom,
  buildFlapGeom, aeroFlapAim, wingBandGeom, numberBoard, aeroFlapsGeom,
  FIN_SHAPES, FIN_SHAPE_IDS, FIN, sharkFinRoot, sharkFinPanel, sharkFinBadge, finOf, finTop,
  COVER_VENT_IDS, SPINE_HEIGHT_IDS, spineRise, COVER_STACK,
  coverProfile, coverFlankX, coverSurfaceY, COVER_CROWN,
  mirrorLightAnchors, cockpitMirrorGlass,
  buildPartRecipes, aeroLevelOf, aeroStyleOf,
  buildSharedChassis, bodyAnchors, addInletMouth,
  buildSidepodBodywork, buildEngineCoverBodywork,
  CAR_HALF,
} = body;

type Vec3Arg = Vec3 | null | undefined;

// car3d.js:127
export function build(color?: Vec3 | null, color2?: Vec3 | null, opts?: BuildOptions | null): CarMesh {
  const LiveryTex = deps.liveryTex;
  const noWheels = opts && opts.noWheels;
  const teamId = opts && opts.teamId;
  // Field body / silhouette = mid & far track LODs: keep the cheap cover.
  // Player, garage, and painted rivals get the dense garage/near cover.
  shadeFlags.coverHi = !(opts && (opts.field || opts.silhouette));
  const out: CarMesh = { pos: [], nrm: [], col: [], mat: [], idx: [], flapInfo: null };
  const sections: Section[] = [];
  const part = (name: string): void => {
    const at = out.pos.length / 3;
    if (sections.length) sections[sections.length - 1]!.to = at;
    sections.push({ name, from: at, to: at });
  };
  const c1: Vec3 = color  || [0.8, 0.05, 0.05];
  // COCKPIT accent dimming — the wheel has always done this (getCockpitWheel
  // tints livery to 40-45%); the body trim needs it too. Accent elements sit
  // 0.8-2.9 m from the eye over a big solid angle, so a near-white accent
  // (ferrari's c2 IS [1,1,1]) stops reading as a stripe and becomes a flat
  // pale slab: 75 of 6095 view rays landed on pure white before this
  // (tools/car/cockpit-pale-sweep.mjs). The darkest channel decides, so a SATURATED
  // accent keeps its identity and only white/silver comes down. External
  // cameras always get the full-strength livery.
  function _ckAcc(c: Vec3): Vec3;
  function _ckAcc(c: Vec3Arg): Vec3Arg;
  function _ckAcc(c: Vec3Arg): Vec3Arg {
    if (!(opts && opts.cockpit) || !c) return c;
    const mn = Math.min(c[0], c[1], c[2]);
    if (mn < 0.45) return c;
    const k = 0.42 / mn;
    return [c[0] * k, c[1] * k, c[2] * k];
  }
  const c2 = _ckAcc(color2 || [0.9, 0.9, 0.1]);
  const liv: Livery = (opts && opts.livery) || {};
  const accentC = _ckAcc(liv.accent) || c2;
  // EVERY livery paint that lands in the driver's view goes through _ckAcc,
  // not just the accent. The first pass dimmed c2/accent/wing/fin and left
  // nose, pod, halo, stripe and noseStripe at full strength — 72 pale values
  // across the shipped liveries, and the ones that matter most are the
  // closest: `pod` is the sidepod shoulders left and right of the eye, and
  // `halo` is 0.5 m in front of the face. Only the BODY (c1) stays exempt,
  // deliberately — a white car really is white, and dimming it would
  // misreport the livery (see tests/unit/cockpit-pale-surfaces.test.mjs).
  // _ckAcc is a no-op outside the cockpit build and on any colour whose
  // darkest channel is under 0.45, so saturated paint keeps its identity.
  const noseC = _ckAcc(liv.nose) || null;
  const podC  = _ckAcc(liv.pod)  || null;
  const wingC = _ckAcc(liv.wing) || c2;   // flap colour (front + rear) — c2 keeps today's look
  // WING FLAPS "carbon" (liv.wingCarbon): every flap, front and rear, in bare weave — the
  // launch-photo look on the MCL40 and the SF-26. Colour AND surface: the flap sites pass
  // SURFACES.paint explicitly, so a CARBON colour alone would render as dark paint.
  const wingCarbon = liv.wingCarbon === "carbon";
  const wingSurf = wingCarbon ? SURFACES.carbon : SURFACES.paint, wingCol = wingCarbon ? CARBON : wingC;
  const rearC = wingCarbon ? CARBON : (_ckAcc(liv.rearWing) || c2);   // REAR WING block (IBM blue, Visa white) — c2 keeps today's look
  const coverC = _ckAcc(liv.cover) || c1;
  const bandProxy = liv.spineTint || c2;
  const finRaw = (LiveryTex !== undefined && LiveryTex.resolveFinPaint)
    ? LiveryTex.resolveFinPaint(teamId, liv, coverC, bandProxy, c1, c2)
    : (liv.fin || c2);
  const finC  = _ckAcc(finRaw) || finRaw;   // shark-fin plate — finHandoff + liv.fin
  // ENGINE COVER (liv.cover): the cover loft in its own colour — the SF-26's
  // white top over a red chassis, the W17's silver over black. Absent = c1,
  // today's look. Airbox mesh lips use airboxMeshColour (wrap sun > cover).
  // BODY SPLIT (liv.bodySplit === "lr"): Cadillac-style L/R body. Left (x<0)
  // keeps c1, right (x>=0) takes c2. Applied as a paint-only recolour over the
  // chassis→livery sections so carbon / wings / glass stay untouched. It wins
  // over `lower` / `upper` (CarShade.lowerZone / upperZone).
  const bodySplitLR = liv.bodySplit === "lr";
  const haloTint = _ckAcc(liv.halo) || null;
  const T: PartTiers = (opts && opts.parts) || {};
  const tier = (id: string): number => (T as Record<string, unknown>)[id] != null ? (T as Record<string, number>)[id]! : 1;
  const ersC2: Vec3 = tier("ers") === 2 ? [c2[0]*1.8, c2[1]*1.8, c2[2]*1.8] : c2;
  const design = buildPartRecipes(T, ersC2);
  const suspT = tier("suspension");
  const suspStyle = design.suspension;
  const engStyle = design.engine;
  const brakeStyle = design.brakes;
  const tyreStyle = design.tyres;
  const ersStyle = design.ers;
  const gbStyle = design.gearbox;
  const fuelStyle = design.fuel;
  const aeroStyle = design.aero;
  out.flapInfo = null;   // filled in once wingC/aLvl are resolved, below
  const exhStyle = design.exhaust;
  const floorStyle = design.floor;
  const cockpitStyle = design.cockpit;
  const wheelStyle = design.wheels;
  const teamStyle = teamStyleOf(opts && opts.teamId);
  const ckpt = opts && opts.cockpit;   // hoisted: buildSharedChassis needs it
  // ownHalo (exterior builds only): the cockpit build's halo (opts.halo, the
  // player's COCKPIT halo choice; 0 = none) replaces the factory hoop and its
  // head-surround attachments (blade, wing, cam pods, screen). The player's
  // first-person shadow caster (car-draw.js cockpitShadowMesh): the real car
  // around the seat, but nothing over the cockpit the player cannot see.
  const exHalo = !ckpt && !(opts && opts.ownHalo);
  const shade = !ckpt && (opts && opts.smooth != null ? !!opts.smooth : CarShade.on(teamId));
  const anchors = bodyAnchors(T, opts && opts.teamId, liv.spineHeight, shade);   // rounded: coke foot + downwash ramp
  const floorEdge = Math.max(0.72, Math.min(1.35, aeroStyle.floorEdge));
  const floorCut = Math.max(0, Math.min(0.24, aeroStyle.floorCut));
  // Same envelope the front wing now respects: at the catalog's widest floor
  // recipe the edge rails measured x 0.970 and the diffuser 0.960, outside the
  // 1900 mm car. The rails carry an edge lip and a gurney another ~45 mm
  // outboard of whatever this returns, so the cap leaves that much room.
  const floorX = (k: number): number => Math.min(CAR_HALF - 0.055, k * floorEdge);
  const floorStep = teamStyle.floorStep || 0;
  const floorStepY = floorStep * 0.85;
  const floorEdgeAt = (z: number): number => {   // hoisted too: the rounded floor plate (CarShade.floor) follows it
    const t = Math.max(0, Math.min(1, (0.78 - z) / 2.36));
    return floorX(0.70 + floorStep - 0.16 * Math.max(0, t - 0.5) * 2);
  };

  part("chassis");
  shadeFlags.round = shade;
  const bodySplitFrom = out.pos.length / 3;
  const rideDY = suspStyle ? suspStyle.ride : (suspT === 0 ? 0.060 : suspT === 2 ? -0.048 : 0);
  buildSharedChassis(out, c1, rideDY, styledNoseStations(teamStyle), ckpt, floorEdgeAt);

  part("hood");
  // Driver-eye deck and shoulders (official F1 / Sky visor cams).
  const hF: Station = ckpt ? { z: 1.10, y: 0.50, w: 0.50, h: 0.10, t: 0.66 }
                           : { z: 1.15, y: 0.435, w: 0.30, h: 0.09, t: 0.64 };
  // The cowl stays ahead of the wheel and rises to its surround, beneath
  // the raised hand position; the exterior aperture keeps its own datums.
  // Deck width, height, shoulder flare, waist and forward crown per design.
  const profiles: Record<string, readonly [number, number, number, number, number]> = { standard:[0,0,0,0,0], sculpted:[-0.045,-0.008,0.025,-0.040,0.026],
    wide:[0.12,0,0.11,0.025,0.010], tapered:[-0.08,-0.015,-0.045,-0.020,-0.040], stepped:[0.04,0,0.055,-0.025,0.038] };
  const profile = profiles[String(ckpt && opts!.cockpitBody)] || profiles["standard"]!;
  const hR: Station = ckpt ? { z: 0.62, y: 0.604, w: 0.62, h: 0.118, t: 0.58 }
                           : { z: 0.30, y: 0.545, w: 0.42, h: 0.13, t: 0.58 };   // stops at the aperture (0.28), top 0.610 onto the tub line
  hR.w += profile[0]; hR.y += profile[1];
  const deck: Station[] = ckpt ? [hF, { z: 0.86, y: 0.56, w: 0.58, h: 0.12, t: 0.62 }, hR] : [hF, hR];
  for (let i = 0; i < deck.length - 1; i++) {
    bodySpan(out, deck[i]!, deck[i + 1]!, c1, 0.026);
  }
  // Exterior crown stripe follows the deck. In cockpit it foreshortens into
  // a slab (a white accent hit the centre ray at 0.69 m), so it stays outside.
  if (!ckpt) {
    const deckTop = (z: number): number => {
      const t = Math.max(0, Math.min(1, (hF.z - z) / (hF.z - hR.z)));
      return (hF.y + hF.h / 2) + ((hR.y + hR.h / 2) - (hF.y + hF.h / 2)) * t + 0.026;
    };
    addSpan(out, { z: 0.85, y: deckTop(0.85) + 0.008, w: 0.09, h: 0.016 },
                 { z: 0.05, y: deckTop(0.05) + 0.008, w: 0.11, h: 0.016 },
            ersC2, null, SURFACES.paint);
  }

  part("bolsters");
  if (ckpt) {
    for (const s of [-1, 1]) {
      // Six shoulder stations resolve the curvature beside the driver's arms.
      const stations: [number, number, number, number][] = [[1.50,0.30,0.52,0.62],[0.94,0.280,0.52,0.702],[0.44,0.255,0.50,0.735],
        [-0.12,0.282,0.50,0.749],[-0.80,0.307,0.55,0.754],[-2.56,0.32,0.55,0.754]];
      const rings = stations.map(([z,inner,outer,y]): Vec3[] =>{
        const waist = Math.exp(-Math.pow((z-0.15)/0.65,2));
        outer += profile[2] + profile[3]*waist;
        const top=Math.min(0.754,y+profile[4]*Math.exp(-Math.pow((z-0.55)/0.40,2)));
        const x=inner+(outer-inner)*0.38; // visor refs: crowned lip, not a broad painted shelf
        return [[s*inner,0.34,z],[s*outer,0.30,z],[s*outer,top-0.080,z],
          [s*(outer-0.035),top-0.025,z],[s*x,top,z],[s*(inner+0.014),y-0.008,z],[s*inner,y-0.040,z]];
      });
      const start=out.pos.length/3;
      for(let i=0;i<rings.length-1;i++) for(let j=2;j<6;j++) {
        const a=rings[i]!, b=rings[i+1]!;
        if(s>0) addQuad(out,a[j]!,b[j]!,b[j+1]!,a[j+1]!,c1); else addQuad(out,a[j+1]!,b[j+1]!,b[j]!,a[j]!,c1);
      }
      CarMaterials.smoothSkin(out,start);
      for(const i of [0,rings.length-1]) for(let j=1;j<6;j++) {
        const q=rings[i]!; if((i===0)===(s>0)) addTri(out,q[0]!,q[j]!,q[j+1]!,c1); else addTri(out,q[0]!,q[j+1]!,q[j]!,c1);
      }
      addTube(out,rings.map(q=>q[6]!),0.008,4,CARBON,SURFACES.carbon);
    }
    addBox(out, 0, 0.36, 0.60, 0.66, 0.13, 0.16, CARBON);
    addBox(out, 0, 0.345, 0.54, 0.52, 0.10, 0.05, INTAKE);   // dark instrument shroud
    // Dark six-point harness webbing avoids a pale slab across the lap.
    const WEB: Vec3 = [0.10, 0.11, 0.14];
    for (const s of [-1, 1]) {
      addQuad(out, [s*0.15,0.700,-0.30],[s*0.22,0.700,-0.30],[s*0.09,0.437,0.155],[s*0.02,0.437,0.155],WEB,SURFACES.carbon);
      addQuad(out, [s*0.245,0.398,0.064],[s*0.245,0.398,0.126],[s*0.052,0.425,0.199],[s*0.052,0.425,0.137],WEB,SURFACES.carbon);
    }
    addBox(out, 0, 0.432, 0.176, 0.088, 0.078, 0.034, [0.32, 0.32, 0.36], SURFACES.metal);
  } else {
    for (const s of [-1, 1]) {
      (shadeFlags.round ? CarShade.blockFn(addTri, { r: [0, 0.03, 0.07, 0.02] }) : addBlock)(out, [   // rounded: outer shoulder r 70 mm
        [s*0.24, 0.42, 0.14], [s*0.40, 0.42, 0.14], [s*0.40, 0.60, 0.10], [s*0.24, 0.58, 0.10],
        [s*0.24, 0.44, -0.42], [s*0.40, 0.44, -0.42], [s*0.40, 0.62, -0.44], [s*0.24, 0.60, -0.44],
      ], c1);
    }
  }

  part("sidepods");
  const podGeom = buildSidepodBodywork(out, c1, engStyle, anchors);
  // TRAP: `proud` is measured off anchors.podAt(z).x, which is the LOFT
  // CONTROL width, NOT the rendered pod surface. Measured, the two diverge by
  // 18 mm at z 0.2 and 99 mm at z -0.4, so a thin line laid the default 8 mm
  // proud is BURIED inside the bodywork over most of the pod's length. That
  // is fine for the callers below — they are tall panels whose top or bottom
  // edge clears the surface — but a flank CREASE anchored this way renders
  // identically to no change at all (two rendered attempts). Anything
  // that has to sit ON the flank must sample the built surface instead.
  function addPodFlankSpan(zFront: number, zRear: number, yFrac: number, height: number, col: Vec3,
                           surface: number | null, proud?: number, fracH?: boolean): void {
    // Never bridge a detail across a loft crease: each segment follows the
    // same station interval as the underlying sidepod surface.
    const stops = [zFront, ...anchors.podStations.map((p) => p.z)
      .filter((z) => z < zFront && z > zRear), zRear].sort((a, b) => b - a);
    for (const side of [-1, 1]) {
      for (let i = 0; i < stops.length - 1; i++) {
        const a = anchors.podAt(stops[i]!), b = anchors.podAt(stops[i + 1]!);
        addSpan(out,
          { z: stops[i]!, x: side * (a.x + (proud || 0.008)),
            y: a.bottom + (a.top - a.bottom) * yFrac,
            w: 0.016, h: fracH ? (a.top - a.bottom) * height
                               : Math.min(height, (a.top - a.bottom) * 0.78) },
          { z: stops[i + 1]!, x: side * (b.x + (proud || 0.008)),
            y: b.bottom + (b.top - b.bottom) * yFrac,
            w: 0.016, h: fracH ? (b.top - b.bottom) * height
                               : Math.min(height, (b.top - b.bottom) * 0.78) },
          col, null, surface);
      }
    }
  }

  for (const side of [-1, 1]) {
    addSpan(out,
      { z: 0.78, x: side * floorX(0.69), y: 0.108 + rideDY + floorStepY, w: 0.062, h: 0.048 + Math.max(0, floorStepY) * 0.35 },
      { z: -0.42 - floorCut, x: side * floorX(0.72), y: 0.114 + rideDY + floorStepY * 0.55, w: 0.052, h: 0.054 + Math.abs(floorStepY) * 0.25 },
      CARBON, null, SURFACES.carbon);
    addSpan(out,
      { z: -0.48 + floorCut, x: side * floorX(0.70), y: 0.116 + rideDY + floorStepY * 0.45, w: 0.048, h: 0.052 },
      { z: -1.58, x: side * floorX(0.54 + floorCut * 0.35),
        y: 0.150 + rideDY + floorStepY * 0.25, w: 0.040, h: 0.068 },
      CARBON, null, SURFACES.carbon);
    addBox(out, side * floorX(0.71), 0.128 + rideDY + floorStepY * 0.5, -0.45,
           0.038, 0.016 + Math.abs(floorStepY) * 0.4, 0.058, CARBON, SURFACES.carbon);
  }
  // 2026 floor leading-edge devices — up to five vortex teeth across the
  // width (motorsport.tech Issue-12). Chase only: they sit under the nose
  // and never enter the onboard frame.
  if (!ckpt) {
    for (const x of [-0.48, -0.24, 0, 0.24, 0.48]) {
      addBox(out, x, 0.078 + rideDY, 0.82, 0.058, 0.030, 0.11, CARBON, SURFACES.carbon);
    }
  }
  const aSlot = Math.max(0, Math.min(1, Math.round((aeroStyle && aeroStyle.slot) || 0)));
  if (aSlot && !ckpt) {
    for (const s of [-1, 1]) {
      const ex = floorEdgeAt(-1.42);
      addBox(out, s * (ex - 0.04), 0.095 + rideDY, -1.48, 0.10, 0.035, 0.16, INTAKE);
      addBox(out, s * (ex + 0.02), 0.088 + rideDY, -1.48, 0.055, 0.018, 0.12, CARBON);
    }
  }

  part("engineCover");
  let coverGeom = null;
  if (!ckpt) {
    const engT = tier("engine");
    const inScale = (engStyle ? engStyle.in : (engT === 0 ? 0.52 : engT === 2 ? 1.65 : 1.0)) * teamStyle.airbox;
    const engSnork = engStyle ? !!engStyle.snork : engT === 2;
    // Roll hoop / snorkel / intake lips: airboxMeshColour (wrap sun wins).
    const airboxC: Vec3 = (LiveryTex !== undefined && LiveryTex.airboxMeshColour)
      ? (_ckAcc(LiveryTex.airboxMeshColour(teamId, liv, coverC)) || coverC)
      : coverC;
    (shadeFlags.round ? (o: MeshOut, a: Station, b: Station, c: Vec3, f: Vec3) => CarShade.loft(o, a, b, c, addTri, { frontCol: f }) : addSpan)(out, { z: -0.28, y: 0.76, w: 0.30 * inScale, h: 0.20 * inScale, t: 0.55 },
                 { z: -0.75, y: 0.74, w: 0.26 * inScale, h: 0.18 * inScale, t: 0.55 }, airboxC, INTAKE);
    // PRINCIPAL ROLL STRUCTURE. C12.4.1 requires structure at [XC 55, 0, 968]
    // — y 0.968 here, the tallest mandated point on the car
    // (docs/notes/COCKPIT-DATUMS.md). Nothing occupied it: the airbox crowned at
    // 0.76 + 0.10*inScale (0.86 at the default tier), the rear wing peaked
    // ~0.97, and the car's silhouette therefore had its highest point at the
    // BACK — inverted from every real car, where the hoop leads and the wing
    // sits under it. The T-camera assembly (pod + bar) rides this blade's
    // crown via the snorkel-aware podY below — not a literal at y 0.955.
    // Height is regulation and therefore FIXED — an engine spec buys mouth
    // width (`in` still scales w), not a taller roll structure.
    const hoopF = 0.76 + 0.10 * inScale, hoopR = 0.74 + 0.09 * inScale;
    (shadeFlags.round ? (o: MeshOut, a: Station, b: Station, c: Vec3) => CarShade.loft(o, a, b, c, addTri, { n: 16 }) : addSpan)(out, { z: -0.33, y: (hoopF + 0.968) / 2, w: 0.15 * inScale,
                   h: Math.max(0.03, 0.968 - hoopF), t: 0.40 },
                 { z: -0.63, y: (hoopR + 0.938) / 2, w: 0.13 * inScale,
                   h: Math.max(0.03, 0.938 - hoopR), t: 0.38 }, airboxC);
    // A SPINE SIDE mark claims the flank band; culled ids leave panels alone.
    // Under wrap, trim aft tracks FLANK_SEEN so the pinstripe/hatch clear the mid-flank design.
    const sideMark = (liv.spineSide || "none") !== "none" && (!LiveryTex || !LiveryTex.SPINE_SIDE_IDS || LiveryTex.SPINE_SIDE_IDS.includes(liv.spineSide!));
    const trimAft = (sideMark && (liv.spineLogo || "logo") === "wrap"
      && LiveryTex !== undefined && LiveryTex.FLANK_SEEN)
      ? LiveryTex.FLANK!.zF - LiveryTex.FLANK_SEEN * LiveryTex.FLANK!.zLen : 0;
    coverGeom = buildEngineCoverBodywork(out, coverC, accentC, engStyle, anchors, spineRise(liv.spineHeight), sideMark, trimAft);
    // Optional scoop lip on the roll-hoop mouth (recipe-gated; default 0).
    const scoopLip = Math.max(0, Math.min(2, Math.round((engStyle && engStyle.scoopLip) || 0)));
    if (scoopLip >= 1) {
      addBox(out, 0, 0.855, -0.265,
             0.27 * inScale, 0.032, 0.030, INTAKE);
    }
    if (scoopLip >= 2) {
      for (const s of [-1, 1]) {
        addBox(out, s * (0.115 * inScale), 0.835, -0.295,
               0.045, 0.055, 0.055, CARBON);
      }
    }
    if (engSnork) {
      const sk = 0.78 + inScale * 0.32;
      const mouth = { z: -0.12, y: 0.96, w: 0.15 * sk, h: 0.10 * sk, t: 0.62 };
      const crest = { z: -0.38, y: 1.02, w: 0.12 * sk, h: 0.13 * sk, t: 0.55 };
      const merge = { z: -0.68, y: 0.88, w: 0.10 * sk, h: 0.09 * sk, t: 0.50 };
      addSpan(out, mouth, crest, airboxC, INTAKE);
      addBeveledSpan(out, crest, merge, 0.010, airboxC, null);
      addBox(out, 0, mouth.y + 0.01, mouth.z + 0.01,
             mouth.w * 0.72, mouth.h * 0.55, 0.04, INTAKE);
      if (scoopLip >= 1) {
        addBox(out, 0, mouth.y + mouth.h * 0.35, mouth.z + 0.02,
               mouth.w * 0.88, 0.022, 0.028, CARBON);
      }
      const lf = anchors.coverAt(-0.80), lr = anchors.coverAt(-1.40);
      const lfY = coverProfile(lf).shoulder - 0.06, lrY = coverProfile(lr).shoulder - 0.06;
      for (const s of [-1, 1])
        addSpan(out,
          { z: lf.z, x: s*(coverFlankX(lf, lfY) + 0.004), y: lfY, w: 0.015, h: 0.10 },
          { z: lr.z, x: s*(coverFlankX(lr, lrY) + 0.004), y: lrY, w: 0.015, h: 0.10 }, CARBON);
    }
    // T-CAMERA POD. Every car on the grid carries one and the roll hoop was
    // bare without it — it is the highest point of the silhouette, so it is in
    // shot from every external camera and reads even at grid distance. Rides
    // on the hoop crown, which the snorkel raises by ~0.22 m, so both variants
    // anchor off the same computed top rather than a literal. Team-coloured
    // housing with a dark forward face: addSpan takes a separate front-cap
    // colour, so the lens costs no triangles of its own.
    const podY = (engSnork ? 1.085 : 0.76 + 0.10 * inScale) + 0.052;
    const podZ = engSnork ? -0.34 : -0.26;
    addBox(out, 0, podY - 0.048, podZ - 0.015, 0.028, 0.055, 0.030, CARBON, SURFACES.carbon);
    // Housing colour is the livery's T-CAM pick (tcamColour): the shipped
    // accent by default, or the real black / yellow driver code.
    addSpan(out, { z: podZ + 0.055, y: podY, w: 0.118, h: 0.056, t: 0.88 },
                 { z: podZ - 0.062, y: podY - 0.003, w: 0.101, h: 0.050, t: 0.82 },
            CarMaterials.tcamColour(liv.tcam, opts ? opts.teamId : undefined, opts ? opts.num : undefined, accentC, deps.teams), [0.05, 0.05, 0.06]);
    addBox(out, 0, podY + 0.002, podZ + 0.062, 0.052, 0.026, 0.012,
           [0.02, 0.02, 0.03], SURFACES.metal);   // lens boss on the front face
    // T-CAMERA BAR — the horizontal wing of the T. Shares podY/podZ with the
    // housing: a literal at the C12.4.1 blade (y 0.955 in part("helmet")) left
    // the bar ~15 cm under every snorkel pod (McLaren factory |barY−podY| =
    // 0.182). Bodywork, not driver — draw it whether or not a helmet is in.
    addBox(out, 0, podY - 0.010, podZ, 0.30, 0.055, 0.06, DARK);
    addBox(out, 0, podY + 0.023, podZ, 0.03, 0.02, 0.03, [0.12, 0.75, 0.28], SURFACES.paint);

    const engOutlet = engStyle && engStyle.outlet != null ? engStyle.outlet
                    : (engT === 2 ? 2 : engT === 0 ? 0 : 1);
    if (engOutlet >= 1) {
      for (const s of [-1, 1]) {
        if (engOutlet === 3) {
          const cp = anchors.coverAt(-1.42);
          const cx = s * (cp.x * 0.72), cy = coverSurfaceY(cp, cx);   // rooted at the shoulder
          addSpan(out,
            { z: -1.34, x: cx, y: cy - 0.02, w: 0.085, h: 0.040, t: 0.80 },
            { z: -1.50, x: cx, y: cy + 0.04, w: 0.055, h: 0.095, t: 0.65 },
            CARBON);
          addBox(out, cx, cy + 0.095, -1.44, 0.042, 0.016, 0.070, INTAKE);
        } else {
          const n = engOutlet === 2 ? 4 : 2;
          for (let i = 0; i < n; i++) {
            const gf = anchors.coverAt(-1.13), gr = anchors.coverAt(-1.47);
            const gfY = coverProfile(gf).shoulder - 0.02 - i*0.040, grY = coverProfile(gr).shoulder - 0.02 - i*0.040;
            addSpan(out,
              { z: gf.z, x: s*(coverFlankX(gf, gfY) + 0.008), y: gfY, w: 0.02, h: 0.018 },
              { z: gr.z, x: s*(coverFlankX(gr, grY) + 0.008), y: grY, w: 0.02, h: 0.018 },
              engOutlet === 2 ? DARK : CARBON);
          }
        }
      }
      // Central hot-air vent slot at the tail of the cover (broad-cooling specs).
      if (engOutlet >= 2) addBox(out, 0, coverGeom.tailVentY, -1.72, 0.13, 0.05, 0.18, INTAKE);
    }
    const servicePanels = Math.max(0, Math.min(4, Math.round(engStyle.servicePanel || 0)));
    // With a SPINE SIDE mark on the flank the panels move aft of it: a grey
    // hatch through the race number is the one thing a real livery never
    // shows. A hatch is DETAIL, not content, so where both want a station the
    // HATCH moves — aft of trimAft, which under a wrap is where the rear tyre
    // covers the flank anyway: it still reads from hero/top/rear, a sponsor
    // name only from the side. The flank ends at z -1.90, so that start fits
    // three hatches, not a fourth hung off the back of the bodywork.
    const pz0 = trimAft ? trimAft - 0.065 : sideMark ? -1.36 : -0.82;
    const pdz = sideMark ? 0.15 : 0.19, pn = Math.min(servicePanels, trimAft ? 3 : 4);
    for (const s of [-1, 1]) for (let i = 0; i < pn; i++) {
      const z = pz0 - i * pdz, p = anchors.coverAt(z);
      // Sunk to COVER_STACK.flankTrim: a hatch is a panel line, not a blister,
      // and the drape has to run over it. At 19 mm it stands PROUD of the
      // flank decal, a grey rectangle through any full-flank design.
      addBox(out, s*(coverFlankX(p, p.top - 0.18) + COVER_STACK.flankTrim - 0.009), p.top - 0.18, z,
        0.018, 0.10, 0.13, [0.24,0.24,0.27], SURFACES.metal);
    }
    if (engStyle.heatShield) {
      const p = anchors.coverAt(-1.58);
      // No wider than the flat crown, or its edges hang over the shoulders,
      // and no taller than COVER_STACK.shield — the livery drape goes over it.
      const sh = 0.014;
      addBox(out, 0, p.top + COVER_STACK.shield - sh / 2, -1.58,
        Math.min(0.18 * engStyle.heatShield, 1.9 * COVER_CROWN * p.x),
        sh, 0.30, [0.30,0.28,0.26], SURFACES.metal);
    }
    // Team-style DORSAL FIN along the engine-cover ridge: 1 = low blade,
    // 2 = tall blade. A SECONDARY ridge blade distinct from the sharkFin
    // tail plate below (which every non-cockpit car carries). Body-colour
    // plate with an accent crest line — a strong per-team silhouette tell
    // from chase and TV cameras. Starts behind the snorkel zone (z −0.95)
    // so the two never intersect. Garage/near: rounded loft so the ridge
    // is not a square plank where it meets the rear wing (Cadillac et al.).
    if (teamStyle.fin) {
      const finH = teamStyle.fin >= 2 ? 0.19 : 0.095;
      const ff = anchors.coverAt(-0.95), fr = anchors.coverAt(-1.85);
      const bladeF = { z: ff.z, y: ff.top + finH * 0.5, w: 0.016, h: finH };
      const bladeR = { z: fr.z, y: fr.top + finH * 0.33, w: 0.014, h: finH * 0.66 };
      const crestF = { z: ff.z, y: ff.top + finH + 0.006, w: 0.020, h: 0.014 };
      const crestR = { z: fr.z, y: fr.top + finH * 0.66 + 0.005, w: 0.018, h: 0.012 };
      if (shadeFlags.round && shadeFlags.coverHi) {
        CarShade.loft(out, bladeF, bladeR, c1, addTri, { n: 10 });
        CarShade.loft(out, crestF, crestR, accentC, addTri, { n: 8 });
      } else {
        addSpan(out, bladeF, bladeR, c1);
        addSpan(out, crestF, crestR, accentC);
      }
    }
    // Engine-spec identification dots across the airbox intake lip.
    const engLed: Vec3 = engT === 2 ? [0.95, 0.22, 0.10] : engT === 0 ? [0.12, 0.82, 0.38] : [0.90, 0.62, 0.12];
    for (const lx of [-0.06, 0, 0.06])
      addBox(out, lx, 0.868, -0.30, 0.02, 0.014, 0.02, engLed, SURFACES.metal);
    // FUEL: per-option filler cap colour. Rooted on the cover skin the same
    // way the tank breather is — literals at y 0.795/0.828/0.85 left the
    // collar floating ~13 cm over a short cover and buried under a tall one.
    const fuelColor: Vec3 = fuelStyle ? fuelStyle.cap : (tier("fuel") === 2 ? [0.95, 0.28, 1.5] : [0.55, 0.52, 0.60]);
    const fuelDisplay = fuelColor.map((value) => Math.min(value, 1)) as unknown as Vec3;
    const fuelX = 0.12, fuelZ = -0.50;
    const fy = coverSurfaceY(anchors.coverAt(fuelZ), fuelX);
    addBox(out, fuelX, fy - 0.018, fuelZ, 0.075, 0.05, 0.12, [0.10, 0.10, 0.12], SURFACES.carbon);   // housing
    const fuelSurface = SURFACES.metal;
    addBox(out, fuelX, fy + 0.015, fuelZ, 0.10,  0.02, 0.15, fuelDisplay, fuelSurface);            // collar ring (proud)
    addBox(out, fuelX, fy + 0.037, fuelZ, 0.035, 0.03, 0.05, fuelDisplay, fuelSurface);            // cap dot
    const fuelFiller = Math.max(0, Math.min(2, Math.round(fuelStyle.filler || 0)));
    if (fuelFiller >= 1) {
      const fuelPorts = [{ x: fuelX, z: fuelZ, s: 1 }];
      if (fuelFiller >= 2) fuelPorts.push({ x: fuelX, z: -0.66, s: 0.85 });
      for (const p of fuelPorts) {
        const s = p.s;
        const py = coverSurfaceY(anchors.coverAt(p.z), p.x);
        addBeveledSpan(out,
          { z: p.z + 0.082 * s, x: p.x, y: py - 0.001, w: 0.108 * s, h: 0.036 * s, t: 0.88 },
          { z: p.z - 0.086 * s, x: p.x, y: py - 0.015, w: 0.060 * s, h: 0.022 * s, t: 0.70 },
          0.007 * s, [0.10, 0.10, 0.12], null, SURFACES.carbon);
        addBox(out, p.x, py + 0.055, p.z, 0.042 * s, 0.028 * s, 0.042 * s,
               [0.22, 0.22, 0.24], fuelSurface);
        addBox(out, p.x, py + 0.073, p.z, 0.050 * s, 0.010 * s, 0.050 * s,
               fuelDisplay, fuelSurface);
        const r = 0.016 * s, capY = py + 0.081, n = 6;
        const ctr: Vec3 = [p.x, capY, p.z];
        for (let i = 0; i < n; i++) {
          const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
          addTri(out, ctr,
            [p.x + Math.cos(a1) * r, capY, p.z + Math.sin(a1) * r],
            [p.x + Math.cos(a0) * r, capY, p.z + Math.sin(a0) * r],
            [0.06, 0.06, 0.07], SURFACES.carbon);
        }
      }
      if (fuelFiller >= 2) {
        addSpan(out,
          { z: fuelZ, x: 0.02, y: fy + 0.032, w: 0.018, h: 0.018 },
          { z: fuelZ, x: 0.02, y: fy + 0.132, w: 0.014, h: 0.014 },
          fuelDisplay, null, fuelSurface);
        addBox(out, 0.02, fy + 0.143, fuelZ, 0.016, 0.012, 0.016, fuelDisplay, fuelSurface);
      }
    }
    const fuelHatch = Math.max(0, Math.min(1, Math.round(fuelStyle.hatch || 0)));
    if (fuelHatch) {
      const lift = fuelFiller >= 1 ? 0.055 : 0.028;
      const hy0 = coverSurfaceY(anchors.coverAt(-0.40), fuelX);
      const hy1 = coverSurfaceY(anchors.coverAt(-0.58), fuelX);
      addSpan(out,
        { z: -0.40, x: fuelX, y: hy0 + 0.059, w: 0.108, h: 0.012, t: 0.92 },
        { z: -0.58, x: fuelX, y: hy1 + 0.059 + lift, w: 0.096, h: 0.010, t: 0.88 },
        [0.08, 0.08, 0.09], null, SURFACES.carbon);
      addBox(out, fuelX, hy0 + 0.057, -0.405, 0.092, 0.010, 0.016,
             [0.24, 0.24, 0.26], SURFACES.metal);
    }
    const fuelVent = Math.max(0, Math.min(1, Math.round(fuelStyle.vent || 0)));
    if (fuelVent) {
      addSpan(out,
        { z: fuelZ, x: 0.205, y: fy + 0.032, w: 0.016, h: 0.016 },
        { z: fuelZ, x: 0.205, y: fy + 0.117, w: 0.012, h: 0.012 },
        fuelDisplay, null, fuelSurface);
      addBox(out, 0.205, fy + 0.127, fuelZ, 0.014, 0.012, 0.014,
             [0.10, 0.10, 0.12], SURFACES.carbon);
    }
    // Tank breather across the spine from the filler (filler x +0.12, vent
    // x +0.205 — the breather mirrors at -0.185 so nothing overlaps):
    // 0 none / 1 sunk NACA duct / 2 duct + overflow standpipe.
    const fuelBreather = Math.max(0, Math.min(2, Math.round(fuelStyle.breather || 0)));
    if (fuelBreather > 0) {
      const cb = anchors.coverAt(-0.56), cbY = coverSurfaceY(cb, 0.185);   // on the shoulder facet
      addBox(out, -0.185, cbY + 0.004, -0.56, 0.052, 0.012, 0.085, INTAKE);
      addBox(out, -0.185, cbY + 0.012, -0.61, 0.058, 0.006, 0.020, CARBON, SURFACES.carbon);
      if (fuelBreather >= 2) {
        addSpan(out,
          { z: -0.62, x: -0.185, y: cbY + 0.010, w: 0.014, h: 0.014 },
          { z: -0.62, x: -0.185, y: cbY + 0.078, w: 0.011, h: 0.011 },
          fuelDisplay, null, fuelSurface);
        addBox(out, -0.185, cbY + 0.088, -0.62, 0.016, 0.012, 0.016,
               [0.10, 0.10, 0.12], SURFACES.carbon);
      }
    }
    if (fuelStyle.line) {
      const lineFront = anchors.coverAt(-0.56);
      const lineRear = anchors.coverAt(-1.30);
      const ly = coverSurfaceY(lineFront, fuelX);
      addSpan(out,
        { z: -0.56, x: fuelX, y: ly - 0.011, w: 0.018 * fuelStyle.line, h: 0.018 },
        { z: -1.30, x: coverFlankX(lineRear, lineRear.top - 0.15) + 0.006, y: lineRear.top - 0.15,
          w: 0.015 * fuelStyle.line, h: 0.015 },
        fuelDisplay, null, fuelSurface);
    }
  }

  // SPONSOR BOARD. The titleA wordmark is podDecal(R.titleA, 0.32, 0.80), so
  // the board must cover yFrac 0.32..0.80 — centre 0.56, height 0.48 x pod
  // height (the fracH=true call below). A board shorter than its decal spills
  // the glyph tops and tails onto the body paint, forcing one ink to serve a
  // pale board and the paint at once — which is why 70% of liveries once fell
  // back to a halo; the fractional sizing keeps the mark WHOLLY on the board
  // at every station so liverytex can ink it for that one colour.
  // Sized in POD FRACTIONS so each band tracks the taper and nothing overlaps:
  // the accent band holds the strip (yFrac 0.08..0.30), the board holds titleA
  // (0.32..0.80), and the accentC flash below sits at 0.88 with its lower edge
  // no deeper than 0.8195 at any station. Clean gaps at every station.
  // PANEL is a fixed pale grey and in cockpit the board carries NO decal
  // (drawCarDecals swaps in the nose-number quad), so it is a bare light
  // panel on the near plane. Its sibling flash is !ckpt-gated; this was not.
  // External keeps it — it is the substrate titleA is inked on.
  if (!ckpt) addPodFlankSpan(0.46, -0.34, 0.56, 0.48, PANEL, null, 0.008, true);
  addPodFlankSpan(0.46, -0.34, 0.19, 0.22, c2, null, 0.008, true);

  // ERS: a color-coded ENERGY-CELL strip on the coke-bottle shoulder, plus a
  // recipe-gated 2026 hybrid tell: pack blister and/or HV conduit run.
  // Runs ABOVE the sponsor band (titleA y 0.19–0.45) so it never washes the wordmark.
  const ersLed = ersStyle ? ersStyle.led : (tier("ers") === 2 ? ersC2 : null);
  const ersPack = ersStyle ? ersStyle.pack : 1.0;
  const ersGlow: Vec3 = ersLed
    ? ersLed.map((value) => Math.min(value, 1)) as unknown as Vec3
    : [1.00, 0.42, 0.08];
  if (ersLed) {
    const half = 0.16 + (ersPack - 0.9) * 0.09;
    addPodFlankSpan(podGeom.conduit.z + half + 0.025, podGeom.conduit.z - half - 0.025,
                    0.91, 0.06, [0.03, 0.03, 0.04], SURFACES.carbon, 0.018);
    addPodFlankSpan(podGeom.conduit.z + half, podGeom.conduit.z - half,
                    0.97, 0.03, ersGlow, SURFACES.metal, 0.025);
    const cells = Math.max(1, Math.min(8, Math.round(ersStyle.cells || 3)));
    for (const side of [-1, 1]) for (let i = 0; i < cells; i++) {
      const z = podGeom.conduit.z + half - (i + 0.5) * (half * 2 / cells);
      const p = anchors.podAt(z);
      addBox(out, side*(p.x + 0.032), p.top + 0.006, z,
        0.016, 0.032, Math.max(0.025, half * 1.5 / cells),
        ersGlow, SURFACES.metal);
    }
  }
  const ersBlister = Math.max(0, Math.min(2, Math.round((ersStyle && ersStyle.blister) || 0)));
  if (ersBlister > 0 && !ckpt) {
    const bS = 0.92 + 0.18 * Math.max(0, ersPack - 1);
    for (const side of [-1, 1]) {
      const z0 = ersBlister >= 2 ? -0.78 : -0.84;
      const z1 = ersBlister >= 2 ? -1.28 : -1.12;
      const pf = anchors.coverAt(z0), pr = anchors.coverAt(z1);
      // The blister rides the shoulder facet: its y is the skin's at 0.52x.
      addBeveledSpan(out,
        { z: z0, x: side * (pf.x * 0.52), y: coverSurfaceY(pf, pf.x * 0.52) + 0.010 * bS,
          w: 0.090 * bS, h: 0.032 * bS, t: 0.78 },
        { z: z1, x: side * (pr.x * 0.52), y: coverSurfaceY(pr, pr.x * 0.52) + 0.006 * bS,
          w: 0.068 * bS, h: 0.022 * bS, t: 0.70 },
        0.007, CARBON);
      const nSlot = ersBlister >= 2 ? 2 : 1;
      for (let i = 0; i < nSlot; i++) {
        const z = z0 - 0.06 - i * 0.14;
        const p = anchors.coverAt(z);
        addBox(out, side * (p.x * 0.52), coverSurfaceY(p, p.x * 0.52) + 0.026 * bS, z,
          0.055 * bS, 0.010, 0.036, INTAKE);
      }
      if (ersBlister >= 2) {
        const p = anchors.coverAt(z1 + 0.04);
        addBox(out, side * (p.x * 0.50), coverSurfaceY(p, p.x * 0.50) + 0.018 * bS, z1 + 0.02,
          0.040 * bS, 0.016, 0.028, INTAKE);
      }
    }
  }
  const ersConduit = Math.max(0, Math.min(2, Math.round((ersStyle && ersStyle.conduit) || 0)));
  if (ersConduit > 0 && !ckpt) {
    const cables = ersConduit >= 2 ? 2 : 1;
    for (const side of [-1, 1]) {
      const pod = anchors.podAt(-0.62);
      const c0 = anchors.coverAt(-0.82);
      const cMid = anchors.coverAt(-1.22);
      const c2e = anchors.coverAt(-1.68);
      for (let k = 0; k < cables; k++) {
        const yo = k * -0.028;
        const xo = k * 0.010 * side;
        const pPack: Vec3 = [side * (pod.x + 0.022 + xo), pod.top + 0.018 + yo, -0.62];
        // Cables run the flank just under the shoulder crease, on the skin.
        const eY = coverProfile(c0).shoulder - 0.02 + yo, mY = coverProfile(cMid).shoulder - 0.02 + yo,
              kY = coverProfile(c2e).shoulder - 0.02 + yo;
        const pEnter: Vec3 = [side * (coverFlankX(c0, eY) + 0.016 + xo), eY, c0.z];
        const pMid: Vec3 = [side * (coverFlankX(cMid, mY) + 0.016 + xo), mY, cMid.z];
        const pK: Vec3 = [side * (coverFlankX(c2e, kY) + 0.014 + xo), kY, c2e.z];
        addBeamBetween(out, pPack, pEnter, 0.022, ersGlow, SURFACES.metal);
        addBeamBetween(out, pEnter, pMid, 0.020, ersGlow, SURFACES.metal);
        addBeamBetween(out, pMid, pK, 0.018, ersGlow, SURFACES.metal);
      }
      addBox(out, side * (pod.x + 0.028), pod.top + 0.014, -0.62,
        0.030, 0.028, 0.038, [0.10, 0.10, 0.12], SURFACES.carbon);
      addBox(out, side * (c2e.x + 0.018), c2e.top - 0.038, c2e.z,
        0.026, 0.032, 0.040, [0.10, 0.10, 0.12], SURFACES.carbon);
      if (ersConduit >= 2) {
        for (let i = 0; i < 2; i++) {
          const z = -0.96 - i * 0.28;
          const p = anchors.coverAt(z);
          addBox(out, side * (p.x + 0.022), p.top - 0.050, z,
            0.028, 0.036, 0.044, [0.10, 0.10, 0.12], SURFACES.carbon);
        }
      }
    }
  }
  // Pack cooling mouth on the pod shoulder ahead of the energy-cell strip:
  // 0 none / 1 low NACA lip / 2 lip + louvre grille behind it.
  const ersIntake = Math.max(0, Math.min(2, Math.round((ersStyle && ersStyle.coolerIntake) || 0)));
  if (ersIntake > 0 && !ckpt) {
    for (const side of [-1, 1]) {
      const p = anchors.podAt(-0.30);
      addBox(out, side * (p.x - 0.02), p.top + 0.008, -0.30, 0.11, 0.016, 0.14, INTAKE);
      addBox(out, side * (p.x - 0.02), p.top + 0.020, -0.38, 0.12, 0.010, 0.030,
             CARBON, SURFACES.carbon);
      if (ersIntake >= 2) {
        for (let i = 0; i < 3; i++) {
          const z = -0.46 - i * 0.05, pl = anchors.podAt(z);
          addBox(out, side * (pl.x - 0.02), pl.top + 0.012, z, 0.10, 0.008, 0.028,
                 CARBON, SURFACES.carbon);
        }
      }
    }
  }

  part("bodyDetail");
  const engInlet = engStyle && engStyle.inlet != null ? engStyle.inlet
                 : (tier("engine") === 2 ? 2 : tier("engine") === 0 ? 0 : 1);
  for (const s of [-1, 1]) {
    const inlet = podGeom.inlet;
    if (engInlet === 0) {
      // Letterbox: the shallowest duct on the grid, and no lip at all.
      addInletMouth(out, s * inlet.x, inlet.y, inlet.z,
                    inlet.width * 0.75, inlet.height * 0.38, c1, 0.034, 0);
    } else if (engInlet === 2) {
      addInletMouth(out, s * inlet.x, inlet.y, inlet.z,
                    inlet.width * 0.92, inlet.height * 0.82, c1, 0.075, 0.016);
      // Splitter bar across the throat — a wide mouth needs one or it reads
      // as a missing panel rather than a radiator.
      addBox(out, s * inlet.x, inlet.y, inlet.z - 0.030,
             inlet.width * 0.86, 0.012, 0.014, CARBON, SURFACES.carbon);
    } else if (engInlet === 3) {
      for (const dx of [-1, 1])
        addInletMouth(out, s * (inlet.x + dx * inlet.width * 0.22), inlet.y, inlet.z,
                      inlet.width * 0.34, inlet.height * 0.88, c1, 0.060, 0.010);
    } else {
      // Reverse-P (2026 field majority): tall inboard stem, not a square scoop.
      addInletMouth(out, s * (inlet.x - inlet.width * 0.12),
                    inlet.y + inlet.height * 0.08, inlet.z,
                    inlet.width * 0.48, inlet.height * 0.88, c1, 0.055, 0.012);
    }
    const fenceN = Math.max(0, Math.min(6, Math.round(floorStyle.fences)));
    const fenceH = Math.max(0.6, Math.min(1.6, floorStyle.fenceH));
    const fenceStep = fenceN > 1 ? 1.08 / (fenceN - 1) : 0;
    // Floor fences sit outboard of the pod. Keep their tops under the
    // sponsor board (yFrac 0.32..0.80) so a side ray hits the board first
    // (body-split). TEAM_STYLE inlet/undercut can drop that band onto a
    // stock-height fence.
    const fenceCap = (z: number): number => {
      const pod = anchors.podAt(z);
      return pod.bottom + 0.28 * (pod.top - pod.bottom);
    };
    const fenceFit = (y: number, h: number, cap: number): { y: number; h: number } => {
      const top = y + h * 0.5;
      if (top <= cap) return { y, h };
      const room = Math.max(0.018, cap - (y - h * 0.5));
      return { y: cap - room * 0.5, h: room };
    };
    for (let i = 0; i < fenceN; i++) {
      const fz = 0.42 - i * fenceStep;
      const ex = floorEdgeAt(fz);
      const cap = fenceCap(fz);
      const a = fenceFit(0.152 + rideDY + 0.058 * fenceH, 0.132 * fenceH, cap);
      const b = fenceFit(0.168 + rideDY + 0.062 * fenceH, 0.145 * fenceH, cap);
      addSpan(out,
        { z: fz + 0.095, x: s * (ex + 0.014), y: a.y, w: 0.028, h: a.h },
        { z: fz - 0.095, x: s * (ex + 0.038), y: b.y, w: 0.022, h: b.h },
        CARBON);
    }
    const edgeLip = Math.max(0, Math.min(1, floorStyle.edgeLip || 0));
    if (edgeLip > 0) {
      const ef = floorEdgeAt(0.50), er = floorEdgeAt(-1.10);
      addSpan(out,
        { z: 0.50, x: s * (ef + 0.006), y: 0.080 + rideDY,
          w: 0.014, h: 0.038 + 0.022 * edgeLip },
        { z: -1.10, x: s * (er + 0.006), y: 0.094 + rideDY,
          w: 0.012, h: 0.034 + 0.020 * edgeLip },
        CARBON, null, SURFACES.carbon);
      addBeveledSpan(out,
        { z: 0.50, x: s * (ef + 0.030 + 0.048 * edgeLip), y: 0.118 + rideDY,
          w: 0.038 + 0.055 * edgeLip, h: 0.012 },
        { z: -1.10, x: s * (er + 0.028 + 0.042 * edgeLip), y: 0.138 + rideDY,
          w: 0.032 + 0.048 * edgeLip, h: 0.010 },
        0.004, accentC, null, SURFACES.paint);
    }
    if (Math.round(floorStyle.gurney || 0) > 0) {
      const er = floorEdgeAt(-1.10);
      addBox(out, s * (er + 0.028 + 0.042 * Math.max(0, edgeLip)), 0.154 + rideDY, -1.12,
             0.026, 0.024, 0.014, CARBON, SURFACES.carbon);
    }
    if (Math.round(floorStyle.scroll || 0) > 0) {
      const es = floorEdgeAt(-1.12), et = floorEdgeAt(-1.38);
      addSpan(out,
        { z: -1.08, x: s * (es + 0.010), y: 0.128 + rideDY, w: 0.022, h: 0.028 },
        { z: -1.38, x: s * (et + 0.016), y: 0.172 + rideDY, w: 0.018, h: 0.050 },
        CARBON, null, SURFACES.carbon);
    }
    const TI: Vec3 = [0.62, 0.60, 0.56];
    const skids = Math.max(0, Math.min(2, Math.round(floorStyle.skid || 0)));
    for (let i = 0; i < skids; i++) {
      const sz = 0.30 - i * 1.10;
      const z0 = sz + 0.16, z1 = sz - 0.16;
      addSpan(out,
        { z: z0, x: s * (floorEdgeAt(z0) - 0.09), y: 0.062 + rideDY, w: 0.20, h: 0.010 },
        { z: z1, x: s * (floorEdgeAt(z1) - 0.09), y: 0.062 + rideDY, w: 0.20, h: 0.010 },
        CARBON, null, SURFACES.carbon);
      addBox(out, s * (floorEdgeAt(sz) - 0.09), 0.050 + rideDY, sz, 0.145, 0.014, 0.22,
             TI, SURFACES.metal);
      for (const bz of [sz + 0.09, sz - 0.09]) {
        addBox(out, s * (floorEdgeAt(bz) - 0.012), 0.070 + rideDY, bz, 0.014, 0.008, 0.014,
               [0.50, 0.48, 0.44], SURFACES.metal);
      }
    }
  }
  if (Math.round(floorStyle.plank || 0) > 0 && !ckpt) {
    const PLANK: Vec3 = [0.52, 0.40, 0.22];
    addSpan(out,
      { z: 0.58, x: 0, y: 0.038 + rideDY, w: 0.30, h: 0.012 },
      { z: -1.36, x: 0, y: 0.038 + rideDY, w: 0.28, h: 0.012 },
      PLANK, null, SURFACES.panel);
    addBox(out, 0, 0.036 + rideDY,  0.55, 0.30, 0.010, 0.08, [0.62, 0.60, 0.56], SURFACES.metal);
    addBox(out, 0, 0.036 + rideDY, -1.32, 0.28, 0.010, 0.08, [0.62, 0.60, 0.56], SURFACES.metal);
  }
  const engChimney = Math.max(0, Math.min(3, Math.round(engStyle.chimney || 0)));
  for (const s of [-1, 1]) for (let i = 0; i < engChimney; i++) {
    const z = -0.16 - i * 0.30, p = anchors.podAt(z);
    const cx = s * Math.max(0.16, p.x - 0.055);
    addSpan(out,
      { z: z + 0.048, x: cx, y: p.top + 0.016, w: 0.078, h: 0.028, t: 0.85 },
      { z: z - 0.048, x: cx, y: p.top + 0.068, w: 0.050, h: 0.078, t: 0.70 },
      CARBON);
    addBox(out, cx, p.top + 0.112, z - 0.012, 0.040, 0.014, 0.060, INTAKE);
  }
  const aDuct = Math.max(0, Math.min(2, Math.round((aeroStyle && aeroStyle.duct) || 0)));
  if (aDuct > 0 && !ckpt) {
    for (const s of [-1, 1]) {
      const p = anchors.podAt(0.18);
      const x = s * Math.max(0.22, p.x - 0.04);
      if (aDuct === 1) {
        addBox(out, x, p.top + 0.018, 0.20, 0.11, 0.026, 0.20, INTAKE);
      } else {
        addBeveledSpan(out,
          { z: 0.38, x: x, y: p.top + 0.042, w: 0.10, h: 0.052, t: 0.55 },
          { z: -0.02, x: s * Math.max(0.20, p.x - 0.08), y: p.top + 0.022, w: 0.08, h: 0.038, t: 0.70 },
          0.008, CARBON);
        addBox(out, x, p.top + 0.052, 0.36, 0.068, 0.020, 0.075, INTAKE);
      }
    }
  }

  part("livery");
  // Nose TIP z moves per team (TEAM_STYLE.noseTipZ, ±0.10): the cap and both
  // stripes must end at the STYLED tip, not a shared literal, or the paint
  // floats past a short nose (haas) / stops short of a long one (williams).
  // anchors.noseAt clamps y/w beyond the tip station, so only the z endpoints
  // need deriving. Every nose graphic below is now expressed as a distance
  // BEHIND the tip for the same reason the cap already was — the tip moved
  // 580 mm rearward when the nose was cut back to sit behind the front wing,
  // and a literal 2.70 would have painted a stripe in mid-air ahead of it.
  const styledTipZ = styledNoseStations(teamStyle)[0]!.z;
  const noseAccentRear = anchors.noseAt(1.60), noseAccentFront = anchors.noseAt(styledTipZ - 0.04);
  addLoft(out, 1.60, 0, noseAccentRear.top + 0.008, 0.09, 0.016,
         styledTipZ - 0.04, 0, noseAccentFront.top + 0.008, 0.05, 0.014, c2);
  // Spine accent along the ROLL-STRUCTURE crown, not the airbox roof it used
  // to lie on: the blade now occupies z -0.33..-0.63 and a flat band at
  // y 0.862 would be buried inside it. A span follows the crown's rearward
  // fall for the same twelve triangles the box cost.
  addSpan(out, { z: -0.28, y: 0.972, w: 0.060, h: 0.030 },
               { z: -0.66, y: 0.944, w: 0.050, h: 0.026 }, c2);

  for (const s of [-1, 1]) {
    const nf = anchors.noseAt(styledTipZ - 0.12), nr = anchors.noseAt(2.025);
    addSpan(out,
      { z: nf.z, x: s*(nf.side + 0.006), y: (nf.bottom + nf.top) * 0.5, w: 0.012, h: 0.040 },
      { z: nr.z, x: s*(nr.side + 0.006), y: (nr.bottom + nr.top) * 0.5, w: 0.012, h: 0.040 },
      accentC);
  }
  // NOSE RUNNING LIGHTS — a pair of HDR white markers on the nose flanks just
  // behind the tip, plus a thin bar across the crown. NOT a regulation part:
  // real cars carry no nose DRL, and the only mandated lamp is the rear rain
  // light modelled elsewhere. This is a styling read — the >1 albedo blooms at
  // night and gives the car a forward-facing signature at grid distance.
  // Restored, not invented. The original pass placed it at literal z 2.62 and
  // 2.70; the tip is now styledTipZ (~2.60) after the nose was cut back 580 mm,
  // so those literals sit AHEAD of the car and the geometry was silently lost.
  // Re-expressed off noseAt() like every other nose graphic here, which is also
  // what lets the drlNoseMaxGap assertion mean something.
  // glass, never SURFACES.emissive: id 25 is functionalEmissive, contractually
  // RESERVED for the rain light (parts-physics "reserves emissive surfaces for
  // the FIA rain light" treats any other position as an offender), and paint is
  // capped at albedo <= 1, which a 2.4 white is not. A lens is the honest class.
  if (!ckpt) {
    const drlC: Vec3 = [2.4, 2.4, 2.7];
    for (const s of [-1, 1]) {
      const n = anchors.noseAt(styledTipZ - 0.14);
      addBox(out, s * (n.side + 0.005), n.bottom + (n.top - n.bottom) * 0.42, n.z,
             0.014, 0.026, 0.028, drlC, SURFACES.glass);
    }
    const drlBar = anchors.noseAt(styledTipZ - 0.05);
    addBox(out, 0, drlBar.top + 0.005, drlBar.z, 0.13, 0.010, 0.020, drlC, SURFACES.glass);
  }
  if (!ckpt) addPodFlankSpan(0.425, -0.025, 0.88, 0.035, accentC, SURFACES.paint, 0.012);

  const stripeC = _ckAcc(liv.stripe) || null;   // monocoque crest runs z 0.05..1.05 — right under the eye
  const stripeTipZ = styledTipZ - 0.04;
  const stripeMidZ = (1.55 + stripeTipZ) * 0.5;   // the taper waypoint, halfway up the styled nose
  if (stripeC) {
    const ns314 = anchors.noseAt(stripeTipZ), ns270 = anchors.noseAt(stripeMidZ);
    const ns155 = anchors.noseAt(1.55), ns105 = anchors.noseAt(1.05);
    addLoft(out, stripeMidZ, 0, ns270.top + 0.012, 0.075, 0.014,
           stripeTipZ, 0, ns314.top + 0.012, 0.040, 0.012, stripeC);
    addLoft(out, 1.55, 0, ns155.top + 0.012, 0.13, 0.016,
           stripeMidZ, 0, ns270.top + 0.012, 0.075, 0.014, stripeC);
    // CHASE ONLY, exactly as the hood's accent stripe above: these two runs
    // start at z 0.05 — 0.25 m from the eye, AT the near plane — then go 1.5 m
    // down the centre of the view at 0.12 m wide. Measured 739 of 24045 view
    // rays, yaw -13..13 pitch -35..-9, wholly inside the WHEEL'S own window,
    // so they foreshorten into a slab across it instead of reading as a
    // stripe; _ckAcc only makes it grey. The nose run below (1.55 → tip) is
    // 1.75 m out and under 4 deg, and stays. Guard: cockpit-crest-stripe.
    if (!ckpt) addLoft(out, 1.05, 0, ns105.top + 0.012, 0.12, 0.016,
           1.55, 0, ns155.top + 0.012, 0.13, 0.016, stripeC);
    if (!ckpt) addLoft(out, 0.05, 0, 0.655, 0.12, 0.022, 1.05, 0, 0.545, 0.13, 0.022, stripeC);   // monocoque → hood crest
    if (!ckpt) addSpan(out, { z: -0.27, y: 0.984, w: 0.080, h: 0.020 },
                            { z: -0.67, y: 0.954, w: 0.070, h: 0.018 }, stripeC);  // spine band over the roll structure
    if (!ckpt) {
      addLoft(out, -0.94, 0, 0.775, 0.075, 0.02, -0.64, 0, 0.948, 0.07, 0.02, stripeC); // roll structure → cover ridge drop
      addLoft(out, -1.95, 0, 0.600, 0.060, 0.02, -0.94, 0, 0.775, 0.075, 0.02, stripeC); // engine-cover ridge run to the tail
    }
  }
  const noseStripeC = _ckAcc(liv.noseStripe) || null;
  if (noseStripeC) {
    const ns155 = anchors.noseAt(1.55), ns270 = anchors.noseAt(stripeMidZ), ns314 = anchors.noseAt(stripeTipZ);
    addLoft(out, 1.55, 0, ns155.top + 0.016, 0.115, 0.014,
           stripeMidZ, 0, ns270.top + 0.016, 0.064, 0.012, noseStripeC);
    addLoft(out, stripeMidZ, 0, ns270.top + 0.016, 0.064, 0.012,
           stripeTipZ, 0, ns314.top + 0.016, 0.036, 0.010, noseStripeC);
  }

  if (noseC) {
    const capRearZ = styledTipZ - 0.38;
    const nt = anchors.noseAt(styledTipZ), nb = anchors.noseAt(capRearZ);
    const capF = { z: styledTipZ + 0.005, y: (nt.bottom + nt.top) * 0.5, w: nt.side*2 + 0.010, h: nt.top - nt.bottom + 0.010, t: 0.70 };
    const capR = { z: capRearZ, y: (nb.bottom + nb.top) * 0.5, w: nb.side*2 + 0.010, h: nb.top - nb.bottom + 0.010, t: 0.86 };
    // Rounded nose (CarShade): the cap wraps it at the nose's own taper instead of poking square corners past it.
    if (shadeFlags.round) CarShade.capLoft(out, capF, capR, nt, nb, noseC, addTri); else addSpan(out, capF, capR, noseC);
  }
  // Proud 0.006 keeps the pod panel UNDER the sponsor board (0.008): a board is
  // applied over the paint, not buried by it. At 0.016 the panel sat proud of
  // the board and covered it, so on every pod-set livery the sidepod wordmark
  // was actually sitting on the pod colour while being inked for the board.
  if (podC) addPodFlankSpan(0.45, 0.11, 0.60, 0.22, podC, SURFACES.paint, 0.006);

  const deckF = anchors.noseAt(2.15), deckR = anchors.noseAt(1.69), deckW = (a: typeof deckF): number => Math.min(0.28, a.topSide*1.75);
  const deckY = (a: typeof deckF): number => a.top + 0.010 - (shadeFlags.round ? CarShade.sink(a, deckW(a) / 2) : 0);   // rounded nose: edges seat on the skin
  addLoft(out, deckR.z, 0, deckY(deckR), deckW(deckR), 0.018, deckF.z, 0, deckY(deckF), deckW(deckF), 0.018, c1);
  const camPod = anchors.noseAt(1.55);
  addBox(out, 0, camPod.top + 0.045, 1.55, 0.06, 0.08, 0.15, DARK);

  // Two-tone body (CarShade): `lower` below the sidepod board line, `upper`
  // above it. bodySplit lr wins; cockpit / silhouette builds skip both.
  if (bodySplitLR) CarMaterials.applyBodySplit(out, bodySplitFrom, out.pos.length / 3, c1, c2);
  else if (!ckpt && !(opts && opts.silhouette)) {
    if (liv.lower) CarShade.lowerZone(out, bodySplitFrom, out.pos.length / 3, c1, liv.lower, anchors, SURFACES.paint);
    if (liv.upper) CarShade.upperZone(out, bodySplitFrom, out.pos.length / 3, c1, liv.upper, anchors, SURFACES.paint);
  }

  part("cockpit");
  // Exterior head surround stays out of the dedicated driver-eye mesh.
  if (!ckpt) {
    // Recipe-gated HEADREST behind the helmet: 0 flat rim (shipped) / 1 raised
    // horseshoe pad / 2 winged pad. Front face stays behind the helmet dome
    // (centre z -0.075, r 0.145 -> rear extent -0.220); pad tops stay under
    // the airbox intake underside (y 0.715). Rounded builds draw the whole
    // recipe as CarShade pipes (no stacked addBox cushions).
    const headrest = Math.max(0, Math.min(2, Math.round(cockpitStyle.headrest || 0)));
    const PAD: Vec3 = [0.08, 0.08, 0.10];
    if (shadeFlags.round) {
      CarShade.headrest(out, headrest === 0 ? DARK : PAD, addTri,
                        headrest === 0 ? null : SURFACES.carbon, headrest);
    } else {
      addBox(out, 0, 0.74, -0.18, 0.60, 0.06, 0.07, DARK); // rear hoop (flat build)
      if (headrest === 1) {
        addBox(out, 0, 0.655, -0.30, 0.34, 0.075, 0.10, PAD, SURFACES.carbon);
        for (const s of [-1, 1])
          addBox(out, s * 0.20, 0.645, -0.16, 0.06, 0.065, 0.24, PAD, SURFACES.carbon);
      } else if (headrest === 2) {
        addBox(out, 0, 0.665, -0.31, 0.36, 0.095, 0.11, PAD, SURFACES.carbon);
        for (const s of [-1, 1]) {
          addBox(out, s * 0.21, 0.675, -0.22, 0.05, 0.075, 0.16, PAD, SURFACES.carbon);
          addBox(out, s * 0.215, 0.700, -0.13, 0.04, 0.028, 0.10, PAD, SURFACES.carbon);
        }
      }
    }
  }
  if (!exHalo && opts && opts.halo) {
    const haloOpt = opts.halo;
    const faired = haloOpt === 4;
    const hk = faired || haloOpt === true ? 1 : [0, 0.64, 1, 1.44][Math.max(1, Math.min(3, (haloOpt as number) | 0))]!;
    const path: MVec3[] = haloHoopPath(0.30,0.765,-0.80,0.28,0.18,faired?1.10:1.045,0.62,faired?24:10);
    const hc = haloTint || (faired ? CARBON : HALO);
    if (faired) {
      const start=out.pos.length/3;
      // Broad carbon roof; underside curves smoothly into the central Y.
      // Swept crown rises toward the nose so its upper edge reads level
      // from the seat, instead of projecting as a deep U over the road.
      for (const p of path) p[1] = Math.max(0.765,0.82 + 0.39*(p[2]+0.20) - 0.028);
      const rings = path.map((p,i): Vec3[] => {
        const a=path[Math.max(0,i-1)]!, b=path[Math.min(path.length-1,i+1)]!;
        const dx=b[0]-a[0], dz=b[2]-a[2], len=Math.hypot(dx,dz);
        const nx=-dz/len*0.038, nz=dx/len*0.038;
        const low=p[1]-0.035*Math.max(0,p[2]+0.20)/0.82-0.15*Math.exp(-p[0]*p[0]/0.0081);
        return [[p[0]+nx,p[1]+0.028,p[2]+nz],[p[0]-nx,p[1]+0.028,p[2]-nz],
          [p[0]-nx,low,p[2]-nz],[p[0]+nx,low,p[2]+nz]];
      });
      for(let i=0;i<rings.length-1;i++)for(let j=0;j<4;j++)
        addQuad(out,rings[i]![j]!,rings[i+1]![j]!,rings[i+1]![(j+1)%4]!,rings[i]![(j+1)%4]!,hc,SURFACES.carbon);
      CarMaterials.smoothSkin(out,start);
      for(const i of [0,rings.length-1]) { const q=i===0?rings[i]!.slice().reverse():rings[i]!; addQuad(out,q[0]!,q[1]!,q[2]!,q[3]!,hc,SURFACES.carbon); }
    } else { // Visor refs: lower nearby side crown; apex and rear mounts stay fixed.
      for(const p of path) p[1]-=0.055*Math.min(1,Math.max(0,(p[2]+0.80)/0.98))*Math.pow(Math.abs(p[0])/0.28,2);
      const start=out.pos.length/3;
      addTube(out,path,0.029*hk,10,hc,SURFACES.carbon);
      for(let i=start;i<out.pos.length/3;i++) out.pos[i*3+1]=path[Math.floor((i-start)/10)]![1]+(out.pos[i*3+1]!-path[Math.floor((i-start)/10)]![1])*0.64;
      CarMaterials.smoothSkin(out,start);
    }
    // Carbon fairing: a narrow stem blending into a broad Y at the crown.
    const stem: Vec3[] = faired ? [[0.67,0.014,0.026],[0.90,0.018,0.025],[0.95,0.026,0.028],
      [1.00,0.045,0.031],[1.05,0.077,0.034],[1.10,0.135,0.036]]
      : [[0.67,0.014,0.026],[0.93,0.018,0.025],[1.059,0.060,0.031]];
    const stemStart=out.pos.length/3;
    for (let i=0;i<stem.length-1;i++) {
      const ring = (v: Vec3): Vec3[] => [[-v[1]*hk,v[0],0.62-v[2]*hk],[v[1]*hk,v[0],0.62-v[2]*hk],
        [v[1]*hk,v[0],0.62+v[2]*hk],[-v[1]*hk,v[0],0.62+v[2]*hk]];
      const a=ring(stem[i]!), b=ring(stem[i+1]!);
      for (let j=0;j<4;j++) addQuad(out,a[j]!,b[j]!,b[(j+1)%4]!,a[(j+1)%4]!,hc,SURFACES.carbon);
    }
    CarMaterials.smoothSkin(out,stemStart);
  }
  // Shared exterior centreline for the fairing and part("halo") below.
  const haloSty = Math.max(0, Math.min(2, Math.round(cockpitStyle.halo || 0)));
  const hr = haloSty === 1 ? 0.024 : 0.028;
  const crownY = 0.845 - (haloSty === 1 ? 0.008 : 0);
  const hoop = exHalo ? haloHoopPath(0.235, 0.505, -0.46, 0.30, 0.02, crownY, 0.49) : null, hoopT = hoop && shadeFlags.round ? CarShade.fine(hoop, 3) : hoop;   // rounded: a spline through it
  const haloBlade = Math.max(0, Math.min(2, Math.round(exHalo ? cockpitStyle.haloBlade || 0 : 0)));
  if (haloBlade > 0) {
    const bladeC = haloTint || HALO;
    // Co-axial fairing follows the hoop's curve, 8–11 mm proud (no coplanar faces).
    if (haloBlade === 1) {
      // Low fairing: shoulders + crown bar only (path pts 3..11 of 15).
      addTube(out, shadeFlags.round ? CarShade.fine(hoop!, 3, 3, 12) : hoop!.slice(3, 12), hr + 0.008, shadeFlags.round ? 12 : 6, bladeC, SURFACES.metal);
    } else {
      // Full shroud: the whole hoop, plus the centre spine riding clear of
      // the fatter tube.
      addTube(out, hoopT!, hr + 0.011, shadeFlags.round ? 12 : 6, bladeC, SURFACES.metal);
      addBeveledSpan(out,
        { z: 0.50, x: 0, y: 0.904, w: 0.083, h: 0.032, t: 0.50 },
        { z: 0.30, x: 0, y: 0.892, w: 0.050, h: 0.027, t: 0.55 },
        0.008, bladeC, null, SURFACES.metal);
    }
  }
  if (cockpitStyle.haloWing && exHalo) {
    const wingC = haloTint || HALO;
    addBeveledSpan(out,
      { z: 0.18, x: 0, y: 0.875, w: 0.32, h: 0.016, t: 0.50 },
      { z: -0.02, x: 0, y: 0.868, w: 0.24, h: 0.012, t: 0.42 },
      0.005, wingC, null, SURFACES.metal);
    for (const s of [-1, 1]) {
      addBox(out, s * 0.155, 0.872, 0.08, 0.010, 0.028, 0.10, wingC, SURFACES.metal);
    }
  }
  const camPods = Math.max(0, Math.min(2, Math.round(exHalo ? cockpitStyle.camPods || 0 : 0)));
  for (let i = 0; i < camPods; i++) {
    const s = i === 0 ? -1 : 1;
    addBeamBetween(out,
      [s * 0.11, 0.760, -0.20],
      [s * 0.12, 0.812, -0.14],
      0.014, DARK);
    addBox(out, s * 0.12, 0.818, -0.118, 0.030, 0.026, 0.042, DARK);
    addBox(out, s * 0.12, 0.818, -0.094, 0.016, 0.014, 0.008, VISOR, SURFACES.glass);
  }
  if (cockpitStyle.screen && exHalo) {
    addLoft(out, 0.48, 0, 0.655, 0.40, 0.028,
                 0.62, 0, 0.720, 0.20, 0.022, DARK);
    addLoft(out, 0.495, 0, 0.668, 0.34, 0.018,
                 0.605, 0, 0.710, 0.16, 0.014, VISOR, SURFACES.glass);
    for (const s of [-1, 1]) {
      addLoft(out, 0.50, s * 0.16, 0.690, 0.10, 0.020,
                   0.58, s * 0.06, 0.730, 0.06, 0.016, DARK);
    }
  }

  part("mirrors");
  const mSty = ckpt ? 0 : teamStyle.mirror;
  // Placement is REGULATION (docs/notes/COCKPIT-DATUMS.md): the body must lie inside
  // RV-MIRROR-BODY, Y 470..680 x Z 640..720. At x 0.44 / y 0.735 ours sat
  // inboard of that volume AND above its ceiling — reported as "floating".
  const mz = ckpt ? 0.92 : 0.24;
  const mScale = Math.max(0.85, Math.min(1.35, cockpitStyle.mirror || 1));
  // MIRROR HOUSING (liv.mirrorTint) / MIRROR FINISH (liv.mirrorFinish): the housing is carbon
  // today, which applyFinish never touches, so a tint or an explicit finish makes the housing
  // and stalk PAINT (the finish remap only rewrites paint ids). Both unset = today's mesh.
  const mTint = _ckAcc(liv.mirrorTint) || null;
  const mFin = liv.mirrorFinish;
  const mPaint = !!mTint || (!!mFin && (mFin === "gloss" || Object.hasOwn(FINISH_SURFACE, mFin)));
  const mHouseC: Vec3 = mTint || [0.09, 0.09, 0.11], mHouseS = mPaint ? SURFACES.paint : SURFACES.carbon;
  const mStalkC = mTint || DARK;
  const mx = ((ckpt ? 0.60 : 0.34) + (mSty === 1 ? 0.035 : 0)) * mScale;
  const msx = (ckpt ? 0.54 : 0.30) * mScale;
  const mY = (ckpt ? 0.780 : 0.735) + (mSty === 2 ? -0.032 : 0);
  const mW = mSty === 1 ? 0.235 : 0.215;   // swept style: wider housing
  const mH = mSty === 1 ? 0.065 : 0.075;
  for (const s of [-1, 1]) {
    // Tapered aero arm (wide at the tub, narrow at the housing) instead of a
    // flat box — real F1 mirror stalks are swept aero elements, not a plain post.
    // C3.7.5: the Inner Stay "must intersect Mirror Body and Mid Chassis". The
    // ckpt root is BURIED in the crown (a start at 0.68 is 17 cm above it,
    // attached to nothing). Move the crown and this must move with it.
    const xi = s * (msx - 0.04), xo = s * mx;
    const sB = ckpt ? 0.655 : 0.68;    // root buried in the cockpit shoulder
    const sR = ckpt ? 0.025 : 0.04;    // rise: must span crown -> housing underside
    const aY = mY - (ckpt ? 0.780 : 0.735);   // style drop carries into the stalk too
    const stalkTop = ckpt ? mY - mH / 2 + 0.006 : sB + sR*1.5 + aY;
    const stalkZ = mz + (ckpt ? 0.025 : 0); // tuck the stay behind the glass
    addBlock(out, [
      [xi, sB + aY, mz - (ckpt ? 0.026 : 0.045)], [xi, sB + aY, mz + (ckpt ? 0.026 : 0.045)], [xi, sB + sR + aY, mz + (ckpt ? 0.026 : 0.045)], [xi, sB + sR + aY, mz - (ckpt ? 0.026 : 0.045)],
      [xo, (ckpt ? stalkTop-0.016 : sB+sR*.75+aY), stalkZ - (ckpt ? 0.012 : 0.020)], [xo, (ckpt ? stalkTop-0.016 : sB+sR*.75+aY), stalkZ + (ckpt ? 0.012 : 0.020)],  [xo, stalkTop, stalkZ + (ckpt ? 0.012 : 0.020)], [xo, stalkTop, stalkZ - (ckpt ? 0.012 : 0.020)],
    ], mStalkC);
    // Glass goes on the face TOWARD the viewer (-z). At mz+0.066 it sits
    // 8 mm BEYOND the housing's own back face, and the driver AND the chase
    // camera see carbon, never the reflective surface.
    // Housing as an 8-corner block with the outboard face pulled BACK in z —
    // the C14.2.2 d i inboard toe (~25°): real mirrors angle at the driver,
    // and the cant is what stops the housing reading as a shoebox.
    const toe = ckpt ? 0.030 : 0.045;
    const hy0 = mY - mH / 2, hy1 = mY + mH / 2;
    const xIn = s * (mx - mW / 2), xOut = s * (mx + mW / 2);
    (shadeFlags.round ? (o: MeshOut, q: readonly Vec3[], c: Vec3, _f: Vec3Arg, sf: number) => CarShade.housing(o, q, c, addTri, sf) : addBlock)(out, [
      [xIn, hy0, mz - 0.03], [xOut, hy0, mz - 0.03 + toe], [xOut, hy1, mz - 0.03 + toe], [xIn, hy1, mz - 0.03],
      [xIn+s*(ckpt ? 0.018 : 0), hy0+(ckpt ? 0.008 : 0), mz + 0.03], [xOut-s*(ckpt ? 0.018 : 0), hy0+(ckpt ? 0.008 : 0), mz + 0.03 + toe], [xOut-s*(ckpt ? 0.018 : 0), hy1-(ckpt ? 0.008 : 0), mz + 0.03 + toe], [xIn+s*(ckpt ? 0.018 : 0), hy1-(ckpt ? 0.008 : 0), mz + 0.03],
    ], mHouseC, null, mHouseS);
    // Recessed glass and carbon bezel share the housing's cant. A flat
    // glass box on a swept housing reads as a detached grey rectangle.
    const face = (inset: number, z: number, depth: number): Vec3[] => {
      const xi=xIn+s*inset, xo=xOut-s*inset, y0=hy0+inset, y1=hy1-inset;
      const zi=z+toe*inset/mW, zo=z+toe*(1-inset/mW);
      return [[xi,y0,zi],[xo,y0,zo],[xo,y1,zo],[xi,y1,zi],
        [xi,y0,zi+depth],[xo,y0,zo+depth],[xo,y1,zo+depth],[xi,y1,zi+depth]];
    };
    if (ckpt) {
      addBlock(out,face(0.004,mz-0.035,0.006),[0.035,0.04,0.045],null,SURFACES.carbon);
      addBlock(out,face(0.012,mz-0.038,0.003),[0.38,0.40,0.42],null,SURFACES.mirror);
    } else {
      if (shadeFlags.round) addBlock(out,face(0.010,mz-0.036,0.008),[0.10,0.11,0.14],null,SURFACES.glass); else addBox(out,s*mx,mY,mz-0.032,mW*0.97,mH*0.80,0.012,[0.10,0.11,0.14],SURFACES.glass);
      if (shadeFlags.round) addBlock(out,face(0.018,mz-0.039,0.004),[0.46,0.56,0.78],null,SURFACES.glass); else addBox(out,s*mx,mY,mz-0.038,0.200,0.050,0.008,[0.46,0.56,0.78],SURFACES.glass);   // rounded: glass canted with the housing
    }
    if (!ckpt) {
      // Top winglet + the C3.7.5 OUTER stay down to the tub shoulder — the
      // two details every 2026 housing carries.
      addBox(out, s*mx, hy1 + 0.008, mz + 0.01, mW * 0.9, 0.008, 0.055, DARK, SURFACES.carbon);
      addBeamBetween(out, [s * (mx + mW * 0.38), hy0, mz + 0.02],
                          [s * (msx + 0.06), 0.60, mz + 0.10], 0.012, DARK, SURFACES.carbon);
    }
  }

  part("driver");
  // A DRIVER, not a floating head. The aperture was the right size and still
  // did not read as a cockpit, because a cockpit reads as an OCCUPIED SPACE:
  // a hole with one helmet hovering in it is a hole. Shoulders rising out of
  // the seat, arms reaching forward and a wheel under the hands are what say
  // "someone is sitting in there" — three shapes, 0 textures, and they do
  // more for the look than every millimetre of rim geometry did.
  // Sized off the opening rather than styled: the coaming abreast of the
  // driver sits at ~0.626 and the seat floor at 0.47, so the shoulders top
  // out at 0.585 — 4 cm proud of the floor's far side and 4 cm UNDER the
  // rail, which is what leaves a visible gap of tub either side instead of
  // a shoulder line jammed against the coaming. Half-width 0.145 against an
  // opening half-width of 0.184 keeps the suit clear of the rails.
  // EXTERIOR ONLY. The first-person build draws the driver's own wheel
  // (getCockpitWheel) and must not also carry a torso, which would sit in
  // the camera; noDriver drops the lot for the studio's empty-car shots.
  // `silhouette` is the shadow-caster path: the torso sits inside the tub
  // so it cannot change a sun/lamp silhouette, and paying for it on a
  // depth map is wasted fill.
  const sil = !!(opts && opts.silhouette);
  if (!ckpt && !(opts && opts.noDriver) && !sil) {
    // The suit takes the TEAM ACCENT, as a real one does. A neutral dark suit
    // was invisible: it sat in a dark liner inside a shadowed well and the
    // whole occupant read as more black smudge, which is the failure this
    // geometry exists to fix. Dimmed so a white accent (ferrari c2 is
    // [1,1,1]) does not read as a pale slab in the cockpit sweep.
    const SUIT: Vec3 = [c2[0] * 0.62 + 0.05, c2[1] * 0.62 + 0.05, c2[2] * 0.62 + 0.05];
    const GLOVE: Vec3 = [0.07, 0.07, 0.08];
    // torso: seat floor to shoulder, tapering forward into the chest
    addLoft(out, -0.22, 0, 0.5275, 0.290, 0.115,
                  0.00, 0, 0.5225, 0.250, 0.105, SUIT, SURFACES.carbon);
    // arms out to the wheel, and the wheel under them
    for (const sgn of [-1, 1]) {
      addBeamBetween(out, [sgn * 0.112, 0.556, -0.045], [sgn * 0.086, 0.508, 0.170],
                     0.046, SUIT, SURFACES.carbon);
      addBox(out, sgn * 0.086, 0.505, 0.178, 0.052, 0.055, 0.050, GLOVE, SURFACES.carbon);
    }
    // The wheel is a 2026 YOKE, not a rim: a flat squared-off crossbar with a
    // boss, which is what the hands above are holding.
    addBox(out, 0, 0.508, 0.192, 0.230, 0.052, 0.028, DARK, SURFACES.carbon);
    addBox(out, 0, 0.512, 0.206, 0.086, 0.062, 0.022, [0.14, 0.15, 0.17], SURFACES.carbon);
  }

  part("helmet");
  if (!(opts && opts.noDriver)) {
    // The driver's head: helmets.js owns the lid. cy is the TEMPLE line. At
    // 0.630 the crown sat at 0.749 under a cockpit surround topping out at
    // 0.765 — the head was BELOW the tub, and a design nobody can see is the
    // defect this module exists to fix. 0.715 clears it by 82 mm, and still
    // passes 43 mm under the halo at 0.890.
    const des = Helmets.designFor(opts && opts.num, c1, helmetKey(opts));
    // Paint-edge splits (~+2k tris on busy lids) matter when the helmet is
    // large on screen (player body, garage, cockpit). Field AI bodies are
    // tens of pixels; depth silhouettes never see paint. Both drop to 0.
    const field = !!(opts && opts.field);
    Helmets.build(out, 0, 0.715, -0.075, des, {
      paint: SURFACES.paint, glass: SURFACES.visor,
      maxSplit: (sil || field) ? 0 : undefined, simplePaint: sil || field,
    });
    // No boxes bolted on here: the rear gurney, top intake and visor strip are
    // lofts on the shell itself (helmets.js buildAero), built with the lid.
  }

  // NOT in the first-person build: it spans z -0.305..-0.175 and y 0.715..
  // 0.805, so against a driver's eye at (0.72, -0.20) its front face is 2.5 cm
  // from the camera and it straddles the eye line. Measured via the engine's
  // own occlusion raster: `player` 20.4% of the frame at distM 0.2 — this box
  // was the dark mass across the view, and the thing "cutting" the wheel.
  if (!ckpt) addBox(out, 0, 0.76, -0.24, 0.15, 0.09, 0.13, INTAKE);

  // T-camera bar + LED live next to the snorkel-aware pod in part("engineCover").

  part("halo");
  if (exHalo) {
    const haloC = haloTint || HALO, haloS = haloTint && Math.max(...haloTint) - Math.min(...haloTint) > 0.15 ? SURFACES.paint : SURFACES.metal;   // a COLOURED livery hoop is paint (Alpine pink: the metal env mirror washed it white); grey stays metal (titanium, Cadillac chrome)
    // Round titanium hoop with a LEVEL, gently arched top bar: one
    // continuous tube, collars (±0.235, 0.505, -0.46) rising to a crown
    // that holds y 0.845 (+HALO_RISE shallow arch) from mid to mid while
    // sweeping to the front apex (z 0.49) — round in plan, never peaking or
    // dipping toward the centre. r 0.028 keeps the square-section outer
    // envelope the haloBlade/haloWing/camPods attachments above were placed
    // against, so they land on the hoop. haloSty/hr/crownY and the hoop path itself
    // (haloHoopPath(0.235, 0.505, -0.46, 0.30, 0.02, crownY, 0.49)) are
    // computed once beside the blade fairing above, which wraps the SAME
    // centreline as a co-axial tube.
    // Front centre pillar rises to y 0.83 — overlapping the flat bar's
    // underside (0.845 - 0.028 = 0.817) by ~1.3 cm, never stopping short.
    if (shadeFlags.round) CarShade.strut(out, [0, 0.53, 0.47], [0, 0.83, 0.47], 0.05, 0.035, haloC, addTri, haloS, { taper: 0.8, n: 10 }); else addBox(out, 0, 0.68, 0.47, 0.035, 0.30, 0.05, haloC, haloS);
    addTube(out, hoopT!, hr, shadeFlags.round ? 12 : 6, haloC, haloS);
    // The real strut SPLITS into a V at the top, meeting the ring at two
    // points either side of the apex — the wishbone silhouette head-on.
    for (const s of [-1, 1])
      addBeamBetween(out, [0, 0.775, 0.468], [s * 0.105, crownY - hr * 0.4, 0.474],
                     0.015, haloC, haloS);
    if (haloSty === 2) {
      // Fenced hoop: three small crest vanes riding the crown bar (hoop
      // indices 5/7/9 = mid-left, apex, mid-right of the 7-point bar).
      for (const hi of [5, 7, 9]) {
        const p = hoop![hi]!;
        addBox(out, p[0], p[1] + hr + 0.012, p[2], 0.012, 0.026, 0.055,
               haloC, haloS);
      }
    }
  }

  part("exhaust");
  // Tip radius for the rain light. Cockpit: cheap stub (!ckpt has full tips).
  let exhTipRForLamp = 0.07;
  const exhTwin = exhStyle.pipes != null ? exhStyle.pipes >= 3
    : (engStyle ? !!engStyle.twin : tier("engine") === 2);
  if (ckpt) {
    addTube(out, [[0, 0.40, -2.04], [0, 0.40, -2.20]], 0.07, 6,
            [0.16, 0.16, 0.17], SURFACES.metal);
  } else {
  const exhBore = Math.max(0.7, Math.min(1.5, exhStyle.bore));
  // Floor the BASE radius for twins, then scale by bore — clamping after bore
  // collapsed hyper_scav (1.30) onto sig_audi_exh (1.133) at 0.095.
  const exhBase = engStyle ? (engStyle.twin ? 0.09 : (engStyle.in < 0.9 ? 0.05 : 0.07))
                        : (tier("engine") === 0 ? 0.05 : tier("engine") === 2 ? 0.09 : 0.07);
  const exhR = (exhTwin ? Math.max(exhBase, 0.076) : exhBase) * exhBore;
  const fuelFlame: Vec3 = fuelStyle && fuelStyle.flame || [1.15, 0.42, 0.14];
  const fTwin: Vec3 = [fuelFlame[0]*0.9, fuelFlame[1]*0.9, fuelFlame[2]*0.9];
  const exhMetal: Vec3 = [0.16, 0.16, 0.17], exhFlareC: Vec3 = [0.18, 0.18, 0.19];
  const glazeOf = (rgb: Vec3): Vec3 => rgb.map((value) => Math.min(value * 0.45, 0.65)) as unknown as Vec3;
  const exhDia = (cx: number, cy: number, z: number, r: number): Vec3[] => [
    [cx, cy - r, z], [cx + r, cy, z], [cx, cy + r, z], [cx - r, cy, z],
  ];
  const EXH_OUT = 0.34;
  // Twins low beside the crash structure; single tip in the rain-light cavity.
  const EXH_Y = exhTwin ? 0.40 : 0.50;
  const heatOf = (c: Vec3): Vec3 => { const g = glazeOf(c);
    return [exhMetal[0]*0.55+g[0]*0.45, exhMetal[1]*0.55+g[1]*0.45, exhMetal[2]*0.55+g[2]*0.45]; };
  const tipZ = exhTwin ? -2.55 : -2.58;   // at/behind rain-light plane
  const exits = exhTwin ? [-EXH_OUT, EXH_OUT] : [0];
  const tipRShow = exhTwin ? exhR : Math.max(exhR * 1.35, 0.095);
  if (exhTwin) {
    addTube(out, [[0, EXH_Y, -2.00], [0, EXH_Y, -2.10]], exhR * 0.55, 8,
            exhMetal, SURFACES.metal);
  }
  for (const cx of exits) {
    if (exhTwin) {
      const s = Math.sign(cx) || 1;
      addTube(out, [[s * 0.08, EXH_Y, -2.05], [cx, EXH_Y, -2.30]], exhR * 0.85, 8,
              exhMetal, SURFACES.metal);
      addTube(out, [[cx, EXH_Y, -2.28], [cx, EXH_Y, tipZ]], exhR, 8,
              exhMetal, SURFACES.metal);
    } else {
      addTube(out, [[0, EXH_Y, -2.04], [0, EXH_Y, tipZ]], tipRShow * 0.85, 8,
              exhMetal, SURFACES.metal);
    }
    const flame = exhTwin ? fTwin : fuelFlame, rPipe = tipRShow;
    addTube(out, [[cx, EXH_Y, tipZ + 0.10], [cx, EXH_Y, tipZ + 0.01]],
            rPipe * 1.08, 8, heatOf(flame), SURFACES.metal);
    addStationLoft(out, [
      exhDia(cx, EXH_Y, tipZ + 0.08, rPipe),
      exhDia(cx, EXH_Y, tipZ, rPipe * 1.08),
    ], exhMetal, null, SURFACES.metal);
    addBox(out, cx, EXH_Y, tipZ + 0.008, rPipe * 1.55, rPipe * 1.55, 0.018,
           [0.05, 0.04, 0.04], SURFACES.carbon);
    addBox(out, cx, EXH_Y, tipZ - 0.004, rPipe * (exhTwin ? 1.25 : 1.05),
           rPipe * (exhTwin ? 1.25 : 1.05), 0.014, glazeOf(flame), SURFACES.metal);
  }
  if (exhTwin && (exhStyle.wastegate || 0) >= 1) {
    addBox(out, 0, EXH_Y + exhR + 0.055, tipZ + 0.02, EXH_OUT * 2.05, 0.028, 0.045,
           exhMetal, SURFACES.metal);
  }
  const exhFlare = Math.max(0, Math.min(1, exhStyle.flare || 0));
  if (exhFlare > 0) {
    // Megaphone open rim at the rear face (no solid tip — keeps the rain light).
    const flareMul = exhTwin ? 0.55 : 1.15;
    for (const cx of exits) {
      const tip = tipRShow * (1 + flareMul * exhFlare);
      const z0 = tipZ + 0.08, z1 = tipZ + 0.005;
      addStationLoft(out, [exhDia(cx, EXH_Y, z0, tipRShow), exhDia(cx, EXH_Y, z1, tip)],
                     exhFlareC, null, SURFACES.metal);
      addStationLoft(out, [exhDia(cx, EXH_Y, z1, tip * 1.05), exhDia(cx, EXH_Y, z1 - 0.012, tip * 1.12)],
                     [0.22, 0.22, 0.24], null, SURFACES.metal);
    }
  }
  if (exhStyle.wrap) {
    for (const cx of exits) {
      addBox(out, cx, EXH_Y, -2.10, exhR * 1.18, exhR * 1.18, 0.06,
             [0.72, 0.70, 0.66], SURFACES.panel);
      addBox(out, cx, EXH_Y, -2.06, exhR * 1.24, exhR * 1.12, 0.045,
             [0.68, 0.66, 0.62], SURFACES.panel);
      if (!exhTwin) {
        addBox(out, 0, EXH_Y, -1.96, exhR * 1.14, exhR * 1.22, 0.045,
               [0.74, 0.72, 0.67], SURFACES.panel);
        addBox(out, 0, EXH_Y, -2.02, exhR * 1.30, 0.012, 0.012,
               [0.22, 0.22, 0.24], SURFACES.metal);
      }
    }
  }
  const exhGates = Math.max(0, Math.min(2, Math.round(exhStyle.wastegate || 0)));
  for (let i = 0; i < exhGates; i++) {
    const s = i === 0 ? -1 : 1;
    const gx = exhTwin ? s * (EXH_OUT * 0.55) : s * 0.075;
    const tipX = exhTwin ? s * EXH_OUT * 0.72 : s * 0.098;
    addSpan(out, { z: -2.02, x: gx, y: 0.47, w: 0.036, h: 0.036 },
                 { z: tipZ + 0.06, x: tipX, y: 0.53, w: 0.030, h: 0.030 },
            [0.20, 0.20, 0.22], null, SURFACES.metal);
    addBox(out, tipX, 0.535, tipZ + 0.05, 0.034, 0.034, 0.028,
           [0.22, 0.22, 0.24], SURFACES.metal);
    addBox(out, tipX, 0.535, tipZ + 0.032, 0.020, 0.020, 0.012,
           glazeOf(fTwin), SURFACES.metal);
  }
  const exhLip = Math.max(0, Math.min(2, Math.round(exhStyle.lip || 0)));
  if (exhLip >= 1) {
    for (const cx of exits) {
      const colR = exhR * (1 + (exhTwin ? 0.18 : 0.22) * exhLip);
      addBox(out, cx, EXH_Y, tipZ + (exhTwin ? 0.14 : 0.22),
             colR * (exhTwin ? 2.0 : 2.15), colR * (exhTwin ? 2.0 : 2.15),
             exhTwin ? 0.06 : 0.09, CARBON, SURFACES.carbon);
      if (!exhTwin) {
        addBox(out, 0, EXH_Y, tipZ + 0.16, colR * 1.95, colR * 1.95, 0.03,
               [0.20, 0.20, 0.22], SURFACES.metal);
      }
    }
  }
  if (exhLip >= 2 && !exhTwin) {
    const colR = exhR * 1.44;
    addBox(out, 0, EXH_Y, tipZ + 0.28, colR * 2.35, colR * 2.35, 0.06, CARBON, SURFACES.carbon);
  }
  if (exhStyle.shield) {
    for (const cx of exits) {
      addBox(out, cx, EXH_Y + tipRShow + 0.028, tipZ + (exhTwin ? 0.16 : 0.22),
             Math.max(exhTwin ? 0.10 : 0.12, tipRShow * (exhTwin ? 2.4 : 2.6)), 0.010,
             exhTwin ? 0.14 : 0.16, [0.32, 0.30, 0.28], SURFACES.metal);
      if (!exhTwin) {
        for (const s of [-1, 1]) {
          addBox(out, s * (tipRShow + 0.022), EXH_Y + tipRShow * 0.45, tipZ + 0.22,
                 0.010, tipRShow * 1.05, 0.13, [0.28, 0.26, 0.24], SURFACES.metal);
        }
      }
    }
  }
  exhTipRForLamp = tipRShow * (exhFlare > 0 && !exhTwin ? (1 + 1.15 * exhFlare) : 1);
  }

  part("sharkFin");
  // liv.finShape picks the outline (FIN_SHAPES); "none" builds no blade at
  // all, and car-mesh reads the same field to leave the decal off too.
  const finShape = liv.finShape || "standard";
  if (!ckpt && finShape !== "none") {
    const F = finOf(finShape);
    const fb = F.halfBase, ft = F.halfTop;
    // The base follows the engine cover in BOTH directions — sharkFinRoot(),
    // the same function car-mesh places the decal from, so the graphic cannot
    // be left behind by a crown that moved. (Lowering only costs 113 mm of the
    // panel inside the cover on every shipped dorsal car.)
    const fRoot = sharkFinRoot(anchors, aeroStyle && aeroStyle.fin, finShape);
    const bLE = fRoot.bLE, bTE = fRoot.bTE;
    const root = (z: number, y0: number): number => {
      const c = anchors.coverAt(z);
      return c && c.top != null ? c.top - 0.010 : y0;
    };
    // Blade height. The fin is 12 triangles carrying the largest flat plate at
    // the highest point on the car, so this is the cheapest silhouette on the
    // whole body — and it had no recipe at all.
    const tp = finTop(aeroStyle && aeroStyle.fin, finShape);
    addBlock(out, [
      [-fb, bLE, F.baseLE[0]], [fb, bLE, F.baseLE[0]],
      [ft, tp, F.topLE[0]],    [-ft, tp, F.topLE[0]],
      [-fb, bTE, F.baseTE[0]], [fb, bTE, F.baseTE[0]],
      [ft, tp, F.topTE[0]],    [-ft, tp, F.topTE[0]],
    ], finC);
    if (F.step) {
      // The lower rear section of a stepped fin, scaled about the base line
      // by the same aero factor as the blade so the step stays proportional.
      const S = F.step, f = Math.max(0.55, Math.min(1.45, (aeroStyle && aeroStyle.fin) || 1));
      const tp2 = F.baseTE[1] + (S.top - F.baseTE[1]) * f;
      const bTE2 = root(S.baseTE[0], S.baseTE[1]);
      addBlock(out, [
        [-fb, bTE, F.baseTE[0]],   [fb, bTE, F.baseTE[0]],
        [ft, tp2, F.baseTE[0]],    [-ft, tp2, F.baseTE[0]],
        [-fb, bTE2, S.baseTE[0]],  [fb, bTE2, S.baseTE[0]],
        [ft, tp2, S.baseTE[0] + 0.03], [-ft, tp2, S.baseTE[0] + 0.03],
      ], finC);
    }
  }
  // COVER VENTS (liv.coverVents; ids in COVER_VENT_IDS). Dark carbon boxes just
  // proud of the cover — a decal would need an atlas region the flanks lack.
  const vents = liv.coverVents || "none";
  if (!ckpt && vents === "gills") {
    for (const s of [-1, 1]) for (let r = 0; r < 2; r++) for (let i = 0; i < 4; i++) {
      const z = -0.98 - i * 0.11, p = anchors.coverAt(z);
      if (!p) continue;
      const gy = coverProfile(p).shoulder - 0.025 - r * 0.045;   // on the flank, under the crease
      addBox(out, s * (coverFlankX(p, gy) + 0.006), gy, z, 0.012, 0.014, 0.075, CARBON, SURFACES.carbon);
    }
  } else if (!ckpt && vents === "spine") {
    // Along the ridge where it is FREE — of the fin root AND of the crest decal
    // (car-mesh maps REGIONS.crest onto z -0.62..-1.28): the first cut ran the
    // slot straight through the horse, measured in the studio. A full-chord fin
    // roots at z -0.65, so only the short gap behind the airbox is open; with a
    // stub or no fin and no spine crest the bare ridge ahead of the root takes
    // a long slot (the AMR24 look); with no fin but a crest it sits behind the
    // crest. Nowhere else is honest, so nowhere else is offered.
    const finRootZ = finShape === "none" ? -1.70 : finOf(finShape).baseLE[0];
    const crestOn = (liv.spineLogo || "logo") !== "none";
    let zc = -0.56, len = 0.14;
    if (!crestOn && finRootZ < -1.0) { len = Math.min(0.5, (-0.66 - finRootZ) - 0.06); zc = -0.69 - len / 2; }
    else if (crestOn && finShape === "none") { zc = -1.47; len = 0.30; }
    const p = anchors.coverAt(zc);
    // Sunk to COVER_STACK.vent: a slot is a hole, so it sits UNDER the drape.
    const vh = 0.008;
    if (p) addBox(out, 0, p.top + COVER_STACK.vent - vh / 2, zc, 0.05, vh, len, CARBON, SURFACES.carbon);
  }

  part("sponsorBoard");
  const aeroT = tier("aero");
  const aLvl = aeroStyle && aeroStyle.lvl != null
    ? aeroStyle.lvl : (aeroT === 0 ? 0 : aeroT === 2 ? 4 : 2);
  const ws = wingOf(teamStyle);
  out.flapInfo = { aLvl, style: Object.assign({}, aeroStyle, { wingStyle: ws }), col: wingCol,
    finish: CarMaterials.finishOf(liv, "wingFinish"), surface: wingCarbon ? "carbon" : "paint" };

  const nb = numberBoard(aLvl, aeroStyle);
  for (const s of [-1, 1]) {
    addBox(out, s*0.527, nb.cy, -2.42, 0.012, nb.h, 0.30, c1);
  }

  part("frontWing");
  // COCKPIT-ONLY front wing. The real cascade below is correct and, from a
  // seated eye, invisible: MEASURED 12.9 deg below the sightline, which is
  // UNDER the hood crest (9.8), so it rasterised 0.01% of frame. The
  // first-person body is its own mesh, so it carries its own wing where the
  // driver can see it — 8.5 deg down, between nose deck (7.1) and hood
  // crest. View-only by design; the chase car's wing is untouched.
  // Rastered at canvas res it lands at x 228..615, y 226..313 of 844x390 —
  // on screen, below centre, and still hard to see: 20208 px alone, 6901
  // surviving (bolsters 9029, hood 2214, mirrors 1526), in the flap colour
  // against a dark surround. So the plane takes the PRIMARY livery colour
  // and rises to 0.47 (8.0 deg down, just under the nose deck's 7.1).
  if (ckpt) {
    addBox(out, 0, 0.47, 2.30, 1.62, 0.040, 0.44, c1, SURFACES.paint);
    for (const s of [-1, 1])
      addBox(out, s*0.84, 0.55, 2.30, 0.035, 0.20, 0.48, wingCol, wingSurf);
  }
  // 2026: no beam by default (tier-2 used to imply beam:1). Active flaps
  // (drs) come from aeroStyleOf / buildAeroParts when a recipe omits them.
  const aBeam = aeroStyle ? (aeroStyle.beam || 0) : 0;
  const aDrs  = aeroStyle ? (aeroStyle.drs  || 0) : 1;
  const frontSweep = Math.max(-0.08, Math.min(0.22, aeroStyle.frontSweep));
  const frontTaper = Math.max(0.72, Math.min(1.08, aeroStyle.frontTaper));
  const frontRise = Math.max(-0.03, Math.min(0.16, aeroStyle.frontRise));

  const fwHalf = frontHalf(aLvl);               // half-span (endplate sits just outside)
  const fwElems = frontCascade(aLvl);
  const fwBaked = frontBakedCount(aLvl);
  for (let i = 0; i < fwBaked; i++) {
    const e = fwElems[i]!, half = fwHalf * e[4]!, extra = wingFoilOf(ws, i);
    addWingFoil(out, {
      zLead: e[0]!, yLead: e[1]!, zTrail: e[2]!, yTrail: e[3]!,
      half, thick: e[5]!, taper: frontTaper,
      sweep: frontSweep * (0.75 + i * 0.10),
      rise: frontRise * (0.65 + i * 0.12) + extra.tipRise,
      attachHalf: fwHalf + 0.03,
      twist: extra.twist, teCurve: extra.teCurve, chordTaper: extra.chordTaper,
    }, i === 0 ? c1 : wingCol, i === 0 ? SURFACES.paint : wingSurf);
  }
  const aPlate = Math.max(0, Math.min(3, Math.round(
    aeroStyle.plate != null ? aeroStyle.plate : 1)));
  // The plate table and its placement live at module scope (frontPlateGeom):
  // the decal mesh reads the same numbers, or it floats.
  const _fp = frontPlateGeom(aLvl, aeroStyle), PLATE = _fp.P;
  const aArch = aeroStyle.arch != null
    ? Math.max(0, Math.min(1, Math.round(aeroStyle.arch as number))) : (PLATE.arch || 0);
  const aGill = aeroStyle.gill != null
    ? Math.max(0, Math.min(4, Math.round(aeroStyle.gill as number))) : (aPlate >= 2 ? 3 : 0);
  const aCasc = Math.max(0, Math.min(3, Math.round(aeroStyle.casc != null ? aeroStyle.casc
    : (aLvl >= 4 ? 3 : (aLvl >= 3 ? 2 : (aLvl >= 1 ? 1 : 0))))));
  for (const s of [-1, 1]) {
    const epW = _fp.w;
    // The plate's LEADING edge stays flush with the foil tip (attachHalf =
    // fwHalf + 0.03) — that is the one place the two actually meet. What was
    // wrong is the outboard `kick` on the trailing station: real endplates are
    // near-parallel to the centreline and win their outwash from the shape of
    // the tip, not by leaning 120 mm out of the car. Clamp it to whatever room
    // CAR_HALF leaves once the plate's own thickness is paid for.
    const epX = s * _fp.front.x;
    const epKick = _fp.kick;
    const archN = ws.arch != null ? ws.arch : (aArch ? 1 : 0.45);
    const bevel = Math.min(0.014, epW * 0.28);
    addBeveledSpan(out,
      { z: 2.66, x: epX, y: 0.135, w: epW, h: PLATE.hF, t: _fp.front.t },
      { z: 2.30, x: epX + s*epKick*0.42, y: 0.190 + archN * 0.008, w: epW * 0.93,
        h: (PLATE.hF + PLATE.hR) * 0.5 + archN * 0.038, t: 0.70 },
      bevel, c2);
    addBeveledSpan(out,
      { z: 2.30, x: epX + s*epKick*0.42, y: 0.190 + archN * 0.008, w: epW * 0.93,
        h: (PLATE.hF + PLATE.hR) * 0.5 + archN * 0.038, t: 0.70 },
      { z: 1.98, x: epX + s*epKick, y: 0.245, w: epW * 0.88, h: PLATE.hR, t: _fp.rear.t },
      bevel, c2);
    const footW = Math.min(PLATE.footW * (ws.foot || 1), (CAR_HALF - Math.abs(epX) - 0.02) * 2);
    addBox(out, epX - s * (footW * 0.08), 0.034, 2.50, footW * 0.92, 0.016, 0.50, CARBON);
    addBeveledSpan(out,
      { z: 2.58, x: epX + s * (footW * 0.20), y: 0.050, w: 0.032, h: 0.022, t: 0.55 },
      { z: 2.14, x: epX + s * (footW * 0.14 + epKick * 0.25), y: 0.058, w: 0.028, h: 0.030, t: 0.70 },
      0.005, CARBON);
    addBeveledSpan(out,
      { z: 2.58, x: s * (fwHalf * 0.52), y: 0.058, w: 0.012, h: 0.050, t: 0.50 },
      { z: 2.20, x: s * (fwHalf * 0.70), y: 0.066, w: 0.010, h: 0.044, t: 0.68 },
      0.005, CARBON);
    // ARCH and GILL were welded to the plate tier: an arch existed only on
    // plate 2 and gills only on plate >= 2, so four plate profiles were four
    // fixed combinations rather than a plate crossed with two choices. Null
    // keeps every shipped recipe exactly where it was.
    addBeveledSpan(out,
      { z: 2.62, x: epX + s*0.010, y: 0.135 + PLATE.hF * 0.5 + archN * 0.028, w: 0.032, h: 0.020 },
      { z: 2.06, x: epX + s*(epKick + 0.010), y: 0.245 + PLATE.hR * 0.46, w: 0.028, h: 0.016 },
      0.006, aArch ? c1 : CARBON);
    if (aGill > 0) {
      // GILLS. The rear endplate has had its louvre stack for ages; the
      // front plate — the one a chase camera actually fills the frame with —
      // had a blank outboard face. Recessed slots, proud of the plate so they
      // read as cuts rather than z-fighting decals.
      for (let i = 0; i < aGill; i++) {
        const gz = 2.42 - i * 0.15;
        addBox(out, epX + s * (epKick * 0.55 + 0.010), 0.185 + PLATE.hF * 0.30 + i * 0.026, gz,
               0.014, 0.020, 0.11, INTAKE, SURFACES.carbon);
      }
    }
    if (aPlate >= 2) {
      // FILLET at the plate-to-main-plane junction: the hard 90 deg corner
      // there is the last unfaired intersection on the front wing. This one
      // IS a property of the plate, so it stays on the plate tier.
      addBeveledSpan(out,
        { z: 2.60, x: epX - s * 0.030, y: 0.150, w: 0.060, h: 0.030, t: 0.35 },
        { z: 2.26, x: epX - s * 0.026, y: 0.178, w: 0.050, h: 0.024, t: 0.30 },
        0.006, c1);
    }
    if (PLATE.roll) {
      // Rolled top edge: a lip leaning OUTBOARD off the plate crown, wider
      // and more canted at the rear — the outwash curl, not a straight rail.
      addBeveledSpan(out,
        { z: 2.58, x: epX + s * 0.012, y: 0.135 + PLATE.hF * 0.5 + 0.006, w: 0.040, h: 0.014, t: 0.45 },
        { z: 2.02, x: epX + s * epKick, y: 0.245 + PLATE.hR * 0.5 - 0.004, w: 0.044, h: 0.012, t: 0.40 },
        0.006, c2);
    }
    // Canard / dive-plane: first element is a horizontal strake on the
    // outer face (the 2026 flick); extras stay as the older cascade vanes.
    const nCan = Math.max(aCasc, ws.canard || 0);
    for (let i = 0; i < nCan; i++) {
      if (i === 0) {
        addBeveledSpan(out,
          { z: 2.60, x: epX + s * 0.030, y: 0.152, w: 0.095, h: 0.016, t: 0.45 },
          { z: 2.30, x: epX + s * 0.058, y: 0.172, w: 0.115, h: 0.013, t: 0.62 },
          0.004, CARBON);
      } else {
        const cz = 2.52 - i * 0.18, cy = 0.170 + i * 0.058;
        addBeveledSpan(out,
          { z: cz,        x: s * (fwHalf - 0.03), y: cy,         w: 0.018, h: 0.12, t: 0.55 },
          { z: cz - 0.22, x: epX + s*0.012,       y: cy + 0.070, w: 0.018, h: 0.18, t: 0.70 },
          0.008, c1);
      }
    }
    if (shadeFlags.round) CarShade.strut(out, [s*0.09, 0.085, 2.54], [s*0.09, 0.275, 2.40], 0.16, 0.040, c1, addTri, null, { n: 10, taper: 0.72 });
    else addFairedArm(out, [s*0.09, 0.275, 2.40], [s*0.09, 0.085, 2.54], 0.040, c1, SURFACES.paint);
  }

  const aVane = aeroStyle && aeroStyle.vane != null ? aeroStyle.vane
              : (aLvl >= 4 ? 3 : aLvl >= 3 ? 2 : aLvl >= 1 ? 1 : 0);
  if (!ckpt && aVane > 0) {
    for (const s of [-1, 1]) {
      // Primary vane — always present.
      addBeveledSpan(out,
        { z: 1.15, x: s*0.73, y: 0.30, w: 0.014, h: 0.22, t: 0.50 },
        { z: 0.81, x: s*0.73, y: 0.30, w: 0.014, h: 0.22, t: 0.50 },
        0.006, CARBON);
      // FOOTPLATE under it. Every real bargeboard cluster turns out into a
      // horizontal foot at its base; without one the default car (vane 1) had
      // a single blade standing in clear air on each side, which is the one
      // configuration most of the grid actually runs. Outboard of the aVane>=3
      // turning vane at x 0.60 and of the `board` wakeboard at x 0.48-0.58, so
      // the three never share a volume.
      addBeveledSpan(out,
        { z: 1.15, x: s*0.725, y: 0.196, w: 0.135, h: 0.016, t: 0.74 },
        { z: 0.81, x: s*0.735, y: 0.204, w: 0.115, h: 0.014, t: 0.82 },
        0.005, CARBON);
      if (aVane >= 2) addBeveledSpan(out,
        { z: 0.87, x: s*0.66, y: 0.26, w: 0.014, h: 0.17, t: 0.50 },
        { z: 0.57, x: s*0.66, y: 0.26, w: 0.014, h: 0.17, t: 0.50 },
        0.006, CARBON);
      if (aVane >= 3) {
        // Curved triple cascade: a swept forward vane + a canted footplate vane.
        addBeveledSpan(out,
          { z: 1.28, x: s*0.70, y: 0.28, w: 0.02, h: 0.20 },
          { z: 0.98, x: s*0.62, y: 0.24, w: 0.02, h: 0.26 },
          0.008, CARBON);
        addBox(out, s*0.60, 0.19, 0.86, 0.16, 0.014, 0.36, CARBON);   // horizontal turning vane
      }
    }
  }
  // 2026 in-wash WAKEBOARD (`board`) — the regulated floor-board / bargeboard
  // return, inboard of the turning-vane cluster so the two never occupy the
  // same volume. 0 none · 1 vertical fence · 2 fence + horizontal foot.
  const aBoard = Math.max(0, Math.min(2, Math.round((aeroStyle && aeroStyle.board) || 0)));
  if (aBoard > 0 && !ckpt) {
    for (const s of [-1, 1]) {
      addBeveledSpan(out,
        { z: 1.38, x: s * 0.48, y: 0.20, w: 0.014, h: aBoard === 2 ? 0.20 : 0.14, t: 0.45 },
        { z: 0.92, x: s * 0.58, y: 0.24, w: 0.012, h: aBoard === 2 ? 0.16 : 0.12, t: 0.60 },
        0.006, CARBON);
      if (aBoard >= 2) addBeveledSpan(out,
        { z: 1.22, x: s * 0.44, y: 0.145, w: 0.15, h: 0.016, t: 0.70 },
        { z: 0.86, x: s * 0.56, y: 0.165, w: 0.12, h: 0.014, t: 0.80 },
        0.005, CARBON);
    }
  }

  part("rearAssembly");
  if (!ckpt) {
    const rwLift = (aLvl - 2) * 0.045;        // gentler vertical shift (beam-wing ref)
    const _ep    = endplateGeom(aLvl, aeroStyle);
    const epSY   = _ep.sy;   // grows with lvl + rearSweep + fin (side silhouette)
    const epCY   = _ep.cy;
    for (const s of [-1, 1]) {   // rounded build: a shaped plate with its crown (CarShade.endplate)
      if (shadeFlags.round) CarShade.endplate(out, _ep, s, DARK, rearC, wingSurf, addTri); else addBeveledSpan(out,
        { z: _ep.front.z, x: s*0.50, y: _ep.front.cy, w: 0.040, h: _ep.front.sy, t: 0.58 },
        { z: _ep.rear.z, x: s*0.50, y: _ep.rear.cy, w: 0.040, h: _ep.rear.sy, t: 0.72 },
        0.012, DARK);
      // Endplate WINDOWS + louvres. The old 18 mm flush slots sat inside the
      // plate thickness and read as a blank black slab from wingRear. Proud
      // raked cuts catch the bay light; two larger recesses read as DRS
      // cut-outs (void, not painted lines).
      for (let i = 0; i < 2; i++) {
        const wy = epCY + epSY * 0.12 - i * 0.11;
        addSpan(out, { z: -2.18, x: s * 0.538, y: wy + 0.028, w: 0.028, h: 0.055, t: 0.78 },
                     { z: -2.46, x: s * 0.522, y: wy - 0.012, w: 0.022, h: 0.042, t: 0.62 },
                INTAKE, null, SURFACES.carbon);
      }
      for (let i = 0; i < 5; i++) {
        const ly = epCY + epSY * 0.42 - i * 0.048;
        addSpan(out, { z: -2.20, x: s * 0.536, y: ly + 0.014, w: 0.022, h: 0.022, t: 0.82 },
                     { z: -2.42, x: s * 0.524, y: ly - 0.012, w: 0.018, h: 0.018, t: 0.64 },
                INTAKE, null, SURFACES.carbon);
      }
      if (!shadeFlags.round) addBeveledSpan(out,
        { z: _ep.front.z, x: s*0.50, y: _ep.front.top, w: 0.046, h: 0.018, t: 0.70 },
        { z: _ep.rear.z, x: s*0.50, y: _ep.rear.top, w: 0.046, h: 0.018, t: 0.85 },
        0.006, rearC, null, wingSurf);
    }
    const rearSweep = Math.max(-0.06, Math.min(0.20, aeroStyle.rearSweep));
    const rearTaper = Math.max(0.72, Math.min(1.08, aeroStyle.rearTaper));
    const crownY = _ep.rear.top - 0.018;
    const upperTrailY = crownY - (aLvl >= 4 || aDrs ? 0.075 : 0);
    const rearWing = (zLead: number, yLead: number, zTrail: number, yTrail: number, half: number, thick: number, col: Vec3, scale?: number): void =>
      addWingFoil(out, {
        zLead, yLead, zTrail, yTrail, half, thick,
        taper: rearTaper, sweep: rearSweep * (scale == null ? 1 : scale), rise: 0,
        attachHalf: 0.50,
      }, col, wingSurf);
    rearWing(-2.30, upperTrailY - 0.270, -2.52, upperTrailY - 0.225,
      0.51, 0.024, c1, 0.8);
    const aSwan = aeroStyle && aeroStyle.swan ? 1 : 0;
    if (aSwan) {
      const mainTopY = upperTrailY - 0.225 + 0.016;
      for (const s of [-1, 1]) {
        addSpan(out, { z: -1.98, x: s*0.16, y: 0.46, w: 0.048, h: 0.13 },
                     { z: -2.26, x: s*0.16, y: mainTopY + 0.075, w: 0.036, h: 0.095 }, DARK);
        addSpan(out, { z: -2.26, x: s*0.16, y: mainTopY + 0.075, w: 0.036, h: 0.060 },
                     { z: -2.44, x: s*0.16, y: mainTopY + 0.012, w: 0.030, h: 0.048 }, DARK);
      }
    } else if (!shadeFlags.round) {   // rounded build: ONE central pylon (below) carries the wing
      for (const s of [-1, 1]) {
        addSpan(out, { z: -1.98, x: s*0.14, y: 0.46, w: 0.05, h: 0.13 },
                     { z: -2.34, x: s*0.14, y: epCY + 0.01, w: 0.042, h: 0.10 }, DARK);
      }
    }
    if (shadeFlags.round) CarShade.strut(out, [0, 0.44, -1.96], [0, upperTrailY - 0.255, -2.40], 0.14, 0.06, DARK, addTri, null, { taper: 0.75, n: 10 }); else addSpan(out, { z: -1.96, x: 0, y: 0.44, w: 0.09, h: 0.14 },
                 { z: -2.36, x: 0, y: epCY, w: 0.07, h: 0.10 }, DARK);   // central spine mount (rounded: a lens pylon ending in the main plane)
    const aTvane = aeroStyle && aeroStyle.tvane != null
      ? (aeroStyle.tvane ? 1 : 0) : (aLvl >= 4 && !aDrs ? 1 : 0);
    if (aTvane) {
      addWingFoil(out, {
        zLead: -1.935, yLead: epCY + 0.188, zTrail: -2.025, yTrail: epCY + 0.212,
        half: 0.17, thick: 0.014, taper: 0.90, sweep: 0.018, rise: 0.006,
      }, rearC, wingSurf);
      addBox(out, 0, (0.56 + epCY + 0.19) / 2, -1.98, 0.03, epCY + 0.19 - 0.56, 0.025, DARK);
    }
    if (aBeam) {
      // Prominent beam wing slung low under the main plane, spanning the crash structure.
      rearWing(-2.36, 0.64 + rwLift * 0.4, -2.58, 0.68 + rwLift * 0.4,
        0.46, 0.022, c1, 0.65);
    }
    if (aDrs) {
      // Active-aero DRS: an extra open slot flap proud of the top flap.
      rearWing(-2.44, crownY - 0.050, -2.60, crownY, 0.49, 0.016, rearC, 1.15);
    }
    const drsSX = aLvl >= 3 ? 0.16 : 0.13;
    // DRS actuator pod + the slot-gap rail it sits on. The pod used to be a
    // 5 cm brick lost on the crown; a taller raked housing and a carbon
    // strip under the top flap make the mechanism (and the open slot) read
    // from wingRear.
    addSpan(out, { z: -2.40, x: 0, y: epCY + 0.268, w: drsSX, h: 0.070, t: 0.70 },
                 { z: -2.62, x: 0, y: epCY + 0.292, w: drsSX * 0.72, h: 0.048, t: 0.50 },
            DARK);
    addBox(out, 0, epCY + 0.236, -2.50, 0.42, 0.010, 0.20, CARBON, SURFACES.carbon);

    // Lamp above tip centreline so stock/megaphone mouth rim stays visible.
    const tipR = exhTipRForLamp, lampY = 0.545;
    const lampW = Math.min(0.042, tipR * 0.70), lampH = Math.min(0.052, tipR * 0.85);
    addSpan(out, { z: -2.47, x: 0, y: lampY, w: 0.14, h: 0.16, t: 0.78 },
                 { z: -2.57, x: 0, y: lampY, w: 0.115, h: 0.13, t: 0.62 }, DARK);
    addBox(out, 0, lampY, -2.585, lampW * 1.15, lampH * 1.10, 0.034,
           [1.55, 0.16, 0.11], SURFACES.emissive);
    addBox(out, 0, lampY, -2.60, lampW * 0.38, lampH * 0.36, 0.016,
           [1.85, 0.18, 0.10], SURFACES.emissive);   // rain-light core (bloom-capped)

    const diffW  = (0.72 + aLvl * 0.145) * Math.max(0.78, Math.min(1.3, aeroStyle.floorEdge));
    const diffH1 = (0.40 + aLvl * 0.325) *
      Math.max(0.72, Math.min(1.4, aeroStyle.diffuserRise));
    // THE DIFFUSER. This was one closed loft, and from directly behind — the
    // view a chase camera holds for most of a lap — it read as a featureless
    // grey slab the full width of the car with the brake light floating on it.
    // The diffuser is the most
    // recognisable thing about the back of an F1 car and none of it was there.
    // Built as two tunnels either side of the crash structure: a ramped
    // ceiling, an outer wall, strakes, and a gurney across the trailing edge.
    // Every piece is a thin CLOSED solid rather than an open quad, so the
    // winding cannot come out inside-out on a surface you only ever see from
    // one side. Both knobs still drive it — floorEdge the width, diffuserRise
    // the ceiling — so the sweep's amplitude for them goes up, not down.
    const dHalf = Math.min(CAR_HALF - 0.04, 0.56 * diffW);   // half-width at the exit
    const dThr  = 0.46 * diffW;                    // half-width at the throat
    const dKeel = 0.12;                            // crash structure half-width
    const dFloor = 0.105;
    const dRise = 0.30 * Math.max(0.72, Math.min(1.4, aeroStyle.diffuserRise));
    const yCE = dFloor + dRise, yCT = dFloor + 0.055 * diffH1 / 0.4;
    const DIFF_IN: Vec3 = [0.045, 0.045, 0.055];
    for (const s of [-1, 1]) {
      const cxE = s * (dKeel + dHalf) / 2, cxT = s * (dKeel + dThr) / 2;
      const wE = dHalf - dKeel, wT = dThr - dKeel;
      if (shadeFlags.round) CarShade.tunnel(out, s, dKeel, dThr, dHalf, dFloor, yCT, yCE, DIFF_IN, CARBON, addTri, SURFACES.carbon); else addLoft(out, -2.52, cxE, yCE, wE, 0.035, -1.95, cxT, yCT, wT, 0.035,
              DIFF_IN, SURFACES.carbon);                              // ramped ceiling (rounded: ceiling + wall as one curved shell)
      if (!shadeFlags.round) addLoft(out, -2.52, s * dHalf, (dFloor + yCE) / 2, 0.030, yCE - dFloor,
                   -1.95, s * dThr,  (dFloor + yCT) / 2, 0.030, yCT - dFloor,
              CARBON, SURFACES.carbon);                               // outer wall
      addBox(out, cxE, dFloor, -2.235, wE, 0.028, 0.57, CARBON, SURFACES.carbon);
      for (let k = 0; k < 3; k++) {
        const f = 0.22 + k * 0.28;
        addLoft(out, -2.50, s * (dKeel + wE * f), (dFloor + yCE) / 2, 0.028, (yCE - dFloor) * 0.90,
                     -2.02, s * (dKeel + wT * f), (dFloor + yCT) / 2, 0.022, (yCT - dFloor) * 0.90,
                DIFF_IN, SURFACES.carbon);                            // strake
      }
    }
    addLoft(out, -2.58, 0, 0.195, 2 * dKeel * 0.82, 0.15,
                 -1.95, 0, 0.170, 2 * dKeel * 1.10, 0.13, DARK, SURFACES.carbon);
    addBox(out, 0, yCE + 0.030, -2.525, 2 * dHalf, 0.030, 0.020, rearC, wingSurf);

    const gbStrakes = gbStyle ? gbStyle.strakes : (tier("gearbox") === 2 ? 5 : 0);
    const gbFin = gbStyle ? gbStyle.fin : (tier("gearbox") === 2 ? 1 : 0);
    const gbStrakeH = gbStyle && gbStyle.strakeH ? gbStyle.strakeH : 0.13;
    const gbCasing  = gbStyle ? (gbStyle.casing  || 0) : (tier("gearbox") === 2 ? 3 : 0);
    const gbLouvres = gbStyle ? (gbStyle.louvres || 0) : 0;
    const gbHeat    = gbStyle ? (gbStyle.heat    || 0) : 0;
    const gbFinSY   = gbStyle && gbStyle.finSY ? gbStyle.finSY : 0.14;
    const gbFinSZ   = gbStyle && gbStyle.finSZ ? gbStyle.finSZ : 0.28;
    const gbHeatFins = gbStyle ? Math.max(0, Math.min(5, Math.round(gbStyle.heatFins || 0))) : 0;
    const gbRibs     = gbStyle ? Math.max(0, Math.min(3, Math.round(gbStyle.ribs || 0))) : 0;
    const gbCaseWmul = Math.max(0.75, Math.min(1.35, (gbStyle && gbStyle.caseWidth) || 1));
    if (gbStrakes > 0) {
      const half = (gbStrakes - 1) / 2;
      for (let i = 0; i < gbStrakes; i++) {
        addBox(out, (i - half) * 0.24, 0.13 + gbStrakeH / 2, -2.20, 0.015, gbStrakeH, 0.42, CARBON);
      }
    }
    let gbCw = 0, gbCh = 0;
    if (gbCasing > 0) {
      gbCw = (0.15 + gbCasing * 0.05) * gbCaseWmul;
      gbCh = 0.13 + gbCasing * 0.03;
      addBox(out, 0, 0.44, -1.92, gbCw * 1.08, gbCh * 1.12, 0.04, CARBON, SURFACES.carbon);
      addSpan(out,
        { z: -1.94, y: 0.44, w: gbCw * 1.02, h: gbCh, t: 0.90 },
        { z: -2.12, y: 0.435, w: gbCw, h: gbCh * 0.96, t: 0.88 },
        CARBON, null, SURFACES.carbon);
      if (gbCasing >= 2) {
        addSpan(out,
          { z: -2.12, y: 0.42, w: gbCw * 0.92, h: gbCh * 0.82, t: 0.88 },
          { z: -2.26, y: 0.40, w: gbCw * 0.58, h: gbCh * 0.62, t: 0.85 },
          DARK, null, SURFACES.carbon);
      }
      if (gbCasing >= 3) {
        for (const s of [-1, 1]) {
          addBox(out, s * (gbCw * 0.5 + 0.012), 0.44, -2.04, 0.02, gbCh * 0.9, 0.22,
                 [0.09, 0.09, 0.10], SURFACES.carbon);
          addBox(out, s * (gbCw * 0.42), 0.32, -2.00, 0.04, 0.05, 0.10, DARK);
        }
      }
    }
    if (gbRibs > 0) {
      const ribW = gbCasing > 0 ? gbCw * 0.48 : 0.16;
      const ribH = gbCasing > 0 ? gbCh * 0.72 : 0.10;
      for (const s of [-1, 1]) for (let i = 0; i < gbRibs; i++) {
        addBox(out, s * ribW, 0.44, -1.96 - i * 0.07,
               0.012, ribH, 0.04, CARBON, SURFACES.carbon);
      }
    }
    if (gbLouvres > 0) {
      const hx = gbCasing > 0 ? (gbCw * 0.5 + 0.018) : 0.135;
      for (const s of [-1, 1]) for (let i = 0; i < gbLouvres; i++) {
        const y = 0.52 - i * 0.038;
        addBox(out, s * hx, y, -2.02, 0.028, 0.012, 0.18, INTAKE);
        addBox(out, s * (hx + 0.012), y + 0.008, -2.00, 0.012, 0.008, 0.16, CARBON);
      }
    }
    if (gbHeat) {
      const hw = gbCasing > 0 ? Math.max(0.16, gbCw * 0.88) : 0.19;
      addBox(out, 0, 0.55, -2.06, hw, 0.014, 0.28, [0.30, 0.30, 0.34], SURFACES.metal);
    }
    if (gbHeatFins > 0) {
      const half = (gbHeatFins - 1) / 2;
      const span = gbCasing > 0 ? Math.max(0.12, gbCw * 0.70) : 0.14;
      const step = gbHeatFins > 1 ? span / (gbHeatFins - 1) : 0;
      for (let i = 0; i < gbHeatFins; i++) {
        addBox(out, (i - half) * step, 0.575, -2.06, 0.010, 0.045, 0.22,
               [0.30, 0.30, 0.34], SURFACES.metal);
      }
    }
    if (gbFin) addBox(out, 0, 0.27 + gbFinSY / 2, -2.30, 0.02, gbFinSY, gbFinSZ, CARBON);
  }

  part("brakeDucts");
  const brakesT = tier("brakes");
  const ductMul = brakeStyle ? brakeStyle.duct : (brakesT === 0 ? 0.5 : brakesT === 2 ? 1.9 : 1.0);
  const brakeScoop = Math.max(0, Math.min(2, Math.round(
    brakeStyle && brakeStyle.scoop != null ? brakeStyle.scoop : (ductMul >= 1.3 ? 1 : 0))));
  for (const s of [-1, 1]) {
    (shadeFlags.round ? CarShade.boxFn(addTri, { r: 0.028 }) : addBox)(out, s*0.60, 0.28, AXLES.frontZ + 0.19, 0.06, 0.20 * ductMul, 0.13 * ductMul, DARK);   // rounded: a stadium section
    // The duct was a plain prism with no MOUTH — the same flat-dark-face
    // defect the radiator inlet had, and addInletMouth() was written for it
    // this session and never applied here. No lip: a brake duct's leading
    // edge is a knife, not a flange, and the lip bars are what make the
    // helper dear.
    // Not in the COCKPIT build: from the seat the front ducts are behind the
    // wheels and outside the visor, so 120 triangles of throat would render
    // where nothing can look at them — and the cockpit ceiling is the tighter
    // of the two.
    if (!ckpt) addInletMouth(out, s * 0.60, 0.28, AXLES.frontZ + 0.19 + 0.065 * ductMul,
                             0.05, 0.15 * ductMul, DARK, 0.045 * ductMul, 0);
    // Big-brake spec: a horizontal duct winglet scooping over each front wheel.
    if (brakeScoop >= 1) addBox(out, s*0.65, 0.42, AXLES.frontZ + 0.16, 0.11, 0.02, 0.15, CARBON);
    if (brakeScoop >= 1) {
      addBox(out, s*0.65, 0.355, AXLES.frontZ + 0.22, 0.08, 0.055, 0.04, INTAKE);
      addBox(out, s*0.65, 0.395, AXLES.frontZ + 0.245, 0.09, 0.012, 0.03, CARBON);
      addBox(out, s*0.65, 0.315, AXLES.frontZ + 0.245, 0.09, 0.012, 0.03, CARBON);
    }
    if (brakeScoop >= 2) {
      addBox(out, s*0.705, 0.38, AXLES.frontZ + 0.15, 0.014, 0.12, 0.17, CARBON);
      addBox(out, s*0.655, 0.20, AXLES.frontZ + 0.11, 0.10, 0.016, 0.20, CARBON);
      addBox(out, s*0.595, 0.32, AXLES.frontZ + 0.14, 0.014, 0.10, 0.16, CARBON);
    }
    if (!ckpt) (shadeFlags.round ? CarShade.boxFn(addTri, { r: 0.028 }) : addBox)(out, s*0.58, 0.30, AXLES.rearZ - 0.20, 0.06, 0.18 * ductMul, 0.12 * ductMul, DARK);
    if (brakeScoop >= 1 && !ckpt) {
      addBox(out, s*0.58, 0.355, AXLES.rearZ - 0.275, 0.07, 0.040, 0.045, INTAKE);
      addBox(out, s*0.58, 0.385, AXLES.rearZ - 0.295, 0.08, 0.010, 0.028, CARBON);
    }
  }

  part("suspension");
  const wbMul = suspStyle ? suspStyle.arm : (suspT === 0 ? 0.85 : suspT === 2 ? 1.3 : 1.0);
  const wbPush = suspStyle ? suspStyle.push : (suspT === 2 ? 1 : 0);
  const wbPull = suspStyle && suspStyle.pull ? 1 : 0;
  const armTh = 0.026 * wbMul, suspC: Vec3 = [0.11, 0.11, 0.13];
  const rockerLvl = Math.max(0, Math.min(2, Math.round(suspStyle.rocker || 0)));
  const heaveOn = Math.max(0, Math.min(1, Math.round(suspStyle.heave || 0)));
  const fairArms = !!(wbPush || wbPull || rockerLvl || heaveOn);
  const drawArm = fairArms ? addFairedArm : shadeFlags.round ? (o: MeshOut, a: Vec3, b: Vec3, th: number, c: Vec3, sf?: number | null) => CarShade.strut(o, a, b, th * 1.9, th * 0.62, c, addTri, sf, { n: 6 }) : addBeamBetween;   // rounded: a lens section
  // Inboard damper barrel + rocker link, the mechanism a real tub carries
  // under its blister. Gated on the existing `rocker` knob, so the default
  // car (rocker 0) is untouched and only fitted suspension gains hardware.
  function suspHardware(y: number, px: number): void {
    for (const sd of [-1, 1]) {
      addBox(out, sd * px, y + 0.020, 1.02, 0.030, 0.030, 0.115,
             [0.30, 0.30, 0.34], SURFACES.metal);            // damper barrel
      addBox(out, sd * px, y + 0.020, 0.955, 0.022, 0.022, 0.028,
             [0.55, 0.52, 0.20], SURFACES.metal);            // spring collar
      addBeamBetween(out, [sd * px, y + 0.020, 1.08], [sd * (px + 0.055), y - 0.012, 1.13],
                     0.013, suspC, SURFACES.carbon);          // rocker link
    }
  }
  if (rockerLvl === 1) {
    for (const s of [-1, 1]) {
      addLoft(out, 0.88, s * 0.11, 0.545 + rideDY, 0.10, 0.036,
              1.12, s * 0.09, 0.530 + rideDY, 0.08, 0.028, CARBON);
    }
    addBeamBetween(out, [-0.10, 0.545 + rideDY, 0.98],
      [0.10, 0.545 + rideDY, 0.98], 0.016, suspC, SURFACES.carbon);
    suspHardware(0.545 + rideDY, 0.11);
  } else if (rockerLvl === 2) {
    addLoft(out, 0.72, 0, 0.555 + rideDY, 0.28, 0.050,
            1.18, 0, 0.515 + rideDY, 0.22, 0.038, CARBON);
    for (const s of [-1, 1]) {
      addBox(out, s * 0.075, 0.590 + rideDY, 0.94, 0.028, 0.055, 0.055,
             [0.24, 0.24, 0.27], SURFACES.metal);
      addBox(out, s * 0.12, 0.568 + rideDY, 0.96, 0.055, 0.012, 0.08,
             CARBON, SURFACES.carbon);
    }
    suspHardware(0.575 + rideDY, 0.075);
    if (!ckpt) {
      addLoft(out, -1.38, 0, 0.520 + rideDY, 0.18, 0.042,
              -1.14, 0, 0.500 + rideDY, 0.14, 0.032, CARBON);
    }
  }
  if (heaveOn) {
    const hy = 0.562 + rideDY, hz = 0.99;
    addBox(out, 0, hy, hz, 0.20, 0.030, 0.030,
           [0.26, 0.26, 0.29], SURFACES.metal);
    addBox(out, 0, hy + 0.020, hz - 0.038, 0.09, 0.024, 0.050,
           CARBON, SURFACES.carbon);
    for (const s of [-1, 1]) {
      const px = rockerLvl === 2 ? 0.075 : rockerLvl === 1 ? 0.11 : 0.18;
      const py = (rockerLvl === 2 ? 0.575 : rockerLvl === 1 ? 0.545 : 0.505) + rideDY;
      const pz = rockerLvl === 2 ? 0.94 : 0.98;
      addBeamBetween(out, [s * 0.09, hy, hz], [s * px, py, pz],
                     armTh * 0.5, suspC, SURFACES.carbon);
    }
  }
  const wishboneSpread = 0.20 * Math.max(0.72, Math.min(1.3, suspStyle.wishbone));
  const toeScale = Math.max(0.7, Math.min(1.35, suspStyle.toe));
  // INBOARD PICKUPS. Every arm on the car started at a hardcoded x 0.29-0.33
  // while the bodywork it bolts to is far narrower at the axle stations: the
  // nose flank measures x 0.19-0.21 at the front axle and the engine cover
  // 0.15-0.17 at the rear, so the wishbones, track rods and pushrods all
  // began 0.10-0.16 m outboard of the chassis, floating in clear air with a
  // visible gap between arm root and body from any three-quarter camera.
  // Sample the SAME anchors the bodywork lofts from — the arms then follow a
  // team's nose style and an engine's tailWidth instead of ignoring both.
  const inNose = (z: number): number => anchors.noseAt(z).side - 0.012;
  const inTail = (z: number): number => Math.max(0.14, anchors.coverAt(z).x - 0.012);
  for (const s of [-1, 1]) {
    // Wishbone PLANE SPREAD. 0.27/0.43 put the two pickups 160 mm apart on an
    // upright that lives inside a 462 mm rim (rimR = 0.68 x 0.34): a real
    // upright uses nearly the whole rim, lower joint low in the wheel and
    // upper joint high, which is what gives an F1 front end its splayed-V
    // silhouette. 0.22/0.47 is a 250 mm spread, still 50 mm clear of the rim
    // at each end. The upright casting below grows to span it.
    const fLower: Vec3 = [s*0.69, 0.22 + rideDY, AXLES.frontZ];
    const fUpper: Vec3 = [s*0.69, 0.47 + rideDY, AXLES.frontZ];
    const fLowZ = [AXLES.frontZ - wishboneSpread, AXLES.frontZ + wishboneSpread] as const;
    for (const z of fLowZ) {
      drawArm(out, [s*inNose(z), 0.225 + rideDY, z], fLower, armTh, suspC, SURFACES.carbon);
      drawArm(out, [s*inNose(z), 0.42 + rideDY, z], fUpper, armTh, suspC, SURFACES.carbon);
    }
    if (fairArms) {
      addWishboneWeb(out, [s*inNose(fLowZ[0]), 0.225 + rideDY, fLowZ[0]],
        [s*inNose(fLowZ[1]), 0.225 + rideDY, fLowZ[1]], fLower, suspC, SURFACES.carbon);
      addWishboneWeb(out, [s*inNose(fLowZ[0]), 0.42 + rideDY, fLowZ[0]],
        [s*inNose(fLowZ[1]), 0.42 + rideDY, fLowZ[1]], fUpper, suspC, SURFACES.carbon);
    }
    drawArm(out, [s*inNose(AXLES.frontZ - 0.16), 0.34 + rideDY, AXLES.frontZ - 0.16],
      [s*0.69, 0.35 + rideDY, AXLES.frontZ - 0.04*toeScale],
      armTh*0.72*toeScale, suspC, SURFACES.carbon);
    // An upright is a CASTING: wide at the lower wishbone pickup, narrow at
    // the top. `addSpan` with a tapered front frame is the same 12 triangles
    // as the cube it replaces.
    addSpan(out, { z: AXLES.frontZ + 0.05, x: s * 0.69, y: 0.345 + rideDY, w: 0.055, h: 0.29, t: 0.55 },
                 { z: AXLES.frontZ - 0.05, x: s * 0.69, y: 0.345 + rideDY, w: 0.048, h: 0.27, t: 0.62 },
            [0.18, 0.18, 0.20], null, SURFACES.metal);
    if (wbPush) {
      const outer = wbPull ? fUpper : fLower;
      const iX = inNose(AXLES.frontZ - 0.05);
      const inner: Vec3 = wbPull ? [s*iX,0.20+rideDY,AXLES.frontZ-0.05]
        : [s*iX,0.455+rideDY,AXLES.frontZ-0.05];
      drawArm(out, outer, inner, armTh*0.82, suspC, SURFACES.carbon);
    }
    if (!ckpt) {
      const rLower: Vec3 = [s*0.67, 0.235 + rideDY, AXLES.rearZ];
      const rUpper: Vec3 = [s*0.67, 0.485 + rideDY, AXLES.rearZ];
      const rLowZ = [AXLES.rearZ - wishboneSpread*0.9, AXLES.rearZ + wishboneSpread*0.9] as const;
      for (const z of rLowZ) {
        drawArm(out, [s*inTail(z), 0.25 + rideDY, z], rLower, armTh, suspC, SURFACES.carbon);
        drawArm(out, [s*inTail(z), 0.47 + rideDY, z], rUpper, armTh, suspC, SURFACES.carbon);
      }
      if (fairArms) {
        addWishboneWeb(out, [s*inTail(rLowZ[0]), 0.25 + rideDY, rLowZ[0]],
          [s*inTail(rLowZ[1]), 0.25 + rideDY, rLowZ[1]], rLower, suspC, SURFACES.carbon);
        addWishboneWeb(out, [s*inTail(rLowZ[0]), 0.47 + rideDY, rLowZ[0]],
          [s*inTail(rLowZ[1]), 0.47 + rideDY, rLowZ[1]], rUpper, suspC, SURFACES.carbon);
      }
      drawArm(out, [s*inTail(AXLES.rearZ + 0.16), 0.36 + rideDY, AXLES.rearZ + 0.16],
        [s*0.67, 0.36 + rideDY, AXLES.rearZ + 0.04*toeScale],
        armTh*0.72*toeScale, suspC, SURFACES.carbon);
      addSpan(out, { z: AXLES.rearZ + 0.05, x: s * 0.67, y: 0.36 + rideDY, w: 0.055, h: 0.29, t: 0.55 },
                   { z: AXLES.rearZ - 0.05, x: s * 0.67, y: 0.36 + rideDY, w: 0.048, h: 0.27, t: 0.62 },
              [0.18, 0.18, 0.20], null, SURFACES.metal);
      if (wbPush) {
        const outer = wbPull ? rUpper : rLower;
        const iX = inTail(AXLES.rearZ + 0.04);
        const inner: Vec3 = wbPull ? [s*iX,0.22+rideDY,AXLES.rearZ+0.04]
          : [s*iX,0.53+rideDY,AXLES.rearZ+0.04];
        drawArm(out, outer, inner, armTh*0.82, suspC, SURFACES.carbon);
      }
      // DRIVESHAFT. Nothing spanned gearbox to upright, so from directly
      // behind — a chase camera's view for most of a lap — the rear wheels
      // floated with clear air where the drive is. Sits on the axle line at
      // upright height, with a CV boot at each end; six sides because it is
      // small and half-hidden behind the tyre from every angle but dead
      // astern, which is the one angle that matters here.
      addTube(out, [[s * 0.155, 0.36 + rideDY, AXLES.rearZ],
                    [s * 0.605, 0.36 + rideDY, AXLES.rearZ]],
              0.032, 6, [0.22, 0.22, 0.25], SURFACES.metal);
      for (const bx of [0.185, 0.575])
        addBox(out, s * bx, 0.36 + rideDY, AXLES.rearZ, 0.052, 0.062, 0.062,
               [0.10, 0.10, 0.12], SURFACES.carbon);   // CV boot
    }
  }

  part("wheels");
  if (!noWheels) {
    const tyreBand = tyreStyle && tyreStyle.band || TYRE_BAND[tier("tyres") as 0 | 1 | 2];
    // Per-option caliper accent peeking through the rim spokes, else tier.
    const wt = CarWheels.tints(liv);   // livery rimTint / caliperTint override the brakes catalog (unset = null)
    const caliperColor = wt.cal || (brakeStyle ? brakeStyle.cal : BRAKE_CALIPER[brakesT as 0 | 1 | 2]);
    const rimColor = wt.rim || (brakeStyle && brakeStyle.rim);   // premium alloy rims (else default dark)
    for (const s of [-1, 1]) {
      addWheel(out, s*0.79, AXLES.wheelY, AXLES.frontZ, 0.34, 0.32,
        tyreBand, caliperColor, rimColor, false, tyreStyle, null, brakeStyle, wheelStyle, wt.ink);
      addWheel(out, s*0.76, AXLES.wheelY, AXLES.rearZ, 0.34, 0.38,
        tyreBand, caliperColor, rimColor, false, tyreStyle, null, brakeStyle, wheelStyle, wt.ink);
    }
  }
  // Fixed deflectors belong to the chassis, including the split race body.
  // 2026 over-wheel deflector above each FRONT wheel (tyre crown y 0.68):
  // 0 none / 1 single plane on a stalk / 2 biplane + outboard endplate.
  const wDefl = Math.max(0, Math.min(2, Math.round((wheelStyle && wheelStyle.deflector) || 0)));
  if (wDefl > 0) {
    for (const s of [-1, 1]) {
      addBeveledSpan(out,
        { z: AXLES.frontZ + 0.20, x: s * 0.79, y: 0.745, w: 0.30, h: 0.012, t: 0.70 },
        { z: AXLES.frontZ - 0.16, x: s * 0.77, y: 0.775, w: 0.26, h: 0.010, t: 0.70 },
        0.004, CARBON, null, SURFACES.carbon);
      addBeamBetween(out, [s * 0.66, 0.46, AXLES.frontZ + 0.17],
                          [s * 0.72, 0.740, AXLES.frontZ + 0.16], 0.016,
                     [0.11, 0.11, 0.13], SURFACES.carbon);
      if (wDefl >= 2) {
        addBeveledSpan(out,
          { z: AXLES.frontZ + 0.14, x: s * 0.80, y: 0.805, w: 0.24, h: 0.010, t: 0.70 },
          { z: AXLES.frontZ - 0.12, x: s * 0.78, y: 0.828, w: 0.20, h: 0.009, t: 0.70 },
          0.004, CARBON, null, SURFACES.carbon);
        addBox(out, s * 0.935, 0.775, AXLES.frontZ + 0.02, 0.012, 0.085, 0.30,
               CARBON, SURFACES.carbon);
      }
    }
  }

  if (sections.length) sections[sections.length - 1]!.to = out.pos.length / 3;
  CarMaterials.applyFinish(out, liv.finish, sections, liv);

  shadeFlags.round = false;
  shadeFlags.coverHi = true;
  if (shade && !sil) CarShade.smooth(out, { skip: [SURFACES.emissive] });   // a shadow caster keeps the shape; depth never reads normals
  // Measure each closed section from the vertices it emitted.
  if (opts && opts.measure) out.parts = sections.filter((sec) => sec.to > sec.from).map((sec) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity,
        z0 = Infinity, z1 = -Infinity;
    const P = out.pos;
    for (let i = sec.from * 3; i < sec.to * 3; i += 3) {
      if (P[i]! < x0) x0 = P[i]!; if (P[i]! > x1) x1 = P[i]!;
      if (P[i + 1]! < y0) y0 = P[i + 1]!; if (P[i + 1]! > y1) y1 = P[i + 1]!;
      if (P[i + 2]! < z0) z0 = P[i + 2]!; if (P[i + 2]! > z1) z1 = P[i + 2]!;
    }
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    return { name: sec.name, vertices: sec.to - sec.from,
             sizeM: [r2(x1 - x0), r2(y1 - y0), r2(z1 - z0)] as [number, number, number],
             centreM: [r2((x0 + x1) / 2), r2((y0 + y1) / 2), r2((z0 + z1) / 2)] as [number, number, number],
             boundsZ: [r2(z0), r2(z1)] as [number, number] };
  });
  return out;
}

// car3d.js:2175
export function buildComplete(color?: Vec3 | null, color2?: Vec3 | null, opts?: BuildOptions | null): CarMesh {
  const out = build(color, color2, opts);
  const info = out.flapInfo;
  if (!info) return out;
  for (const el of aeroFlapsGeom(info.aLvl, info.style)) {
    // The livery finish rides flapInfo: build()'s own paint->finish remap
    // runs before these flaps are appended, so without it a satin/chrome
    // car got gloss top flaps from this path.
    const g = buildFlapGeom(el, info.col, info.finish, info.surface);
    const base = out.pos.length / 3;
    for (let i = 0; i < g.pos.length; i += 3) {
      // delta 0: undo only the hinge translation buildFlapGeom applied.
      out.pos.push(g.pos[i]!, g.pos[i + 1]! + el.y, g.pos[i + 2]! + el.z);
      out.nrm.push(g.nrm[i]!, g.nrm[i + 1]!, g.nrm[i + 2]!);
      out.col.push(g.col[i]!, g.col[i + 1]!, g.col[i + 2]!);
    }
    if (g.mat) for (const m of g.mat) out.mat.push(m);
    for (const k of g.idx) out.idx.push(base + k);
  }
  return out;
}

export { buildWheel, buildWheelLayers, bodyAnchors };

// car3d.js:2206
export const Car3D = Object.freeze({
  build, buildComplete, buildWheel, buildWheelLayers, bodyAnchors, SURFACES, FINISH_SURFACE,
  PANEL_COL: PANEL,
  TYRE_BAND, BRAKE_CALIPER, AXLES, CHASSIS,
  TEAM_STYLE, teamStyleOf,
  endplate: endplateGeom, numberBoard, frontPlate: frontPlateGeom,
  wingBand: wingBandGeom,
  aeroFlaps: aeroFlapsGeom, aeroFlapAim, buildFlapGeom,
  sharkFin: FIN, sharkFinPanel, sharkFinBadge, sharkFinRoot, FIN_SHAPES, FIN_SHAPE_IDS,
  TCAM_IDS, COVER_VENT_IDS, mirrorLightAnchors, cockpitMirrorGlass, SPINE_HEIGHT_IDS, spineRise,
  coverProfile, coverFlankX, coverSurfaceY, COVER_STACK,
  aeroLevelOf, aeroStyleOf,
});
export type Car3DApi = typeof Car3D;
