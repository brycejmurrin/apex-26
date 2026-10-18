// Car body geometry builders (wings, fins, chassis, pods, cover, part recipes).
// create() receives palette + mesh primitives + chassis datums from Car3D.
// Ported verbatim from f1-game js/car/car-body-geom.js:6-1420 (itself a pure move out of
// car3d.js). The CarShade / CarMaterials globals are module imports here.
import type { CarGeometry, Station } from "./geometry";
import { applyFinish, type Surfaces } from "./materials";
import { CarShade } from "./shade";
import type { MeshOut, MVec3, Vec3 } from "./types";

// ---------------------------------------------------------------------------
// Types that cross the module boundary (car3d.ts builds and reads these).
// ---------------------------------------------------------------------------

/** Category-neutral wheel datums (car3d.js:13). */
export interface Axles { readonly frontZ: number; readonly rearZ: number; readonly wheelY: number }

/** The floor box (car3d.js:15). */
export interface ChassisFloor {
  readonly cx: number; readonly cy: number; readonly cz: number;
  readonly sx: number; readonly sy: number; readonly sz: number;
}

/** A body loft station as CHASSIS stores it (car3d.js:29). */
export interface ChassisStation {
  readonly z: number; readonly y: number; readonly w: number; readonly h: number; readonly t: number;
}

/** CHASSIS (car3d.js:14-41). */
export interface Chassis {
  readonly floor: ChassisFloor;
  readonly nose: readonly [ChassisStation, ChassisStation, ChassisStation];
  readonly monocoque: readonly [ChassisStation, ChassisStation];
  readonly cockpit: readonly [ChassisStation, ChassisStation];
}

/** Front-wing cascade recipe (car3d.js:43 DEFAULT_WING). */
export interface WingStyle {
  readonly flaps: number; readonly arch: number; readonly twist: number; readonly teCurve: number;
  readonly chordTaper: number; readonly foot: number; readonly canard: number; readonly tipRise: number;
}

/** Per-team chassis relief (car3d.js:45 DEFAULT_STYLE / :54 TEAM_STYLE). */
export interface TeamStyle {
  readonly noseTipZ: number; readonly noseSlim: number; readonly noseDroop: number;
  readonly airbox: number; readonly fin: number; readonly mirror: number; readonly inlet: number;
  readonly wingStyle: WingStyle;
  readonly inletH: number; readonly inletW: number; readonly undercutD: number; readonly waist: number;
  readonly floorStep: number; readonly coverCrown: number;
}

/** What car3d.js:106-110 hands CarBodyGeom.create. */
export interface BodyGeomContext {
  SURFACES: Surfaces;
  CARBON: Vec3; DARK: Vec3; INTAKE: Vec3; PANEL: Vec3;
  TYRE_BAND: Readonly<Record<number, Vec3>>;
  BRAKE_CALIPER: Readonly<Record<number, Vec3 | null>>;
  AXLES: Axles;
  CHASSIS: Chassis;
  DEFAULT_STYLE: TeamStyle;
  DEFAULT_WING: WingStyle;
  TEAM_STYLE: Readonly<Record<string, TeamStyle>>;
  teamStyleOf: (teamId?: string | null) => TeamStyle;
  geometry: CarGeometry;
  /** Owned by Car3D.build: mutated for one build, then reset (car3d.js:129). */
  shadeFlags: { round: boolean; coverHi: boolean };
}

/** The wing-shape fields wingFoilOf / flapSig read off a style or a wing recipe. */
export interface WingFields {
  flaps?: number | undefined;
  twist?: number | undefined;
  teCurve?: number | undefined;
  chordTaper?: number | undefined;
  tipRise?: number | undefined;
}
/** Anything wingOf / wingFoilOf accept: a team style, an aero style, or a wing recipe. */
export interface WingSource extends WingFields {
  wingStyle?: WingStyle | null | undefined;
}

/** An aero recipe as the wing builders read it (car-body-geom.js:93 AERO_STYLE_DEF). */
export interface AeroStyle extends WingSource {
  frontSweep: number; frontTaper: number; frontRise: number;
  rearSweep: number; rearTaper: number;
  drs?: number | undefined;
  fin?: number | undefined;
  plate?: number | null | undefined;
}
/** Style argument: f1-game guards against non-objects (a tier number) at runtime. */
export type AeroStyleArg = AeroStyle | number | null | undefined;

/** [zLead, yLead, zTrail, yTrail, spanFrac, thick] (car-body-geom.js:106). */
export type CascadeElem = [number, number, number, number, number, number];

export interface EndplateProfile { z: number; cy: number; sy: number; bottom: number; top: number }
export interface EndplateGeom { cy: number; sy: number; chord: number; front: EndplateProfile; rear: EndplateProfile }
export interface WingFoilExtra { twist: number; teCurve: number; chordTaper: number; tipRise: number }

export interface FrontPlateProfile {
  hF: number; hR: number; kick: number; footW: number; footZ: number; arch: number; roll?: number;
}
export interface FrontPlateGeom {
  P: FrontPlateProfile; w: number; kick: number;
  front: { z: number; x: number; y: number; h: number; t: number };
  rear: { z: number; x: number; y: number; h: number; t: number };
}

/** An element record for the flap pose solve (car-body-geom.js:274). */
export interface ElemRecord { chord: number; thick: number; hinge: number; natural: number; pz: number; py: number }
export interface ElemPose extends ElemRecord { zAngle: number; xAngle: number }
export interface ElemPoint { z: number; top: number; bot: number }

export type WingId = "front" | "rear";
/** Element planform handed to hinged() and carried on the flap record. */
export interface FlapPlanform {
  half: number; thick: number; taper: number; sweep: number; rise: number; attachHalf: number;
  upsweep?: { fwHalf: number; e: CascadeElem } | null;
  twist?: number | undefined; teCurve?: number | undefined; chordTaper?: number | undefined;
  hinge?: number | null | undefined;
}
/** A moveable wing element (car-body-geom.js:330). Shared via the memo: treat as immutable. */
export interface FlapElement extends FlapPlanform {
  id: string; wing: WingId;
  z: number; y: number;
  le: [number, number]; te: [number, number];
  chord: number; natural: number; hinge: number;
  zAngle: number; xAngle: number;
  cacheKey?: string;
}

export interface WingBandStation {
  x: number;
  front: { y: number; z: number };
  rear: { y: number; z: number };
  nrm: [number, number, number];
}
export interface WingBand { half: number; stations: WingBandStation[]; elem: string }

export interface FinShape {
  readonly baseLE: readonly [number, number]; readonly topLE: readonly [number, number];
  readonly topTE: readonly [number, number]; readonly baseTE: readonly [number, number];
  readonly halfBase: number; readonly halfTop: number;
  readonly step?: { readonly top: number; readonly baseTE: readonly [number, number] };
}
export interface FinRoot { bLE: number; bTE: number; dLE: number; dTE: number; top: number; clear: number }
export interface FinPoint { x: number; y: number; z: number }

/** A cover cross-section anchor (bodyAnchors coverAt). xb: the rounded build's pinched foot. */
export interface CoverSection { x: number; bottom: number; top: number; k?: number | undefined; xb?: number | undefined }
export interface CoverStation extends CoverSection { z: number }
export type Pt2 = [number, number];
export interface CoverProfile {
  x: number; bottom: number; top: number; shoulder: number; d: number;
  pts: readonly (readonly [number, number])[]; keys: Pt2[];
}

export interface MirrorAnchor { x: number; y: number; z: number }
/** Per side [inboard-low, outboard-low, outboard-high, inboard-high]. */
export type MirrorGlassQuads = MVec3[][];

// Part recipes (car-body-geom.js:864-969). Catalog `visual` recipes may carry extra keys.
export interface EngineParts {
  in: number; snork: number; twin: number; inlet: number; outlet: number;
  podWidth: number; shoulderHeight: number; undercut: number; coke: number; tailWidth: number; coverHeight: number;
  servicePanel: number; heatShield: number; chimney: number; scoopLip: number;
  [extra: string]: unknown;
}
export interface AeroParts extends AeroStyle {
  lvl: number; beam: number; drs: number; vane: number; plate: number;
  casc: number | null; swan: number; tvane: number | null;
  duct: number; board: number; slot: number;
  floorEdge: number; floorCut: number; diffuserRise: number; fin: number;
  [extra: string]: unknown;
}
export interface SuspensionParts {
  ride: number; arm: number; push: number; pull: number; wishbone: number; toe: number;
  rocker: number; heave: number;
  [extra: string]: unknown;
}
export interface BrakeParts {
  cal: Vec3 | null | undefined; duct: number; rim: Vec3 | null; caliperPos: number; coverOpen: number;
  rotor: number; rotorScale: number; scoop: number | null; discFace: number; caliper: number;
  [extra: string]: unknown;
}
export interface TyreParts { band: Vec3 | undefined; shoulder: number; sidewall: number; [extra: string]: unknown }
export interface ErsParts {
  led: Vec3 | null | undefined; pack: number; cells: number; conduit: number; blister: number; coolerIntake: number;
  [extra: string]: unknown;
}
export interface GearboxParts {
  strakes: number; fin: number; strakeH: number; finSY: number; finSZ: number;
  casing: number; louvres: number; heat: number; caseWidth: number; heatFins: number; ribs: number;
  [extra: string]: unknown;
}
export interface FuelParts {
  cap: [number, number, number]; flame: [number, number, number];
  line: number; filler: number; hatch: number; vent: number; breather: number;
  [extra: string]: unknown;
}
export interface ExhaustParts {
  pipes: number | null; bore: number; flare: number; wastegate: number; wrap: number; lip: number; shield: number;
  [extra: string]: unknown;
}
export interface FloorParts {
  fences: number; fenceH: number; skid: number; edgeLip: number; plank: number; gurney: number; scroll: number;
  [extra: string]: unknown;
}
export interface WheelParts {
  spokes: number; tape: number; dish: number; nut: Vec3 | null; gunNut: number; deflector: number;
  [extra: string]: unknown;
}
export interface CockpitParts {
  haloBlade: number; haloWing: number; camPods: number; screen: number; halo: number; headrest: number; mirror: number;
  [extra: string]: unknown;
}
export interface PartRecipes {
  engine: EngineParts; aero: AeroParts; suspension: SuspensionParts; brakes: BrakeParts;
  tyres: TyreParts; ers: ErsParts; gearbox: GearboxParts; fuel: FuelParts;
  exhaust: ExhaustParts; floor: FloorParts; cockpit: CockpitParts; wheels: WheelParts;
}
type Recipe<P> = Partial<P> | null | undefined;
export interface VisualRecipes {
  engine?: Recipe<EngineParts>; aero?: Recipe<AeroParts>; suspension?: Recipe<SuspensionParts>;
  brakes?: Recipe<BrakeParts>; tyres?: Recipe<TyreParts>; ers?: Recipe<ErsParts>;
  gearbox?: Recipe<GearboxParts>; fuel?: Recipe<FuelParts>; exhaust?: Recipe<ExhaustParts>;
  floor?: Recipe<FloorParts>; cockpit?: Recipe<CockpitParts>; wheels?: Recipe<WheelParts>;
}
/** Per-part visual tiers (0/1/2) plus optional catalog recipes (parts.js getVisualTiers). */
export interface PartsTiers {
  engine?: number | null | undefined; aero?: number | null | undefined; suspension?: number | null | undefined;
  brakes?: number | null | undefined; tyres?: number | null | undefined; ers?: number | null | undefined;
  gearbox?: number | null | undefined; fuel?: number | null | undefined;
  _visual?: VisualRecipes | null | undefined;
}
type TierId = "engine" | "aero" | "suspension" | "brakes" | "tyres" | "ers" | "gearbox" | "fuel";

