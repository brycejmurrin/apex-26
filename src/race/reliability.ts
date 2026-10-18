/**
 * RELIABILITY: whether a car reaches the flag at all. A seeded per-round plan
 * of failures (`dnfAt` as a fraction of race distance, `dnfWhy`).
 *
 * Ported from f1-game js/race/reliability.js (main @ 2026-10-18). The career
 * reads (`Career.paceMult`, `TDEV_*`) and the fitted build's quality
 * (`buildQuality`, which needs the parts catalog) come in through `opts`.
 */
import type { RaceCar, ReliabilityLevel } from "../contracts/race";
import { unit } from "./hash32";

/** :7. */
export const LEVELS: Readonly<Record<ReliabilityLevel, number>> = { off: 0, low: 0.5, real: 1 };
/** :9. */
export const TIER_RISK: readonly number[] = [0.04, 0.055, 0.075, 0.10, 0.12];
/** :11. */
export const REASONS: readonly string[] = ["engine", "engine", "gearbox", "gearbox", "accident"];
/** :16. */
export const AT_LO = 0.06, AT_HI = 0.94;
/** :21. */
export const DEV_RELIEF = 0.40;
/** :23. */
export const BUILD_RELIEF = 0.33;
/** Career constants, js/career/career.js:28-29. */
export const TDEV_MAX = 8;
export const TDEV_TO_PACE = 0.0025;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export type ReliabilityCar = Pick<RaceCar, "tier" | "team" | "isPlayer" | "retired" | "dnf" | "dnfAt" | "dnfWhy" | "driverId" | "code">;

export interface ArmOpts {
  level?: ReliabilityLevel | string;
  seed?: number;
  round?: number;
  /** The player's fitted build quality, 0..1 (reliability.js buildQuality). */
  build?: number;
  networked?: boolean;
  /** Career.paceMult(teamId); 1 for an undeveloped team / outside a career. */
  paceMult?: (teamId: string | undefined) => number;
}

/** Team development as -1..1 (:31-34). */
export function devNorm(paceMult: number): number {
  const span = TDEV_MAX * TDEV_TO_PACE;
  return span ? clamp((paceMult - 1) / span, -1, 1) : 0;
}

/** :56-63. */
export function riskFor(car: ReliabilityCar, scale: number, build: number | undefined, networked: boolean | undefined, paceMult = 1): number {
  if (!scale) return 0;
  const tier = clamp(car.tier | 0, 0, TIER_RISK.length - 1);
  let risk = TIER_RISK[tier] as number;
  risk *= 1 - DEV_RELIEF * devNorm(paceMult);
  if (car.isPlayer && (build as number) > 0 && !networked) risk *= 1 - BUILD_RELIEF * clamp(build as number, 0, 1);
  return clamp(risk * scale, 0, 1);
}

/** Draw every car's failure plan for the round (:65-89). */
export function arm<C extends ReliabilityCar>(cars: C[], opts: ArmOpts = {}): C[] {
  const scale = LEVELS[opts.level as ReliabilityLevel] || 0;
  const seed = (opts.seed as number) >>> 0, round = (opts.round as number) | 0;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i] as C;
    c.retired = false; c.dnf = null; c.dnfAt = null; c.dnfWhy = null;
    if (!scale) continue;
    const who = c.driverId || c.code || ("i" + i);
    const pm = opts.paceMult ? opts.paceMult(c.team && c.team.id) : 1;
    if (unit(seed, "dnf", round, who) >= riskFor(c, scale, opts.build, opts.networked, pm)) continue;
    c.dnfAt = AT_LO + unit(seed, "dnfAt", round, who) * (AT_HI - AT_LO);
    c.dnfWhy = REASONS[Math.min(REASONS.length - 1,
      Math.floor(unit(seed, "dnfWhy", round, who) * REASONS.length))] as string;
  }
  return cars;
}

/** The planned failures, for debug/tests (:91-100). */
export function plan(cars: readonly ReliabilityCar[] | null | undefined): { idx: number; code: string; retired: boolean; why: string | null; at: number | null }[] {
  const out: { idx: number; code: string; retired: boolean; why: string | null; at: number | null }[] = [];
  (cars || []).forEach((c, i) => {
    if (!c.retired && c.dnfAt == null) return;
    out.push({ idx: i, code: c.code, retired: !!c.retired,
      why: c.dnf || c.dnfWhy || null,
      at: c.dnfAt != null ? +c.dnfAt.toFixed(4) : null });
  });
  return out;
}

export const isLevel = (v: unknown): v is ReliabilityLevel => typeof v === "string" && Object.prototype.hasOwnProperty.call(LEVELS, v);

/**
 * Retire a car whose drawn failure it has passed, when the race ends early
 * (f1-game js/game.js:2908-2915, endRace's solo sweep).
 */
export function sweepPassedFailures(cars: readonly (ReliabilityCar & Pick<RaceCar, "human" | "finished" | "prog" | "_progGift">)[], lapsTarget: number, total: number): void {
  const dist = Math.max(1, lapsTarget * total);
  for (const c of cars) {
    if (c.human || c.finished || c.retired || c.dnfAt == null || (c.prog - (c._progGift || 0)) / dist < c.dnfAt) continue;
    c.retired = true; c.dnf = c.dnfWhy || "mechanical"; c.dnfAt = null;
  }
}
