/**
 * The player step: one fixed physics tick of a HUMAN car.
 *
 * Port of f1-game js/game.js `updateCar` (:4690-5168) and its parts, player
 * path only, in f1-game's order: updateCar → updateCarBrakePlan (:5171) →
 * updateCarLongitudinal (:5368) → updateCarLateral (:5563) →
 * updateCarBicycle (:5904) → WallClamp.apply → updateCarAdvance (:6110),
 * plus rescuePlayer (:6402) and the solo slice of `update()` (:4341) that
 * wraps it (raceT, the traffic snapshot, resolveCollisions). Statements are
 * verbatim in float operation order; the AI branches are not here (src/sim/ai/).
 *
 * f1-game's globals become the typed `PlayerWorld`: the track (a
 * `PhysicsTrack`), the live tunables, and seams for the subsystems other lanes
 * own (pit lane, race control, wind, weather, aero zones, timing) whose
 * defaults are f1-game's values in the pinned world (wear/wind/cautions off,
 * dry, no pit stop). Presentation (announce, audio, haptics, camera shake,
 * the coach/engineer/recorders, display-only damage) is optional fx.
 *
 * THE ARC MUST NOT REACH THE DRIVER (AGENTS.md). f1-game reads
 * `Tracks.curvature` for every car (game.js:4730) and caches it on `c.kCur`;
 * the player path here reads no curvature at all. The two places f1-game's
 * player path uses it, the DRIVING-HELP road-follow assist and the
 * racing-line assist (game.js:5960-5990), take their arc values from the
 * separate `AssistInput` and are skipped outright when their gain is 0, which
 * is bit-identical to f1-game with the assists off (ROAD_FOLLOW 0 yields
 * assistDelta ±0, which PlayerForces folds to 0).
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
import type { Tyres } from "../physics/tyre-model";
import * as WallClamp from "../physics/wall-clamp";
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
} = PhysicsConsts;

/** game.js:661 — fraction of BRAKE a car above the caution delta pace sheds at. */
const CAUTION_BRAKE = 0.5;
const _towWin = { range: TOW_RANGE, fade: TOW_FADE, halfW: TOW_HALF_W };

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

/** Every car field the player step reads or writes, beyond PhysCar. */
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
  pitState?: string | null | undefined;
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
}

/** f1-game js/race/pit-lane.js (PitLane.create): the calls the player path makes. */
export interface PitSeam {
  update(c: PlayerCar, dt: number): void;
  inLane(c: PlayerCar): boolean;
  held(c: PlayerCar): boolean;
  limit(): number;
}
/** Tyre wear off closes the pit feature (pit-lane.js:1198): nothing is ever in the lane. */
export const NO_PITS: PitSeam = { update: () => {}, inLane: (c) => c.pitState === "lane" || c.pitState === "box", held: () => false, limit: () => Infinity };

/** f1-game js/race/race-control.js: the reads the player path makes. */
export interface RaceCtlSeam {
  /** 0 green … 2 VSC, 3 SC, 4 red. */
  readonly level: number;
  otDetectOpen(): boolean;
  otEnabled(): boolean;
  lowGrip(): boolean;
  /** At level 3, RaceControl.scQueueFrac(c, …) (game.js:4776); the SC queue rule needs the field. */
  scQueueFrac(c: PlayerCar): number;
}
export const GREEN_FLAG: RaceCtlSeam = { level: 0, otDetectOpen: () => true, otEnabled: () => false, lowGrip: () => false, scQueueFrac: () => 0.6 };

/** f1-game js/race/wind.js: `Wind.carInto(Wind.sync(…), heading, vStd)` (game.js:4751) then `Wind.latA()` (:6062). */
export interface WindSeam {
  carInto(heading: number, vStd: number): Readonly<{ vmaxMul: number; latA: number }>;
}
const _calm = Object.freeze({ vmaxMul: 1, latA: 0 });
export const CALM: WindSeam = { carInto: () => _calm };

/** f1-game game.js:638-639 (`trackWetness`, `gripMult`) and the weather arc's local wetness. */
export interface WeatherSeam {
  readonly raceWeather: string;
  trackWetness(): number;
  /** Wetness under the car (a local shower); absent without a weather arc. */
  wetnessAt?: (s: number) => number;
}
export const DRY: WeatherSeam = { raceWeather: "dry", trackWetness: () => 0 };

