/**
 * The GARAGE SETUP-PREVIEW CAMERA (#carsetup): the turntable/orbit rig, its
 * presets, pan and zoom, the active-aero demo, the preview mesh cache and the
 * whole non-track render path the garage draws through — plus the #cs-view /
 * #cs-cam-panel controls that drive it. The ROOM it renders into is
 * ./scene/scene.ts; the sheet beside it is ./setup-sheet.ts.
 *
 * Port of f1-game js/garage/setup-camera.js:1-1090, verbatim: panelCover
 * :10-24, the garage present (presentOpts / glareScale) :26-99, create
 * :101-1086 (drive-out :121-189, arrival preview :190-237, the orbit state and
 * presets :238-487, the preview mesh cache :488-539, garageCtx :540-597, the
 * camera snapshot and Home session :598-619, renderSetupPreview :620-857, the
 * #cs-view / #cs-cam-panel controls :859-1030, surface inspection :1032-1044,
 * the returned API :1046-1085).
 *
 * `SetupCamera.create(G, deps)` becomes `createSetupCamera(host, deps)`:
 * - `host` (SetupCameraHost) is a typed facade of exactly the members of
 *   f1-game's G this module reads; the caller keeps it live (getters), as
 *   game.js's G is.
 * - `deps` is f1-game's deps (resolveLivery, partsVisualKey, drawAeroFlaps, …)
 *   plus every global the IIFE read, each injected with the lane that owns the
 *   real one (see SetupCameraDeps). Absent optional globals reproduce f1-game's
 *   `typeof X === "undefined"` branch.
 * Deviations, none of which change a number:
 * - M4.perspectiveTo / lookAtTo (js/core/mat4.js:30-52) are ported privately
 *   below (src/xr/mat4.ts has only mulTo / invertTo, and that is lane-xr's).
 * - Every window/document listener is tracked and removed by `dispose()`,
 *   which f1-game (a page-lifetime singleton) never needed.
 * - presentOpts / glareScale take the tuner, phone and PerfGov reads as an
 *   explicit `env` instead of the LightTune / GLX / PerfGov globals.
 * - The ARRIVAL TUNER panel (#garrival, ga-*) is bound only when it is in the
 *   page; otherwise the arrival reads the stored settings directly.
 */
import { Car3D } from "../car/car3d";
import { Parts, type PartSetup, type PartsTeam } from "../car/parts";
import { Teams } from "../car/teams";
import { PhysicsConsts } from "../physics/consts";
import * as CssZoom from "../styles/css-zoom";
import { LIST as TRACK_LIST, SEASON as TRACK_SEASON } from "../track/core/tracks";
import { invertTo, mulTo } from "../xr/mat4";
import { log as dataLog } from "../data/log";
import * as GarageArrival from "./arrival";
import type { ArrivalPose, ArrivalSettings } from "./arrival";
import { GarageExperience as DefaultExperience, type GarageExperienceFull, type HomeShotName, type HomePose, type HomeState } from "./experience";
import { GarageSurfaceInspection, type SurfaceInspectionApi } from "./surface-inspection";
import { createGarageScene, type GarageSceneApi, type PreviewData } from "./scene/scene";
import type { DrawOpts, GarageAchievements, GarageCtx, GarageDriver, GarageGfx, GarageLivery, GarageLog, GarageTeam, GarageTrack, GfxMesh } from "./scene/types";
import type { GarageStoreLike } from "./store";

// Read at EVAL time, exactly as js/game.js reads its own physics constants —
// the garage eases the flaps at the rates the car uses on track, so there is
// one source for them. See the HARD_EDGES pair in tools/manifest.cjs.
const { X_OPEN_RATE, X_CLOSE_RATE } = PhysicsConsts;

/** A DOMRect-shaped box. */
export interface CoverRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

// WHERE THE DOCKED PANEL LEAVES THE CAR ITS ROOM — pure, so it is testable
// without a canvas (tests/unit/garage-panel-side.test.mjs). `pr` is the
// panel's visual rect, `cr` the canvas rect, cw/ch the canvas size, `camTop` a
// thunk for the open camera panel's top (read only on the portrait axis).
// Returns { x, y } as fractions of the canvas: x is SIGNED by which half the
// panel's centre sits in (+ right, the shipped dock, - left), so a right dock
// returns exactly the unsigned number it always did; y is the portrait band.
export function panelCover(pr: CoverRect, cr: CoverRect, cw: number, ch: number, camTop: () => number): { x: number; y: number } {
  const lim = (v: number): number => (v < 0 ? 0 : v > 0.85 ? 0.85 : v);   // M4.clamp(v, 0, 0.85), the clamp this replaced
  if (cw - pr.width >= ch - pr.height) {
    const f = lim(pr.width / cw);
    return { x: f > 0 && pr.left + pr.right < cr.left + cr.right ? -f : f, y: 0 };
  }
  return { x: 0, y: lim((pr.bottom + Math.min(camTop(), ch) - ch) / ch) };
}

// Garage present, in the same units as the race path (game.js):
//   exposure  = base * LT.exposureMul
//   bloom     = base * LT.bloomMul   (off on a phone, and shed at autoTier 4)
//   threshold = clamp(base + LT.threshOff, 0.4, 1.2) * baseExposure
//   tune.sunShaftMul is FORCED OFF. The bay's "sun" is a soft roof fill
//   (GarageScene.SKYLIGHT, dir Y≈0.86) — PostCommon.sunScreen still arms a
//   ~0.35 screen-shaft from that fill, and the composite then marches bloom
//   toward the skylight UV. After #1025 restored glossy dry-day paint, those
//   crepuscular rays washed liveries white/sky-blue once the camera (or a
//   team switch + orbit) put the fill on-screen. A closed pit bay has no sun
//   disc; SCREEN SUN-SHAFT is a race/outdoor knob. Exposure / bloom / glare
//   still route through LT so the Lighting Tuner can dial the bay.
// Bases are a showroom, not a night-bloom track: 1.04 / 0.20 / 0.86, not the
// old hardcoded 1.28 / 0.70 / 0.62. Slider 1 / glare 0.12 = these defaults.
export const SP_EXPOSURE = 1.04;
export const SP_BLOOM = 0.20;
export const SP_THRESH = 0.86;
export const RACE_GLARE_DEF = 0.12;

/** The Lighting Tuner's live knobs (LightTune.LT / LightKnobs.LT). TODO(lane-render): the tuner. */
export type LightTuneLike = Readonly<Record<string, unknown>>;
/** PerfGov's tier reads (js/render/perf-gov.js). TODO(lane-shell): the performance governor. */
export interface PerfGovLike {
  autoTier?(): number;
  userTier?(): number;
  autoShed?(): number;
}
/** Where presentOpts reads f1-game's globals from: LightTune/LightKnobs, GLX's phone flags, PerfGov. */
export interface PresentEnv {
  readonly lightTune?: (() => LightTuneLike | null | undefined) | undefined;
  /** GLX.isMobile || GLX.mobileTier (setup-camera.js:61-63). */
  readonly phone?: (() => boolean) | undefined;
  readonly perfGov?: PerfGovLike | null | undefined;
}
/** The garage present options (setup-camera.js:53-56), one reused object. */
export interface PresentOpts {
  exposure: number;
  bloom: number;
  threshold: number;
  contact: number;
  reflect: number;
  carReflect: number;
  ssao: number;
  godray: number;
  bloomLevels: number;
  tune: { sunShaftMul: number } | null;
}

function liveTune(env: PresentEnv): LightTuneLike | null {
  const T = env.lightTune ? env.lightTune() : null;
  return T || null;
}
function _tuneNum(T: LightTuneLike | null | undefined, id: string, fallback: number): number {
  const v = T ? T[id] : undefined;
  return T && Number.isFinite(v) ? v as number : fallback;
}
// Reused every garage frame — gfx.present / begin consume opts synchronously.
const _presentOpts: PresentOpts = {
  exposure: 0, bloom: 0, threshold: 0, contact: 0, reflect: 0, carReflect: 0,
  ssao: 0, godray: 0, bloomLevels: 0, tune: null,
};
const _presentTune = { sunShaftMul: 0 };
// A phone boots GRAPHICS MEDIUM, and the governor never ticks in the bay, so
// autoTier stays 0. Without this the present runs the full bloom mip chain
// (bloomLevels 0 means "all of them") plus the 0.05 car-paint SSR default.
function garagePhone(env: PresentEnv): boolean {
  return !!(env.phone && env.phone());
}
/** setup-camera.js:64-95. `tune` undefined reads the live tuner from `env`. */
export function presentOpts(tune?: LightTuneLike | null, env: PresentEnv = {}): PresentOpts {
  const T = tune === undefined ? liveTune(env) : tune;
  const exposureMul = _tuneNum(T, "exposureMul", 1);
  const bloomMul = _tuneNum(T, "bloomMul", 1);
  const threshOff = _tuneNum(T, "threshOff", 0);
  const phone = garagePhone(env);
  const PerfGov = env.perfGov;
  const shed = phone || (!!PerfGov && !!PerfGov.autoTier && PerfGov.autoTier() >= 4);
  const t = SP_THRESH + threshOff;
  const threshold = (t < 0.4 ? 0.4 : t > 1.2 ? 1.2 : t) * SP_EXPOSURE;
  // Kill screen sun-shafts regardless of the race slider / track preset.
  // Prototype chain carries the rest of the image-grade knobs (no Object.create).
  Object.setPrototypeOf(_presentTune, T && typeof T === "object" ? T : null);
  _presentTune.sunShaftMul = 0;
  _presentOpts.exposure = SP_EXPOSURE * exposureMul;
  _presentOpts.bloom = shed ? 0 : SP_BLOOM * bloomMul;
  _presentOpts.threshold = threshold;
  _presentOpts.contact = 0;
  // A closed bay has no wet road and no env probe. Omitted carReflect is the
  // 0.05 tuner default, which still marches car-paint SSR and blits depth.
  _presentOpts.reflect = 0;
  _presentOpts.carReflect = 0;
  _presentOpts.ssao = 0;
  _presentOpts.godray = 0;
  let levels = 0;
  if (!shed && PerfGov && PerfGov.userTier) {
    const ut = PerfGov.userTier() | 0, as = PerfGov.autoShed ? PerfGov.autoShed() | 0 : 0;
    levels = (as >= 3 || ut >= 4) ? 2 : ((as >= 1 || ut >= 2) ? 3 : 0);
  }
  _presentOpts.bloomLevels = levels;
  _presentOpts.tune = _presentTune;
  return _presentOpts;
}
/** setup-camera.js:96-99 */
export function glareScale(tune?: LightTuneLike | null, env: PresentEnv = {}): number {
  const T = tune === undefined ? liveTune(env) : tune;
  return _tuneNum(T, "glareStr", RACE_GLARE_DEF) / RACE_GLARE_DEF;
}

// ── M4.perspectiveTo / lookAtTo (js/core/mat4.js:30-52), verbatim ───────────
type Vec3In = ArrayLike<number>;
export function perspectiveTo(out: Float32Array, fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) / (near - far); out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}
export function lookAtTo(out: Float32Array, eye: Vec3In, target: Vec3In, up: Vec3In): Float32Array {
  const e0 = eye[0]!, e1 = eye[1]!, e2 = eye[2]!, u0 = up[0]!, u1 = up[1]!, u2 = up[2]!;
  let zx = e0 - target[0]!, zy = e1 - target[1]!, zz = e2 - target[2]!;
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = u1 * zz - u2 * zy, xy = u2 * zx - u0 * zz, xz = u0 * zy - u1 * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * e0 + xy * e1 + xz * e2);
  out[13] = -(yx * e0 + yy * e1 + yz * e2);
  out[14] = -(zx * e0 + zy * e1 + zz * e2);
  out[15] = 1;
  return out;
}

