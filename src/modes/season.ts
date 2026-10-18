/**
 * THE SEASON: the standalone championship's calendar, its weekend format
 * (qualifying, sprints, distance, points table, the fastest-lap point,
 * dropped scores), its save, and the standings.
 *
 * Ported from f1-game js/career/season-cal.js (main @ 2026-10-18). Module
 * state (`cfg`, `activeCfg`, `activeSeason`, the save revision) becomes a
 * `SeasonCal` instance over a `SaveStore` (keys `a26.seasonCfg`,
 * `a26.season`). The scoring itself is src/race/points.ts. Circuits are
 * named by id, never by index (season-cal.js:25-28).
 */
import { CIRCUITS } from "../circuits";
import type { RaceFlow, WeekendStage } from "../contracts/race";
import {
  CLASSIC_POINTS, POINTS, SPRINT_POINTS, award as awardPoints, canRace as canRaceRounds, netPts as netPoints,
  rank as rankDrivers, rankTeams as rankTeamsBy, type AwardCar, type SeasonRecord,
} from "../race/points";
import type { ShortRun } from "../race/race-control";
import type { SaveStore, WriteResult } from "./store";

/** The circuit fields the calendar reads. */
export interface CalCircuit {
  readonly id: string;
  readonly gp: string;
  readonly classic?: boolean;
}

export const CFG_KEY = "seasonCfg";
export const SAVE_KEY = "season";
export { SPRINT_POINTS, CLASSIC_POINTS };
/** season-cal.js:14. */
export const DROP_OPTS: readonly number[] = [0, 2, 3];
export const SPRINT_FRAC = 1 / 3;
export const SPRINT_MIN = 2;
export const DEFAULT_LAPS = 3;
export const LAP_OPTS: readonly number[] = [3, 5, 10, 25, 57];
export const SPRINT_SEED_OFFSET = 1000;

/** A season's format (season-cal.js:29-40). */
export interface SeasonConfig {
  trackIds: string[];
  quali: boolean;
  sprint: boolean | "rounds";
  sprintIds: string[];
  laps: number;
  points: "modern" | "classic";
  flPoint: boolean;
  drop: number;
}

/** A saved championship: the points record plus its frozen format. */
export interface Season extends SeasonRecord {
  config: Readonly<SeasonConfig>;
}

export type SaveStatus = Omit<WriteResult, "ok"> & { ok: boolean };

const asList = (l: readonly CalCircuit[]): readonly CalCircuit[] => l;
const seasonOf = (l: readonly CalCircuit[]): CalCircuit[] => l.filter((t) => !t.classic);

/** The 2026 calendar as raced (season-cal.js:629-640). */
export const REAL_2026: readonly { readonly id: string; readonly from: string; readonly to: string; readonly sprint: boolean }[] = Object.freeze(([
  ["albert_park", "03-06", "03-08"], ["shanghai", "03-13", "03-15", 1], ["suzuka", "03-27", "03-29"],
  ["miami", "05-01", "05-03", 1], ["montreal", "05-22", "05-24", 1], ["monaco", "06-05", "06-07"],
  ["catalunya", "06-12", "06-14"], ["redbull", "06-26", "06-28"], ["silverstone", "07-03", "07-05", 1],
  ["spa", "07-17", "07-19"], ["hungaroring", "07-24", "07-26"], ["zandvoort", "08-21", "08-23", 1],
  ["monza", "09-04", "09-06"], ["madrid", "09-11", "09-13"], ["baku", "09-24", "09-26"],
  ["sepang", "10-02", "10-04"], ["singapore", "10-09", "10-11", 1], ["cota", "10-23", "10-25"],
  ["mexico", "10-30", "11-01"], ["interlagos", "11-06", "11-08"], ["vegas", "11-19", "11-21"],
  ["qatar", "11-27", "11-29"], ["abudhabi", "12-04", "12-06"],
] as [string, string, string, number?][]).map(([id, from, to, sprint]) => Object.freeze({ id, from: "2026-" + from, to: "2026-" + to, sprint: !!sprint })));
const REAL_2026_GP: Readonly<Record<string, string>> = Object.freeze({ sepang: "Bahrain GP", catalunya: "Barcelona-Catalunya GP" });

