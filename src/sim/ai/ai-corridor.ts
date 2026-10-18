/**
 * AI-only reachable passing lanes. Read-only traffic inputs, no randomness.
 * Port of f1-game js/physics/ai-corridor.js (`AiCorridor`, :3-77), verbatim.
 */
import { passSideBonus, type OtPullCtx } from "./ai-drive";

/** The car fields the corridor reads (the per-tick traffic snapshot first). */
export interface CorridorCar {
  readonly x: number;
  readonly prog: number;
  readonly speed: number;
  readonly retired?: boolean;
  readonly finished?: boolean;
  readonly corridorAccel?: number | undefined;
  readonly _snapX?: number | undefined;
  readonly _snapProg?: number | undefined;
  readonly _snapSpeed?: number | undefined;
}

export interface CorridorLane {
  side: number;
  score: number;
  reason: string;
  target: number;
  seconds?: number;
}
export interface CorridorPlan {
  left: CorridorLane;
  right: CorridorLane;
  side: number;
  reason: string;
}
export type CorridorCtx = OtPullCtx & { roomL: number; roomR: number; roadL: number; roadR: number };

function crosses(s: number, x: number, vs: number, vx: number, seconds: number, accel = 0): boolean {
  let enter = 0,
    leave = seconds;
  if (Math.abs(vx) < 1e-8) {
    if (Math.abs(x) >= 2.2) return false;
  } else {
    const a = (-2.2 - x) / vx,
      b = (2.2 - x) / vx;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
  }
  if (enter >= leave) return false;
  const first = s + vs * enter + 0.5 * accel * enter * enter;
  const last = s + vs * leave + 0.5 * accel * leave * leave;
  let lo = Math.min(first, last),
    hi = Math.max(first, last);
  if (Math.abs(accel) > 1e-8) {
    const turn = -vs / accel;
    if (turn > enter && turn < leave) {
      const p = s + vs * turn + 0.5 * accel * turn * turn;
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
  }
  return lo < 5.2 && hi > -5.2;
}
function acceleration(car: CorridorCar): number {
  return Number.isFinite(car.corridorAccel) ? Math.max(-40, Math.min(20, car.corridorAccel as number)) : 0;
}
function snap(o: CorridorCar, key: "_snapX" | "_snapProg" | "_snapSpeed", live: number): number {
  const v = o[key];
  return Number.isFinite(v) ? (v as number) : live;
}
function candidate(
  ctx: CorridorCtx,
  car: CorridorCar,
  blocker: CorridorCar,
  cars: readonly CorridorCar[],
  total: number,
  clear: number,
  side: number,
  out: CorridorLane,
): void {
  const room = side > 0 ? Math.min(ctx.roomR, ctx.roadR) : Math.min(ctx.roomL, ctx.roadL);
  out.side = side;
  out.score = -Infinity;
  out.reason = "road too narrow";
  out.target = snap(blocker, "_snapX", blocker.x) + side * clear;
  if (room < clear || out.target < car.x - ctx.roadL || out.target > car.x + ctx.roadR) return;
  const lateral = out.target - car.x;
  const seconds = Math.max(0.4, Math.min(1.6, Math.abs(lateral) / 2.4));
  out.seconds = seconds;
  const reach = Math.max(car.speed, 10) * 1.5;
  const blockerSpeed = snap(blocker, "_snapSpeed", blocker.speed);
  const passT = Math.min(8, ((ctx.blockerGap || 0) + 6.3) / Math.max((ctx.freeSpeed || car.speed) - (ctx.blockerVmax || blockerSpeed), (ctx.vTop || 72) / 72));
  for (const other of cars) {
    if (other === car || other.retired || other.finished) continue;
    const oProg = snap(other, "_snapProg", other.prog),
      oX = snap(other, "_snapX", other.x),
      oSpeed = snap(other, "_snapSpeed", other.speed);
    const raw = oProg - car.prog;
    const gap = ((((raw + total / 2) % total) + total) % total) - total / 2;
    const closing = oSpeed - car.speed;
    const accel = acceleration(other) - acceleration(car);
    if (
      crosses(gap, oX - car.x, closing, -lateral / seconds, seconds, accel) ||
      crosses(gap + closing * seconds + 0.5 * accel * seconds * seconds, oX - out.target, closing + accel * seconds, 0, 0.5, accel)
    ) {
      out.reason = other === blocker ? "cannot clear the blocker in time" : "traffic in the passing lane";
      return;
    }
    if (!ctx.street && other !== blocker && gap > 0 && gap < reach && Math.abs(oX - out.target) < 2.2 && gap - (car.speed - oSpeed) * passT < 6) {
      out.reason = "traffic ahead in the passing lane";
      return;
    }
  }
  out.reason = "clear passing lane";
  out.score = Math.min(room, 8) * 0.25 - seconds + passSideBonus(ctx, side);
}

export function choose(
  ctx: CorridorCtx,
  car: CorridorCar,
  blocker: CorridorCar,
  cars: readonly CorridorCar[],
  total: number,
  clear: number,
  out: Partial<CorridorPlan> = {},
): CorridorPlan {
  out.left = out.left || { side: 0, score: 0, reason: "", target: 0 };
  out.right = out.right || { side: 0, score: 0, reason: "", target: 0 };
  candidate(ctx, car, blocker, cars, total, clear, -1, out.left);
  candidate(ctx, car, blocker, cars, total, clear, 1, out.right);
  const best = out.left.score > out.right.score ? out.left : out.right;
  out.side = Number.isFinite(best.score) ? best.side : 0;
  out.reason = out.side ? (out.side < 0 ? "pass left" : "pass right") : "follow: no reachable passing lane";
  return out as CorridorPlan;
}
