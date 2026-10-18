/**
 * Fixed-step simulation loop with render interpolation.
 *
 * Port of the accumulator in f1-game js/game.js:8337-8458 (`tickBody`):
 * - the wall-clock dt is clamped to [0, 1/4] s (game.js:8338: tab resume, a
 *   non-monotonic rAF stamp);
 * - physics advances in constant `FIXED_DT` chunks (js/physics/consts.js:282,
 *   1/60 s), at most `MAX_SUBSTEPS` (5) per frame (game.js:8427);
 * - when the cap is hit with a full step still owed, the whole-step backlog is
 *   dropped and the sub-step remainder kept (game.js:8440-8442);
 * - `alpha` is the leftover fraction `physAcc / FIXED_DT` clamped to 0..1, for
 *   interpolating between the last two physics poses (game.js:8446).
 *
 * The loop owns no game state: `beforeStep` is where callers snapshot the
 * previous pose (game.js:8432-8436 `rPrev*`), `step` advances the sim.
 */

/** f1-game js/physics/consts.js:282 `FIXED_DT`. */
export const FIXED_DT = 1 / 60;
/** game.js:8427 `steps < 5`. */
export const MAX_SUBSTEPS = 5;
/** game.js:8338 `Math.min(..., 1 / 4)`. */
export const MAX_FRAME_DT = 1 / 4;

export interface StepHooks {
  /** Called before each step; snapshot render-interpolation state here. */
  beforeStep?: () => void;
  /** Advance the simulation by `dt` (always `FIXED_DT`). */
  step: (dt: number) => void;
}

export interface FrameResult {
  /** Clamped wall-clock dt of this frame, seconds. */
  readonly dt: number;
  /** Physics steps taken this frame (0..MAX_SUBSTEPS). */
  readonly steps: number;
  /** Seconds of whole-step backlog dropped this frame (game.js:8438). */
  readonly dropped: number;
  /** 0..1 interpolation factor between the previous and current pose. */
  readonly alpha: number;
}

export class FixedStepLoop {
  /** Unspent simulated time, seconds (game.js `physAcc`). */
  acc = 0;
  /** Last rAF timestamp in ms, or null before the first frame. */
  private lastFrame: number | null = null;
  /** Time scale applied to the sim (game.js `simTime`, hit-stop). 1 = real time. */
  timeScale = 1;

  constructor(private readonly hooks: StepHooks) {}

  /** Feed one display frame at rAF timestamp `now` (ms). */
  frame(now: number, simulate = true): FrameResult {
    const last = this.lastFrame ?? now;
    const dt = Math.max(0, Math.min((now - last) / 1000, MAX_FRAME_DT));
    this.lastFrame = now;
    return this.advance(dt, simulate);
  }

  /** Advance by an already-clamped `dt` seconds of wall time. */
  advance(dt: number, simulate = true): FrameResult {
    let steps = 0;
    let dropped = 0;
    if (simulate) {
      this.acc += dt * this.timeScale;
      while (this.acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
        this.hooks.beforeStep?.();
        this.hooks.step(FIXED_DT);
        this.acc -= FIXED_DT;
        steps++;
      }
      dropped = steps === MAX_SUBSTEPS && this.acc >= FIXED_DT ? this.acc - this.acc % FIXED_DT : 0;
      if (dropped) this.acc %= FIXED_DT;
    }
    const alpha = Math.min(1, Math.max(0, this.acc / FIXED_DT));
    return { dt, steps, dropped, alpha };
  }

  /** Forget the last timestamp (call on resume so the gap is not simulated). */
  resetClock(): void {
    this.lastFrame = null;
  }
}

/** Linear interpolation between a previous and current value. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate an angle along the shorter arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}
