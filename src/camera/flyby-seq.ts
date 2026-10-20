/**
 * FLYBY SHOT SEQUENCER: the pre-race loading screen's camera. Ported verbatim
 * from f1-game js/camera/flyby-seq.js:1-2065 (`FlybySeq`).
 *
 * WHAT IT REPLACES. The menu camera was one continuous crawl: `s` advanced with
 * the wall clock and camVantage("cinematic") solved a broadcast rig around it.
 * That rig has no idea what is standing beside the track — its only lateral
 * guard, `corr`, is applied on STREET circuits and is Infinity everywhere else —
 * so on an open circuit the eye sat 22 m off the racing line and flew through
 * whatever was there. Reported as "the flyby goes through a building".
 *
 * WHAT A SHOT IS. A list of shots, each a move from one camera pose to another
 * over a duration. Poses are TRACK-RELATIVE and anchored on landmarks, never on
 * world coordinates:
 *
 *   { at: "start"|"pole"|"grid"|"corner", n, off, x, y }   along the lap
 *   { at: "centre", bear, distR, yR }                      the whole circuit
 *   { at: "landmark", rank, bear, distK, yK }              this circuit's own
 *
 *   off     metres of arc from the anchor, signed along the racing direction
 *   x       lateral metres, + is right of the centreline — EXCEPT at a corner,
 *           where + is the OUTSIDE of that corner, whichever way it turns
 *   y       metres above the road surface at that point
 *   n       a corner by number, or by ROLE: "first" | "mid" | "late"
 *   bear    radians around the anchor, 0 = FACING THE TRACK: for `centre` the
 *           side the start line is on, for `landmark` the side its nearest
 *           stretch of track is on
 *   distR/yR   multiples of the LAP's radius — one establishing shot fits any circuit
 *   distK/yK   multiples of the LANDMARK's own size — one shot fits a tower or a stand
 *
 * That is what makes one shot list mean the same thing on every circuit: "rise
 * up the middle of the grid" is the same instruction at Monza and at Monaco.
 * It is also why bearings and corner sides are RELATIVE. A world bearing names
 * a different picture at every circuit — the same `bear: 0.55` looked down on
 * Monza's towers against bare grass, with no sky and no track in frame — and a
 * fixed lateral sign put corner shots on the INSIDE at some circuits, peering
 * through trunks and lamp posts (Monaco's hairpin from its apex). "From the
 * track side" and "from the outside of the turn" port; a number does not.
 *
 * CLEARANCE. Every built circuit carries a registry of its scenery as
 * world-space boxes (`track.props`), which is how a camera can finally be told
 * it is inside a building. `clearEye` lifts the eye over anything solid it
 * lands in. It is a floor under authoring mistakes, not a substitute for
 * framing a shot properly.
 *
 * Port notes (deviations are structural, never numeric):
 * - The IIFE's module state (player slot, grid size, flyby length, the last
 *   cut, the hero car, warm generation) lives in an instance made by
 *   `createFlybySeq(deps)`. f1-game's per-track caches (`track._fb*`) are a
 *   WeakMap keyed by the track inside that instance; `cornerList(track)`
 *   replaces free-cam.js's / trackside.js's direct `track._fbCorners` read.
 * - Track geometry is the track lane's port (src/track/core: sample, project,
 *   wallAt, terrainY; line.ts `at` for TrackLine.at). CircuitLore is
 *   src/data/circuit-lore. Everything else is injected (FlybyDeps):
 *   TrackMaps.corners (TODO(lane-shell)), DrivingLine.speedAt
 *   (TODO(lane-render)), prefers-reduced-motion and the #loading presentation
 *   sink (TODO(lane-shell)).
 * - Camera only: nothing here feeds player input. The one write outside the
 *   camera is driveHero(), which moves the MENU field's display model of the
 *   player through a corner shot (flyby-seq.js:1052-1091); the shell must hand
 *   it menu display records, never the sim's CarState (the arc rule).
 */
import { forId as loreForId } from "../data/circuit-lore";
import { at as lineAt } from "../track/core/line";
import { project as trackProject, sample as trackSample, terrainY as trackTerrainY, wallAt as trackWallAt } from "../track/core/tracks";
import type { BuiltDef } from "../track/core/def";
import type { Sample, Track } from "../track/core/types";
import * as FlybySight from "./flyby-sight";
import type { FrameJudgement, SightBox, SightSubject } from "./flyby-sight";

export type Vec3 = [number, number, number];

/** One prop-registry record (src/track/scenery/ctx.ts PropRecord, the fields read here). */
export interface PropRec {
  readonly kind: string;
  readonly x: number; readonly y: number; readonly z: number;
  readonly w: number; readonly h: number; readonly d: number;
  readonly fill?: number | undefined;
}
/** One linear-feature span (src/track/scenery/ctx.ts SpanRecord, the fields read here). */
export interface SpanRec {
  readonly kind: string;
  readonly s0: number; readonly s1: number;
  readonly side: number;
  readonly gap?: number | undefined;
  readonly h?: number | undefined;
}
/** A built track as the cameras read it: the track core plus the scenery's registry (build-props.js:450). */
export interface FlybyTrack extends Track {
  props?: { readonly list?: readonly PropRec[]; readonly spans?: readonly SpanRec[] } | null;
}

/** One measured corner (js/ui/track-maps.js:139 cornerAt): `f` lap fraction of the apex, `r` its radius. */
export interface FlybyCorner { readonly f: number; readonly r: number }

/** A camera pose (header). Every field optional, as authored. */
export interface FlybyPose {
  at?: string;
  n?: number | string;
  off?: number; x?: number; y?: number;
  bear?: number; distR?: number; yR?: number;
  rank?: number; distK?: number; yK?: number;
}
/** One shot: a move from eye[0]/look[0] to eye[1]/look[1] over `dur` of the flyby. */
export interface FlybyShot {
  id?: string;
  dur?: number;
  ease?: string;
  sway?: number;
  eye: FlybyPose[];
  look: FlybyPose[];
  fov?: number[];
}

/** The menu field's display record of a car (game.js menuGridCars). Never the sim's CarState. */
export interface HeroCar {
  isPlayer?: boolean;
  s: number; x: number; px: number; pz: number; speed: number;
  xVis?: number | undefined;
  rPrevS?: number | undefined; rPrevX?: number | undefined;
  rPrevPx?: number | undefined; rPrevPz?: number | undefined;
}

export interface FlybyPresentation { dip: number; dipMs: number; sectors: number }

export interface FlybyDeps {
  /** TrackMaps.corners(def) (js/ui/track-maps.js:314). TODO(lane-shell): TrackMaps is not ported; absent = no corners. */
  readonly corners?: ((def: BuiltDef) => readonly FlybyCorner[] | null | undefined) | null;
  /** DrivingLine.speedAt (js/render/shared/driving-line.js:215). TODO(lane-render); absent = the hero stays parked. */
  readonly speedAt?: ((s: number) => number | null) | null;
  /** matchMedia("(prefers-reduced-motion: reduce)").matches (flyby-seq.js:1215). TODO(lane-shell). */
  readonly reducedMotion?: (() => boolean) | null;
  /** syncPresentation's sink (flyby-seq.js:1509); `loadingPresenter(el)` is the f1-game body. TODO(lane-shell). */
  readonly present?: ((p: FlybyPresentation, cut: boolean) => void) | null;
  /** CircuitLore.forId; defaults to src/data/circuit-lore. */
  readonly lore?: ((id: string) => { readonly corner?: string } | null) | null;
}

/** The pooled solve() result (flyby-seq.js:1050). */
export interface FlybyFrame {
  eye: Vec3; tgt: Vec3; fov: number; index: number; id: string; cut: boolean; lift: number; corner: number;
}

/** A shot's plan (flyby-seq.js:2007). */
export interface FlybyPlan {
  eye: FlybyPose[]; look: FlybyPose[]; prof: Float32Array; onRoad: boolean; frac: number; secs: number;
  squeeze: number; slot: number; rows: number; framing: number; fovK: number; fast: boolean; tried: MoveJudgement[];
}

/** judgeMove()'s worst-of-the-move record (flyby-seq.js:1694). */
export interface MoveJudgement {
  cost: number; near: number; nearSubj: number; inside: boolean; ground: number; mixCost: number;
  inF: number; vis: number; cover: number | null; ok: boolean;
}

export interface FlybyBounds { x: number; y: number; z: number; rad: number; pts: Vec3[]; face: number }

type Framing = FlybyPose[] & { tier?: number; fovK?: number; aim?: number };
interface PlannedEye { eye: FlybyPose[]; prof: Float32Array }
interface Fin { pe: PlannedEye; k: number; fast: boolean; look: FlybyPose[] }

const newSample = (): Sample => ({ p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 10 });
/** `v | 0` on an authored field that may be a role string or absent (JS ToInt32). */
const int = (v: unknown): number => (v as number) | 0;

// The grid, from js/track/core/mesh.js gridSlot(): pole sits POLE_BACK metres
// before the line and the rows are GRID_SPACING apart. Duplicated as named
// constants rather than imported because TrackMesh is not loaded in the node
// tests that check these shots, and a wrong number here is a framing bug, not
// a crash — the unit test pins them against mesh.js.
export const POLE_BACK = 14, GRID_SPACING = 8, GRID_ROWS = 20;
const PLAYER_SLOT_DEFAULT = 11;

/* HOW THE FLYBY IS RENDERED, not where it is pointed — and the reason those
 * two live in the same file. The shots are VISTAS: a crane 190 m up looking
 * down a 5.8 km circuit is nothing like a chase cam 8 m behind a car, so the
 * cinematic renders with the far plane pushed out and the fog thinned, the
 * way photo mode does.
 *
 * BOTH ENDS READ THESE: the live screen (js/game.js's flyby branch) and the
 * EDITOR's preview (__apex.flybyCam, through dbgCam). With separate far clip
 * and fog (6000 m / 15 % vs gameplay's 900 m / 100 %) the same shot is clear
 * in the editor and a wall of haze on the loading screen. */
export const FAR = 6000;               // metres of far clip — a whole circuit, not a corner
export const FOG = 0.15;               // × the session's fog density (photo mode's value)
// Near plane. Pinned rather than inherited: gameplay picks 0.3 for cockpit and
// hood (the wheel sits 0.46 m from the eye) and 0.9 for everything else, so a
// flyby would have taken whichever camera MODE the player last raced in —
// the same shot rendered with two different depth budgets. Nothing is within
// a metre of a crane, and 0.9:6000 is the better ratio of the two.
export const NEAR = 0.9;

/** Props that a camera must not be inside. The registry also records ridges,
 *  bushes and sparse `structure` hulls whose `fill` says they are mostly air
 *  (a 56 m x 1.3 m "structure" at 5 % fill is a run of kerbing, not a wall);
 *  treating those as solid would shove the camera into the sky on every shot. */
const SOLID = ["building", "grandstand", "tower", "motorhome", "gantry", "pit", "garage"];
export const MIN_FILL = 0.25;          // a `structure` below this is scattered parts, not a mass
export const MIN_H = 3;                // and anything shorter than this cannot swallow a camera

/** flyby-seq.js:111 */
export function isSolid(r: PropRec | null | undefined): boolean {
  if (!r || !(r.h >= MIN_H)) return false;
  if (SOLID.indexOf(r.kind) !== -1) return true;
  return r.kind === "structure" && (r.fill || 0) >= MIN_FILL;
}

/** THE ROAD IS ALWAYS CLEAR, so a shot that runs down it is never lifted.
 *  The props registry stores AXIS-ALIGNED boxes, and a long structure at an
 *  angle to the world axes gets a box far bigger than itself: Bahrain's main
 *  grandstand is 143 m long and lies at an angle, so its box reaches across
 *  the start straight. The closing shot, 0.85 m up the centreline, was
 *  therefore "inside a grandstand" and got lifted 21 m into a crane — the one
 *  shot whose whole point is being low. Cars drive that line at 300 km/h; if
 *  the geometry says a camera cannot be there, the geometry is wrong.
 *  flyby-seq.js:192 */
export function onRoadPose(pose: FlybyPose | null | undefined): boolean {
  return !!pose && pose.at !== "centre" && pose.at !== "landmark" &&
    Math.abs(pose.x || 0) <= 8 && (pose.y || 0) <= 6;
}

/** LIFT, never shove sideways (flyby-seq.js:197-201). */
const CLEAR_M = 2.5;            // metres over a roof the eye is lifted to

// ---- easing --------------------------------------------------------------

export const EASE: Readonly<Record<string, (u: number) => number>> = {
  linear: (u) => u,
  in: (u) => u * u,
  out: (u) => 1 - (1 - u) * (1 - u),
  inOut: (u) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u)),
};
const easeOf = (name: string | undefined): ((u: number) => number) => (name !== undefined && EASE[name]) || EASE["inOut"]!;

function trackAnchored(p: FlybyPose | null | undefined): boolean {
  return !!p && p.at !== "centre" && p.at !== "landmark";
}

// ---- the shipped sequence ------------------------------------------------

/* NINE SHOTS OVER FLY_MS (24 s), ~2.4-3.1 s each. Durations stay fractions
   so retuning the budget rebalances all of them rather than truncating the
   last.

   PANS ARE SLOW AND SHORT. The first cut swung 0.45 rad in 1.2 s and read as a
   camera being yanked; the same 0.2 rad over 3 s reads as a crane.

   EVERY SHOT HAS A SUBJECT, and the bearings/sides are the relative ones the
   header describes, so the subject is the same thing on every circuit:
     wide        the start straight in the foreground, the lap behind it
     wide2       the far side of the lap, lower and closer
     landmark1/2 this circuit's own buildings, from the TRACK side, low,
                 looking UP so they stand against the sky with the circuit
                 in front of them (looking DOWN from above their centre
                 gives towers against grass, no horizon, no track)
     turn-*      from the OUTSIDE of the turn, raised like a trackside stand
     grid-crane  up behind the back row: the whole field, long lens
     grid        up the aisle between the columns, ending among the front
                 rows with the start gantry ahead
   flyby-seq.js:906-1040 */