export interface PlayerStepFx {
  readonly audio?: (AudioFx & { shift?(up: boolean): void; offtrack?(): void; penalty?(): void; rumble?(): void; xMode?(open: boolean): void; deployBoost?(): void; overtakeReady?(): void }) | null;
  readonly haptics?: HapticsFx | null;
  readonly debris?: DebrisFx | null;
  readonly incidents?: IncidentFx | null;
  /** Camera trauma: f1-game `feel.shake` (raised, never read by physics). */
  readonly shake?: ((add: number, floor: number) => void) | null;
  readonly announce?: ((msg: string, dur: number, kind: string) => void) | null;
}

/** What the player step reads off the world each tick (f1-game's `G` members, made explicit). */
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
}

/** The step's pooled locals (f1-game `_ucS`, game.js:4688). */
interface Scratch {
  hw: number;
  slopeSin: number;
  slopeNose: number;
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
  kerbGrip: number;
  bankMu: number;
  windLatA: number;
}

export interface PlayerStep {
  /** game.js updateCar for one human car (the car must be `human`). */
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

export function createPlayerStep(world: PlayerWorld): PlayerStep {
  const track = world.track;
  const tune = world.tune;
  const fx = world.fx ?? {};
  const audio = fx.audio ?? null;
  const haptics = fx.haptics ?? null;
  const incidents = fx.incidents ?? NO_INCIDENTS;
  const settle = world.settleLine ?? settleSolo;
  const frenet = createFrenet(track);
  const wrapS = frenet.wrapS;
  const frenetH = frenet.frenetH;
  const trackFrom = frenet.trackFrom;
  const worldFromTrack = frenet.worldFromTrack;
  const pace = PaceMathMod.create({ getPACE: () => tune.PACE, lowGrip: () => world.raceCtl.lowGrip() });
  const { vTop, vStd, xVmaxGain, xCoastCut, drainFor, regenFor, otTimeFor, aeroDfMult, gearHi, rpmFor } = pace;
  const playerForces = PlayerForces.create(tune, { gripSteer: world.gripSteer ?? null, haptics, debris: fx.debris ?? null });
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
    kerbGrip: 0,
    bankMu: 0,
    windLatA: 0,
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
    debris: fx.debris ?? null,
    audio,
    haptics,
    teamIds: world.teamIds ?? [],
  };
  const NEUTRAL_MODS = Object.freeze({ speed: 1, accel: 1, cornering: 1, braking: 1 });

