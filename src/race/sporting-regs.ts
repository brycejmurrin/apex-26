/**
 * SPORTING REGULATIONS the player is held to, as pure rules: two dry compounds
 * (FIA 2026 SR B6.3.6), no passing under a caution (B5.12.2(c), B5.13.2(c)),
 * the championship-order grid (B2.5.4(a); grid.ts `champOrder`), false starts
 * (B5.11.1) and blue flags (ISC App. H 2.5.5(e); Driving Standards §K).
 *
 * Ported from f1-game js/race/sporting-regs.js (main @ 2026-10-18), constant
 * names and rule order kept. Deterministic: no clock, no RNG.
 */
import type { RaceCar } from "../contracts/race";
export { champOrder } from "./grid";

/** One stint in a car's tyre log (TyreModel.fit): `code` is the HUD letter S/M/H/I/W. */
export interface StintEntry {
  readonly code: string;
}

/** The car fields these rules read. `pitState` is the pit lane's ("none" on track). */
export type RegsCar = Pick<RaceCar, "code" | "retired" | "finished" | "prog" | "lap" | "finishT" | "speed" | "dsq" | "penalty"> & {
  pitState?: string;
  tyreLog?: readonly StintEntry[];
};

// ── 1. TWO DRY COMPOUNDS (:53-101) ─────────────────────────────────────────
export const DRY: readonly string[] = ["S", "M", "H"];
export const WET: readonly string[] = ["I", "W"];
export const SUSPENDED_PEN_S = 30;
export const DSQ_WHY = "one dry compound";

/** Distinct dry compounds run, and whether any wet-weather set was (:63-72). */
export function compoundsRun(log: readonly (StintEntry | null | undefined)[] | null | undefined): { dry: number; wet: boolean } {
  const seen = new Set<string>();
  let wet = false;
  for (const e of Array.isArray(log) ? log : []) {
    const code = e && e.code;
    if (code && DRY.indexOf(code) >= 0) seen.add(code);
    else if (code && WET.indexOf(code) >= 0) wet = true;
  }
  return { dry: seen.size, wet };
}

/** Breaks B6.3.6: fewer than two dry compounds and no wet set (:75-78). */
export function compoundShort(log: readonly (StintEntry | null | undefined)[] | null | undefined): boolean {
  const r = compoundsRun(log);
  return !r.wet && r.dry < 2;
}

export interface CompoundOpts {
  /** The race is one the rule covers (PitLane.twoCompoundApplies). */
  readonly applies: boolean;
  /** Ended under a red flag and not resumed. */
  readonly suspended?: boolean;
}

/** One car's verdict at the flag (:83-87). */
export function compoundVerdict(c: RegsCar | null | undefined, o: CompoundOpts | null | undefined): { dsq: string } | { penaltyS: number } | null {
  if (!c || !o || !o.applies || c.retired) return null;
  if (!compoundShort(c.tyreLog)) return null;
  return o.suspended ? { penaltyS: SUSPENDED_PEN_S } : { dsq: DSQ_WHY };
}

/** Apply to every car; returns the disqualified (:90-100). */
export function applyCompoundRule<C extends RegsCar>(cars: readonly (C | null | undefined)[] | null | undefined, o: CompoundOpts): C[] {
  const out: C[] = [];
  for (const c of cars || []) {
    if (c) delete c.dsq;
    const v = compoundVerdict(c, o);
    if (!v || !c) continue;
    if ("dsq" in v) { c.dsq = v.dsq; out.push(c); }
    else c.penalty = (c.penalty || 0) + v.penaltyS;
  }
  return out;
}

// ── 2. NO PASSING UNDER A CAUTION (:103-186) ───────────────────────────────
export const GIVE_BACK_S = 5;
export const CAUTION_MIN = 2;

/** 10 s for one place kept, 20 for two, 30 for more (:108). */
export function passPenaltyS(n: number): number { return n <= 0 ? 0 : n === 1 ? 10 : n === 2 ? 20 : 30; }
const inPit = (c: RegsCar | null | undefined): boolean => !!(c && c.pitState && c.pitState !== "none");
/** A car it is legal to pass under a caution (:110). */
export function exempt(o: RegsCar | null | undefined): boolean { return !o || !!o.retired || !!o.finished || inPit(o); }

