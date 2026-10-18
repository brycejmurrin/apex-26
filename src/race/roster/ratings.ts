/**
 * DRIVER RATINGS: the five-axis skill table plus two style traits for the
 * 2026 grid, the generated rating for anyone else, overall, and the AI skill
 * scale. Ported verbatim from f1-game js/data/driver-ratings.js (main @
 * 2026-10-18); the numbers are the game's opinion, not the verified grid.
 */
import { fnv1a, mix } from "../hash32";

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const AXES = ["pace", "craft", "awareness", "consistency", "experience"] as const;
export const STYLE_AXES = ["aggression", "optimism"] as const;
export const STYLE_SCALE = 30;

export type Axis = (typeof AXES)[number] | (typeof STYLE_AXES)[number];
export type Rating = Record<Axis, number>;

/** [pace, craft, awareness, consistency, experience, aggression, optimism] (:12-35). */
export const BASE: Readonly<Record<string, readonly number[]>> = {
  VER: [96, 96, 92, 94, 92, 30, 24], LEC: [94, 89, 84, 86, 84, 24, 18], NOR: [93, 78, 81, 90, 72, -18, -12],
  PIA: [91, 74, 71, 90, 62, -10, -8], RUS: [90, 82, 70, 90, 78, 12, 30], HAM: [89, 95, 88, 88, 100, -30, -24],
  SAI: [88, 88, 85, 88, 90, -24, -18], ALO: [86, 96, 76, 88, 100, 18, 12], GAS: [84, 84, 82, 82, 86, -12, -30],
  ALB: [84, 84, 81, 84, 78, 8, 6], ANT: [84, 90, 86, 74, 32, -8, -6], HUL: [82, 84, 86, 86, 94, 10, 8],
  OCO: [82, 82, 73, 80, 84, -6, -10], HAD: [82, 78, 66, 78, 30, 2, 4], PER: [80, 88, 88, 74, 92, 6, 10],
  BEA: [80, 76, 78, 76, 34, -2, -4], LAW: [79, 76, 74, 74, 38, 1, 1], BOT: [79, 82, 76, 84, 96, 4, 2],
  COL: [78, 88, 85, 70, 30, -4, -2], BOR: [77, 72, 70, 73, 24, 0, 0], LIN: [76, 70, 85, 68, 12, 0, 0],
  STR: [74, 72, 87, 72, 80, -1, -1],
};

/** The career's hireable free agents (:37-46). */
export const HIRES: Readonly<Record<string, readonly number[]>> = Object.freeze({
  FER2: [87, 85, 80, 82, 70], LNQ: [85, 82, 79, 80, 64], SLZ: [82, 78, 76, 76, 58], ASH: [80, 77, 74, 75, 66],
  NKM: [78, 74, 72, 72, 48], DVL: [76, 73, 71, 71, 60], CHD: [75, 70, 70, 68, 40], OKO: [73, 68, 68, 66, 36],
});

export const SKILL_BASE = 0.94843;
export const SKILL_SPAN = 0.0232;
export const SKILL_JITTER = 0.00522;

const roundClamp = (v: number, lo: number, hi: number): number => Math.round(clamp(v, lo, hi));

/** A stable generated rating for a code with no row (:54-72). */
export function fromTier(tier: number, code: string | null | undefined): Rating {
  const t = clamp(tier | 0, 0, 4);
  const h = fnv1a(code || "???");
  const spread = (n: number): number => ((h >>> (n * 5)) & 31) - 15;
  const h2 = mix(h);
  const spread2 = (n: number): number => ((h2 >>> (n * 5)) & 31) - 15;
  const anchor = 88 - t * 4;
  return {
    pace: roundClamp(anchor + spread(0) * 0.35, 60, 96),
    craft: roundClamp(anchor + spread(1) * 0.45, 55, 96),
    awareness: roundClamp(anchor + spread(2) * 0.50, 55, 94),
    consistency: roundClamp(anchor + spread(3) * 0.45, 55, 94),
    experience: roundClamp(45 + spread(4) * 2.0, 5, 100),
    aggression: clamp(spread2(0), -STYLE_SCALE, STYLE_SCALE),
    optimism: clamp(spread2(1), -STYLE_SCALE, STYLE_SCALE),
  };
}

/** A driver's rating with career deltas applied (:74-90). */
export function get(code: string, tier: number, deltas?: Partial<Record<Axis, unknown>> | null): Rating {
  const row = Object.hasOwn(BASE, code) ? BASE[code] : Object.hasOwn(HIRES, code) ? HIRES[code] : null;
  const r: Rating = row
    ? {
        pace: row[0] as number, craft: row[1] as number, awareness: row[2] as number, consistency: row[3] as number, experience: row[4] as number,
        aggression: row[5] != null ? row[5] : 0,
        optimism: row[6] != null ? row[6] : 0,
      }
    : fromTier(tier, code);
  if (deltas) {
    const dv = (k: Axis): number => { const v = deltas[k]; return typeof v === "number" && isFinite(v) ? v : 0; };
    for (const k of AXES) if (dv(k)) r[k] = clamp(r[k] + dv(k), 1, 100);
    for (const k of STYLE_AXES) if (dv(k)) r[k] = clamp(r[k] + dv(k), -STYLE_SCALE, STYLE_SCALE);
  }
  return r;
}

/** The headline number (:92-96). */
export function overall(r: Rating | null | undefined): number {
  if (!r) return 0;
  return Math.round(r.pace * 0.46 + r.craft * 0.26 + r.awareness * 0.12 + r.consistency * 0.12 + r.experience * 0.04);
}

/** The AI's ground-speed skill scale (:98-101). */
export function skill(r: Pick<Rating, "pace" | "consistency">, roll: number): number {
  const jitter = (roll - 0.5) * SKILL_JITTER * (1 - r.consistency / 100);
  return clamp(SKILL_BASE + (r.pace / 100) * SKILL_SPAN + jitter, 0.90, 1.0);
}

/** Authored style unit → trait −1..+1 (:104-106). */
export function style01(v: number | null | undefined): number { return clamp((v != null ? v : 0) / STYLE_SCALE, -1, 1); }

/** A build's pace against the works car, mean of the four mods (:108-113). */
export function buildPace(built: { mods: Partial<Record<keyof import("./teams").TeamStats, number>> }, works: { mods: Partial<Record<keyof import("./teams").TeamStats, number>> }): number {
  const b = built.mods, w = works.mods;
  let sum = 0;
  for (const k of ["speed", "accel", "cornering", "braking"] as const) sum += (b[k] || 1) / (w[k] || 1);
  return sum / 4;
}