// ── the camera's constants (setup-camera.js:243-342) ────────────────────────
// Defaults: eye y 2.0 at dist 8.35 over a target at y 0.35 is an elevation of
// atan2(1.65, 8.5).
export const SP_EL_DEF = Math.atan2(1.65, 8.5), SP_DIST_DEF = 8.35;
// Half the car's BROADSIDE footprint (~5.95 m drawn) plus ~5% margin.
// Was 3.35 (~12%), then 3.15 after honest WGX off-axis projection. 3.10 is a
// hair closer on desktop after the view-matrix fix landed (1440x900 ~8.40 m).
export const SP_FIT_HALF_W = 3.10;
// How far the AUTOMATIC turntable may back off. Deliberately under the MANUAL
// zoom ceiling SP_DIST_MAX: a player who zooms out that far asked for the wide
// shot, whereas the auto fit reaching it means the fit diverged. js/garage/scene.js
// notes a camera at 15 m "is outside the bay on at least one axis nearly
// always"; 11 keeps the swing inside the door/back walls (Z +/-6.4) at the
// default elevation with real headroom over the 8.5 m default framing.
export const SP_FIT_DIST_MAX = 11;
// Orbit limits: never underneath the floor plane, never past straight down, and
// close enough to read a decal without clipping into the nose.
export const SP_EL_MIN = 0, SP_EL_MAX = 1.30, SP_DIST_MIN = 4.6, SP_DIST_MAX = 15, SP_DIST_FREE_MIN = 0.3;

/** A camera preset (setup-camera.js:282-305). `aim` names the wing a WING view orbits. */
export interface SpView {
  readonly az: number;
  readonly el: number;
  readonly dist: number;
  readonly aim?: "front" | "rear";
  readonly minDist?: number;
}
// az 0 = ahead of the nose (+Z), PI = behind the wing; see the eye vector below.
// Distances are per-view because the car is 5.4 m long and 1.9 m wide, and the
// sheet takes the right ~40% of the canvas: head-on it fits close, broadside it
// does not. SIDE and TOP get the extra pull-back their aspect actually needs
// rather than one nominal distance that crops the nose off two of the five.
export const SP_VIEWS: Readonly<Record<string, SpView>> = {
  hero:  { az: Math.PI * 0.78, el: 0.30, dist: 8.35 },   // rear three-quarter
  // A SURVEY FRAMING IS NOT A GAME PRESET. `bay` / `bayFront` lived here with
  // no #cs-stack button — production data carrying a shot tool's camera. They
  // are `az` / `el` / `dist` parameters now (garage-angles CAM_ALIAS), which
  // also lets the tool sweep between them; anything a PLAYER can pick belongs
  // in this table, and everything else is a parameter.
  front: { az: 0,              el: 0.20, dist: 8.2 },
  side:  { az: Math.PI * 0.5,  el: 0.10, dist: 11.2 },
  rear:  { az: Math.PI,        el: 0.22, dist: 8.4 },
  top:   { az: Math.PI * 0.5,  el: 1.20, dist: 11.5 },
  // WING views: framed for watching the active-aero flaps travel. Both are
  // deliberately three-quarter, never head-on — the flaps rotate about the
  // car's X axis, so a dead-on view looks straight down that axis and hides
  // the travel. `aim` names the wing the camera orbits (see setSetupView);
  // `minDist` lets them sit closer than the whole-car floor. Distances come
  // from the frustum (36 deg vertical fov, ~62% usable canvas width at the
  // target). REAR-WING used to sit at 2.8 m / el 0.36 — that cropped the far
  // endplate and parked the number board in the left half. 4.6 m back and a
  // little above wing height keeps both endplates, the main plane and the
  // beam wing in the visible half.
  wingFront: { az: Math.PI * 0.30, el: 0.34, dist: 3.6, aim: "front", minDist: 2.0 },
  wingRear:  { az: Math.PI * 0.72, el: 0.50, dist: 4.6, aim: "rear",  minDist: 2.4 },
};
// The point the preview camera ORBITS and LOOKS AT. The defaults reproduce the
// previous hard-coded numbers exactly (eye was offset -1.0 in z from a target at
// z 0), so every existing view is unchanged; only the wing presets move them.
// ORBIT AND AIM ARE THE SAME POINT, AND IT IS THE CAR'S CENTRE. These used to
// be [0, 0.35, -1.0] and [0, 0.35, 0] — a camera circling a point 1 m BEHIND
// the one it looked at, swinging the car across the frame instead of rotating
// it in place. The drawn body spans z -2.69..3.18 (measured), so its centre
// is z +0.245, not 0 and not -1.
export const SP_CAR_CTR: readonly number[] = [0, 0.45, 0.245];
// Bounds are a box around the car (~5.4 m long, ~1.9 m wide), sized so you can
// reach past either end and either flank but not lose the car off screen.
export const SP_PAN_X = 2.2, SP_PAN_Z = 3.4;
export const SP_RATE = { az: 1.8, el: 1.0, zoom: 2.4, pan: 1.5 } as const;
// Which livery fields can MOVE a vertex, as opposed to only recolouring one.
// Measured (tests/unit/setup-preview-hull.test.mjs builds the car both ways and
// compares positions byte for byte): a hue change never moves anything, and only
// the PRESENCE of these four does — they gate optional strip geometry. finShape
// is the one non-colour entry: it picks the shark fin's outline (or no fin).
// coverVents and spineHeight are the other enums that move a vertex, and
// spineSide moves the service panels aft of its flank band.
export const SP_HULL_GEOM_FIELDS: readonly string[] = ["stripe", "noseStripe", "nose", "pod", "finShape", "coverVents", "spineHeight", "spineSide"];
// Phone fill-rate. The bay shares the race framebuffer and the governor never
// ticks here, so renderScale stays 1 under a 1.5× DPR — including the pixels
// hidden by the sheet. 0.72 brings a 1.5× phone back to about 1× CSS pixels.
// Restored on the first world frame (endGarageRes). Photo studio stays sharp.
export const GARAGE_PHONE_SCALE = 0.72;

// ── the seams ───────────────────────────────────────────────────────────────

/** A car-paint material (game.js carPaintMat): DrawOpts plus the flake knob the preview damps. */
export interface CarPaint extends DrawOpts { sparkle?: number }

/** gfx.begin's frame description (js/render/gfx.js BEGIN). */
export interface GarageBeginOpts {
  readonly viewProj: Float32Array;
  readonly view: Float32Array;
  readonly eye: readonly number[];
  readonly sunDir: readonly number[];
  readonly sunColor: readonly number[];
  readonly ambientSky: readonly number[];
  readonly ambientGround: readonly number[];
  readonly fogColor: readonly number[];
  readonly fogDensity: number;
  readonly lights: number[];
  readonly proj: Float32Array;
  readonly invProj: Float32Array;
  readonly noEnv: boolean;
}

/**
 * The renderer facade the setup camera draws through: the scene's GarageGfx
 * plus the frame calls (resize / begin / drawGlow / present) and the phone
 * render-scale pin. f1-game's `G.gfx` (js/render/gfx.js). TODO(lane-render):
 * the production garage pass.
 */
export interface SetupGfx extends GarageGfx {
  readonly aspect: number;
  resize(): void;
  begin(opts: GarageBeginOpts): boolean | void;
  drawGlow(lights: number[], strength: number): void;
  present(opts: PresentOpts): void;
  warming?(): boolean;
  setRenderScale?(scale: number): void;
  getRenderScale?(): number;
}

/** A team as the camera reads it: Teams.LIST rows (src/car/teams.ts), MY TEAM, LEGENDS. */
export type CameraTeam = GarageTeam & {
  readonly id: string;
  readonly legends?: boolean | undefined;
  readonly engine?: string | null | undefined;
};
/** A resolved livery (CustomLiveries.resolveLivery): the bay's fields plus every livery field by name. */
export type CameraLivery = GarageLivery & { readonly [field: string]: unknown };
/** A circuit, as garageCtx reads it (Tracks.LIST / SEASON rows: `night` too). */
export type CameraTrack = GarageTrack & { readonly night?: boolean | undefined };

/**
 * The members of f1-game's G (js/game.js:3100-3240 façade) this module reads,
 * and the two it writes (setupPreviewOn, during an arrival preview). Keep it
 * live: the shell passes getters, as game.js does.
 */
export interface SetupCameraHost {
  $: (id: string) => HTMLElement | null;
  readonly gfx: SetupGfx;
  clamp(v: number, lo: number, hi: number): number;
  getTeamParts(teamId: string): PartSetup;
  readonly store: GarageStoreLike & { readonly rev?: number | undefined };
  readonly teamIdx: number;
  readonly driverIdx: number;
  readonly soundOn?: boolean | undefined;
  setupPreviewOn: boolean;
  readonly skyHold?: boolean | undefined;
  readonly skyT?: number | undefined;
  readonly raceWeather?: string | null | undefined;
  readonly raceTimeOfDay?: string | null | undefined;
  readonly seasonMode?: boolean | undefined;
  readonly season?: { readonly round: number } | null | undefined;
  readonly trackIdx?: number | undefined;
  readonly unlimitedBudget?: boolean | undefined;
}

/** teamDecalState(team, true) (game.js): the aero level and the decal/part state of the preview car. */
export interface DecalState {
  readonly val: number;
  readonly aero?: unknown;
  readonly parts?: unknown;
}

/** The surface contour (f1-game js/car/surface-outline.js GarageSurfaceOutline.create(gfx)). TODO(lane-car). */
export interface SurfaceOutlineLike {
  set(field: string, team: CameraTeam, liv: CameraLivery, num: unknown): boolean;
  draw(mesh: unknown, matrix: Float32Array): void;
  clear(): void;
}

/** GameAudio as the garage plays it (js/audio). TODO(lane-audio). */
export interface GarageAudioLike {
  uiTick?(): void;
  uiSelect?(): void;
  uiReject?(): void;
  setVoice?(engine: string | null | undefined): void;
  startEngine?(): void;
  stopEngine?(): void;
  setSkid?(amount: number, wet: boolean): void;
  setEngine?(rpm01: number, gear: number, limiter: boolean, load: number, mix: number, state: Readonly<Record<string, unknown>>): void;
}

/** The career, as garageCtx and garageSeat read it. TODO(lane-race). */
export interface CameraCareer {
  inCareer(): boolean;
  data(): CareerSave | null | undefined;
  calendar?(): readonly CameraTrack[];
  sponsor(): { readonly label?: string | null | undefined } | null | undefined;
  gridDrivers?(team: GarageTeam): readonly (GarageDriver | null | undefined)[] | null | undefined;
}
/** The slice of the career save garageCtx reads. */
export interface CareerSave {
  readonly season: { readonly round: number };
  readonly results: readonly { readonly p?: number | undefined; readonly dnf?: string | false | null | undefined; readonly pts?: number | undefined }[];
  readonly history?: readonly unknown[] | undefined;
}

