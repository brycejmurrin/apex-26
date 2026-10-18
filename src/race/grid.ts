/**
 * THE GRID: which rule orders it and the order it produces. Slot geometry is
 * the track's (TrackMesh.gridSlot); this file decides who sits where.
 *
 * Ported from f1-game (main @ 2026-10-18): GRID_RULES js/game.js:903-912,
 * `gridRule` :1602-1605, `gridOrderFor` :1606-1636, gridUp's own order
 * :1727-1752, `champOrder` js/race/sporting-regs.js:189-197.
 *
 * RNG STREAM CONTRACT (makeCars): every branch that does not take an explicit
 * order draws exactly one `rnd()` per car, so the stream position after the
 * grid is the same whichever rule ran.
 */
import type { RaceCar } from "../contracts/race";

export const GRID_RULES = ["tier", "quali", "rev10", "revchamp", "random"] as const;
export const CHAMP_GRID_RULES = ["champ", "tier", "revchamp", "random"] as const;
export type GridRule = (typeof GRID_RULES)[number] | (typeof CHAMP_GRID_RULES)[number];

export type GridCar = Pick<RaceCar, "tier" | "driverId">;

export interface GridRuleCtx {
  readonly timeTrial: boolean;
  readonly championship: boolean;
  /** SeasonCal.quali(): the championship format qualifies. */
  readonly seasonQuali: boolean;
  readonly champGrid: GridRule;
  readonly raceGrid: GridRule;
  readonly networked: boolean;
}

/** game.js:1602-1605. */
export function gridRule(ctx: GridRuleCtx): GridRule {
  const rule0: GridRule = ctx.timeTrial ? "tier" : ctx.championship ? (ctx.seasonQuali ? "quali" : ctx.champGrid) : ctx.raceGrid;
  return (rule0 === "random" && ctx.networked) ? "tier" : rule0;
}

/** Scorers by the standings, the rest by tier then id; null when nobody has scored (sporting-regs.js:189-197). */
export function champOrder<C extends GridCar>(cars: readonly C[] | null | undefined, cmp: (a: string, b: string) => number,
  ptsOf: (id: string) => number): C[] | null {
  const list = Array.isArray(cars) ? cars as readonly C[] : [];
  const scored = list.filter((c) => (ptsOf(c.driverId) || 0) > 0);
  if (!scored.length) return null;
  const rest = list.filter((c) => !((ptsOf(c.driverId) || 0) > 0));
  scored.sort((a, b) => cmp(a.driverId, b.driverId));
  rest.sort((a, b) => ((a.tier || 0) - (b.tier || 0)) || (String(a.driverId) < String(b.driverId) ? -1 : 1));
  return scored.concat(rest);
}

export interface GridOrderCtx<C extends GridCar> {
  readonly rule: GridRule;
  readonly cars: readonly C[];
  readonly championship: boolean;
  /** Championship points by driver id; null outside a season. */
  readonly pts: Readonly<Record<string, number>> | null;
  /** SeasonCal.rank(season, a, b). */
  readonly rank: (a: string, b: string) => number;
  readonly rnd: () => number;
}

/** The order the grid rule makes of `base` (a qualifying order, or null) (game.js:1606-1636). */
export function gridOrderFor<C extends GridCar>(base: readonly C[] | null, ctx: GridOrderCtx<C>): readonly C[] | null {
  const { rule, cars } = ctx;
  if (rule === "rev10" && base && base.length === cars.length) {
    return base.slice(0, 10).reverse().concat(base.slice(10));
  }
  if (rule === "revchamp" && ctx.championship && ctx.pts && !base && Object.values(ctx.pts).some((p) => p > 0)) {
    for (let i = 0; i < cars.length; i++) ctx.rnd();
    return cars.slice().sort((a, b) => ctx.rank(a.driverId, b.driverId)).reverse();
  }
  const pts = ctx.pts;
  const champ = rule === "champ" && ctx.championship && pts && !base
    ? champOrder(cars, ctx.rank, (id) => pts[id] || 0) : null;
  if (champ) { for (let i = 0; i < cars.length; i++) ctx.rnd(); return champ; }
  if (rule === "random" && !base) {
    const jit = new Map(cars.map((c) => [c, ctx.rnd()]));
    return cars.slice().sort((a, b) => (jit.get(a) as number) - (jit.get(b) as number));
  }
  return base;
}

/**
 * The grid itself (gridUp, game.js:1739-1752): an explicit full order as is;
 * otherwise tier then one jitter draw per car, with the player spliced to P12.
 * Returns the order; `gridPos` is set on each car (1-based).
 */
export function gridUp<C extends GridCar & Pick<RaceCar, "isPlayer"> & { gridPos?: number }>(cars: readonly C[], preOrder: readonly C[] | null,
  player: C | null, rnd: () => number): C[] {
  const order = preOrder && preOrder.length === cars.length ? preOrder.slice() : (() => {
    const jit = new Map(cars.map((c) => [c, rnd()]));
    const o = cars.slice().sort((a, b) => (a.tier - b.tier) || ((jit.get(a) as number) - (jit.get(b) as number)));
    const pi = player ? o.indexOf(player) : -1;
    if (pi >= 0 && player) {
      o.splice(pi, 1);
      o.splice(Math.min(11, o.length), 0, player);
    }
    return o;
  })();
  order.forEach((c, i) => { c.gridPos = i + 1; });
  return order;
}
