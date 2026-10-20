/**
 * RenderRate: draw every second requestAnimationFrame when a PHONE's display
 * delivers rAF at 100 Hz or more. Ported verbatim from f1-game
 * js/perf/render-rate.js:1-111; the IIFE singleton became `createRenderRate()`
 * and the localStorage read takes a `RawStore` (key `a26.renderRate`).
 *
 * Safari renders web content at 60 Hz by default and 120 Hz is opt-in
 * (Settings > Safari > Advanced > Feature Flags > "Prefer Pages Rendering
 * Updates near 60fps", heise 2026-02-12; WebKit bug 173434), but a player who
 * turns that flag off, or a future WebKit default, would double GPU work and
 * heat with no governor rung to refuse it: PerfGov scales resolution and sheds
 * features, it never skips frames. Physics is untouched (the shell's fixed-step
 * accumulator steps 1/60 s chunks on its own, so handling is identical at any
 * refresh rate); only render and the HUD pass are skipped, and the skipped
 * frame's dt and ms are carried into the next drawn one so the camera damping
 * and HUD smoothing see the real elapsed time.
 *
 * Device class only: desktop 144 Hz monitors keep every frame, and an immersive
 * XR session (its own rAF, its own rate) is never gated. a26.renderRate = "off"
 * never skips, "half" forces it on any device (the test and A/B handle),
 * unset/"auto" = phones. "45" / "30" are the opt-in render-rate TIER (#2652):
 * while racing, draw 3-of-4 or every 2nd frame by earning rate/second credits
 * against the wall clock, so a 120 Hz display lands on the same rate; the first
 * WARM_FRAMES race frames always draw (handoff card, first presents). The
 * cadence is read off the rAF interval, which skipping does not change, so a
 * 30 Hz Low Power Mode device or a 60 Hz display never trips it. Enter: the
 * interval EMA stays under ENTER_MS for ENTER_FRAMES in a row; leave: it climbs
 * over LEAVE_MS. Evidence and rationale: f1-game issue #2652.
 *
 * Shell use (src/sim/loop.ts / src/app/): call `observe(ms)` every rAF, then
 * `if (gate(dt, ms, presenting, racing))` render + HUD with `dt()` / `ms()`.
 * The fixed physics steps run BEFORE the gate (f1-game game.js tickBody).
 */
import { localRawStore, type RawStore } from "./env";

export const RENDER_RATE_KEY = "a26.renderRate";
const ENTER_MS = 10.5;     // a 100 Hz+ display: 120 Hz is 8.3 ms, 90 Hz 11.1 ms (not gated)
const LEAVE_MS = 13.5;     // between 75 Hz and 60 Hz
const ENTER_FRAMES = 90;   // a second and a half of sustained fast cadence
const EMA_A = 0.1;
const MAX_SANE_MS = 100;   // a tab resume or stall is not a cadence sample

export const RENDER_RATE_MODES = ["auto", "off", "half", "45", "30"] as const;
export type RenderRateMode = (typeof RENDER_RATE_MODES)[number];
const WARM_FRAMES = 90;    // race-entry frames the tier never skips
const MAX_GAP_S = 1 / 20;  // render()'s own dt clamp: one drawn frame never carries more

export interface RenderRateState {
  mode: RenderRateMode;
  tier: number;
  mobile: boolean;
  half: boolean;
  active: boolean;
  emaMs: number;
  skipped: number;
  drawn: number;
}

export interface RenderRate {
  init(opts?: { isMobile?: boolean; store?: RawStore }): void;
  observe(ms: number): void;
  gate(dt: number, ms: number, presenting?: boolean, racing?: boolean): boolean;
  setMode(v: string): boolean;
  dt(): number;
  ms(): number;
  active(): boolean;
  state(): RenderRateState;
}

const isMode = (v: string): v is RenderRateMode => (RENDER_RATE_MODES as readonly string[]).indexOf(v) >= 0;

export function createRenderRate(): RenderRate {
  let mode: RenderRateMode = "auto";
  let credit = 0, live = 0;  // tier: banked draw credit, consecutive racing frames seen
  let mobile = false;
  let ema = 16.7;
  let fast = 0;
  let half = false;          // auto-mode: the display is fast enough to halve
  let phase = 0;
  let accDt = 0, accMs = 0;  // skipped frames' time, paid into the next drawn frame
  let outDt = 0, outMs = 0;
  let skipped = 0, drawn = 0;

  function init(opts?: { isMobile?: boolean; store?: RawStore }): void {
    mobile = !!(opts && opts.isMobile);
    let v = "";
    try { v = (opts?.store ?? localRawStore()).raw(RENDER_RATE_KEY) || ""; } catch { /* no storage: auto */ }
    mode = isMode(v) ? v : "auto";
    credit = 0; live = 0;
    ema = 16.7; fast = 0; half = false; phase = 0; accDt = 0; accMs = 0; skipped = 0; drawn = 0;
  }

  const tierRate = (): number => mode === "45" ? 45 : mode === "30" ? 30 : 0;

  /** Set the mode at run time (the debug hook). Persisting is the caller's. */
  function setMode(v: string): boolean {
    if (!isMode(v)) return false;
    mode = v; credit = 0; live = 0; phase = 0; accDt = 0; accMs = 0;
    return true;
  }

  function active(): boolean {
    return tierRate() > 0 || mode === "half" || (mode === "auto" && mobile && half);
  }

  /** One rAF interval in ms (call every tick, drawn or not). */
  function observe(ms: number): void {
    if (!(ms > 0) || ms > MAX_SANE_MS) return;
    ema += (ms - ema) * EMA_A;
    if (!half) {
      if (ema < ENTER_MS) { if (++fast >= ENTER_FRAMES) half = true; } else fast = 0;
    } else if (ema > LEAVE_MS) {
      half = false; fast = 0;
    }
  }

  /** True when this rAF should draw. After a true, dt() / ms() hold the time to render
   *  and update the HUD with (this frame's plus any skipped frame's). `presenting` is
   *  the XR comfort flag: an immersive session is never gated. */
  function gate(dt: number, ms: number, presenting?: boolean, racing?: boolean): boolean {
    const rate = tierRate();
    if (rate && !presenting) {
      if (!racing) { live = 0; credit = 0; } else {
        accDt += dt; accMs += ms;
        let draw = live++ < WARM_FRAMES;
        if (!draw) { credit = Math.min(2, credit + dt * rate); draw = credit >= 1 - 1e-6; if (draw) credit -= 1; }
        if (draw) { outDt = Math.min(accDt, MAX_GAP_S); outMs = accMs; accDt = 0; accMs = 0; drawn++; return true; }
        skipped++; return false;
      }
    }
    if (presenting || !active() || rate) {
      outDt = dt + accDt; outMs = ms + accMs; accDt = 0; accMs = 0; phase = 0; drawn++;
      return true;
    }
    accDt += dt; accMs += ms;
    if ((++phase & 1) === 1) { skipped++; return false; }
    outDt = accDt; outMs = accMs; accDt = 0; accMs = 0; drawn++;
    return true;
  }

  return {
    init, observe, gate, setMode,
    dt: () => outDt,
    ms: () => outMs,
    active,
    state: () => ({ mode, tier: tierRate() || 60, mobile, half, active: active(), emaMs: +ema.toFixed(2), skipped, drawn }),
  };
}
