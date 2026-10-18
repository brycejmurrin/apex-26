/**
 * THE BRIDGE from real races to the game: the seam between the Data Hub's
 * WATCH & DRIVE tab (src/data/real-race/tab.ts, the data lane's) and the REAL
 * RACE director (f1-game js/race/real-race.js, the race lane's).
 *
 * f1-game's tab reached the director through globals; each read is listed here
 * with the member that replaces it:
 *   RealRace.launch(script, options)  real-race-tab.js:905 (launchRace)     -> RealRacePort.launch
 *   RealRace.replay (presence only)   real-race-tab.js:827, :991            -> RealRacePort.replay
 *   RealRace.mapField(script, Teams)  real-race-tab.js:1046-1051 (seatsFor) -> RealRacePort.mapField
 *   RealRace.cumTable(script)         real-race-tab.js:328 (lapBoard)       -> RealRacePort.cumTable
 *   Tracks.LIST {id,name,country,classic}  real-race-tab.js:716, :56-76     -> TrackInfo / circuitTracks()
 *   SeasonCal.REAL_2026 windows       real-race-tab.js:66-67                -> DEFAULT_CALENDAR (injectable)
 *   Teams.LIST                        real-race-tab.js:1049                 -> src/data/teams.ts LIST (injectable)
 *
 * The director's side, for the race lane to implement (f1-game js/race/real-race.js):
 *   launch   :451-459 (stage :394-430) — synchronously stages the race and
 *            returns the staged summary, or null when it refuses (no circuit,
 *            no seat). The tab closes the Hub only after a truthy return.
 *   replay   :923-925 — the WATCH replay's controls; the tab only tests that
 *            the member exists (WATCH/HIGHLIGHTS buttons appear with it).
 *   mapField :276-298 — which roster seat each real driver takes.
 *   cumTable :84-111  — cumulative real race time per driver per lap.
 */
import { CIRCUITS } from "../../circuits/index";
import type { Team } from "../teams";
import type { CalendarWindow, CumTable, RaceScript, TrackInfo, Traces } from "./script";

export type { CalendarWindow, TrackInfo } from "./script";

/** The WATCH camera shots (real-race-tab.js:814; js/race/broadcast.js owns AUTO). */
export type WatchCamera = "auto" | "side" | "heli" | "tcam" | "chase";

/**
 * What the tab hands RealRace.launch (real-race-tab.js:925 WATCH, :1149 JUMP IN).
 * WATCH always races the full real distance; JUMP IN takes the DISTANCES pick.
 */
export interface LaunchOptions {
  /** The real driver's code whose seat the player takes / the camera follows (null: the first seated driver). */
  seat: string | null;
  /** Sim laps (WATCH: script.laps). */
  laps: number;
  /** The real lap the race starts from (1 = the grid). */
  startLap: number;
  /** The real positions when loaded (WATCH needs them; JUMP IN passes them when they fit the script). */
  traces: Traces | null;
  /** Go through the pre-race screen (card, flyby, announcer), as RACE! does. */
  intro: boolean;
  /** WATCH: replay the real race from the positions, no player car. */
  watch?: boolean;
  camera?: WatchCamera;
  /** HIGHLIGHTS: the key moments cut together. */
  reel?: boolean;
}

/** RealRace.stage's summary (real-race.js:429). */
export interface StagedLaunch {
  trackId: string | null;
  laps: number;
  seat: string;
  startLap: number;
  watch?: true;
  reel?: boolean;
}

/** A roster seat a real driver takes (RealRace.mapField, real-race.js:297). */
export interface Seat { driverId: string; num: number; teamId: string; di: number }

/**
 * The race lane's REAL RACE director as the WATCH & DRIVE tab uses it.
 *
 * TODO(lane-race): implement this from f1-game js/race/real-race.js and call
 * registerRealRacePort() at boot (or pass `port` in the tab deps). Until then
 * the tab renders the race book and entry list, every seat reads as seated,
 * the lap board is empty, and JUMP IN / WATCH report "Could not start the race".
 */
export interface RealRacePort {
  /** Stage and start the race synchronously. Truthy = accepted (f1-game returns the StagedLaunch, or null to refuse). May throw. */
  launch(script: RaceScript, options: LaunchOptions): StagedLaunch | boolean | null;
  /** Present when WATCH (the real-positions replay, js/race/real-replay.js) is available. The tab never calls it. */
  replay?(): unknown;
  /** Which roster seat each real driver takes; drivers left out have no seat in this roster. */
  mapField(script: RaceScript, teams: readonly Team[]): Seat[];
  /** Cumulative real race time per driver (index = laps completed, 0 at the start); feeds the lap board. */
  cumTable?(script: RaceScript): CumTable;
}

// One port per page, registered by the race lane at boot (f1-game: the global RealRace).
let registered: RealRacePort | null = null;

/** Register the director (TODO(lane-race): call from the race module's init). Returns the previous one. */
export function registerRealRacePort(port: RealRacePort | null): RealRacePort | null {
  const prev = registered;
  registered = port;
  return prev;
}
export function realRacePort(): RealRacePort | null { return registered; }

/** The game's circuits as the builder reads them (f1-game Tracks.LIST). */
export function circuitTracks(): TrackInfo[] {
  return CIRCUITS.map((c) => (c.classic ? { id: c.id, name: c.name, country: c.country, classic: true } : { id: c.id, name: c.name, country: c.country }));
}

/**
 * SeasonCal.REAL_2026: the real 2026 calendar's race-weekend windows, verbatim
 * from f1-game js/career/season-cal.js:650-659. trackIdFor reads it to put a GP
 * that moved venue (the 2026 Bahrain GP at Sepang) on the right circuit.
 * TODO(lane-race): import from the race lane's season calendar once it is ported.
 */
export const DEFAULT_CALENDAR: readonly CalendarWindow[] = Object.freeze(([
  ["albert_park", "03-06", "03-08"], ["shanghai", "03-13", "03-15", 1], ["suzuka", "03-27", "03-29"],
  ["miami", "05-01", "05-03", 1], ["montreal", "05-22", "05-24", 1], ["monaco", "06-05", "06-07"],
  ["catalunya", "06-12", "06-14"], ["redbull", "06-26", "06-28"], ["silverstone", "07-03", "07-05", 1],
  ["spa", "07-17", "07-19"], ["hungaroring", "07-24", "07-26"], ["zandvoort", "08-21", "08-23", 1],
  ["monza", "09-04", "09-06"], ["madrid", "09-11", "09-13"], ["baku", "09-24", "09-26"],
  ["sepang", "10-02", "10-04"], ["singapore", "10-09", "10-11", 1], ["cota", "10-23", "10-25"],
  ["mexico", "10-30", "11-01"], ["interlagos", "11-06", "11-08"], ["vegas", "11-19", "11-21"],
  ["qatar", "11-27", "11-29"], ["abudhabi", "12-04", "12-06"],
] as [string, string, string, number?][]).map(([id, from, to, sprint]) => Object.freeze({ id, from: "2026-" + from, to: "2026-" + to, sprint: !!sprint })));