export const PRESETS: readonly { readonly id: string; readonly label: string }[] = [
  { id: "full", label: "FULL" }, { id: "real2026", label: "2026 REAL" }, { id: "12", label: "12" },
  { id: "8", label: "8" }, { id: "5", label: "5" }, { id: "classics", label: "CLASSICS" },
];

/** A fresh format: every season circuit, qualifying on (season-cal.js:29-40). */
export function fresh(list: readonly CalCircuit[] = CIRCUITS): SeasonConfig {
  return {
    trackIds: seasonOf(list).map((t) => t.id),
    quali: true, sprint: false, sprintIds: [], laps: DEFAULT_LAPS, points: "modern", flPoint: false, drop: 0,
  };
}

/** Each stored id's place in the raceable calendar, -1 dropped (unknown or repeat) (season-cal.js:48-56). */
export function knownMap(raw: unknown, list: readonly CalCircuit[] = CIRCUITS): number[] {
  const seen = new Set<string>();
  let n = 0;
  return (Array.isArray(raw) ? raw as unknown[] : []).map((id) => {
    if (typeof id !== "string" || seen.has(id) || !list.some((t) => t.id === id)) return -1;
    seen.add(id);
    return n++;
  });
}
export function knownIds(raw: unknown, list: readonly CalCircuit[] = CIRCUITS): string[] {
  const m = knownMap(raw, list);
  return m.length ? (raw as string[]).filter((_, i) => (m[i] as number) >= 0) : [];
}

/** Normalise on read (season-cal.js:60-74). */
export function normalize(raw: unknown, list: readonly CalCircuit[] = CIRCUITS): SeasonConfig {
  const def = fresh(list);
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ids = knownIds(c["trackIds"], list);
  return {
    trackIds: ids.length ? ids : def.trackIds,
    quali: c["quali"] !== false,
    sprint: c["sprint"] === true ? true : c["sprint"] === "rounds" ? "rounds" : false,
    sprintIds: knownIds(c["sprintIds"], list),
    laps: LAP_OPTS.indexOf(c["laps"] as number) >= 0 ? c["laps"] as number : def.laps,
    points: c["points"] === "classic" ? "classic" : "modern",
    flPoint: c["flPoint"] === true,
    drop: DROP_OPTS.indexOf(c["drop"] as number) >= 0 ? c["drop"] as number : 0,
  };
}

function frozenConfig(raw: unknown, list: readonly CalCircuit[]): Readonly<SeasonConfig> {
  const out = normalize(raw, list);
  Object.freeze(out.trackIds);
  Object.freeze(out.sprintIds);
  return Object.freeze(out);
}

function scoreMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.entries(raw as Record<string, unknown>).forEach(([id, value]) => {
    const n = Number(value);
    if (id && isFinite(n)) out[id] = Math.max(0, n);
  });
  return out;
}
/** SaveMigrate.roundMap (save-migrate.js:142-150). */
function roundMap(o: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!o || typeof o !== "object") return out;
  for (const k of Object.keys(o)) {
    const v = (o as Record<string, unknown>)[k];
    if (k === "__proto__" || !Array.isArray(v)) continue;
    out[k] = (v as unknown[]).map((x) => (Number.isFinite(x) && (x as number) > 0 ? x as number : 0));
  }
  return out;
}
/** SaveMigrate.finishMap (save-migrate.js:151-159). */
function finishMap(o: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!o || typeof o !== "object") return out;
  for (const k of Object.keys(o)) {
    const v = (o as Record<string, unknown>)[k];
    if (k === "__proto__" || !Array.isArray(v)) continue;
    out[k] = (v as unknown[]).map((x) => (Number.isInteger(x) && (x as number) > 0 ? x as number : 0));
  }
  return out;
}
function codeMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.entries(raw as Record<string, unknown>).forEach(([id, value]) => {
    if (id && typeof value === "string") out[id] = value.slice(0, 12);
  });
  return out;
}

