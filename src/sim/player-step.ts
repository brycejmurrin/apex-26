/**
 * The car step: one fixed physics tick of a car, human or AI.
 *
 * Port of f1-game js/game.js `updateCar` (:4690-5168) and its parts, in
 * f1-game's order: updateCar → updateCarBrakePlan (:5171) →
 * updateCarLongitudinal (:5368) → updateCarLateral (:5563) →
 * updateCarBicycle (:5904) → WallClamp.apply → updateCarAdvance (:6110),
 * plus rescuePlayer (:6402), coast (:6496) and the solo slice of `update()`
 * (:4341) for `createPlayerStep().step`. Statements are verbatim in float
 * operation order. A human car runs the bicycle model (PlayerForces); an AI car
 * the kinematic Frenet controller, with its decisions in src/sim/ai/. The
 * field-level tick (ranking, the whole grid, collisions) is src/sim/ai/race-step.ts.
 *
 * f1-game's globals become the typed `PlayerWorld`: the track (a
 * `PhysicsTrack`, plus the racing-line reads an AI field needs), the live
 * tunables, and seams for the subsystems other lanes own (pit lane, race
 * control, wind, weather, aero zones, timing) whose defaults are f1-game's
 * values in the pinned world (wear/wind/cautions off, dry, no pit stop).
 * Presentation (announce, audio, haptics, camera shake, the coach/engineer/
 * recorders, display-only damage) is optional fx.
 *
 * THE ARC MUST NOT REACH THE DRIVER (AGENTS.md). f1-game reads
 * `Tracks.curvature` for every car (game.js:4730) and caches it on `c.kCur`;
 * here only an AI car reads it. The two places f1-game's player path uses the
 * arc, the DRIVING-HELP road-follow assist and the racing-line assist
 * (game.js:5960-5990), take their values from the separate `AssistInput` and
 * are skipped outright when their gain is 0, which is bit-identical to f1-game
 * with the assists off (ROAD_FOLLOW 0 yields assistDelta ±0, which
 * PlayerForces folds to 0).
 */
import type { AssistInput, NetPlayOwnership, PlayerInput, SessionMode, TrackSample } from "../contracts";
import { towGain } from "../physics/ai-contact";
import type { PhysCar } from "../physics/car";
import * as Collide from "../physics/collide";
import { DirtyAir, PhysicsConsts } from "../physics/consts";
import type { DirtyAirMode } from "../physics/consts";
import type { AudioFx, DebrisFx, HapticsFx, IncidentFx } from "../physics/fx";
import { NO_INCIDENTS } from "../physics/fx";
import * as GripSteer from "../physics/grip-steer";
import { clamp, lerp } from "../physics/math";
import * as OvertakeMode from "../physics/overtake-mode";
import type { OtCar } from "../physics/overtake-mode";
import * as PaceMathMod from "../physics/pace-math";
import type { PaceCar } from "../physics/pace-math";
import * as PlayerForces from "../physics/player-forces";
import type { PhysicsTrack, PostLimits } from "../physics/track";
import { aquaInto, treadFor, weatherGrip } from "../physics/tyre-model";
import type { TyreRecord, Tyres } from "../physics/tyre-model";
import * as WallClamp from "../physics/wall-clamp";
import * as AiBand from "./ai/ai-band";
import * as AiCorridor from "./ai/ai-corridor";
import type { CorridorPlan } from "./ai/ai-corridor";
import * as AiDrive from "./ai/ai-drive";
import type { LaunchPlan, TeamRef, TeamStats, Traits } from "./ai/ai-drive";
import { createFrenet } from "./player-step-frenet";
import { lineTransition, sectorAt, settleSolo } from "./player-step-lap";
import type { LapTiming, LineCar, LineCross, LineEntry } from "./player-step-lap";

const {
  VMAX,
  ACCEL,
  BRAKE,
  REVERSE_MAX,
  REVERSE_ACCEL,
  COAST_DRAG,
  GRAVITY_SLOPE,
  LAT_MAX,
  STEER_VMAX,
  FRONT_WEIGHT,
  WT_LONG,
  X_OPEN_RATE,
  X_CLOSE_RATE,
  X_MIN_SPEED,
  OT_MIN_SPEED,
  OFF_GRIP,
  ASSIST_KUS,
  LINE_PURSUIT,
  GRASS_V,
  KERB_SHAKE,
  KERB_CUE_HOLD,
  DEPLOY_A,
  TAPER_LO,
  TAPER_HI,
  TAPER_FLOOR,
  REGEN_FULL_V,
  OT_GAP,
  GEARS,
  GEAR_TOP,
  TOW_RANGE,
  TOW_FADE,
  TOW_HALF_W,
  DIFF,
  BAND_CEIL,
} = PhysicsConsts;

/** game.js:661 — fraction of BRAKE a car above the caution delta pace sheds at. */
const CAUTION_BRAKE = 0.5;
const _towWin = { range: TOW_RANGE, fade: TOW_FADE, halfW: TOW_HALF_W };
// AI lateral controller tunables (game.js:4626-4633).
const AI_PASS_LATCH_M = 16;
const AI_HEAD_VMIN = 6;
const AI_XTRACK_GAIN = 2.5;
const AI_HEAD_MAX = 0.45;
const AI_YAW_LAT = 0.6;
const AI_YAW_MAX = 1.2;
const AI_BIAS_SLEW = 3.0;
const AI_LOOK_CAP = 64;
const LCAR = Collide.LCAR,
  WCAR = Collide.WCAR;

/** The live driving-feel tunables. f1-game js/physics/drive-tune.js:6-21 (defaults). */
export interface DriveTune {
  PACE: number;
  WHEELBASE: number;
  STEER_EXPO: number;
  STEER_MAX_SLIP: number;
  STEER_SPEED_REF: number;
  DRIFT: number;
  FRONT_GRIP: number;
  YAW_DAMP: number;
  YAW_INERTIA: number;
  PLAYER_GRIP: number;
}
export function defaultDriveTune(): DriveTune {
  return {
    PACE: 1.0,
    WHEELBASE: 3.2,
    STEER_EXPO: 2.4,
    STEER_MAX_SLIP: 0.32,
    STEER_SPEED_REF: 60,
    DRIFT: 0,
    FRONT_GRIP: 0.94,
    YAW_DAMP: 1.0,
    YAW_INERTIA: 0.58,
    PLAYER_GRIP: 1.15,
  };
}

/** The assists-off `AssistInput`: every gain 0 (f1-game's shipped default). */
export const NO_ASSISTS: AssistInput = Object.freeze({ roadFollow: 0, curvature: 0, raceLine: 0, racingLineX: 0 });

/** The AI's per-car brake look-ahead cache (game.js:5257). */
interface LookCache {
  node: number;
  on: boolean;
  track: unknown;
  n: number;
  v: Float64Array;
  a: Float64Array;
  b: Float64Array;
  m: Float64Array;
}

/** Every car field the step reads or writes, beyond PhysCar. */
export interface PlayerCar extends PhysCar, OtCar, LineCar, PaceCar {
  lap: number;
  s: number;
  human: boolean;
  finished: boolean;
  lapTime: number;
  aeroX: number;
  deploying: boolean;
  // pace / driver
  tread?: number | null | undefined;
  tyre?: TyreRecord | undefined;
  tyreClass?: string | null | undefined;
  pitState?: string | null | undefined;
  pitArmed?: boolean | undefined;
  rescueT?: number | undefined;
  rescueLastT?: number | null | undefined;
  wrongT?: number | undefined;
  wrongWay?: boolean | undefined;
  wrongCueT?: number | undefined;
  // ERS / aero
  wasArmed?: boolean | undefined;
  xArmed?: boolean | undefined;
  _xSndWant?: number | undefined;
  _vmaxNow?: number | undefined;
  _bandNow?: number | undefined;
  towing?: number | undefined;
  wake?: number | undefined;
  // surface and timing
  offT: number;
  cuts: number;
  cutWarn?: number | undefined;
  penalty: number;
  incidentInvalidLap?: boolean | undefined;
  qualiCut?: boolean | undefined;
  kerbCueT?: number | undefined;
  kerbSndT?: number | undefined;
  kerbHapT?: number | undefined;
  corridorAccel?: number | undefined;
  vertLoad?: number | undefined;
  brakeDemand?: number | undefined;
  throttleDemand?: number | undefined;
  steerCommand?: number | undefined;
  steerVis?: number | undefined;
  brakeHeat?: number | undefined;
  exhaustPop?: number | undefined;
  wasOnThrottle?: boolean | undefined;
  totalT: number;
  lastLap?: number | undefined;
  finishT?: number | undefined;
  _secIdx?: number | undefined;
  _secValid?: boolean | undefined;
  _secT0?: number | undefined;
  xVis?: number | undefined;
  rPrevPx?: number | undefined;
  rPrevPz?: number | undefined;
  rPrevS?: number | undefined;
  rPrevX?: number | undefined;
  rPrevHead?: number | undefined;
  _coastHeld?: boolean | undefined;
  paceF?: number | undefined;
  rank?: number | undefined;
  // AI: ratings and race plan (game.js makeCars :1706-1803)
  craft?: number | undefined;
  awareness?: number | undefined;
  experience?: number | undefined;
  skill?: number | undefined;
  aggression?: number | undefined;
  optimism?: number | undefined;
  tierV?: number | undefined;
  houseStats?: TeamStats | null | undefined;
  team?: (TeamRef & { readonly id: string }) | null | undefined;
  gridPos?: number | undefined;
  raceHash?: number | undefined;
  phaseRoll?: number | undefined;
  launch?: LaunchPlan | null | undefined;
  launchOn?: boolean | undefined;
  calmUntil?: number | undefined;
  calm?: number | undefined;
  accSm?: number | undefined;
  // AI: the heading-state controller and racecraft
  kCur?: number | undefined;
  aiHead?: number | undefined;
  aiBias?: number | null | undefined;
  aiFam?: number | undefined;
  lane: number;
  lanePref?: number | null | undefined;
  steerSm: number | undefined;
  passOf?: PlayerCar | null | undefined;
  passSide?: number | undefined;
  passBest?: number | undefined;
  passT?: number | undefined;
  passCool?: number | undefined;
  passPlan?: Partial<CorridorPlan> | undefined;
  atkOn?: boolean | undefined;
  atkWant?: boolean | undefined;
  runT?: number | undefined;
  pressT?: number | undefined;
  errT?: number | undefined;
  errCount?: number | undefined;
  zoneKey?: number | undefined;
  defendSide?: number | undefined;
  holdOff?: number | null | undefined;
  hYieldT?: number | undefined;
  sbsT?: number | undefined;
  stuckT?: number | undefined;
  letPassT?: number | undefined;
  _alPrev?: PlayerCar | null | undefined;
  _alPrevDp?: number | undefined;
  queueT?: number | undefined;
  _qOf?: PlayerCar | null | undefined;
  digEscHeld?: boolean | undefined;
  parkedOnRoad?: boolean | undefined;
  _lk?: LookCache | undefined;
}

/** f1-game js/race/pit-lane.js (PitLane.create): the calls the step makes. */
export interface PitSeam {
  update(c: PlayerCar, dt: number): void;
  inLane(c: PlayerCar): boolean;
  held(c: PlayerCar): boolean;
  limit(): number;
  /** AI only: strategy, the box approach, the entry/exit roads, the lane line. */
  think(c: PlayerCar): void;
  approachV(c: PlayerCar): number;
  entryV(c: PlayerCar): number;
  exitV(c: PlayerCar): number;
  laneX(c: PlayerCar, hw: number, x: number): number;
}
/** Tyre wear off closes the pit feature (pit-lane.js:1198): nothing is ever in the lane. */
export const NO_PITS: PitSeam = {
  update: () => {},
  inLane: (c) => c.pitState === "lane" || c.pitState === "box",
  held: () => false,
  limit: () => Infinity,
  think: () => {},
  approachV: () => Infinity,
  entryV: () => Infinity,
  exitV: () => Infinity,
  laneX: (_c, _hw, x) => x,
};

/** f1-game js/race/race-control.js: the reads the step makes. */
export interface RaceCtlSeam {
  /** 0 green … 2 VSC, 3 SC, 4 red. */
  readonly level: number;
  otDetectOpen(): boolean;
  otEnabled(): boolean;
  lowGrip(): boolean;
  /** At level 3, RaceControl.scQueueFrac(c, …) (game.js:4776); the SC queue rule needs the field. */
  scQueueFrac(c: PlayerCar): number;
  /** Under VSC/SC an AI car holds its place: RaceControl.holdCap(c, ranked, cautionFair) (game.js:4781). */
  holdCap(c: PlayerCar, ranked: readonly PlayerCar[]): number;
}
export const GREEN_FLAG: RaceCtlSeam = {
  level: 0,
  otDetectOpen: () => true,
  otEnabled: () => false,
  lowGrip: () => false,
  scQueueFrac: () => 0.6,
  holdCap: () => Infinity,
};

/** f1-game js/race/wind.js: `Wind.carInto(Wind.sync(…), heading, vStd)` (game.js:4751) then `Wind.latA()` (:6062). */
export interface WindSeam {
  carInto(heading: number, vStd: number): Readonly<{ vmaxMul: number; latA: number }>;
}
const _calm = Object.freeze({ vmaxMul: 1, latA: 0 });
export const CALM: WindSeam = { carInto: () => _calm };
/** wind.js:68 `AI_TAU`: an AI car takes the side force as latA·AI_TAU of drift. */
const WIND_AI_TAU = 0.3;

