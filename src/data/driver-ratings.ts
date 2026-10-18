/* DriverRatings: the five-axis skill table for the 2026 grid, plus two signed
 * style axes. Ported verbatim from f1-game js/data/driver-ratings.js:1-154.
 * Deliberately NOT in teams.ts: that file is the verified real-world grid
 * (names, numbers, colours); these numbers are the game's own opinion of
 * each driver.
 *
 * f1-game's IIFE global `DriverRatings` becomes named exports; `M4.clamp` and
 * `Hash32.fnv1a/mix` come from ./util (ported from js/core). Float operation
 * order is f1-game's throughout. */

import { clamp, fnv1a, mix } from "./util";

export type Axis = "pace" | "craft" | "awareness" | "consistency" | "experience";
export type StyleAxis = "aggression" | "optimism";

export const AXES: readonly Axis[] = ["pace", "craft", "awareness", "consistency", "experience"];
// Style axes: signed −30..+30, zero-mean across the authored grid, NEVER in
// overall()/skill() or the top-speed product. Appended after the quality tuple.
export const STYLE_AXES: readonly StyleAxis[] = ["aggression", "optimism"];
export const STYLE_SCALE = 30;   // authored units → traits −1..+1 via / STYLE_SCALE

/** The five quality axes (1..100) and the two style axes (−30..+30). */
export type DriverRating = Record<Axis | StyleAxis, number>;
/** The five quality axes alone: what Legends.ratingsFor returns (legends.js:224). */
export type QualityRating = Record<Axis, number>;

/** [pace, craft, awareness, consistency, experience, aggression?, optimism?] */
export type RatingRow = readonly [number, number, number, number, number, number?, number?];

// [pace, craft, awareness, consistency, experience, aggression, optimism].
// Slice 2: craft/awareness/consistency pairwise |r|<0.5; pace frozen.
// Slice 3: style columns interleaved by overall rank (sum 0 each).
export const BASE: Readonly<Record<string, RatingRow>> = {
  VER: [96, 96, 92, 94,  92,  30,  24], // still the pace king
  LEC: [94, 89, 84, 86,  84,  24,  18], // craft high; awareness soft spot kept
  NOR: [93, 78, 81, 90,  72, -18, -12], // 2025 champion — craft reshuffled for decorrelation
  PIA: [91, 74, 71, 90,  62, -10,  -8],
  RUS: [90, 82, 70, 90,  78,  12,  30], // metronome with optimistic brake markers
  HAM: [89, 95, 88, 88, 100, -30, -24], // pace has ebbed; racecraft has not
  SAI: [88, 88, 85, 88,  90, -24, -18],
  ALO: [86, 96, 76, 88, 100,  18,  12], // craft elite; OT product preserved vs tip
  GAS: [84, 84, 82, 82,  86, -12, -30],
  ALB: [84, 84, 81, 84,  78,   8,   6],
  ANT: [84, 90, 86, 74,  32,  -8,  -6], // quick, raw
  HUL: [82, 84, 86, 86,  94,  10,   8],
  OCO: [82, 82, 73, 80,  84,  -6, -10],
  HAD: [82, 78, 66, 78,  30,   2,   4],
  PER: [80, 88, 88, 74,  92,   6,  10],
  BEA: [80, 76, 78, 76,  34,  -2,  -4],
  LAW: [79, 76, 74, 74,  38,   1,   1],
  BOT: [79, 82, 76, 84,  96,   4,   2],
  COL: [78, 88, 85, 70,  30,  -4,  -2],
  BOR: [77, 72, 70, 73,  24,   0,   0],
  LIN: [76, 70, 85, 68,  12,   0,   0], // rookie
  STR: [74, 72, 87, 72,  80,  -1,  -1], // pay seat
};

// The MY TEAM free agents (Career.freeAgents(), f1-game js/career/career.js), keyed by
// code and kept OUT of BASE so the grid's statistics (zero-mean style, field
// mean pace, decorrelated columns) stay about the 22 real drivers. Without a row
// here get() fell back to fromTier(), which depends on the CALLER's tier: the
// hire tile asked with the agent's own tier and the race with the team's (a
// custom team is tier 2), so six of eight tiles promised a different driver
// than raced, and the cheapest hires raced like the dearest. An authored row
// answers the same whatever tier is passed; overall() rises with the asking
// price (pinned in f1-game tests/unit/career-hire-rating.test.mjs).
// TODO(lane-race): the career lane owns Career.freeAgents(); its codes must stay keys here.
export const HIRES: Readonly<Record<string, RatingRow>> = Object.freeze({
  FER2: [87, 85, 80, 82, 70],
  LNQ:  [85, 82, 79, 80, 64],
  SLZ:  [82, 78, 76, 76, 58],
  ASH:  [80, 77, 74, 75, 66],
  NKM:  [78, 74, 72, 72, 48],
  DVL:  [76, 73, 71, 71, 60],
  CHD:  [75, 70, 70, 68, 40],
  OKO:  [73, 68, 68, 66, 36],
});

// The unrated roll, Math.min(1.0, 0.92 + simRnd() * 0.1), puts ~20% of draws
// on the clamp for a true mean of ~0.968. SKILL_BASE/SKILL_SPAN put the
// GRID-MEAN pace (84) back on that 0.968 — otherwise handing every driver a
// rating would quietly make the whole field faster at every difficulty.
// Compressed alongside TIER_V (./teams) by the same factor (0.174)
// about the measured field mean (0.9679): mean skill unchanged, spread
// 3.19% -> ~0.6% across the field. The car still dominates, as in the sport.
export const SKILL_BASE = 0.94843;
export const SKILL_SPAN = 0.0232;    // × (pace/100)
export const SKILL_JITTER = 0.00522;

