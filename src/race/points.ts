/**
 * POINTS: the paying tables, the shortened-race scale, awarding a classified
 * order into a championship record, and the standings comparators.
 *
 * Ported from f1-game js/career/season-cal.js (main @ 2026-10-18): tables :10-11
 * and :430-438, `payTable` :430-438, `award` :440-500, `netPts` :517-538,
 * `rank` :540-555, `rankTeams` :586-607; the modern table is js/data/teams.js:272.
 * What f1-game read from module state (`fmtActive()`, `rulesConfig()`,
 * `stage()`, `rounds()`, `seasonConflict`) is the explicit `AwardRules`.
 */
import type { RaceCar, WeekendStage } from "../contracts/race";
import type { ShortRun } from "./race-control";

/** js/data/teams.js:272. */
export const POINTS: readonly number[] = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
/** season-cal.js:10. */
export const SPRINT_POINTS: readonly number[] = [8, 7, 6, 5, 4, 3, 2, 1];
/** 1991–2002, season-cal.js:11. */
export const CLASSIC_POINTS: readonly number[] = [10, 6, 4, 3, 2, 1];
/** Shortened Grand Prix columns below 25/50/75 % (season-cal.js:429). */
export const SHORT_POINTS: readonly (readonly number[])[] = [[6, 4, 3, 2, 1], [13, 10, 8, 6, 5, 4, 3, 2, 1], [19, 14, 12, 10, 8, 6, 4, 3, 2, 1]];

export type Scoring = WeekendStage;

/** The fraction of the scheduled distance run; 1 for a race that saw the flag (:430). */
export function shortFrac(run: ShortRun | null | undefined): number { return run ? run.laps / Math.max(1, run.of) : 1; }

/** The table a (possibly shortened) race pays (:431-438). */
export function payTable(table: readonly number[], scoring: Scoring, run: ShortRun | null | undefined): readonly number[] {
  if (!run) return table;
  const f = shortFrac(run);
  if (run.laps < 2) return [];
  if (scoring === "sprint") return f < 0.5 ? [] : table;
  if (f >= 0.75) return table;
  return table === CLASSIC_POINTS ? table.map((p) => p / 2) : SHORT_POINTS[f < 0.25 ? 0 : f < 0.5 ? 1 : 2] as readonly number[];
}

/**
 * A championship record (f1-game `season`, season-cal.js:186). Sparse arrays
 * are kept sparse: `finishes[id][pos]` counts Grand Prix finishes at that
 * position, `roundPts[id][round]` points per round.
 */
export interface SeasonRecord {
  round: number;
  stage?: WeekendStage;
  pts: Record<string, number>;
  teamPts: Record<string, number>;
  driverCodes: Record<string, string>;
  finishes: Record<string, number[]>;
  roundPts: Record<string, number[]>;
  lastFl?: string;
  seed?: number;
  qualiOrder?: unknown;
  qualiTrack?: unknown;
  qualiMode?: unknown;
  sprintOrder?: unknown;
}

/** What `award` read off SeasonCal's module state. */
export interface AwardRules {
  /** stage(season): "sprint" on a sprint weekend's first leg. */
  readonly scoring: Scoring;
  /** pointsTable(): CLASSIC_POINTS only for a season configured "classic". */
  readonly table: readonly number[];
  /** fmtActive() && rulesConfig().flPoint. */
  readonly flPoint: boolean;
  /** rounds() of the calendar; canRace() needs round < rounds. */
  readonly rounds: number;
  /** fmtActive() && seasonConflict: refuse to score. */
  readonly conflict?: boolean;
}

export type AwardCar = Pick<RaceCar, "driverId" | "code" | "team"> & Partial<Pick<RaceCar, "classified" | "retired">>;

/** canRace (:337-339). */
export function canRace(season: SeasonRecord | null | undefined, rounds: number): boolean {
  return !!(season && Number.isInteger(season.round) && season.round >= 0 && season.round < rounds);
}

/** Score one classified order into `season` (:440-500). Returns the leg scored, or null when refused. */
export function award(season: SeasonRecord | null | undefined, order: readonly AwardCar[], fastestId: string | null | undefined,
  run: ShortRun | null | undefined, rules: AwardRules): Scoring | null {
  if (season) delete season.lastFl;
  if (rules.conflict) return null;
  if (!season || !canRace(season, rules.rounds)) return null;
  const scoring = rules.scoring;
  const table = payTable(scoring === "sprint" ? SPRINT_POINTS : rules.table, scoring, run);
  const fl = scoring !== "sprint" && rules.flPoint && fastestId != null && shortFrac(run) >= 0.5;
  const rp = season.roundPts || (season.roundPts = {});
  order.forEach((c, i) => {
    const classified = c.classified != null ? !!c.classified : !c.retired;
    let pts = classified ? (table[i] || 0) : 0;
    if (fl && classified && !c.retired && c.driverId === fastestId && i < Math.min(10, table.length)) { pts += 1; season.lastFl = fastestId; }
    const row = rp[c.driverId] || (rp[c.driverId] = []);
    row[season.round] = (row[season.round] || 0) + pts;
    season.pts[c.driverId] = (season.pts[c.driverId] || 0) + pts;
    season.driverCodes[c.driverId] = c.code;
    season.teamPts[c.team.id] = (season.teamPts[c.team.id] || 0) + pts;
    if (scoring !== "sprint" && classified) {
      const f = season.finishes || (season.finishes = {});
      const frow = f[c.driverId] || (f[c.driverId] = []);
      frow[i] = (frow[i] || 0) + 1;
    }
  });
  delete season.qualiOrder;
  delete season.qualiTrack;
  delete season.qualiMode;
  if (scoring === "sprint") {
    season.stage = "race";
  } else {
    season.round++;
    delete season.stage;
    delete season.sprintOrder;
  }
  return scoring;
}