/** Everything createSetupCamera reads beyond `host`. */
export interface SetupCameraDeps {
  // ── f1-game's deps (game.js:3480-3483) ──
  /** CustomLiveries.resolveLivery (src/car/custom-liveries.ts), memoised on store.rev. */
  resolveLivery(team: CameraTeam): CameraLivery;
  /** game.js partsVisualKey: the resolved option ids + livery id, the preview mesh key. */
  partsVisualKey(teamId: string): string;
  /** game.js teamDecalState(team, true). TODO(lane-render): car-draw. Absent = aero level 0. */
  teamDecalState?: ((team: CameraTeam, preview: boolean) => DecalState) | undefined;
  /** game.js drawAeroFlaps. TODO(lane-render): car-draw. Absent = no flaps drawn. */
  drawAeroFlaps?: ((team: CameraTeam, val: number, aeroX: number, mat: Float32Array, paint: CarPaint, aero: unknown) => void) | undefined;
  /** game.js carDecalNum. TODO(lane-render). */
  carDecalNum?: ((team: CameraTeam, car: null) => unknown) | undefined;
  /** game.js drawCarDecals. TODO(lane-render). Absent = no decals drawn. */
  drawCarDecals?: ((team: CameraTeam, mat: Float32Array, isPlayer: boolean, num: unknown, cockpit: boolean, night: boolean) => void) | undefined;
  /** game.js carPaintMat(PAINT_DRY_DAY). TODO(lane-render). Absent = a fresh default paint each frame. */
  carPaintMat?: ((which: unknown) => CarPaint) | undefined;
  readonly PAINT_DRY_DAY?: unknown;
  /** game.js:1179 MAT_REFLECT_X; the default is that matrix. */
  readonly MAT_REFLECT_X?: ArrayLike<number> | undefined;
  /** game.js render(dt): the one frame a paused race needs after the arrival preview. TODO(lane-shell). */
  render?: ((dt: number) => void) | undefined;
  /** game.js previewDecalMesh(team) for the surface contour. TODO(lane-render). */
  previewDecalMesh?: ((team: CameraTeam) => unknown) | undefined;

  // ── f1-game globals ──
  /** GarageScene. Default: a new createGarageScene() (initialised with host.gfx). */
  scene?: GarageSceneApi | undefined;
  /** Teams.LIST (with MY TEAM / LEGENDS spliced in by the shell). Default src/car/teams.ts LIST. */
  teams?: readonly CameraTeam[] | undefined;
  /** Tracks.LIST / Tracks.SEASON. Default src/track/core/tracks.ts. */
  tracks?: { readonly LIST: readonly CameraTrack[]; readonly SEASON: readonly CameraTrack[] } | undefined;
  /** SeasonCal.track(round). TODO(lane-race): the free-play season calendar. */
  seasonCal?: { track(round: number): CameraTrack | null | undefined } | null | undefined;
  /** Career. TODO(lane-race). Absent = never in a career. */
  career?: CameraCareer | null | undefined;
  /** CareerExperience.garageMetadata(). TODO(lane-race). */
  careerExperience?: { garageMetadata(): GarageAchievements | null | undefined } | null | undefined;
  /** GameAudio. TODO(lane-audio). */
  audio?: GarageAudioLike | null | undefined;
  /** LightTune.LT / LightKnobs.LT. TODO(lane-render). */
  lightTune?: (() => LightTuneLike | null | undefined) | undefined;
  /** PerfGov. TODO(lane-shell). */
  perfGov?: PerfGovLike | null | undefined;
  /** GLX.isMobile || GLX.mobileTier. Default: host.gfx.isMobile || host.gfx.mobileTier. */
  phone?: (() => boolean) | undefined;
  /** LoadingScreen.isAutomation(). TODO(lane-shell). */
  isAutomation?: (() => boolean) | undefined;
  /** GaragePrebuild.packSettled(Assets.state()). TODO(lane-shell). Absent = always settled. */
  packSettled?: (() => boolean) | undefined;
  /** MirrorPass.instance().standDown(). TODO(lane-render). */
  mirrorStandDown?: (() => void) | undefined;
  /** CarMesh.drawRearLights. TODO(lane-render). */
  drawRearLights?: ((mat: Float32Array, k: number) => void) | undefined;
  /** GarageSurfaceOutline.create(gfx). TODO(lane-car). Absent = no contour. */
  surfaceOutline?: SurfaceOutlineLike | null | undefined;
  /** GarageSurfaceInspection. Default the page's instance; null = absent. */
  surfaceInspection?: SurfaceInspectionApi | null | undefined;
  /** GarageExperience. Default ./experience.ts GarageExperience. */
  experience?: GarageExperienceFull | undefined;
  /** Car3D.build. Default src/car/car3d.ts. */
  buildCar?: ((c1: unknown, c2: unknown, opts: PreviewBuildOpts) => PreviewData) | undefined;
  /** Car3D.aeroFlapAim. Default src/car/car3d.ts. */
  aeroFlapAim?: ((val: number, which: "front" | "rear", aero: unknown) => readonly number[]) | undefined;
  log?: GarageLog | undefined;
  /** performance.now. */
  now?: (() => number) | undefined;
}

/** What getSetupPreviewMesh hands Car3D.build (setup-camera.js:528-534). */
export interface PreviewBuildOpts {
  livery: CameraLivery;
  teamId: string;
  num: unknown;
  helmetKey: string | null | undefined;
  parts: unknown;
}

/** captureCamera's snapshot (setup-camera.js:598-602). */
export interface CameraSnapshot {
  az: number;
  el: number;
  dist: number;
  spin: boolean;
  orbit: number[];
  target: number[];
  pan: number[];
  minDist: number;
  free: boolean;
  xOn: boolean;
  aeroX: number;
  view: string;
}

/** An arrival / drive-out / preview frame as the camera holds it. */
export type CameraPose = ArrivalPose & { last?: number };

/** SetupCamera.create's result (setup-camera.js:1048-1085) plus dispose(). */
export interface SetupCameraApi {
  beginHome(mode: string, opts?: { shot?: string; motion?: string; panel?: HTMLElement | null }): boolean;
  endHome(): boolean;
  renderHome(dt: number): boolean;
  homeState(): HomeState | null;
  captureCamera(): CameraSnapshot;
  restoreCamera(s: CameraSnapshot | null | undefined): void;
  startArrival(): void;
  cancelArrival(): void;
  startDriveOut(): number;
  driveOutLeft(): number;
  stopDriveOut(): void;
  renderSetupPreview(dt: number, holdDriveOut?: boolean): boolean;
  resetSetupCam(): void;
  setSetupCamPanel(open: boolean): void;
  spMeshBust(): void;
  endGarageRes(): void;
  stepSetupAero(dt: number): void;
  setSetupView(name: string): void;
  setSetupAero(on: boolean, opts?: { keepCam?: boolean }): void;
  setupPan(strafe: number, dolly: number): void;
  nudgeSetupCam(dAz: number, dEl: number, zoom: number): void;
  setSetupAim(p: readonly number[]): void;
  setSetupFree(on: boolean): void;
  readonly spin: boolean;
  readonly az: number;
  readonly el: number;
  readonly dist: number;
  readonly pan: number[];
  readonly aeroX: number;
  readonly xOn: boolean;
  readonly effDist: number;
  readonly effFit: number;
  readonly effPanel: number;
  previewKey(): string;
  prebuildKey(): string;
  prebuild(part: string): boolean;
  roomReady(): boolean;
  release(): boolean;
  meshKey: string;
  /** The room this camera draws (deps.scene or its own). */
  readonly scene: GarageSceneApi;
  /** Remove every window/document listener this camera added. Not in f1-game (page lifetime). */
  dispose(): void;
}

