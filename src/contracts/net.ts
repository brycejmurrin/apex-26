/**
 * Multiplayer seam: what NetPlay (src/net/netplay.ts) reads and writes on the
 * game, replacing the `G` façade f1-game hands `NetPlay.create(G)`
 * (js/net/netplay.js:259). Every member below is a `G.` read or write found by
 * `grep -o 'G\.[A-Za-z_]*' js/net/netplay.js` (19 distinct members).
 */
import type { RaceCar } from "./race";
import type { CarState, SimTrack, SimTrackDef } from "./sim";

/** Tyre compound replicated by STRATEGY (netplay.js:242-251). */
export interface NetTyre {
  id: string;
  code: string;
  life: number;
  tread: number;
  off: number;
  colour: [number, number, number];
}

export type PitState = "none" | "lane" | "box" | "out";

/** Numeric strategy fields STRATEGY replicates, each clamped on receipt (netplay.js:234-235). */
export interface NetStrategyFields {
  tyreWearF?: number;
  tyreWearR?: number;
  tyreTs?: number;
  tyreTb?: number;
  tyreGrain?: number;
  tyreBlister?: number;
  tyreLap0?: number;
  tyreStints?: number;
  pitStops?: number;
  pitT?: number;
}

/**
 * The car fields NetPlay touches beyond `CarState` (sim.ts) and `RaceCar`
 * (race.ts). Field names follow f1-game verbatim so the physics port
 * (collide.js reads `_nOk/_nProg/_nX/_nSpd`) and the race port read the same
 * members.
 */
export interface NetCarFields extends NetStrategyFields {
  // grid (game.js makeCars / gridUp)
  /** Driver seat within the team, 0 or 1 (wireId = teamIndex*2 + seat). */
  seat: number;
  /** 1-based grid slot. */
  gridPos: number;
  /** Resolved parts for a human rival (lobby modsFromProfile). TODO(lane-garage): type it. */
  mods: unknown;

  // pose extras netplay writes for the renderer (netplay.js:439-509)
  xVis: number;
  yawVis: number;
  rPrevPx: number;
  rPrevPz: number;
  rPrevS: number;
  rPrevX: number;
  rPrevHead: number;
  rPrevYawVis: number;
  _prevS: number;

  /** A net-driven car's inputs. TODO(lane-net): type when remote inputs replicate. */
  netInput: unknown;

  // strategy (netplay.js:236-258)
  tyre: NetTyre | null;
  tread: number;
  pitState: PitState;
  pitArmed: boolean;

  // contact prediction, read by the contact solver (netplay.js:1305-1316)
  _nOk: boolean;
  _nProg: number;
  _nX: number;
  _nSpd: number;

  // ownership and anti-cheat bookkeeping (netplay.js:99-126, 316-331)
  _nOwnerLap: number;
  _nOwnerS: number;
  _nFin: number | null;
  _nFinLap: number | null;
  _nMid: boolean;
  _nRiseT: number | null;
}

/** One car as NetPlay sees it. `_nHuman`/`_nFallback` live on RaceCar. */
export type NetCar = CarState & RaceCar & NetCarFields;

/** The armed start: lights out at `at` (local ms) after `hold` s (netplay.js:474-483). */
export interface NetStart {
  readonly at: number;
  readonly hold: number;
  readonly now: () => number;
}

/** A peer's qualifying lap, validated (netplay.js:146-152). `t` is Infinity for NO TIME. */
export interface PeerQuali {
  readonly driverId: unknown;
  readonly t: number;
  readonly noTime?: boolean;
}

export interface PeerQualiLive {
  readonly driverId: unknown;
  readonly t: number;
  readonly frac: number;
}

/** The track as NetPlay reads it: `length` is f1-game's `track.total`. */
export type NetTrack = Pick<SimTrack, "length" | "sample"> & { readonly def?: SimTrackDef };

/** f1-game `G` as NetPlay sees it. */
export interface NetPlayCtx {
  readonly cars: NetCar[];
  readonly player: NetCar | null;
  readonly track: NetTrack | null;
  readonly lapsTarget: number;
  /** Race clock, seconds; shared through netStart. */
  readonly raceT: number;
  /** Lights sequence length, seconds (game.js COUNTDOWN_S). */
  readonly COUNTDOWN_S: number;
  /** True when the grid came from qualifying (separateGrid skips). */
  readonly gridPreOrdered: boolean;
  /** Written by NetPlay: the rAF time of the last tick(); null between races. */
  netNow: number | null;
  /** Written by NetPlay: the armed start the countdown consumes. */
  netStart: NetStart | null;
  /** teamIndex*2 + seat: a byte every peer computes identically; < 0 for no id. */
  wireId(c: NetCar): number;
  setCarRole(c: NetCar, human: boolean, local: boolean): void;
  /** Pooled result; copy what you keep. */
  worldFromTrack(s: number, x: number): Readonly<{ x: number; z: number }>;
  swapGridSlots(a: NetCar, b: NetCar): void;
  announce?(text: string, secs: number, kind?: string): void;
  retireCar?(c: NetCar, why: string): void;
  /** TODO(lane-race): type the caution payload when race control lands. */
  applyCaution?(d: unknown): void;
  onPeerQuali?(q: PeerQuali): void;
  onPeerQualiLive?(q: PeerQualiLive): void;
  /** f1-game PhysicsConsts.REVISION: peers on different physics refuse each other. */
  readonly physicsRevision?: string;
  /** f1-game PhysicsConsts.GEARS (default 8). */
  readonly gears?: number;
}