/** Sidepod section (car-body-geom.js:1190). */
export interface PodStation {
  z: number; inner: number; outer: number;
  innerBottom: number; outerBottom: number; innerTop: number; outerTop: number;
}
export interface PodAnchor {
  z: number; x: number; inner: number; bottom: number; top: number; innerBottom: number; innerTop: number;
}
export interface NoseAnchor { z: number; side: number; topSide: number; bottom: number; top: number }
export interface BodyAnchors {
  key: string;
  podAt(z: number): PodAnchor;
  coverAt(z: number): CoverStation;
  noseAt(z: number): NoseAnchor;
  podStations: readonly Readonly<PodStation>[];
}
export interface SidepodBodywork {
  inlet: { z: number; x: number; y: number; width: number; height: number };
  shoulder: { x: number; y: number; z: number };
  flank: { x: number; y: number; z: number };
  floorEdge: { x: number; y: number };
  conduit: { x: number; y: number; z: number };
  tail: { x: number; y: number; z: number };
}
export interface CoverBox { z: number; y: number; w: number; h: number; t: number }
export interface EngineCoverBodywork {
  front: CoverBox; rear: CoverBox; coolingX: number; coolingY: number; tailVentY: number;
}

export function create(context: BodyGeomContext) {
  const {
    SURFACES, CARBON, DARK, INTAKE,
    TYRE_BAND, BRAKE_CALIPER,
    AXLES, CHASSIS, DEFAULT_STYLE, DEFAULT_WING, TEAM_STYLE, teamStyleOf,
    geometry, shadeFlags,
  } = context;
  const { addTri, addLoft, addBox, addBlock, addSpan, foilThick, FOIL_CAMBER,
    foilAt, addWingFoil, addStationLoft, addTopBevel } = geometry;

  function styledNoseStations(style?: TeamStyle | null): readonly ChassisStation[] {
    const s = style || DEFAULT_STYLE;
    if (s === DEFAULT_STYLE || (!s.noseTipZ && s.noseSlim === 1 && !s.noseDroop)) return CHASSIS.nose;
    const tip = CHASSIS.nose[0], mid = CHASSIS.nose[1];
    return [
      { z: tip.z + s.noseTipZ, y: tip.y + s.noseDroop,
        w: tip.w * s.noseSlim, h: tip.h * s.noseSlim, t: tip.t },
      { z: mid.z, y: mid.y + s.noseDroop * 0.4,
        w: mid.w * (1 + (s.noseSlim - 1) * 0.4), h: mid.h, t: mid.t },
      CHASSIS.nose[2],
    ];
  }

  // A BODY span: rounded when CarShade is on for this build, else trapezoid + crease.
  function bodySpan(out: MeshOut, a: Station, b: Station, col: Vec3, bevel: number): void { if (shadeFlags.round) CarShade.loft(out, a, b, col, addTri); else { addSpan(out, a, b, col, col); addTopBevel(out, a, b, bevel, col); } }

  // Halo hoop centreline: a level, gently ROUNDED top bar (shallow arch RISE toward
  // the centre) blended into the legs through tangent shoulders. Rear legs ease up
  // from each collar (quadratic, zero slope at the crown); the crown bar is a
  // half-ellipse in x-z with the sin-shaped RISE on top.
  const HALO_RISE = 0.012;                   // shallow arch: ~1.2 cm at centre
  function haloHoopPath(rearX: number, rearY: number, rearZ: number, midX: number, midZ: number,
                        crownY: number, apexZ: number, barSteps = 6): MVec3[] {
    const LEG = 4, BAR = barSteps, pts: MVec3[] = [];
    for (let i = 0; i < LEG; i++) {          // left leg: collar -> crown
      const t = i / LEG;
      pts.push([-(rearX + (midX - rearX) * t),
                rearY + (crownY - rearY) * t * (2 - t),
                rearZ + (midZ - rearZ) * t]);
    }
    for (let i = 0; i <= BAR; i++) {         // crown bar: level, gently arched
      const a = Math.PI * (1 - i / BAR);
      pts.push([Math.cos(a) * midX,
                crownY + HALO_RISE * Math.sin(a),
                midZ + (apexZ - midZ) * Math.sin(a)]);
    }
    for (let i = 1; i <= LEG; i++) {         // right leg: crown -> collar
      const t = i / LEG;
      pts.push([midX + (rearX - midX) * t,
                crownY + (rearY - crownY) * t * t,
                midZ + (rearZ - midZ) * t]);
    }
    return pts;
  }

  const REAR_TYRE_CROWN = AXLES.wheelY + 0.34, REAR_WING_TOP = 1.00;
  function endplateGeom(aLvl: number | null | undefined, style?: AeroStyleArg): EndplateGeom {
    const aN = Math.max(0, Math.min(1, (aLvl || 0) / 4));
    const st = (style && typeof style === "object") ? style : AERO_STYLE_DEF;
    const sweep = Math.max(-0.06, Math.min(0.20, st.rearSweep != null ? st.rearSweep : 0.03));
    const fin = Math.max(0.55, Math.min(1.45, st.fin != null ? st.fin : 1));
    const lift = Math.pow(aN, 0.85), topLift = Math.pow(lift, 1.15);
    const sweepN = Math.max(0, (sweep + 0.02) / 0.14);
    const finN = Math.max(0, (fin - 0.55) / 0.90);
    // Grow UP from a low plank, capped at REAR_WING_TOP = a real wing's ~1.0 m.
    const rise = Math.min(REAR_WING_TOP - (REAR_TYRE_CROWN - 0.02),
      Math.pow(topLift, 0.6) * (0.29 + 0.03 * sweepN + 0.03 * finN));
    const topY = (REAR_TYRE_CROWN - 0.02) + rise, sy = 0.22 + 0.80 * rise;   // bottom = topY - sy stays ≈ 0.44–0.53
    const cy = topY - 0.015 - sy * 0.5;
    const chord = 0.48 + 0.24 * topLift, rearZ = -2.69, frontZ = rearZ + chord;
    const profile = (z: number, sectionCy: number, sectionSy: number): EndplateProfile => ({
      z, cy: sectionCy, sy: sectionSy,
      bottom: sectionCy - sectionSy * 0.5,
      top: sectionCy + sectionSy * 0.5,
    });
    return {
      cy, sy, chord,
      front: profile(frontZ, cy - 0.035, sy * 0.76),
      rear: profile(rearZ, cy + 0.015, sy),
    };
  }
  const FW_MOVEABLE = 2;
  const AERO_STYLE_DEF: AeroStyle = { frontSweep: 0.04, frontTaper: 0.98, frontRise: 0.04,
                                      rearSweep: 0.03, rearTaper: 0.98 };
  function wingOf(style?: WingSource | null): WingStyle { return (style && style.wingStyle) || DEFAULT_WING; }
  function wingFoilOf(st: WingSource | null | undefined, i: number): WingFoilExtra {
    const w: WingFields = (st && st.wingStyle) || st || DEFAULT_WING;
    const k = Math.max(0, Math.min(1, i / 2));
    return { twist: (w.twist || 0) * (0.55 + 0.55 * k),
             teCurve: (w.teCurve || 0) * (0.60 + 0.55 * k),
             chordTaper: (w.chordTaper || 0) * (0.55 + 0.55 * k),
             tipRise: (w.tipRise || 0) * (0.50 + 0.50 * k) };
  }
  function frontCascade(aLvl: number): CascadeElem[] {
    const a = aLvl;
    const els: CascadeElem[] = [
      [2.72, 0.048, 2.40, 0.086, 1.00, 0.024],   // main plane (structure, never moves)
      [2.50, 0.092, 2.24, 0.146, 0.98, 0.020],   // flap 1
    ];
    if (a >= 1) els.push([2.34, 0.148, 2.10, 0.212, 0.95, 0.018]);   // flap 2
    if (a >= 3) els.push([2.20, 0.200, 1.98, 0.272, 0.92, 0.016]);   // flap 3
    if (a >= 4) els.push([2.08, 0.256, 1.88, 0.328, 0.88, 0.014]);   // flap 4
    return els;
  }
  // How many of them the mesh still bakes. Never the main plane.
  function frontBakedCount(aLvl: number): number {
    const n = frontCascade(aLvl).length;
    return n - Math.min(FW_MOVEABLE, n - 1);
  }
  // The front tyre's outer face (addWheel at x 0.79, width 0.32): the car's widest
  // point, 1.90 m across, the 2026 maximum.
  const FRONT_TYRE_OUTER = 0.79 + 0.32 / 2;
  // A front wing is NARROWER than the car (~1700 mm against 1900 for 2026): the gap
  // is what the endplate pushes the wake around. 0.715 is set by the WIDEST aero
  // option (outwash_max / reg26_concept reach span + 0.240 = 0.945, just inboard of
  // the 0.950 tyre face), not the default — calibrating on the default let two
  // specs sit 5 mm proud.
  const FW_SPAN = 0.715;
  function frontHalf(aLvl: number): number {
    return FW_SPAN * (aLvl <= 0 ? 0.74 : (aLvl === 1 ? 0.88 : 1.0));
  }
  // FRONT-WING ENDPLATE profiles, and the ONE function that places the plate: the
  // decal mesh has to land on the plate at every aero recipe, so mesh and decal
  // both read this.
  const FRONT_PLATE: readonly FrontPlateProfile[] = [
    { hF: 0.16, hR: 0.30, kick: 0.020, footW: 0.09, footZ: 0.46, arch: 0 },
    { hF: 0.22, hR: 0.40, kick: 0.060, footW: 0.13, footZ: 0.54, arch: 0 },
    { hF: 0.30, hR: 0.54, kick: 0.100, footW: 0.19, footZ: 0.62, arch: 1 },
    // 3: outwash spec — tall plate whose TOP EDGE ROLLS OUTBOARD (roll: 1).
    { hF: 0.28, hR: 0.50, kick: 0.120, footW: 0.16, footZ: 0.58, arch: 0, roll: 1 },
  ];
  function frontPlateGeom(aLvl: number | null | undefined, aero?: { plate?: number | null | undefined } | null): FrontPlateGeom {
    const lvl = aLvl == null ? 2 : aLvl;
    const pick = aero && aero.plate != null ? aero.plate : 1;
    const P = FRONT_PLATE[Math.max(0, Math.min(3, Math.round(pick)))]!;
    const half = frontHalf(lvl);
    const w = lvl >= 4 ? 0.060 : (lvl <= 0 ? 0.028 : 0.044);
    const x = half + 0.03;
    const kick = Math.min(P.kick, Math.max(0, CAR_HALF - half - 0.03 - w * 0.5 - 0.006));
    return { P, w, kick,
             front: { z: 2.66, x, y: 0.135, h: P.hF, t: 0.62 },
             rear:  { z: 1.98, x: x + kick, y: 0.245, h: P.hR, t: 0.78 } };
  }
  // FIA overall-width envelope, half (1900 mm, exactly the front tyre faces).
  // NOTHING may sit outside it: it bounds the endplate kick, floor rails, diffuser.
  const CAR_HALF = 0.95;
  // Extra incidence the CLOSED (Z-mode) pose takes over the element's baked angle,
  // per wing: a rear wing gives 30-40 deg back in X-mode; the front only trims. A
  // mid-chord hinge + a little front bite makes the TE drop in X-mode so the cascade
  // reads as two steps; rear bite is the DRS-style slot.
  const Z_BITE = { front: 0.12, rear: 0.55 };
  // Where each element pivots, as a fraction of its own chord (0 LE, 1 TE).
  const HINGE = { front: 0.52, rear: 0.45 };
  const OPEN_FRAC = { front: 2.2, rear: 2.6 };
  // The ceiling the front-wing flap solve clears: the nose underside where it
  // overhangs the wing, as (z, y) samples. The WORST droop over every shipped style
  // is DERIVED (styledNoseStations drops the mid station by noseDroop * 0.4), so it
  // can only make the solver back off more and cannot go stale.
  const NOSE_DROOP_FLOOR = (function () {
    const zMid = CHASSIS.nose[1].z, zTip = CHASSIS.nose[0].z;
    let worst = 0;
    for (const k of Object.keys(TEAM_STYLE)) {
      const st = TEAM_STYLE[k]!, d = st.noseDroop || 0;
      if (d >= 0) continue;                       // a raised nose only adds room
      const tipZ = zTip + (st.noseTipZ || 0);
      for (const z of [2.00, 2.16]) {             // the window NOSE_UNDER covers
        const t = Math.max(0, Math.min(1, (z - zMid) / (tipZ - zMid)));
        worst = Math.min(worst, d * (0.4 + 0.6 * t));
      }
    }
    return worst;                                 // <= 0, metres
  })();
  const NOSE_UNDER: readonly (readonly [number, number])[] = [[1.96, Infinity], [2.00, 0.294 + NOSE_DROOP_FLOOR],
                      [2.10, 0.414 + NOSE_DROOP_FLOOR], [2.16, Infinity]];
  const NOSE_GAP = 0.005;        // m of daylight to keep under it
  function noseUnderAt(z: number): number {
    if (z <= NOSE_UNDER[0]![0] || z >= NOSE_UNDER[NOSE_UNDER.length - 1]![0]) return Infinity;
    for (let i = 1; i < NOSE_UNDER.length; i++) {
      const [z1, y1] = NOSE_UNDER[i]!, [z0, y0] = NOSE_UNDER[i - 1]!;
      if (z <= z1) {
        if (!isFinite(y0) || !isFinite(y1)) return Infinity;
        return y0 + (y1 - y0) * (z - z0) / (z1 - z0);
      }
    }
    return Infinity;
  }
  function elemPoint(e: ElemRecord, d: number, t: number): ElemPoint {
    const ang = e.natural + d, c = Math.cos(ang), s = Math.sin(ang);
    const u = (t - e.hinge) * e.chord;
    const mid = e.py + u * s - FOIL_CAMBER * e.chord * 4 * t * (1 - t);
    const h = e.thick * 0.5 * foilThick(t);
    return { z: e.pz - u * c, top: mid + h, bot: mid - h };
  }
  function elemRecord(le: readonly [number, number], te: readonly [number, number], thick: number, hinge: number): ElemRecord {
    const chord = Math.hypot(le[0] - te[0], te[1] - le[1]);
    return {
      chord, thick, hinge,
      natural: Math.atan2(te[1] - le[1], le[0] - te[0]),
      pz: le[0] + (te[0] - le[0]) * hinge,
      py: le[1] + (te[1] - le[1]) * hinge,
    };
  }
  function elemTopAt(e: ElemRecord, d: number, z: number): number | null {
    const N = 32;
    let prev = elemPoint(e, d, 0);
    for (let k = 1; k <= N; k++) {
      const cur = elemPoint(e, d, k / N);
      if ((z <= prev.z && z >= cur.z) || (z >= prev.z && z <= cur.z)) {
        const f = (z - prev.z) / ((cur.z - prev.z) || 1e-9);
        return prev.top + (cur.top - prev.top) * f;
      }
      prev = cur;
    }
    return null;
  }
  // What the engine cover stacks, in ONE place (every layer used to carry its own
  // literal and three had drifted into each other). Bodywork sits UNDER the livery:
  // the bodywork is sunk rather than the decal floated.
  const COVER_STACK = Object.freeze({
    vent: 0.005, shield: 0.008, decal: 0.013,        // crown, from cover.top
    flankTrim: 0.009, flankDecal: 0.014,             // flank, from coverFlankX
  });
  const SLOT_MIN = 0.003;   // m of daylight to keep in a cascade slot
  function hinged(id: string, wing: WingId, zLead: number, yLead: number, zTrail: number, yTrail: number,
                  planform: FlapPlanform | null, prev: ElemPose | null): FlapElement {
    const dz = zLead - zTrail, dy = yTrail - yLead;
    const chord = Math.sqrt(dz * dz + dy * dy);
    const natural = Math.atan2(dy, dz);
    const thick = planform ? planform.thick : 0;
    const want = planform && planform.hinge != null ? planform.hinge : HINGE[wing];
    let hinge = want, pz = 0, py = 0, best = -1;
    for (let h = want; h >= 0.14; h -= 0.02) {
      const r = solvePoses(h);
      if (!r) continue;
      const travel = r.bite - r.open;
      if (travel > best + 1e-6) { best = travel; hinge = h; pz = r.pz; py = r.py; }
    }
    if (best < 0) {   // nothing clears anywhere — keep the requested pivot
      pz = zLead + (zTrail - zLead) * want; py = yLead + (yTrail - yLead) * want;
      hinge = want;
    }
    const solved = solvePoses(hinge);
    return Object.assign({
      id, wing,
      z: pz, y: py,              // PIVOT, in car-local metres — what the draw hangs it at
      le: [zLead, yLead] as [number, number], te: [zTrail, yTrail] as [number, number],   // what buildFlapGeom emits
      chord, natural, hinge,
      zAngle: solved ? solved.bite : 0,
      xAngle: solved ? solved.open : -natural,
    }, planform) as FlapElement;

    function solvePoses(h: number): { bite: number; open: number; pz: number; py: number } | null {
      const qz = zLead + (zTrail - zLead) * h, qy = yLead + (yTrail - yLead) * h;
      const self: ElemRecord = { chord, thick, hinge: h, natural, pz: qz, py: qy };
      // Two things a front element must not enter: the nose overhang above it, and
      // the element it nests over (posed at ITS pose for the same end of travel).
      // Sampled far finer than the mesh stations: the crossings fall between them.
      // Applies to BOTH wings; noseUnderAt() is Infinity behind the nose.
      const CLEAR_N = 40;
      const clears = (d: number, prevDelta: number): boolean => {
        for (let k = 0; k <= CLEAR_N; k++) {
          const p = elemPoint(self, d, k / CLEAR_N);
          const ceil = noseUnderAt(p.z);
          if (isFinite(ceil) && p.top > ceil - NOSE_GAP) return false;
          if (prev) {
            const below = elemTopAt(prev, prevDelta, p.z);
            if (below != null && p.bot < below + SLOT_MIN) return false;
          }
        }
        return true;
      };
      // Back each end off in small steps until it fits. The closed search runs PAST
      // zero (the baked attitude is not safe at max downforce); null lets the hinge
      // search reject this pivot instead of shipping an intersection.
      const relax = (from: number, dir: number, prevDelta: number): number | null => {
        for (let i = 0; i <= 120; i++) {
          const a = from + dir * 0.01 * i;
          if (clears(a, prevDelta)) return a;
        }
        return null;
      };
      const bite = relax(Z_BITE[wing], -1, prev ? prev.zAngle : 0);
      if (bite == null) return null;
      const open = relax(-natural * OPEN_FRAC[wing], +1, prev ? prev.xAngle : 0);
      return { bite, open: open == null ? bite : open, pz: qz, py: qy };
    }
  }
  // SOLVED ONCE PER (level, recipe), NEVER PER FRAME. hinged() SEARCHES each
  // element's pivot; drawAeroFlaps calls this for every car every frame, and nothing
  // in the result depends on the car or the blend, so it is memoised.
  // Callers MUST treat the records as immutable — they are shared.
  const _flapSpecs = new Map<string, FlapElement[]>();
  const _flapSig = new WeakMap<object, string>();
  function flapSig(st0: AeroStyle): string {
    let sig = _flapSig.get(st0);
    if (sig === undefined) {
      const w: WingFields = st0.wingStyle || st0;
      sig = [st0.frontSweep, st0.frontTaper, st0.frontRise,
             st0.rearSweep, st0.rearTaper, st0.drs || 0,
             w.twist || 0, w.teCurve || 0, w.chordTaper || 0, w.tipRise || 0]
        .map((v) => +v || 0).join(",");
      _flapSig.set(st0, sig);
    }
    return sig;
  }
  // Per-STYLE-object front cache (style -> Map(level -> records)).
  const _flapByStyle = new WeakMap<object, Map<number, FlapElement[]>>();
  function aeroFlapsGeom(aLvl: number, style?: AeroStyleArg): FlapElement[] {
    const st0 = (style && typeof style === "object") ? style : AERO_STYLE_DEF;
    let byLvl = _flapByStyle.get(st0), hit = byLvl && byLvl.get(aLvl); if (hit) return hit;
    const key = aLvl + "|" + flapSig(st0);
    hit = _flapSpecs.get(key);
    if (!hit) {
      hit = solveFlapsGeom(aLvl, st0);
      for (let i = 0; i < hit.length; i++) hit[i]!.cacheKey = key + "|" + i;
      _flapSpecs.set(key, hit);
    }
    if (!byLvl) _flapByStyle.set(st0, byLvl = new Map());
    byLvl.set(aLvl, hit); return hit;
  }
  function solveFlapsGeom(aLvl: number, style?: AeroStyleArg): FlapElement[] {
    // A style must be a RECIPE OBJECT: a tier NUMBER would read .frontSweep as
    // undefined and NaN every vertex downstream.
    const a = aLvl, st = (style && typeof style === "object") ? style : AERO_STYLE_DEF;
    const frontSweep = Math.max(-0.08, Math.min(0.22, st.frontSweep));
    const frontTaper = Math.max(0.72, Math.min(1.08, st.frontTaper));
    const frontRise = Math.max(-0.03, Math.min(0.16, st.frontRise));
    const rearSweep = Math.max(-0.06, Math.min(0.20, st.rearSweep));
    const rearTaper = Math.max(0.72, Math.min(1.08, st.rearTaper));
    const els = frontCascade(a), baked = frontBakedCount(a), fwHalf = frontHalf(a);
    const out: FlapElement[] = [];
    // Solved in cascade order, each element handed the one it nests over (bottom-up).
    // A baked neighbour never moves, hence the zero poses on its record.
    for (let i = baked; i < els.length; i++) {
      const e = els[i]!, p = els[i - 1];
      const prev: ElemPose | null = p
        ? Object.assign(elemRecord([p[0], p[1]], [p[2], p[3]], p[5], i - 1 < baked ? 0 : HINGE.front),
                        i - 1 < baked ? { zAngle: 0, xAngle: 0 }
                                      : { zAngle: out[out.length - 1]!.zAngle,
                                          xAngle: out[out.length - 1]!.xAngle })
        : null;
      const extra = wingFoilOf(st, i);
      out.push(hinged("front" + i, "front", e[0], e[1], e[2], e[3], {
        half: fwHalf * e[4], thick: e[5], taper: frontTaper,
        sweep: frontSweep * (0.75 + i * 0.10),
        rise: frontRise * (0.65 + i * 0.12) + extra.tipRise,
        attachHalf: fwHalf + 0.03,
        upsweep: i === els.length - 1 && (wingOf(st).flaps || 3) >= 3 ? { fwHalf, e } : null,
        twist: extra.twist, teCurve: extra.teCurve, chordTaper: extra.chordTaper,
      }, prev));
    }
    const ep = endplateGeom(a, st), crownY = ep.rear.top - 0.018;
    const upperTrailY = crownY - ((a >= 4 || (st.drs || 0)) ? 0.075 : 0);
    const rearMain: ElemPose = Object.assign(
      elemRecord([-2.30, upperTrailY - 0.270], [-2.52, upperTrailY - 0.225], 0.024, 0),
      { zAngle: 0, xAngle: 0 });
    let below: ElemPose = rearMain;
    const addRear = (id: string, le: [number, number], te: [number, number], thick: number, sweepMul: number): void => {
      const el = hinged(id, "rear", le[0], le[1], te[0], te[1], {
        half: id === "rearTop" ? 0.50 : 0.51, thick, taper: rearTaper,
        sweep: rearSweep * sweepMul, attachHalf: 0.50, rise: 0,
      }, below);
      out.push(el);
      below = Object.assign(elemRecord(le, te, thick, el.hinge),
                            { zAngle: el.zAngle, xAngle: el.xAngle });
    };
    if (a >= 2) {
      addRear("rearMid", [-2.34, upperTrailY - 0.170], [-2.56, upperTrailY - 0.115], 0.022, 0.9);
    }
    addRear("rear", [-2.38, upperTrailY - 0.075], [-2.64, upperTrailY], 0.026, 1);
    if (a >= 4 && !(st.drs || 0)) {
      addRear("rearTop", [-2.42, crownY - 0.055], [-2.66, crownY], 0.022, 1.1);
    }
    return out;
  }
  function buildFlapGeom(el: FlapElement, col: Vec3, finish?: string | null, surface?: string | null): MeshOut {
    if (surface === "carbon") col = CARBON;
    const out: MeshOut = { pos: [], nrm: [], col: [], mat: [], idx: [] };
    // The element exactly as the wing build emits it...
    addWingFoil(out, {
      zLead: el.le[0], yLead: el.le[1], zTrail: el.te[0], yTrail: el.te[1],
      half: el.half, thick: el.thick, taper: el.taper,
      sweep: el.sweep, rise: el.rise, attachHalf: el.attachHalf,
      twist: el.twist, teCurve: el.teCurve, chordTaper: el.chordTaper,
    }, col, surface === "carbon" ? SURFACES.carbon : SURFACES.paint);
    if (el.upsweep) {
      const { fwHalf, e } = el.upsweep;
      for (const sgn of [-1, 1]) {
        addSpan(out, { z: e[2], x: sgn * (fwHalf * e[4] - 0.05), y: e[3], w: 0.16, h: e[5] * 1.5 },
                     { z: e[2] - 0.04, x: sgn * (fwHalf + 0.02), y: e[3] + 0.085, w: 0.09, h: e[5] * 1.6 }, col);
      }
    }
    for (let i = 0; i < out.pos.length; i += 3) {
      out.pos[i + 1]! -= el.y;
      out.pos[i + 2]! -= el.z;
    }
    // Livery FINISH remap, exactly as build() does for the baked mesh. A gloss /
    // absent finish leaves the array byte-identical (no remap).
    if (surface === "carbon") {
      // Upsweep spans also belong to the flap; keep every vertex bare weave.
      for (let i = 0; i < out.mat.length; i++) out.mat[i] = SURFACES.carbon;
    } else applyFinish(out, finish, null, null);
    return out;
  }
  function aeroFlapAim(aLvl: number, wing: WingId, style?: AeroStyleArg): MVec3 {
    const els = aeroFlapsGeom(aLvl, style).filter((e) => e.wing === wing);
    let y = 0, z = 0;
    for (const e of els) {
      y += (e.le[1] + e.te[1]) * 0.5;
      z += (e.le[0] + e.te[0]) * 0.5;
    }
    return [0, y / els.length, z / els.length];
  }
  // REGIONS.wing — the rear-wing sponsor band, on the TOPMOST rear flap's TOP SKIN
  // at its REST attitude (drawAeroFlaps hangs it at its pivot rotated by zAngle),
  // not the design chord where no flap is drawn. Chord fractions clear the curl and
  // the TE; HALF is inside the element's 0.51; five span segments follow the sweep;
  // `proud` is along the local normal, not +Y.
  const WING_BAND = Object.freeze({ tF: 0.17, tR: 0.83, half: 0.44, proud: 0.005, seg: 5 });
  function wingBandGeom(aLvl: number | null | undefined, style?: AeroStyleArg): WingBand | null {
    const a = aLvl == null ? 2 : aLvl;
    const st = (style && typeof style === "object") ? style : AERO_STYLE_DEF;
    const W = WING_BAND;
    let spec: Parameters<typeof foilAt>[0] | null = null, pivot: { y: number; z: number } | null = null, ang = 0, elem = "";
    if (st.drs) {
      // A DRS package BAKES an extra plane over the moveable stack; it never
      // rotates, so it keeps the band attached at every wing angle.
      const crownY = endplateGeom(a, st).rear.top - 0.018;
      const rearSweep = Math.max(-0.06, Math.min(0.20, st.rearSweep));
      const rearTaper = Math.max(0.72, Math.min(1.08, st.rearTaper));
      spec = { zLead: -2.44, yLead: crownY - 0.050, zTrail: -2.60, yTrail: crownY,
               half: 0.49, thick: 0.016, taper: rearTaper, sweep: rearSweep * 1.15,
               rise: 0, attachHalf: 0.50 };
      elem = "drs";
    } else {
      const flaps = aeroFlapsGeom(a, st);
      let fg: FlapElement | null = null;
      for (const f of flaps) if (f.wing === "rear") fg = f;   // the TOPMOST one
      if (!fg) return null;
      // Exactly what buildFlapGeom hands addWingFoil, at the closed-wing pose.
      spec = { zLead: fg.le[0], yLead: fg.le[1], zTrail: fg.te[0], yTrail: fg.te[1],
               half: fg.half, thick: fg.thick, taper: fg.taper, sweep: fg.sweep,
               rise: fg.rise, attachHalf: fg.attachHalf };
      pivot = { y: fg.y, z: fg.z };
      ang = fg.zAngle;
      elem = fg.id;
    }
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const pv = pivot;
    const pose = (p: { y: number; h: number; z: number }): { y: number; z: number } => {
      const top = p.y + p.h;
      if (!pv) return { y: top, z: p.z };
      const dy = top - pv.y, dz = p.z - pv.z;
      return { y: dy * ca - dz * sa + pv.y, z: dy * sa + dz * ca + pv.z };
    };
    const st8: WingBandStation[] = [];
    for (let i = 0; i <= W.seg; i++) {
      const x = -W.half + (2 * W.half) * (i / W.seg);
      const f = pose(foilAt(spec, x, W.tF)), r = pose(foilAt(spec, x, W.tR));
      const dz = r.z - f.z, dy = r.y - f.y, len = Math.hypot(dz, dy) || 1e-9;
      const n: [number, number, number] = [0, -dz / len, dy / len];
      st8.push({ x,
                 front: { y: f.y + n[1] * W.proud, z: f.z + n[2] * W.proud },
                 rear:  { y: r.y + n[1] * W.proud, z: r.z + n[2] * W.proud },
                 nrm: n });
    }
    return { half: W.half, stations: st8, elem };
  }
  // Number board anchored low on the plate; shrinks on the tier-0 plank.
  function numberBoard(aLvl: number | null | undefined, style?: AeroStyleArg): { cy: number; h: number } {
    const ep = endplateGeom(aLvl, style), gap = 0.05;
    // Cap with mid front/rear height so the board stays inside the plate.
    const midH = ((ep.front.top - ep.front.bottom) + (ep.rear.top - ep.rear.bottom)) * 0.5;
    const h = Math.min(0.20, Math.max(0.12, Math.min(ep.sy - gap - 0.02, midH - 2 * gap - 0.008)));
    return { cy: ep.cy - ep.sy * 0.5 + gap + h * 0.5, h };
  }
  // The blade OUTLINES a livery may pick (liv.finShape). Every shape keeps the
  // standard base line (the cover root and the decal maths read baseLE/baseTE) and
  // moves only the top corners; topLE.y === topTE.y in every one.
  const FIN_SHAPES = Object.freeze({
    standard: Object.freeze<FinShape>({
      baseLE: [-0.65, 0.7935], topLE: [-1.15, 0.97],
      topTE:  [-1.65, 0.97],   baseTE: [-1.70, 0.6197],
      halfBase: 0.022, halfTop: 0.014,
    }),
    // Raked: the leading edge sweeps back to a short crown — the 2023 RB19 look.
    swept: Object.freeze<FinShape>({
      baseLE: [-0.65, 0.7935], topLE: [-1.38, 0.97],
      topTE:  [-1.66, 0.97],   baseTE: [-1.70, 0.6197],
      halfBase: 0.022, halfTop: 0.012,
    }),
    // A short rear blade: half the chord, rooted where the cover is already low.
    stub: Object.freeze<FinShape>({
      baseLE: [-1.18, 0.7100], topLE: [-1.42, 0.93],
      topTE:  [-1.65, 0.93],   baseTE: [-1.70, 0.6197],
      halfBase: 0.020, halfTop: 0.013,
    }),
    // Ferrari's SF-26 fin: a tall front blade dropping a step to a lower rear
    // section. The outline is the FRONT blade; `step` is the lower block behind it.
    stepped: Object.freeze<FinShape>({
      baseLE: [-0.65, 0.7935], topLE: [-1.15, 0.97],
      topTE:  [-1.43, 0.97],   baseTE: [-1.45, 0.6611],
      halfBase: 0.022, halfTop: 0.014,
      step: Object.freeze({ top: 0.885, baseTE: [-1.70, 0.6197] as const }),
    }),
  });
  // Mesh (not paint) detail picks a livery carries.
  const COVER_VENT_IDS = Object.freeze(["none", "gills", "spine"] as const);
  // SPINE HEIGHT (liv.spineHeight): lifts the engine-cover crown's TOP line only,
  // tapering toward the tail (SPINE_TAIL), so the cover reads as a dorsal hump. It
  // enters through bodyAnchors so everything mounted off coverAt(z).top rides up.
  // The fin's TOP stays at finTop, so a raised spine shortens the blade. "dorsal"
  // (0.96) runs level with the hoop: the real 2026 cover, a tall spine with no fin.
  const SPINE_HEIGHT_IDS = Object.freeze(["standard", "raised", "high", "dorsal"] as const);
  const SPINE_RISE: Readonly<Record<string, number>> = Object.freeze({ standard: 0, raised: 0.06, high: 0.10, dorsal: 0.13 });
  const SPINE_TAIL = 0.45;   // fraction of the lift that survives at the tail (z -2.0)
  const spineRise = (id: string | null | undefined): number => SPINE_RISE[id as string] || 0;
  // ENGINE-COVER CROSS-SECTION — one profile for the loft, the flank band, the crest
  // strip and every detail bolted to the cover. Per side, bottom to crown: the FLANK
  // from (x, bottom) up to the SHOULDER at (0.72x, top - d), then two facets
  // rounding over to a flat crown ±0.32x wide at `top`; d is 18 % of the height.
  // Garage/near (`dense`): CarShade.densifyCoverPts samples shoulder→crown as a
  // quarter-ellipse; pts[0]/pts[1] stay foot/shoulder.
  const COVER_SHOULDER = 0.72, COVER_CROWN = 0.32, COVER_DROP = 0.18;
  function coverProfile(c: CoverSection, dense?: boolean): CoverProfile {
    const h = c.top - c.bottom, d = h * COVER_DROP;
    const ck = Math.max(-0.04, Math.min(0.06, c.k || 0));
    const cr = Math.max(0.20, COVER_CROWN - ck * 2.4);
    const keys: Pt2[] = [[c.xb != null ? c.xb : c.x, c.bottom], [c.x * COVER_SHOULDER, c.top - d],
                         [c.x * 0.55, c.top - d * 0.32], [c.x * cr, c.top]];
    const pts: readonly (readonly [number, number])[] = (dense && CarShade.densifyCoverPts)
      ? CarShade.densifyCoverPts(keys) : keys;
    return { x: c.x, bottom: c.bottom, top: c.top, shoulder: keys[1]![1], d, pts, keys };
  }
  // x of the flank skin at height y (clamped to the flank) — where a side-mounted
  // detail actually touches the car.
  function coverFlankX(c: CoverSection, y: number): number {
    const p = coverProfile(c);
    const v = Math.max(0, Math.min(1, (y - p.bottom) / (p.shoulder - p.bottom)));
    return c.xb != null ? c.xb + (p.pts[1]![0] - c.xb) * v : p.x * (1 - (1 - COVER_SHOULDER) * v);
  }
  // y of the cover skin over |x| — the crown, a facet, or the flank top.
  function coverSurfaceY(c: CoverSection, x: number): number {
    const p = coverProfile(c), ax = Math.abs(x);
    for (let i = p.pts.length - 1; i > 0; i--) {
      const [xi, yi] = p.pts[i]!, [xo, yo] = p.pts[i - 1]!;   // inner → outer
      if (ax <= xi) return yi;
      if (ax <= xo) return yi + (yo - yi) * (ax - xi) / (xo - xi);
    }
    return p.bottom;
  }
  const FIN_SHAPE_IDS = Object.freeze(Object.keys(FIN_SHAPES).concat(["none"]));
  const FIN = FIN_SHAPES.standard;
  const finOf = (shape?: string | null): FinShape => (FIN_SHAPES as Readonly<Record<string, FinShape | undefined>>)[shape as string] || FIN;
  const finMix = (a: number, b: number, t: number): number => a + (b - a) * t;
  // `fin` is the aero recipe's blade-height scale, applied about the FROZEN base line
  // so mesh and decal agree on the top. ONE height for both ends keeps the crown
  // LEVEL (scaling each end about its own base grew a wedge crown and walked the
  // decal off the blade).
  const finTop = (fin?: number | null, shape?: string | null): number => {
    const F = finOf(shape);
    const f = Math.max(0.55, Math.min(1.45, fin || 1));
    return F.baseLE[1] + (F.topLE[1] - F.baseLE[1]) * f;
  };
  // THE BLADE'S ROOT — one function for the mesh AND the decal. FIN_MIN_BLADE keeps
  // the maths from inverting when a cover tops the regulation fin line.
  const FIN_MIN_BLADE = 0.005;
  function sharkFinRoot(anchors: { coverAt?: ((z: number) => { top?: number | null } | null) | undefined } | null | undefined,
                        fin?: number | null, shape?: string | null): FinRoot {
    const F = finOf(shape), tp = finTop(fin, shape);
    const coverTop = (z: number, y0: number): number => {
      const c = anchors && anchors.coverAt ? anchors.coverAt(z) : null;
      return c && c.top != null ? c.top : y0;
    };
    const cLE = coverTop(F.baseLE[0], F.baseLE[1]), cTE = coverTop(F.baseTE[0], F.baseTE[1]);
    const cap = (y: number): number => Math.min(y, tp - FIN_MIN_BLADE);
    return {
      // The MESH root, buried 10 mm so no daylight shows under the blade…
      bLE: cap(cLE - 0.010), bTE: cap(cTE - 0.010),
      // …and the DECAL base, where the blade EMERGES from the skin.
      dLE: cap(cLE + 0.001), dTE: cap(cTE + 0.001),
      top: tp,
      // How much blade stands above the crown at the LE (car-mesh skips a graphic
      // when there is not enough of it to read).
      clear: tp - cLE,
    };
  }
  // `root` is a sharkFinRoot() result, or absent for the frozen base line.
  const finBaseLE = (F: FinShape, root?: FinRoot | null): number => (root ? root.dLE : F.baseLE[1]);
  const finBaseTE = (F: FinShape, root?: FinRoot | null): number => (root ? root.dTE : F.baseTE[1]);
  function finXAt(z: number, y: number, proud: number, fin?: number | null, shape?: string | null, root?: FinRoot | null): number {
    const F = finOf(shape), tp = finTop(fin, shape);
    const u = (z - F.baseLE[0]) / (F.baseTE[0] - F.baseLE[0]);   // along the base edge
    const yBase = finMix(finBaseLE(F, root), finBaseTE(F, root), Math.max(0, Math.min(1, u)));
    const v = Math.max(0, Math.min(1, (y - yBase) / (tp - yBase)));
    return finMix(F.halfBase, F.halfTop, v) + proud;
  }
  function sharkFinPanel(inset?: number | null, proud?: number | null, fin?: number | null,
                         shape?: string | null, root?: FinRoot | null): FinPoint[] {
    const F = finOf(shape);
    const i = inset != null ? inset : 0.05;
    const p = proud != null ? proud : 0.002;
    const tp = finTop(fin, shape);
    const vBase = Math.max(i, 0.18);
    const at = (u: number, v: number): FinPoint => {
      // bilinear over the outline: u = 0 leading → 1 trailing, v = 0 base → 1 top.
      const bz = finMix(F.baseLE[0], F.baseTE[0], u), by = finMix(finBaseLE(F, root), finBaseTE(F, root), u);
      const tz = finMix(F.topLE[0],  F.topTE[0],  u), ty = tp;
      return { x: finMix(F.halfBase, F.halfTop, v) + p,
               y: finMix(by, ty, v), z: finMix(bz, tz, v) };
    };
    return [at(i, vBase), at(1 - i, vBase), at(1 - i, 1 - i), at(i, 1 - i)];
  }
  // v0/v1 are FRACTIONS of the blade and u0/u1 of the BASE, so the badge fits every
  // fin scale and shape (on the standard shape they reproduce z -1.235 / -1.465).
  // The WIDTH is the standard badge's aspect re-applied to each shape's own blade
  // height at fin scale 1, so a short chord does not squash the mark.
  const FIN_BADGE = Object.freeze({ uMid: 0.7 / 1.05, wStd: 0.23, v0: 0.32, v1: 0.88 });
  const badgeHeight1 = (F: FinShape): number => {
    const yB = finMix(F.baseLE[1], F.baseTE[1], FIN_BADGE.uMid);
    return (F.topLE[1] - yB) * (FIN_BADGE.v1 - FIN_BADGE.v0);
  };
  const BADGE_ASPECT = FIN_BADGE.wStd / badgeHeight1(FIN);
  function sharkFinBadge(proud?: number | null, fin?: number | null, shape?: string | null, root?: FinRoot | null): FinPoint[] {
    const F = finOf(shape);
    const p = proud != null ? proud : 0.0022;   // just outside the graphic panel
    const B = FIN_BADGE, tp = finTop(fin, shape);
    const chord = F.baseLE[0] - F.baseTE[0];
    const half = Math.min(0.45, BADGE_ASPECT * badgeHeight1(F) / chord / 2);
    const u0 = B.uMid - half, u1 = B.uMid + half;
    const zAt = (u: number): number => finMix(F.baseLE[0], F.baseTE[0], u);
    const yAt = (u: number, v: number): number => { const yB = finMix(finBaseLE(F, root), finBaseTE(F, root), u); return yB + (tp - yB) * v; };
    const at = (u: number, v: number): FinPoint => { const z = zAt(u), y = yAt(u, v); return { x: finXAt(z, y, p, fin, shape, root), y, z }; };
    return [at(u0, B.v0), at(u1, B.v0), at(u1, B.v1), at(u0, B.v1)];
  }
  // Where the 2026 amber "stopped" lamps sit: the outboard face of each mirror
  // housing, from the same numbers build()'s mirror section uses. Cached per (team,
  // scale): game.js asks once per drawn car per frame.
  const _mirrorAnchorCache = new Map<string, readonly MirrorAnchor[]>();
  const _mirrorAnchorLast = new Map<string | null | undefined, [number | null | undefined, readonly MirrorAnchor[]]>();   // no key string on a hit
  function mirrorLightAnchors(teamId?: string | null, mirrorScale?: number | null): readonly MirrorAnchor[] {
    const last = _mirrorAnchorLast.get(teamId); if (last && last[0] === mirrorScale) return last[1];
    const mScale = Math.max(0.85, Math.min(1.35, mirrorScale || 1));
    const k = String(teamId) + "|" + mScale.toFixed(3);
    let a = _mirrorAnchorCache.get(k);
    if (a) { _mirrorAnchorLast.set(teamId, [mirrorScale, a]); return a; }
    const mSty = teamStyleOf(teamId).mirror;
    const mx = (0.34 + (mSty === 1 ? 0.035 : 0)) * mScale;
    const mW = mSty === 1 ? 0.235 : 0.215;
    const y = 0.735 + (mSty === 2 ? -0.032 : 0);
    a = Object.freeze([{ x: -(mx + mW / 2 + 0.004), y, z: 0.26 }, { x: mx + mW / 2 + 0.004, y, z: 0.26 }]);
    _mirrorAnchorCache.set(k, a); _mirrorAnchorLast.set(teamId, [mirrorScale, a]); return a;
  }
  // The COCKPIT build's mirror GLASS faces, 1 mm toward the eye: car-draw.js lays a
  // sky-tint fallback there while the HUD mirror pass is not drawing.
  const _ckMirrorCache = new Map<string, MirrorGlassQuads>();
  let _ckLastIn: unknown = {}, _ckLastQ: MirrorGlassQuads | null = null;   // last raw scale -> quads
  function cockpitMirrorGlass(mirrorScale?: number | null): MirrorGlassQuads {
    if (mirrorScale === _ckLastIn) return _ckLastQ!;
    const mScale = Math.max(0.85, Math.min(1.35, mirrorScale || 1)), k = mScale.toFixed(3);
    if (_ckMirrorCache.has(k)) { _ckLastIn = mirrorScale; return (_ckLastQ = _ckMirrorCache.get(k)!); }
    const mx = 0.60 * mScale, mW = 0.215, mH = 0.075, mY = 0.780, toe = 0.030, ins = 0.012, z = 0.92 - 0.038 - 0.001;
    const y0 = mY - mH / 2 + ins, y1 = mY + mH / 2 - ins, zi = z + toe * ins / mW, zo = z + toe * (1 - ins / mW);
    const q = [-1, 1].map((s): MVec3[] => { const xi = s * (mx - mW / 2 + ins), xo = s * (mx + mW / 2 - ins);
      return [[xi, y0, zi], [xo, y0, zo], [xo, y1, zo], [xi, y1, zi]]; });
    _ckMirrorCache.set(k, q); _ckLastIn = mirrorScale; return (_ckLastQ = q);
  }

  function mergeRecipe<P>(defaults: P, recipe: Recipe<P>): P {
    return Object.assign(defaults as object, recipe || {}) as P;
  }
  function buildEngineParts(recipe: Recipe<EngineParts>, tier: number): EngineParts {
    return mergeRecipe<EngineParts>({
      in: tier === 0 ? 0.52 : tier === 2 ? 1.65 : 1,
      snork: tier === 2 ? 1 : 0, twin: tier === 2 ? 1 : 0,
      inlet: tier === 0 ? 0 : tier === 2 ? 2 : 1,
      outlet: tier === 0 ? 0 : tier === 2 ? 2 : 1,
      podWidth: 1, shoulderHeight: 1, undercut: 1,
      coke: 1, tailWidth: 1, coverHeight: 1,
      servicePanel: tier === 2 ? 3 : 1, heatShield: 1,
      chimney: 0,
      // 2026 intake lip. 0 none (shipped) · 1 thin mouth ring · 2 ring + cheeks.
      scoopLip: 0,
    }, recipe);
  }
  function buildAeroParts(recipe: Recipe<AeroParts>, tier: number): AeroParts {
    const lvl = tier === 0 ? 0 : tier === 2 ? 4 : 2;
    // 2026 regulation defaults: no beam wing, universal active flaps, mandated
    // in-wash bargeboard. `beam_wing` keeps an explicit beam:1 for career picks.
    return mergeRecipe<AeroParts>({
      lvl, beam: 0, drs: 1,
      vane: lvl >= 4 ? 3 : lvl >= 3 ? 2 : lvl >= 1 ? 1 : 0,
      plate: 1, casc: null, swan: 0, tvane: null,
      duct: 0, board: 1, slot: 0,
      frontSweep: 0.04, frontTaper: 0.98, frontRise: 0.04,
      rearSweep: 0.03, rearTaper: 0.98,
      floorEdge: 1, floorCut: 0.04, diffuserRise: 1, fin: 1,
    }, recipe);
  }
  function buildSuspensionParts(recipe: Recipe<SuspensionParts>, tier: number): SuspensionParts {
    return mergeRecipe<SuspensionParts>({
      ride: tier === 0 ? 0.060 : tier === 2 ? -0.048 : 0,
      arm: tier === 0 ? 0.85 : tier === 2 ? 1.3 : 1,
      push: tier === 2 ? 1 : 0, pull: 0,
      wishbone: 1, toe: 1,
      // Visible inboard rocker fairing on the tub top: 0 none / 1 split blister / 2 full cover.
      rocker: 0,
      // Transverse third (heave) element: 0 none / 1 damper + spring pack + links.
      heave: 0,
    }, recipe);
  }
  function buildBrakeParts(recipe: Recipe<BrakeParts>, tier: number): BrakeParts {
    return mergeRecipe<BrakeParts>({
      cal: BRAKE_CALIPER[tier], duct: tier === 0 ? 0.5 : tier === 2 ? 1.9 : 1,
      rim: null, caliperPos: 0, coverOpen: tier === 2 ? 1 : 0,
      rotor: tier === 2 ? 2 : 1, rotorScale: tier === 2 ? 1.12 : 1,
      // null = derive the duct fairing from `duct` (the shipped behaviour).
      scoop: null,
      // Disc face pattern seen through an open cover: 0 plain / 1 drilled / 2 slotted.
      discFace: 0,
      // Caliper hardware: 0 shipped 3-box peek / 1 Brembo monobloc / 2 six-piston radial.
      caliper: 0,
    }, recipe);
  }
  function buildTyreParts(recipe: Recipe<TyreParts>, tier: number): TyreParts {
    // sidewall: raised lettering ring(s) on the tyre face. 0 flush / 1 ring / 2 double.
    return mergeRecipe<TyreParts>({ band: TYRE_BAND[tier], shoulder: 0,
      sidewall: 0 }, recipe);
  }
  function buildErsParts(recipe: Recipe<ErsParts>, tier: number, accent: Vec3 | null | undefined): ErsParts {
    // coolerIntake: pack cooling mouth on the pod shoulder. 0 none / 1 NACA lip / 2 lip + louvres.
    return mergeRecipe<ErsParts>({ led: tier === 2 ? accent : null, pack: 1,
      cells: tier === 2 ? 6 : 3, conduit: 0, blister: 0, coolerIntake: 0 }, recipe);
  }
  function buildGearboxParts(recipe: Recipe<GearboxParts>, tier: number): GearboxParts {
    return mergeRecipe<GearboxParts>({
      strakes: tier === 2 ? 5 : 0, fin: tier === 2 ? 1 : 0,
      strakeH: 0.13, finSY: 0.14, finSZ: 0.28,
      casing: tier === 2 ? 3 : 0, louvres: 0, heat: 0,
      caseWidth: 1,
      heatFins: 0, ribs: 0,
    }, recipe);
  }
  function buildFuelParts(recipe: Recipe<FuelParts>, tier: number): FuelParts {
    return mergeRecipe<FuelParts>({
      cap: tier === 2 ? [0.95, 0.28, 1.5] : [0.55, 0.52, 0.60],
      flame: [1.15, 0.42, 0.14],
      line: 1, filler: 0,
      hatch: 0, vent: 0,
      // breather: NACA duct beside the filler. 0 none / 1 duct / 2 duct + standpipe.
      breather: 0,
    }, recipe);
  }
  function buildExhaustParts(recipe: Recipe<ExhaustParts>): ExhaustParts {
    return mergeRecipe<ExhaustParts>({
      pipes: null, bore: 1, flare: 0, wastegate: 0, wrap: 0,
      lip: 0, shield: 0,
    }, recipe);
  }
  function buildFloorParts(recipe: Recipe<FloorParts>): FloorParts {
    return mergeRecipe<FloorParts>({ fences: 5, fenceH: 1, skid: 0, edgeLip: 0,
      plank: 0, gurney: 0, scroll: 0 }, recipe);
  }
  function buildWheelParts(recipe: Recipe<WheelParts>): WheelParts {
    // deflector: 2026 over-wheel deflector above each FRONT wheel. 0 none / 1 plane / 2 biplane + endplate.
    return mergeRecipe<WheelParts>({ spokes: 0, tape: 0, dish: 0, nut: null, gunNut: 0,
      deflector: 0 }, recipe);
  }
  function buildCockpitParts(recipe: Recipe<CockpitParts>): CockpitParts {
    // halo: hoop profile. 0 regulation round tube / 1 slim low-profile / 2 fenced crown.
    // headrest: 0 flat rim / 1 raised horseshoe / 2 winged pad.
    // mirror: outboard span scale for the mirror stalks and housings, 1 = stock.
    return mergeRecipe<CockpitParts>({ haloBlade: 0, haloWing: 0, camPods: 0, screen: 0,
      halo: 0, headrest: 0, mirror: 1 }, recipe);
  }
  function buildPartRecipes(T: PartsTiers, accent?: Vec3 | null): PartRecipes {
    const tier = (id: TierId): number => T[id] != null ? T[id]! : 1;
    const recipe = <K extends keyof VisualRecipes>(id: K): VisualRecipes[K] | null => T._visual && T._visual[id] || null;
    return {
      engine: buildEngineParts(recipe("engine"), tier("engine")),
      aero: buildAeroParts(recipe("aero"), tier("aero")),
      suspension: buildSuspensionParts(recipe("suspension"), tier("suspension")),
      brakes: buildBrakeParts(recipe("brakes"), tier("brakes")),
      tyres: buildTyreParts(recipe("tyres"), tier("tyres")),
      ers: buildErsParts(recipe("ers"), tier("ers"), accent),
      gearbox: buildGearboxParts(recipe("gearbox"), tier("gearbox")),
      fuel: buildFuelParts(recipe("fuel"), tier("fuel")),
      exhaust: buildExhaustParts(recipe("exhaust")),
      floor: buildFloorParts(recipe("floor")),
      cockpit: buildCockpitParts(recipe("cockpit")),
      wheels: buildWheelParts(recipe("wheels")),
    };
  }
  function aeroLevelOf(T?: PartsTiers | null): number {
    T = T || {};
    return buildAeroParts(T._visual && T._visual.aero, T.aero != null ? T.aero : 1).lvl;
  }
  function aeroStyleOf(T?: PartsTiers | null): AeroParts {
    T = T || {};
    return buildAeroParts(T._visual && T._visual.aero, T.aero != null ? T.aero : 1);
  }

  // The monocoque span is a CLOSED block whose rear face is a wall the driver's eye
  // (car-local z -0.18) looks into; its z and top edge are depth-raster
  // measurements (f1-game docs/notes/OCCLUSION-PROBE.md §4), not styling.
  const CKPT_MONO_REAR = Object.freeze({ z: 0.45, y: 0.32, w: 0.552, h: 0.16, t: 0.752 });
  function buildSharedChassis(out: MeshOut, c1: Vec3, rideDY: number, noseStations: readonly Station[] | null | undefined,
                              ckpt: boolean | null | undefined, edgeAt: (z: number) => number): void {
    const floor = CHASSIS.floor;
    if (shadeFlags.round) CarShade.floor(out, floor, Math.max(floor.cy + rideDY, 0.052), edgeAt, CARBON, addTri); else addBox(out, floor.cx, Math.max(floor.cy + rideDY, 0.052), floor.cz,
           floor.sx, floor.sy, floor.sz, CARBON);
    const nose: readonly Station[] = noseStations || CHASSIS.nose;
    bodySpan(out, nose[0]!, nose[1]!, c1, 0.022);
    bodySpan(out, nose[1]!, nose[2]!, c1, 0.028);
    const monoR = ckpt ? CKPT_MONO_REAR : CHASSIS.monocoque[1];
    // COCKPIT: the tub the driver sits IN. In body paint it was the flat slab players
    // reported below the steering wheel; carbon is what a real tub is. External
    // builds never take this branch.
    const monoC = ckpt ? CARBON : c1;
    // THE OPENING HAS TO CLEAR THE WHEEL (hands at z 0.17-0.21): the exterior
    // monocoque stops CLOSED at z 0.28 and the aperture carries on from there; the
    // first-person build keeps its one closed span.
    const MONO_APEX_Z = 0.28;
    const monoAt = (z: number): ChassisStation => { const A = CHASSIS.monocoque[0], B = CHASSIS.monocoque[1];
      const f = (A.z - z) / (A.z - B.z), L = (a: number, b: number): number => a + (b - a) * f;
      return { z, y: L(A.y, B.y), w: L(A.w, B.w), h: L(A.h, B.h), t: L(A.t, B.t) }; };
    const monoApex = monoAt(MONO_APEX_Z);
    bodySpan(out, CHASSIS.monocoque[0], ckpt ? monoR : monoApex, monoC, 0.032);
    if (ckpt) return;
    // SPLITTER / TEA-TRAY: the flat blade under the nose ahead of the floor's z 1.30
    // leading edge, and the stem tying it into the chassis. Rides with rideDY.
    addSpan(out, { z: 1.58, y: 0.058 + rideDY, w: 0.36, h: 0.028, t: 0.92 },
                 { z: 1.30, y: 0.062 + rideDY, w: 0.64, h: 0.030, t: 0.96 }, CARBON);
    addBox(out, 0, 0.132 + rideDY, 1.44, 0.10, 0.125, 0.26, CARBON);
    // THE COCKPIT APERTURE. There is no CSG, so the hole comes from HOW the span is
    // built: a tub capped at the seat floor, a rail either side, the well closed
    // behind. Every number is measured off the span's own stations.
    const CK_A = CHASSIS.cockpit[0], CK_B = CHASSIS.cockpit[1];
    const CK_REAR_Z = -0.33;    // behind the headrest; the tub aft of it stays closed
    const CK_FLOOR_Y = 0.47;    // seat floor — the helmet's neck rim sits at 0.490
    const ckAt = (z: number): ChassisStation => { const f = (CK_A.z - z) / (CK_A.z - CK_B.z), L = (a: number, b: number): number => a + (b - a) * f;
      return { z, y: L(CK_A.y, CK_B.y), w: L(CK_A.w, CK_B.w), h: L(CK_A.h, CK_B.h), t: L(CK_A.t, CK_B.t) }; };
    const ckTop = (st: ChassisStation): number => st.y + st.h / 2, ckBot = (st: ChassisStation): number => st.y - st.h / 2;
    const ckOpen = (z: number): number => 0.150 + (0.200 - 0.150) *
      Math.max(0, Math.min(1, (z - CK_REAR_Z) / (CK_A.z - CK_REAR_Z)));   // clamped: unbounded, the
      // forward extension widened it past the tub and left a 16 mm rail
    // tub half-width at any height (the flank leans in linearly from w/2 at the
    // bottom to t*w/2 at the deck)
    const CK_TOP_T = 0.86;
    const ckT = (st: ChassisStation): number => Math.max(st.t, CK_TOP_T);
    const ckFlank = (st: ChassisStation, y: number): number => (st.w / 2) +
      (ckT(st) * st.w / 2 - st.w / 2) * ((y - ckBot(st)) / (ckTop(st) - ckBot(st)));
    const ckSide = (st: ChassisStation): number => ckFlank(st, CK_FLOOR_Y);
    // THE COCKPIT SIDE SWEEPS DOWN toward the front: level at the deck line it buried
    // the VISOR; dropping the front 50 mm puts the rail just under the visor's lower
    // edge (raising the helmet instead would move everything keyed to its y).
    const CK_NOSE_DROP = 0.050;
    const ckRailTop = (st: ChassisStation): number => ckTop(st) -
      CK_NOSE_DROP * ((st.z - CK_REAR_Z) / (CK_A.z - CK_REAR_Z));
    const ckMid = ckAt(CK_REAR_Z);
    // The aperture runs across TWO loft tables (monocoque ahead of z 0.05, cockpit
    // span behind), so it is two segments, each a straight loft.
    const CK_SEGS: [ChassisStation, ChassisStation][] = [[monoApex, monoAt(CK_A.z)], [CK_A, ckMid]];
    // 1. THE TUB UNDER THE OPENING — same flanks, capped at the seat floor.
    const ckLower = (st: ChassisStation): Station => ({ z: st.z, y: (ckBot(st) + CK_FLOOR_Y) / 2, w: st.w,
                               h: CK_FLOOR_Y - ckBot(st), t: ckSide(st) / (st.w / 2) });
    for (const [f0, r0] of CK_SEGS) if (shadeFlags.round) CarShade.cTub(out, [f0, r0].map((st) => Object.assign({}, st, { t: ckFlank(st, ckRailTop(st)) / (st.w / 2), open: ckOpen(st.z), rail: ckRailTop(st) })), CK_FLOOR_Y, c1, addTri); else addSpan(out, ckLower(f0), ckLower(r0), c1);
    // 2. A RAIL EACH SIDE, floor to deck. Explicit corners: a rail's inner face is
    //    vertical while its outer follows the flank inboard.
    for (const sgn of [1, -1]) for (const seg of CK_SEGS) {
      const q: MVec3[] = [];
      for (const st of seg) {
        const rt = ckRailTop(st);
        const xi = sgn * ckOpen(st.z), xo = sgn * ckSide(st), xt = sgn * ckFlank(st, rt);
        q.push([xi, CK_FLOOR_Y, st.z], [xo, CK_FLOOR_Y, st.z], [xt, rt, st.z], [xi, rt, st.z]);
      }
      if (!shadeFlags.round) addBlock(out, q, c1);   // rounded build: the rails are the C of CarShade.cTub above
      // Dark liner on the inner face: a body-paint cockpit wall reads as a painted
      // trough, not a carbon tub.
      const li: MVec3[] = [];
      for (const st of seg) {
        const rt = ckRailTop(st);
        const xi = sgn * ckOpen(st.z), xn = sgn * (ckOpen(st.z) - 0.006);
        li.push([xn, CK_FLOOR_Y, st.z], [xi, CK_FLOOR_Y, st.z], [xi, rt, st.z], [xn, rt, st.z]);
      }
      addBlock(out, li, DARK, null, SURFACES.carbon);
      // 3. COAMING: the padded lip the driver's shoulders sit inside.
      addLoft(out, seg[1].z, sgn * (ckOpen(seg[1].z) + 0.022), ckRailTop(seg[1]) + 0.007, 0.050, 0.016,
                   seg[0].z, sgn * (ckOpen(seg[0].z) + 0.023), ckRailTop(seg[0]) + 0.007, 0.052, 0.016,
              DARK, SURFACES.carbon);
    }
    // 4. THE FLOOR and the rear bulkhead — without them you see the track through
    //    the driver.
    addLoft(out, ckMid.z, 0, CK_FLOOR_Y - 0.006, 2 * ckOpen(ckMid.z), 0.012,
                 monoApex.z, 0, CK_FLOOR_Y - 0.006, 2 * ckOpen(monoApex.z), 0.012, DARK, SURFACES.carbon);
    addBox(out, 0, (CK_FLOOR_Y + ckTop(ckMid)) / 2, ckMid.z + 0.008,
           2 * ckOpen(ckMid.z), ckTop(ckMid) - CK_FLOOR_Y, 0.016, DARK, SURFACES.carbon);
    // 5. The tub AFT of the headrest stays a closed block (a body span).
    bodySpan(out, ckMid, CK_B, c1, 0.028);
  }

  function sidepodStation(side: number, z: number, inner: number, outer: number, innerBottom: number,
                          outerBottom: number, innerTop: number, outerTop: number): MVec3[] {
    return [
      [side * inner, innerBottom, z], [side * outer, outerBottom, z],
      [side * outer, outerTop, z], [side * inner, innerTop, z],
    ];
  }

  function sampleStations<S extends { z: number }>(stations: readonly S[], z: number): S {
    if (z >= stations[0]!.z) return Object.assign({}, stations[0]!, { z });
    if (z <= stations[stations.length - 1]!.z)
      return Object.assign({}, stations[stations.length - 1]!, { z });
    for (let i = 0; i < stations.length - 1; i++) {
      const a = stations[i]!, b = stations[i + 1]!;
      if (z <= a.z && z >= b.z) {
        const t = (a.z - z) / (a.z - b.z), out: Record<string, number> = { z };
        const A = a as unknown as Record<string, number>, B = b as unknown as Record<string, number>;
        for (const key of Object.keys(a)) {
          if (key !== "z") out[key] = A[key]! + (B[key]! - A[key]!) * t;
        }
        return out as unknown as S;
      }
    }
    return Object.assign({}, stations[0]!, { z });
  }

  function sidepodStations(eng: EngineParts, style?: TeamStyle | null): PodStation[] {
    const podWidth = Math.max(0.72, Math.min(1.28, eng.podWidth));
    const shoulder = Math.max(0.76, Math.min(1.28, eng.shoulderHeight));
    const undercut = Math.max(0.72, Math.min(1.38, eng.undercut));
    const coke = Math.max(0.72, Math.min(1.38, eng.coke));
    const tailWidth = Math.max(0.70, Math.min(1.30, eng.tailWidth));
    const inletH = style ? (style.inletH || 0) : 0;
    const inletW = style ? (style.inletW || 0) : 0;
    const undercutD = style ? (style.undercutD || 0) : 0;
    const waistK = style ? (style.waist || 0) : 0;
    const outerFront = 0.66 * podWidth + inletW;
    const outerShoulder = 0.70 * podWidth + inletW * 0.35;
    const outerWaist = (0.58 - 0.08 * (coke - 1)) * podWidth + waistK;
    const outerTail = (0.38 - 0.09 * (coke - 1)) * tailWidth + waistK * 0.35;
    const inletFloor = 0.235 + 0.11 * (undercut - 1);
    const shoulderTop = 0.49 + 0.23 * (shoulder - 1);
    const inletBias = style ? (style.inlet || 0) : 0;
    // THE UNDERCUT: outerBottom sits ABOVE innerBottom at every station and every
    // value of the knob (checked at both clamps), so the pod's belly climbs outboard
    // and daylight shows between it and the floor edge — the defining sidepod shape
    // of every ground-effect car since 2022. The knob deepens it everywhere.
    return [
      { z: 0.62, inner: 0.30, outer: outerFront, innerBottom: inletFloor,
        outerBottom: 0.258 + 0.09 * (undercut - 1) + undercutD * 0.70,
        innerTop: 0.45 + inletBias + inletH, outerTop: 0.46 + inletBias * 0.6 + inletH * 0.85 },
      { z: 0.50, inner: 0.298, outer: outerFront * 0.97 + outerShoulder * 0.03,
        innerBottom: 0.218 + 0.12 * (undercut - 1),
        outerBottom: 0.232 + 0.10 * (undercut - 1) + undercutD * 0.85,
        innerTop: 0.448 + inletBias * 0.55 + inletH * 0.70,
        outerTop: 0.455 + inletBias * 0.35 + inletH * 0.55 },
      { z: 0.22, inner: 0.29, outer: outerShoulder,
        innerBottom: 0.20 + 0.13 * (undercut - 1),
        outerBottom: 0.208 + 0.11 * (undercut - 1) + undercutD,
        innerTop: shoulderTop + inletH * 0.15, outerTop: shoulderTop - 0.015 + inletH * 0.08 },
      { z: -0.38, inner: 0.28, outer: outerShoulder * 0.55 + outerWaist * 0.45,
        innerBottom: 0.162 + 0.10 * (undercut - 1),
        outerBottom: 0.176 + 0.09 * (undercut - 1) + undercutD * 0.55,
        innerTop: shoulderTop * 0.68 + (0.42 + 0.10 * (shoulder - 1)) * 0.32,
        outerTop: (shoulderTop - 0.015) * 0.62 + (0.38 + 0.08 * (shoulder - 1)) * 0.38 },
      { z: -0.62, inner: 0.27, outer: outerWaist,
        innerBottom: 0.14 + 0.08 * (undercut - 1),
        outerBottom: 0.160 + 0.07 * (undercut - 1) + undercutD * 0.35,
        innerTop: 0.42 + 0.10 * (shoulder - 1),
        outerTop: 0.38 + 0.08 * (shoulder - 1) },
      { z: -1.05, inner: 0.25, outer: outerWaist * 0.42 + outerTail * 0.58,
        innerBottom: 0.134, outerBottom: 0.146,
        innerTop: 0.355 + 0.07 * (shoulder - 1),
        outerTop: 0.318 + 0.04 * (shoulder - 1) },
      { z: -1.48, inner: 0.23, outer: outerTail, innerBottom: 0.13,
        outerBottom: 0.134, innerTop: 0.30 + 0.05 * (shoulder - 1), outerTop: 0.27 },
    ];
  }

  const _anchorCache = new WeakMap<object, Map<string, BodyAnchors>>();
  const _anchorNullKey = {};   // stand-in for a null/undefined parts (legacy bodies)
  function bodyAnchors(parts?: PartsTiers | null, teamId?: string | null, spineHeight?: string | null, round?: boolean | null): BodyAnchors {
    const outer = parts || _anchorNullKey;
    let byTeam = _anchorCache.get(outer);
    if (!byTeam) { byTeam = new Map(); _anchorCache.set(outer, byTeam); }
    // A "standard" (or absent) spine keys exactly as before.
    const rise = spineRise(spineHeight);
    const tk = (teamId || "") + (rise ? "|" + spineHeight : "") + (round ? "|r" : "");   // round: the rounded car's coke-bottle shape (CarShade)
    const hit = byTeam.get(tk);
    if (hit) return hit;
    const built = buildBodyAnchors(parts, teamId, rise, round);
    byTeam.set(tk, built);
    return built;
  }

  function buildBodyAnchors(parts?: PartsTiers | null, teamId?: string | null, rise?: number | null, round?: boolean | null): BodyAnchors {
    rise = rise || 0;
    const T: PartsTiers = parts || {};
    const tier = T.engine != null ? T.engine : 1;
    const eng = buildEngineParts(T._visual && T._visual.engine, tier);
    const style = teamStyleOf(teamId);
    const coverHeight = Math.max(0.78, Math.min(1.28, eng.coverHeight));
    const crown = style.coverCrown || 0;
    // Two stations only: a third made coverAt non-linear and broke car-shade.
    // coverCrown pinches x and peaks the profile — it must NOT lift coverAt().top.
    const coverStations: CoverStation[] = [
      { z: -0.55, x: 0.28 * eng.tailWidth * (1 - crown * 0.6),
        bottom: 0.52 + 0.08 * (coverHeight - 1) - 0.31 * coverHeight,
        top: 0.52 + 0.08 * (coverHeight - 1) + 0.31 * coverHeight + rise, k: crown },
      { z: -2.00, x: 0.13 * eng.tailWidth,
        bottom: 0.42 - 0.17 * coverHeight, top: 0.42 + 0.17 * coverHeight + rise * SPINE_TAIL, k: crown * 0.45 },
    ];
    const podStations: readonly PodStation[] = round ? CarShade.downwash(sidepodStations(eng, style), (z: number) => sampleStations(coverStations, z).bottom, eng.coke) : sidepodStations(eng, style);   // rounded: the downwash ramp
    const noseStations: NoseAnchor[] = styledNoseStations(style).map((station) => ({
      z: station.z, side: station.w * 0.5, topSide: station.w * station.t * 0.5,
      bottom: station.y - station.h * 0.5, top: station.y + station.h * 0.5,
    }));
    return {
      key: [eng.podWidth, eng.shoulderHeight, eng.undercut, eng.coke,
            eng.tailWidth, eng.coverHeight, rise,
            style === DEFAULT_STYLE ? "" : (teamId || "")].join(",") + (round ? "|r" : ""),
      podAt(z: number): PodAnchor {
        const p = sampleStations(podStations, z);
        return { z, x: p.outer, inner: p.inner, bottom: p.outerBottom, top: p.outerTop,
                 innerBottom: p.innerBottom, innerTop: p.innerTop };
      },
      coverAt(z: number): CoverStation { const c = sampleStations(coverStations, z); return round ? CarShade.cokeFoot(c, coverStations, eng.coke) : c; },   // rounded: the pinched foot, c.xb
      noseAt(z: number): NoseAnchor { return sampleStations(noseStations, z); },
      podStations: podStations.map((p) => Object.freeze(Object.assign({}, p))),
    };
  }

  // A radiator mouth that reads as a HOLE: a proud lip, four throat walls raking to
  // 70% of the opening over `depth`, and a dark core face at the back of the duct.
  function addInletMouth(out: MeshOut, x: number, y: number, z: number, w: number, h: number, lipC: Vec3,
                         depth?: number | null, lip?: number | null): void {
    const D = depth == null ? 0.055 : depth;
    const L = lip == null ? 0.012 : lip;
    const T = 0.010, K = 0.70;
    // Two bars, not four: the lower edge sits in the undercut and the inboard edge
    // faces the chassis; no camera sees either.
    if (L > 0) {
      addBox(out, x, y + (h + L) * 0.5, z + 0.008, w + L * 2, L, 0.020, lipC, SURFACES.paint);
      addBox(out, x + Math.sign(x) * (w + L) * 0.5, y, z + 0.008, L, h + L * 2, 0.020,
             lipC, SURFACES.paint);
    }
    for (const u of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      addSpan(out,
        { z, x: x + u[0] * w * 0.5, y: y + u[1] * h * 0.5,
          w: u[0] ? T : w, h: u[1] ? T : h },
        { z: z - D, x: x + u[0] * w * 0.5 * K, y: y + u[1] * h * 0.5 * K,
          w: u[0] ? T : w * K, h: u[1] ? T : h * K },
        INTAKE, null, SURFACES.carbon);
    }
    addBox(out, x, y, z - D - 0.008, w * K, h * K, 0.016, DARK);
  }

  function buildSidepodBodywork(out: MeshOut, c1: Vec3, eng: Partial<EngineParts>, anchors?: BodyAnchors | null): SidepodBodywork {
    const data = anchors || bodyAnchors({ engine: 1, _visual: { engine: eng } });
    const stations = data.podStations;
    if (shadeFlags.round) CarShade.podLoft(out, stations, c1, INTAKE, addTri);
    else for (const side of [-1, 1]) {
      addStationLoft(out, stations.map((p) => sidepodStation(side, p.z, p.inner, p.outer,
        p.innerBottom, p.outerBottom, p.innerTop, p.outerTop)), c1, INTAKE);
    }
    const inletP = data.podAt(0.62);
    const shoulderP = data.podAt(0.18);
    const flankP = data.podAt(-0.10);
    const floorP = data.podAt(0.0);
    const conduitP = data.podAt(-0.65);
    const tailP = data.podAt(-1.48);
    return {
      inlet: { z: 0.625, x: (inletP.inner + inletP.x) * 0.5,
               y: (inletP.innerBottom + inletP.innerTop) * 0.5,
               width: inletP.x - inletP.inner, height: inletP.innerTop - inletP.innerBottom },
      shoulder: { x: shoulderP.x + 0.008, y: shoulderP.top - 0.012, z: 0.18 },
      flank: { x: flankP.x + 0.008, y: (flankP.bottom + flankP.top) * 0.5, z: -0.10 },
      floorEdge: { x: floorP.x + 0.012, y: floorP.bottom + 0.012 },
      conduit: { x: conduitP.x + 0.012, y: conduitP.top + 0.018, z: -0.65 },
      tail: { x: tailP.x, y: (tailP.bottom + tailP.top) * 0.5, z: -1.48 },
    };
  }

  function buildEngineCoverBodywork(out: MeshOut, c1: Vec3, accentC: Vec3, eng: Pick<EngineParts, "coverHeight" | "tailWidth">,
                                    anchors: BodyAnchors, rise?: number | null, sideMark?: unknown,
                                    trimAft?: number | null): EngineCoverBodywork {
    const coverHeight = Math.max(0.78, Math.min(1.28, eng.coverHeight));
    rise = rise || 0;
    // t 0.72, not 0: a zero-width knife crown left the shark fin nothing to stand on
    // and floated every detail anchored off coverAt(z).x. 0.72 makes the crown as
    // wide as the crest decal painted on it. The spine lift is TOP-ONLY (centre up
    // by half, height up by the whole), matching bodyAnchors' coverStations top line.
    const front: CoverBox = { z: -0.55, y: 0.52 + 0.08 * (coverHeight - 1) + rise / 2,
                    w: 0.56 * eng.tailWidth, h: 0.62 * coverHeight + rise, t: 0.72 };
    const rear: CoverBox = { z: -2.00, y: 0.42 + rise * SPINE_TAIL / 2, w: 0.26 * eng.tailWidth,
                   h: 0.34 * coverHeight + rise * SPINE_TAIL, t: 0.70 };
    // The loft is three stacked blocks over coverProfile's four KEYS at the two
    // anchor stations. Rounded garage/near densifies the CROSS-SECTION only.
    const pf = coverProfile(anchors.coverAt(front.z)), pr = coverProfile(anchors.coverAt(rear.z));
    const loftKeys = (c: CoverStation): { pts: readonly (readonly [number, number])[] } => { const p = coverProfile(c); return { pts: p.keys || p.pts }; };
    if (shadeFlags.round) {
      CarShade.coverLoft(out, anchors, shadeFlags.coverHi ? ((c: CoverStation) => coverProfile(c, true)) : loftKeys,
        front.z, rear.z, c1, addTri);
    } else for (let k = 0; k < 3; k++) {
      const ring = (p: CoverProfile, z: number): MVec3[] => {
        const q = p.keys || p.pts;
        return [[-q[k]![0], q[k]![1], z], [q[k]![0], q[k]![1], z],
                [q[k + 1]![0], q[k + 1]![1], z], [-q[k + 1]![0], q[k + 1]![1], z]];
      };
      addBlock(out, ring(pf, front.z).concat(ring(pr, rear.z)), c1, c1);
    }
    // The accent pinstripe runs the flank just under the crease; with a mark on the
    // spine side it starts aft of the MARK (a crown that moved the design hands its
    // own station in trimAft). COVER_STACK.flankTrim keeps it out of the decal plane.
    const stripeFront = anchors.coverAt(trimAft || (sideMark ? -1.26 : -0.825)), stripeRear = anchors.coverAt(-1.675);
    // The pinstripe runs the flank just under the shoulder crease, ON the skin.
    const sfY = coverProfile(stripeFront).shoulder - 0.03, srY = coverProfile(stripeRear).shoulder - 0.025;
    for (const side of [-1, 1]) {
      addSpan(out,
        { z: stripeFront.z, x: side * (coverFlankX(stripeFront, sfY) + COVER_STACK.flankTrim - 0.005), y: sfY,
          w: 0.010, h: 0.012 },
        { z: stripeRear.z, x: side * (coverFlankX(stripeRear, srY) + COVER_STACK.flankTrim - 0.005), y: srY,
          w: 0.010, h: 0.012 }, accentC);
    }
    const mid = anchors.coverAt(-1.30);
    return {
      front, rear,
      coolingX: Math.max(0.08, mid.x * 0.78),
      coolingY: mid.top - 0.12,
      tailVentY: rear.y + rear.h * 0.20,
    };
  }

  return {
    styledNoseStations, bodySpan, haloHoopPath,
    endplateGeom, wingOf, wingFoilOf, frontCascade, frontBakedCount, frontHalf, frontPlateGeom,
    noseUnderAt, elemPoint, elemRecord, elemTopAt, hinged, flapSig, aeroFlapsGeom, solveFlapsGeom,
    buildFlapGeom, aeroFlapAim, wingBandGeom, numberBoard,
    FIN_SHAPES, FIN_SHAPE_IDS, FIN, sharkFinRoot, sharkFinPanel, sharkFinBadge, finOf, finTop,
    COVER_VENT_IDS, SPINE_HEIGHT_IDS, spineRise, COVER_STACK,
    coverProfile, coverFlankX, coverSurfaceY,
    mirrorLightAnchors, cockpitMirrorGlass,
    buildPartRecipes, aeroLevelOf, aeroStyleOf,
    buildSharedChassis, sidepodStation, sampleStations, sidepodStations,
    bodyAnchors, buildBodyAnchors, addInletMouth,
    buildSidepodBodywork, buildEngineCoverBodywork,
    REAR_TYRE_CROWN, REAR_WING_TOP, FW_MOVEABLE, FW_SPAN, WING_BAND,
    CAR_HALF, COVER_CROWN, COVER_SHOULDER, COVER_DROP,
  };
}

export type CarBodyGeomApi = ReturnType<typeof create>;
export const CarBodyGeom = Object.freeze({ create });