export const DEFAULT: FlybyShot[] = [
  // ---- establish: where are we -------------------------------------------
  {
    id: "wide", dur: 0.09, ease: "inOut", sway: 0.35,
    eye: [{ at: "centre", bear: -0.30, distR: 1.10, yR: 0.36 },
          { at: "centre", bear: -0.12, distR: 1.00, yR: 0.32 }],
    look: [{ at: "centre", distR: 0, yR: 0 }, { at: "centre", distR: 0, yR: 0 }],
    fov: [36, 38],
  },
  {
    id: "wide2", dur: 0.08, ease: "inOut", sway: 0.25,
    eye: [{ at: "centre", bear: 2.35, distR: 0.80, yR: 0.30 },
          { at: "centre", bear: 2.55, distR: 0.70, yR: 0.25 }],
    look: [{ at: "centre", distR: 0, yR: 0 }, { at: "centre", distR: 0, yR: 0 }],
    fov: [36, 39],
  },
  // ---- this circuit in particular ----------------------------------------
  {
    id: "landmark1", dur: 0.09, ease: "inOut",
    eye: [{ at: "landmark", rank: 0, bear: -0.28, distK: 1.7, yK: -0.15, y: 12 },
          { at: "landmark", rank: 0, bear: -0.08, distK: 1.5, yK: -0.1, y: 12 }],
    look: [{ at: "landmark", rank: 0, distK: 0, yK: 0.2 }, { at: "landmark", rank: 0, distK: 0, yK: 0.25 }],
    fov: [38, 40],
  },
  {
    id: "landmark2", dur: 0.08, ease: "inOut",
    eye: [{ at: "landmark", rank: 1, bear: 0.30, distK: 1.8, yK: -0.1, y: 12 },
          { at: "landmark", rank: 1, bear: 0.10, distK: 1.6, yK: -0.05, y: 12 }],
    look: [{ at: "landmark", rank: 1, distK: 0, yK: 0.15 }, { at: "landmark", rank: 1, distK: 0, yK: 0.2 }],
    fov: [38, 41],
  },
  // ---- the corners you will actually drive --------------------------------
  {
    id: "turn-first", dur: 0.09, ease: "inOut",
    eye: [{ at: "corner", n: "first", off: -60, x: 16, y: 9 },
          { at: "corner", n: "first", off: 0, x: 18, y: 8 }],
    look: [{ at: "corner", n: "first", off: -12, x: 0, y: 0.6 },
           { at: "corner", n: "first", off: 30, x: 0, y: 0.6 }],
    fov: [38, 42],
  },
  {
    id: "turn-mid", dur: 0.09, ease: "inOut",
    eye: [{ at: "corner", n: "lore", off: -35, x: 16, y: 9 },
          { at: "corner", n: "lore", off: 0, x: 18, y: 8 }],
    // Held on the APEX and 20 m past it, not 15-55 m down the road: the lore
    // corner is often the slowest one, and past a 10 m hairpin that aim swung
    // behind the camera (frame-report, 16 circuits: 40 -> 52; renders agree).
    // An apex aim once filmed a kerb from above from a fence-line camera;
    // 16-18 m out and 8-9 m up, this one keeps the whole bend and its exit.
    look: [{ at: "corner", n: "lore", off: 0, x: 0, y: 0.6 },
           { at: "corner", n: "lore", off: 20, x: 0, y: 0.6 }],
    fov: [42, 44],
  },
  {
    id: "turn-late", dur: 0.09, ease: "inOut",
    eye: [{ at: "corner", n: "fastest", off: -35, x: 13, y: 6 },
          { at: "corner", n: "fastest", off: 20, x: 14, y: 5 }],
    look: [{ at: "corner", n: "fastest", off: 5, x: 0, y: 0.6 },
           { at: "corner", n: "fastest", off: 45, x: 0, y: 0.6 }],
    fov: [40, 43],
  },
  // ---- and then the grid you start from ------------------------------------
  // The road draws without slope-scaled depth bias (PR #248), so the grid can
  // be filmed from ahead of pole.
  {
    id: "grid-walk", dur: 0.08, ease: "inOut",
    // THE GRID WALK: head height, a slow dolly up the aisle between the
    // staggered rows (the pole anchor is the centreline) — the TV walk before
    // the formation lap. Numbered slots: a grid too small to fill them (time
    // trial, duel) leaves it out.
    // FROM THE BACK HALF, looking up the field: walked from between rows 5
    // and 6 it kept 20-26 % of the grid in frame on every circuit (frame
    // report, 2026-10-04) — the rest were behind the lens. From behind row
    // 14, 14-15 of the 22 are ahead of it, stacked up towards the lights.
    // The look stays on ONE column (slots 4 and 2, both left): 4 -> 3
    // crossed the aisle mid-shot, a 6 m lateral swing no squeeze can slow.
    eye: [{ at: "pole", off: -118, x: 0, y: 1.7 }, { at: "pole", off: -110, x: 0, y: 1.7 }],
    look: [{ at: "slot", n: 4, off: 0, x: 0, y: 0.6 }, { at: "slot", n: 2, off: 0, x: 0, y: 0.6 }],
    fov: [50, 46],
  },
  {
    id: "grid-crane", dur: 0.09, ease: "inOut",
    // A slow crane up behind the back row, long lens: the whole field stacked
    // up towards the lights.
    // On the aisle's line and tight behind the last row: from 6 m left and
    // 38 m back, Bahrain's crane stood by the final bend and filmed its
    // trackside hoarding across two thirds of the frame.
    eye: [{ at: "grid", off: -16, x: -1, y: 2.2 }, { at: "grid", off: -8, x: 0, y: 5.8 }],
    // Aimed at MID-GRID, not at pole: a grid that runs out of the final bend
    // (Bahrain's) puts pole round the corner, and the sightline to it crossed
    // the grandstand on the inside of the curve.
    look: [{ at: "grid", off: 45, x: 0, y: 0.8 }, { at: "grid", off: 85, x: 0, y: 0.8 }],
    fov: [30, 32],
  },
  {
    id: "grid-front", dur: 0.10, ease: "inOut",
    // THE FRONT ROW, FROM THE START LINE, looking back down the grid: pole
    // big in frame and the field stacked behind it. Close and a little off
    // the aisle — measured with frame-report across eight circuits, 40+ m
    // out on a long lens left the cars at 1-2 % of the frame and put the
    // eye inside Bahrain's and Istanbul's main grandstands.
    eye: [{ at: "pole", off: 14, x: 3.5, y: 2.2 }, { at: "pole", off: 10, x: 2.5, y: 1.8 }],
    look: [{ at: "pole", off: -12, x: 0, y: 0.6 }, { at: "pole", off: -12, x: 0, y: 0.6 }],
    fov: [40, 40],
  },
  {
    id: "grid-mine", dur: 0.12, ease: "out",
    // YOUR CAR, in the slot the race starts you from (menuGridCars seats the
    // field as gridUp will, and tells FlybySeq which slot is yours): a low
    // push-in from two rows back that settles just behind the car, looking
    // past it at the lights — the frame the race's own camera takes over from.
    eye: [{ at: "slot", n: "player", off: -22, x: 0, y: 1.9 }, { at: "slot", n: "player", off: -9, x: 0, y: 1.5 }],
    look: [{ at: "slot", n: "player", off: 6, x: 0, y: 0.9 }, { at: "start", off: 30, x: 0, y: 1.2 }],
    fov: [36, 40],
  },
];
export const GRID_SHOTS: readonly FlybyShot[] = Object.freeze(DEFAULT.filter((shot) => /^grid/.test(shot.id || "")));
/** flyby-seq.js:1042 */
export function gridProgress(lightsLit: number): number {
  const lit = Math.max(1, Math.min(3, lightsLit | 0));
  return (lit - 0.5) / 3;
}

/** WHICH SHOT IS ON AIR at flyby progress `u`, and how far through it (0..1)
 *  — the cut arithmetic solve() uses, with none of its planning, so a caller
 *  that only needs the shot's NAME (the loading card's grid graphic and its
 *  radio check, js/ui/loading-screen.js) pays nothing for it. Pure: binding
 *  corners and the landmark fallback never change an id or a duration.
 *  flyby-seq.js:1149 */
export function shotAt(u: number, shots?: readonly FlybyShot[] | null): { index: number; id: string; t: number; total: number } {
  const list = (shots && shots.length) ? shots : DEFAULT;
  let total = 0;
  for (let i = 0; i < list.length; i++) total += list[i]!.dur || 0;
  if (!(total > 0)) total = 1;
  const at = Math.max(0, Math.min(1, +u || 0)) * total;
  let idx = 0, acc = 0;
  for (; idx < list.length - 1; idx++) {
    if (at < acc + (list[idx]!.dur || 0)) break;
    acc += list[idx]!.dur || 0;
  }
  const dur = list[idx]!.dur || 1;
  return { index: idx, id: list[idx]!.id || String(idx), t: Math.max(0, Math.min(1, (at - acc) / dur)), total };
}
/** Progress through `list` at the midpoint of `turn-first`. Hidden picker
 *  presents (game.js flybyProgress while `_menuGate.warm`) use this instead
 *  of 0: the opening `wide` shot is a whole-circuit look that level() aims
 *  at the horizon, so u=0 no longer draws the road/prop batches those frames
 *  exist to compile (track-switch-memory anti-vacuity: 39 ROs on llvmpipe).
 *  A list without that id (an edited sequence) keeps 0. flyby-seq.js:1168 */
export function warmProgress(list?: readonly FlybyShot[] | null): number {
  const l = (list && list.length) ? list : DEFAULT;
  let tot = 0;
  for (let i = 0; i < l.length; i++) tot += l[i]!.dur || 0;
  if (!(tot > 0)) return 0;
  let acc = 0;
  for (let i = 0; i < l.length; i++) {
    const d = l[i]!.dur || 0;
    if (l[i]!.id === "turn-first") return (acc + 0.5 * d) / tot;
    acc += d;
  }
  return 0;
}
/** flyby-seq.js:1482 */
export function boundaries(shots?: readonly FlybyShot[] | null): number[] {
  const list = (shots && shots.length) ? shots : DEFAULT;
  let total = 0;
  for (const shot of list) total += shot.dur || 0;
  if (!(total > 0)) return [];
  const out: number[] = []; let acc = 0;
  for (let i = 0; i < list.length - 1; i++) { acc += list[i]!.dur || 0; out.push(acc / total); }
  return out;
}
/** flyby-seq.js:1504 */
export function swayAt(shot: FlybyShot | null | undefined, t: number, reduced: boolean): number {
  if (reduced || !(shot && (shot.sway || 0) > 0)) return 0;
  return shot.sway! * Math.sin(Math.max(0, Math.min(1, t)) * Math.PI * 2);
}

/** The pan budget's reference flyby length (flyby-seq.js:1452), seconds. */
export const REF_S = 20;
export const PAN_MAX = 25 * Math.PI / 180, PARA_MAX = 30 * Math.PI / 180;
/** The street-circuit fence cap (flyby-seq.js:626), metres beyond the barrier line. */
export const FENCE = 1.5;

/** syncPresentation (flyby-seq.js:1508-1519) bound to the loading screen's
 *  element: the shell passes the result as `deps.present`. */
export function loadingPresenter(el: HTMLElement | null): (p: FlybyPresentation, cut: boolean) => void {
  let dipTimer: ReturnType<typeof setTimeout> | undefined;
  return (p, cut) => {
    if (!el || !el.dataset || el.dataset["phase"] !== "run") return;
    el.dataset["sectors"] = p.sectors > 0 ? p.sectors.toFixed(3) : "";
    if (!cut) return;
    el.dataset["dip"] = "";
    if (el.animate) el.animate([{ opacity: 1 }, { opacity: 0.78 }, { opacity: 1 }], { duration: p.dipMs, easing: "ease-in-out" });
    clearTimeout(dipTimer);
    dipTimer = setTimeout(() => { if (el.dataset) delete el.dataset["dip"]; }, p.dipMs);
  };
}

/** Per-track caches (f1-game hangs each on the track as `_fb*`). */
interface FbCache {
  solid?: PropRec[];
  solidGrid?: Map<number, number[]>;
  corners?: readonly FlybyCorner[];
  landmarks?: PropRec[];
  lmBase?: Map<PropRec, number>;
  bounds?: FlybyBounds;
  filmable?: boolean[];
  bind?: WeakMap<readonly FlybyShot[], FlybyShot[]>;
  boundShot?: WeakMap<FlybyShot, Record<number, FlybyShot>>;
  lmFace?: Map<PropRec, number>;
  lmNear?: Map<PropRec, number>;
  cornerSide?: Record<string, number>;
  trees?: PropRec[];
  treeGrid?: Map<number, number[]>;
  fallback?: WeakMap<FlybyShot, FlybyShot>;
  subj?: WeakMap<FlybyShot, { n: number; subj: SightSubject | null }>;
  plan?: WeakMap<FlybyShot, FlybyPlan>;
}