  const damp = (c: number, t: number, l: number, dt: number): number => lerp(c, t, 1 - Math.exp(-l * dt));
  // game.js:638-639
  function trackWetness(): number {
    return world.weather.trackWetness();
  }
  function gripMult(c?: PlayerCar): number {
    const wx = world.weather;
    return weatherGrip(
      c ? (c.tread == null ? treadFor(wx.raceWeather, trackWetness()) : c.tread) : 0,
      c && wx.wetnessAt ? wx.wetnessAt(c.s) : trackWetness(),
    );
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
  const isTimeTrial = (): boolean => world.session === "tt";
  const isQuali = (): boolean => world.session === "quali";
  const shake = (add: number, floor: number): void => {
    if (fx.shake) fx.shake(add, floor);
  };
  const announce = (msg: string, dur: number, kind: string): void => {
    if (fx.announce) fx.announce(msg, dur, kind);
  };

  // ── updateCar (game.js:4690-5168), human path ──────────────────────────────
  function updateCar(c: PlayerCar, dt: number, inp: PlayerInput, assists: AssistInput = NO_ASSISTS): void {
    if (!c.human) throw new Error("player-step: updateCar takes a human car (the AI step is src/sim/ai/)");
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
      // TODO(lane-race): coast(c, dt) (game.js:6496) — the finished-car coast belongs with the race rules port.
      pits.update(c, dt);
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
    track.sample(c.s, smp);
    const hw = smp.hw;
    const slopeSin = smp.t[1] || 0;
    const slopeNose = c.human && Math.cos(Math.atan2(smp.t[0], smp.t[2]) - (c.head || 0)) < 0 ? -slopeSin : slopeSin;
    // game.js:4730-4731 read Tracks.curvature here for c.kCur (render lean). Not on the player path (the arc rule).
    const mods = c.mods || NEUTRAL_MODS;
    tyres.update(c, dt);
    pits.update(c, dt);
    const aq = aquaInto(c, vStd(Math.abs(c.speed)), world.weather.raceWeather, world.weather.wetnessAt ? world.weather.wetnessAt(c.s) : trackWetness());
    const vT = vTop(),
      trMul = tyres.tractionMul(c),
      gmC = gripMult(c) * aq.mul,
      gm0 = gripMult();
    const perfMul = trMul * tyres.fuelAccelMul(c);

    // --- speed targets ---
    let vmax = VMAX * tune.PACE * (mods.speed as number);
    const windCar = world.wind.carInto(c.head || 0, vStd(Math.abs(c.speed)));
    vmax *= windCar.vmaxMul;
    // Wind.latA() (game.js:6062) is the side force THIS call computed, read later in the bicycle step.
    S.windLatA = windCar.latA;
    c._bandNow = 0;
    let pitV = -1;
    if (pits.inLane(c)) {
      pitV = pits.limit();
      vmax = Math.min(vmax, pitV);
    }
    let cautionV = -1;
    {
      const lvl = raceCtl.level;
      if (lvl >= 2) cautionV = vmax = Math.min(vmax, vTop() * (lvl >= 4 ? 0.02 : lvl === 3 ? raceCtl.scQueueFrac(c) : 0.6));
    }
    vmax *= trMul;
    vmax *= tyres.fuelVmaxMul(c);

    // --- electric deploy ---
    let deploy = 0;
    const boostToggle = c.isPlayer && inp.boost;
    if (boostToggle) c.boostOn = !c.boostOn;
    const pitHeld = pits.held(c);
    const ersHeld = pitHeld || cautionV >= 0 || c.pitState === "box";
    const wantBoost = c.boostOn && !ersHeld;
    let otFree = false;

    // --- overtake mode ---
    const otSpeed = Math.max(0, c.speed);
    let gapAhead = Infinity;
    const otL = track.length,
      otW = OT_GAP * otSpeed + 1;
    if (c._otLap == null || c._otS == null) {
      c._otLap = c.lap | 0;
      c._otS = c.s;
    }
    const otOpen = raceCtl.otDetectOpen();
    const otNeedAhead = (c.otE as number) > 0 || c.otOn || (otOpen && OvertakeMode.crossed(c._otS, c.s, otDetectAt, otL));
    let ahead: PhysCar | null = null;
    if (otNeedAhead) {
      const ot = Collide.scanOtAhead(c, otL, otW, (o) => pits.inLane(o as PlayerCar));
      ahead = ot.ahead;
      gapAhead = ot.gapAhead;
    }
    gapAhead = ahead && c.speed > 1 ? gapAhead / c.speed : Infinity;
    OvertakeMode.lines(c, otTrack, gapAhead, otOpen && !pitHeld, otDetectAt);
    const otGate = raceCtl.otEnabled() && !c.finished && !pitHeld,
      otFast = vStd(c.speed) > OT_MIN_SPEED;
    OvertakeMode.arm(c, otGate, otFast);
    const fire = !!inp.overtake;
    if (OvertakeMode.prepare(c, fire, otGate, otFast, otTimeFor(c)) && c.isPlayer && world.soundOn && audio && audio.deployBoost) audio.deployBoost();
    otFree = (c.otT as number) > 0;
    if (otFree || (wantBoost && c.energy > 0)) deploy = DEPLOY_A * Math.max(tune.PACE, 0.05) * deployTaper(c);
    if (c.isPlayer && c.otArmed && !c.wasArmed && world.soundOn && audio && audio.overtakeReady) audio.overtakeReady();
    c.wasArmed = c.otArmed;

    // --- braking / target speed (updateCarBrakePlan, human) ---
    S.vmax = vmax;
    brakePlan(c, inp);
    vmax = S.vmax;
    const braking = S.braking,
      brakeLvl = S.brakeLvl,
      throttleLvl = S.throttleLvl;

    // --- active aero ---
    c.xArmed = !c.offroad && !braking && vStd(c.speed) > X_MIN_SPEED && !c.finished && !pitHeld && state === "race" && world.aeroZoneAt(wrapS(c.s));
    if (world.aeroMode === "auto") {
      c.xOn = c.xArmed;
    } else {
      if (c.local) {
        if (inp.aeroToggle) c.xOn = !c.xOn;
      } else c.xOn = !!inp.aero;
    }
    {
      const want = c.xOn && c.xArmed ? 1 : 0;
      if (c.local && world.soundOn && want !== (c._xSndWant ?? 0)) {
        if (audio && audio.xMode) audio.xMode(want === 1);
        c._xSndWant = want;
      }
      const rate = want > (c.aeroX || 0) ? X_OPEN_RATE : X_CLOSE_RATE;
      c.aeroX = clamp(
        (c.aeroX || 0) + Math.sign(want - (c.aeroX || 0)) * rate * dt,
        Math.min(c.aeroX || 0, want),
        Math.max(c.aeroX || 0, want),
      );
      if (!c.xArmed) c.xOn = false;
    }
    vmax *= 1 + xVmaxGain(c) * c.aeroX;
    c._vmaxNow = vmax;
    // game.js:5077 AiDrive.paceSample learns the per-node pace profile from every car, the player
    // included (it writes the human's paceF for the AI's judgement). TODO(lane-physics AI port).

    // --- gearbox (player) ---
    let gearMult = 1,
      accelCeil = vmax + 14 * Math.max(tune.PACE, 0.05);
    {
      c.shiftT = Math.max(0, c.shiftT - dt);
      const up = !!inp.shiftUp,
        down = !!inp.shiftDown;
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
    longitudinal(c, dt, inp, mods);
    deploy = S.deploy;

    // --- lateral ---
    lateral(c, inp);
    // --- bicycle ---
    S.vT = vT;
    S.gmC = gmC;
    S.vmax = vmax;
    S.deploy = deploy;
    bicycle(c, dt, mods, assists);
    const steer = S.steer;
    wallCtx.dt = dt;
    wallCtx.steer = steer;
    wallCtx.soundOn = world.soundOn;
    WallClamp.apply(c, wallCtx);
    // game.js:5124 Damage.observe: display-only, nothing reads it back.
    c.brakeDemand = braking ? brakeLvl : 0;
    c.throttleDemand = S.onThrottle && !braking ? throttleLvl : 0;
    c.steerCommand = steer;
    c.steerVis = damp(c.steerVis as number, steer, 10, dt);
    if (c.head != null) {
      let psi = Math.atan2(smp.t[0], smp.t[2]) - c.head;
      while (psi > Math.PI) psi -= 2 * Math.PI;
      while (psi < -Math.PI) psi += 2 * Math.PI;
      c.yawVis = psi;
    }
    {
      const heating = braking && vStd(c.speed) > 12;
      c.brakeHeat = clamp((c.brakeHeat || 0) + (heating ? dt * 1.6 : -dt * 0.9), 0, 1);
    }
    {
      const thr = S.onThrottle;
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
    advance(c, dt, inp, braking, raceT);
  }

  // ── updateCarBrakePlan (game.js:5171-5367), human ──────────────────────────
  function brakePlan(c: PlayerCar, inp: PlayerInput): void {
    let vmax = S.vmax;
    const braking = !!inp.brake;
    const brakeLvl = inp.brakeLevel ?? 1;
    const throttleLvl = world.liveInput && world.autoThrottle ? 1 : (inp.throttleLevel ?? 1);
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
    S.vmax = vmax;
    S.braking = braking;
    S.brakeLvl = brakeLvl;
    S.throttleLvl = throttleLvl;
  }

  // ── updateCarLongitudinal (game.js:5368-5561), human ───────────────────────
  function longitudinal(c: PlayerCar, dt: number, inp: PlayerInput, mods: NonNullable<PlayerCar["mods"]>): void {
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
    const roadBrake = BRAKE * trMul * (mods.braking as number) * (gmC / gm0);
    const grassDrag = Math.min((1 - surfaceMu) * 24, roadBrake * 0.75);
    const surfaceBrake = c.offroad ? Math.min(roadBrake * surfaceMu, Math.max(0, roadBrake * 0.95 - grassDrag)) : roadBrake;
    const brakeDecel = world.liveInput ? Math.max(surfaceBrake * brakeLvl, COAST_DRAG) : surfaceBrake * brakeLvl;
    const longitudinalSpeed = c.speed;

    const wallPinned = (c.wallT || 0) > 0;
    const onThrottle = world.liveInput ? (world.autoThrottle && !wallPinned) || !!inp.throttle : !!inp.throttle;
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
      } else if (state === "race") {
        c.speed = Math.max(REVERSE_MAX, c.speed - REVERSE_ACCEL * surfaceMu * dt);
      }
      c.energy = Math.min(1, c.energy + regenFor(c) * 1.6 * regenSpeedK(c) * dt);
    } else if (!onThrottle) {
      const cd = COAST_DRAG * (1 - xCoastCut(c) * (c.aeroX || 0));
      if (c.speed > 0) c.speed = Math.max(0, c.speed - cd * dt);
      else if (c.speed < 0) c.speed = Math.min(0, c.speed + cd * dt);
      c.energy = Math.min(1, c.energy + regenFor(c) * regenSpeedK(c) * dt);
    } else {
      const a =
        (ACCEL * tune.PACE * perfMul * ((mods.accel as number) * throttleLvl) * clamp(1 - c.speed / Math.max(vmax, 1), 0, 1) * gearMult + deploy) *
        surfaceMu *
        (state === "race" ? 1 : 0);
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
    if (!world.gearsManual) {
      const ng = naturalGear(gearSpeed);
      if (ng !== c.gear && state === "race" && world.soundOn && c.local && audio && audio.shift) audio.shift(ng > c.gear);
      c.gear = ng;
    }
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

  // ── updateCarLateral (game.js:5563-5902), human ────────────────────────────
  function lateral(c: PlayerCar, inp: PlayerInput): void {
    const steer = inp.steer ?? 0;
    // latFac and gripScale (game.js:5888-5889) feed only the AI's kinematic step.
    const kerbGrip = c.kerbGripSm ?? 1;
    const bankPhys = track.banking(c.s, 0, bankScratch);
    const bankRoll = bankPhys ? Math.abs(bankPhys.roll) : 0;
    const bankMu = 1 + Math.sin(bankRoll) * 0.8;
    S.steer = steer;
    S.kerbGrip = kerbGrip;
    S.bankMu = bankMu;
  }

  // ── updateCarBicycle (game.js:5904-6108), human ────────────────────────────
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
    const kerbGrip = S.kerbGrip;
    const bankMu = S.bankMu;
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
    const fx = Math.sin(c.head),
      fz = Math.cos(c.head);
    const vWx = c.speed * fx - c.vLat * fz;
    const vWz = c.speed * fz + c.vLat * fx;
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
    const slipAng = Math.abs(Math.atan2(c.vLat || 0, Math.max(4, Math.abs(c.speed))));
    c.skidIntensity = c.offroad ? 0.5 : Math.max(clamp((slipAng - 0.1) / 0.2, 0, 1), (c.wheelLock || 0) * 0.9);
    S.steer = steer;
  }

  // ── updateCarAdvance (game.js:6110-6398), human ────────────────────────────
  function advance(c: PlayerCar, dt: number, inp: PlayerInput, braking: boolean, raceT: number): void {
    const state = world.state;
    const pits = world.pits;
    const timing = world.timing;
    let oldS = c._prevS ?? c.s;
    const L = track.length;
    let ds = c.s - oldS;
    if (ds > L / 2) ds -= L;
    else if (ds < -L / 2) ds += L;
    if (Math.abs(ds) > 20) {
      ds = c.speed * dt;
      oldS = wrapS(c.s - ds);
    }
    const dLine = ds;
    c.prog += ds - (c._pushD || 0);
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

    // --- wrong-way + auto-rescue (player only) ---
    if (state === "race" && !c.finished) {
      if (ds < -0.03 && vStd(c.speed) > 15) c.wrongT = Math.min(2, (c.wrongT || 0) + dt);
      else c.wrongT = Math.max(0, (c.wrongT || 0) - dt * 2);
      c.wrongWay = c.wrongWay ? c.wrongT > 0.15 : c.wrongT > 0.4;
      if (c.wrongWay && (c.wrongCueT = (c.wrongCueT || 0) - dt) <= 0) {
        if (c.local) announce("WRONG WAY", 1.0, "warning");
        c.wrongCueT = 1.0;
      }
      const autoGas = world.autoThrottle && (c.contactT || 0) === 0 && vStd(c.speed) < 3;
      const gasPressed = world.liveInput ? autoGas || !!inp.throttle : !!inp.throttle;
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

  // ── the solo slice of update() (game.js:4341-4555) ─────────────────────────
  const _scratchW = newSample();
  const collide = Collide.create(
    {
      wrapS,
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
        return tune.PACE;
      },
      worldFromTrack: (s: number, x: number) => worldFromTrack(s, x, _scratchW),
    },
    () => {},
    () => false,
    { incidents, debris: fx.debris ?? null },
  );
  let _player: PlayerCar | null = null;
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
    updateCar(c, dt, input, assists);
    collide.resolveCollisions(_ranked, dt);
  }

  return { updateCar, step, rescuePlayer, pace };
}