/** f1-game game.js:638-639 (`trackWetness`, `gripMult`) and the weather arc's local wetness. */
export interface WeatherSeam {
  readonly raceWeather: string;
  trackWetness(): number;
  /** Wetness under the car (a local shower); absent without a weather arc. */
  wetnessAt?: (s: number) => number;
}
export const DRY: WeatherSeam = { raceWeather: "dry", trackWetness: () => 0 };

/** The racing line and arc reads only an AI car makes (f1-game js/track/core/line.js, Tracks.curvature / bankAngle). */
export interface AiTrackQuery {
  /** Node count (`track.n`). */
  readonly n: number;
  curvature(s: number): number;
  bankAngle(s: number): number;
  /** TrackLine.at(track, s, fam): POOLED {x, w}. */
  lineAt(s: number, fam?: number): Readonly<{ x: number; w: number }>;
  /** TrackLine.pathK(track, s). */
  pathK(s: number): number;
  /** TrackLine.attackAt(track, s): POOLED {q, toTurnIn}. */
  attackAt(s: number): Readonly<{ q: number; toTurnIn: number }>;
  /** `track.attackQ ? track.attackQ[i] : 0` (game.js:5653). */
  attackQ(i: number): number;
}

/** What only an AI field needs from the race (f1-game globals, made explicit). */
export interface AiField {
  readonly track: AiTrackQuery;
  /** The whole grid, in f1-game's `cars` order. */
  readonly cars: readonly PlayerCar[];
  /** settings difficulty: easy | normal | hard. */
  readonly difficulty: string;
  readonly aiPace: AiBand.AiPaceMode;
  /** game.js `launchT0`: the race clock at the green. */
  launchT0: number;
  /** game.js `simRnd()` (:614), the seeded simulation stream. */
  readonly rnd: () => number;
  /** game.js `luckSeed()` (:2383) and the round index the mistake hash keys on (:5664). */
  readonly luckSeed: number | string;
  readonly round: number;
  /** game.js `_leadHuman` (:4494), recomputed each tick by the race step. */
  leadHuman: PlayerCar | null;
  /** game.js `parked` (:4521): retired cars parked on the road. */
  readonly parked: PlayerCar[];
  /** game.js `paceRef()` (pace-math.js:62): one Float32Array(track.n) per field. */
  readonly paceRef: Float32Array;
}

export interface PlayerStepFx {
  readonly audio?:
    | (AudioFx & {
        shift?(up: boolean): void;
        offtrack?(): void;
        penalty?(): void;
        rumble?(): void;
        xMode?(open: boolean): void;
        deployBoost?(): void;
        overtakeReady?(): void;
      })
    | null;
  readonly haptics?: HapticsFx | null;
  readonly debris?: DebrisFx | null;
  readonly incidents?: IncidentFx | null;
  /** Camera trauma: f1-game `feel.shake` (raised, never read by physics). */
  readonly shake?: ((add: number, floor: number) => void) | null;
  readonly announce?: ((msg: string, dur: number, kind: string) => void) | null;
}

/** What the step reads off the world each tick (f1-game's `G` members, made explicit). */
export interface PlayerWorld {
  readonly track: PhysicsTrack;
  readonly def: {
    readonly id: string;
    readonly sectors?: readonly number[] | null;
    readonly otDetectFrac?: number;
  };
  readonly tune: DriveTune;
  /** Race clock, s; `step()` advances it. */
  raceT: number;
  readonly state: "race" | "count" | "menu" | "results";
  readonly session: SessionMode;
  readonly lapsTarget: number;
  readonly dirtyAir: DirtyAirMode;
  /** game.js:233 `raceAeroMode` (store "aeroMode", default "manual"). */
  readonly aeroMode: "manual" | "auto";
  /** game.js:302 `gearsManual()`. */
  readonly gearsManual: boolean;
  /** game.js:314 `autoThrottle()`. */
  readonly autoThrottle: boolean;
  /**
   * true when the controls are the live local devices (f1-game `inputOf(c)` is
   * null and the step reads `Input`), false for a scripted/replicated input
   * (`__apex.setInput`, a ghost, a net rival). Two rules differ: the live brake
   * never slows less than lifting (game.js:5381), and auto-throttle applies.
   */
  readonly liveInput: boolean;
  readonly soundOn: boolean;
  readonly weather: WeatherSeam;
  readonly wind: WindSeam;
  readonly pits: PitSeam;
  readonly raceCtl: RaceCtlSeam;
  readonly tyres: Tyres;
  /** f1-game js/physics/aero-zones.js `at(s)` (game.js:564): inside an active-aero activation zone. */
  readonly aeroZoneAt: (s: number) => boolean;
  readonly timing: LapTiming;
  readonly netPlay: NetPlayOwnership;
  /** Team ids in f1-game Teams.LIST order (audio keys only). */
  readonly teamIds?: readonly string[];
  readonly fx?: PlayerStepFx;
  /** The GRIP STEER slider (grip-steer.js, notch 1 = OFF). */
  readonly gripSteer?: GripSteer.GripSteer;
  /** Race-control finish policy for a line crossing (race-control.js:62). Default: solo, flag at full distance. */
  readonly settleLine?: (e: LineEntry<PlayerCar>) => void;
  /** Lap / time-trial / quali side effects at the line (game.js:6263-6290). */
  readonly onLine?: (c: PlayerCar, cross: LineCross) => void;
  /** Required for AI cars; a solo player world leaves it out. */
  readonly ai?: AiField;
}

/** The step's pooled locals (f1-game `_ucS`, game.js:4688). */
interface Scratch {
  hw: number;
  slopeSin: number;
  slopeNose: number;
  k: number;
  vT: number;
  trMul: number;
  gmC: number;
  gm0: number;
  perfMul: number;
  vmax: number;
  pitV: number;
  cautionV: number;
  deploy: number;
  otFree: boolean;
  braking: boolean;
  brakeLvl: number;
  throttleLvl: number;
  gearMult: number;
  accelCeil: number;
  surfaceMu: number;
  brakeDecel: number;
  onThrottle: boolean;
  steer: number;
  gripScale: number;
  latFac: number;
  kerbGrip: number;
  bankMu: number;
  windLatA: number;
  dd: (typeof DIFF)[keyof typeof DIFF];
  aiT: Traits | null;
  roomL: number;
  roomR: number;
  roadL: number;
  roadR: number;
  blocker: PlayerCar | null;
  blockerGap: number;
  unstuckActive: boolean;
  letPass: boolean;
  aiFreeSpeed: number;
  squeezed: boolean;
  queued: boolean;
  alongO: PlayerCar | null;
  alongDx: number;
  alongDprog: number;
  towCar: PlayerCar | null;
  towGap: number;
  chaser: PlayerCar | null;
  chaserGap: number;
  nearbyN: number;
  sep: number;
}

export interface CarStep {
  /** game.js updateCar for one car. `input` is the car's controls (humans); AI cars pass null. */
  updateCar(c: PlayerCar, dt: number, ranked: readonly PlayerCar[], input: PlayerInput | null, assists?: AssistInput): void;
  /** game.js:6402 rescuePlayer. */
  rescuePlayer(c: PlayerCar): void;
  readonly pace: PaceMathMod.PaceMath;
  readonly wrapS: (s: number) => number;
  readonly worldFromTrack: (s: number, x: number, out: TrackSample) => Readonly<{ x: number; z: number }>;
}

export interface PlayerStep {
  /** game.js updateCar for one human car. */
  updateCar(c: PlayerCar, dt: number, input: PlayerInput, assists?: AssistInput): void;
  /**
   * One whole solo tick, as f1-game's update() runs it with the AI retired:
   * raceT, the traffic snapshot and buckets, updateCar, resolveCollisions.
   */
  step(c: PlayerCar, dt: number, input: PlayerInput, assists?: AssistInput): void;
  /** game.js:6402 rescuePlayer. */
  rescuePlayer(c: PlayerCar): void;
  readonly pace: PaceMathMod.PaceMath;
}

const newSample = (): TrackSample => ({ p: [0, 0, 1], t: [0, 0, 1], r: [1, 0, 0], hw: 7 });

/** game.js:402 scriptPace: the scripted field pace (tierV × skill) for AiDrive.pairEdgeN. */
function scriptPace(o: PlayerCar | null | undefined): number {
  return o && (o.tierV as number) > 0 && (o.skill as number) > 0 ? (o.tierV as number) * (o.skill as number) : 0;
}

