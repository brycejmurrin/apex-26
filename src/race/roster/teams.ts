/**
 * TEAMS: the 2026 grid (generated, teams-data.ts), the points table, the tier
 * pace ladder, the real-constructor predicate and the My Team record's
 * load-time repair.
 *
 * Ported from f1-game js/data/teams.js (main @ 2026-10-18): POINTS :272,
 * TIER_V :286, isReal :300, DEFAULT_CUSTOM :303-310, sanitizeCustom :320-386.
 * `liveryEnumOk` takes the car lane's id tables as an argument (f1-game read
 * Car3D/LiveryTex globals at call time).
 */
import { TEAM_LIST } from "./teams-data";

export type Rgb = readonly [number, number, number] | readonly number[];

export interface TeamDriver {
  readonly name: string;
  readonly code: string;
  readonly num: number;
}

export interface TeamStats {
  readonly speed: number;
  readonly accel: number;
  readonly cornering: number;
  readonly braking: number;
}

/** One constructor (teams.js LIST entry). `livery` is the car lane's; the race treats it as opaque. */
export interface TeamRecord {
  readonly id: string;
  readonly name: string;
  readonly short: string;
  readonly engine: string;
  readonly tier: number;
  readonly color: Rgb;
  readonly color2: Rgb;
  readonly stats: TeamStats;
  readonly drivers: readonly TeamDriver[];
  readonly livery?: Readonly<Record<string, unknown>>;
  readonly custom?: boolean;
  readonly legends?: boolean;
}

/** The eleven real constructors, garage order. */
export const TEAMS: readonly TeamRecord[] = TEAM_LIST;
/** Top-ten race points, 2026 (:272). */
export const POINTS: readonly number[] = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
/** Ground-speed scale per tier, 0 fastest (:286). */
export const TIER_V: readonly number[] = [0.9695, 0.9674, 0.9648, 0.9622, 0.9594];

/** One of the eleven real constructors, not My Team or Legends (:300). */
export const isReal = (t: Pick<TeamRecord, "custom" | "legends"> | null | undefined): boolean => !!t && !t.custom && !t.legends;

export function teamById(id: string): TeamRecord | undefined { return TEAMS.find((t) => t.id === id); }

/** The My Team seed record (:303-310). */
export const DEFAULT_CUSTOM: TeamRecord = {
  id: "custom", name: "My Team", short: "YOU", engine: "Custom", tier: 2, custom: true,
  livery: { finShape: "none", spineHeight: "dorsal", spineLogo: "number", spineSide: "number" },
  color: [0.13, 0.79, 0.85], color2: [0.96, 0.86, 0.0],
  stats: { speed: 84, accel: 82, cornering: 83, braking: 81 },
  drivers: [{ name: "Your Name", code: "YOU", num: 99 }],
};

export const CUSTOM_MAX_DRIVERS = 2;
// C0/C1 controls, and the bidi overrides/isolates that reorder a label (:323).
const CTRL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
function cleanText(v: unknown, fb: string, n: number, upper: boolean): string {
  if (typeof v !== "string") return fb;
  let s = v.replace(CTRL, "").trim().slice(0, n).trim();
  if (upper) s = s.toUpperCase();
  return s || fb;
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function cleanRgb(v: unknown, fb: Rgb): number[] {
  if (!Array.isArray(v) || v.length < 3 || !v.slice(0, 3).every(fin)) return fb.slice();
  return (v.slice(0, 3) as number[]).map((x) => Math.min(1, Math.max(0, x)));
}
function cleanDriver(d: unknown, fb: TeamDriver): TeamDriver {
  const num = isObj(d) && fin(d["num"]) ? Math.round(d["num"]) : fb.num;
  return {
    name: cleanText(isObj(d) ? d["name"] : null, fb.name, 22, false),
    code: cleanText(isObj(d) ? d["code"] : null, fb.code, 3, true),
    num: Math.min(99, Math.max(0, num)),
  };
}

/** The car lane's enum id tables a kept livery string must name, when known (:348-355). */
export interface LiveryEnums {
  readonly finShape?: readonly string[];
  readonly numFont?: readonly string[];
  readonly finish?: readonly string[];
}

export function liveryEnumOk(k: string, v: unknown, enums: LiveryEnums = {}): boolean {
  if (typeof v !== "string" || v in Object.prototype) return false;
  const ids = k === "finShape" ? enums.finShape : k === "numFont" ? enums.numFont : k === "finish" ? enums.finish : undefined;
  return !ids || ids.indexOf(v) >= 0;
}

/** Rebuild a stored or imported My Team record to the dialog's limits; repair, never discard (:356-385). */
export function sanitizeCustom(t: unknown, enums: LiveryEnums = {}): TeamRecord {
  const D = DEFAULT_CUSTOM;
  const src = isObj(t) ? t : {};
  const rows = Array.isArray(src["drivers"]) ? (src["drivers"] as unknown[]).filter(isObj).slice(0, CUSTOM_MAX_DRIVERS) : [];
  const stats: Record<string, number> = {};
  const sStats = src["stats"];
  for (const k of Object.keys(D.stats)) {
    const v = isObj(sStats) ? sStats[k] : undefined;
    stats[k] = fin(v) ? Math.min(100, Math.max(0, v)) : (D.stats as unknown as Record<string, number>)[k] as number;
  }
  const livery: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(isObj(src["livery"]) ? src["livery"] as Record<string, unknown> : D.livery as Record<string, unknown>)) {
    if (k === "__proto__") continue;
    if (typeof v === "string") { const s = cleanText(v, "", 32, false); if (s && liveryEnumOk(k, s, enums)) livery[k] = s; }
    else if (Array.isArray(v) && v.length === 3 && v.every(fin)) livery[k] = cleanRgb(v, [0, 0, 0]);
  }
  const tier = src["tier"];
  return {
    id: "custom", custom: true,
    name: cleanText(src["name"], D.name, 22, false),
    short: cleanText(src["short"], D.short, 4, true),
    engine: cleanText(src["engine"], D.engine, 16, false),
    tier: Number.isInteger(tier) && (tier as number) >= 0 && (tier as number) <= 4 ? tier as number : D.tier,
    color: cleanRgb(src["color"], D.color),
    color2: cleanRgb(src["color2"], D.color2),
    stats: stats as unknown as TeamStats,
    livery,
    drivers: rows.length ? rows.map((d) => cleanDriver(d, D.drivers[0] as TeamDriver)) : D.drivers.map((d) => cleanDriver(d, d)),
  };
}
