/**
 * Simulation seams: what the player physics reads (input, context, car state).
 *
 * Source of truth for every member: f1-game at the revision this repo was
 * forked against. Each block cites the file:line it was derived from.
 */
import type { TrackQuery } from "./track";

// ─── The arc rule ──────────────────────────────────────────────────────────

/**
 * Keys that carry track curvature or the racing line. None of them may appear
 * on `PlayerInput`: f1-game AGENTS.md:128 (§Physics), "The arc must not reach the
 * driver: nothing derived from track curvature or the racing line may affect
 * the player with assists off", audited per consumer in f1-game
 * docs/PHYSICS.md:1127 ("Curvature channels — the 'arc must not reach the
 * driver' table"). tests/unit/contracts.test.ts asserts the disjointness.
 */
export type ArcKey =
  | "curvature"
  | "kPath"
  | "kCur"
  | "kTurn"
  | "racingLine"
  | "racingLineX"
  | "lineX";

/** `T` with every `ArcKey` forbidden. Use it on any function that feeds the player step. */
export type ArcFree<T> = T & { readonly [K in ArcKey]?: never };

/**
 * One physics step of driver controls for a human car.
 *
 * Fields: f1-game js/car/input-ghost.js:74-87 (`packFlags`, the InputGhost v3
 * record) and :89-99 (`decodeStep`), which is the same shape as the
 * `_testInput` / `netInput` objects `inputOf(c)` returns at js/game.js:1014.
 * Readers in `updateCar`: steer :5787, brake/brakeLevel :5406-5408,
 * throttleLevel :5412, shiftUp/shiftDown :5282-5283, aero :5236,
 * overtake :5187; boost is the toggle edge recorded at :5118-5120.
 *
 * Differences from f1-game, on purpose: every field is required (f1-game
 * defaults a missing `throttleLevel`/`brakeLevel` to 1 with `??`), and the
 * edge-triggered controls (shiftUp, shiftDown, aeroToggle, overtake, boost)
 * are true for exactly one step, which is what `Input.consume*()` gives the
 * local car.
 *
 * THE ARC MUST NOT REACH THE DRIVER. This type has NO curvature or racing-line
 * field, and never may (f1-game AGENTS.md §Physics; docs/PHYSICS.md:1127).
 * Steering help that reads the arc is `AssistInput`, a separate opt-in input.
 */
export interface PlayerInput {
  /** Steering command, -1..1, same sign convention as f1-game `Input.steer()`. */
  readonly steer: number;
  /** Throttle pressed (InputGhost flag bit 0). */
  readonly throttle: boolean;
  /** Brake pressed (flag bit 1). */
  readonly brake: boolean;
  /** Analog throttle travel 0..1 (InputGhost v2+ quantised to /255). */
  readonly throttleLevel: number;
  /** Analog brake travel 0..1 (InputGhost v2+ quantised to /255). */
  readonly brakeLevel: number;
  /** Upshift edge (flag bit 5). */
  readonly shiftUp: boolean;
  /** Downshift edge (flag bit 6). */
  readonly shiftDown: boolean;
  /** Active-aero (X-mode) held, for a non-local human car (flag bit 2; game.js:5236). */
  readonly aero: boolean;
  /** Active-aero toggle edge, for the local car (flag bit 7; game.js:5235). */
  readonly aeroToggle: boolean;
  /** Overtake-mode fire edge (flag bit 3; game.js:5187). */
  readonly overtake: boolean;
  /** ERS boost toggle edge (flag bit 4; game.js:5118-5120 flips `c.boostOn`). */
  readonly boost: boolean;
}

/**
 * Opt-in driving assists. This is the ONLY place a curvature or racing-line
 * value may enter the player step, and each one is multiplied by a gain that
 * ships at 0 (f1-game docs/PHYSICS.md:1127 table, rows "updateCar k/c.kCur
 * cache" and "RACING LINE assist": both **assist-gated**).
 *
 * Fields: js/game.js:6190-6208. `roadFollow` is `ROAD_FOLLOW` (let, def 0,
 * game.js:433) and `raceLine` is `raceLineAssist` (def 0, game.js:986).
 * The player step must compute nothing from `curvature` or `racingLineX` when
 * its gain is 0.
 */