export function createCarStep(world: PlayerWorld): CarStep {
  const track = world.track;
  const tune = world.tune;
  const fx = world.fx ?? {};
  const audio = fx.audio ?? null;
  const haptics = fx.haptics ?? null;
  const incidents = fx.incidents ?? NO_INCIDENTS;
  const debris = fx.debris ?? null;
  const settle = world.settleLine ?? settleSolo;
  const frenet = createFrenet(track);
  const wrapS = frenet.wrapS;
  const frenetH = frenet.frenetH;
  const trackFrom = frenet.trackFrom;
  const worldFromTrack = frenet.worldFromTrack;
  const pace = PaceMathMod.create({ getPACE: () => tune.PACE, lowGrip: () => world.raceCtl.lowGrip() });
  const { vTop, vStd, xVmaxGain, xCoastCut, drainFor, regenFor, otTimeFor, aeroDfMult, gearHi, rpmFor } = pace;
  const playerForces = PlayerForces.create(tune, { gripSteer: world.gripSteer ?? null, haptics, debris });
  // f1-game's module scratch: smp (game.js:1033), smp2 (:1034), postLim, _bankScratchP.
  const smp = newSample(),
    smp2 = newSample();
  const postLim: PostLimits = { r: 0, l: 0, minOut: 0, side: 0 };
  const bankScratch = { dy: 0, roll: 0 };
  const otTrack = { total: track.length, def: world.def };
  const otDetectAt = OvertakeMode.detectS(otTrack);
  const S: Scratch = {
    hw: 0,
    slopeSin: 0,
    slopeNose: 0,
    k: 0,
    vT: 0,
    trMul: 0,
    gmC: 0,
    gm0: 0,
    perfMul: 0,
    vmax: 0,
    pitV: 0,
    cautionV: 0,
    deploy: 0,
    otFree: false,
    braking: false,
    brakeLvl: 0,
    throttleLvl: 0,
    gearMult: 0,
    accelCeil: 0,
    surfaceMu: 0,
    brakeDecel: 0,
    onThrottle: false,
    steer: 0,
    gripScale: 0,
    latFac: 0,
    kerbGrip: 0,
    bankMu: 0,
    windLatA: 0,
    dd: DIFF.normal,
    aiT: null,
    roomL: Infinity,
    roomR: Infinity,
    roadL: Infinity,
    roadR: Infinity,
    blocker: null,
    blockerGap: Infinity,
    unstuckActive: false,
    letPass: false,
    aiFreeSpeed: 0,
    squeezed: false,
    queued: false,
    alongO: null,
    alongDx: 0,
    alongDprog: 0,
    towCar: null,
    towGap: Infinity,
    chaser: null,
    chaserGap: Infinity,
    nearbyN: 0,
    sep: 0,
  };
  const pfCtx = {
    dt: 0,
    driverDelta: 0,
    assistDelta: 0,
    lineDelta: 0,
    onThrottle: false,
    throttleLvl: 0,
    gearMult: 0,
    deploy: 0,
    braking: false,
    surfaceMu: 0,
    kerbGrip: 0,
    bankMu: 0,
    modsCornering: 0,
    modsBraking: 1,
    loadF: 0,
    loadR: 0,
    vertLoad: 0,
    af: 0,
    ar: 0,
    sp: 0,
    steer: 0,
    weatherGrip: 0,
    aeroDf: 0,
    dirtyMul: 0,
    coastCut: 0,
    vTopNow: 0,
    tyres: world.tyres,
  };
  const wallCtx: { -readonly [K in keyof WallClamp.WallClampCtx]: WallClamp.WallClampCtx[K] } = {
    track,
    dt: 0,
    steer: 0,
    postLim,
    smp,
    wrapS,
    worldFromTrack,
    soundOn: false,
    incidentSim: incidents,
    addShake: fx.shake ? (d: number) => (fx.shake as (a: number, f: number) => void)(d, 0) : null,
    debris,
    audio,
    haptics,
    teamIds: world.teamIds ?? [],
  };
  const NEUTRAL_MODS = Object.freeze({ speed: 1, accel: 1, cornering: 1, braking: 1 });
  // AI ctx bags, pooled like f1-game's (game.js:4617-4668).
  const aiBoxed: AiDrive.BoxedCtx = { contactT: 0, roomL: 0, roomR: 0, blocker: null, blockerGap: 0, street: false };
  const aiDefOnce = { defend: 0, side: 0 };

  const damp = (c: number, t: number, l: number, dt: number): number => lerp(c, t, 1 - Math.exp(-l * dt));
  function aiField(): AiField {
    const a = world.ai;
    if (!a) throw new Error("player-step: an AI car needs world.ai (the field)");
    return a;
  }
  // game.js:638-639
  function trackWetness(): number {
    return world.weather.trackWetness();
  }
  function gripMult(c?: PlayerCar): number {
    const wx = world.weather;
    return weatherGrip(c ? (c.tread == null ? treadFor(wx.raceWeather, trackWetness()) : c.tread) : 0, c && wx.wetnessAt ? wx.wetnessAt(c.s) : trackWetness());
  }
  // game.js:540-549
  function deployTaper(c: PlayerCar): number {
    if ((c.otT as number) > 0) return 1;
    const t = clamp(1 - (vStd(c.speed) - TAPER_LO) / (TAPER_HI - TAPER_LO), 0, 1);
    return TAPER_FLOOR + (1 - TAPER_FLOOR) * t;
  }
  function regenSpeedK(c: PlayerCar): number {
    return clamp(vStd(c.speed) / REGEN_FULL_V, 0, 1);
  }
  // game.js:624-628
  function naturalGear(speed: number): number {
    for (let g = 1; g <= GEARS; g++) if (speed <= gearHi(g) + 0.01) return g;
    return GEARS;
  }
  function gearLo(g: number): number {
    return g > 1 ? vTop() * (GEAR_TOP[g - 2] as number) : 0;
  }
  // game.js:700-703
  function wakeOf(gap: number, dx: number): number {
    return DirtyAir.wakeOf(gap, dx, world.dirtyAir, _towWin);
  }
  function dirtyAirMul(wake: number, speed: number): number {
    return DirtyAir.mul(wake, speed, world.dirtyAir, PhysicsConsts.DOWNFORCE, vTop());
  }
  // game.js:369
  function beachedAt(c: PlayerCar): boolean {
    return c.offroad && c.speed < GRASS_V * 0.6 * Math.max(tune.PACE, 0.05) + 1.5 * Math.max(tune.PACE, 0.05);
  }
  // game.js:400
  function paceVmax(o: PlayerCar): number {
    return ((o._vmaxNow || (o.human ? vTop() : 0)) / (1 + xVmaxGain(o) * (o.aeroX || 0))) * (o.human ? o.paceF || 1 : 1);
  }
  const isTimeTrial = (): boolean => world.session === "tt";
  const isQuali = (): boolean => world.session === "quali";
  const shake = (add: number, floor: number): void => {
    if (fx.shake) fx.shake(add, floor);
  };
  const announce = (msg: string, dur: number, kind: string): void => {
    if (fx.announce) fx.announce(msg, dur, kind);
  };
  const otSkipLane = (o: PhysCar): boolean => world.pits.inLane(o as PlayerCar);

  // ── coast (game.js:6496-6531) ──────────────────────────────────────────────
  function coast(c: PlayerCar, dt: number): void {
    const pits = world.pits;
    const floor = GRASS_V * 0.6 * Math.max(tune.PACE, 0.05);
    const next = c.speed - 20 * dt;
    if (c.speed > floor) {
      c.speed = Math.max(floor, next);
      if (c.speed === floor) c._coastHeld = true;
    } else c.speed = c._coastHeld ? floor : Math.max(0, next);
    const onLane = pits.held(c);
    if (c.pitState === "box") c.speed = 0;
    else if (onLane) c.speed = Math.min(c.speed, pits.limit());
    c.s = wrapS(c.s + c.speed * dt);
    c.prog += c.speed * dt;
    track.sample(c.s, smp);
    const kA = aiField().track.curvature(wrapS(c.s + 30));
    c.x = onLane ? damp(c.x, pits.laneX(c, smp.hw, c.x), 3, dt) : damp(c.x, clamp(-kA * 130, -0.5, 0.5) * smp.hw, 2, dt);
    {
      const w = worldFromTrack(c.s, c.x, smp);
      c.px = w.x;
      c.pz = w.z;
      c.head = Math.atan2(smp.t[0], smp.t[2]);
    }
  }

  // ── updateCar (game.js:4690-5168) ──────────────────────────────────────────
  function updateCar(c: PlayerCar, dt: number, ranked: readonly PlayerCar[], inp: PlayerInput | null, assists: AssistInput = NO_ASSISTS): void {
    const pits = world.pits;
    const raceCtl = world.raceCtl;
    const tyres = world.tyres;
    const state = world.state;
    const raceT = world.raceT;
    if (c.retired) {
      c._prevS = c.s;
      c.skidIntensity = c.wheelLock = c.brakeDemand = c.throttleDemand = c.towing = c.wake = 0;
      c.deploying = false;
      c.collideT = Math.max(0, c.collideT - dt);
      return;
    }
    if (c.finished && !world.netPlay.owns(c)) {
      pits.update(c, dt);
      coast(c, dt);
      c.rpm = rpmFor(c.gear || 1, Math.max(0, c.speed || 0));
      c._prevS = c.s;
      c.skidIntensity = c.wheelLock = c.brakeDemand = c.throttleDemand = c.towing = c.wake = 0;
      c.deploying = false;
      c.collideT = Math.max(0, c.collideT - dt);
      return;
    }
    if (incidents.owns(c)) {
      c.rpm = rpmFor(c.gear || 1, Math.max(0, c.speed || 0));
      c._prevS = c.s;
      return;
    }
    if (world.netPlay.owns(c)) {
      c.rpm = rpmFor(c.gear || 1, Math.max(0, c.speed || 0));
      c._prevS = c.s;
      return;
    }
    // (game.js:4722 realRace.owns: the REAL REPLAY puppets belong to the race lane.)
    track.sample(c.s, smp);
    const hw = smp.hw;
    const slopeSin = smp.t[1] || 0;
    const slopeNose = c.human && Math.cos(Math.atan2(smp.t[0], smp.t[2]) - (c.head || 0)) < 0 ? -slopeSin : slopeSin;
    // game.js:4730 reads the arc for EVERY car (c.kCur, render lean); here only an AI car does.
    let k = 0;
    if (!c.human) {
      k = aiField().track.curvature(c.s);
      c.kCur = k;
    }
    const dd = (DIFF as Record<string, (typeof DIFF)[keyof typeof DIFF]>)[world.ai ? world.ai.difficulty : "normal"] || DIFF.normal;
    const mods = c.mods || NEUTRAL_MODS;
    tyres.update(c, dt);
    pits.update(c, dt);
    // game.js:4741 engineer.update (local car, presentation).
    const aq = aquaInto(c, vStd(Math.abs(c.speed)), world.weather.raceWeather, world.weather.wetnessAt ? world.weather.wetnessAt(c.s) : trackWetness());
    const vT = vTop(),
      trMul = tyres.tractionMul(c),
      gmC = gripMult(c) * aq.mul,
      gm0 = gripMult();
    const perfMul = trMul * tyres.fuelAccelMul(c);

    // --- speed targets ---
    let vmax = VMAX * tune.PACE * (c.human ? (mods.speed as number) : (c.tierV as number) * (c.skill as number) * dd.ai);
    const windCar = world.wind.carInto(c.human ? c.head || 0 : Math.atan2(smp.t[0], smp.t[2]) - (c.aiHead || 0), vStd(Math.abs(c.speed)));
    vmax *= windCar.vmaxMul;
    // Wind.latA() (game.js:6062) is the side force THIS call computed, read later in the bicycle step.
    S.windLatA = windCar.latA;
    if (!c.human && aq.safeV < Infinity) vmax = Math.min(vmax, (aq.safeV * vT) / VMAX);
    const leadHuman = world.ai ? world.ai.leadHuman : null;
    if (!c.human && leadHuman && world.ai && world.ai.aiPace === "catchup") {
      const applied = AiBand.applyVmax(
        vmax,
        AiBand.factor({
          mode: world.ai.aiPace,
          leadProg: leadHuman.prog,
          carProg: c.prog,
          trackTotal: track.length,
          raceT,
          launchT0: world.ai.launchT0,
          bandAuth: dd.band,
        }),
        (c.tierV as number) * (c.skill as number) * dd.ai,
        BAND_CEIL,
      );
      vmax = applied.vmax;
      c._bandNow = applied.bandNow;
    } else c._bandNow = 0;
    let pitV = -1;
    if (pits.inLane(c)) {
      pitV = pits.limit();
      if (!c.human) pitV = Math.min(pitV, pits.approachV(c));
      vmax = Math.min(vmax, pitV);
    } else if (!c.human && c.pitArmed) {
      pitV = pits.entryV(c);
      vmax = Math.min(vmax, pitV);
    } else if (!c.human && c.pitState === "out") {
      pitV = pits.exitV(c);
      vmax = Math.min(vmax, pitV);
    }
    let cautionV = -1;
    {
      const lvl = raceCtl.level;
      if (lvl >= 2) cautionV = vmax = Math.min(vmax, vTop() * (lvl >= 4 ? 0.02 : lvl === 3 ? raceCtl.scQueueFrac(c) : 0.6));
      if ((lvl === 2 || lvl === 3) && !c.human && !(c.pitState && c.pitState !== "none")) {
        const h = raceCtl.holdCap(c, ranked);
        if (h < cautionV) cautionV = vmax = h;
      }
    }

    // --- AI traffic awareness (game.js:4790-4890) ---
    let roomL = Infinity,
      roomR = Infinity,
      blocker: PlayerCar | null = null,
      blockerGap = Infinity,
      unstuckActive = false,
      letPass = false;
    const aiFreeSpeed = 0;
    const squeezed = false;
    let roadL = Infinity,
      roadR = Infinity;
    const queued = false;
    let alongO: PlayerCar | null = null,
      alongDx = 0,
      alongDprog = 0;
    let towCar: PlayerCar | null = null,
      towGap = Infinity;
    let chaser: PlayerCar | null = null,
      chaserGap = Infinity;
    let nearbyN = 0,
      sep = 0;
    const aiT = c.human ? null : AiDrive.traits(c);
    if (!c.human) vmax *= AiDrive.pacePhase(raceT, (aiT as Traits).consistency, c.phaseRoll);
    if (!c.human && tyres.on() && state === "race") pits.think(c);
    if (!c.human && AiDrive.mistakePhase(c.errT) === 2) vmax *= AiDrive.mistakeGatherMul();
    if (!c.human && c.tyreClass) {
      vmax *= tyres.on() ? (1 + (c.tyre ? c.tyre.off : 0)) * trMul : AiDrive.tyrePace(c.tyreClass, Math.max(0, c.lap - 1));
    } else if (c.human) vmax *= trMul;
    vmax *= tyres.fuelVmaxMul(c);
    if (!c.human) {
      const t = aiT as Traits;
      const edge = track.street ? hw - 0.8 : hw + 5;
      roadL = c.x + hw - 0.5;
      roadR = hw - 0.5 - c.x;
      roomL = edge + c.x;
      roomR = edge - c.x;
      const L = track.length;
      const BACK = AiDrive.mirrorReach(t, c.speed),
        REJ = Math.max(34.1, BACK + 0.1);
      const MIN_GAP = AiDrive.minLatGap(hw, !!track.street);
      const ts = Collide.scanTraffic(c, L, BACK, REJ, MIN_GAP, !!track.street, roomL, roomR);
      roomL = ts.roomL;
      roomR = ts.roomR;
      nearbyN = ts.nearbyN;
      sep = ts.sep;
      blocker = ts.blocker as PlayerCar | null;
      blockerGap = ts.blockerGap;
      towCar = ts.towCar as PlayerCar | null;
      towGap = ts.towGap;
      chaser = ts.chaser as PlayerCar | null;
      chaserGap = ts.chaserGap;
      alongO = ts.alongO as PlayerCar | null;
      alongDx = ts.alongDx;
      alongDprog = ts.alongDprog;
      aiBoxed.contactT = c.contactT;
      aiBoxed.roomL = roomL;
      aiBoxed.roomR = roomR;
      aiBoxed.blocker = blocker;
      aiBoxed.blockerGap = blockerGap;
      aiBoxed.street = !!track.street;
      const boxed = AiDrive.isBoxed(aiBoxed);
      if (state === "race" && c.speed < 7 && boxed && raceCtl.level < 4) c.stuckT = (c.stuckT || 0) + dt;
      else c.stuckT = Math.max(0, (c.stuckT || 0) - dt * 1.5);
      unstuckActive = c.stuckT > AiDrive.stuckThreshold(t);
      const letPassCase = AiDrive.letPassCase(
        state === "race",
        blocker,
        chaser,
        chaserGap,
        chaser ? (chaser._snapSpeed as number) : 0,
        c.speed,
        vT / VMAX,
        !!chaser && (chaser._snapProg as number) - c.prog > track.length * 0.5,
      );
      if (letPassCase) c.letPassT = (c.letPassT || 0) + dt;
      else c.letPassT = Math.max(0, (c.letPassT || 0) - dt * 1.5);
      letPass = (c.letPassT || 0) > AiDrive.letPassDelay(t);
      if (alongO && alongO === c._alPrev && (c._alPrevDp as number) < 0 && alongDprog >= 0) {
        c.passFailOf = alongO;
        c.passFailT = Math.max(c.passFailT || 0, AiDrive.repassLock(t, (vmax - paceVmax(alongO)) / vT));
      }
      c._alPrev = alongO;
      c._alPrevDp = alongDprog;
    }

    // --- electric deploy ---
    let deploy = 0;
    const boostToggle = c.isPlayer && !!inp && inp.boost;
    if (boostToggle) c.boostOn = !c.boostOn;
    const pitHeld = pits.held(c);
    const ersHeld = pitHeld || cautionV >= 0 || c.pitState === "box";
    let aiWantsBoost = false;
    if (!c.human && c.energy > 0.02 && !ersHeld) {
      const t = aiT as Traits;
      const tc = towCar as PlayerCar | null;
      const ch = chaser as PlayerCar | null;
      aiWantsBoost = AiDrive.wantBoost({
        traits: t,
        energy: c.energy,
        otActive: (c.otT as number) > 0,
        kAhead60: aiField().track.curvature(wrapS(c.s + 60)),
        towCar: !!tc,
        towGap,
        towSpeed: tc ? (tc._snapSpeed as number) : 0,
        speed: c.speed,
        chaser: !!ch,
        chaserGap,
        chaserSpeed: ch ? (ch._snapSpeed as number) : 0,
        team: c.team,
        seat: c.seat,
        stats: c.houseStats,
        ersDeploy: c.ersDeploy,
        ersRegen: c.ersRegen,
        vTop: vT,
        street: !!track.street,
        towVmax: tc ? paceVmax(tc) : 0,
        ourVmax: paceVmax(c),
        ourPace: scriptPace(c),
        towPace: tc ? scriptPace(tc) : 0,
      });
    }
    const wantBoost = (c.human ? c.boostOn : aiWantsBoost) && !ersHeld;
    let otFree = false;

    // --- overtake mode ---
    const otSpeed = Math.max(0, c.speed);
    let ahead: PlayerCar | null = null,
      gapAhead = Infinity;
    const otL = track.length,
      otW = OT_GAP * otSpeed + 1;
    if (c._otLap == null || c._otS == null) {
      c._otLap = c.lap | 0;
      c._otS = c.s;
    }
    const otOpen = raceCtl.otDetectOpen();
    const otNeedAhead = (c.otE as number) > 0 || c.otOn || (otOpen && OvertakeMode.crossed(c._otS, c.s, otDetectAt, otL));
    if (otNeedAhead) {
      const ot = Collide.scanOtAhead(c, otL, otW, otSkipLane);
      ahead = ot.ahead as PlayerCar | null;
      gapAhead = ot.gapAhead;
    }
    gapAhead = ahead && c.speed > 1 ? gapAhead / c.speed : Infinity;
    OvertakeMode.lines(c, otTrack, gapAhead, otOpen && !pitHeld, otDetectAt);
    const otGate = raceCtl.otEnabled() && !c.finished && !pitHeld,
      otFast = vStd(c.speed) > OT_MIN_SPEED;
    OvertakeMode.arm(c, otGate, otFast);
    let fire: boolean;
    if (c.human) fire = !!(inp && inp.overtake);
    else {
      fire = !!c.otArmed && gapAhead < OT_GAP;
      if (fire) {
        const t = aiT as Traits;
        const bl = blocker as PlayerCar | null;
        const ah = ahead as PlayerCar | null;
        const fireCtx = {
          traits: t,
          blockerGap: bl ? blockerGap : gapAhead * (c.speed || 1),
          gapAhead: gapAhead * (c.speed || 1),
          roomL,
          roomR,
          speed: c.speed,
          vTop: vT,
          aheadSpeed: bl ? (bl._snapSpeed as number) : ah ? (ah._snapSpeed as number) : c.speed,
          kAhead: aiField().track.curvature(wrapS(c.s + 40)),
          street: !!track.street,
          team: c.team,
          seat: c.seat,
          stats: c.houseStats,
          other: bl,
          queueT: c.queueT || 0,
          blockerVmax: bl ? paceVmax(bl) : ah ? paceVmax(ah) : 0,
          ourVmax: paceVmax(c),
          ourPace: scriptPace(c),
          blockerPace: bl ? scriptPace(bl) : ah ? scriptPace(ah) : 0,
        };
        fire = AiDrive.otShouldFire(aiField().rnd(), dt, fireCtx);
      }
    }
    if (OvertakeMode.prepare(c, fire, otGate, otFast, otTimeFor(c)) && c.isPlayer && world.soundOn && audio && audio.deployBoost) audio.deployBoost();
    otFree = (c.otT as number) > 0;
    if (otFree || (wantBoost && c.energy > 0)) deploy = DEPLOY_A * Math.max(tune.PACE, 0.05) * deployTaper(c);
    if (c.isPlayer && c.otArmed && !c.wasArmed && world.soundOn && audio && audio.overtakeReady) audio.overtakeReady();
    c.wasArmed = c.otArmed;

    // --- braking / target speed ---
    S.hw = hw;
    S.dd = dd;
    S.vT = vT;
    S.trMul = trMul;
    S.gmC = gmC;
    S.gm0 = gm0;
    S.vmax = vmax;
    S.pitV = pitV;
    S.roomL = roomL;
    S.roomR = roomR;
    S.blocker = blocker;
    S.blockerGap = blockerGap;
    S.unstuckActive = unstuckActive;
    S.letPass = letPass;
    S.aiFreeSpeed = aiFreeSpeed;
    S.squeezed = squeezed;
    S.roadL = roadL;
    S.roadR = roadR;
    S.queued = queued;
    S.alongO = alongO;
    S.alongDx = alongDx;
    S.alongDprog = alongDprog;
    S.towCar = towCar;
    S.towGap = towGap;
    S.aiT = aiT;
    brakePlan(c, dt, inp, raceT);
    vmax = S.vmax;
    const braking = S.braking,
      brakeLvl = S.brakeLvl,
      throttleLvl = S.throttleLvl;

    // --- active aero ---
    c.xArmed = !c.offroad && !braking && vStd(c.speed) > X_MIN_SPEED && !c.finished && !pitHeld && state === "race" && world.aeroZoneAt(wrapS(c.s));
    if (c.human && world.aeroMode === "auto") {
      c.xOn = c.xArmed;
    } else if (c.human) {
      if (c.local) {
        if (inp && inp.aeroToggle) c.xOn = !c.xOn;
      } else c.xOn = !!(inp && inp.aero);
    } else {
      c.xOn =
        c.xArmed &&
        AiDrive.wantX({
          armed: true,
          team: c.team,
          seat: c.seat,
          stats: c.houseStats,
          energy: c.energy,
          catching: !!(towCar && towGap < 28),
          otActive: (c.otT as number) > 0,
        });
    }
    {
      const want = c.xOn && c.xArmed ? 1 : 0;
      if (c.human && c.local && world.soundOn && want !== (c._xSndWant ?? 0)) {
        if (audio && audio.xMode) audio.xMode(want === 1);
        c._xSndWant = want;
      }
      const rate = want > (c.aeroX || 0) ? X_OPEN_RATE : X_CLOSE_RATE;
      c.aeroX = clamp((c.aeroX || 0) + Math.sign(want - (c.aeroX || 0)) * rate * dt, Math.min(c.aeroX || 0, want), Math.max(c.aeroX || 0, want));
      if (!c.xArmed) c.xOn = false;
    }
    vmax *= 1 + xVmaxGain(c) * c.aeroX;
    c._vmaxNow = vmax;
    if (world.ai && state === "race" && raceCtl.level < 2 && !pits.inLane(c)) {
      const ai = world.ai;
      AiDrive.paceSample(ai.paceRef, Math.floor((c.s / track.length) * ai.track.n) % ai.track.n, c, vmax, !S.blocker || S.blockerGap > 30, dt);
    }

    // --- gearbox ---
    let gearMult = 1,
      accelCeil = vmax + 14 * Math.max(tune.PACE, 0.05);
    if (!c.human && aq.safeV < Infinity) accelCeil = Math.min(accelCeil, (aq.safeV * vT) / VMAX);
    if (c.human) {
      c.shiftT = Math.max(0, c.shiftT - dt);
      const up = !!(inp && inp.shiftUp),
        down = !!(inp && inp.shiftDown);
      if (world.gearsManual) {
        if (up && c.gear < GEARS && c.shiftT <= 0) {
          c.gear++;
          c.shiftT = 0.1;
          if (world.soundOn && c.local && audio && audio.shift) audio.shift(true);
        }
        if (down && c.gear > 1 && c.shiftT <= 0) {
          c.gear--;
          c.shiftT = 0.1;
          if (world.soundOn && c.local && audio && audio.shift) audio.shift(false);
        }
        const hi = gearHi(c.gear),
          lo = gearLo(c.gear);
        const frac = (c.speed - lo) / Math.max(hi - lo, 1);
        if (c.speed >= hi && c.gear < GEARS) {
          gearMult = 0.08;
          accelCeil = Math.min(accelCeil, hi + 1.5);
        } else if (frac < 0.25) gearMult = clamp(0.7 + frac * 1.2, 0, 1);
        if (c.speed < 0) gearMult = Math.max(gearMult, 0.7);
      }
    }

    // --- longitudinal ---
    S.hw = hw;
    S.slopeSin = slopeSin;
    S.slopeNose = slopeNose;
    S.trMul = trMul;
    S.gmC = gmC;
    S.gm0 = gm0;
    S.perfMul = perfMul;
    S.vmax = vmax;
    S.pitV = pitV;
    S.cautionV = cautionV;
    S.deploy = deploy;
    S.otFree = otFree;
    S.braking = braking;
    S.brakeLvl = brakeLvl;
    S.throttleLvl = throttleLvl;
    S.gearMult = gearMult;
    S.accelCeil = accelCeil;
    longitudinal(c, dt, inp, mods, raceT);
    deploy = S.deploy;

    // --- lateral ---
    S.hw = hw;
    S.k = k;
    S.dd = dd;
    S.vT = vT;
    S.vmax = vmax;
    S.roomL = roomL;
    S.roomR = roomR;
    S.blocker = blocker;
    S.blockerGap = blockerGap;
    S.unstuckActive = unstuckActive;
    S.letPass = letPass;
    S.roadL = roadL;
    S.roadR = roadR;
    S.alongO = alongO;
    S.alongDx = alongDx;
    S.alongDprog = alongDprog;
    S.chaser = chaser;
    S.chaserGap = chaserGap;
    S.nearbyN = nearbyN;
    S.sep = sep;
    S.aiT = aiT;
    S.braking = braking;
    lateral(c, dt, inp, raceT);
    // --- bicycle / kinematic step ---
    S.hw = hw;
    S.slopeSin = slopeSin;
    S.k = k;
    S.vT = vT;
    S.gmC = gmC;
    S.perfMul = perfMul;
    S.vmax = vmax;
    S.unstuckActive = unstuckActive;
    S.alongO = alongO;
    S.alongDx = alongDx;
    S.aiT = aiT;
    S.deploy = deploy;
    S.braking = braking;
    S.throttleLvl = throttleLvl;
    S.gearMult = gearMult;
    bicycle(c, dt, mods, assists);
    const steer = S.steer;
    wallCtx.track = track;
    wallCtx.dt = dt;
    wallCtx.steer = steer;
    wallCtx.soundOn = world.soundOn;
    WallClamp.apply(c, wallCtx);
    // game.js:5124 Damage.observe: display-only, nothing reads it back.
    c.brakeDemand = braking ? brakeLvl : 0;
    c.throttleDemand = S.onThrottle && !braking ? throttleLvl : 0;
    c.steerCommand = steer;
    c.steerVis = damp(c.steerVis as number, steer, 10, dt);
    let yawTarget: number;
    if (c.human && c.head != null) {
      let psi = Math.atan2(smp.t[0], smp.t[2]) - c.head;
      while (psi > Math.PI) psi -= 2 * Math.PI;
      while (psi < -Math.PI) psi += 2 * Math.PI;
      c.yawVis = psi;
      yawTarget = psi;
    } else {
      yawTarget = (c.steerVis as number) * 0.35 + clamp(-k * c.speed * 0.14, -0.28, 0.28);
    }
    if (!(c.human && c.head != null)) c.yawVis = damp(c.yawVis as number, yawTarget, 6, dt);
    {
      const heating = braking && vStd(c.speed) > 12;
      c.brakeHeat = clamp((c.brakeHeat || 0) + (heating ? dt * 1.6 : -dt * 0.9), 0, 1);
    }
    {
      const thr = c.human ? S.onThrottle : !braking;
      const lifted = !!c.wasOnThrottle && !thr && c.speed > 8;
      c.exhaustPop = lifted ? 1 : Math.max(0, (c.exhaustPop || 0) - dt * 5);
      c.wasOnThrottle = !!thr;
    }
    if (c.retired || c.finished) {
      c.towing = 0;
      c.wake = 0;
    }
    c.collideT = Math.max(0, c.collideT - dt);
    c.contactT = Math.max(0, (c.contactT || 0) - dt);

    // --- advance along track ---
    advance(c, dt, inp, braking, raceT, roomL, roomR, unstuckActive, S.queued, aiT);
  }

  // ── updateCarBrakePlan (game.js:5171-5367) ─────────────────────────────────
  function brakePlan(c: PlayerCar, dt: number, inp: PlayerInput | null, raceT: number): void {
    const hw = S.hw;
    const dd = S.dd;
    const vT = S.vT;
    const trMul = S.trMul;
    const gmC = S.gmC;
    const gm0 = S.gm0;
    let vmax = S.vmax;
    const pitV = S.pitV;
    const roomL = S.roomL;
    const roomR = S.roomR;
    const blocker = S.blocker;
    const blockerGap = S.blockerGap;
    const unstuckActive = S.unstuckActive;
    const letPass = S.letPass;
    let aiFreeSpeed = S.aiFreeSpeed;
    let squeezed = S.squeezed;
    const roadL = S.roadL;
    const roadR = S.roadR;
    let queued = S.queued;
    const alongO = S.alongO;
    const alongDx = S.alongDx;
    const alongDprog = S.alongDprog;
    const towCar = S.towCar;
    const towGap = S.towGap;
    const aiT = S.aiT;
    let braking = false;
    let brakeLvl = 1;
    let throttleLvl = 1;
    if (c.human) {
      braking = !!(inp && inp.brake);
      brakeLvl = inp ? (inp.brakeLevel ?? 1) : 1;
      throttleLvl = world.liveInput && world.autoThrottle ? 1 : inp ? (inp.throttleLevel ?? 1) : 1;
      c.towing = 0;
      c.wake = 0;
      {
        const tw = Collide.scanTow(c, track.length);
        const tc = tw.tc,
          tg = tw.tg;
        if (tc) c.wake = wakeOf(tg, (tc._snapX as number) - c.x);
        if (tc && !braking && Math.abs(c.steerVis || 0) < 0.12) {
          c.towing = c.wake;
          vmax *= 1 + towGain(!!track.street) * c.towing;
        }
      }
    } else {
      const ai = aiField();
      const t = aiT as Traits;
      const look = clamp(c.speed * 1.7, 30, 160);
      AiDrive.beginLook();
      let kMax = 0;
      const onLine = Math.abs(ai.track.lineAt(c.s).x - c.x) < 1.5;
      const dsN = track.length / ai.track.n;
      const node0 = Math.ceil(c.s / dsN),
        ss0 = node0 * dsN;
      const lk =
        c._lk ||
        (c._lk = {
          node: -1,
          on: false,
          track: null,
          n: 0,
          v: new Float64Array(AI_LOOK_CAP),
          a: new Float64Array(AI_LOOK_CAP),
          b: new Float64Array(AI_LOOK_CAP),
          m: new Float64Array(AI_LOOK_CAP),
        });
      if (lk.node !== node0 || lk.on !== onLine || lk.track !== track) {
        lk.node = node0;
        lk.on = onLine;
        lk.track = track;
        lk.n = 0;
      }
      let lkI = 0;
      for (let ss = ss0, d = ss0 - c.s; d < look; ss += dsN, d += dsN, lkI++) {
        if (lkI < lk.n) {
          if ((lk.a[lkI] as number) > kMax) kMax = lk.a[lkI] as number;
          AiDrive.pushLook(d, lk.v[lkI] as number, lk.b[lkI] as number, lk.m[lkI] as number);
          continue;
        }
        const kk = ai.track.curvature(ss);
        const ak = Math.abs(kk);
        if (ak > kMax) kMax = ak;
        const lkV = onLine ? ai.track.pathK(ss) : kk,
          lkB = Math.abs(ai.track.bankAngle(ss));
        const lkM = AiDrive.bankGrip(lkB);
        AiDrive.pushLook(d, lkV, lkB, lkM);
        if (lkI < AI_LOOK_CAP) {
          lk.v[lkI] = lkV;
          lk.a[lkI] = ak;
          lk.b[lkI] = lkB;
          lk.m[lkI] = lkM;
          lk.n = lkI + 1;
        }
      }
      const br = AiDrive.brakeDecision({
        traits: t,
        samples: AiDrive.endLook(),
        latMax: LAT_MAX,
        diffCorner: Math.min(1, dd.corner * (1 + (c._bandNow || 0))),
        aeroLoad: c.aeroLoad,
        brake: BRAKE * trMul * (gmC / gm0),
        pace: tune.PACE,
        vmax: VMAX,
        grip: gmC * world.tyres.gripMul(c) * dirtyAirMul(c.wake || 0, c.speed),
        speed: c.speed,
        blocker: !!blocker,
        blockerGap,
        blockerSpeed: blocker ? (blocker._snapSpeed as number) : 0,
        roomL,
        roomR,
        team: c.team,
        seat: c.seat,
        stats: c.houseStats,
        errMul: AiDrive.mistakePhase(c.errT) === 1 ? AiDrive.mistakeBrakeMul() : 1,
      });
      braking = br.braking;
      brakeLvl = br.brakeLvl;
      c.wake = towCar ? wakeOf(towGap, (towCar._snapX as number) - c.x) : 0;
      c.towing = towCar && !braking && kMax < 0.006 ? c.wake : 0;
      if (c.towing > 0) {
        const tc = towCar as PlayerCar;
        const towH = AiDrive.passHunger({
          street: !!track.street,
          traits: t,
          vTop: vT,
          queueT: c.queueT || 0,
          blockerVmax: paceVmax(tc),
          ourVmax: paceVmax(c),
          blockerPace: scriptPace(tc),
          ourPace: scriptPace(c),
        });
        vmax *= 1 + AiDrive.towGain(!!track.street, towH) * c.towing;
      }
      if (pitV >= 0) vmax = Math.min(vmax, pitV);
      const followR = blocker
        ? AiDrive.followGap(
            t,
            !!track.street,
            c.speed,
            c.passOf || c.atkOn || c.towing > 0 ? 1 : c.atkWant ? 0.6 : 0,
            c.team,
            c.seat,
            blocker,
            c.houseStats,
            (c.runT || 0) + AiDrive.startGapT((c.calm = AiDrive.startCalm(c.launchOn, c.calmUntil, raceT))),
          )
        : 0;
      const qWin = AiDrive.queueReach(
        Math.max(16, followR + 6 + AiDrive.startQWinBonus(c.calm, raceT - ai.launchT0)),
        c.speed,
        blocker ? (blocker._snapSpeed as number) : 0,
        BRAKE,
        vT / VMAX,
      );
      const capBlocks = !!blocker && blockerGap < qWin && !(blocker === c.passOf && Math.abs(c.x - (blocker._snapX as number)) >= 1.8);
      if (blocker && blockerGap < qWin) aiFreeSpeed = vmax;
      c.queueT = AiDrive.queueTime(c.queueT, capBlocks && blocker === c._qOf && world.raceCtl.level < 2, dt);
      c._qOf = capBlocks ? blocker : null;
      if (capBlocks) {
        const bl = blocker as PlayerCar;
        queued = world.pits.inLane(bl);
        const onLane = queued && world.pits.held(c);
        const follow = onLane ? AiDrive.laneFollow() : followR;
        const q = (bl._snapSpeed as number) + clamp(blockerGap - follow, -6, 8);
        const crawl = onLane ? 0 : Math.min(AiDrive.queueFloor(!!track.street) * Math.max(tune.PACE, 0.05), vmax);
        vmax = Math.min(vmax, Math.max(q, crawl));
        const qb = AiDrive.queueBrake(c.speed, bl._snapSpeed as number, !!track.street, blockerGap, follow, BRAKE, vT / VMAX);
        if (qb) {
          braking = true;
          brakeLvl = qb;
        }
      }
      if (letPass) vmax *= AiDrive.letPassEase(t);
      if (alongO) {
        const al = alongO;
        if (
          (c.sbsT as number) >
            AiDrive.sbsCommitT({
              street: !!track.street,
              traits: t,
              vTop: vT,
              other: al,
              ourVmax: paceVmax(c),
              ourPace: scriptPace(c),
              otherVmax: paceVmax(al),
              otherPace: scriptPace(al),
            }) &&
          c.passOf !== al &&
          (al._snapSpeed as number) >= c.speed - (0.5 * vT) / VMAX
        )
          vmax = Math.min(
            vmax,
            (al._snapSpeed as number) *
              AiDrive.sbsEase({
                street: !!track.street,
                traits: t,
                vTop: vT,
                other: al,
                ourVmax: paceVmax(c),
                ourPace: scriptPace(c),
                otherVmax: paceVmax(al),
                otherPace: scriptPace(al),
              }),
          );
      }
      squeezed =
        (c.contactT || 0) > 0 &&
        !!alongO &&
        AiDrive.sideYieldsA(-alongDprog, c.x, alongO._snapX as number, c.kTurn) &&
        (alongDx <= 0 ? Math.min(roomR, roadR) : Math.min(roomL, roadL)) < AiDrive.minLatGap(hw, !!track.street);
      if (squeezed) {
        vmax = Math.min(vmax, ((alongO as PlayerCar)._snapSpeed as number) * AiDrive.squeezeEase(!!track.street));
        if (!unstuckActive) {
          braking = true;
          brakeLvl = Math.max(brakeLvl, AiDrive.squeezeBrake());
        }
      }
      if (unstuckActive) {
        braking = false;
        brakeLvl = 0;
      }
    }
    S.vmax = vmax;
    S.aiFreeSpeed = aiFreeSpeed;
    S.squeezed = squeezed;
    S.queued = queued;
    S.braking = braking;
    S.brakeLvl = brakeLvl;
    S.throttleLvl = throttleLvl;
  }

  // ── updateCarLongitudinal (game.js:5368-5561) ──────────────────────────────
  function longitudinal(c: PlayerCar, dt: number, inp: PlayerInput | null, mods: NonNullable<PlayerCar["mods"]>, raceT: number): void {
    const hw = S.hw;
    const slopeSin = S.slopeSin;
    const slopeNose = S.slopeNose;
    const trMul = S.trMul;
    const gmC = S.gmC;
    const gm0 = S.gm0;
    const perfMul = S.perfMul;
    const vmax = S.vmax;
    const pitV = S.pitV;
    const cautionV = S.cautionV;
    let deploy = S.deploy;
    const otFree = S.otFree;
    const braking = S.braking;
    const brakeLvl = S.brakeLvl;
    const throttleLvl = S.throttleLvl;
    const gearMult = S.gearMult;
    const accelCeil = S.accelCeil;
    const state = world.state;
    c.onKerb = track.onKerb(c.s, c.x) > 0;
    c.inPitLane = Math.abs(c.x) > hw && track.inPitLane(c.s, c.x);
    c.offroad = Math.abs(c.x) > hw && !c.onKerb && !c.inPitLane;
    const surfaceMu = c.offroad ? lerp(1, OFF_GRIP, clamp((Math.abs(c.x) - hw) / 1.5, 0, 1)) : 1;
    const roadBrake = BRAKE * trMul * (c.human ? (mods.braking as number) : 1) * (gmC / gm0);
    const grassDrag = Math.min((1 - surfaceMu) * 24, roadBrake * 0.75);
    const surfaceBrake = c.offroad ? Math.min(roadBrake * surfaceMu, Math.max(0, roadBrake * 0.95 - grassDrag)) : roadBrake;
    const brakeDecel = c.human && world.liveInput ? Math.max(surfaceBrake * brakeLvl, COAST_DRAG) : surfaceBrake * brakeLvl;
    const longitudinalSpeed = c.speed;

    const wallPinned = c.human && (c.wallT || 0) > 0;
    const onThrottle = c.human ? (world.liveInput ? (world.autoThrottle && !wallPinned) || !!(inp && inp.throttle) : !!(inp && inp.throttle)) : true;
    if (otFree) deploy *= OvertakeMode.consume(c, dt, onThrottle && !braking && deploy > 0, otTimeFor(c));
    if (!onThrottle || braking) deploy = 0;
    if (deploy > 0 && !otFree) {
      c.energy = Math.max(0, c.energy - drainFor(c) * dt);
      if (c.energy <= 0) c.boostOn = false;
    }
    c.deploying = deploy > 0;
    if (braking) {
      if (c.speed > 0) {
        c.speed = Math.max(0, c.speed - brakeDecel * dt);
      } else if (c.human && state === "race") {
        c.speed = Math.max(REVERSE_MAX, c.speed - REVERSE_ACCEL * surfaceMu * dt);
      }
      c.energy = Math.min(1, c.energy + regenFor(c) * 1.6 * regenSpeedK(c) * dt);
    } else if (!onThrottle) {
      const cd = COAST_DRAG * (1 - xCoastCut(c) * (c.aeroX || 0));
      if (c.speed > 0) c.speed = Math.max(0, c.speed - cd * dt);
      else if (c.speed < 0) c.speed = Math.min(0, c.speed + cd * dt);
      c.energy = Math.min(1, c.energy + regenFor(c) * regenSpeedK(c) * dt);
    } else {
      const ai = world.ai;
      const launch = c.launchOn ? AiDrive.launchMul(raceT - aiField().launchT0, c.launch) : 1;
      if (c.launchOn && AiDrive.launchDone(raceT - aiField().launchT0, c.launch)) {
        c.launchOn = false;
        c.calmUntil = aiField().launchT0 + AiDrive.startCalmS();
      }
      void ai;
      const a =
        (ACCEL * tune.PACE * perfMul * (c.human ? (mods.accel as number) * throttleLvl : launch) * clamp(1 - c.speed / Math.max(vmax, 1), 0, 1) * gearMult + deploy) *
        surfaceMu *
        (state === "race" ? 1 : 0);
      if (!c.human) c.accSm = damp(c.accSm ?? 0, a, 6, dt);
      c.speed = c.speed > accelCeil ? Math.max(accelCeil, c.speed - COAST_DRAG * dt) : Math.min(accelCeil, c.speed + a * dt);
      if (c.speed < vmax * 0.5 && !(deploy > 0)) c.energy = Math.min(1, c.energy + regenFor(c) * regenSpeedK(c) * dt);
    }
    if (state === "race" && slopeNose) {
      const a = clamp(-GRAVITY_SLOPE * slopeNose, -ACCEL * 0.5, ACCEL * 0.5);
      if (a < 0) {
        if (c.speed > 0) c.speed = Math.max(0, c.speed + a * dt);
      } else {
        const cap = vmax * 1.06;
        if (c.speed < cap && !(braking && c.speed <= a * dt)) c.speed = Math.min(cap, c.speed + a * dt);
      }
    }
    if (pitV >= 0 && c.speed > pitV) c.speed = Math.max(pitV, c.speed - BRAKE * CAUTION_BRAKE * dt);
    if (c.pitState === "box") c.speed = 0;
    if (cautionV >= 0 && c.speed > cautionV) c.speed = Math.max(cautionV, c.speed - BRAKE * CAUTION_BRAKE * dt);
    if (state === "race" && c.speed > vmax * 1.06 && slopeSin >= -0.03) {
      c.speed = Math.max(vmax * 1.06, c.speed - COAST_DRAG * 0.35 * dt);
    }
    const gearSpeed = Math.max(0, c.speed);
    if (c.human && !world.gearsManual) {
      const ng = naturalGear(gearSpeed);
      if (ng !== c.gear && state === "race" && world.soundOn && c.local && audio && audio.shift) audio.shift(ng > c.gear);
      c.gear = ng;
    } else if (!c.human) c.gear = naturalGear(gearSpeed);
    c.rpm = rpmFor(c.gear, gearSpeed);

    if (c.offroad) {
      const grassFloor = GRASS_V * 0.6 * Math.max(tune.PACE, 0.05);
      if (c.speed > grassFloor) c.speed = Math.max(grassFloor, c.speed - grassDrag * dt);
      c.offT += dt;
      if (c.offT > 1.2) {
        c.offT = -2;
        c.cuts++;
        c.incidentInvalidLap = true;
        if (c.isPlayer && isQuali()) c.qualiCut = true;
        const priced = !isTimeTrial() && !isQuali();
        c.cutWarn = ((c.cutWarn as number) | 0) + 1;
        if (!priced) {
          if (c.cutWarn >= 4) c.cutWarn = 0;
          if (c.isPlayer) {
            announce("LAP INVALIDATED", 1.2, "penalty-warn");
            if (world.soundOn && audio && audio.offtrack) audio.offtrack();
          }
        } else if (c.cutWarn >= 4) {
          c.penalty += 5;
          if (c.isPlayer) {
            announce("+5s TRACK LIMITS PENALTY", 2, "penalty-hit");
            if (world.soundOn && audio && audio.penalty) audio.penalty();
          }
        } else if (c.isPlayer) {
          announce("TRACK LIMITS " + c.cutWarn + "/4" + (c.cutWarn === 3 ? " — BLACK & WHITE FLAG" : ""), 1.2, "penalty-warn");
          if (world.soundOn && audio && audio.offtrack) audio.offtrack();
        }
      }
    } else if (c.offT !== 0) {
      c.offT = c.offT > 0 ? Math.max(0, c.offT - dt) : Math.min(0, c.offT + dt);
    }

    c.kerbGripSm = damp(c.kerbGripSm ?? 1, c.onKerb ? 0.7 : 1, 12, dt);
    if (c.kerbGripSm < 0.999) c.speed = Math.sign(c.speed) * Math.max(0, Math.abs(c.speed) - ((6 * (1 - c.kerbGripSm)) / 0.3) * dt);
    if (c.onKerb && c.isPlayer) c.kerbCueT = KERB_CUE_HOLD;
    if (c.isPlayer && (c.kerbCueT = Math.max(0, (c.kerbCueT || 0) - dt)) > 0) {
      shake(0, KERB_SHAKE);
      c.kerbSndT = (c.kerbSndT || 0) - dt;
      if (world.soundOn && c.kerbSndT <= 0) {
        if (audio && audio.rumble) audio.rumble();
        c.kerbSndT = 0.07;
      }
      if ((c.kerbHapT = (c.kerbHapT || 0) - dt) <= 0) {
        if (haptics) {
          haptics.vibrate(15);
          haptics.rumble(0.25, 90, "handles");
        }
        c.kerbHapT = 0.12;
      }
    }
    c.corridorAccel = damp(c.corridorAccel || 0, (c.speed - longitudinalSpeed) / Math.max(dt, 1e-6), 6, dt);
    S.deploy = deploy;
    S.surfaceMu = surfaceMu;
    S.brakeDecel = brakeDecel;
    S.onThrottle = onThrottle;
  }

  // ── updateCarLateral (game.js:5563-5902) ───────────────────────────────────
  function lateral(c: PlayerCar, dt: number, inp: PlayerInput | null, raceT: number): void {
    const hw = S.hw;
    const k = S.k;
    const dd = S.dd;
    const vT = S.vT;
    const vmax = S.vmax;
    const roomL = S.roomL;
    const roomR = S.roomR;
    const blocker = S.blocker;
    const blockerGap = S.blockerGap;
    const unstuckActive = S.unstuckActive;
    const letPass = S.letPass;
    const aiFreeSpeed = S.aiFreeSpeed;
    const squeezed = S.squeezed;
    const roadL = S.roadL;
    const roadR = S.roadR;
    const alongO = S.alongO;
    const alongDx = S.alongDx;
    const alongDprog = S.alongDprog;
    const chaser = S.chaser;
    const chaserGap = S.chaserGap;
    const nearbyN = S.nearbyN;
    let sep = S.sep;
    const aiT = S.aiT;
    const braking = S.braking;
    let steer: number;
    let gripScale: number | undefined;
    if (c.human) {
      steer = inp ? (inp.steer ?? 0) : 0;
    } else {
      const ai = aiField();
      const at = ai.track;
      const t = aiT as Traits;
      const L = track.length;
      c.lane = AiDrive.adaptLane(
        c.lane,
        {
          traits: t,
          nearby: nearbyN,
          roomL,
          roomR,
          street: !!track.street,
          baseLane: c.lanePref != null ? c.lanePref : c.lane,
          queueT: c.queueT || 0,
        },
        dt,
      );
      const kA = at.curvature(wrapS(c.s + clamp(c.speed * 0.7, 18, 70)));
      const famWant = c.passOf ? ((c.passSide as number) * -(kA >= 0 ? 1 : -1) > 0 ? 1 : -1) : c.defendSide ? 1 : 0;
      c.aiFam = damp(c.aiFam || 0, famWant, 1.5, dt);
      const lead = clamp(c.speed * 0.3, 8, 25);
      const follow = AiDrive.lineFollow(!!track.street, AiDrive.houseStyle(c.team, c.seat, c.houseStats).hold);
      const laneX = c.lane * (hw - 1.2);
      const ln = at.lineAt(wrapS(c.s + lead), c.aiFam);
      let targetX = clamp(lerp(laneX, ln.x, ln.w * follow), -(hw - 1.0), hw - 1.0);
      const ln2 = at.lineAt(wrapS(c.s + lead + 4), c.aiFam);
      let tanT = (clamp(lerp(laneX, ln2.x, ln2.w * follow), -(hw - 1.0), hw - 1.0) - targetX) / 4;
      if (AiDrive.mistakePhase(c.errT) === 1 && Math.abs(kA) > 0.004) targetX = lerp(targetX, Math.sign(kA) * (hw - 0.9), 0.7);
      let overtake = 0;
      const CLEAR = AiDrive.minLatGap(hw, !!track.street);
      c.passCool = Math.max(0, (c.passCool || 0) - dt);
      c.passFailT = Math.max(0, (c.passFailT || 0) - dt);
      const _atk = at.attackAt(c.s);
      // _atk is TrackLine's pooled object: read both fields before the next attackAt (f1-game reads it inline).
      const atkQ = _atk.q,
        atkTo = _atk.toTurnIn;
      c.kTurn =
        atkTo < 400
          ? AiDrive.cornerK(at.curvature(wrapS(c.s + atkTo + 10)), at.curvature(wrapS(c.s + atkTo + 30)), at.curvature(wrapS(c.s + atkTo + 55)))
          : 0;
      const _passH = blocker
        ? AiDrive.passHunger({
            street: !!track.street,
            traits: t,
            vTop: vT,
            queueT: c.queueT || 0,
            blockerVmax: paceVmax(blocker),
            ourVmax: paceVmax(c),
            blockerPace: scriptPace(blocker),
            ourPace: scriptPace(c),
          })
        : 1;
      c.runT =
        blocker && blockerGap < 40
          ? AiDrive.runExtra(k, at.attackQ(Math.floor((wrapS(c.s + atkTo - 2) / L) * at.n) % at.n), c.atkWant, !!track.street, _passH)
          : 0;
      c.pressT = clamp((c.pressT || 0) + (chaser && chaserGap < 0.6 * Math.max(c.speed, 10) ? dt : -dt * 0.5), 0, 6);
      c.errT = Math.max(0, (c.errT || 0) - dt);
      if (atkTo < Math.max(c.speed, 10) * 1.2) {
        const zk = Math.round(wrapS(c.s + atkTo));
        if (zk !== c.zoneKey) {
          c.zoneKey = zk;
          if (
            !c.errT &&
            !alongO &&
            fnv1a(ai.luckSeed + ":" + ai.round + ":" + c.gridPos + ":" + c.lap + ":" + zk) / 4294967296 < AiDrive.mistakeChance(t, c.pressT / 6, dd.err)
          ) {
            c.errT = AiDrive.mistakeTotal();
            c.errCount = (c.errCount || 0) + 1;
          }
        }
      } else c.zoneKey = -1;
      c.wheelLock = AiDrive.mistakePhase(c.errT) === 1 && braking ? 1 : 0;
      if (c.passOf) {
        const po = c.passOf;
        let dp = (po._snapProg as number) - c.prog;
        dp = ((((dp + L / 2) % L) + L) % L) - L / 2;
        const sideRoom = (c.passSide as number) > 0 ? Math.min(roomR, roadR) : Math.min(roomL, roadL);
        if (po.finished || po.retired || world.raceCtl.level >= 2 || dp > AI_PASS_LATCH_M || !Number.isFinite(dp)) {
          c.passOf = null;
        } else if (dp < -(LCAR + 1.5)) {
          c.passOf = null;
          if (!po.human && !po.retired) {
            po.passFailOf = c;
            const poCool = AiDrive.repassLock(AiDrive.traits(po), (paceVmax(po) - paceVmax(c)) / vT);
            if (!c.human) AiDrive.traits(c);
            po.passFailT = Math.max(po.passFailT || 0, poCool);
            if (po.passOf === c) {
              po.passOf = null;
              po.passCool = po.passFailT;
            }
          }
        } else if (
          AiDrive.passSideClosed(
            sideRoom,
            (c.passSide as number) * (AiDrive.passTarget(po._snapX as number, c.passSide as number, CLEAR, hw) - c.x),
            WCAR,
          )
        ) {
          c.passOf = null;
          c.passCool = AiDrive.passCooldown(t);
        } else if (squeezed) {
          c.passOf = null;
          c.passCool = AiDrive.passCooldown(t);
        } else if (atkTo < 6 && dp > AiDrive.sideLevel() && Math.max(aiFreeSpeed, blocker === po ? 0 : vmax) < paceVmax(po) + 0.12 * vT) {
          c.passOf = null;
          c.passCool = AiDrive.passCooldown(t);
          c.passFailOf = po;
          c.passFailT = 2 * AiDrive.passCooldown(t);
        } else {
          if (dp < (c.passBest as number) - 0.3) {
            c.passBest = dp;
            c.passT = AiDrive.passHold(t);
          } else c.passT = (c.passT as number) - dt;
          if ((c.passT as number) <= 0) {
            c.passOf = null;
            c.passCool = AiDrive.passCooldown(t);
          }
        }
      }
      if (blocker) {
        const pull: AiCorridor.CorridorCtx = {
          street: !!track.street,
          traits: t,
          speed: c.speed,
          team: c.team,
          seat: c.seat,
          stats: c.houseStats,
          blockerSpeed: blocker._snapSpeed as number,
          blockerGap,
          roomL,
          roomR,
          other: blocker,
          roadL,
          roadR,
          kAhead: kA,
          lane: c.lane,
          freeSpeed: aiFreeSpeed,
          blockerVmax: paceVmax(blocker),
          vTop: vT,
          queueT: c.queueT || 0,
          ourVmax: paceVmax(c),
          ourPace: scriptPace(c),
          blockerPace: scriptPace(blocker),
          blockerAccel: blocker.human ? blocker.axEstSm || 0 : blocker.accSm || 0,
          attackQ: atkQ,
          toTurnIn: atkTo,
          kTurn: c.kTurn,
          calm: c.calm || 0,
          roll: AiDrive.attemptRoll(c.raceHash, c.lap, Math.round(wrapS(c.s + atkTo))),
        };
        c.atkWant = AiDrive.otWant(pull);
        const sameCar = blocker === c.passFailOf && (c.passFailT || 0) > 0;
        const moveOn = (c.atkOn = world.raceCtl.level < 2 && !sameCar && c.atkWant && AiDrive.attackOK(pull));
        if (!c.passOf && (c.passCool as number) <= 0 && moveOn && blockerGap <= AI_PASS_LATCH_M && AiDrive.latchLate(pull)) {
          const side = AiCorridor.choose(pull, c, blocker, ai.cars, track.length, CLEAR, c.passPlan || (c.passPlan = {})).side;
          if (side && (side > 0 ? Math.min(roomR, roadR) : Math.min(roomL, roadL)) >= CLEAR) {
            c.passOf = blocker;
            c.passSide = side;
            c.passBest = blockerGap;
            c.passT = AiDrive.passHold(t);
          }
        }
        if (!c.passOf) overtake = moveOn && (!c.passPlan || c.passPlan.side) ? AiDrive.otPull(pull) : 0;
      } else c.atkOn = c.atkWant = false;
      if (c.passOf && world.raceCtl.level >= 2) c.passOf = null;
      if (c.passOf) overtake = AiDrive.passTarget(c.passOf._snapX as number, c.passSide as number, CLEAR, hw) - targetX;
      let yieldPull = 0;
      if (letPass) {
        const freeSide = roomR >= roomL ? 1 : -1;
        const freeRoom = freeSide > 0 ? roomR : roomL;
        if (freeRoom > 1.6) yieldPull = freeSide * AiDrive.letPassPull(t, !!track.street) * clamp(freeRoom / 2.4, 0, 1);
      }
      let defend = 0;
      const caution = world.raceCtl.level >= 2;
      if (chaser && !caution && (!blocker || chaserGap < blockerGap) && !letPass && !c.passOf) {
        defend = AiDrive.defendPull({
          street: !!track.street,
          traits: t,
          speed: c.speed,
          team: c.team,
          seat: c.seat,
          stats: c.houseStats,
          chaser: true,
          chaserGap,
          chaserSpeed: chaser._snapSpeed as number,
          kA,
          roomL,
          roomR,
          other: chaser,
          x: c.x,
          vTop: vT,
          blocker,
          blockerGap,
          kTurn: c.kTurn,
          toTurnIn: atkTo,
          roadL,
          roadR,
          chaserVmax: paceVmax(chaser),
          ourVmax: paceVmax(c),
          chaserPace: scriptPace(chaser),
          ourPace: scriptPace(c),
        });
      }
      if (braking || caution) {
        c.defendSide = 0;
        defend = 0;
      } else {
        AiDrive.defendOnce(defend, c.defendSide || 0, aiDefOnce);
        defend = aiDefOnce.defend;
        c.defendSide = aiDefOnce.side;
      }
      const freer = roomR - roomL;
      const unstuckSide = Math.abs(freer) > 1 ? (freer > 0 ? 1 : -1) : Math.abs(c.x) > 1.5 ? (c.x > 0 ? -1 : 1) : c.lane >= 0 ? 1 : -1;
      const unstuck = unstuckActive ? unstuckSide * AiDrive.unstuckPull(t, !!track.street) : 0;
      const sepMax = AiDrive.sepClamp(!!track.street);
      sep = clamp(sep, -sepMax, sepMax);
      const biasWant = overtake + defend + yieldPull + sep;
      c.aiBias = c.aiBias == null ? biasWant : c.aiBias + clamp(biasWant - c.aiBias, -AI_BIAS_SLEW * dt, AI_BIAS_SLEW * dt);
      let desiredX = clamp(targetX + c.aiBias + unstuck, -(hw - 0.5), hw - 0.5);
      const holdLine = braking && chaser && !c.passOf && !unstuckActive && chaserGap < AiDrive.holdLineGap(c.speed);
      if (holdLine) {
        if (c.holdOff == null) c.holdOff = desiredX - targetX;
        desiredX = clamp(targetX + c.holdOff, -(hw - 0.5), hw - 0.5);
      } else c.holdOff = null;
      const pk = ai.parked.length ? (Collide.parkedAhead(c, ai.parked, track.length, 30 + 1.5 * c.speed) as PlayerCar | null) : null;
      if (pk && Math.abs(desiredX - pk.x) < CLEAR) desiredX = clamp(pk.x > 0 ? pk.x - CLEAR : pk.x + CLEAR, -(hw - 0.5), hw - 0.5);
      let rubClamp = false;
      const alongClose = !!alongO && Math.abs(alongDx) < CLEAR;
      const aimClose = !!alongO && !alongClose && !!alongO.human && AiDrive.aimIntrudes(desiredX, c.x, alongO._snapX as number, CLEAR);
      let yieldMine = alongClose && AiDrive.sideYieldsA(-alongDprog, c.x, (alongO as PlayerCar)._snapX as number, c.kTurn);
      const inBand = alongClose && Math.abs(alongDx) < CLEAR - AiDrive.humanYieldBand();
      const intruding = inBand && (alongDx <= 0 ? desiredX < c.x : desiredX > c.x);
      c.hYieldT = AiDrive.humanYieldT(c.hYieldT as number, !!alongO && Math.abs(alongDx) < CLEAR + 1, yieldMine, !!(alongO && alongO.human), intruding, dt, inBand);
      if (!yieldMine && AiDrive.humanYieldTakes(c.hYieldT)) yieldMine = true;
      if (!yieldMine && aimClose && (alongO as PlayerCar).human) yieldMine = true;
      c.sbsT = yieldMine ? (c.sbsT || 0) + dt : 0;
      if (yieldMine) {
        const al = alongO as PlayerCar;
        desiredX = alongDx <= 0 ? Math.max(desiredX, (al._snapX as number) + CLEAR) : Math.min(desiredX, (al._snapX as number) - CLEAR);
        desiredX = clamp(desiredX, -(hw - 0.5), hw - 0.5);
        rubClamp = alongClose;
      }
      {
        const lx = world.pits.laneX(c, hw, desiredX);
        if (lx !== desiredX) {
          desiredX = lx;
          tanT = 0;
        }
      }
      const err = desiredX - c.x;
      const vAbs = Math.abs(c.speed);
      const emergency = unstuckActive || rubClamp || (c.contactT || 0) > 0;
      if (emergency || vStd(vAbs) < AI_HEAD_VMIN) {
        let e = err;
        if (Math.abs(e) < 0.3) e *= Math.abs(e) / 0.3;
        steer = clamp(e * 0.9, -1, 1);
        if (c.steerSm === undefined) c.steerSm = steer;
        c.steerSm = damp(c.steerSm, steer, AiDrive.steerDamp(t), dt);
        steer = c.steerSm;
        const vl = steer * STEER_VMAX * clamp(vStd(vAbs) / 18, 0, 1);
        c.aiHead = vAbs > 1 ? clamp(Math.asin(clamp(vl / vAbs, -1, 1)), -AI_HEAD_MAX, AI_HEAD_MAX) : 0;
      } else {
        const steeringGrip = S.gmC * world.tyres.gripMul(c) * dirtyAirMul(c.wake || 0, c.speed);
        const headWant = clamp(Math.atan(tanT) + Math.atan((AI_XTRACK_GAIN * err) / Math.max(vAbs, 1)), -AI_HEAD_MAX, AI_HEAD_MAX);
        const yawMax = Math.min(AI_YAW_MAX, (AI_YAW_LAT * LAT_MAX * AiDrive.yawScale(c.speed, c.aeroLoad as number, steeringGrip, tune.PACE, VMAX)) / vAbs);
        const head0 = c.aiHead || 0;
        c.aiHead = head0 + clamp(headWant - head0, -yawMax * dt, yawMax * dt);
        gripScale = AiDrive.lateralScale(c.speed, c.aeroLoad as number, steeringGrip, tune.PACE, VMAX, aeroDfMult(c));
        steer = clamp((vAbs * Math.sin(c.aiHead)) / Math.max(STEER_VMAX * clamp(vStd(vAbs) / 18, 0, 1) * gripScale, 1), -1, 1);
        c.steerSm = steer;
      }
      void raceT;
    }
    const latFac = clamp(vStd(Math.abs(c.speed)) / 18, 0, 1);
    // game.js:5889 computes gripScale for every car; only the AI's kinematic step reads it, and it is pure.
    if (gripScale === undefined && !c.human)
      gripScale = AiDrive.lateralScale(c.speed, c.aeroLoad as number, S.gmC * world.tyres.gripMul(c) * dirtyAirMul(c.wake || 0, c.speed), tune.PACE, VMAX, aeroDfMult(c));
    const kerbGrip = c.kerbGripSm ?? 1;
    const bankPhys = track.banking(c.s, 0, bankScratch);
    const bankRoll = bankPhys ? Math.abs(bankPhys.roll) : 0;
    const bankMu = 1 + Math.sin(bankRoll) * 0.8;
    S.steer = steer;
    S.gripScale = gripScale ?? 0;
    S.latFac = latFac;
    S.kerbGrip = kerbGrip;
    S.bankMu = bankMu;
  }

  // ── updateCarBicycle (game.js:5904-6108) ───────────────────────────────────
  function bicycle(c: PlayerCar, dt: number, mods: NonNullable<PlayerCar["mods"]>, assists: AssistInput): void {
    const hw = S.hw;
    const slopeSin = S.slopeSin;
    const vT = S.vT;
    const gmC = S.gmC;
    const perfMul = S.perfMul;
    const vmax = S.vmax;
    const deploy = S.deploy;
    const braking = S.braking;
    const throttleLvl = S.throttleLvl;
    const gearMult = S.gearMult;
    const surfaceMu = S.surfaceMu;
    const brakeDecel = S.brakeDecel;
    const onThrottle = S.onThrottle;
    let steer = S.steer;
    const gripScale = S.gripScale;
    const latFac = S.latFac;
    const kerbGrip = S.kerbGrip;
    const bankMu = S.bankMu;
    if (c.human) {
      if (c.px == null) {
        const w0 = worldFromTrack(c.s, c.x, smp);
        c.px = w0.x;
        c.pz = w0.z;
        c.head = Math.atan2(smp.t[0], smp.t[2]);
        c.vLat = 0;
        c.yawRateCur = 0;
      }
      const sp = clamp(Math.abs(c.speed) / 3, 0, 1);
      const shaped = Math.sign(steer) * Math.pow(Math.abs(steer), tune.STEER_EXPO);
      const vs = vStd(Math.abs(c.speed)),
        raw = 1 / (1 + vs / tune.STEER_SPEED_REF),
        lockTaper = vs <= 15 ? 1.06 : vs >= 30 ? raw : 1.06 + ((raw - 1.06) * (vs - 15)) / 15;
      const driverDelta = shaped * tune.STEER_MAX_SLIP * lockTaper;
      const offAssistFade = Math.max(0, 1 - Math.max(0, Math.abs(c.x) - hw) / 3);
      const hFrenet = frenetH(c.s, c.x);
      // DRIVING-HELP assist (game.js:5946-5976): kPath arrives as assists.curvature (AssistInput).
      let assistDelta = 0;
      if (assists.roadFollow !== 0) {
        const brakeFade = 1 - 0.8 * clamp(-(c.axEstSm ?? 0) / BRAKE, 0, 1);
        const kPath = assists.curvature;
        let yawEase = 1;
        const rNeed = c.speed * kPath;
        if (rNeed !== 0) {
          const ratio = (c.yawRateCur || 0) / rNeed;
          if (ratio > 1) yawEase = clamp(1 - (ratio - 1) * 0.6, 0.3, 1);
        }
        assistDelta = -assists.roadFollow * (tune.WHEELBASE + ASSIST_KUS * c.speed * c.speed * brakeFade) * kPath * yawEase * offAssistFade;
      }
      // Racing-line assist (game.js:5979-5987): lineX arrives as assists.racingLineX.
      let lineDelta = 0;
      if (assists.raceLine !== 0) {
        const lineX = assists.racingLineX;
        const Ld = clamp(Math.abs(c.speed) * 1.2, 22, 70);
        lineDelta = ((assists.raceLine * LINE_PURSUIT * tune.WHEELBASE * 2 * (lineX - c.x)) / (Ld * Ld)) * offAssistFade;
      }
      const L = Math.max(2, tune.WHEELBASE);
      const ar = FRONT_WEIGHT * L,
        af = L - ar;
      const axEstTarget = braking
        ? c.speed > 0
          ? -brakeDecel
          : c.speed > REVERSE_MAX
            ? -REVERSE_ACCEL * surfaceMu
            : 0
        : onThrottle
          ? (ACCEL * tune.PACE * perfMul * ((mods.accel as number) * throttleLvl) * clamp(1 - c.speed / Math.max(vmax, 1), 0, 1) * gearMult + deploy) * surfaceMu
          : -COAST_DRAG * (1 - xCoastCut(c) * (c.aeroX || 0));
      c.axEstSm = damp(c.axEstSm ?? axEstTarget, axEstTarget, 10, dt);
      const wt = clamp((-c.axEstSm / LAT_MAX) * WT_LONG, -0.16, 0.18);
      const loadF = FRONT_WEIGHT + wt,
        loadR = 1 - FRONT_WEIGHT - wt;
      track.sample(wrapS(c.s + 12), smp2);
      const kv = ((smp2.t[1] || 0) - slopeSin) / 12;
      const vtRaw = clamp((kv * c.speed * c.speed) / 9.8, -0.2, 0.2);
      c.vertLoad = damp(c.vertLoad ?? vtRaw, vtRaw, 4, dt);
      const vertLoad = c.vertLoad;
      const pf = pfCtx;
      pf.dt = dt;
      pf.driverDelta = driverDelta;
      pf.assistDelta = assistDelta;
      pf.lineDelta = lineDelta;
      pf.onThrottle = onThrottle;
      pf.throttleLvl = throttleLvl;
      pf.gearMult = gearMult;
      pf.deploy = deploy;
      pf.braking = braking;
      pf.surfaceMu = surfaceMu;
      pf.kerbGrip = kerbGrip;
      pf.bankMu = bankMu;
      pf.modsCornering = mods.cornering as number;
      pf.modsBraking = mods.braking as number;
      pf.loadF = loadF;
      pf.loadR = loadR;
      pf.vertLoad = vertLoad;
      pf.af = af;
      pf.ar = ar;
      pf.sp = sp;
      pf.steer = steer;
      pf.weatherGrip = gmC;
      pf.aeroDf = aeroDfMult(c);
      pf.dirtyMul = dirtyAirMul(c.wake || 0, c.speed);
      pf.coastCut = xCoastCut(c);
      pf.vTopNow = vT;
      playerForces.step(c, pf);
      const latA = S.windLatA;
      if (latA) c.vLat += ((latA * vT) / VMAX) * dt;
      const fx2 = Math.sin(c.head),
        fz = Math.cos(c.head);
      const vWx = c.speed * fx2 - c.vLat * fz;
      const vWz = c.speed * fz + c.vLat * fx2;
      c.px += vWx * dt;
      c.pz += vWz * dt;
      let tX = smp.t[0],
        tZ = smp.t[2];
      const tL = Math.hypot(tX, tZ) || 1;
      tX /= tL;
      tZ /= tL;
      const tf = trackFrom(c.px, c.pz, c.s + ((vWx * tX + vWz * tZ) * dt) / hFrenet);
      c.s = tf.s;
      c.x = tf.x;
      steer = clamp(shaped, -1, 1);
    } else {
      const alongO = S.alongO;
      const alongDx = S.alongDx;
      const t = S.aiT as Traits;
      const toward = !alongO || Math.sign(steer) === Math.sign(alongDx);
      const give = AiDrive.contactGive((c.contactT || 0) > 0 && toward, t, !!track.street);
      const aiSurfMu = surfaceMu;
      const aiLat = S.unstuckActive ? Math.max(latFac, AiDrive.unstuckLatFloor(!!track.street)) : latFac;
      c.x += steer * STEER_VMAX * aiLat * gripScale * kerbGrip * bankMu * give * aiSurfMu * dt;
      if (S.windLatA) c.x += ((S.windLatA * vT) / VMAX) * WIND_AI_TAU * dt;
      // game.js:6091-6098 DebrisWorld.tyreMarble (cosmetic) for an AI car: the debris lane's.
    }
    if (c.human) {
      const slipAng = Math.abs(Math.atan2(c.vLat || 0, Math.max(4, Math.abs(c.speed))));
      c.skidIntensity = c.offroad ? 0.5 : Math.max(clamp((slipAng - 0.1) / 0.2, 0, 1), (c.wheelLock || 0) * 0.9);
    }
    S.steer = steer;
  }

  // ── updateCarAdvance (game.js:6110-6398) ───────────────────────────────────
  function advance(
    c: PlayerCar,
    dt: number,
    inp: PlayerInput | null,
    braking: boolean,
    raceT: number,
    roomL: number,
    roomR: number,
    unstuckActive: boolean,
    queued: boolean,
    aiT: Traits | null,
  ): void {
    const state = world.state;
    const pits = world.pits;
    const timing = world.timing;
    const vT = vTop();
    let oldS = c._prevS ?? c.s;
    const hAi = c.human ? 1 : frenetH(c.s, c.x);
    if (!c.human) c.s = wrapS(c.s + (c.speed * dt) / hAi);
    const L = track.length;
    let ds = c.s - oldS;
    if (ds > L / 2) ds -= L;
    else if (ds < -L / 2) ds += L;
    if (Math.abs(ds) > 20) {
      ds = c.speed * dt;
      oldS = wrapS(c.s - ds);
    }
    const dLine = ds;
    if (c.human) c.prog += ds - (c._pushD || 0);
    else c.prog += ds = (c.speed * dt) / hAi;
    c._pushD = 0;
    c.totalT += dt;
    c.lapTime += dt;
    const s3Past = dLine > 0 && oldS > L * 0.5 && c.s < L * 0.5 && dt > 0 ? dt * (1 - Math.min(1, Math.max(0, (L - oldS) / dLine))) : 0;
    const sectors = world.def.sectors;
    if (state === "race") {
      const ns = sectorAt(wrapS(c.s) / L, sectors);
      if (ns !== c._secIdx) {
        const fwd = ds > 0 && c._secIdx != null && (c._secIdx < ns || (c._secIdx === 2 && ns === 0));
        if (fwd && c._secValid !== false && c.lap >= 1 && !c.incidentInvalidLap && c._secT0 != null) {
          const e = c.lapTime - (ns === 0 ? s3Past : 0) - c._secT0;
          if (e >= 2 && e < (timing.fieldSectorBests[c._secIdx as 0 | 1 | 2] as number)) timing.fieldSectorBests[c._secIdx as 0 | 1 | 2] = e;
        }
        c._secValid = fwd || c._secIdx == null;
        c._secIdx = ns;
        c._secT0 = c.lapTime;
      }
    }
    if (c.isPlayer && state === "race") {
      const newSector = sectorAt(wrapS(c.s) / L, sectors);
      if (newSector !== timing.sectorIdx) {
        const fwd = ds > 0 && (timing.sectorIdx < newSector || (timing.sectorIdx === 2 && newSector === 0));
        if (fwd) {
          if (c.lap >= 1 && !c.incidentInvalidLap && timing.sectorValid) {
            const elapsed = c.lapTime - (newSector === 0 ? s3Past : 0) - timing.sectorStartT;
            const prevSector = timing.sectorIdx as 0 | 1 | 2;
            const prevBest = timing.sectorBests[prevSector];
            timing.sectorLast[prevSector] = elapsed;
            if (elapsed < prevBest) timing.sectorBests[prevSector] = elapsed;
          }
        }
        timing.sectorValid = fwd;
        timing.sectorIdx = newSector;
        timing.sectorStartT = c.lapTime;
      }
    }
    const lineCross = lineTransition(c, oldS, c.s, dLine, track.length, world.lapsTarget, raceT, dt, settle);
    if (lineCross && lineCross.direction > 0) {
      const lapValid = !c.incidentInvalidLap;
      lineCross.lapValid = lapValid && c.lap > 1 && !lineCross.recross;
      if (c.lap > 1 && !lineCross.recross) {
        const lapDone = lineCross.lapDone as number;
        if (lapValid) c.lastLap = lapDone;
        else if (c.isPlayer && isQuali()) c.qualiCut = true;
        if (lapValid && lapDone < c.best) c.best = lapDone;
      }
      c.incidentInvalidLap = false;
      c._secT0 = 0;
      if (c.isPlayer) {
        timing.sectorIdx = 0;
        timing.sectorStartT = 0;
      }
      if (world.onLine) world.onLine(c, lineCross);
    } else if (lineCross && lineCross.direction < 0) {
      if (lineCross.changed && c.isPlayer) {
        timing.sectorIdx = sectorAt(wrapS(c.s) / L, sectors);
        timing.sectorStartT = c.lapTime;
        timing.sectorValid = false;
      }
      if (world.onLine) world.onLine(c, lineCross);
    }

    if (c.human && state === "race" && !c.finished) {
      if (ds < -0.03 && vStd(c.speed) > 15) c.wrongT = Math.min(2, (c.wrongT || 0) + dt);
      else c.wrongT = Math.max(0, (c.wrongT || 0) - dt * 2);
      c.wrongWay = c.wrongWay ? c.wrongT > 0.15 : c.wrongT > 0.4;
      if (c.wrongWay && (c.wrongCueT = (c.wrongCueT || 0) - dt) <= 0) {
        if (c.local) announce("WRONG WAY", 1.0, "warning");
        c.wrongCueT = 1.0;
      }
      const autoGas = world.autoThrottle && (c.contactT || 0) === 0 && vStd(c.speed) < 3;
      const gasPressed = world.liveInput ? autoGas || !!(inp && inp.throttle) : !!(inp && inp.throttle);
      const stoppedOnTrack = gasPressed && c.speed < 3 && raceT > 2 && !(braking && ds < -0.01);
      const redHeld = world.raceCtl.level >= 4;
      const beached = beachedAt(c);
      const stuck = !(pits.inLane(c) || c.pitState === "box") && (beached || c.wrongWay || (c.speed < 4 && (c.wallT || 0) > 0) || stoppedOnTrack);
      const rescueGrace = c.rescueLastT != null && raceT < c.rescueLastT + 4;
      const redOnly = redHeld && stoppedOnTrack && !beached && !c.wrongWay && !((c.wallT || 0) > 0);
      if (stuck && !redOnly && !rescueGrace) c.rescueT = (c.rescueT || 0) + dt;
      else c.rescueT = Math.max(0, (c.rescueT || 0) - dt * 1.5);
      if (c.rescueT > 3) {
        rescuePlayer(c);
        c.rescueT = 0;
      }
    } else if (!c.human && state === "race" && !c.finished) {
      const t = aiT as Traits;
      c.digEscHeld = AiDrive.digOutHeld(c.digEscHeld, AiDrive.digOutEscalated(c.stuckT, t, !!track.street), unstuckActive);
      const digEsc = c.digEscHeld;
      const laneQueueOk = !(queued && pits.inLane(c)) || digEsc;
      const aiStuck = c.pitState !== "box" && (beachedAt(c) || (c.speed < 5 && raceT > 2 && (!unstuckActive || digEsc) && laneQueueOk));
      const aiRedHeld = world.raceCtl.level >= 4 && !beachedAt(c);
      if (c.pitState === "box") c.rescueT = 0;
      else if (aiStuck && !aiRedHeld) c.rescueT = (c.rescueT || 0) + dt;
      else c.rescueT = Math.max(0, (c.rescueT || 0) - dt * 1.5);
      if (c.rescueT > AiDrive.aiRescueDelay((c.contactT || 0) > 0, digEsc)) {
        track.sample(c.s, smp);
        if ((c.contactT || 0) > 0) c.x += (roomR >= roomL ? 1 : -1) * 1.2;
        if (pits.inLane(c)) {
          c.x = pits.laneX(c, smp.hw, c.x);
          c.speed = Math.min(pits.limit(), Math.max(c.speed, 8 * Math.max(tune.PACE, 0.05)));
        } else {
          c.x = clamp(c.x, -(smp.hw - 1.5), smp.hw - 1.5);
          c.speed = Math.min(vT, Math.max(c.speed, 14 * Math.max(tune.PACE, 0.05)));
        }
        c.rescueT = 0;
        c.offT = 0;
        c.stuckT = 0;
        c.contactT = 0;
        c.digEscHeld = false;
      }
    }
    if (!c.human) {
      const w = worldFromTrack(c.s, c.x, smp);
      c.px = w.x;
      c.pz = w.z;
    }
    c._prevS = c.s;
  }

  // ── rescuePlayer (game.js:6402-6425) ───────────────────────────────────────
  function rescuePlayer(c: PlayerCar): void {
    if (c.human && (isTimeTrial() || isQuali())) {
      c.incidentInvalidLap = true;
      if (c.isPlayer && isQuali()) c.qualiCut = true;
    }
    // game.js:6406 incidentSim.release(c): the incident sim hands the car back first. TODO(debris lane).
    track.sample(c.s, smp);
    c.x = 0;
    c.xVis = 0;
    c.head = Math.atan2(smp.t[0], smp.t[2]);
    c.vLat = 0;
    c.yawRateCur = 0;
    c.speed = Math.min(vTop(), Math.max(c.speed, 16 * Math.max(tune.PACE, 0.05)));
    c.px = smp.p[0];
    c.pz = smp.p[2];
    c.rPrevPx = c.px;
    c.rPrevPz = c.pz;
    c.rPrevS = c.s;
    c.rPrevX = c.x;
    c.rPrevHead = c.head;
    c.boostOn = false;
    c.deploying = false;
    c.xOn = false;
    c.aeroX = 0;
    c.xArmed = false;
    c.wrongT = 0;
    c.wrongWay = false;
    c.offT = 0;
    c.wallT = 0;
    c.wasOnWall = false;
    c.rescueT = 0;
    c.rescueLastT = world.raceT;
    if (c.local && world.soundOn && audio && audio.offtrack) audio.offtrack();
  }

  return { updateCar, rescuePlayer, pace, wrapS, worldFromTrack };
}

