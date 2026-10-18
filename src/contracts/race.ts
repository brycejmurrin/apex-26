/**
 * Race seam: the typed race state that replaces the 117 `G` members f1-game's
 * js/race/ reads (`grep -ohE '\bG\.\w+' js/race/*.js`). It is an explicit store
 * passed to pure rule functions in src/race/; there is no global and no `G`.
 *
 * The store is split by owner, so a rule takes only the slice it reads:
 * `cars` (one `RaceCar` per entry, roster order), `session` (what is being
 * run), the clocks (`raceT`, countdown), `caution` (flags/VSC/SC/red),
 * `weather`, `timing` (sectors) and `settings` (the race-settings sheet).
 *
 * Every member cites the f1-game file:line it came from (f1-game at the
 * revision `../f1-game` was cloned from, main @ 2026-10-18).
 */
import type { SessionMode, TyreWearLevel, Weather, WeatherArc } from "./sim";

// ─── One car, as the race rules see it ─────────────────────────────────────

/** A team as the race reads it: f1-game js/data/teams.js:52 (`id`, `tier` 0 fastest .. 4). */
export interface RaceTeam {
  readonly id: string;
  readonly tier: number;
}

/**
 * The race-owned fields of one car. The physics `CarState` (sim.ts) carries
 * the shared ones (`s`, `prog`, `lap`, `lapTime`, `best`, `speed`, `retired`,
 * `finished`, role flags) with the same names and types, so the integrated
 * car is `CarState & RaceCar`.
 *
 * Fields: f1-game js/game.js:1795-1801 (timing/status), js/race/race-control.js
 * :102-136 (line crossing, `fuelLap`, `_lapTimeAtLine`, `_recross`), :143-186
 * (`finishT`, `penalty`, `classified`, `dsq`), js/race/overtake-mode.js:27-31
 * (`ot*`), js/race/reliability.js:72-86 (`dnf*`), js/game.js:2949 (`finPos`),
 * js/game.js:6153-6163 (per-car sector trackers `_secIdx/_secValid/_secT0`).
 */
export interface RaceCar {
  // identity (js/game.js setCarRole; js/roster.js)
  /** Three-letter timing code. */
  code: string;
  /** Stable driver id; points and countback key on it (season-cal.js:398). */
  driverId: string;
  team: RaceTeam;
  /** Team tier copied onto the car (reliability.js:59). */
  tier: number;
  human: boolean;
  isPlayer: boolean;
  /** A remote human in a networked race (race-control.js:28). */
  _nHuman?: boolean;
  /** AI temporarily driving a disconnected owner's car (race-control.js:65). */
  _nFallback?: boolean;

  // track frame and timing (game.js:1795-1801)
  s: number;
  prog: number;
  /** Line crossings: 0 on the grid, 1 on the first flying lap, lapsTarget + 1 at the flag. */
  lap: number;
  lapTime: number;
  lastLap: number;
  best: number;
  speed: number;

  // line crossing (race-control.js:110-134)
  _lapTimeAtLine?: number | null;
  _recross?: boolean;
  /** Physical laps burned for fuel; a red-flag restart adds `fuelRestartLaps`. */
  fuelLap?: number;
  fuelRestartLaps?: number;
  incidentInvalidLap?: boolean;

  // result (race-control.js:143-186; game.js:2930-2949)
  finished: boolean;
  /** Race clock at the flag. */
  finishT?: number | null;
  /** Time penalty, seconds, served on the clock (finishers) or the road (runners). */
  penalty?: number;
  retired: boolean;
  /** Why the car retired ("engine", "gearbox", "accident", "mechanical"). */
  dnf?: string | null;
  /** Planned failure point, fraction of race distance (reliability.js:80). */
  dnfAt?: number | null;
  dnfWhy?: string | null;
  /** Disqualification reason (sporting-regs.js applyCompoundRule). */
  dsq?: string | null;
  /** Within 90 % of the winner's laps (race-control.js:181). */
  classified?: boolean;
  finPos?: number;
  /** Distance credited by a red-flag regrid; reliability ignores it (game.js:2913). */
  _progGift?: number;

  // per-car sector trackers (game.js:6153-6163)
  _secIdx?: number | null;
  _secValid?: boolean;
  _secT0?: number | null;

  // Overtake mode (overtake-mode.js:27-31)
  otE?: number;
  otOn?: boolean;
  otEarned?: boolean;
  otArmed?: boolean;
  otT?: number;
  _otS?: number | null;
  _otLap?: number | null;
  _otHold?: boolean;
  /** Snapshot pose stamped before any car moves this tick (race-control.js:633-634). */
  _snapProg?: number;
  _snapSpeed?: number;
}

// ─── What is being run ─────────────────────────────────────────────────────

/** The app flow. f1-game js/game.js setFlow (`flow`): one-off GP, season, career, time trial. */
export type RaceFlow = "gp" | "season" | "career" | "tt";

/** The game state machine's race-relevant states. f1-game js/game.js setState. */
export type RacePhase = "menu" | "count" | "race" | "results";

/** A sprint weekend's leg (season-cal.js:415 `stage`). */
export type WeekendStage = "sprint" | "race";