/** Fisher–Yates with the seeded mulberry32 draw, Math.random without a seed (season-cal.js:663-683). */
export function shuffled<T>(ids: readonly T[], seed?: number | null): T[] {
  const a = ids.slice();
  let s = seed != null ? (seed | 0) : null;
  for (let i = a.length - 1; i > 0; i--) {
    let r: number;
    if (s != null) {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    } else {
      r = Math.random();
    }
    const j = Math.floor(r * (i + 1));
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}

export interface SeasonCalOpts {
  readonly list?: readonly CalCircuit[];
  /** Career.calendar(): the calendar a career stamped at its season's start. */
  readonly careerCalendar?: () => readonly CalCircuit[];
}

/** The championship's rules and save (season-cal.js). */
export class SeasonCal {
  private readonly list: readonly CalCircuit[];
  private readonly careerCalendar: (() => readonly CalCircuit[]) | undefined;
  private cfg: SeasonConfig | null = null;
  private resolved: readonly CalCircuit[] | null = null;
  private activeCfg: Readonly<SeasonConfig> | null = null;
  private activeSeason: Season | null = null;
  private seasonRevision: string | null = null;
  private seasonConflict = false;
  private lastSave: SaveStatus = { ok: true, durable: true, reason: null };
  private flow: RaceFlow = "gp";
  private lastScored: WeekendStage = "race";
  private lastLossy = false;
  private readonly lossySeasons = new WeakSet<object>();
  private luckStamps = 0;

  constructor(private readonly store: SaveStore, opts: SeasonCalOpts = {}) {
    this.list = asList(opts.list ?? CIRCUITS);
    this.careerCalendar = opts.careerCalendar;
    store.subscribe((change) => {
      if (change.local) return;
      if (change.key === CFG_KEY) { this.cfg = null; this.resolved = null; }
      if (change.key === SAVE_KEY) {
        if (this.flow === "season" && this.activeSeason) this.seasonConflict = true;
        else { this.activeSeason = null; this.activeCfg = null; this.seasonConflict = false; this.resolved = null; }
      }
    });
  }

  config(): SeasonConfig {
    if (!this.cfg) this.cfg = normalize(this.store.get<unknown>(CFG_KEY, null), this.list);
    return this.cfg;
  }
  setConfig(next: unknown): SeasonConfig {
    const cfg = normalize(next, this.list);
    this.cfg = cfg;
    this.resolved = null;
    this.store.set(CFG_KEY, cfg);
    return cfg;
  }
  resetConfig(): SeasonConfig { return this.setConfig(null); }

  private rulesConfig(): Readonly<SeasonConfig> { return this.flow === "season" && this.activeCfg ? this.activeCfg : this.config(); }
  private currentRevision(): string { return this.store.keyRevision(SAVE_KEY); }
  private armRevision(season: Season | null): void {
    this.activeSeason = season;
    this.seasonRevision = this.currentRevision();
    this.seasonConflict = false;
  }

  /** setFlow's partner: which flow the format applies to (season-cal.js:150-155). */
  engage(v: RaceFlow | null | undefined): void { this.flow = v || "gp"; this.resolved = null; this.lastScored = "race"; }
  private calCustom(): boolean { return this.flow !== "career"; }
  private fmtActive(): boolean { return this.flow === "season"; }

  calendar(): readonly CalCircuit[] {
    if (!this.calCustom()) return this.careerCalendar ? this.careerCalendar() : seasonOf(this.list);
    if (!this.resolved) {
      const byId = new Map(this.list.map((t) => [t.id, t]));
      let r = this.rulesConfig().trackIds.map((id) => byId.get(id)).filter((t): t is CalCircuit => !!t);
      if (!r.length) r = seasonOf(this.list);
      this.resolved = r;
    }
    return this.resolved;
  }
  rounds(): number { return this.calendar().length; }
  track(round: number): CalCircuit | null { return this.calendar()[round] || null; }

  /** The round's GP name; an unedited 2026 calendar takes its renamed rounds (season-cal.js:174-181). */
  gpName(t: CalCircuit | null | undefined): string {
    if (!t) return "";
    const rename = REAL_2026_GP[t.id];
    if (this.fmtActive() && rename) {
      const ids = this.rulesConfig().trackIds || [];
      if (ids.length === REAL_2026.length && REAL_2026.every((r, i) => r.id === ids[i])) return rename;
    }
    return t.gp || "";
  }

  blank(): Season {
    const snap = frozenConfig(this.flow === "season" && this.activeCfg ? this.activeCfg : this.config(), this.list);
    if (this.flow === "season") this.activeCfg = snap;
    return { round: 0, pts: {}, teamPts: {}, driverCodes: {}, finishes: {}, roundPts: {}, config: snap };
  }
  resetWeekend(): void { this.lastScored = "race"; }
  restart(): Season {
    this.activeCfg = frozenConfig(this.config(), this.list);
    this.resolved = null;
    this.resetWeekend();
    const season = this.blank();
    this.activeSeason = season;
    return season;
  }
  matchesConfig(season: Pick<Season, "config"> | null | undefined, next: unknown): boolean {
    return !!(season && season.config && JSON.stringify(normalize(season.config, this.list)) === JSON.stringify(normalize(next, this.list)));
  }

  private conflictNow(): boolean {
    const now = this.currentRevision();
    return this.seasonConflict || (this.seasonRevision != null && now !== this.seasonRevision);
  }

  /** Apply a changed setup: replaces the saved championship (season-cal.js:203-231). */
  applyConfig(next: unknown): SaveStatus & { season: Season | null } {
    if (this.conflictNow()) {
      this.seasonConflict = true;
      this.lastSave = { ok: false, durable: false, reason: "conflict" };
      return { season: null, ...this.lastSave };
    }
    if (this.canRace(this.activeSeason) && this.matchesConfig(this.activeSeason, next)) {
      if (!this.matchesConfig({ config: this.config() }, next)) this.setConfig(next);
      return { ...this.lastSave, season: this.activeSeason, ok: true };
    }
    const snap = frozenConfig(next, this.list);
    const season: Season = { round: 0, pts: {}, teamPts: {}, driverCodes: {}, finishes: {}, roundPts: {}, config: snap };
    this.lastSave = this.store.write(SAVE_KEY, season);
    this.setConfig(next);
    this.activeCfg = snap;
    this.resolved = null;
    this.resetWeekend();
    this.armRevision(season);
    return { season, ...this.lastSave };
  }

  /** Make a saved season safe to race (season-cal.js:263-309). Repairs `saved` in place. */
  resume(saved: unknown): Season {
    const s = saved && typeof saved === "object" ? saved as Season & Record<string, unknown> : null;
    this.activeCfg = frozenConfig(s && s.config ? s.config : this.config(), this.list);
    this.resolved = null;
    const n = this.activeCfg.trackIds.length;
    const rawIds = s && s.config && Array.isArray(s.config.trackIds) ? s.config.trackIds as unknown[] : null;
    const idx = rawIds ? knownMap(rawIds, this.list) : null;
    const remap = idx && idx.some((v) => v >= 0) ? idx : null;
    if (s && remap && rawIds && Number.isInteger(s.round) && s.round >= 0 && s.round <= rawIds.length) {
      s.round = remap.slice(0, s.round).filter((v) => v >= 0).length;
    }
    if (!s || !Number.isInteger(s.round) || s.round < 0 || s.round > n) return this.restart();
    s.config = this.activeCfg;
    s.pts = scoreMap(s.pts);
    s.teamPts = scoreMap(s.teamPts);
    s.driverCodes = codeMap(s.driverCodes);
    s.finishes = finishMap(s.finishes);
    s.roundPts = roundMap(s.roundPts);
    if (remap && remap.some((v, i) => v !== i)) {
      for (const id of Object.keys(s.roundPts)) {
        const row: number[] = [];
        (s.roundPts[id] as number[]).forEach((v, r) => { const to = remap[r] as number; if (to >= 0) row[to] = v; });
        s.roundPts[id] = row;
      }
    }
    if (typeof s.lastFl !== "string") delete s.lastFl;
    if (!(Number.isInteger(s.seed) && (s.seed as number) > 0 && (s.seed as number) <= 0xFFFFFFFF)) delete s.seed;
    if (s.sprintOrder) delete s.sprintOrder;
    return s;
  }

  lastLoadLossy(): boolean { return this.lastLossy; }

  /** Load the saved championship; a save naming a circuit this build lacks is never written back (season-cal.js:313-341). */
  load(): Season {
    const raw = this.store.get<unknown>(SAVE_KEY, null);
    const rawObj = raw && typeof raw === "object" ? raw as { config?: { trackIds?: unknown } } : null;
    const rawIds = rawObj && rawObj.config && Array.isArray(rawObj.config.trackIds) ? rawObj.config.trackIds as unknown[] : null;
    const copy: unknown = rawObj ? JSON.parse(JSON.stringify(raw)) : raw;
    const season = this.resume(copy);
    this.armRevision(season);
    const lossy = !!raw && rawIds != null && (knownIds(rawIds, this.list).length !== rawIds.length
      || (season === copy && season.config.trackIds.length !== rawIds.length));
    this.lastLossy = lossy;
    if (lossy) this.lossySeasons.add(season);
    if (raw && !lossy) this.save(season);
    return season;
  }

  /** Save, refusing a lossy read and a newer write from another tab (season-cal.js:342-367). */
  save(season: Season | null | undefined): SaveStatus {
    if (!season || typeof season !== "object") { this.lastSave = { ok: false, durable: false, reason: "invalid" }; return this.lastSave; }
    if (this.lossySeasons.has(season)) { this.lastSave = { ok: false, durable: false, reason: "unknown circuit" }; return this.lastSave; }
    if (this.conflictNow()) {
      this.seasonConflict = true;
      this.lastSave = { ok: false, durable: false, reason: "conflict" };
      return this.lastSave;
    }
    this.activeCfg = frozenConfig(season.config || this.activeCfg || this.config(), this.list);
    season.config = this.activeCfg;
    this.lastSave = this.store.write(SAVE_KEY, season);
    this.armRevision(season);
    return this.lastSave;
  }
  clear(): SaveStatus {
    if (this.conflictNow()) {
      this.seasonConflict = true;
      this.lastSave = { ok: false, durable: false, reason: "conflict" };
      return this.lastSave;
    }
    this.lastSave = this.store.write(SAVE_KEY, null);
    this.activeSeason = null;
    this.activeCfg = null;
    this.resolved = null;
    this.seasonRevision = this.currentRevision();
    this.seasonConflict = false;
    return this.lastSave;
  }
  conflicted(): boolean { return this.seasonConflict; }
  saveStatus(): SaveStatus { return { ...this.lastSave }; }

  canRace(season: SeasonRecord | null | undefined): boolean { return canRaceRounds(season, this.rounds()); }
  hasProgress(season: SeasonRecord | null | undefined): boolean { return !!(season && (season.round > 0 || season.stage === "race")); }

  /** This round is a sprint weekend (season-cal.js:383-392). */
  sprintOn(season?: SeasonRecord | null): boolean {
    if (!this.fmtActive()) return false;
    const c = this.rulesConfig();
    if (c.sprint === true) return true;
    if (c.sprint !== "rounds" || !c.sprintIds || !c.sprintIds.length) return false;
    const s = season || this.activeSeason;
    const t = this.track(s && Number.isInteger(s.round) ? s.round : 0);
    return !!t && c.sprintIds.indexOf(t.id) >= 0;
  }
  stage(season?: SeasonRecord | null): WeekendStage {
    if (!this.sprintOn(season)) return "race";
    return season && season.stage === "race" ? "race" : "sprint";
  }
  midWeekend(season: Season | null | undefined): boolean {
    const c = season && season.config ? season.config : (this.fmtActive() ? this.rulesConfig() : null);
    return sprintMidOf(c, season);
  }
  quali(): boolean { return !this.fmtActive() || this.rulesConfig().quali; }
  qualiLabel(season?: SeasonRecord | null): string { return this.stage(season) === "sprint" ? "SPRINT QUALIFYING" : "QUALIFYING"; }
  /** The sprint leg divides the distance (season-cal.js:415-418). */
  lapsFor(fallback: number, season?: SeasonRecord | null): number {
    if (this.stage(season) !== "sprint") return fallback;
    return Math.max(SPRINT_MIN, Math.round(fallback * SPRINT_FRAC));
  }
  formatLaps(fallback: number): number { return this.fmtActive() ? this.rulesConfig().laps : fallback; }
  /** NEXT ROUND's distance, clamped to the circuit's full (season-cal.js:425-428). */
  roundLaps(prev: number, season: Season | null | undefined, full: number): number {
    const laps = this.midWeekend(season) ? prev : this.formatLaps(prev);
    return full > 0 ? Math.min(laps, full) : laps;
  }
  pointsTable(): readonly number[] { return this.fmtActive() && this.rulesConfig().points === "classic" ? CLASSIC_POINTS : POINTS; }

  /** Score a classified order (season-cal.js:440-500). */
  award(season: Season | null | undefined, order: readonly AwardCar[], fastestId: string | null | undefined, run: ShortRun | null | undefined): WeekendStage | null {
    const scoring = this.stage(season);
    const out = awardPoints(season, order, fastestId, run, {
      scoring, table: this.pointsTable(), flPoint: this.fmtActive() && this.rulesConfig().flPoint,
      rounds: this.rounds(), conflict: this.fmtActive() && this.seasonConflict,
    });
    if (out) this.lastScored = out;
    return out;
  }
  scored(): WeekendStage { return this.lastScored; }

  netPts(season: Season | null | undefined, id: string): number {
    const c = season && season.config ? season.config : (this.fmtActive() ? this.rulesConfig() : null);
    return netPoints(season, id, c, this.rounds());
  }
  rank(season: Season | null | undefined, a: string, b: string): number {
    const c = season && season.config ? season.config : (this.fmtActive() ? this.rulesConfig() : null);
    return rankDrivers(season, a, b, c, this.rounds());
  }
  rankTeams(season: SeasonRecord | null | undefined, a: string, b: string, teams: readonly { readonly id: string; readonly tier?: number }[]): number {
    return rankTeamsBy(season, a, b, teams);
  }

  /** The draw round: a sprint draws apart from its Grand Prix (season-cal.js:609-613). */
  drawRound(season: SeasonRecord | null | undefined): number {
    const r = season ? season.round : 0;
    return this.stage(season) === "sprint" ? r + SPRINT_SEED_OFFSET : r;
  }

  /** The season's own luck seed, stamped once and saved (season-cal.js:568-578). */
  luckSeed(season: Season | null | undefined, sessionSeed: number): number {
    const base = (sessionSeed >>> 0) || 1;
    if (!season || typeof season !== "object") return base;
    if (Number.isInteger(season.seed) && (season.seed as number) > 0) return (season.seed as number) >>> 0;
    season.seed = (this.luckStamps ? (base ^ Math.imul(this.luckStamps, 0x9E3779B1)) >>> 0 : base) || 1;
    this.luckStamps++;
    this.save(season);
    return season.seed;
  }

  /** A preset's calendar ids (season-cal.js:650-657). */
  presetIds(id: string): string[] {
    if (id === "real2026") return knownIds(REAL_2026.map((r) => r.id), this.list);
    if (id === "classics") return this.list.filter((t) => t.classic).map((t) => t.id);
    const all = seasonOf(this.list).map((t) => t.id);
    const n = parseInt(id, 10);
    return n > 0 ? all.slice(0, Math.min(n, all.length)) : all;
  }
  /** What a preset changes in a setup draft (season-cal.js:659-666). */
  preset(id: string): Partial<SeasonConfig> {
    const out: Partial<SeasonConfig> = { trackIds: this.presetIds(id) };
    if (id === "real2026") {
      out.sprint = "rounds";
      out.sprintIds = knownIds(REAL_2026.filter((r) => r.sprint).map((r) => r.id), this.list);
    }
    return out;
  }
}

/** sprintMid (season-cal.js:510-516). */
export function sprintMidOf(c: Readonly<Pick<SeasonConfig, "sprint" | "sprintIds" | "trackIds">> | null | undefined, season: SeasonRecord | null | undefined): boolean {
  if (!c || !season || season.stage !== "race") return false;
  if (c.sprint === true) return true;
  if (c.sprint !== "rounds" || !c.sprintIds || !c.trackIds) return false;
  const id = c.trackIds[Number.isInteger(season.round) ? season.round : 0];
  return !!id && c.sprintIds.indexOf(id) >= 0;
}