export type PassEvent = { type: "warn"; n: number } | { type: "cleared" } | { type: "penalty"; n: number; sec: number };

export interface PassWatch<C extends RegsCar> {
  tick(p: C | null | undefined, field: readonly (C | null | undefined)[] | null | undefined, level: number, dt: number): PassEvent | null;
  reset(): void;
  info(): { owed: number; t: number; code: string | null };
}

/** One watcher per race for the local player (:117-185). */
export function createPassWatch<C extends RegsCar>(windowS?: number, troubled?: (o: C) => boolean): PassWatch<C> {
  const WIN = (windowS as number) > 0 ? windowS as number : GIVE_BACK_S;
  const fair = typeof troubled === "function" ? (o: C): boolean => exempt(o) || !!troubled(o) : (o: C): boolean => exempt(o);
  let ahead = new Set<C>(), now = new Set<C>(), primed = false, finished = false;
  const owed: C[] = [], lostTo: C[] = [];
  let t = 0;
  function reset(): void { ahead.clear(); now.clear(); primed = false; finished = false; owed.length = 0; lostTo.length = 0; t = 0; }
  function drop(list: C[], o: C): void { const i = list.indexOf(o); if (i >= 0) list.splice(i, 1); }
  function tick(p: C | null | undefined, field: readonly (C | null | undefined)[] | null | undefined, level: number, dt: number): PassEvent | null {
    if (!p) { reset(); return null; }
    now.clear();
    const finishPass = p.finished && !finished;
    for (const o of field || []) {
      if (!o || o === p || o.retired) continue;
      const aheadNow = finishPass && o.finished && (o.lap || 0) === (p.lap || 0)
        && Number.isFinite(p.finishT) && Number.isFinite(o.finishT)
        ? (o.finishT as number) < (p.finishT as number) : o.prog > p.prog;
      if (aheadNow) now.add(o);
    }
    let ev: PassEvent | null = null, gained = false;
    const caution = level >= CAUTION_MIN && !finished && !p.retired && !inPit(p);
    if (primed && caution) {
      for (const o of ahead) {
        const justBehind = finishPass && o.finished && (o.lap || 0) === (p.lap || 0) && !o.retired && !inPit(o)
          && Number.isFinite(p.finishT) && (o.finishT as number) >= (p.finishT as number) && !(typeof troubled === "function" && troubled(o));
        if (now.has(o) || (fair(o) && !justBehind)) continue;
        if (lostTo.indexOf(o) >= 0) { drop(lostTo, o); continue; }
        if (owed.indexOf(o) < 0) { owed.push(o); gained = true; }
      }
      for (const o of now) if (!ahead.has(o) && !fair(o) && owed.indexOf(o) < 0 && lostTo.indexOf(o) < 0) lostTo.push(o);
    }
    if (level < CAUTION_MIN) lostTo.length = 0;
    if (owed.length) {
      if (!p.finished) for (let i = owed.length - 1; i >= 0; i--) if (now.has(owed[i] as C) || exempt(owed[i])) owed.splice(i, 1);
      if (gained) {
        if (!(t > 0)) t = WIN;
        ev = { type: "warn", n: owed.length };
      }
      if (!owed.length) { t = 0; ev = { type: "cleared" }; }
      else if (p.finished || (t -= dt) <= 0) {
        const n = owed.length;
        owed.length = 0; t = 0;
        ev = { type: "penalty", n, sec: passPenaltyS(n) };
      }
    } else t = 0;
    const sw = ahead; ahead = now; now = sw;
    primed = true; finished = !!p.finished;
    return ev;
  }
  function info(): { owed: number; t: number; code: string | null } {
    return { owed: owed.length, t: +Math.max(0, t).toFixed(2), code: owed.length ? (owed[0] as C).code || null : null };
  }
  return { tick, reset, info };
}

// ── 4. BLUE FLAGS (:199-209, :236-297) ─────────────────────────────────────
export const BLUE_GAP_S = 1.2;
export const BLUE_VFLOOR = 0.26;
export const BLUE_WARN_S = 4;
export const BLUE_HOLD_S = 8;
export const BLUE_PEN_S = 5;