const MAT_REFLECT_X_DEF = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** SetupCamera.create (setup-camera.js:106-1086). */
export function createSetupCamera(G: SetupCameraHost, deps: SetupCameraDeps): SetupCameraApi {
  const Log = deps.log || dataLog;
  Log.info("game", "SetupCamera.create");
  const nowMs = deps.now || (() => performance.now());
  // Stable bindings from the game.js closure.
  const { $, gfx, clamp, getTeamParts } = G;
  const { resolveLivery, partsVisualKey } = deps;
  const teamDecalState = deps.teamDecalState || ((): DecalState => ({ val: 0, aero: null }));
  const carDecalNum = deps.carDecalNum || ((): unknown => null);
  const carPaintMat = deps.carPaintMat || ((): CarPaint => ({}));
  const PAINT_DRY_DAY = deps.PAINT_DRY_DAY;
  const MAT_REFLECT_X = deps.MAT_REFLECT_X || MAT_REFLECT_X_DEF;
  const render = deps.render || ((): void => {});
  const Teams_LIST: readonly CameraTeam[] = deps.teams || (Teams.LIST as unknown as readonly CameraTeam[]);
  const Tracks = deps.tracks || { LIST: TRACK_LIST as readonly CameraTrack[], SEASON: TRACK_SEASON as readonly CameraTrack[] };
  const Career = deps.career || null;
  const CareerExperience = deps.careerExperience || null;
  const GameAudio = deps.audio || null;
  const GarageExperience = deps.experience || DefaultExperience;
  const GarageSurfaceInspectionApi = deps.surfaceInspection === undefined ? GarageSurfaceInspection : deps.surfaceInspection;
  const buildCar = deps.buildCar || ((c1: unknown, c2: unknown, opts: PreviewBuildOpts): PreviewData =>
    Car3D.build(c1 as never, c2 as never, opts as never));
  const aeroFlapAim = deps.aeroFlapAim || ((val: number, which: "front" | "rear", aero: unknown): readonly number[] =>
    Car3D.aeroFlapAim(val, which, aero as never) as unknown as readonly number[]);
  const env: PresentEnv = {
    lightTune: deps.lightTune, perfGov: deps.perfGov,
    phone: deps.phone || (() => !!(gfx.isMobile || gfx.mobileTier)),
  };
  let GarageScene: GarageSceneApi;
  if (deps.scene) GarageScene = deps.scene;
  else { GarageScene = createGarageScene(); GarageScene.init(gfx); }
  const surfaceOutline = deps.surfaceOutline || null;

  // Window / document listeners, removed by dispose() (not in f1-game).
  const unlisten: (() => void)[] = [];
  function listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    unlisten.push(() => target.removeEventListener(type, fn, opts));
  }
  const uiTick = (): void => { if (GameAudio && GameAudio.uiTick) GameAudio.uiTick(); };

  const reducedMotion = (): boolean => {
    const mv = G.store.get("motion", null);
    if (mv === "off") return false;
    if (mv === "reduce") return true;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  };
  // The tuner panel (#garrival, the settings screen's) is wired only where it
  // exists: f1-game's page always had it; a garage mounted without the settings
  // screen reads the same stored settings directly (bindSettings' own reader).
  const arrival = GarageArrival.create($, reducedMotion, $("ga-enabled")
    ? GarageArrival.bindSettings($, G.store, { preview: startArrivalPreview })
    : () => GarageArrival.settings(G.store.get("garageArrival", null)));
  // THE PRE-RACE DRIVE-OUT (GarageArrival.poseOut): this room, the car rolling out,
  // played by js/game.js on every RACE! with no card up (LoadingScreen.garage) while
  // the circuit builds. Its pose stays "active" until stopDriveOut(), so the camera
  // never falls back to the turntable framing on the held last frame.
  let driveOut: { t: number; cfg: ArrivalSettings; last?: number } | null = null;
  function startDriveOut(): number {
    const cfg = GarageArrival.settings(G.store.get("garageArrival", null));
    endHome();
    driveOut = null;
    if (!cfg.enabled) return 0;
    // AUTOMATION skips it (LoadingScreen.isAutomation, the one gate #1294's 700 ms
    // card uses): a harness launch on software GL spent the ~10.6 s drive-out (up to 3x
    // on a stalled clock) plus awaitSoftPresent on top of a 30-90 s build and blew
    // the specs' 45 s grid wait (steering, quali). No drive-out means no studio and no
    // soft-present wait: game.js introGarage flies straight on, as with the tuner off.
    if (deps.isAutomation && deps.isAutomation()) return 0;
    // Reduce-motion plays it too, at the tuner's own pace (cfg.speed), never a
    // sped-up cut and never skipped — Start Race awaits this before the race/session
    // card (js/game.js studioDone → afterGarageOut → raceIntro).
    const play = Object.assign({}, cfg, { enabled: true });
    driveOut = { t: 0, cfg: play };
    driveOutEngine(true);
    return Math.round(GarageArrival.OUT_DURATION * 1000 / play.speed);
  }
  // Wall ms of the drive-out still to play: it advances on the clamped frame dt, so a
  // stalled frame (a circuit build on the main thread) delays it rather than skipping it.
  function driveOutLeft(): number {
    return driveOut ? Math.max(0, (GarageArrival.OUT_DURATION - driveOut.t) * 1000 / driveOut.cfg.speed) : 0;
  }
  // Stepped on the WALL clock, not the render dt the menu loop caps at 1/20 s: under
  // 20 fps that cap played the car in slow motion. A gap over 0.1 s (a synchronous
  // build) still only advances it 0.1 s, so a stall delays the car, never skips it.
  function stepDriveOut(held = false): CameraPose {
    const d = driveOut!;
    const now = nowMs(), gap = d.last ? (now - d.last) / 1000 : 0;
    d.last = now;
    if (!held) d.t += Math.min(0.1, Math.max(0, gap)) * d.cfg.speed;
    const pose = Object.assign(GarageArrival.poseOut(d.t, d.cfg, reducedMotion()), { active: true });
    driveOutSound(pose, gap);
    return pose;
  }
  // THE ENGINE ON THE WAY OUT (sound on): an idle while the shutter lifts, revs
  // with the car's speed as it rolls, a chirp of wheelspin as it pulls away. Its
  // own start/stop, so the race's startEngine (js/game.js, with its venue) builds
  // a fresh graph exactly as it did before: stopDriveOut always stops this one.
  let _outEngine = false, _outPrev: CameraPose | null = null;
  function driveOutEngine(on: boolean): void {
    if (on && G.soundOn && GameAudio && GameAudio.startEngine) {
      try {
        const team = Teams_LIST[G.teamIdx];
        if (GameAudio.setVoice) GameAudio.setVoice(team && team.engine);
        GameAudio.startEngine(); _outEngine = true; _outPrev = null;
      } catch (e) { _outEngine = false; Log.warn("audio", "garage engine failed", e); }
    } else if (!on && _outEngine) {
      _outEngine = false; _outPrev = null;
      try { GameAudio!.stopEngine!(); if (GameAudio!.setSkid) GameAudio!.setSkid(0, false); } catch { /* already down */ }
    }
  }
  function driveOutSound(pose: CameraPose, gap: number): void {
    if (!_outEngine || !(gap > 0)) { _outPrev = pose; return; }
    const p = _outPrev; _outPrev = pose;
    if (!p) return;
    const v = Math.hypot(pose.x - p.x, pose.z - p.z) / Math.min(0.1, gap);   // m/s along the path
    const s01 = Math.min(1, v / 12), rolling = v > 0.2;
    try {
      GameAudio!.setEngine!(rolling ? 0.22 + 0.35 * s01 : 0.12, 0, false, s01 * 0.2, 1,
        { throttle: rolling ? 0.45 : 0, brake: 0, slip: 0, wet: false });
      if (GameAudio!.setSkid) GameAudio!.setSkid(rolling && v < 2.5 ? 0.35 : 0, false);
    } catch { /* audio is decoration here */ }
  }
  // THE ARRIVAL PREVIEW (#garrival's PREVIEW IN / OUT): the tuner's saved settings
  // played once in this room, from the settings page — the title screen or a paused
  // race — so a speed, angle or lens is judged by eye. An explicit click, so it plays
  // with PLAY ARRIVAL off or reduced motion on. Its own clock on the render dt, as the
  // WORK ON CAR arrival runs; it never calls arrival.start()/chrome(), whose sheet is
  // not up. It ends by itself, on DONE or on Escape (the panel is hidden meanwhile,
  // so the layer stack cannot route Escape to DONE).
  let preview: { t: number; cfg: ArrivalSettings; dir: "in" | "out"; was: boolean; btn: HTMLElement | null | undefined } | null = null;
  function startArrivalPreview(dir?: string | null, btn?: HTMLElement | null): boolean {
    if (!dir) return stopPreview();
    endHome();
    const cs = $("carsetup");
    if (preview || driveOut || (cs && !cs.hidden)) return false;   // the garage or the RACE! drive-out owns the room
    const cfg = Object.assign(GarageArrival.settings(G.store.get("garageArrival", null)), { enabled: true });
    preview = { t: 0, cfg, dir: dir === "out" ? "out" : "in", was: G.setupPreviewOn, btn };
    Log.info("game", "SetupCamera.preview " + preview.dir);
    G.setupPreviewOn = true;
    const inner = $("garrival-inner");
    if (inner) inner.hidden = true;
    return true;
  }
  function stepPreview(dt: number): CameraPose {
    const p = preview!;
    p.t += Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0)) * p.cfg.speed;
    const pose = (p.dir === "out" ? GarageArrival.poseOut : GarageArrival.pose)(p.t, p.cfg, reducedMotion());
    if (pose.active) return pose;
    stopPreview();
    return Object.assign(pose, { active: true });   // this frame still holds the last pose, not the turntable's
  }
  function stopPreview(): boolean {
    if (!preview) return false;
    const p = preview;
    preview = null;
    G.setupPreviewOn = p.was;
    const inner = $("garrival-inner");
    if (inner) inner.hidden = false;
    if (p.btn && p.btn.focus) p.btn.focus();
    // A PAUSED RACE renders nothing while no tuner is open, so the garage would
    // stay on the canvas: one more frame, outside the render this may be called from.
    if (!p.was && typeof requestAnimationFrame === "function") requestAnimationFrame(() => render(0));
    return true;
  }
  listen(window, "keydown", (e) => {
    if ((e as KeyboardEvent).key !== "Escape" || !preview) return;
    stopPreview();
    e.preventDefault();
    e.stopPropagation();   // not the settings page's door as well
  }, true);
  const arrivalCar = new Float32Array(MAT_REFLECT_X);
  // A standalone, non-track, non-player render path for the #carsetup screen:
  // openSetup() has no `player`/`cars` yet (makeCars() only runs at race-start),
  // so the studio() rig (buildStudioRig in js/game.js) can't be reused — it hard-depends
  // on player.px/track. This is the same ring-of-lamps energy math, anchored at
  // the world origin instead of the player's track position.
  let setupPreviewAz = 0.6;
  // Preview CAMERA state. az/el/dist are a real orbit the player drives (drag on
  // the canvas, wheel/pinch to zoom, preset chips in #cs-view), and SPIN is a
  // toggle over the top of it rather than the whole interaction — a fixed
  // turntable makes inspecting the part you just bought a wait for it to come
  // back around.
  // The garage environment — bay shell, truss, LED fixtures, pit equipment, team
  // dress, floor and light rig — lives in ./scene/scene.ts. It owns the
  // frame clear colour too: every surface in there fades to exactly BACKDROP at
  // its far edge, so the room has no silhouette against the void.
  let setupPreviewEl = SP_EL_DEF, setupPreviewDist = SP_DIST_DEF;
  let setupPreviewSpin = true;
  // GARAGE active-aero demo. `setupPreviewXOn` is the button; `setupPreviewAeroX`
  // is the flap TRAVEL that the draw reads, eased toward it at the same rates the
  // car uses on track — so the garage shows the wings MOVING, at the real speed,
  // rather than snapping between two poses.
  let setupPreviewXOn = false, setupPreviewAeroX = 0;
  const SP_ORBIT_DEF = SP_CAR_CTR.slice(), SP_TGT_DEF = SP_CAR_CTR.slice();
  let setupPreviewOrbit = SP_ORBIT_DEF.slice(), setupPreviewTgt = SP_TGT_DEF.slice();
  let setupPreviewMinDist = 0, setupPreviewFree = false;   // 0 = use the global SP_DIST_MIN; free = a dev shot may leave the player's range
  // The player's orbit floor is 0 (never under the car) and a view's minDist; a
  // survey tool asking to look UP at a wing from the floor needs neither, and
  // setSetupFree lifts both until the next preset. Nothing the player can reach.
  const spElMin = (): number => (setupPreviewFree ? -SP_EL_MAX : SP_EL_MIN);
  const spDistMin = (): number => (setupPreviewFree ? SP_DIST_FREE_MIN : (setupPreviewMinDist || SP_DIST_MIN));
  // Last frame's RESOLVED framing, for __apex.garageCam(). Read-only telemetry.
  let _spEffDist = 0, _spEffFit = 0, _spEffPanel = 0;
  // THE GARAGE'S CLOCK. The bay's washer flickers on three sines of whatever
  // clock live() gets, so under performance.now() two captures at different WALL
  // instants light the room differently — a held render clock did not hold the
  // garage. Measurements: tools/shot/garage-angles.mjs header.
  const ambientClock = GarageExperience.clock(nowMs());
  function garageNow(): number {
    return G.skyHold ? (G.skyT as number) * 1000 : ambientClock.step(nowMs(), !document.hidden && !reducedMotion() && (!home.active || home.moving));
  }
  // PAN — a translation of the whole rig (orbit centre AND look-at) in car-local
  // metres. Orbit and zoom alone can only ever circle the same point, so there is
  // no way to walk along the car and study one end of it up close; you can only
  // back off until the whole car fits. Pan is what makes the preview a camera you
  // move rather than a turntable you watch.
  let setupPreviewPan = [0, 0, 0];
  const _spAim = [0, 0, 0];
  // Mid-chord of one flap, in car-local metres — what a wing view aims at. Read
  // from the same Car3D anchors the flaps are drawn from, so the framing follows
  // the player's own AERO part instead of a fixed guess.
  function flapAimPoint(which: "front" | "rear"): readonly number[] {
    const aSt = teamDecalState(Teams_LIST[G.teamIdx] as CameraTeam, true);
    return aeroFlapAim(aSt.val, which, aSt.aero);
  }
  let setupPreviewView = "hero";
  function setSetupView(name: string): void {
    const v = SP_VIEWS[name];
    if (!v) return;
    setupPreviewView = name;
    GarageScene.spot(name);   // the work lamp wheels over to what the preset frames
    setupPreviewFree = false;   // a preset is the player's range again
    setupPreviewAz = v.az; setupPreviewEl = v.el; setupPreviewDist = v.dist;
    // A preset is an absolute framing, so it also drops any pan the player had
    // walked in — otherwise "show me the rear wing" shows them the rear wing plus
    // whatever two metres of offset they were still carrying.
    setupPreviewPan[0] = setupPreviewPan[1] = setupPreviewPan[2] = 0;
    if (v.aim) {
      // Orbit AND look at the flap itself, so the wing stays centred at every
      // turntable angle instead of swinging out of frame the way a car-centred
      // orbit does once you are 2.5 m away.
      const p = flapAimPoint(v.aim);
      setupPreviewOrbit = p.slice(); setupPreviewTgt = p.slice();
      setupPreviewMinDist = v.minDist || 0;
    } else {
      setupPreviewOrbit = SP_ORBIT_DEF.slice(); setupPreviewTgt = SP_TGT_DEF.slice();
      setupPreviewMinDist = 0;
    }
    // Picking a view means "hold it there" — leaving the turntable running would
    // immediately rotate away from the angle that was just asked for.
    setSetupSpin(false);
  }
  function setSetupSpin(on: boolean): void {
    setupPreviewSpin = !!on;
    const b = $("cs-view-spin");
    // `active` drives the lit style (and is what AriaState reads); the attribute
    // is set here too so the state is correct before AriaState's observer fires.
    if (b) {
      b.classList.toggle("active", setupPreviewSpin);
      b.setAttribute("aria-pressed", String(setupPreviewSpin));
    }
  }
  // Ease the garage flaps at the SAME asymmetric rates the car uses on track (see
  // X_OPEN_RATE / X_CLOSE_RATE) — the snap-shut is half the character of the
  // system, and a garage that opened and closed at one speed would missell it.
  // Its own function so the frame loop and __apex.garageStep() cannot drift:
  // reachable only from inside the rAF render, the preview animation would be
  // untestable, and an untested animation is one you find out about from a player.
  function stepSetupAero(dt: number): void {
    const want = setupPreviewXOn ? 1 : 0;
    const rate = want > setupPreviewAeroX ? X_OPEN_RATE : X_CLOSE_RATE;
    const step = rate * Math.min(dt, 1 / 20);
    setupPreviewAeroX = clamp(setupPreviewAeroX + Math.sign(want - setupPreviewAeroX) * step,
                              Math.min(setupPreviewAeroX, want), Math.max(setupPreviewAeroX, want));
  }
  function setSetupAero(on: boolean, opts?: { keepCam?: boolean }): void {
    const was = setupPreviewXOn;
    setupPreviewXOn = !!on;
    // Switching X-mode ON from the untouched turntable AIMS at the rear wing.
    // The flaps rotate about the car's X axis, so the turntable's own three-quarter
    // sweep and the FRONT/REAR presets all look very nearly along that axis, where
    // a 36-degree sweep projects to almost nothing. Pressing the button and seeing
    // the car not move is the single most common way to conclude this feature is
    // broken — and it is what happened. `spin` is the "I have not aimed anything"
    // state, so a player who HAS chosen an angle keeps it.
    // The threshold is DISTANCE, not just the turntable. At the whole-car framing
    // (8.5 m) the rear wing's 135 mm of travel projects to about TEN PIXELS on a
    // landscape phone — the motion is real and simply cannot be seen, which is
    // indistinguishable from a broken feature and was reported as one. The wing
    // preset sits at 4.6 m, where the travel is still readable and both endplates
    // stay in the visible half. A player already close in on something has aimed
    // deliberately, so they keep their shot. `keepCam` (garageAero opts) skips
    // the snap so a test can toggle flaps without stealing the camera.
    if (!(opts && opts.keepCam) && setupPreviewXOn && !was && (setupPreviewSpin || setupPreviewDist > 5)) setSetupView("wingRear");
    const b = $("cs-aero");
    if (b) {
      // `active` drives the lit style (and is what AriaState reads); the attribute
      // is set here too so the state is correct before AriaState's observer fires.
      b.classList.toggle("active", setupPreviewXOn);
      b.setAttribute("aria-pressed", String(setupPreviewXOn));
      const v = b.querySelector(".cs-aero-val");
      if (v) v.textContent = setupPreviewXOn ? "STRAIGHT MODE" : "CORNER MODE";
    }
  }
  function setupZoom(mul: number): void {
    setupPreviewDist = clamp(setupPreviewDist * mul, spDistMin(), SP_DIST_MAX);
  }
  // Move the rig sideways / along the car, in the SCREEN's frame rather than the
  // car's: "left" has to mean left as seen, or the control inverts itself as soon
  // as the turntable carries you past the nose. At azimuth `az` the camera's
  // horizontal right vector is (cos az, 0, -sin az) and its forward is
  // (-sin az, 0, -cos az); strafe and dolly ride those.
  function setupPan(strafe: number, dolly: number): void {
    if (!strafe && !dolly) return;
    const ca = Math.cos(setupPreviewAz), sa = Math.sin(setupPreviewAz);
    setupPreviewPan[0] = clamp(setupPreviewPan[0]! + strafe * ca - dolly * sa, -SP_PAN_X, SP_PAN_X);
    setupPreviewPan[2] = clamp(setupPreviewPan[2]! - strafe * sa - dolly * ca, -SP_PAN_Z, SP_PAN_Z);
    // Panning is aiming. Leaving the turntable running would immediately carry the
    // camera away from whatever was just framed, exactly as picking a view does.
    setSetupSpin(false);
  }
  // One discrete step of the on-screen orbit controls (keyboard activation).
  function nudgeSetupCam(dAz: number, dEl: number, zoom: number): void {
    if (dAz) { setupPreviewAz += dAz; setSetupSpin(false); }
    if (dEl) { setupPreviewEl = clamp(setupPreviewEl + dEl, spElMin(), SP_EL_MAX); setSetupSpin(false); }
    if (zoom) setupZoom(zoom);
  }
  // A HELD control, as per-second rates applied by the frame loop. This started as
  // a setInterval and read as a stutter: the render loop saturates the main thread
  // under software GL, so a 55 ms timer was only serviced every ~240 ms. Rates on
  // the frame clock are smooth at any frame rate and correct on a fast machine
  // too, where a fixed timer would instead have moved in visible jumps.
  type HeldRates = { az?: number; el?: number; zoom?: number; strafe?: number; dolly?: number };
  let spHeld: HeldRates | null = null;   // {az, el, zoom, strafe, dolly} — per second
  function applyHeldSetupCam(dt: number): void {
    if (!spHeld) return;
    if (spHeld.az) { setupPreviewAz += spHeld.az * dt; setSetupSpin(false); }
    if (spHeld.el) {
      setupPreviewEl = clamp(setupPreviewEl + spHeld.el * dt, SP_EL_MIN, SP_EL_MAX);
      setSetupSpin(false);
    }
    if (spHeld.zoom) setupZoom(Math.pow(spHeld.zoom, dt));
    if (spHeld.strafe || spHeld.dolly)
      setupPan((spHeld.strafe || 0) * dt, (spHeld.dolly || 0) * dt);
  }
  function resetSetupCam(): void {
    endHome();
    arrival.cancel();
    setupPreviewAz = 0.6;
    setupPreviewEl = SP_EL_DEF;
    setupPreviewDist = SP_DIST_DEF;
    setupPreviewPan[0] = setupPreviewPan[1] = setupPreviewPan[2] = 0;
    // …and the FRAMING, which az/el/dist do not carry. A WING or BRAKES preset
    // aims the camera by moving the orbit point and the look-at (setSetupAim /
    // garageFrame) and tightens minDist; resetting only the three angles left the
    // turntable spinning about the wing with a close-up minimum, which is exactly
    // the "reopened on somebody's last drag" state this reset exists to prevent.
    setupPreviewOrbit = SP_ORBIT_DEF.slice();
    setupPreviewTgt = SP_TGT_DEF.slice();
    setupPreviewMinDist = 0;
    setupPreviewFree = false;
    setSetupSpin(true);
  }
  // Rebuild-on-change only (not per-frame): keyed by team + resolved parts tiers,
  // mirroring the playerBodyMesh/cockpitBodyMesh cache-key pattern. The meshes
  // live in GarageScene's six-slot LRU, which frees what it evicts — no leak.
  let _spMesh: GfxMesh | null = null, _spMeshKey = "", _spHull: number[] | null = null;
  // The key carries the livery ID, not its colours: a paint edit drops EVERY cached car.
  function spMeshBust(): void { _spMeshKey = ""; GarageScene.dropPreviewMeshes(); }
  function garageSeat(): GarageDriver | null {
    const team = Teams_LIST[G.teamIdx] as CameraTeam;
    if (GarageScene.seatDriverAt)
      return GarageScene.seatDriverAt(team, G.driverIdx);
    const seats = (Career && Career.gridDrivers)
      ? (Career.gridDrivers(team) || team.drivers) : team.drivers;
    return (seats && seats[G.driverIdx]) || (seats && seats[0]) || null;
  }
  // driverIdx, not drivers[0]: the turntable shows YOUR car, so it wears the
  // helmet of the seat you picked. In the key too, or switching seats keeps
  // the mesh you were already looking at. Career.gridDrivers() is the MY TEAM
  // pair when a second driver is hired.
  function previewKey(): string {
    const team = Teams_LIST[G.teamIdx] as CameraTeam, seat = garageSeat();
    // Ten legends share num 1, so the player's Legends slot keys on the code too.
    return team.id + ":" + partsVisualKey(team.id) + ":" + (seat && seat.num) + (team.legends && seat ? ":" + seat.code : "");
  }
  function getSetupPreviewMesh(): GfxMesh | null {
    const team = Teams_LIST[G.teamIdx] as CameraTeam;
    const seat = garageSeat();
    const key = previewKey();
    if (key !== _spMeshKey) {
      const liv = resolveLivery(team);
      // The hull depends on POSITIONS ONLY: keyed on the geometry-gating fields, it
      // survives the per-value colour-drag busts livePreviewDraft issues.
      const hullKey = key + "|" + SP_HULL_GEOM_FIELDS.map((f) => (typeof liv[f] === "string" ? liv[f] : liv[f] ? 1 : 0)).join(",");
      const ent = GarageScene.previewMesh(key, hullKey, () => buildCar(liv.c1, liv.c2, {
        livery: liv,
        teamId: team.id,   // per-team chassis style shows in the setup turntable too
        num: seat && seat.num,
        helmetKey: team.legends && seat ? seat.code : undefined,   // the legend's own lid, not a shared #1
        parts: Parts.getVisualTiers(getTeamParts(team.id), team as PartsTeam),
      }));
      _spMesh = ent.mesh; _spHull = ent.hull;   // hull: silhouette proxy for the turntable re-centre
      _spMeshKey = key;
    }
    return _spMesh;
  }
  // The ROOM's view of the game beyond the car (GarageScene.draw's ctx): the
  // circuit the next race runs at — the career's calendar, the free-play season's,
  // else the picker's — its weather and hour, and the career's tally for the wall.
  // `asSetup`: the ctx the SETUP garage will draw with, even while the title's
  // Home session borrows the room (GaragePrebuild keys and builds the room on it).
  // One reused ctx object per frame — GarageScene.draw / live / ctxKey read it
  // synchronously, so a fresh {} (+ results.filter) every orbit frame was GC only.
  const _garageCtx: { -readonly [K in keyof GarageCtx]: GarageCtx[K] } = {
    track: null, weather: null, tod: null, night: false, wins: 0, last: null,
    sponsor: null, career: false, round: 0, spin: false, achievements: null,
    sceneNow: 0, ambient: true, studio: false, unlimited: false,
  };
  let _winsCacheRef: CareerSave["results"] | null = null, _winsCacheN = -1, _winsCacheV = 0;
  // Career.sponsor() and CareerExperience.garageMetadata() (state() + totals) were
  // re-derived on EVERY garage frame; they only move with a save write (store.rev),
  // a different career/results array, a new result or history row, or a round.
  let _cmRev: number | undefined = -1, _cmC: CareerSave | null = null, _cmN = -1, _cmH = -1, _cmRound = -1;
  let _cmSponsor: GarageCtx["sponsor"] = null, _cmAch: GarageAchievements | null | undefined = null;
  function garageCtx(asSetup = false): GarageCtx {
    const c = Career && Career.inCareer() ? Career.data() || null : null, h = home.active && !asSetup;
    const cal = (): readonly CameraTrack[] => (Career && Career.calendar ? Career.calendar() : Tracks.SEASON);
    const t = c ? cal()[c.season.round % cal().length]
            : (G.seasonMode && G.season) ? (deps.seasonCal ? deps.seasonCal.track(G.season.round) : undefined) : Tracks.LIST[G.trackIdx as number];
    const ctx = _garageCtx;
    ctx.track = t;
    ctx.weather = G.raceWeather;
    ctx.tod = G.raceTimeOfDay;
    ctx.night = h ? home.mode === "night"
      : (G.raceTimeOfDay === "night" || (G.raceTimeOfDay === "default" && !!(t && t.night)));
    if (c) {
      const n = c.results.length;
      // Keyed on the array too: another slot with the same result count kept the
      // previous slot's win tally on the wall.
      if (n !== _winsCacheN || c.results !== _winsCacheRef) {
        let w = 0;
        for (let i = 0; i < n; i++) if (c.results[i]!.p === 1) w++;
        _winsCacheRef = c.results; _winsCacheN = n; _winsCacheV = w;
      }
      ctx.wins = _winsCacheV;
      ctx.last = n ? c.results[n - 1] : null;
      const hn = Array.isArray(c.history) ? c.history.length : 0;
      if (G.store.rev !== _cmRev || c !== _cmC || n !== _cmN || hn !== _cmH || c.season.round !== _cmRound) {
        _cmRev = G.store.rev; _cmC = c; _cmN = n; _cmH = hn; _cmRound = c.season.round;
        _cmSponsor = Career!.sponsor();
        _cmAch = CareerExperience ? CareerExperience.garageMetadata() : null;
      }
      ctx.sponsor = _cmSponsor;
      ctx.career = true;
      ctx.round = c.season.round;
    } else {
      ctx.wins = 0; ctx.last = null; ctx.sponsor = null; ctx.career = false; ctx.round = 0;
    }
    ctx.spin = setupPreviewSpin;
    ctx.achievements = c ? _cmAch : CareerExperience ? CareerExperience.garageMetadata() : null;
    ctx.sceneNow = asSetup ? ambientClock.value : garageNow();
    ctx.ambient = !reducedMotion() && (!h || home.moving);
    ctx.studio = !!(h && home.mode === "studio");
    ctx.unlimited = !!G.unlimitedBudget;   // the wall BUDGET board reads FREE BUILD, like the DOM sheet
    return ctx;
  }
  function captureCamera(): CameraSnapshot {
    return { az: setupPreviewAz, el: setupPreviewEl, dist: setupPreviewDist, spin: setupPreviewSpin,
      orbit: setupPreviewOrbit.slice(), target: setupPreviewTgt.slice(), pan: setupPreviewPan.slice(),
      minDist: setupPreviewMinDist, free: setupPreviewFree, xOn: setupPreviewXOn, aeroX: setupPreviewAeroX, view: setupPreviewView };
  }
  function restoreCamera(s: CameraSnapshot | null | undefined): void {
    if (!s) return;
    setupPreviewAz = s.az; setupPreviewEl = s.el; setupPreviewDist = s.dist;
    setupPreviewOrbit = s.orbit.slice(); setupPreviewTgt = s.target.slice(); setupPreviewPan = s.pan.slice();
    setupPreviewMinDist = s.minDist; setupPreviewFree = s.free; setupPreviewXOn = s.xOn; setupPreviewAeroX = s.aeroX;
    setupPreviewView = s.view; GarageScene.spot(s.view); setSetupSpin(s.spin);
  }
  function setHomeView(name: HomeShotName, pose: HomePose): void {
    setSetupView(name);
    setupPreviewAz = pose.az; setupPreviewEl = pose.el; setupPreviewDist = pose.dist;
  }
  const home = GarageExperience.homeSession<CameraSnapshot>({ capture: captureCamera, restore: restoreCamera, view: setHomeView }, reducedMotion);
  function beginHome(mode: string, opts?: { shot?: string; motion?: string; panel?: HTMLElement | null }): boolean {
    if (preview || driveOut || ($("carsetup") && !$("carsetup")!.hidden)) return false;
    return home.begin(mode, opts);
  }
  function endHome(): boolean { return home.end(); }
  const _spProj = new Float32Array(16), _spView = new Float32Array(16), _spVP = new Float32Array(16);
  const _spInvProj = new Float32Array(16);
  const _spEye = [0, 0, 0], _spUp = [0, 1, 0], _spSun = [0, 0.86, 0.51];
  const _spLiv = (): CameraLivery => resolveLivery(Teams_LIST[G.teamIdx] as CameraTeam);   // memoised on store.rev
  let _resPinned = false, _resPrev = 1;
  function pinGarageRes(): void {
    if (_resPinned || !(gfx.isMobile || gfx.mobileTier) || !gfx.setRenderScale || !gfx.getRenderScale) return;
    const cur = gfx.getRenderScale();
    _resPrev = cur;
    _resPinned = true;
    if (cur > GARAGE_PHONE_SCALE + 0.02) gfx.setRenderScale(GARAGE_PHONE_SCALE);
  }
  function endGarageRes(): void {
    if (!_resPinned) return;
    _resPinned = false;
    if (gfx.setRenderScale) gfx.setRenderScale(_resPrev || 1);
  }
  // Panel coverage does not move with the turntable. Cache the rects until the
  // canvas, the sheet, the camera strip, or CSS zoom actually changes.
  const _covPr: CoverRect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  const _covCr: CoverRect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  let _covKey = "", _covX = 0, _covY = 0, _covPanel: HTMLElement | null = null, _covCanvas: HTMLElement | null = null, _covCam: HTMLElement | null = null;
  function _stampRect(out: CoverRect, r: CoverRect | DOMRect): CoverRect {
    out.left = r.left; out.top = r.top; out.width = r.width; out.height = r.height;
    out.right = r.right; out.bottom = r.bottom;
    return out;
  }
  function renderSetupPreview(dt: number, holdDriveOut = false): boolean {
    // SETUP bay only (not title Home): wait out an in-flight material-pack upload
    // before the first garage present. Measured on tip a52e9108 at 4× CPU: tapping
    // #mb-garage while Assets.createTextureArray was still uploading produced one
    // 5–12 s long task (pack upload + setup present colliding on the main thread);
    // the same pack on the idle title alone was ~0.4–0.6 s. The sheet (openSetup)
    // is already up; returning false keeps firstFrame unmarked until a later tick
    // draws after packSettled. Home keeps drawing through the upload — that path
    // never showed the multi-second stall.
    if (G.setupPreviewOn && !home.active && deps.packSettled) {
      if (!deps.packSettled()) return false;
    }
    // The race's HUD mirror: render() never reaches its slot on a garage frame,
    // so its rect stayed set and present() composited it over the car.
    if (deps.mirrorStandDown) deps.mirrorStandDown();
    // Photo studio stays at the race resolution; every other bay frame sheds.
    if (home.active && $("photo-studio") && !$("photo-studio")!.hidden) endGarageRes();
    else pinGarageRes();
    gfx.resize();
    const arriving: CameraPose | null = home.active ? null : driveOut ? stepDriveOut(holdDriveOut) : preview ? stepPreview(dt) : arrival.step(dt);
    if (!home.active && (!arriving || !arriving.active)) applyHeldSetupCam(dt);                               // held on-screen controls
    // Title Home ambient is already gated by home.moving (respects OS / Menu
    // motion: reduce). The #carsetup turntable is an EXPLICIT inspection control
    // (SPIN / RESET / openGarage) — gating it on prefers-reduced-motion left the
    // SPIN chip lit while the bay sat frozen (Playwright pins reduce; so do many
    // macOS "Reduce motion" users). Decorative bay props still freeze via ctx.ambient.
    if ((home.active ? home.moving : setupPreviewSpin) && !(arriving && arriving.active)) setupPreviewAz += dt * (home.active ? 0.035 : 0.35);   // slow turntable
    if (!home.active) stepSetupAero(dt);
    // The orbit radius is horizontal, so raising the camera does not walk it away
    // from the car: at el 0 this is the turntable ring, at el 1.2 it is overhead.
    const spCe = Math.cos(setupPreviewEl), spSe = Math.sin(setupPreviewEl);
    // The docked #cs-inner panel covers one side of the canvas, so the car only
    // ever gets (1 - |panelFrac|) of the frustum. Read the panel's live pixel
    // width so this tracks every breakpoint/viewport automatically. SIGNED: the
    // panel docks RIGHT (+) by default and LEFT (-) under APPEARANCE › GARAGE ›
    // PANEL SIDE; the lens shift and GarageScene.recentre take the sign as is
    // (the car lands at -panelFrac either way), the fit takes the magnitude.
    // WHICH WAY DOES THE PANEL LEAVE ROOM? It docks to the RIGHT on a wide screen
    // and to the TOP on a tall one, because a portrait phone has no width to give
    // and plenty of height — so the gap the car gets is either beside the panel or
    // below it. Measure both and shift along the axis that actually has the room;
    // shifting the wrong one is what left the car invisible behind a full-width
    // sheet in portrait.
    const canvasEl = $("game"), panelEl = home.active ? home.panel : $("cs-inner");
    const photoOpen = home.active && $("photo-studio") && !$("photo-studio")!.hidden;
    const autoFrame = !photoOpen && (setupPreviewSpin || home.active);
    let homePane: ReturnType<typeof GarageExperience.freePane> | null = null;
    if (home.active) getSetupPreviewMesh();   // the first held home frame needs its silhouette now, before framing
    let panelFrac = 0, panelFracY = 0;
    if (!(arriving && arriving.active) && canvasEl && panelEl && canvasEl.clientWidth > 0 && canvasEl.clientHeight > 0) {
      // Visual coverage vs the unzoomed canvas (A13). viewportRect scales up on
      // engines where gBCR is still local under CSS zoom. The dock does not move
      // with the turntable, so a matching size/zoom key keeps the last rects.
      const cam = home.active ? null : $("cs-cam-panel");
      const camOn = !!(cam && !cam.hidden && cam.offsetParent !== null);
      const zP = CssZoom.of(panelEl);
      const zC = CssZoom.of(canvasEl);
      const key = canvasEl.clientWidth + "x" + canvasEl.clientHeight
        + "|" + panelEl.clientWidth + "x" + panelEl.clientHeight
        + "|" + (camOn ? cam!.clientWidth + "x" + cam!.clientHeight : "0")
        + "|" + zP + "|" + zC + "|" + (home.active ? 1 : 0)
        + "|" + document.documentElement.getAttribute("data-look-garage-side");
      if (key !== _covKey || panelEl !== _covPanel || canvasEl !== _covCanvas || cam !== _covCam) {
        _covPanel = panelEl; _covCanvas = canvasEl; _covCam = cam;
        const pr = _stampRect(_covPr, CssZoom.viewportRect(panelEl) || panelEl.getBoundingClientRect());
        const cr = _stampRect(_covCr, canvasEl.getBoundingClientRect());
        const camTop = (): number => camOn
          ? (CssZoom.viewportRect(cam!) || cam!.getBoundingClientRect()).top
          : canvasEl.clientHeight;
        const cover = panelCover(pr, cr, canvasEl.clientWidth, canvasEl.clientHeight, camTop);
        _covX = cover.x; _covY = cover.y; _covKey = key;
      }
      if (home.active) homePane = GarageExperience.freePane(_covPr, _covCr);
      panelFrac = _covX; panelFracY = _covY;
    }
    // FIT THE VISIBLE REGION, NOT THE WHOLE CANVAS. SP_DIST_DEF clears the full
    // frustum — but a third of that frustum is behind the panel, so there the
    // turntable puts the front wing off the left edge and the rear wing under
    // the panel every time it swings broadside (measured at 1440x900). The drawn
    // car is ~5.95 m across at broadside (the wings are the wide part), and the
    // margin has to come out of the VISIBLE half-width. Hold the turntable at whatever distance
    // keeps that inside it. Only the AUTOMATIC view self-frames — picking a preset
    // or zooming clears setupPreviewSpin, and from there the distance is theirs.
    // THIS BACKS OFF WITHOUT BOUND. The visible half-angle is
    // atan(tan18 * aspect * (1 - |panelFrac|)), so as the region narrows the
    // distance diverges, and otherwise only the MANUAL zoom's SP_DIST_MAX stops
    // it. Measured at 900x820 with the panel over half the width: the
    // fit asks for 17.6 m and pins on 15 — outside the bay's 5.4 m side wall, the
    // near wall culled away, the car a small object in a dollhouse of the whole
    // garage ("the camera is further back and rotates around the outside of the
    // room"). Cap the AUTO fit; past it, crop the wings at broadside rather than
    // leave the room. Only viewports that pin are affected (1440x900, 1280x800
    // and 844x390 are unchanged to 2 dp).
    //
    // panelFracY is NOT a term here and that is not the oversight it looks like:
    // it constrains the car's on-screen HEIGHT (~1.8 m projected against 6.7 m
    // wide), so the horizontal axis binds everywhere. Fitting the half-WIDTH
    // against the vertical half-angle was tried and measured wrong — a constant
    // 10.31 m floor that pushed 1440x900 from 9.10 to 10.31.
    const spFitD = Math.min(SP_FIT_DIST_MAX,
      SP_FIT_HALF_W / Math.max(Math.tan(18 * Math.PI / 180) * gfx.aspect * (1 - Math.abs(panelFrac)), 0.05));
    const homeFov = homePane && gfx.aspect < 1 ? 72 : (home.lens && home.lens.fov) || 36;
    const homeFit = !photoOpen && homePane && GarageExperience.fitHome(_spHull, { az: setupPreviewAz, el: setupPreviewEl,
      center: setupPreviewTgt, aspect: gfx.aspect, fov: homeFov, minDist: SP_DIST_MIN, maxDist: home.lens!.maxDist || SP_FIT_DIST_MAX }, homePane);
    const spDist = homeFit ? homeFit.dist : autoFrame
      ? clamp(Math.max(setupPreviewDist, spFitD), SP_DIST_MIN, SP_DIST_MAX) : setupPreviewDist;
    // Publish what the camera USES: garageCam() reported setupPreviewDist, which
    // is the effective distance only when the turntable is off — so on the auto
    // path, the one that can misframe, it read 8.5 while the camera sat at 15.
    _spEffDist = spDist; _spEffFit = homeFit ? homeFit.dist : spFitD; _spEffPanel = panelFrac;
    // PAN shifts the orbit centre and the look-at together, so strafing tracks
    // along the car instead of swinging the aim off it — the difference between
    // "walk down the flank" and "turn your head at the far end of the pit box".
    const eye = _spEye;
    eye[0] = setupPreviewOrbit[0]! + setupPreviewPan[0]! + Math.sin(setupPreviewAz) * spDist * spCe;
    eye[1] = setupPreviewOrbit[1]! + setupPreviewPan[1]! + spDist * spSe;
    eye[2] = setupPreviewOrbit[2]! + setupPreviewPan[2]! + Math.cos(setupPreviewAz) * spDist * spCe;
    perspectiveTo(_spProj, homeFov * Math.PI / 180, gfx.aspect, 0.1, 60);
    // An on-axis camera centers the car behind the panel, half-cropped. Shift the
    // frustum (off-axis / "lens shift") so the car renders centered in the VISIBLE
    // region instead — sideways when the panel is docked to an edge, downwards
    // when it sits across the top. col2 row0 shifts NDC.x, col2 row1 shifts NDC.y;
    // in both cases a positive value moves the image the OTHER way, which is why
    // the car ends up at -frac, the centre of the gap the panel is not covering.
    _spProj[8] = panelFrac;
    _spProj[9] = panelFracY;
    if (homeFit) { _spProj[8] = homeFit.shiftX; _spProj[9] = homeFit.shiftY; }
    _spAim[0] = setupPreviewTgt[0]! + setupPreviewPan[0]!;
    _spAim[1] = setupPreviewTgt[1]! + setupPreviewPan[1]!;
    _spAim[2] = setupPreviewTgt[2]! + setupPreviewPan[2]!;
    if (arriving && arriving.active) {
      eye[0] = arriving.eye[0]; eye[1] = arriving.eye[1]; eye[2] = arriving.eye[2];
      _spAim[0] = arriving.aim[0]; _spAim[1] = arriving.aim[1]; _spAim[2] = arriving.aim[2];
      perspectiveTo(_spProj, (gfx.aspect < 1 ? Math.min(85, arriving.fov + 14) : arriving.fov) * Math.PI / 180, gfx.aspect, 0.1, 60);
    }
    lookAtTo(_spView, eye, _spAim, _spUp);
    mulTo(_spVP, _spProj, _spView);
    GarageScene.recentre(_spProj, _spView, _spVP, panelFrac, !homeFit && autoFrame && !(arriving && arriving.active), _spHull);
    invertTo(_spInvProj, _spProj);
    const context = garageCtx(), sceneTime = context.sceneNow as number;
    (context as { door?: number }).door = arriving && arriving.active ? arriving.door : 1;   // GarageScene.live's shutter swell
    const liv = _spLiv();
    const lightsRig = GarageScene.live(liv, sceneTime, context);
    if (gfx.begin({
      // Sun with NO sideways component. The shark fin is a thin blade whose two
      // flanks carry opposite normals (+X and -X), so any X in the sun direction
      // lights one face and leaves the other on ambient — the same badge came out
      // two different shades depending on which side you orbited to. On a thick
      // body that asymmetry is correct; on a blade being inspected in a showroom
      // it just reads as a bug. Front-and-above keeps the modelling (the ring of
      // studio lamps below is already symmetric) without favouring a side.
      // The sun is now a SKYLIGHT — a soft roof fill, not the key. See
      // GarageScene.SKYLIGHT: no lamp can contribute more than 1/17 of albedo, so
      // as long as the sun stayed at full white it owned the picture and the bay's
      // ten fixtures were decoration. proj/invProj are what unlock SSAO in
      // present(), and an interior lives or dies on its corner darkening.
      viewProj: _spVP, view: _spView, eye, sunDir: _spSun, sunColor: GarageScene.SKYLIGHT,
      ambientSky: GarageScene.AMB_SKY, ambientGround: GarageScene.AMB_GROUND,
      fogColor: GarageScene.BACKDROP, fogDensity: 0, lights: lightsRig,
      proj: _spProj, invProj: _spInvProj,
      noEnv: true,   // probe-less preview: matte paint, never mirror a stale race cube
    }) === false) return false;
    const spMat = carPaintMat(PAINT_DRY_DAY);
    spMat.sparkle = 0.12;   // near-kill the metallic-flake glitter so the slow turntable doesn't "twinkle"
    // Paint stays the race dry-day material. The old matte override (clearcoat 0.1,
    // roughness × 2.4) hid a present wash; presentOpts() now owns bloom / exposure.
    // The car's matrix from the pose: translate (x, 0, z), turn by yaw about +Y, then the
    // preview's X mirror (MAT_REFLECT_X). The arrival in, and the parked car, have no x/yaw.
    const ay = (arriving && arriving.yaw) || 0, ac = Math.cos(ay), as = Math.sin(ay);
    arrivalCar[0] = -ac; arrivalCar[2] = as; arrivalCar[8] = as; arrivalCar[10] = ac;
    arrivalCar[12] = (arriving && arriving.x) || 0; arrivalCar[14] = arriving ? arriving.z : 0;
    const team = Teams_LIST[G.teamIdx] as CameraTeam;
    const carMesh = getSetupPreviewMesh();
    GarageScene.draw(team, liv, eye, getTeamParts as (id: string | null | undefined) => unknown, G.driverIdx, context, carMesh, arriving, arrivalCar);
    gfx.draw(carMesh!, arrivalCar, spMat);
    // Rolling in or out at NIGHT or in the WET, the rain light is on, as it is on
    // the grid (js/game.js drawRearLights); parked in the bay it stays dark.
    if (arriving && arriving.active && (context.night || /rain|wet|storm/.test(String(context.weather || ""))) && deps.drawRearLights)
      deps.drawRearLights(arrivalCar, 1);
    // The moveable wings, so a player can watch active aero work before ever
    // driving — and see what their own AERO parts choice did to the flap size.
    {
      const aSt = teamDecalState(team, true);
      if (deps.drawAeroFlaps) deps.drawAeroFlaps(team, aSt.val, setupPreviewAeroX, arrivalCar, spMat,
        aSt.aero);
    }
    // `night` here means "the sun is not the key" — which in a garage it is not.
    // The decal shader is sun + ambient + glow only, so without this the liveries'
    // logos and numbers would darken with the skylight and nothing would lift them.
    const gSeat = garageSeat();
    if (deps.drawCarDecals) deps.drawCarDecals(team, arrivalCar, true,
      (gSeat && gSeat.num) || carDecalNum(team, null), false, true);
    if (surfaceOutline && GarageSurfaceInspectionApi && GarageSurfaceInspectionApi.field()) {
      // The injected getter uses the same body-mode decision as drawCarDecals.
      // In particular a loaded GLB must borrow its legacy-anchor decal mesh.
      const mesh = deps.previewDecalMesh ? deps.previewDecalMesh(team) : null;
      if (mesh) surfaceOutline.draw(mesh, arrivalCar);
    }
    // AFTER the car: glare billboards are additive with depth-write off, so drawn
    // any earlier the opaque car would paint straight over them — and at high
    // elevation the ceiling fixtures sit between the eye and the car.
    gfx.drawGlow(lightsRig, GarageScene.glareStr() * glareScale(undefined, env));
    gfx.present(presentOpts(undefined, env));
    return !(gfx.warming && gfx.warming());
  }

  // ---- the #cs-view / #cs-cam-panel controls ----
  // The chips in #cs-view, plus orbit-by-drag and zoom on the canvas itself. All
  // of it is gated on G.setupPreviewOn, so none of these listeners can touch the
  // camera during a race — the canvas is shared with the track render and, on
  // touch, with the steering.
  // ---- the CAMERA disclosure ----
  // The panel holds the whole camera set; only CAMERA and ACTIVE AERO show at
  // rest. Closing is driven by INTENT, not by "a click happened": a preset is an
  // aim-and-leave choice so it closes, while MOVE/zoom/SPIN repeat and must not
  // pull the panel out from under the finger mid-adjustment.
  function setSetupCamPanel(open: boolean): void {
    const b = $("cs-cam"), p = $("cs-cam-panel");
    if (!b || !p) return;
    p.hidden = !open;
    b.setAttribute("aria-expanded", open ? "true" : "false");
  }
  const setupCamPanelOpen = (): boolean => !$("cs-cam-panel")!.hidden;
  $("cs-cam")!.onclick = () => {
    setSetupCamPanel(!setupCamPanelOpen());
    if (G.soundOn) uiTick();
  };
  // Outside-click and Escape, the two ways every disclosure is expected to shut.
  // Pointerdown rather than click so a drag STARTING on the car closes the panel
  // before the orbit begins, instead of leaving it hanging over the car you are
  // now turning.
  listen(document, "pointerdown", (e) => {
    if (!G.setupPreviewOn || !setupCamPanelOpen()) return;
    const target = e.target as Element | null;
    if (!target || !target.closest || !target.closest("#cs-stack")) setSetupCamPanel(false);
  }, true);
  // AN INNER DISCLOSURE CLAIMS ESCAPE BEFORE ITS SCREEN DOES. The generic layer
  // handler in js/ui/modal.js is on document/capture and bails on an event
  // already marked handled; this one must run before it (see below). stopPropagation alone did NOT mark it: it stops the
  // event descending but says nothing to a sibling listener on this same node, so
  // preventDefault is what actually keeps Escape from ALSO pressing the GARAGE's
  // BACK button and closing the screen behind the panel.
  // ON WINDOW, NOT DOCUMENT. Since the extraction this registers when game.js
  // calls create(), which can be after js/ui/modal.js has registered its own
  // document/capture Escape handler — and then modal ran FIRST and pressed the
  // garage's BACK (cs-back) with the panel open. Window capture precedes every
  // document listener whatever the registration order, so the inner disclosure
  // always claims the key first (parts-setup-ids.spec.js "the panel starts shut…").
  listen(window, "keydown", (e) => {
    // …but only when the GARAGE is the top layer: keyboard-opened EDIT MY TEAM
    // (a <dialog> over the garage) left the panel open behind it, and Escape shut
    // the hidden panel instead of the dialog the player was looking at.
    if ((e as KeyboardEvent).key === "Escape" && G.setupPreviewOn && setupCamPanelOpen()
        && !document.querySelector("dialog[open], dialog.screen:not([hidden])")) {
      setSetupCamPanel(false);
      e.preventDefault();
      e.stopPropagation();   // don't also close the GARAGE behind it
    }
  }, true);

  const stack = $("cs-stack");
  for (const btn of Array.from(stack ? stack.querySelectorAll<HTMLElement>("[data-cs-view]") : [])) {
    btn.onclick = () => {
      setSetupView(btn.dataset["csView"] as string);
      setSetupCamPanel(false);
      if (G.soundOn) uiTick();
    };
  }
  $("cs-view-spin")!.onclick = () => { setSetupSpin(!setupPreviewSpin); if (G.soundOn) uiTick(); };
  $("cs-view-reset")!.onclick = () => { resetSetupCam(); if (G.soundOn) uiTick(); };
  // Hold a control to move continuously; the frame loop reads spHeld. A camera
  // control that only moves on click is one you have to jab at twenty times to get
  // round the car, so press-and-hold is the primary interaction and the discrete
  // step is what a keyboard activation gets.
  function holdSetupCtl(id: string, rates: HeldRates, step: () => void): void {
    const el = $(id);
    if (!el) return;
    let pointerId: number | null = null;
    const release = (e?: Event): void => {
      if (e && e.type !== "blur" && (e as PointerEvent).pointerId !== pointerId) return;
      pointerId = null;
      if (spHeld === rates) spHeld = null;
    };
    el.addEventListener("pointerdown", (e) => {
      if (!G.setupPreviewOn || preview || (arrival.state && arrival.state.active)) return;
      if (pointerId !== null) return;
      e.preventDefault();
      pointerId = e.pointerId;
      // Capture so a finger sliding off the chip still releases here. NOT
      // pointerleave for the release: setPointerCapture fires a boundary event as
      // it retargets, which would stop the motion on its very first frame.
      try { el.setPointerCapture(e.pointerId); } catch { /* capture can refuse (pointer already gone); the drag still runs on move events */ }
      // One discrete step up front, THEN the held rate. Without the step a quick
      // tap moved by whatever fraction of a frame it happened to span — i.e.
      // visibly nothing — so the buttons only worked if you knew to hold them.
      step();
      spHeld = rates;
      if (G.soundOn) uiTick();
    });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(ev, release);
    listen(window, "pointerup", release);
    listen(window, "pointercancel", release);
    listen(window, "blur", release);
    // Enter/Space activate as a click with detail 0 and never send a pointerdown,
    // so the keyboard gets a discrete nudge rather than nothing at all.
    el.addEventListener("click", (e) => { if (e.detail === 0) step(); });
  }
  holdSetupCtl("cs-view-in",    { zoom: 1 / SP_RATE.zoom }, () => nudgeSetupCam(0, 0, 1 / 1.12));
  holdSetupCtl("cs-view-out",   { zoom: SP_RATE.zoom },     () => nudgeSetupCam(0, 0, 1.12));
  holdSetupCtl("cs-view-left",  { az: -SP_RATE.az },        () => nudgeSetupCam(-0.18, 0, 0));
  holdSetupCtl("cs-view-right", { az: SP_RATE.az },         () => nudgeSetupCam(0.18, 0, 0));
  holdSetupCtl("cs-view-up",    { el: SP_RATE.el },         () => nudgeSetupCam(0, 0.12, 0));
  holdSetupCtl("cs-view-down",  { el: -SP_RATE.el },        () => nudgeSetupCam(0, -0.12, 0));
  holdSetupCtl("cs-pan-left",   { strafe: -SP_RATE.pan },   () => setupPan(-0.15, 0));
  holdSetupCtl("cs-pan-right",  { strafe: SP_RATE.pan },    () => setupPan(0.15, 0));
  holdSetupCtl("cs-pan-fwd",    { dolly: SP_RATE.pan },     () => setupPan(0, 0.15));
  holdSetupCtl("cs-pan-back",   { dolly: -SP_RATE.pan },    () => setupPan(0, -0.15));
  $("cs-aero")!.onclick = () => { setSetupAero(!setupPreviewXOn); if (G.soundOn) uiTick(); };
  {
    const canvas = $("game");
    // Live pointers by id, so a two-finger pinch is separable from a one-finger
    // orbit without a separate touch-event path.
    const spPtr = new Map<number, { x: number; y: number }>();
    let spPinch = 0;
    const pinchGap = (): number => {
      const p = [...spPtr.values()];
      return p.length >= 2 ? Math.hypot(p[0]!.x - p[1]!.x, p[0]!.y - p[1]!.y) : 0;
    };
    const canPointerOrbit = (e: MouseEvent): boolean => {
      const photo = $("photo-studio"), photoOpen = !!photo && !photo.hidden;
      const panel = photoOpen && $("ps-panel");
      const r = panel && (CssZoom.viewportRect(panel) || panel.getBoundingClientRect());
      const inPanel = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      const target = e.target as Element | null;
      return GarageExperience.canOrbit(G.setupPreviewOn, home.active, photoOpen,
        !!preview || !!(arrival.state && arrival.state.active) || !!inPanel
          || !!(target && target.closest && target.closest("#ps-panel")));
    };
    if (canvas) {
      listen(canvas, "pointerdown", (ev) => {
        const e = ev as PointerEvent;
        if (!canPointerOrbit(e)) return;
        spPtr.set(e.pointerId, { x: e.clientX, y: e.clientY });
        spPinch = pinchGap();
        // Taking hold of the car is itself the instruction to stop the turntable —
        // dragging against a rotation that keeps adding to your input is horrible.
        if (spPtr.size === 1) setSetupSpin(false);
      });
      listen(window, "pointermove", (ev) => {
        const e = ev as PointerEvent;
        if (!spPtr.has(e.pointerId)) return;
        const p = spPtr.get(e.pointerId)!;
        if (!canPointerOrbit(e)) {
          p.x = e.clientX; p.y = e.clientY; spPinch = pinchGap(); return;
        }
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        if (spPtr.size >= 2) {
          // Pinch: the gap between the two fingers drives distance directly.
          const gap = pinchGap();
          if (spPinch > 0 && gap > 0) setupZoom(spPinch / gap);
          spPinch = gap;
          return;
        }
        // Drag: horizontal spins, vertical raises/lowers. Scaled by viewport width
        // so the same swipe travels the same arc on a phone and on a desktop.
        const span = Math.max(1, canvas.clientWidth);
        setupPreviewAz -= dx * (Math.PI * 1.6) / span;
        setupPreviewEl = clamp(setupPreviewEl + dy * (Math.PI * 0.9) / span, SP_EL_MIN, SP_EL_MAX);
      });
      const release = (ev: Event): void => {
        spPtr.delete((ev as PointerEvent).pointerId);
        spPinch = pinchGap();
      };
      listen(window, "pointerup", release);
      listen(window, "pointercancel", release);
      const onWheel = (e: WheelEvent): void => {
        if (!canPointerOrbit(e)) return;
        e.preventDefault();
        setupZoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
      };
      // The canvas outlives the garage (it is the race canvas), so its listeners are tracked too.
      listen(canvas, "wheel", onWheel as (e: Event) => void, { passive: false });
    }
  }

  // Preset jumps are immediate even with reduced motion; the full camera snapshot
  // is restored on DONE, tab change or garage exit. No draft/material mutation.
  if (GarageSurfaceInspectionApi) GarageSurfaceInspectionApi.bind({
    capture: captureCamera, restore: restoreCamera, show: setSetupView,
    highlight(field: string | null) {
      if (!surfaceOutline) return false;
      if (!field) { surfaceOutline.clear(); return false; }
      if (!deps.previewDecalMesh) return false;
      const team = Teams_LIST[G.teamIdx] as CameraTeam, seat = garageSeat();
      return surfaceOutline.set(field, team, resolveLivery(team), (seat && seat.num) || carDecalNum(team, null));
    },
    eligible: () => !!$("carsetup") && !$("carsetup")!.hidden,
  });

  function dispose(): void {
    endHome(); stopPreview(); driveOutEngine(false); driveOut = null; spHeld = null;
    while (unlisten.length) unlisten.pop()!();
  }

  // The camera's own state, published for the G façade (js/game.js keeps the
  // spellings __apex.garageCam() and types/game-ctx.d.ts already name).
  return {
    beginHome, endHome, renderHome(dt: number) { return home.active && renderSetupPreview(dt); }, homeState: () => home.state(),
    captureCamera, restoreCamera,
    startArrival() { endHome(); return arrival.start(); }, cancelArrival: arrival.cancel,
    startDriveOut, driveOutLeft, stopDriveOut() { driveOut = null; driveOutEngine(false); },
    renderSetupPreview, resetSetupCam, setSetupCamPanel, spMeshBust, endGarageRes,
    stepSetupAero, setSetupView, setSetupAero, setupPan, nudgeSetupCam,
    setSetupAim(p: readonly number[]) { setupPreviewOrbit = p.slice(); setupPreviewTgt = p.slice(); },
    setSetupFree(on: boolean) { setupPreviewFree = !!on; },
    get spin() { return setupPreviewSpin; },
    get az() { return setupPreviewAz; },
    get el() { return setupPreviewEl; },
    get dist() { return setupPreviewDist; },
    get pan() { return setupPreviewPan; },
    get aeroX() { return setupPreviewAeroX; },
    get xOn() { return setupPreviewXOn; },
    get effDist() { return _spEffDist; },
    get effFit() { return _spEffFit; },
    get effPanel() { return _spEffPanel; },
    // GaragePrebuild (js/garage/prebuild.js): the setup garage's car and room,
    // built ahead of the GARAGE tap — keyed exactly as the first garage frame keys them.
    previewKey, prebuildKey: () => previewKey() + "|" + GarageScene.ctxKey(garageCtx(true)),
    prebuild(part: string) {
      if (part === "car") return !!getSetupPreviewMesh();
      const team = Teams_LIST[G.teamIdx] as CameraTeam;
      return GarageScene.prepare(team, _spLiv(), getTeamParts as (id: string | null | undefined) => unknown, G.driverIdx, garageCtx(true));
    },
    roomReady() { return GarageScene.prepared(Teams_LIST[G.teamIdx] as CameraTeam, _spLiv(), getTeamParts as (id: string | null | undefined) => unknown, G.driverIdx, garageCtx(true)); },
    // Race start (GaragePrebuild.release): free the room and every cached car, unless a
    // garage is on screen. The cleared key makes the next getSetupPreviewMesh rebuild.
    release() {
      if (G.setupPreviewOn) return false;
      GarageScene.release(); _spMesh = null; _spMeshKey = "";   // the hull is CPU-only and frames the next visit
      return true;
    },
    get meshKey() { return _spMeshKey; },
    set meshKey(v: string) { if (v === "") spMeshBust(); else _spMeshKey = v; },
    scene: GarageScene,
    dispose,
  };
}

export const SetupCamera = Object.freeze({ create: createSetupCamera, panelCover, presentOpts, glareScale });
