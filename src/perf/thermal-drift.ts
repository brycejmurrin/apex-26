/**
 * ThermalDrift: a pure, clock-free helper for a phone that throttles over a
 * long session (#2652). It never touches physics, the renderer or storage.
 * Ported verbatim from f1-game js/perf/thermal-drift.js:1-63.
 *
 * drift(): a slow-drift detector. The governor reacts to frame MISSES; a phone
 * that is slowly heating gets there minutes later than its cost curve says.
 * Frames are cut into WINDOW_MS windows by their own durations, each window
 * reduces to its p50, the first BASE_WINDOWS (after WARM_WINDOWS of settling)
 * fix the baseline, and an EMA of later window p50s above baseline*(1+OVER)
 * (and at least MIN_OVER_MS above it) says "due". It only SAYS due: the
 * governor decides whether a rung may move and acks with stepped(), which
 * re-baselines on the cheaper state and starts a cooldown. Vsync-bound p50 is
 * flat at the refresh interval until the work no longer fits it, so this reads
 * drift earlier than a miss streak but not before the frame budget is tight.
 * The opt-in 45 / 30 fps render tier lives in ./render-rate.ts.
 */

export const WINDOW_MS = 10000;
const WARM_WINDOWS = 1;        // the first window is shader warm-up and the intro: not the baseline
const BASE_WINDOWS = 6;        // the first minute after it
const EMA_ALPHA = 0.15;        // ~6 windows: a minute, not a hitch
const OVER = 0.12;             // 12 % slower than the baseline p50 ...
const MIN_OVER_MS = 1.0;       // ... and by at least a millisecond (a 60 fps floor jitters by less)
const COOL_WINDOWS = 6;        // after a step, one minute before it may fire again
const MAX_STEPS = 4;           // the ladder is finite; a session never needs more
const MIN_WINDOW_FRAMES = 20;  // a window of a few frames (a menu stall) is no evidence

export interface DriftState {
  baseline: number;
  ema: number;
  due: boolean;
  steps: number;
  windows: number;
  cooling: boolean;
}

export interface Drift {
  /** One frame interval in ms. Returns true while a step is due and not yet acked. */
  feed(frameMs: number): boolean;
  /** The governor moved a rung: measure the cheaper state afresh and wait a minute. */
  stepped(): void;
  /** The session restarted (new race): forget everything. */
  reset(): void;
  state(): DriftState;
}

export function drift(): Drift {
  let buf: number[] = [], ms = 0, win = 0, base: number[] = [], baseline = 0, ema = 0, cool = 0, steps = 0, due = false;
  // a[length >> 1] of a non-empty array: callers guarantee the length (MIN_WINDOW_FRAMES / BASE_WINDOWS).
  function p50(a: number[]): number { a.sort((x, y) => x - y); return a[a.length >> 1] as number; }
  function closeWindow(): void {
    const ok = buf.length >= MIN_WINDOW_FRAMES;
    const m = ok ? p50(buf) : 0;
    buf = []; ms = 0; win++;
    if (!ok || win <= WARM_WINDOWS) return;
    if (!baseline) {
      base.push(m);
      if (base.length >= BASE_WINDOWS) { baseline = p50(base.slice()); ema = baseline; }
      return;
    }
    ema += (m - ema) * EMA_ALPHA;
    if (cool > 0) { cool--; return; }
    if (steps < MAX_STEPS && ema > baseline * (1 + OVER) && ema - baseline >= MIN_OVER_MS) due = true;
    else due = false;
  }
  return {
    feed(frameMs) {
      if (!(frameMs > 0)) return due;
      buf.push(frameMs); ms += frameMs;
      if (ms >= WINDOW_MS) closeWindow();
      return due;
    },
    stepped() { steps++; due = false; baseline = 0; base = []; ema = 0; cool = COOL_WINDOWS; win = 0; buf = []; ms = 0; },
    reset() { buf = []; ms = 0; win = 0; base = []; baseline = 0; ema = 0; cool = 0; steps = 0; due = false; },
    state() { return { baseline, ema, due, steps, windows: win, cooling: cool > 0 }; },
  };
}