export interface AssistInput {
  /** ROAD_FOLLOW gain; 0 = off (the default). game.js:6198. */
  readonly roadFollow: number;
  /**
   * Curvature of the car's own path at its lateral offset, 1/m (+ = left
   * turn): f1-game `kPath = k / frenetH(s, x)`, game.js:6190-6191.
   */
  readonly curvature: number;
  /** Racing-line assist strength; 0 = off (the default). game.js:6202. */
  readonly raceLine: number;
  /**
   * Racing-line lateral target, metres (+ right), already clamped to the road
   * edge: f1-game `lineX = clamp(ln.x * ln.w, -edge, edge)`, game.js:6203-6206.
   */
  readonly racingLineX: number;
}

// ─── Context the physics modules read ──────────────────────────────────────

/** TYRE WEAR level. f1-game js/physics/tyre-model.js:49 `LEVELS = { off, light, real }`. */
export type TyreWearLevel = "off" | "light" | "real";

/** Race weather. f1-game js/game.js:929. */
export type Weather = "dry" | "wet" | "rain" | "overcast" | "fog";

/** Session kind. f1-game js/game.js:856. */
export type SessionMode = "race" | "tt" | "quali";

/** The live weather arc. f1-game types/game-ctx.d.ts:200 `WeatherArc`. */
export interface WeatherArc {
  readonly from: string;
  readonly to: string;
  readonly t: number;
  readonly dur: number;
  /** TODO(T1.5): type when the tyre-model port reads it (f1-game types it Opaque). */
  readonly seq: unknown;
  readonly cell?: {
    readonly c0: number;
    readonly h: number;
    readonly v: number;
    readonly life: number;
    readonly total: number;
  } | null;
  readonly sectors?: ReadonlyArray<{ readonly sector: number; readonly wet: number; readonly raining: boolean }> | null;
  readonly where?: readonly number[] | null;
}

/**
 * The circuit fields the physics reads off `G.track.def`. Structural on
 * purpose: `CircuitDef` belongs to src/circuits/types.ts (T1.1) and is
 * assignable to this. tyre-model.js:861-862 reads `def.tyreSeverity`;
 * aero-zones.js:206 logs `def.id`.
 */
export interface SimTrackDef {
  readonly id: string;
  readonly tyreSeverity?: number;
}

/**
 * `G.track` as the physics modules see it: the query surface plus the two
 * plain fields they read. collide.js:299/447/743 read `track.street`
 * (tracks.js:157 `street: !!def.street`); tyre-model.js:778/879 read
 * `track.total` (here `length`).
 */
export interface SimTrack extends TrackQuery {
  readonly street: boolean;
  readonly def: SimTrackDef;
}

/** Remote-car ownership in a friend race. collide.js:299-451 calls only `owns(c)`. */
export interface NetPlayOwnership {
  readonly owns: (c: CarState) => boolean;
}

/**
 * Every `G.` member read by the f1-game physics modules Phase 1 ports
 * (PLAN T1.5), from `grep -ohE '\bG\.[A-Za-z_]+' js/physics/<file>.js`:
 *
 * - player-forces.js:81-85: PLAYER_GRIP, FRONT_GRIP, DRIFT, YAW_INERTIA,
 *   YAW_DAMP. (`G.vTop` appears only in the comment at :102; the value
 *   arrives as `ctx.vTopNow`, :69.)
 * - collide.js:268 wrapS, :622 PACE, :718 track/player/netPlay,
 *   :723-724 raceT, :802/:817 worldFromTrack.
 * - tyre-model.js:731 raceTyreWear, :778/:878 track, :832/:881 weatherArc +
 *   raceWeather, :881 aTop, :882 LAT_MAX, :893 vTop, :908/:954 lapsTarget,
 *   :953 session.
 * - aero-zones.js:205/:216/:228 track.
 * - consts, grip-steer, wall-clamp, wall-end-face: no `G` reads (explicit
 *   ctx bags; wall-clamp.js:8).
 *
 * 20 distinct members. Not included (not Phase 1 modules): brake-cue.js
 * (paused, soundOn, state, store), body-attitude.js (cars), debris-world.js
 * (cars, gfx, store), incident-sim.js (cars, onIncidentLineCross,
 * rescuePlayer, sectorIdx, sectorStartT, smp, trackFrom). The physics writes
 * none of these (no `G.x =` in js/physics/), so every member is readonly.
 * Types follow f1-game types/game-ctx.d.ts:369-811.
 */
export interface SimCtx {
  // player-forces tunables (game.js `let`s, live-tunable from the pause sliders)
  readonly DRIFT: number;
  readonly FRONT_GRIP: number;
  readonly PLAYER_GRIP: number;
  readonly YAW_DAMP: number;
  readonly YAW_INERTIA: number;