/** One sequencer: the flyby-seq.js IIFE body, its module state per instance. */
export function createFlybySeq(deps: FlybyDeps = {}) {
  const caches = new WeakMap<object, FbCache>();
  const cacheOf = (track: FlybyTrack): FbCache => {
    let c = caches.get(track);
    if (!c) caches.set(track, c = {});
    return c;
  };
  const loreOf = deps.lore || ((id: string) => loreForId(id));

  /* THE PLAYER'S OWN SLOT. gridUp() (js/game.js) seats the local player at P12
     (slot 11) unless a qualifying order exists, and menuGridCars() seats the
     flyby's field the same way and tells us here — so `{ at: "slot", n:
     "player" }` is the car the race is about to start from, not a stranger. */
  let _playerSlot = PLAYER_SLOT_DEFAULT;
  let _slotKnown = true;
  /** `null` = the race's grid cannot be known before it forms (a random grid):
   *  slotKnown() goes false and vary() leaves the grid-mine shot out. */
  /** `n` = cars on the grid (a time trial seats one, a duel two): a shot aimed
   *  at a NUMBERED slot past it would film an empty box, so it is left out. */
  let _gridSize = 22;
  function setPlayerSlot(k: number | null | undefined, n?: number | null): void {
    _slotKnown = k !== null; _playerSlot = (k != null && k >= 0 && k === (k | 0)) ? k : PLAYER_SLOT_DEFAULT;
    _gridSize = n != null && n > 0 ? n | 0 : 22;
  }
  function slotKnown(): boolean { return _slotKnown; }
  const slotPoses = (shot: FlybyShot): FlybyPose[] => [shot.eye[0], shot.eye[1], shot.look[0], shot.look[1]].filter((p): p is FlybyPose => !!p && p.at === "slot");
  const usesSlot = (shot: FlybyShot): boolean => slotPoses(shot).length > 0;
  const usesGrid = (shot: FlybyShot): boolean => [shot.eye[0], shot.eye[1], shot.look[0], shot.look[1]].some((p) => p && p.at === "grid");
  /** Can this grid play the shot? Your car needs a known slot; a numbered slot needs a car in it. */
  const fitsGrid = (shot: FlybyShot): boolean => slotPoses(shot).every((p) => (p.n === "player" || p.n === undefined) ? _slotKnown : int(p.n) < _gridSize);
  function slotIndex(pose: FlybyPose): number { return pose.n === "player" || pose.n === undefined ? _playerSlot : Math.max(0, int(pose.n)); }
  /** gridSlot()'s stagger (js/track/core/mesh.js): even slots left, odd right,
   *  min(0.4 hw, 3) m off the centreline — pinned against mesh.js by the test. */
  const _gs = newSample();
  function slotX(track: FlybyTrack, k: number, s: number): number {
    trackSample(track, s, _gs);
    return (k % 2 === 0 ? -1 : 1) * Math.min((_gs.hw || 7) * 0.4, 3);
  }

  /** The solid subset, computed once per built track and cached ON the track, so
   *  it dies with the world it describes rather than in a map nobody clears. */
  function blockers(track: FlybyTrack): PropRec[] {
    const C = cacheOf(track);
    if (C.solid) return C.solid;
    const out: PropRec[] = [];
    const list = track.props && track.props.list;
    if (list) for (let i = 0; i < list.length; i++) if (isSolid(list[i])) out.push(list[i]!);
    C.solid = out;
    return out;
  }

  /** The record containing this point, or null. Boxes are centre + size, and the
   *  margin inflates them so the eye clears a facade rather than grazing it. */
  /* A GRID INDEX over a box list, so a clearance test touches the few boxes
     near a point instead of every one. The planner tests every sample of every
     candidate eye against every solid and every tall tree; Monza's turn-first
     (~1,500 trees) took 1.35 s to plan and Suzuka's up to 3.4 s — a freeze at
     the cut, on every load now that vary() builds new shots. Candidates come
     back in LIST ORDER, which both tests depend on (first hit; sequential
     lifts), so a plan is identical to the full scan. */
  const GRID_CELL = 32;
  function boxGrid(list: readonly PropRec[]): Map<number, number[]> {
    const cells = new Map<number, number[]>();
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      const x0 = Math.floor((r.x - r.w / 2) / GRID_CELL), x1 = Math.floor((r.x + r.w / 2) / GRID_CELL);
      const z0 = Math.floor((r.z - r.d / 2) / GRID_CELL), z1 = Math.floor((r.z + r.d / 2) / GRID_CELL);
      for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
        const k = ix * 100003 + iz;
        let a = cells.get(k);
        if (!a) cells.set(k, a = []);
        a.push(i);
      }
    }
    return cells;
  }
  const _near: number[] = [], byIndex = (a: number, b: number): number => a - b;
  function nearBoxes(cells: Map<number, number[]>, x: number, z: number, m: number): number[] {
    _near.length = 0;
    const x0 = Math.floor((x - m) / GRID_CELL), x1 = Math.floor((x + m) / GRID_CELL);
    const z0 = Math.floor((z - m) / GRID_CELL), z1 = Math.floor((z + m) / GRID_CELL);
    let many = 0;
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const a = cells.get(ix * 100003 + iz);
      if (a) { many++; for (let j = 0; j < a.length; j++) _near.push(a[j]!); }
    }
    if (many > 1) {
      _near.sort(byIndex);
      let w = 0;
      for (let j = 0; j < _near.length; j++) if (!j || _near[j] !== _near[j - 1]) _near[w++] = _near[j]!;
      _near.length = w;
    }
    return _near;
  }

  /** flyby-seq.js:172 */
  function insideProp(track: FlybyTrack, p: Readonly<Vec3>, margin?: number | null): PropRec | null {
    const b = blockers(track), m = margin || 0;
    const C = cacheOf(track);
    const near = nearBoxes(C.solidGrid || (C.solidGrid = boxGrid(b)), p[0], p[2], m);
    for (let n = 0; n < near.length; n++) {
      const r = b[near[n]!]!;
      if (Math.abs(p[0] - r.x) < r.w / 2 + m &&
          Math.abs(p[2] - r.z) < r.d / 2 + m &&
          p[1] > r.y - r.h / 2 - m && p[1] < r.y + r.h / 2 + m) return r;
    }
    return null;
  }

  /** LIFT, never shove sideways. A lateral escape would need a direction the
   *  shot cannot know (both ways may be blocked), and it would swing the framing;
   *  going over the top keeps the subject in the same part of the screen and is
   *  always available. Bounded so a bad shot reads as a high shot, not as orbit.
   *  flyby-seq.js:202 */
  function clearEye(track: FlybyTrack, eye: Vec3, margin?: number): Vec3 {
    const m = margin === undefined ? CLEAR_M : margin;
    for (let i = 0; i < 4; i++) {
      const hit = insideProp(track, eye, m);
      if (!hit) break;
      eye[1] = hit.y + hit.h / 2 + m;
    }
    return eye;
  }

  /** NEVER BELOW THE GROUND. `centre` and `landmark` heights are measured from
   *  a centroid and a prop's middle, not from the ground under the eye, so on a
   *  hillside (or over a road that runs above the anchor) nothing else stops an
   *  eye being authored underground: Red Bull Ring's rank-0 landmark is a 34 m
   *  tower standing in a valley, and landmark1 put the eye 6.1 m below the start
   *  straight on every sample. Terrain where there is terrain, the road where
   *  the eye is over it. Part of the PLANNED lift (profileOf), so the camera
   *  rises into the floor smoothly instead of popping up onto it.
   *  flyby-seq.js:220-236 */
  const FLOOR = 1.5;
  const _fl = newSample();
  function groundAt(track: FlybyTrack, x: number, z: number, y?: number): number {
    let g: number | null = trackTerrainY(track, x, z);
    if (g == null || !isFinite(g)) g = -Infinity;
    const pr = trackProject(track, x, z, null, y);
    if (pr) {
      trackSample(track, pr.s, _fl);
      if (Math.abs(pr.lat) <= (_fl.hw || 10) + 2 && _fl.p[1] > g) g = _fl.p[1];
    }
    return g;
  }
  function floorEye(track: FlybyTrack, eye: Vec3): Vec3 {
    const g = groundAt(track, eye[0], eye[2], eye[1]);
    if (eye[1] < g + FLOOR) eye[1] = g + FLOOR;
    return eye;
  }

  // ---- what this circuit looks like ----------------------------------------

  /* TERRAIN IS NOT A LANDMARK. Ranked by raw volume the answer is always the
     scenery nobody came to see: Spa's biggest props are 240 m mountains and
     Monza's are ridges. The shot that says "this is Bahrain" frames the tower,
     not the hill behind it. */
  const TERRAIN = ["mountain", "ridge", "hill", "tree", "pine", "stonePine",
                   "cypress", "palm", "acacia", "broadleafFall", "bush"];
  /* How much each kind is worth being a shot ABOUT. A tower is the thing a
     circuit is recognised by; a grandstand says "motor racing" but not which
     circuit; a `structure` is an assembled hull and only earns a shot when it is
     both tall and mostly solid (Monaco's whole skyline arrives this way). */
  // No `gantry`: a gantry spans the road, so "the track side of it" is the
  // road under it — Buenos Aires's start gantry was its landmark2, framed from
  // its own footprint. The start line has the grid shots.
  const LM_WEIGHT: Readonly<Record<string, number>> = { tower: 3, building: 1.6, grandstand: 1.3, motorhome: 1, structure: 0.9 };
  const LM_MIN_H = 8;             // shorter than this reads as trackside furniture
  // metres — two boxes of one grandstand are one landmark, and so is a CLUSTER:
  // at 80 m Monza's three towers (84 m apart) were ranks 0 and 1, so the second
  // landmark shot was the first one again from a little closer.
  const LM_APART = 300;
  const LM_KEEP = 6;
  const LM_SPAN = 0.45;           // how much of a landmark's footprint counts as its framing size
  const LM_MIN_SIZE = 40;         // metres — nothing is framed as if it were smaller
  const LM_NEAR = 220;            // metres from the centreline — beyond this it is scenery, not a landmark
  const LM_EDGE = 5;              // metres past the road edge — nearer than this it is ON the track, not beside it

  /** flyby-seq.js:265 */
  function landmarkScore(r: PropRec): number {
    const w = LM_WEIGHT[r.kind];
    if (!w || !(r.h >= LM_MIN_H)) return 0;
    if (r.kind === "structure" && ((r.fill || 0) < 0.35 || r.h < 12)) return 0;
    const vol = Math.max(1, r.w * r.h * r.d);
    // Cube root, so a landmark twice as big in every direction is twice as
    // interesting rather than eight times — raw volume lets one mass win outright.
    return w * Math.cbrt(vol) * (1 + r.h / 60);
  }

  /** This circuit's notable built scenery, best first. Cached on the track. flyby-seq.js:276 */
  function landmarks(track: FlybyTrack): PropRec[] {
    const C = cacheOf(track);
    if (C.landmarks) return C.landmarks;
    const list = (track.props && track.props.list) || [];
    const scored: { r: PropRec; score: number; near?: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      if (TERRAIN.indexOf(r.kind) !== -1 || !LM_WEIGHT[r.kind]) continue;
      // Scored on the part ABOVE GROUND (lmBase): Hockenheim's stands are 30 m
      // hulls sunk 16 m into a bank, and Red Bull Ring's tower stands in a
      // valley — ranked on their hull heights they framed a buried box.
      const hv = lmH(track, r);
      const sc = landmarkScore(hv === r.h ? r : Object.assign({}, r, { h: hv }));
      if (!(sc > 0)) continue;
      // ON the road is not beside it: a box whose centre is within LM_EDGE of
      // the road edge straddles the track (a bridge, an overhead sign), and its
      // "track side" is the tarmac under it.
      const pr = trackProject(track, r.x, r.z);
      if (pr) {
        trackSample(track, pr.s, _smp);
        if (Math.abs(pr.lat) - (_smp.hw || 10) < LM_EDGE) continue;
      }
      scored.push({ r: r, score: sc });
    }
    // NEAR THE TRACK, OR IT IS NOT A SHOT. Bahrain's tallest structure is a
    // 126 m tower out in the desert: framed on its own at dusk it is a lit pole
    // against black sand, with no circuit anywhere in shot. A landmark earns a
    // shot by being part of the place you are about to race, so distance to the
    // centreline both gates and scores it.
    const b = bounds(track);
    for (let i = 0; i < scored.length; i++) {
      const r = scored[i]!.r;
      let best = Infinity;
      for (let j = 0; j < b.pts.length; j++) {
        const d = Math.hypot(r.x - b.pts[j]![0], r.z - b.pts[j]![2]);
        if (d < best) best = d;
      }
      scored[i]!.near = best;
      scored[i]!.score *= best <= LM_NEAR ? (1 + (LM_NEAR - best) / LM_NEAR) : 0;
    }
    scored.sort((a, b2) => b2.score - a.score);
    const keep: PropRec[] = [];
    for (let i = 0; i < scored.length && keep.length < LM_KEEP; i++) {
      if (!(scored[i]!.score > 0)) break;          // sorted, so the rest are all too far
      const c = scored[i]!.r;
      let near = false;
      for (let j = 0; j < keep.length; j++) {
        if (Math.hypot(c.x - keep[j]!.x, c.z - keep[j]!.z) < LM_APART) { near = true; break; }
      }
      if (!near) keep.push(c);
    }
    C.landmarks = keep;
    return keep;
  }

  /** Where a landmark's VISIBLE part starts: its hull bottom, or the ground
   *  under its centre when the hull is sunk into a bank. Cached per record on
   *  the track, never written onto the shared record. flyby-seq.js:333 */
  function lmBase(track: FlybyTrack, r: PropRec): number {
    const C = cacheOf(track);
    const cache = C.lmBase || (C.lmBase = new Map());
    if (cache.has(r)) return cache.get(r)!;
    const bottom = r.y - r.h / 2, top = r.y + r.h / 2;
    const g = groundAt(track, r.x, r.z, top);
    const base = (isFinite(g) && g > bottom) ? Math.min(g, top) : bottom;
    cache.set(r, base);
    return base;
  }
  function lmH(track: FlybyTrack, r: PropRec): number { return r.y + r.h / 2 - lmBase(track, r); }
  function lmMid(track: FlybyTrack, r: PropRec): number { return lmBase(track, r) + lmH(track, r) / 2; }

  /** Centroid and radius of the whole lap, for the establishing shots. Sampled
   *  from the centreline rather than from props, so an outlying mountain cannot
   *  drag the frame off the circuit. flyby-seq.js:348 */
  function bounds(track: FlybyTrack): FlybyBounds {
    const C = cacheOf(track);
    if (C.bounds) return C.bounds;
    const N = 96;
    let cx = 0, cz = 0, cy = 0;
    const pts: Vec3[] = [];
    for (let i = 0; i < N; i++) {
      trackSample(track, (i / N) * track.total, _smp);
      pts.push([_smp.p[0], _smp.p[1], _smp.p[2]]);
      cx += _smp.p[0]; cy += _smp.p[1]; cz += _smp.p[2];
    }
    cx /= N; cy /= N; cz /= N;
    let rad = 1;
    for (let i = 0; i < N; i++) rad = Math.max(rad, Math.hypot(pts[i]![0] - cx, pts[i]![2] - cz));
    // Keep the samples: landmark selection needs "how far is this from the
    // track", and 96 points is a good enough centreline for a proximity test.
    // FACE: the bearing from the centroid to the start line (pts[0] is s = 0),
    // which is what a `centre` bearing of 0 means — the establishing shot then
    // has the main straight, the grid and the pits in its foreground.
    const face = Math.atan2(pts[0]![2] - cz, pts[0]![0] - cx);
    C.bounds = { x: cx, y: cy, z: cz, rad: rad, pts: pts, face: face };
    return C.bounds;
  }

  // ---- anchors -------------------------------------------------------------

  function wrapS(track: FlybyTrack, s: number): number {
    const total = track.total || 1;
    return ((s % total) + total) % total;
  }

  /** The measured corner list cornerS() fills (f1-game `track._fbCorners`). */
  function cornerList(track: FlybyTrack): readonly FlybyCorner[] {
    cornerS(track, 1);
    return cacheOf(track).corners!;
  }

  /** Corner apexes as arc metres, from the same measurement the picker's map and
   *  the loading card's turn count use. Cached with the blockers, for the same
   *  reason: it is a property of this built world. flyby-seq.js:381 */
  function cornerS(track: FlybyTrack, n?: number | string): number {
    const C = cacheOf(track);
    if (!C.corners) {
      let cs: readonly FlybyCorner[] = [];
      try {
        if (deps.corners && track.def) cs = deps.corners(track.def) || [];
      } catch (_) { cs = []; }
      C.corners = cs;
    }
    const cs = C.corners;
    if (!cs.length) return 0;
    const c = cs[Math.min(cornerIndex(track, cs, n), cs.length - 1)];
    return (c && typeof c.f === "number") ? c.f * track.total : 0;
  }
  function cornerIndex(track: FlybyTrack, cs: readonly FlybyCorner[], n: number | string | undefined): number {
    // A shot list is written once for every circuit, and circuits do not agree
    // on how many corners they have — Monza has 11, Suzuka 18. Naming a ROLE
    // ("the first corner", "something mid-lap") ports; naming corner 14 does not.
    let i: number;
    if (n === "first") i = roleCorner(track, cs, 0);
    else if (n === "mid") i = roleCorner(track, cs, Math.floor(cs.length * 0.45));
    else if (n === "late") i = roleCorner(track, cs, Math.floor(cs.length * 0.78));
    else if (n === "slowest" || n === "fastest") i = extremeCorner(track, cs, n === "slowest");
    else if (n === "lore") { const L = loreCorner(track, cs), slow = extremeCorner(track, cs, true); i = L >= 0 && cacheOf(track).filmable![L] ? L : slow; }
    else i = Math.min(Math.max(1, int(n)), cs.length) - 1;
    return i;
  }
  const filmableOf = (track: FlybyTrack, cs: readonly FlybyCorner[]): boolean[] => {
    const C = cacheOf(track);
    return C.filmable || (C.filmable = cs.map((c) => filmable(track, c)));
  };

  /* ONE CORNER, ONE SHOT. Roles resolve independently, so two can name the
     same corner: Monza's "first" and "fastest" are both T1, and 14 of 52
     circuits filmed one corner twice in a single flyby (a third of varied
     loads). bindCorners() resolves a list's roles in order and moves a clash to
     that role's NEXT choice — the next-slowest, the next-fastest, else the
     nearest filmable corner — returning a copy whose corner poses carry plain
     corner numbers. Cached per list, so the per-shot caches downstream hold.
     flyby-seq.js:408-467 */
  function roleRank(track: FlybyTrack, cs: readonly FlybyCorner[], n: number | string, home: number): number[] {
    const ok = filmableOf(track, cs);
    const idx: number[] = [];
    for (let k = 0; k < cs.length; k++) if (ok[k] && k !== home) idx.push(k);
    if (n === "slowest" || n === "fastest" || n === "lore") {   // lore's own fallback is the slowest
      const sg = n === "fastest" ? -1 : 1, r = (k: number): number => (cs[k]!.r > 0 ? sg * cs[k]!.r : Infinity);
      return idx.sort((a, b) => r(a) - r(b));
    }
    return idx.sort((a, b) => Math.abs(a - home) - Math.abs(b - home) || b - a);
  }
  function shotCorner(shot: FlybyShot): number | string | null {
    const poses = [shot.eye[0], shot.eye[1], shot.look[0], shot.look[1]];
    for (let i = 0; i < 4; i++) { const p = poses[i]; if (p && p.at === "corner") return p.n === undefined ? 1 : p.n; }
    return null;
  }
  const SAME_M = 120;
  function bindCorners(track: FlybyTrack, list: readonly FlybyShot[]): FlybyShot[] {
    const C = cacheOf(track);
    const cache = C.bind || (C.bind = new WeakMap());
    let out = cache.get(list);
    if (out) return out;
    cornerS(track, 1);
    const cs = C.corners!, used: number[] = [], total = track.total || 1;
    // By PLACE, not index: the measured list can hold one corner twice (Monza's
    // T1 and T2 are both s = 592, the two halves of the Rettifilo).
    const taken = (k: number): boolean => used.some((j) => { const d = Math.abs(cs[j]!.f - cs[k]!.f) * total; return Math.min(d, total - d) < SAME_M; });
    // A corner the author NUMBERED is theirs: it is never moved (the editor's
    // CORNER field must film what it says), but it is claimed first, so the
    // roles steer around it.
    const numbered = (n: number | string): boolean => typeof n !== "string";
    for (let i = 0; i < list.length; i++) {
      const role = shotCorner(list[i]!);
      if (role !== null && cs.length && numbered(role)) used.push(Math.min(cornerIndex(track, cs, role), cs.length - 1));
    }
    out = list.map((shot) => {
      const role = shotCorner(shot);
      if (role === null || !cs.length || numbered(role)) return shot;
      let k = Math.min(cornerIndex(track, cs, role), cs.length - 1);
      if (taken(k)) {
        const alt = roleRank(track, cs, role, k).filter((j) => !taken(j));
        if (alt.length) k = alt[0]!;
      }
      used.push(k);
      // ONE bound copy per (shot, corner): a list re-filtered or re-bound reuses it,
      // so the plan cached on it (planShot) survives — the menu plans, the flyby plays.
      const memo = C.boundShot || (C.boundShot = new WeakMap());
      const byK = memo.get(shot) || (memo.set(shot, {}), memo.get(shot)!);
      if (byK[k]) return byK[k]!;
      const bind = (p: FlybyPose): FlybyPose => (p && p.at === "corner" && (p.n === undefined ? 1 : p.n) === role ? Object.assign({}, p, { n: k + 1 }) : p);
      return (byK[k] = Object.assign({}, shot, { eye: shot.eye.map(bind), look: shot.look.map(bind) }));
    });
    cache.set(list, out);
    return out;
  }

  /* A ROLE NAMES A CORNER WORTH FILMING. The measured list counts kinks and
     chicane flicks as corners, and a role landing on one filmed a straight:
     Mont-Tremblant's "first" turns 0 degrees net over +-40 m, Sochi's 20,
     Jeddah's "late" 17, Buenos Aires's "mid" 21 — and a camera on "the outside"
     of a chicane is on the inside of its other half (Montreal's late, 42 net of
     75 swept). A role therefore takes the NEAREST corner (forward first) that
     turns at least TURN_MIN net over TURN_WIN either side, and a chicane — one
     that sweeps half as much again as it nets — only at TURN_CHICANE. Numbered
     corners are the author's own choice and are never moved.
     flyby-seq.js:469-497 */
  const TURN_WIN = 40, TURN_MIN = 35 * Math.PI / 180, TURN_CHICANE = 45 * Math.PI / 180;
  const _tA = newSample();
  function cornerTurn(track: FlybyTrack, s: number): { net: number; swept: number } {
    let net = 0, swept = 0, prev: number | null = null;
    for (let d = -TURN_WIN; d <= TURN_WIN; d += 4) {
      trackSample(track, wrapS(track, s + d), _tA);
      const a = Math.atan2(_tA.t[2], _tA.t[0]);
      if (prev !== null) {
        const x = Math.atan2(Math.sin(a - prev), Math.cos(a - prev));
        net += x; swept += Math.abs(x);
      }
      prev = a;
    }
    return { net: Math.abs(net), swept: swept };
  }
  function filmable(track: FlybyTrack, c: FlybyCorner | undefined): boolean {
    if (!c || typeof c.f !== "number") return false;
    const t = cornerTurn(track, c.f * track.total);
    return t.net >= TURN_MIN && (t.swept <= 1.5 * t.net || t.net >= TURN_CHICANE);
  }
  /* CORNERS BY CHARACTER. "first/mid/late" are positions; a circuit is known
     for its hairpin, its flat-out sweep, or the corner the announcer names
     (js/data/circuit-lore.js `corner`). `slowest`/`fastest` read the measured
     apex RADIUS (TrackMaps.corners `r`; its `v` is peak CURVATURE, not speed —
     reading `v` as a speed swapped the two) among FILMABLE corners; `lore` pulls
     "Turn N" out of the lore line and falls back to the slowest. All three
     cache like the others (cornerSide keys by n). flyby-seq.js:498-534 */
  function extremeCorner(track: FlybyTrack, cs: readonly FlybyCorner[], slow: boolean): number {
    const ok = filmableOf(track, cs);
    let best = -1;
    for (let k = 0; k < cs.length; k++) {
      if (!ok[k] || !(cs[k]!.r > 0)) continue;
      if (best < 0 || (slow ? cs[k]!.r < cs[best]!.r : cs[k]!.r > cs[best]!.r)) best = k;
    }
    return best >= 0 ? best : 0;
  }
  const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  function loreCorner(track: FlybyTrack, cs: readonly FlybyCorner[]): number {
    let line = "";
    try {
      const L = track.def ? loreOf(track.def.id) : null;
      line = (L && L.corner) || "";
    } catch (_) { line = ""; }
    const m = /\bturns? (\d+|[a-z]+)\b/i.exec(line);
    if (!m) return -1;
    const w = m[1]!;
    const n = /^\d+$/.test(w) ? +w : NUM_WORDS.indexOf(w.toLowerCase());
    return n >= 1 && n <= cs.length ? n - 1 : -1;
  }
  function roleCorner(track: FlybyTrack, cs: readonly FlybyCorner[], i: number): number {
    const ok = filmableOf(track, cs);
    for (let d = 0; d < cs.length; d++) {
      if (i + d < cs.length && ok[i + d]) return i + d;
      if (d && i - d >= 0 && ok[i - d]) return i - d;
    }
    return i;
  }

  /** flyby-seq.js:536 */
  function anchorS(track: FlybyTrack, pose: FlybyPose): number {
    const total = track.total || 1;
    const off = pose.off || 0;
    switch (pose.at) {
      case "pole": return wrapS(track, total - POLE_BACK + off);
      // The BACK of the grid that is there: a time trial seats one car and a duel
      // two, and a fixed 20th row filmed 19 empty boxes 160 m from them.
      case "grid": return wrapS(track, total - POLE_BACK - (Math.min(GRID_ROWS, _gridSize) - 1) * GRID_SPACING + off);
      case "corner": return wrapS(track, cornerS(track, pose.n || 1) + off);
      case "slot": return wrapS(track, total - POLE_BACK - slotIndex(pose) * GRID_SPACING + off);
      default: return wrapS(track, off);          // "start" — the line is s = 0 by construction
    }
  }

  const _smp = newSample();

  /** The bearing from a landmark to its nearest stretch of track — what a
   *  landmark `bear` of 0 means. Shot from that side, the circuit sits between
   *  the camera and the landmark, so the frame says "this tower, at THIS
   *  track" instead of framing a tower against whatever is behind it. Cached
   *  on the track, keyed by the record, and never written onto the record: the
   *  props registry is shared with everything else that reads scenery.
   *  flyby-seq.js:558 */
  function lmFace(track: FlybyTrack, r: PropRec): number {
    const C = cacheOf(track);
    const cache = C.lmFace || (C.lmFace = new Map());
    if (cache.has(r)) return cache.get(r)!;
    const pts = bounds(track).pts;
    let best = Infinity, bx = r.x, bz = r.z;
    for (let j = 0; j < pts.length; j++) {
      const d = Math.hypot(r.x - pts[j]![0], r.z - pts[j]![2]);
      if (d < best) { best = d; bx = pts[j]![0]; bz = pts[j]![2]; }
    }
    const a = Math.atan2(bz - r.z, bx - r.x);
    cache.set(r, a);
    return a;
  }

  /* A LANDMARK SHOT STANDS ON THE TRACK SIDE, NOT A BLOCK BEYOND IT. The eye
     is `distK` landmark sizes out, and a size is the landmark's HEIGHT, so a
     170 m Las Vegas tower 60 m from the road put the eye 157-170 m past the
     track, inside the next tower along, and the planned lift then cleared
     that one by 40 m. Past LM_REACH beyond the landmark's own distance to the
     centreline the extra distance is taken at a quarter: the dolly between the
     two ends survives, the overshoot does not. flyby-seq.js:572-591 */
  const LM_REACH = 40, LM_REACH_MIN = 60;
  function lmNear(track: FlybyTrack, r: PropRec): number {
    const C = cacheOf(track);
    const cache = C.lmNear || (C.lmNear = new Map());
    if (cache.has(r)) return cache.get(r)!;
    const pr = trackProject(track, r.x, r.z);
    const d = pr ? Math.abs(pr.lat) : 0;
    cache.set(r, d);
    return d;
  }
  function lmDist(track: FlybyTrack, r: PropRec, d: number): number {
    const cap = Math.max(LM_REACH_MIN, lmNear(track, r) + LM_REACH);
    return d <= cap ? d : cap + (d - cap) * 0.25;
  }

  /** +1 when a corner turns LEFT (its outside is the road's +right), -1 when it
   *  turns right. The heading change is SUMMED in short steps across the apex:
   *  one comparison either side reads a hairpin backwards, because Monaco's
   *  Loews turns more than 180 degrees inside 60 m. A camera placement, the
   *  broadcast column — never a force on any car. flyby-seq.js:593-616 */
  const _cA = newSample();
  const _cB = newSample();
  function cornerSide(track: FlybyTrack, n?: number | string): number {
    const C = cacheOf(track);
    const cache = C.cornerSide || (C.cornerSide = {});
    const key = String(n === undefined ? 1 : n);
    if (cache[key] !== undefined) return cache[key]!;
    const s = cornerS(track, n === undefined ? 1 : n);
    // Each step: the next heading against this step's right vector, i.e. the
    // sine of the turn over 4 m. Swinging toward +right is a right-hander.
    let turnRight = 0;
    trackSample(track, wrapS(track, s - 24), _cA);
    for (let i = -5; i <= 6; i++) {
      trackSample(track, wrapS(track, s + i * 4), _cB);
      turnRight += _cB.t[0] * _cA.r[0] + _cB.t[2] * _cA.r[2];
      for (let j = 0; j < 3; j++) { _cA.t[j] = _cB.t[j]!; _cA.r[j] = _cB.r[j]!; }
    }
    cache[key] = turnRight > 0 ? -1 : 1;
    return cache[key]!;
  }

  /* A TRACKSIDE CAMERA STANDS AT THE FENCE. On a street circuit the outside of
     a corner is a building a few metres past the barrier, so a lateral offset
     that frames an open circuit well lands the eye inside a block — lifted
     30 m over Monaco's Ste Devote — or out over another stretch of road across
     a hairpin, staring down at tarmac. Capping |x| just beyond this side's
     barrier keeps the shot on the fence line. STREET circuits only: past an
     open circuit's barrier is run-off and trees, and Monza's chicane barriers
     sit 8 m out — capping there pulled good shots onto the kerbs. */

  /** A track pose's lateral offset in the road's +right frame, capped at the
   *  fence at arc `s`. Capped per ENDPOINT, never along a move: barrier
   *  distances step between nodes, and a per-frame cap would print that step
   *  onto the camera path. flyby-seq.js:632 */
  function poseX(track: FlybyTrack, pose: FlybyPose, s: number): number {
    let x = pose.x || 0;
    if (pose.at === "corner" && x) x *= cornerSide(track, pose.n);
    // A slot pose's x is relative to THAT car, so "x: 0" is right behind it.
    if (pose.at === "slot") { const k = slotIndex(pose); x += slotX(track, k, wrapS(track, (track.total || 1) - POLE_BACK - k * GRID_SPACING)); }
    if (x && track.def && track.def.street) {
      const w = trackWallAt(track, s, x > 0 ? 1 : -1);
      if (w > 0 && Math.abs(x) > w + FENCE) x = (x > 0 ? 1 : -1) * (w + FENCE);
    }
    return x;
  }

  /** A pose to a world point: arc → centreline, then lateral along the road's
   *  right vector, then height above the surface. flyby-seq.js:646 */
  function posePoint(track: FlybyTrack, pose: FlybyPose, out: Vec3): Vec3 {
    // WHOLE-CIRCUIT anchor: polar around the lap's centroid, in multiples of its
    // radius, so one establishing shot frames Monaco and Spa alike.
    if (pose.at === "centre") {
      const b = bounds(track);
      // CLAMPED, because a multiple of the radius alone is a satellite. Monza's
      // lap radius is ~800 m, so 0.85 of it put the eye 680 m up and the
      // establishing shot became a map of the circuit with no scenery, no
      // scale and nothing to recognise. These bounds are what a helicopter
      // shot actually lives in.
      // ZERO MEANS THE CENTROID. The clamps are for a camera; the establishing
      // shots' LOOK pose is {distR: 0, yR: 0}, "at the middle of the lap", and
      // clamping it too aimed every one of them at a point 200 m out towards the
      // start line and 55 m up — off-centre and above the horizon of a low shot.
      const dR = pose.distR === undefined ? 1.4 : pose.distR;
      const yR = pose.yR === undefined ? 0.5 : pose.yR;
      const d = dR > 0 ? Math.max(C_DMIN, Math.min(C_DMAX, dR * b.rad)) : 0;
      const h = yR > 0 ? Math.max(C_HMIN, Math.min(C_HMAX, yR * b.rad)) : yR * b.rad;
      const a = b.face + (pose.bear || 0);
      out[0] = b.x + Math.cos(a) * d;
      out[1] = b.y + h + (pose.y || 0);
      out[2] = b.z + Math.sin(a) * d;
      return out;
    }
    // LANDMARK anchor: polar around this circuit's own notable scenery, in
    // multiples of the landmark's size, so a 126 m tower is framed from further
    // out than a grandstand without a per-circuit number.
    if (pose.at === "landmark") {
      const lm = landmarks(track);
      // NO LANDMARK: the whole circuit instead. A "start + 20 m" fallback puts
      // a LOOK pose 8 m above an eye the same fallback puts at start + 12 m —
      // the camera stares straight up. A whole-circuit pose
      // keeps an eye an eye and a look a look (solve() swaps the whole shot for
      // landmarkFallback(); this is for callers that solve one pose).
      if (!lm.length) {
        const eye = (pose.distK || 0) > 0;
        return posePoint(track, { at: "centre", bear: pose.bear || 0, distR: eye ? 0.8 : 0, yR: eye ? 0.25 : 0 }, out);
      }
      const r = lm[Math.min(pose.rank || 0, lm.length - 1)]!;
      // HEIGHT FIRST, footprint at a discount. The longest side made a 162 m x
      // 21 m grandstand "162 m big", so Monza's was framed from ~290 m as a
      // sliver behind the trees; a tower's height is still its size. And a
      // floor, because a shot's `y` is in metres: Bahrain's 15 m pavilion,
      // framed from 1.6 of its own size, put a 12 m-high eye 29 m away looking
      // down at the roof.
      // Heights are of the part ABOVE GROUND (lmBase), centred on its middle.
      const size = lmSize(track, r);
      const d = lmDist(track, r, (pose.distK === undefined ? 0 : pose.distK) * size);
      const a = lmFace(track, r) + (pose.bear || 0);
      out[0] = r.x + Math.cos(a) * d;
      out[1] = lmMid(track, r) + (pose.yK === undefined ? 0 : pose.yK) * lmH(track, r) + (pose.y || 0);
      out[2] = r.z + Math.sin(a) * d;
      return out;
    }
    const s = anchorS(track, pose);
    trackSample(track, s, _smp);
    const x = poseX(track, pose, s);
    out[0] = _smp.p[0] + _smp.r[0] * x;
    out[1] = _smp.p[1] + (pose.y || 0);
    out[2] = _smp.p[2] + _smp.r[2] * x;
    return out;
  }

  // ---- the inverse: a world point back to a pose ---------------------------
  //
  // THE FREE CAMERA'S "COPY AS FLYBY POSE". A camera flown to a good spot is a
  // world point, and a world point is exactly what a shot list must not hold
  // (see the header: it names a different picture on every circuit). This
  // re-expresses the point in the anchor it is nearest, so the result can be
  // pasted into the editor and still means "just outside turn 3" rather than
  // "x = 412". Every answer is re-solved through posePoint() and the miss is
  // reported as `err`, so a caller never has to trust the inversion.
  // flyby-seq.js:709-854

  const _inv: Vec3 = [0, 0, 0];
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const r5 = (n: number): number => Math.round(n * 1e5) / 1e5;
  function wrapAng(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }

  /** Arc distance from `s` to the nearest corner apex, signed along the lap. */
  function nearestCorner(track: FlybyTrack, s: number): { n: number; off: number } | null {
    cornerS(track, 1);                           // fills the corner cache
    const cs = cacheOf(track).corners || [], total = track.total || 1;
    let best: { n: number; off: number } | null = null;
    for (let i = 0; i < cs.length; i++) {
      if (!cs[i] || typeof cs[i]!.f !== "number") continue;
      let off = s - cs[i]!.f * total;
      off -= Math.round(off / total) * total;    // wrap into (-total/2, total/2]
      if (!best || Math.abs(off) < Math.abs(best.off)) best = { n: i + 1, off };
    }
    return best;
  }

  interface PoseOpts { at?: string | undefined; rank?: number | null | undefined; cornerWindow?: number | null | undefined; trackMax?: number | null | undefined }

  function trackPose(track: FlybyTrack, p: Readonly<Vec3>, opts: PoseOpts): FlybyPose {
    const pr = trackProject(track, p[0], p[2]);
    // project() measures `lat` along the interpolated right vector from the
    // nearest point on the node CHORD, but that vector is not square to the
    // chord inside a corner, and posePoint() walks it from sample(s). At 18 m
    // out on a Monza corner that is 0.8 m of miss. A few Newton steps in the
    // XZ plane solve posePoint's own equation, p = sample(s).p + r(s) * x.
    let s = pr.s, x = pr.lat;
    for (let it = 0; it < 4; it++) {
      trackSample(track, s, _smp);
      const ex = p[0] - _smp.p[0] - _smp.r[0] * x, ez = p[2] - _smp.p[2] - _smp.r[2] * x;
      const tl = Math.hypot(_smp.t[0], _smp.t[2]) || 1, rl = Math.hypot(_smp.r[0], _smp.r[2]) || 1;
      s += (ex * _smp.t[0] + ez * _smp.t[2]) / tl;
      x += (ex * _smp.r[0] + ez * _smp.r[2]) / rl / rl;
    }
    s = wrapS(track, s); pr.s = s; pr.lat = x;
    trackSample(track, s, _smp);
    const y = r2(p[1] - _smp.p[1]);
    const win = opts.cornerWindow == null ? 150 : opts.cornerWindow;
    const c = opts.at === "start" ? null : nearestCorner(track, pr.s);
    if (c && (opts.at === "corner" || Math.abs(c.off) <= win)) {
      // A corner's +x is its OUTSIDE (poseX multiplies by cornerSide), and the
      // side is ±1, so dividing it back out is multiplying by it.
      return { at: "corner", n: c.n, off: r2(c.off), x: r2(pr.lat * cornerSide(track, c.n)), y };
    }
    const total = track.total || 1;
    return { at: "start", off: r2(pr.s > total / 2 ? pr.s - total : pr.s), x: r2(pr.lat), y };
  }

  // posePoint's helicopter clamps, mirrored: a `centre` pose cannot say "closer
  // than 200 m" or "further than 850 m", so outside them it is not an answer.
  const C_DMIN = 200, C_DMAX = 850, C_HMIN = 55, C_HMAX = 190;
  function centrePose(track: FlybyTrack, p: Readonly<Vec3>): FlybyPose | null {
    const b = bounds(track);
    const d = Math.hypot(p[0] - b.x, p[2] - b.z);
    if (d < C_DMIN || d > C_DMAX) return null;
    const dy = p[1] - b.y, h = Math.max(C_HMIN, Math.min(C_HMAX, dy));
    const pose: FlybyPose = { at: "centre", bear: r5(wrapAng(Math.atan2(p[2] - b.z, p[0] - b.x) - b.face)),
      distR: r5(d / b.rad), yR: r5(h / b.rad) };
    if (Math.abs(dy - h) > 0.005) pose.y = r2(dy - h);   // the part the clamp cannot carry
    return pose;
  }

  function lmSize(track: FlybyTrack, r: PropRec): number { return Math.max(LM_MIN_SIZE, lmH(track, r), LM_SPAN * Math.max(r.w, r.d)); }

  /** The nearest landmark to `p` in XZ as {rank, r, d}, or null. */
  function nearestLandmark(track: FlybyTrack, p: Readonly<Vec3>): { rank: number; r: PropRec; d: number } | null {
    const lm = landmarks(track);
    let best: { rank: number; r: PropRec; d: number } | null = null;
    for (let i = 0; i < lm.length; i++) {
      const d = Math.hypot(p[0] - lm[i]!.x, p[2] - lm[i]!.z);
      if (!best || d < best.d) best = { rank: i, r: lm[i]!, d };
    }
    return best;
  }
  function landmarkPose(track: FlybyTrack, p: Readonly<Vec3>, rank: number): FlybyPose | null {
    const lm = landmarks(track);
    if (!lm.length) return null;
    const i = Math.max(0, Math.min(rank | 0, lm.length - 1)), r = lm[i]!;
    const d = Math.hypot(p[0] - r.x, p[2] - r.z);
    const bear = d > 1e-6 ? wrapAng(Math.atan2(p[2] - r.z, p[0] - r.x) - lmFace(track, r)) : 0;
    // lmDist() inverted: past the reach cap a world metre is four authored ones.
    const cap = Math.max(LM_REACH_MIN, lmNear(track, r) + LM_REACH);
    const da = d <= cap ? d : cap + (d - cap) * 4;
    return { at: "landmark", rank: i, bear: r5(bear), distK: r5(da / lmSize(track, r)), yK: 0, y: r2(p[1] - lmMid(track, r)) };
  }

  /** A world point → the pose that names it, with its round-trip miss.
   *  opts.at: "auto" (default) | "track" | "corner" | "start" | "centre" | "landmark"
   *  opts.rank (landmark), opts.cornerWindow (m, default 150), opts.trackMax
   *  (m from the centreline beyond which "auto" stops anchoring on the road,
   *  default 80). "auto" picks the road when near it, then a landmark the point
   *  is within three sizes of, then the whole circuit — and the road whenever
   *  the others cannot represent the point, since a track pose always can.
   *  flyby-seq.js:812 */
  function poseFromWorld(track: FlybyTrack, p: Readonly<Vec3>, opts?: PoseOpts | null): { pose: FlybyPose; err: number } {
    const o: PoseOpts = opts || {};
    const at = o.at || "auto";
    let pose: FlybyPose | null = null;
    if (at === "centre") pose = centrePose(track, p);
    else if (at === "landmark") {
      const nl = o.rank == null ? nearestLandmark(track, p) : null;
      pose = landmarkPose(track, p, o.rank != null ? o.rank : (nl ? nl.rank : 0));
    } else if (at === "auto") {
      const pr = trackProject(track, p[0], p[2]);
      const trackMax = o.trackMax == null ? 80 : o.trackMax;
      if (pr.dist > trackMax) {
        const nl = nearestLandmark(track, p);
        if (nl && nl.d <= 3 * lmSize(track, nl.r)) pose = landmarkPose(track, p, nl.rank);
        else pose = centrePose(track, p);
      }
    }
    if (!pose) pose = trackPose(track, p, { at, cornerWindow: o.cornerWindow });
    posePoint(track, pose, _inv);
    const err = Math.hypot(_inv[0] - p[0], _inv[1] - p[1], _inv[2] - p[2]);
    return { pose, err: Math.round(err * 1000) / 1000 };
  }

  /** The free camera's current view as a HELD one-shot list entry — eye and
   *  look both converted, same pose at both ends — ready for the editor. The
   *  look is anchored on the road unless the eye framed a landmark it is
   *  looking at, so a pan along the track later follows the track.
   *  flyby-seq.js:839 */
  function shotFromView(track: FlybyTrack, eye: Readonly<Vec3>, target: Readonly<Vec3>, fov?: number | null,
    opts?: (PoseOpts & { id?: string | undefined; dur?: number | undefined }) | null): { shot: FlybyShot; err: { eye: number; look: number } } {
    const o = opts || {};
    const e = poseFromWorld(track, eye, o);
    let lookOpts: PoseOpts = { at: "track" };
    if (e.pose.at === "landmark") {
      const nl = nearestLandmark(track, target);
      if (nl && nl.rank === e.pose.rank && nl.d <= lmSize(track, nl.r)) lookOpts = { at: "landmark", rank: nl.rank };
    }
    const t = poseFromWorld(track, target, lookOpts);
    const f = Math.round((fov || 50) * 10) / 10;
    return {
      shot: { id: o.id || "freecam", dur: o.dur || 0.1, ease: "inOut",
        eye: [e.pose, Object.assign({}, e.pose)], look: [t.pose, Object.assign({}, t.pose)], fov: [f, f] },
      err: { eye: e.err, look: t.err },
    };
  }

  /** A MOVE ALONG THE TRACK FOLLOWS THE TRACK. Interpolating two track-anchored
   *  poses as world points draws a straight line between them, which cuts every
   *  corner in between: the closing grid shot runs ~200 m from behind the back
   *  row to the line, and at Bahrain that chord left the road by up to 49 m —
   *  a shot authored as "up the middle of the grid" ended up in the run-off.
   *  Track-anchored pairs therefore interpolate in TRACK space (arc, lateral,
   *  height) and convert once, which also handles a move that crosses the
   *  start line, where the raw arc numbers jump by a lap.
   *
   *  A pair that is not track-anchored (the whole-circuit and landmark orbits)
   *  has no arc to walk, so those still interpolate as world points.
   *  flyby-seq.js:880 */
  function lerpPose(track: FlybyTrack, a: FlybyPose, b: FlybyPose, u: number, out: Vec3): Vec3 {
    if (trackAnchored(a) && trackAnchored(b)) {
      const total = track.total || 1;
      const sa = anchorS(track, a), sb = anchorS(track, b);
      let d = sb - sa;
      while (d > total / 2) d -= total;          // go the short way round the lap
      while (d < -total / 2) d += total;
      const xa = poseX(track, a, sa), xb = poseX(track, b, sb);
      trackSample(track, wrapS(track, sa + d * u), _smp);
      const x = xa + (xb - xa) * u;
      out[0] = _smp.p[0] + _smp.r[0] * x;
      out[1] = _smp.p[1] + (a.y || 0) + ((b.y || 0) - (a.y || 0)) * u;
      out[2] = _smp.p[2] + _smp.r[2] * x;
      return out;
    }
    posePoint(track, a, _pa);
    posePoint(track, b, _pb);
    out[0] = _pa[0] + (_pb[0] - _pa[0]) * u;
    out[1] = _pa[1] + (_pb[1] - _pa[1]) * u;
    out[2] = _pa[2] + (_pb[2] - _pa[2]) * u;
    return out;
  }
  const _pa: Vec3 = [0, 0, 0], _pb: Vec3 = [0, 0, 0];

  // ---- solve ---------------------------------------------------------------

  const _eye: Vec3 = [0, 0, 0], _tgt: Vec3 = [0, 0, 0];
  const _out: FlybyFrame = { eye: _eye, tgt: _tgt, fov: 50, index: 0, id: "", cut: false, lift: 0, corner: 0 };

  /* ONE CAR THROUGH EACH CORNER SHOT. The menu field is scenery, not a
     simulation: move the player's menu model along the baked racing line while a turn is on
     air, then put it back on its grid box before the finale. The apex is the
     midpoint by construction; speedAt supplies both the travel window and the
     displayed wheel/body speed. This is broadcast-only and never runs on the
     player's physics state or after the menu hands over to the countdown. The
     player's model is deliberate: the field renderer culls rivals more than
     550 m from the grid-seated player, while it always keeps that model.
     flyby-seq.js:1052-1091 */
  let _heroCars: readonly HeroCar[] | null = null, _hero: HeroCar | null = null, _heroHome: Partial<HeroCar> | null = null;
  function restoreHero(): void {
    if (_hero && _heroHome) Object.assign(_hero, _heroHome);
  }
  function setHeroCars(cars: readonly HeroCar[] | null | undefined): void {
    if (cars === _heroCars) return;
    restoreHero();
    _heroCars = Array.isArray(cars) ? cars : null;
    _hero = _heroCars && (_heroCars.find((c) => c && c.isPlayer) || _heroCars[0]) || null;
    _heroHome = _hero ? {
      s: _hero.s, x: _hero.x, xVis: _hero.xVis, px: _hero.px, pz: _hero.pz, speed: _hero.speed,
      rPrevS: _hero.rPrevS, rPrevX: _hero.rPrevX, rPrevPx: _hero.rPrevPx, rPrevPz: _hero.rPrevPz,
    } : null;
  }
  const _heroSmp = newSample();
  function driveHero(track: FlybyTrack | null | undefined, apexS: number, t: number, seconds: number, cars?: readonly HeroCar[] | null): HeroCar | null {
    if (cars !== undefined) setHeroCars(cars);
    const speedAt = deps.speedAt;
    if (!_hero || !track || !speedAt) return null;
    const apexV = speedAt(apexS);
    if (!(apexV != null && apexV > 0)) return null;
    let s = apexS + (Math.max(0, Math.min(1, t)) - 0.5) * apexV * Math.max(0, seconds || 0);
    s %= track.total; if (s < 0) s += track.total;
    const line = lineAt(track, s), v = speedAt(s);
    trackSample(track, s, _heroSmp);
    const x = line && isFinite(line.x) ? line.x : 0;
    _hero.s = _hero.rPrevS = s; _hero.x = _hero.rPrevX = _hero.xVis = x;
    _hero.px = _hero.rPrevPx = _heroSmp.p[0] + _heroSmp.r[0] * x;
    _hero.pz = _hero.rPrevPz = _heroSmp.p[2] + _heroSmp.r[2] * x;
    _hero.speed = v != null && v > 0 ? v : apexV;
    return _hero;
  }

  /** Plan `shots` before they play: a cold corner plan is a visible stall at its
   *  cut (up to ~0.2 s desktop, ~1 s on a phone). The opening WARM_NOW shots are
   *  planned at once and the rest one per timer slice, so the RACE! tap does not
   *  pay for shots 20 s away. Plans go straight into planShot's cache — never
   *  through solve(), whose cut tracking a background call would disturb. A newer
   *  warm() (the next load) retires an unfinished one. flyby-seq.js:1099-1118 */
  const WARM_NOW = 2;
  let _warmGen = 0;
  function warm(track: FlybyTrack, shots?: readonly FlybyShot[] | null): void {
    const list = bindCorners(track, (shots && shots.length) ? shots : DEFAULT);
    let total = 0;
    for (let i = 0; i < list.length; i++) total += list[i]!.dur || 0;
    if (!(total > 0)) return;
    const gen = ++_warmGen;
    const plan = (i: number): void => { const sh = landmarkFallback(track, list[i]!); planShot(track, sh, (sh.dur || 1) / total); };
    for (let i = 0; i < Math.min(WARM_NOW, list.length); i++) plan(i);
    let i = WARM_NOW;
    const next = (): void => { if (gen !== _warmGen || i >= list.length) return; plan(i++); setTimeout(next, 0); };
    if (i < list.length) setTimeout(next, 0);
  }
  /** Retire an unfinished warm(): the race started (or the screen closed), and
   *  its remaining plans would only stall the countdown. */
  function cancelWarm(): void { _warmGen++; }
  // The SAME array when nothing is dropped: bindCorners and the plans cache by identity.
  /** The same plans as warm(), one shot per call, for a caller that owns the
   *  pacing (the menu, between its idle slices). step() → true when all are planned. */
  function planSteps(track: FlybyTrack, shots?: readonly FlybyShot[] | null): () => boolean {
    const list = bindCorners(track, (shots && shots.length) ? shots : DEFAULT);
    let total = 0, i = 0;
    for (let j = 0; j < list.length; j++) total += list[j]!.dur || 0;
    return () => {
      if (!(total > 0) || i >= list.length) return true;
      const sh = landmarkFallback(track, list[i++]!);
      planShot(track, sh, (sh.dur || 1) / total);
      return i >= list.length;
    };
  }
  const withoutSlot = (list: readonly FlybyShot[]): readonly FlybyShot[] => { const out = list.filter(fitsGrid); return out.length && out.length < list.length ? out : list; };
  /** Every shot that films the standing grid, gone: a real race joined mid-race
   *  (a rolling start) or watched back has no grid to show, and the field
   *  seated for these shots is the game's order, not the real one. Durations
   *  are fractions, so the rest share the budget (as withoutSlot's do). */
  const FILMS_GRID: Readonly<Record<string, number>> = { grid: 1, pole: 1, slot: 1 };   // the anchors that frame the standing field (grid-front stands at pole)
  const filmsGrid = (sh: FlybyShot): boolean => [sh.eye[0], sh.eye[1], sh.look[0], sh.look[1]].some((p) => !!p && !!FILMS_GRID[p.at as string]);
  const withoutGrid = (list: readonly FlybyShot[]): readonly FlybyShot[] => { const out = list.filter((sh) => !filmsGrid(sh)); return out.length ? out : list; };

  /** The camera at `u` (0..1) through the whole sequence. Returns a POOLED
   *  object — read it, do not keep it. `cut` is true on the frame a new shot
   *  starts, so the caller can snap its damping instead of smearing the cut.
   *
   *  Beyond 1 the sequence holds on its last frame rather than looping: the
   *  screen is skippable, so a player who waits should not see it restart.
   *  flyby-seq.js:1181 */
  function solve(track: FlybyTrack, u: number, shots?: readonly FlybyShot[] | null): FlybyFrame {
    const list = bindCorners(track, (shots && shots.length) ? shots : DEFAULT);
    const on = shotAt(u, list), idx = on.index, t = on.t, total = on.total;
    const shot = landmarkFallback(track, list[idx]!);
    const dur = shot.dur || 1;
    const e = easeOf(shot.ease)(t);

    // The PLAN is the authored shot after every per-shot correction (grid
    // sightline, corner step-in, pan budget, lift profile) — see planShot().
    const plan = planShot(track, shot, dur / total);
    lerpPose(track, plan.eye[0]!, plan.eye[1]!, e, _eye);
    lerpPose(track, plan.look[0]!, plan.look[1]!, e, _tgt);
    const authoredY = _eye[1];
    // A shot that runs low along the track is trusted as authored (see onRoadPose).
    if (!plan.onRoad) {
      _eye[1] += liftAt(plan.prof, e);
      floorEye(track, clearEye(track, _eye));   // safety net only: the profile already cleared every sample
    }
    // How far the clearance had to lift this eye. A shot authored beside a
    // building lifts a metre or two; one authored INSIDE a grandstand lifts
    // twenty. Reported so the difference is measurable rather than a matter of
    // squinting at a height — the unit test and tools/shot/flyby.mjs both read it.
    _out.lift = _eye[1] - authoredY;
    _out.fov = (shot.fov ? shot.fov[0]! + (shot.fov[1]! - shot.fov[0]!) * e : 50) * (plan.fovK || 1);
    _out.cut = idx !== _lastIdx;
    _lastIdx = idx;
    _out.index = idx;
    _out.id = shot.id || String(idx);
    // The corner this shot films, as the lap's turn number (bound: a role is a
    // number by now), or 0. The loading card marks it on its map (airCorner).
    const k = shotCorner(shot);
    _out.corner = _airCorner = typeof k === "number" && k > 0 ? k : 0;
    if (_out.corner) driveHero(track, cornerS(track, _out.corner), t, dur / total * _flyS);
    else restoreHero();
    const reduced = !!(deps.reducedMotion && deps.reducedMotion());
    const sway = swayAt(shot, t, reduced);
    if (sway) {
      let dx = _tgt[0] - _eye[0], dz = _tgt[2] - _eye[2];
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl; _eye[0] -= dz * sway; _eye[2] += dx * sway;
    }
    if (deps.present) deps.present(presentation(u, list, reduced), _out.cut);
    return _out;
  }
  let _lastIdx = -1, _airCorner = 0;
  /** The turn number the last solve() filmed, 0 for none (a grid, landmark or
   *  whole-circuit shot). Read by js/ui/loading-screen.js: shotAt() knows the
   *  shot's name but not its corner, which only exists once bindCorners() has
   *  resolved "first"/"slowest" against the built world. */
  function airCorner(): number { return _airCorner; }

  /* THE LIFT IS PLANNED PER SHOT, NOT DISCOVERED PER FRAME. clearEye() alone
     runs on the frame the eye enters a box, so the camera popped straight up
     mid-shot the instant it touched one: 17 m in a single frame on Monza's
     turn-late, 54 m on Shanghai's turn-mid, at 27 circuits. The shot's path is
     sampled once (LIFT_N points along the eased parameter), the lift each
     sample needs is recorded, and the lift at any point is the largest of
     those needs FADED linearly over LIFT_W of the shot either side — so the
     camera is already rising before it reaches the obstruction and settles
     after it.

     AND A CORNER SHOT IS MOVED IN BEFORE IT IS LIFTED. Only street circuits
     get the fence cap, so a corner eye 15-18 m out on an open circuit grazed
     Shanghai's, Mexico's and Sochi's trackside structures and was lifted 30-54
     m clear of them — a crane shot of a roof instead of a corner. When a
     corner shot needs more than LIFT_OK, both eyes step towards the road
     together, 1.5 m at a time (never inside IN_MIN of the centreline), and the
     least-lifted plan wins. Cached per shot object on the track; an edited
     list is new objects and recomputes. flyby-seq.js:1231-1249 */
  const LIFT_N = 32, LIFT_W = 0.3, LIFT_OK = 4, IN_STEP = 1.5, IN_MIN = 9;

  /* TREES ARE OBSTACLES TO A PLAN, NOT TO A FRAME. Canopies are not in the
     solid set — a camera brushing a hedge is not a camera inside a wall, and
     lifting every frame over every pine would make forest circuits all crane
     — but a PLANNED eye should not sit in one: the frame report found Monza's
     turn-first eye inside a stone-pine canopy, a screen of leaves. So the
     plan's profile clears tall trees too (TREE_H up, their full box, TREE_M
     over the top), which is what the step-in then works to avoid, and the
     per-frame safety net (clearEye) still ignores them. flyby-seq.js:1251-1281 */
  const TREES = ["pine", "stonePine", "cypress", "broadleafFall", "palm", "acacia", "tree"];
  const TREE_H = 8, TREE_M = 1;
  function treeBlockers(track: FlybyTrack): PropRec[] {
    const C = cacheOf(track);
    if (C.trees) return C.trees;
    const out: PropRec[] = [];
    const list = track.props && track.props.list;
    if (list) for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      if (r && r.h >= TREE_H && TREES.indexOf(r.kind) !== -1) out.push(r);
    }
    C.trees = out;
    return out;
  }
  function clearTrees(track: FlybyTrack, eye: Vec3): Vec3 {
    const b = treeBlockers(track);
    const C = cacheOf(track);
    const near = nearBoxes(C.treeGrid || (C.treeGrid = boxGrid(b)), eye[0], eye[2], 0);
    for (let n = 0; n < near.length; n++) {
      const r = b[near[n]!]!;
      if (Math.abs(eye[0] - r.x) < r.w / 2 && Math.abs(eye[2] - r.z) < r.d / 2 &&
          eye[1] > r.y - r.h / 2 && eye[1] < r.y + r.h / 2 + TREE_M) eye[1] = r.y + r.h / 2 + TREE_M;
    }
    return eye;
  }

  const _lp: Vec3 = [0, 0, 0];
  /* The profile is SAMPLED, and the per-frame safety net is not: an eye that
     grazes a box's corner between two samples was lifted 27 m for one frame
     at Sochi's turn-late. So the plan clears solids with the safety net's
     margin PLUS half the widest gap between its samples — anything the net
     could catch between two samples, the plan has already cleared.
     flyby-seq.js:1284-1312 */
  const _lq: Vec3 = [0, 0, 0];
  function profileOf(track: FlybyTrack, eye0: FlybyPose, eye1: FlybyPose): { prof: Float32Array; max: number } {
    const prof = new Float32Array(LIFT_N + 1);
    let max = 0, gap = 0;
    lerpPose(track, eye0, eye1, 0, _lq);
    for (let j = 1; j <= LIFT_N; j++) {
      lerpPose(track, eye0, eye1, j / LIFT_N, _lp);
      gap = Math.max(gap, Math.hypot(_lp[0] - _lq[0], _lp[1] - _lq[1], _lp[2] - _lq[2]));
      _lq[0] = _lp[0]; _lq[1] = _lp[1]; _lq[2] = _lp[2];
    }
    const m = CLEAR_M + gap / 2 + 0.25;
    for (let j = 0; j <= LIFT_N; j++) {
      lerpPose(track, eye0, eye1, j / LIFT_N, _lp);
      const y0 = _lp[1];
      for (let k = 0; k < 3; k++) {
        const y = _lp[1];
        floorEye(track, clearTrees(track, clearEye(track, _lp, m)));
        if (_lp[1] === y) break;
      }
      prof[j] = _lp[1] - y0;
      if (prof[j]! > max) max = prof[j]!;
    }
    return { prof: bridge(prof), max: max };
  }
  /* A LIFT HOLDS ACROSS A SHORT GAP. Two obstructions a little apart left the
     faded profile with a valley between them, and the camera dipped 8 m and
     rose again inside one shot (Mont-Tremblant's turn-late, through a pine
     wood with one clearing) — a bob, and at 20 m up a fast pitch. A valley
     narrower than BRIDGE of the shot is filled at the lower of its two sides.
     flyby-seq.js:1313-1328 */
  const BRIDGE = 0.6;
  function bridge(prof: Float32Array): Float32Array {
    const n = prof.length, w = Math.round(BRIDGE * (n - 1)), out = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      let l = 0, r = 0;
      for (let i = Math.max(0, j - w); i <= j; i++) if (prof[i]! > l) l = prof[i]!;
      for (let i = j; i <= Math.min(n - 1, j + w); i++) if (prof[i]! > r) r = prof[i]!;
      out[j] = Math.max(prof[j]!, Math.min(l, r));
    }
    return out;
  }
  /** A corner eye k steps towards the road; a landmark eye k steps towards its
   *  landmark (LM_STEP of the distance each, never under LM_IN_MIN of it). */
  const LM_STEP = 0.08, LM_IN_MIN = 0.6;
  function inset(pose: FlybyPose, k: number): FlybyPose {
    if (pose.at === "landmark") {
      if (!((pose.distK || 0) > 0)) return pose;
      const o = Object.assign({}, pose);
      o.distK = pose.distK! * Math.max(LM_IN_MIN, 1 - k * LM_STEP);
      return o;
    }
    const x = pose.x || 0, ax = Math.abs(x);
    if (pose.at !== "corner" || ax <= IN_MIN) return pose;
    const o = Object.assign({}, pose);
    o.x = (x > 0 ? 1 : -1) * Math.max(IN_MIN, ax - k * IN_STEP);
    return o;
  }

  /* NO LANDMARK TO FILM. A circuit with one landmark filmed it twice (the
     rank clamps), and one with none filmed the start line from 20 m up. A
     landmark shot whose rank this circuit does not have becomes a whole-circuit
     shot from a side the establishing shots do not use (FB_BEAR, by rank), so
     the sequence still has as many different pictures as it has shots. Cached
     per shot object, like the plan. flyby-seq.js:1346-1369 */
  const FB_BEAR = [1.25, -1.75];
  function landmarkFallback(track: FlybyTrack, shot: FlybyShot): FlybyShot {
    let rank = -1;
    const poses = [shot.eye[0], shot.eye[1], shot.look[0], shot.look[1]];
    for (let i = 0; i < 4; i++) { const p = poses[i]; if (p && p.at === "landmark") rank = Math.max(rank, p.rank || 0); }
    if (rank < 0 || rank < landmarks(track).length) return shot;
    const C = cacheOf(track);
    const cache = C.fallback || (C.fallback = new WeakMap());
    let fb = cache.get(shot);
    if (fb) return fb;
    const bear = FB_BEAR[Math.min(rank, FB_BEAR.length - 1)]!;
    fb = Object.assign({}, shot, {
      eye: [{ at: "centre", bear: bear - 0.1, distR: 0.75, yR: 0.24 },
            { at: "centre", bear: bear + 0.1, distR: 0.66, yR: 0.2 }],
      look: [{ at: "centre", distR: 0, yR: 0 }, { at: "centre", distR: 0, yR: 0 }],
    });
    cache.set(shot, fb);
    return fb;
  }

  /* A SIGHTLINE DOWN THE GRID STAYS OVER THE GRID. The grid shots look 60-110
     m up the road from an eye on the centreline; on a grid that runs out of a
     bend (Bahrain's, Jeddah's, Magny-Cours's) that chord crossed the infield —
     13.6 m past the road edge at Bahrain, a crane shot of the inside
     grandstand. A shot whose eye runs down the road (onRoadPose) and whose
     look is a road pose too has each look's LEAD over its eye shortened, in
     steps, until the chord stays within SIGHT_EDGE of the road edge at every
     sample, never below SIGHT_MIN of the authored lead. flyby-seq.js:1371-1434 */
  const SIGHT_EDGE = 1, SIGHT_MIN = 0.3;
  const _sa: Vec3 = [0, 0, 0], _sb: Vec3 = [0, 0, 0], _sm = newSample();
  function arcDelta(track: FlybyTrack, a: FlybyPose, b: FlybyPose): number {
    const total = track.total || 1;
    let d = anchorS(track, b) - anchorS(track, a);
    while (d > total / 2) d -= total;
    while (d < -total / 2) d += total;
    return d;
  }
  // The arc position lerpPose puts a track-anchored pose pair at for `u`.
  function lerpS(track: FlybyTrack, a: FlybyPose, b: FlybyPose, u: number): number {
    const sa = anchorS(track, a);
    let d = anchorS(track, b) - sa;
    const total = track.total || 1;
    while (d > total / 2) d -= total;
    while (d < -total / 2) d += total;
    return sa + d * u;
  }
  // HINTED projection: both ends of every chord are road poses (planLook's
  // gate), so each sample's arc position is known to within the chord's own
  // sag, and the hint turns a full-lap scan (n nodes, 40 per call) into the
  // ±16-node window. Measured identical planShot looks across all 52 circuits.
  function sightOff(track: FlybyTrack, eye: FlybyPose[], look: FlybyPose[]): number {
    let worst = -Infinity;
    const total = track.total || 1;
    for (let j = 0; j <= 4; j++) {
      lerpPose(track, eye[0]!, eye[1]!, j / 4, _sa);
      lerpPose(track, look[0]!, look[1]!, j / 4, _sb);
      const se = lerpS(track, eye[0]!, eye[1]!, j / 4);
      let dl = lerpS(track, look[0]!, look[1]!, j / 4) - se;
      while (dl > total / 2) dl -= total;
      while (dl < -total / 2) dl += total;
      for (let k = 1; k <= 8; k++) {
        const f = k / 8;
        const pr = trackProject(track, _sa[0] + (_sb[0] - _sa[0]) * f, _sa[2] + (_sb[2] - _sa[2]) * f, se + dl * f);
        if (!pr) continue;
        trackSample(track, pr.s, _sm);
        const off = Math.abs(pr.lat) - (_sm.hw || 10);
        if (off > worst) worst = off;
      }
    }
    return worst;
  }
  function planLook(track: FlybyTrack, eye: FlybyPose[], look: FlybyPose[]): FlybyPose[] {
    if (!(onRoadPose(eye[0]) && onRoadPose(eye[1]) && trackAnchored(look[0]) && trackAnchored(look[1]) &&
          look[0]!.at !== "corner" && look[1]!.at !== "corner")) return look;
    if (sightOff(track, eye, look) <= SIGHT_EDGE) return look;
    const lead = [arcDelta(track, eye[0]!, look[0]!), arcDelta(track, eye[1]!, look[1]!)];
    let best = look;
    for (let f = 0.9; f >= SIGHT_MIN - 1e-9; f -= 0.1) {
      const cand = [0, 1].map((i) => Object.assign({}, look[i], { off: (look[i]!.off || 0) - (1 - f) * lead[i]! }));
      best = cand;
      if (sightOff(track, eye, cand) <= SIGHT_EDGE) break;
    }
    return best;
  }

  /* PANS HAVE A SPEED LIMIT. Eye and look are interpolated separately, so a
     corner shot whose eye sweeps round the outside of a hairpin while its look
     slides through it turned the view 150-200 degrees a second at the ease's
     peak (Bahrain's turn-late 206, Monaco's turn-mid 152) — a whip pan, read
     as a glitch. The plan measures the peak rate over REF_S (the loading
     screen's FLY_MS; the unit test pins the two together) and, while it is
     over PAN_MAX, squeezes the shot's travel about its middle (both pairs, the
     same factor), down to PAN_MIN_K of it.

     PAN_MAX WAS 40 deg/s, and the frame report (tools/shot/frame-report.mjs,
     2026-10-04) flagged every corner shot on Monza, Spa and Monaco at 34-40
     deg/s with the eye sliding 50-93 deg/s past what it filmed: the limit was
     the whip, not the crane. Both are held to the report's own thresholds now
     (FAST_PAN 25, FAST_MOVE 30): the PAN is the view direction's turn rate, the
     PARALLAX the eye's speed over its distance to the target (100 m/s is a
     crawl 800 m out and a blur 10 m from a car). flyby-seq.js:1436-1476 */
  const PAN_K = 0.85, PAN_MIN_K = 0.03, PAN_N = 48;
  const _pe: Vec3 = [0, 0, 0], _pt: Vec3 = [0, 0, 0];
  /** The shot's worst motion as a multiple of its budget: > 1 is too fast. */
  function panRate(track: FlybyTrack, shot: FlybyShot, frac: number, eye: FlybyPose[], look: FlybyPose[], prof: Float32Array | null): number {
    const ease = easeOf(shot.ease);
    let peak = 0, para = 0, px = 0, py = 0, pz = 0, ex = 0, ey = 0, ez = 0;
    for (let j = 0; j <= PAN_N; j++) {
      const e = ease(j / PAN_N);
      lerpPose(track, eye[0]!, eye[1]!, e, _pe);
      if (prof) _pe[1] += liftAt(prof, e);
      lerpPose(track, look[0]!, look[1]!, e, _pt);
      let dx = _pt[0] - _pe[0], dy = _pt[1] - _pe[1], dz = _pt[2] - _pe[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      if (j) {
        const a = Math.acos(Math.max(-1, Math.min(1, dx * px + dy * py + dz * pz)));
        if (a > peak) peak = a;
        const m = Math.hypot(_pe[0] - ex, _pe[1] - ey, _pe[2] - ez) / l;
        if (m > para) para = m;
      }
      px = dx; py = dy; pz = dz; ex = _pe[0]; ey = _pe[1]; ez = _pe[2];
    }
    const per = PAN_N / (Math.max(1e-6, frac) * _flyS);
    return Math.max(peak * per / PAN_MAX, para * per / PARA_MAX);
  }
  /** The run's real length: a habitual skipper's flyby is 10 s, and every shot
   *  planned against REF_S's 20 panned at twice PAN_MAX. */
  const PAN_RUNGS = Math.floor(Math.log(PAN_MIN_K) / Math.log(PAN_K) + 1e-9);   // 0.85^21 = 0.033: the walk's last rung (0.103 left a lift ramp whipping at the bottom)
  let _flyS = REF_S;
  function setDuration(ms: number | null | undefined): void { _flyS = ms != null && ms > 0 ? ms / 1000 : REF_S; }
  const DIP_MS = 150, REDUCED_DIP_MS = 300;
  function presentation(u: number, shots: readonly FlybyShot[] | null | undefined, reduced: boolean): FlybyPresentation {
    const on = shotAt(u, shots), cuts = boundaries(shots);
    let near = Infinity;
    for (const cut of cuts) near = Math.min(near, Math.abs((+u || 0) - cut) * _flyS * 1000);
    const dipMs = reduced ? REDUCED_DIP_MS : DIP_MS;
    const id = on.id || "";
    return {
      dip: near < dipMs ? 1 - near / dipMs : 0,
      dipMs,
      sectors: id === "wide" ? on.t : (/^wide/.test(id) ? 1 : 0),
    };
  }
  function squeeze(track: FlybyTrack, pair: FlybyPose[], k: number): FlybyPose[] {
    const a = pair[0]!, b = pair[1]!;
    if (trackAnchored(a) && trackAnchored(b)) {
      const d = arcDelta(track, a, b) * (1 - k) / 2;
      if (!d) return pair;
      return [Object.assign({}, a, { off: (a.off || 0) + d }), Object.assign({}, b, { off: (b.off || 0) - d })];
    }
    if (a.at === b.at && (a.at === "centre" || a.at === "landmark") && (a.bear || 0) !== (b.bear || 0)) {
      const d = ((b.bear || 0) - (a.bear || 0)) * (1 - k) / 2;
      return [Object.assign({}, a, { bear: (a.bear || 0) + d }), Object.assign({}, b, { bear: (b.bear || 0) - d })];
    }
    return pair;
  }

  /** Eye poses with the least lift: authored, else stepped in (corners towards
   *  the road, landmarks towards the landmark), the least-lifted winning.
   *  flyby-seq.js:1536 */
  function planEye(track: FlybyTrack, eye: FlybyPose[]): PlannedEye {
    const e0 = eye[0]!, e1 = eye[1]!;
    let best = profileOf(track, e0, e1), out = eye;
    if (best.max > LIFT_OK && (e0.at === "corner" || e1.at === "corner" || e0.at === "landmark" || e1.at === "landmark")) {
      for (let k = 1; k <= 8; k++) {
        const a = inset(e0, k), b = inset(e1, k);
        if (a === e0 && b === e1) break;
        const p = profileOf(track, a, b);
        if (p.max < best.max) { best = p; out = [a, b]; }
        if (p.max <= LIFT_OK) break;
      }
      // STEPPING IN CAN RUN OUT OF ROOM: a thin structure or a treeline standing
      // AT the fence (Sochi's turn-mid, 16 m of sparse hull at 9 m out) is in
      // the way at every inset. Stepping OUT past it, OUT_STEP at a time to
      // OUT_MAX, is the other side of the same obstacle; still the least lift wins.
      for (let k = 1; best.max > LIFT_OK && k <= OUT_N; k++) {
        const a = outset(e0, k), b = outset(e1, k);
        if (a === e0 && b === e1) break;
        const p = profileOf(track, a, b);
        if (p.max < best.max - 0.5) { best = p; out = [a, b]; }
      }
      // Last, SLIDE the move: a corner eye along the arc, a landmark eye round
      // its landmark. An obstruction at one END of a move (Istanbul's turn-mid
      // began inside a 24 m hull and craned down out of it) is often a few
      // metres from a clean start.
      const base = out;
      for (let i = 0; best.max > LIFT_OK && i < NUDGE.length; i++) {
        const a = nudge(base[0]!, NUDGE[i]!), b = nudge(base[1]!, NUDGE[i]!);
        if (a === base[0] && b === base[1]) continue;
        const p = profileOf(track, a, b);
        if (p.max < best.max - 0.5) { best = p; out = [a, b]; }
      }
      // A CORNER WALLED IN BY TREES has no clear eye at the fence at any
      // inset, outset or slide (Mont-Tremblant's turn-late craned 17-21 m up a
      // pine wood and still looked through canopy). Last resort: drop to the
      // road's OUTER EDGE, low — nothing grows on the tarmac, and a road-level
      // camera looks down the tree tunnel at the corner instead of over it.
      if (best.max > TREE_ROAD && e0.at === "corner" && e1.at === "corner") {
        const a = roadEdge(e0), b = roadEdge(e1);
        const p = profileOf(track, a, b);
        if (p.max < best.max) { best = p; out = [a, b]; }
      }
    }
    return { eye: out, prof: best.prof };
  }
  const TREE_ROAD = 8, EDGE_X = 5.5, EDGE_Y = 3.2;
  function roadEdge(pose: FlybyPose): FlybyPose {
    const o = Object.assign({}, pose);
    o.x = ((pose.x as number) >= 0 ? 1 : -1) * EDGE_X;   // f1-game: `pose.x >= 0` (undefined → false → -1)
    o.y = Math.min(pose.y || EDGE_Y, EDGE_Y);
    return o;
  }
  const NUDGE = [1, -1, 2, -2];
  function nudge(pose: FlybyPose, k: number): FlybyPose {
    if (pose.at === "corner") return Object.assign({}, pose, { off: (pose.off || 0) + k * 8 });
    if (pose.at === "landmark" && (pose.distK || 0) > 0) return Object.assign({}, pose, { bear: (pose.bear || 0) + k * 0.2 });
    return pose;
  }
  const OUT_STEP = 2, OUT_N = 6, OUT_MAX = 30;
  function outset(pose: FlybyPose, k: number): FlybyPose {
    const x = pose.x || 0, ax = Math.abs(x);
    if (pose.at !== "corner" || !x) return pose;
    const o = Object.assign({}, pose);
    o.x = (x > 0 ? 1 : -1) * Math.min(OUT_MAX, ax + k * OUT_STEP);
    return o;
  }

  /* AN EYE THAT STAYS OUT OF THE SCENERY CAN STILL BE BEHIND IT. Everything
     above keeps the eye from standing IN a box; nothing asked what stood
     between the eye and the shot's subject, and the frame report found it
     systematic (2026-10-04): Monza's turn-first framed a grandstand across the
     whole left third at 7 m (score 9), Spa's landmark2 a pine at 3 m, the
     wide shots saw 15-47 % of the lap through the forest. So every shot is
     JUDGED before it is kept: FlybySight.frame() casts the start, middle and
     end of the move against the same box model the report uses, and a shot
     whose subject is lost to a near occluder (> NEAR_SUBJ), whose nearest
     30 m fills a third (> NEAR_THIRD), or whose cost is over FRAME_OK, tries
     the alternatives in order — BACK OFF along the outside, RAISE, then
     MIRROR to the other side — and keeps the first that passes, else the
     cheapest. A whole-circuit shot evaluates every azimuth and three heights
     and keeps the one that sees the most lap. Eyes only — the subject is the
     author's, and so is the look, except a whole-circuit shot's TILT (level()
     below). Cached in the plan, like the lift. flyby-seq.js:1603-1628 */
  // An eye ON the road (the grid shots, at head height) is held close to the
  // report's own NEAR_OBSTRUCTION (nearObsThirdPct 25): Monaco's grid walk
  // passed at 0.4 with the barrier across 31 % of its left third, when 12 m on
  // and 5 m across was clear. 0.28, not 0.25: this raster reads a few points
  // high, and at 0.25 Mexico's clean walk (19 % in the report) re-planned to
  // a worse one. Off the road the looser 0.4 stands (the fleet audit is tuned to it).
  const NEAR_ROAD = 0.28;
  const NEAR_SUBJ = 0.25, NEAR_THIRD = 0.4, FRAME_OK = 20, FRAME_TIE = 0.1, FRAME_MISS = 5, FRAME_FAST = 15, FRAME_PLANS = 3, FRAME_SCREEN = 8;
  const _fe: Vec3 = [0, 0, 0], _ft: Vec3 = [0, 0, 0];
  const _fs = newSample();

  /** The points a shot is ABOUT, read off its look — the frame report's own
   *  subjects (tools/shot/frame-report.mjs subjectFor), thinner. flyby-seq.js:1632 */
  function subjectOf(track: FlybyTrack, shot: FlybyShot): SightSubject | null {
    const C = cacheOf(track);
    const cache = C.subj || (C.subj = new WeakMap());
    const hit = cache.get(shot);
    if (hit && hit.n === _gridSize) return hit.subj;
    const a: FlybyPose = shot.look[0] || {}, b = shot.look[1] || a, L = track.total || 1;
    const road = (s0: number, s1: number, step: number, lats: readonly number[]): Vec3[] => {
      const pts: Vec3[] = [];
      for (let s = s0; s <= s1; s += step) {
        trackSample(track, wrapS(track, s), _fs);
        const rl = Math.hypot(_fs.r[0], _fs.r[2]) || 1;
        for (let i = 0; i < lats.length; i++) {
          const l = lats[i]! * _fs.hw;
          pts.push([_fs.p[0] + _fs.r[0] / rl * l, _fs.p[1] + 0.3, _fs.p[2] + _fs.r[2] / rl * l]);
        }
      }
      return pts;
    };
    let subj: SightSubject | null = null;
    if (a.at === "landmark") {
      const lm = landmarks(track);
      if (lm.length) {
        const rec = lm[Math.min(a.rank || 0, lm.length - 1)]!, pts: Vec3[] = [];
        for (const fx of [-0.45, 0, 0.45]) for (const fy of [-0.45, 0, 0.45]) for (const fz of [-0.45, 0, 0.45]) {
          pts.push([rec.x + fx * rec.w, rec.y + fy * rec.h, rec.z + fz * rec.d]);
        }
        subj = { pts, skip: (bx: SightBox) => bx.rec === rec, box: rec };
      }
    } else if (a.at === "centre") {
      subj = { pts: road(0, L - 1, L / 32, [-0.85, 0, 0.85]), lap: true };
    } else if (a.at === "corner") {
      const sc = cornerS(track, a.n || 1);
      const rel = (s: number): number => { let d = s - sc; while (d > L / 2) d -= L; while (d < -L / 2) d += L; return d; };
      const lo = Math.min(rel(anchorS(track, a)), rel(anchorS(track, b)), 0) - 30;
      const hi = Math.max(rel(anchorS(track, a)), rel(anchorS(track, b)), 0) + 30;
      subj = { pts: road(sc + lo, sc + hi, 8, [-0.85, 0, 0.85]), strip: 3 };
    } else {
      // The standing field: one point mid-car and one at each end, every slot.
      const pts: Vec3[] = [];
      for (let k = 0; k < _gridSize; k++) {
        const s = wrapS(track, L - POLE_BACK - k * GRID_SPACING);
        const x = slotX(track, k, s);
        trackSample(track, s, _fs);
        const tl = Math.hypot(_fs.t[0], _fs.t[2]) || 1, fx = _fs.t[0] / tl, fz = _fs.t[2] / tl;
        const cx = _fs.p[0] + _fs.r[0] * x, cz = _fs.p[2] + _fs.r[2] * x, cy = _fs.p[1] + 0.5;
        pts.push([cx, cy + 0.3, cz], [cx + fx * 2.2, cy + 0.2, cz + fz * 2.2], [cx - fx * 2.2, cy + 0.2, cz - fz * 2.2]);
      }
      subj = pts.length ? { pts, field: true } : null;
    }
    cache.set(shot, { n: _gridSize, subj });
    return subj;
  }

  /** A candidate move, judged at its first, middle and last frame: the worst. */
  const FRAME_AT = [0, 0.5, 1], SCREEN_AT = [0, 1], SKETCH_AT = [0.5];
  /** The camera of a move at `e` into _fe/_ft, as solve() will film it; its fov. flyby-seq.js:1687 */
  function frameAt(track: FlybyTrack, shot: FlybyShot, eye: FlybyPose[], look: FlybyPose[], prof: Float32Array | null, onRoad: boolean, e: number, fovK?: number): number {
    lerpPose(track, eye[0]!, eye[1]!, e, _fe);
    lerpPose(track, look[0]!, look[1]!, e, _ft);
    if (!onRoad) { if (prof) _fe[1] += liftAt(prof, e); floorEye(track, clearEye(track, _fe)); }
    return (shot.fov ? shot.fov[0]! + (shot.fov[1]! - shot.fov[0]!) * e : 50) * (fovK || 1);
  }
  /** flyby-seq.js:1693 */
  function judgeMove(track: FlybyTrack, shot: FlybyShot, eye: FlybyPose[], look: FlybyPose[], prof: Float32Array | null, onRoad: boolean,
    subj: SightSubject, at?: readonly number[] | null, coarse?: boolean, fovK?: number, withMix?: boolean, lapCover?: boolean): MoveJudgement {
    const w: MoveJudgement = { cost: 0, near: 0, nearSubj: 0, inside: false, ground: 0, mixCost: 0, inF: 1, vis: 1, cover: null, ok: false }, es = at || FRAME_AT;
    // `withMix`: the rest of the frame too (FlybySight.mix, a lap shot's
    // ground and sky) at the move's two ENDS, the worst added once — the end
    // that swings over open lawn is the one the report flags (Monza's wide:
    // 71 % at its start, 67 % mid-shot). Only level() pays for it.
    const mixed = !!withMix && !!subj.lap;
    for (let j = 0; j < es.length; j++) {
      const fov = frameAt(track, shot, eye, look, prof, onRoad, es[j]!, fovK);
      const f: FrameJudgement = FlybySight.frame(track, _fe, _ft, fov, subj, coarse, mixed && (j === 0 || j === es.length - 1), lapCover);
      if (f.mix) { w.ground = Math.max(w.ground, f.mix.ground); w.mixCost = Math.max(w.mixCost, f.mixCost); }
      if (f.cost - f.mixCost > w.cost) w.cost = f.cost - f.mixCost;
      if (f.near > w.near) w.near = f.near;
      if (f.nearSubj > w.nearSubj) w.nearSubj = f.nearSubj;
      if (f.inF < w.inF) w.inF = f.inF;
      if (f.vis < w.vis) w.vis = f.vis;
      if (f.cover != null && (w.cover == null || f.cover < w.cover)) w.cover = f.cover;
      if (f.inside) w.inside = true;
    }
    w.cost += w.mixCost;
    w.ok = !w.inside && w.nearSubj <= NEAR_SUBJ && w.near <= (onRoad ? NEAR_ROAD : NEAR_THIRD) && w.cost <= FRAME_OK;
    return w;
  }
  /** The most ground either end of a move shows (FlybySight.mix alone). */
  function groundOf(track: FlybyTrack, shot: FlybyShot, eye: FlybyPose[], look: FlybyPose[], prof: Float32Array | null, onRoad: boolean, fovK?: number): number {
    let g = 0;
    for (const e of [0, 1]) {
      const fov = frameAt(track, shot, eye, look, prof, onRoad, e, fovK);
      g = Math.max(g, FlybySight.mix(track, FlybySight.camera(_fe, _ft, fov, 16 / 9)).ground);
    }
    return g;
  }

  /* A WIDE SHOT KEEPS ITS HORIZON IN FRAME. The establishing shots look at the
     lap's centroid from a helicopter, and on a flat park circuit that is a
     frame of lawn: Monza's wide shots looked down 16 degrees with the horizon
     at the top edge and the report flagged 72-80 % of every frame ground
     (EMPTY_GROUND). level() takes the PLANNED eye and raises its look (TILT)
     just far enough that both ends clear FlybySight.GROUND_OK: the tilt that
     moves the horizon down by the excess (the rows a tilt pushes out of the
     bottom are open ground, so the share falls about a row for a row),
     judged in full and stepped once more if short, and kept only when the
     judgement is cheaper than the level frame's. The eye is the solver's;
     only the aim moves, and only on a whole-circuit look. (A coarse 32-ray
     mix read a tilt that took 16 rows of ground away as adding 7.)
     flyby-seq.js:1726-1775 */
  const TILT_MAX = 0.7, TILT_PAD = 0.05;
  const _te: Vec3 = [0, 0, 0], _tl: Vec3 = [0, 0, 0];
  /** A whole-circuit look raised by `k` of the eye's height over it, at each end. */
  function tilt(track: FlybyTrack, eye: FlybyPose[], look: FlybyPose[], k: number): FlybyPose[] {
    return [0, 1].map((i) => {
      if (look[i]!.at !== "centre") return look[i]!;
      posePoint(track, eye[i]!, _te); posePoint(track, look[i]!, _tl);
      return Object.assign({}, look[i], { y: (look[i]!.y || 0) + k * Math.max(0, _te[1] - _tl[1]) });
    });
  }
  function level(track: FlybyTrack, shot: FlybyShot, frac: number, fin: Fin, onRoad: boolean, subj: SightSubject, fovK: number,
    best: MoveJudgement, cand: Framing | null, ref: MoveJudgement | null): { j: MoveJudgement; f: Fin } | null {
    if (fin.look[0]!.at !== "centre" || fin.look[1]!.at !== "centre") return null;
    const eye = fin.pe.eye, prof = fin.pe.prof, ok = FlybySight.GROUND_OK;
    const g0 = groundOf(track, shot, eye, fin.look, prof, onRoad, fovK);
    if (g0 <= ok) return null;
    const fov = frameAt(track, shot, eye, fin.look, prof, onRoad, 0.5, fovK);
    const H = _fe[1] - _ft[1], D = Math.hypot(_fe[0] - _ft[0], _fe[2] - _ft[2]);
    if (!(H > 1 && D > 1)) return null;
    // Lowering the horizon by a fraction `dr` of the frame's height takes
    // tan(pitch) up by 2 tan(fov/2) dr; the look rises D times that.
    const perRow = 2 * Math.tan(fov * Math.PI / 360) * D / H;
    // The untilted plan pays the same ground term on the same estimate; a
    // tilt is kept when its full judgement (ground included) is cheaper, even
    // one still a point or two over: the estimate counts the road as ground.
    let bestCost = best.cost + (best.ok ? 0 : FRAME_MISS) + FlybySight.mixCost({ ground: g0, sky: 0 }), out: { j: MoveJudgement; f: Fin } | null = null;
    let dr = 0, g = g0;
    for (let n = 0; n < 3 && g > ok; n++) {
      dr += g - ok + TILT_PAD;
      const k = Math.min(TILT_MAX, dr * perRow), lk = tilt(track, eye, fin.look, k);
      if (!fin.fast && panRate(track, shot, frac, eye, lk, prof) > 1) break;
      const j = judgeMove(track, shot, eye, lk, prof, onRoad, subj, FRAME_AT, false, fovK, true, !!(cand && cand.aim));
      g = j.ground;
      const cost = j.cost + (j.ok ? 0 : FRAME_MISS) + lapLoss(ref || best, j, cand, LAP_TILT);
      if (cost < bestCost) { bestCost = cost; out = { j, f: Object.assign({}, fin, { look: lk }) }; }
      if (k >= TILT_MAX) break;
    }
    return out;
  }

  /** The alternatives to an authored eye pair, in the order they are tried. */
  const ROAD_X = 8, ROAD_Y = 6;
  const LONG_LENS = 0.65, C_SCALE = [1, 1.4, 1.8], C_UP = [0, 6, 12, 22], C_SLIDE = [0, -25, 25, -50, 50, -90, 90, -120, 120], R_SLIDE = [0, -12, 12, -28, 28];
  const L_DIST = [1, 1.3, 0.75], L_UP = [0, 12, 24], L_TURN = [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2];
  // A whole-circuit eye at the CREST — as high as it can stand and still look
  // at the centroid shallower than W_CREST — sees down into a forest: Spa's lap
  // was 34-44 % visible from 250 m through the pines. A height in metres would
  // be steep at Monaco's 470 m and timid at Spa's 850; null in W_UP is the crest.
  // ±1.2 rad: Monaco's wide2 sees its lap past the mountain only from there.
  const W_TURN = [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2], W_UP = [0, 60, null], W_CREST = 23 * Math.PI / 180;
  // HIGHER STILL, AIMED THE SAME. The crest was still a grazing look into the
  // far half of a big forest lap: Spa (rad 1230 m, the eye clamped 850 m out)
  // saw 45-48 % of it through the pines from 360 m up, under the report's 50 %.
  // From the 30 and 36 deg crests its look is RAISED (aimed()) until it looks
  // down at W_AIM, shallower than the fov's half-angle so the horizon stays in
  // frame (at 23 deg Hockenheim's raised frame was 76 % lawn, EMPTY_GROUND):
  // the extra height buys sightline, not lawn. Tried only in a second round,
  // for a lap the plain framings still see under W_HIGH_VIS of (planShot).
  const W_HIGH = [30 * Math.PI / 180, 36 * Math.PI / 180], W_AIM = 15 * Math.PI / 180;
  function centreD(track: FlybyTrack, p: FlybyPose): number {
    const b = bounds(track), dR = p.distR === undefined ? 1.4 : p.distR;
    return dR > 0 ? Math.max(C_DMIN, Math.min(C_DMAX, dR * b.rad)) : 0;
  }
  function crestY(track: FlybyTrack, p: FlybyPose, ang?: number): number {
    if (p.at !== "centre") return 0;
    const b = bounds(track), yR = p.yR === undefined ? 0.5 : p.yR;
    const h = yR > 0 ? Math.max(C_HMIN, Math.min(C_HMAX, yR * b.rad)) : yR * b.rad;
    return Math.max(0, centreD(track, p) * Math.tan(ang || W_CREST) - h - (p.y || 0));
  }
  /** What a raised (W_HIGH) framing pays for the lap it lets out of frame: the
   *  report does not score a lap's in-frame share, so without this the cheapest
   *  high eye on Spa framed a third of the lap where the authored one framed
   *  62 %. LAP_SLACK of the authored share is free. */
  // …and for the road it thins: an eye high enough to see over the trees sees
  // a thinner ribbon, and Jeddah's and Vegas's raised framings kept a third of
  // their lap's cover (the report's SUBJECT_SMALL, 0.5 %). The planner's lap
  // cover is only roughly on the report's scale, so it pays twice: as a RATIO
  // to the plain framing it would replace (under LAP_THIN of it, LAP_THIN_K a
  // unit) and under LAP_COVER of the frame (a margin over the report's 0.5 %:
  // Spa's raised wide reads 0.76 here, 1.0-1.3 there; Jeddah's 0.47 and 0.3).
  const LAP_SLACK = 0.08, LAP_LOSS = 200, LAP_TILT = 60, W_HIGH_VIS = 0.6, LAP_THIN = 0.5, LAP_THIN_K = 100, LAP_COVER = 0.006;
  function lapLoss(j0: MoveJudgement, j: MoveJudgement, cand: Framing | null | undefined, rate?: number): number {
    if (!(cand && cand.aim)) return 0;
    let thin = 0;
    if (j.cover != null) thin = Math.max(0, LAP_COVER - j.cover) * LAP_THIN_K * 100 + (j0.cover != null && j0.cover > 0 ? Math.max(0, LAP_THIN - j.cover / j0.cover) * LAP_THIN_K : 0);
    return Math.max(0, j0.inF - LAP_SLACK - j.inF) * (rate || LAP_LOSS) + thin;
  }
  /** A whole-circuit look raised until `eye` looks down at it no steeper than
   *  `pitch` (a W_HIGH framing's aim); any other look, or no pitch, as given. */
  function aimed(track: FlybyTrack, eye: FlybyPose[], look: FlybyPose[], pitch: number | undefined): FlybyPose[] {
    if (!pitch) return look;
    return [0, 1].map((i) => {
      if (look[i]!.at !== "centre") return look[i]!;
      posePoint(track, eye[i]!, _te); posePoint(track, look[i]!, _tl);
      const up = _te[1] - _tl[1] - Math.hypot(_te[0] - _tl[0], _te[2] - _tl[2]) * Math.tan(pitch);
      return up > 0 ? Object.assign({}, look[i], { y: (look[i]!.y || 0) + up }) : look[i]!;
    });
  }
  /** Every alternative eye pair, the AUTHORED pair first (index 0), each
   *  tagged with its tier. flyby-seq.js:1837 */
  function framings(track: FlybyTrack, shot: FlybyShot): Framing[] {
    const e0 = shot.eye[0]!, e1 = shot.eye[1]!, at = e0 && e0.at;
    const out: Framing[] = [];
    let tier = 0;
    const add = (o: (p: FlybyPose) => FlybyPose, fovK?: number): void => {
      const c: Framing = [Object.assign({}, e0, o(e0)), Object.assign({}, e1, o(e1))]; c.tier = tier; c.fovK = fovK || 1; out.push(c);
    };
    if (onRoadPose(e0) && onRoadPose(e1)) {
      // Down the road: stay on it (|x| <= 8, y <= 6), so the closing shots are
      // never lifted — the other side of the aisle, a step across (2.5 m, or 5
      // off a barrier), a step up.
      // Then the same a little up or down the road: an angled stand's
      // axis-aligned box can reach across the tarmac for 30 m (Suzuka's).
      const cap = (x: number): number => Math.max(-ROAD_X, Math.min(ROAD_X, x));
      for (const ds of R_SLIDE) {
        tier++;
        for (const dy of [0, 1.5]) for (const dx of [0, null, 2.5, -2.5, 5, -5]) {
          add((p) => ({ x: dx === null ? -(p.x || 0) : cap((p.x || 0) + dx), y: Math.min(ROAD_Y, (p.y || 0) + dy), off: (p.off || 0) + ds }));
        }
      }
    } else if (at === "corner" && e1.at === "corner") {
      // Back off along the outside, then up, then the inside; then the same a
      // little up or down the road.
      for (const ds of C_SLIDE) for (const side of [1, -1]) {
        tier++;
        for (const dy of C_UP) for (const k of C_SCALE) {
          const o = (p: FlybyPose): FlybyPose => ({ x: (p.x || 0) * k * side, y: (p.y || 0) + dy, off: (p.off || 0) + ds });
          add(o);
          // A far or high eye can take the LONG LENS: the corner the same size
          // in frame from out past the stands that hide it from close in.
          if (dy >= 12 || Math.abs(ds) >= 50) add(o, LONG_LENS);
        }
      }
    } else if (at === "landmark" && e1.at === "landmark") {
      for (const db of L_TURN) {
        if (db <= 0) tier++;   // a turn and its mirror are one tier
        for (const dy of L_UP) for (const k of L_DIST) add((p) => ({ distK: (p.distK || 0) * k, y: (p.y || 0) + dy, bear: (p.bear || 0) + db }));
      }
    } else if (at === "centre" && e1.at === "centre") {
      for (const dy of W_UP) {
        // The crest only where it is above the last fixed step (else it is that step again).
        if (dy === null && !(Math.min(crestY(track, e0), crestY(track, e1)) > W_UP[1]! + 20)) continue;
        for (const db of W_TURN) add((p) => ({ bear: (p.bear || 0) + db, y: (p.y || 0) + (dy === null ? crestY(track, p) : dy) }));
      }
      let below = Math.max(W_UP[1]!, Math.min(crestY(track, e0), crestY(track, e1)));
      for (const ang of W_HIGH) {
        const up = Math.min(crestY(track, e0, ang), crestY(track, e1, ang));
        if (!(up > below + 20)) continue;   // the same step again
        below = up;
        for (const db of W_TURN) { add((p) => ({ bear: (p.bear || 0) + db, y: (p.y || 0) + crestY(track, p, ang) })); out[out.length - 1]!.aim = W_AIM; }
      }
    }
    return out;
  }

  /** flyby-seq.js:1890-2011 */
  function planShot(track: FlybyTrack, shot: FlybyShot, frac: number): FlybyPlan {
    const C = cacheOf(track);
    const cache = C.plan || (C.plan = new WeakMap());
    let plan = cache.get(shot);
    // REUSE WHAT STILL HOLDS. The slot is part of the key only for a shot aimed at
    // a slot, the grid size only for one aimed at the grid's back; and a plan made
    // for LESS screen time is squeezed at least as hard as this one needs (a list
    // that dropped a shot gives every other shot more time). Keying every shot on
    // the slot and the exact fraction threw the menu's plans away on most races.
    const secs = frac * _flyS, slot = usesSlot(shot) ? _playerSlot : -1, rows = usesGrid(shot) ? Math.min(GRID_ROWS, _gridSize) : -1;
    // …but only a plan made for NEARLY this much time: a plan squeezed for a
    // habitual skipper's 12 s flyby, reused once the flyby is 24 s again, played
    // the whole long flyby near-static until the track was rebuilt.
    if (plan && plan.secs <= secs + 1e-6 && plan.secs >= secs * 0.8 && plan.slot === slot && plan.rows === rows) return plan;
    const onRoad = onRoadPose(shot.eye[0]) && onRoadPose(shot.eye[1]);
    const noLift = new Float32Array(LIFT_N + 1);
    interface Src { eye: FlybyPose[]; look: FlybyPose[] }
    interface Rung { k: number; pe: PlannedEye; look: FlybyPose[]; rate: number; fast: boolean }
    const at = (src: Src, k: number): Rung => {
      const ey = k === 1 ? src.eye : squeeze(track, src.eye, k), lk = k === 1 ? src.look : squeeze(track, src.look, k);
      const pe = onRoad ? { eye: ey, prof: noLift } : planEye(track, ey);
      const rate = panRate(track, shot, frac, pe.eye, lk, pe.prof);
      return { k, pe, look: lk, rate, fast: rate > 1 };
    };
    const canSqueeze = (src: Src): boolean => squeeze(track, src.eye, 0.5) !== src.eye || squeeze(track, src.look, 0.5) !== src.look;
    // The widest travel under PAN_MAX, on the SAME 0.85^n ladder the planner has
    // always used (the fleet audit is tuned to those squeezes) — but found in 2-3
    // plans, not up to 14: the rate falls roughly with the travel, so the first
    // measurement predicts the rung; walk down while too fast, then up while the
    // rung above still passes. One planEye is up to ~30 ms on a dense circuit,
    // and walking down from the top cost 657 ms for one shot (Mont-Tremblant).
    const ladder = (src: Src): Rung => {
      let best = at(src, 1);
      if (best.fast && canSqueeze(src)) {   // else nothing to squeeze
        const rung = (n: number): Rung => at(src, Math.pow(PAN_K, n));
        const ahead = (c: Rung): number => Math.max(1, Math.ceil(Math.log(1 / c.rate) / Math.log(PAN_K)));   // rungs the rate says are left
        let lo = 0, n = Math.min(PAN_RUNGS, ahead(best));
        best = rung(n);
        while (best.fast && n < PAN_RUNGS) { lo = n; best = rung(n = Math.min(PAN_RUNGS, n + ahead(best))); }
        // Too fast at rung `lo`, passing at `n`: the highest passing rung between them.
        while (!best.fast && n - lo > 1) { const m = (lo + n) >> 1, c = rung(m); if (c.fast) lo = m; else { n = m; best = c; } }
      }
      return best;
    };
    // The squeezed look keeps the sightline rule: re-plan it against the eye.
    const finish = (c: Rung): Fin => ({ pe: c.pe, k: c.k, fast: c.fast, look: c.look !== shot.look ? planLook(track, c.pe.eye, c.look) : c.look });
    let fin = finish(ladder({ eye: shot.eye, look: planLook(track, shot.eye, shot.look) })), framing = 0, fovK = 1;
    // THE FRAMING (see NEAR_SUBJ above): the plan as it will play, judged; an
    // alternative eye is planned at the same squeeze (down the ladder while it
    // is still too fast) and judged the same way.
    const subj = subjectOf(track, shot);
    const tried: MoveJudgement[] = [];
    let picked: Framing | null = null, lapRef: MoveJudgement | null = null;
    if (subj) {
      const j0 = judgeMove(track, shot, fin.pe.eye, fin.look, fin.pe.prof, onRoad, subj);
      let best = j0;
      tried.push(j0);
      if (!j0.ok || fin.fast || subj.lap) {
        // SCREEN every alternative at the authored squeeze, unplanned (the
        // per-frame safety net only — an eye in a canopy screens as inside),
        // then PLAN the few best and judge them as they will play.
        const k = fin.k, n0 = Math.round(Math.log(k) / Math.log(PAN_K)), cands = framings(track, shot);
        const lk0 = k === 1 ? shot.look : squeeze(track, shot.look, k);
        // Tier by tier (a corner's outside, then its inside, then a slide along
        // the road): a tier with a passing framing ends the screen.
        // A SKETCH first (the middle frame, coarse), then both ends of the
        // best few at full resolution.
        // Two rounds: the plain framings, then — only for a lap the best of
        // them still sees under W_HIGH_VIS of — the raised ones (W_HIGH), each
        // paying for lap it lets out of frame against that best (lapLoss).
        let bestCost = j0.cost + (j0.ok ? 0 : FRAME_MISS) + (fin.fast ? FRAME_FAST : 0), ref = j0;
        for (let round = 0; round < 2; round++) {
          if (round === 1) {
            if (!(subj.lap && best.vis < W_HIGH_VIS)) break;
            // Height buys sightline AND lawn: this round is judged with the
            // frame's ground/sky (FlybySight.mix) and its lap's cover, so the
            // incumbent pays them too.
            const jr = judgeMove(track, shot, fin.pe.eye, fin.look, fin.pe.prof, onRoad, subj, FRAME_AT, false, fovK, true, true);
            bestCost += jr.cost - best.cost;
            ref = lapRef = jr;
          }
          const sketched: { i: number; ey: FlybyPose[]; lk: FlybyPose[]; cost: number }[] = [], screened: { i: number; cost: number }[] = [];
          for (let i = 1, pass = false; i < cands.length; i++) {
            if (!cands[i]!.aim !== !round) continue;
            if (pass && cands[i]!.tier !== cands[i - 1]!.tier) break;
            const ey = k === 1 ? cands[i]! : squeeze(track, cands[i]!, k);
            const lk = aimed(track, ey, planLook(track, ey, lk0), cands[i]!.aim);
            // On the road the sketch sees the whole move: a grid walk clears a
            // barrier mid-shot and meets it at the start (Monaco's, 31 %), and
            // a passing middle frame (on a coarse raster) ended the search a tier too soon.
            const j = judgeMove(track, shot, ey, lk, null, onRoad, subj, onRoad ? FRAME_AT : SKETCH_AT, !onRoad, cands[i]!.fovK, false, round === 1);
            sketched.push({ i, ey, lk, cost: j.cost + i * FRAME_TIE * 0.2 + lapLoss(ref, j, cands[i]) });
            if (j.ok && !subj.lap) pass = true;
          }
          sketched.sort((a, b) => a.cost - b.cost);
          for (let m = 0; m < Math.min(FRAME_SCREEN, sketched.length); m++) {
            const c = sketched[m]!, j = judgeMove(track, shot, c.ey, c.lk, null, onRoad, subj, SCREEN_AT, false, cands[c.i]!.fovK, false, round === 1);
            screened.push({ i: c.i, cost: Math.max(j.cost + lapLoss(ref, j, cands[c.i]), c.cost) + c.i * FRAME_TIE * 0.2 + (j.ok ? 0 : FRAME_MISS) });
          }
          screened.sort((a, b) => a.cost - b.cost);
          // A move still too fast at the ladder's last rung is a whip pan however
          // well framed: it pays like a missed framing.
          for (let m = 0; m < Math.min(FRAME_PLANS, screened.length); m++) {
            const i = screened[m]!.i, src = { eye: cands[i]!, look: aimed(track, cands[i]!, planLook(track, cands[i]!, shot.look), cands[i]!.aim) };
            let n = n0, c = at(src, k);
            while (c.fast && n < PAN_RUNGS && canSqueeze(src)) c = at(src, Math.pow(PAN_K, ++n));
            const f = finish(c);
            const j = judgeMove(track, shot, f.pe.eye, f.look, f.pe.prof, onRoad, subj, FRAME_AT, false, cands[i]!.fovK, round === 1, round === 1);
            tried.push(j);
            const cost = j.cost + i * FRAME_TIE * 0.2 + (j.ok ? 0 : FRAME_MISS) + (f.fast ? FRAME_FAST : 0) + lapLoss(ref, j, cands[i]);
            if (cost < bestCost) { bestCost = cost; fin = f; framing = i; fovK = cands[i]!.fovK!; best = j; picked = cands[i]!; }
            if (j.ok && !subj.lap) break;
          }
        }
      }
      if (subj.lap) {
        const lv = level(track, shot, frac, fin, onRoad, subj, fovK, best, picked, lapRef);
        if (lv) { fin = lv.f; tried.push(lv.j); }
      }
    }
    plan = { eye: fin.pe.eye, look: fin.look, prof: fin.pe.prof, onRoad: onRoad, frac: frac, secs: secs, squeeze: fin.k, slot: slot, rows: rows,
             framing: framing, fovK: fovK, fast: !!fin.fast, tried: tried };
    cache.set(shot, plan);
    return plan;
  }
  function liftAt(prof: Float32Array, e: number): number {
    let best = 0;
    for (let j = 0; j <= LIFT_N; j++) {
      if (!(prof[j]! > 0)) continue;
      const f = 1 - Math.abs(e - j / LIFT_N) / LIFT_W;
      if (f > 0 && prof[j]! * f > best) best = prof[j]! * f;
    }
    return best;
  }

  /* A DIFFERENT FLYBY EACH LOAD. The same nine shots on the fifth load of a
     circuit is a loading screen; the same LANGUAGE redrawn is a broadcast.
     vary() jitters the establishing bearings, sometimes films the second
     landmark first, sometimes runs a pan the other way, and draws the three
     corner shots from roles without repeats. The grid finale is fixed — it is
     the handoff to the race. Pure and seeded (never the sim RNG): the same
     seed is the same flyby, which is what the test holds it to.
     flyby-seq.js:2022-2049 */
  const VARY_ROLES = ["first", "lore", "slowest", "fastest", "mid", "late"];
  function vary(list: readonly FlybyShot[], seed: number, fit?: boolean): FlybyShot[] {
    if (fit !== false) list = list.filter(fitsGrid);   // durations renormalise in solve(); the menu passes false (the race's grid is not known yet)
    let h = (seed >>> 0) || 1;
    const rnd = (): number => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
    const used: Record<string, boolean> = {}, swapLm = rnd() < 0.35;   // decided ONCE: swapping one landmark shot alone films the same landmark twice
    return list.map((shot) => {
      if (/^grid/.test(shot.id || "")) return shot;
      const o = JSON.parse(JSON.stringify(shot)) as FlybyShot;
      const at = o.eye[0] && o.eye[0].at;
      if (at === "centre") { const j = (rnd() - 0.5) * 0.5; o.eye.forEach((p) => { p.bear = (p.bear || 0) + j; }); }
      if (at === "landmark" && swapLm) [o.eye, o.look].forEach((a) => a.forEach((p) => { p.rank = int(p.rank) === 0 ? 1 : 0; }));
      if (at === "corner") {
        const free = VARY_ROLES.filter((r) => !used[r]);
        const n = free.length ? free[Math.floor(rnd() * free.length)]! : o.eye[0]!.n;
        used[n as string] = true;
        [o.eye, o.look].forEach((a) => a.forEach((p) => { if (p.at === "corner") { if (n === undefined) delete p.n; else p.n = n; } }));
      } else if (rnd() < 0.4) { o.eye.reverse(); o.look.reverse(); if (o.fov) o.fov.reverse(); }
      return o;
    });
  }

  /** Called when a run begins, so the first frame of the first shot reads as a
   *  cut and the camera does not glide in from wherever it last was. */
  function reset(): void { _lastIdx = -1; _airCorner = 0; }

  return {
    solve, shotAt, warmProgress, airCorner, reset, clearEye, floorEye, groundAt, insideProp, blockers, isSolid, onRoadPose,
    landmarks, bounds, landmarkScore, lmBase, landmarkFallback, planShot, treeBlockers,
    anchorS, posePoint, cornerS, cornerSide, cornerTurn, lmFace, cornerList,
    poseFromWorld, shotFromView, nearestCorner, vary, setPlayerSlot, slotIndex, slotKnown, withoutSlot, withoutGrid, bindCorners, warm, cancelWarm, setDuration, planSteps,
    boundaries, presentation, swayAt, setHeroCars, driveHero, gridProgress,
    DEFAULT, GRID_SHOTS, EASE,
    POLE_BACK, GRID_SPACING, GRID_ROWS, MIN_FILL, MIN_H, FAR, FOG, NEAR, FENCE, REF_S, PAN_MAX, PARA_MAX,
  };
}

/** One FlybySeq instance's API (flyby-seq.js:2055-2063, plus cornerList). */
export type FlybySeq = ReturnType<typeof createFlybySeq>;