/** Session identity. f1-game G.session/G.flow/G.trackIdx/G.simSeed/G.seasonRound. */
export interface RaceSession {
  mode: SessionMode;
  flow: RaceFlow;
  stage: WeekendStage;
  /** Circuit id (src/circuits); never a positional index. */
  trackId: string;
  /** Championship round, 0-based; 0 outside a season. */
  round: number;
  /** The session's simulation seed (G.simSeed, game.js). */
  seed: number;
  /** A networked race (G.netPlay.active()). */
  networked: boolean;
  /** This peer runs race control (NetPlay.ownsRaceControl(), race-control.js:366). */
  ownsRaceControl: boolean;
}

// ─── Clocks ────────────────────────────────────────────────────────────────

/**
 * The start sequence. f1-game js/game.js:716 (`countT`, `lightsLit`),
 * :4366-4413 (the count), `feel.startHold` / `feel.restartPending`.
 */
export interface Countdown {
  countT: number;
  /** Lamps lit, 0..5 (COUNTDOWN_S, game.js:956). Monotonic within a sequence. */
  lightsLit: number;
  /** Random hold after the fifth lamp, seconds (0.2 + rnd·1.8, game.js:4411). */
  startHold: number;
  /** The sequence is a red-flag standing restart (game.js:1718). */
  restartPending: boolean;
}

// ─── Race control ──────────────────────────────────────────────────────────

/** Flag level: 0 GREEN, 1 local YELLOW, 2 VSC, 3 SAFETY CAR, 4 RED FLAG (race-control.js:199). */
export type CautionLevel = 0 | 1 | 2 | 3 | 4;

/** The caution picture. f1-game js/race/race-control.js:218-220 `blank()`. */
export interface Caution {
  level: CautionLevel;
  /** Yellow sector, -1 for none. */
  sector: number;
  frac: number;
  /** Settled hazards on the surface (HUD count). */
  total: number;
  sectors: number[];
  /** Seconds the current level has flown. */
  sinceT: number;
  cause: string;
  /** Red-flag procedure phase: "" | "stopping" | "held". */
  phase: string;
}

/** A settled-hazard picture from the debris world. f1-game js/physics/debris-world.js `hazards()`. */
export interface HazardPicture {
  readonly total: number;
  /** Count proven to come from at least two cars; RED keys on it (race-control.js:423). */
  readonly redTotal?: number | null;
  readonly sectors: readonly number[];
  readonly worst: { readonly count: number; readonly sector: number; readonly frac: number };
}

/** RaceControl's private machine state (race-control.js:230-262), held in the store, not a closure. */
export interface RaceControlState {
  caution: Caution;
  enabled: boolean;
  queryT: number;
  capHoldT: number;
  capHoldLevel: number;
  replayOwned: boolean;
  restartWanted: boolean;
  /** Leader's lap when a SC/red ended; Overtake waits for the next crossing (B7.2.2c). */
  otHoldLap: number | null;
  lowGripNoted: boolean;
  held: number;
  heldCause: string;
  scriptHeld: number;
  scriptCause: string;
  wxHeld: number;
  stormSince: number | null;
  stormAtStart: boolean;
  stormLastT: number;
  /** Last caution key published to guests. */
  sent: string;
}

// ─── Weather and timing ────────────────────────────────────────────────────

/** Race weather. f1-game G.raceWeather, G.weatherArc, G.trackWetness(), G.raceTimeOfDay. */
export interface RaceWeather {
  weather: Weather;
  arc: WeatherArc | null;
  /** Track wetness 0..1 (G.trackWetness()). */
  wetness: number;
  timeOfDay: string;
}

/**
 * Sector timing. f1-game js/game.js:2594-2599 (`lapRec`), :6165-6198: the
 * player's splits plus the field's best per sector.
 */
export interface SectorTiming {
  /** Player's current sector, 0..2. */
  sectorIdx: number;
  sectorStartT: number;
  /** The next split is trustworthy (entered going forward). */
  sectorValid: boolean;
  sectorLast: [number, number, number];
  sectorBests: [number, number, number];
  fieldSectorBests: [number, number, number];
}

/** RELIABILITY setting. f1-game js/race/reliability.js:7. */
export type ReliabilityLevel = "off" | "low" | "real";

/** The race-settings sheet's values. f1-game js/race/race-settings.js; G.raceTyreWear, G.raceReliability. */
export interface RaceSettings {
  laps: number;
  tyreWear: TyreWearLevel;
  reliability: ReliabilityLevel;
  cautions: boolean;
  /** The 2019–2024 fastest-lap point (season-cal.js:38). */
  flPoint: boolean;
  points: "modern" | "classic";
}

// ─── The store ─────────────────────────────────────────────────────────────

/** The race store. Rules in src/race/ take this or the slice they need; nothing else holds race state. */
export interface RaceState {
  session: RaceSession;
  phase: RacePhase;
  settings: RaceSettings;
  /** Every car, roster order (G.cars). */
  cars: RaceCar[];
  /** Cars by cumulative progress, leader first (G.ranked). */
  ranked: RaceCar[];
  /** Race clock, seconds since lights-out (game.js:716). */
  raceT: number;
  /** Where the clock started (a mid-race jump-in seeds it; race-control.js:10-22). */
  raceT0: number;
  /** Laps to run (G.lapsTarget). */
  lapsTarget: number;
  countdown: Countdown;
  raceControl: RaceControlState;
  weather: RaceWeather;
  timing: SectorTiming;
}