/** The fastest lap among cars still in the race (game.js:2939-2940). */
export function fastestLap(cars: readonly Pick<RaceCar, "retired" | "dsq" | "best" | "driverId">[]): string | null {
  let fastest: string | null = null, fastestT = Infinity;
  for (const c of cars) if (!c.retired && !c.dsq && c.best < fastestT) { fastestT = c.best; fastest = c.driverId; }
  return fastest;
}

/** The format fields `netPts` reads (a season's frozen config). */
export interface DropConfig {
  readonly drop?: number;
  readonly trackIds?: readonly string[];
  readonly sprint?: boolean | "rounds";
  readonly sprintIds?: readonly string[];
}

/** Mid-way through a sprint weekend (:510-516). */
export function sprintMid(c: DropConfig | null | undefined, season: SeasonRecord | null | undefined): boolean {
  if (!c || !season || season.stage !== "race") return false;
  if (c.sprint === true) return true;
  if (c.sprint !== "rounds" || !c.sprintIds || !c.trackIds) return false;
  const id = c.trackIds[Number.isInteger(season.round) ? season.round : 0];
  return !!id && c.sprintIds.indexOf(id) >= 0;
}

/** A driver's counting points under dropped scores (:517-538). `rounds` stands in for an untracked calendar. */
export function netPts(season: SeasonRecord | null | undefined, id: string, c: DropConfig | null | undefined, rounds = 0): number {
  const gross = (season && season.pts && season.pts[id]) || 0;
  const drop = c ? c.drop || 0 : 0;
  if (!drop || !season) return gross;
  const row = (season.roundPts && season.roundPts[id]) || [];
  const played = (season.round || 0) + (sprintMid(c, season) ? 1 : 0);
  const keep = Math.max(1, (c && c.trackIds ? c.trackIds.length : rounds) - drop);
  if (played <= keep || !row.length) return gross;
  const vals: number[] = [];
  for (let r = 0, n = Math.min(played, row.length); r < n; r++) vals.push(row[r] || 0);
  vals.sort((x, y) => y - x);
  let sum = 0;
  for (let i = 0; i < keep; i++) sum += vals[i] || 0;
  return sum;
}

/** Drivers' standings comparator: counting points, countback, id (:540-555). */
export function rank(season: SeasonRecord | null | undefined, a: string, b: string, c?: DropConfig | null, rounds = 0): number {
  const d = netPts(season, b, c, rounds) - netPts(season, a, c, rounds);
  if (d) return d;
  const fin = (season && season.finishes) || {};
  const fa = fin[a] || [], fb = fin[b] || [];
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
    const e = (fb[i] || 0) - (fa[i] || 0);
    if (e) return e;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/** Both cars' Grand Prix finishes for a team; finish ids are "team:seat" (:572-583). */
export function teamFinishes(season: SeasonRecord | null | undefined, team: string): number[] {
  const row: number[] = [];
  const fin = (season && season.finishes) || {};
  for (const id of Object.keys(fin)) {
    const k = id.lastIndexOf(":");
    if ((k > 0 ? id.slice(0, k) : id) !== team) continue;
    const f = fin[id] || [];
    for (let i = 0; i < f.length; i++) if (f[i]) row[i] = (row[i] || 0) + (f[i] as number);
  }
  return row;
}

/** Constructors' comparator: points, countback, tier, id (:584-607). `teams` is Teams.LIST. */
export function rankTeams(season: SeasonRecord | null | undefined, a: string, b: string,
  teams: readonly { readonly id: string; readonly tier?: number }[] = []): number {
  const pts = (season && season.teamPts) || {};
  const d = (pts[b] || 0) - (pts[a] || 0);
  if (d) return d;
  if (a === b) return 0;
  const fa = teamFinishes(season, a), fb = teamFinishes(season, b);
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
    const e = (fb[i] || 0) - (fa[i] || 0);
    if (e) return e;
  }
  const ta = teams.find((t) => t.id === a);
  const tb = teams.find((t) => t.id === b);
  const tierA = ta && Number.isFinite(ta.tier) ? ta.tier as number : Infinity;
  const tierB = tb && Number.isFinite(tb.tier) ? tb.tier as number : Infinity;
  if (tierA !== tierB) return tierA - tierB;
  return a < b ? -1 : a > b ? 1 : 0;
}