  /** Ground-speed scale, not a cap (f1-game AGENTS.md §Physics). collide.js:622. */
  readonly PACE: number;
  /** Lateral-g ceiling used by the human tyre-load model. tyre-model.js:882. */
  readonly LAT_MAX: number;
  /** Pace-scaled top speed, m/s. Compare speeds through this, never raw. */
  readonly vTop: () => number;
  /** Pace-scaled standard acceleration. tyre-model.js:881. */
  readonly aTop: () => number;

  readonly track: SimTrack | null;
  readonly player: CarState | null;
  readonly netPlay: NetPlayOwnership;
  /** Race clock, seconds. collide.js:723. */
  readonly raceT: number;
  readonly lapsTarget: number;
  readonly session: SessionMode;
  readonly raceTyreWear: TyreWearLevel;
  readonly raceWeather: Weather;
  readonly weatherArc: WeatherArc | null;

  /** `s` wrapped into [0, track length). game.js:1266. */
  readonly wrapS: (s: number) => number;
  /**
   * World XZ of track coords (`s`, `x`). Returns a POOLED object that the next
   * call overwrites (game.js:526-533 writes `_wf`): copy what you keep.
   */
  readonly worldFromTrack: (s: number, x: number) => Readonly<{ x: number; z: number }>;
}

// ─── Car state ─────────────────────────────────────────────────────────────

/**
 * The player-relevant subset of an f1-game car object.
 *
 * Full field count in f1-game: `makeCars()` spawns ~176 own fields
 * (js/race/car-fields.js:3; the object literal at js/game.js:1706-1803 plus
 * spread helpers), and `CarFields.predeclare` adds 79 more as `undefined`
 * (js/race/car-fields.js GROUPS, counted from `CarFields.KEYS`): about 255.
 * This is the Phase 1 subset the player step and the physics oracle (PLAN
 * T1.4) touch; later waves add fields here, in their own contracts PR.
 *
 * Fields predeclared `undefined` in f1-game stay `| undefined` here: readers
 * are behaviour-bearing on it (game.js:6079 seeds `steerSm` from the first
 * input only while it is `undefined`).
 */
export interface CarState {
  // role (game.js setCarRole; types/game-ctx.d.ts:103-105)
  human: boolean;
  local: boolean;
  isPlayer: boolean;

  // track frame
  /** Arc position, metres. */
  s: number;
  /** Lateral offset from the centreline, metres, + right. */
  x: number;
  /** Cumulative race progress, metres. */
  prog: number;
  lap: number;

  // world pose and the bicycle model (game.js:5311-5312)
  px: number;
  pz: number;
  /** World heading, radians. */
  head: number;
  /** Longitudinal speed, m/s. */
  speed: number;
  /** Body lateral velocity, m/s. */
  vLat: number;
  /** Yaw rate, rad/s. */
  yawRateCur: number;

  // driver state
  /** Smoothed steer; `undefined` until the first step seeds it (car-fields.js GROUPS). */
  steerSm: number | undefined;
  /** Kerb grip smoother, 1 = full grip (game.js:5763, reset at :1918). */
  kerbGripSm: number;

  /** Brake applied this step; replicated as the netplay F_BRAKE snapshot bit (f1-game js/net/netplay.js:80, applied to remote cars at :454). */
  braking: boolean;

  // drivetrain (game.js:1790)
  gear: number;
  rpm: number;
  /** Seconds left in the current shift. */
  shiftT: number;

  // energy and aero (game.js:1791-1794)
  /** ERS store, 0..1. */
  energy: number;
  boostOn: boolean;
  deploying: boolean;
  /** Active-aero commanded mode. Physics reads `aeroX`, never `xOn`. */
  xOn: boolean;
  /** Active-aero flap blend 0..1. */
  aeroX: number;

  // surface flags (game.js:5590-5592)
  onKerb: boolean | undefined;
  inPitLane: boolean | undefined;
  offroad: boolean;

  // player force model readouts (player-forces.js; car-fields.js GROUPS)
  slipFront: number | undefined;
  slipRear: number | undefined;
  steerAngle: number | undefined;
  lateralAccel: number | undefined;

  // timing and status (game.js:1795-1801)
  lapTime: number;
  best: number;
  tyreWear: number;
  retired: boolean;
  finished: boolean;
}