// ── 5. FALSE START (:211-233) ──────────────────────────────────────────────
export const JUMP_START_PEN_S = 5;
export const JUMP_START_WHY = "false start";
export const JUMP_START_THROTTLE = 0.12;
export const JUMP_START_REACT_S = 0.2;
export const JUMP_START_SPEED_VREF = 0.04;

/** Throttle already engaged at lights-out; auto-throttle exempt (:221-225). */
export function jumpStartEarlyThrottle(throttleLevel: unknown, autoThrottleOn: boolean): boolean {
  if (autoThrottleOn) return false;
  const t = typeof throttleLevel === "number" && isFinite(throttleLevel) ? throttleLevel : 0;
  return t > JUMP_START_THROTTLE;
}

/** Meaningful speed inside the minimum reaction window (:228-232). */
export function jumpStartFastLaunch(tSinceGreen: number, speed: unknown, vRef: number): boolean {
  if (!(vRef > 0) || !(tSinceGreen >= 0) || tSinceGreen >= JUMP_START_REACT_S) return false;
  const v = typeof speed === "number" && isFinite(speed) ? speed : 0;
  return v > vRef * JUMP_START_SPEED_VREF;
}

export interface BlueCtx {
  readonly total: number;
  readonly vRef: number;
  readonly caution?: number;
  readonly race?: boolean;
}

/** The lapping car the blue flag is shown for (:236-251). */
export function blueFlagCar<C extends RegsCar>(p: C | null | undefined, field: readonly (C | null | undefined)[] | null | undefined, o: BlueCtx | null | undefined): C | null {
  if (!p || !o || !(o.total > 0) || !(o.vRef > 0)) return null;
  if (p.finished || p.retired || inPit(p)) return null;
  const L = o.total, floor = o.vRef * BLUE_VFLOOR;
  let best: C | null = null, bestD = Infinity;
  for (const c of field || []) {
    if (!c || c === p || c.retired || c.finished || inPit(c)) continue;
    const up = (c.prog || 0) - (p.prog || 0);
    if (!(up > L * 0.5)) continue;
    const back = (((p.prog || 0) - (c.prog || 0)) % L + L) % L;
    if (!(back > 0) || back >= bestD) continue;
    if (back / Math.max(c.speed || 0, floor) <= BLUE_GAP_S) { best = c; bestD = back; }
  }
  return best;
}

export type BlueEvent = { type: "warn"; code: string | null } | { type: "penalty"; sec: number; code: string | null };

/** One watcher per race for the local player (:261-297). */
export function createBlueFlagWatch<C extends RegsCar>(troubled?: (p: C) => boolean): {
  tick(p: C | null | undefined, field: readonly (C | null | undefined)[] | null | undefined, ctx: BlueCtx | null | undefined, dt: number): BlueEvent | null;
  reset(): void;
  info(): { hold: number; warned: boolean; pen: boolean; code: string | null };
} {
  const bad = typeof troubled === "function" ? troubled : (): boolean => false;
  let hold = 0, warned = false, pen = false, code: string | null = null, who: C | null = null;
  function reset(): void { hold = 0; warned = false; pen = false; code = null; who = null; }
  function tick(p: C | null | undefined, field: readonly (C | null | undefined)[] | null | undefined, ctx: BlueCtx | null | undefined, dt: number): BlueEvent | null {
    if (!p || !ctx || !ctx.race || p.finished || p.retired || inPit(p)
        || ((ctx.caution as number) | 0) >= CAUTION_MIN || bad(p)) {
      reset();
      return null;
    }
    const lapper = blueFlagCar(p, field, ctx);
    if (!lapper) { reset(); return null; }
    if (who !== lapper) { hold = 0; warned = false; who = lapper; }
    code = lapper.code || null;
    hold += dt > 0 ? dt : 0;
    if (!warned && hold >= BLUE_WARN_S) {
      warned = true;
      return { type: "warn", code };
    }
    if (!pen && hold >= BLUE_HOLD_S) {
      pen = true;
      return { type: "penalty", sec: BLUE_PEN_S, code };
    }
    return null;
  }
  function info(): { hold: number; warned: boolean; pen: boolean; code: string | null } {
    return { hold: +Math.max(0, hold).toFixed(2), warned, pen, code };
  }
  return { tick, reset, info };
}