const roundClamp = (v: number, lo: number, hi: number): number => Math.round(clamp(v, lo, hi));

/** Hash32.fnv1a, re-exported under DriverRatings' name for it (driver-ratings.js:152). */
export const hash32 = fnv1a;

// Fallback for a code not in BASE. Anchored on the car's tier (a tier-4 seat
// rarely holds a 90-pace driver) and spread by the code's hash so two unknown
// drivers are not clones of each other.
export function fromTier(tier: number | null | undefined, code: string | null | undefined): DriverRating {
  const t = clamp((tier as number) | 0, 0, 4);   // `| 0` maps null/undefined/NaN to 0, as in f1-game
  const h = fnv1a(code || "???");
  const spread = (n: number): number => ((h >>> (n * 5)) & 31) - 15;      // -15..+16, stable per code
  // The style axes read a SECOND hash. spread(6) shifts by 30, which leaves 2
  // bits of a 32-bit hash, so optimism was always -15..-12 and every unrated
  // driver was ~-0.45 optimistic. Re-deriving them changes the style traits
  // of unrated codes only (MY TEAM hires, user codes, rivals); BASE/HIRES rows
  // and the five quality axes keep their exact values.
  const h2 = mix(h);
  const spread2 = (n: number): number => ((h2 >>> (n * 5)) & 31) - 15;
  const anchor = 88 - t * 4;
  return {
    pace:        roundClamp(anchor + spread(0) * 0.35, 60, 96),
    craft:       roundClamp(anchor + spread(1) * 0.45, 55, 96),
    awareness:   roundClamp(anchor + spread(2) * 0.50, 55, 94),
    consistency: roundClamp(anchor + spread(3) * 0.45, 55, 94),
    experience:  roundClamp(45 + spread(4) * 2.0, 5, 100),
    // Style from the second hash — not zero-mean for unrated codes (only BASE is).
    aggression:  clamp(spread2(0), -STYLE_SCALE, STYLE_SCALE),
    optimism:    clamp(spread2(1), -STYLE_SCALE, STYLE_SCALE),
  };
}

/** Career deltas per axis. Persisted data, so any value may be junk; only finite numbers apply. */
export type RatingDeltas = Readonly<Partial<Record<string, unknown>>>;

export function get(code: string, tier?: number | null, deltas?: RatingDeltas | null): DriverRating {
  // Own keys only: a persisted code of "constructor" / "__proto__" resolved to
  // a function and the rating came out NaN.
  const row = Object.hasOwn(BASE, code) ? BASE[code] : Object.hasOwn(HIRES, code) ? HIRES[code] : null;
  const r: DriverRating = row
    ? {
        pace: row[0], craft: row[1], awareness: row[2], consistency: row[3], experience: row[4],
        aggression: row[5] != null ? row[5] : 0,
        optimism: row[6] != null ? row[6] : 0,
      }
    : fromTier(tier, code);
  if (deltas) {
    // A delta is a finite number or nothing: a persisted "5" concatenated ("825") and Infinity pinned the axis.
    const dv = (k: string): number => { const v = deltas[k]; return typeof v === "number" && isFinite(v) ? v : 0; };
    for (const k of AXES) if (dv(k)) r[k] = clamp(r[k] + dv(k), 1, 100);
    // Career may not author style deltas; ignore unknown keys.
    for (const k of STYLE_AXES) if (dv(k)) r[k] = clamp(r[k] + dv(k), -STYLE_SCALE, STYLE_SCALE);
  }
  return r;
}

// A single headline number, weighted the way F1 25 weights it — mostly pace,
// with racecraft second. NOT display-only: career's silly season ranks the
// grid with it (the seat-swap gate and weakerSeat() in f1-game js/career/career.js), so
// a weighting change moves who changes teams in a saved career.
// Style axes are excluded by construction.
export function overall(r: QualityRating | null | undefined): number {
  if (!r) return 0;
  return Math.round(r.pace * 0.46 + r.craft * 0.26 + r.awareness * 0.12
                  + r.consistency * 0.12 + r.experience * 0.04);
}

export function skill(r: Pick<QualityRating, "pace" | "consistency">, roll: number): number {
  const jitter = (roll - 0.5) * SKILL_JITTER * (1 - r.consistency / 100);
  return clamp(SKILL_BASE + (r.pace / 100) * SKILL_SPAN + jitter, 0.90, 1.0);
}

/** Authored style unit (−STYLE_SCALE..+STYLE_SCALE) → trait −1..+1. */
export function style01(v: number | null | undefined): number {
  return clamp((v != null ? v : 0) / STYLE_SCALE, -1, 1);
}

/** The four car-mod multipliers buildPace reads (Parts mods, f1-game js/car/parts.js).
 *  TODO(lane-car): replace with the car lane's mods type once src/car/ exports it. */
export type BuildMods = Readonly<Partial<Record<"speed" | "accel" | "cornering" | "braking", number>>>;

// MY TEAM hire pace vs the works car — mean of the four mod axes. Pure; no RNG.
export function buildPace(built: { readonly mods: BuildMods }, works: { readonly mods: BuildMods }): number {
  const b = built.mods, w = works.mods;
  let sum = 0;
  for (const k of ["speed", "accel", "cornering", "braking"] as const) sum += (b[k] || 1) / (w[k] || 1);
  return sum / 4;
}