/** f1-game js/core/hash32.js:5-13 `Hash32.fnv1a` (DriverRatings.hash32). */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A solo human car: createCarStep plus the solo slice of update() (game.js:4341-4555). */
export function createPlayerStep(world: PlayerWorld): PlayerStep {
  const cs = createCarStep(world);
  const track = world.track;
  const incidents = world.fx?.incidents ?? NO_INCIDENTS;
  const _scratchW = newSample();
  let _player: PlayerCar | null = null;
  const collide = Collide.create(
    {
      wrapS: cs.wrapS,
      get track() {
        return track;
      },
      get player() {
        return _player;
      },
      netPlay: world.netPlay,
      get raceT() {
        return world.raceT;
      },
      get PACE() {
        return world.tune.PACE;
      },
      worldFromTrack: (s: number, x: number) => cs.worldFromTrack(s, x, _scratchW),
    },
    () => {},
    () => false,
    { incidents, debris: world.fx?.debris ?? null },
  );
  const _ranked: PlayerCar[] = [];
  function step(c: PlayerCar, dt: number, input: PlayerInput, assists?: AssistInput): void {
    if (world.state !== "race") return;
    world.raceT += dt;
    _player = c;
    _ranked.length = 0;
    if (!c.retired) _ranked.push(c);
    for (const o of _ranked) {
      o._snapProg = o.prog;
      o._snapX = o.x;
      o._snapSpeed = o.speed;
    }
    if (_ranked.length) Collide.fillArcBuckets(_ranked, track.length, TOW_RANGE, (o) => o._snapProg as number);
    cs.updateCar(c, dt, _ranked, input, assists);
    collide.resolveCollisions(_ranked, dt);
  }
  return {
    updateCar: (c, dt, input, assists) => cs.updateCar(c, dt, _ranked, input, assists),
    step,
    rescuePlayer: cs.rescuePlayer,
    pace: cs.pace,
  };
}
