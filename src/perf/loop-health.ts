/**
 * LoopHealth: the frame-loop fault policy and the one heartbeat that outlives
 * the loop. Ported verbatim from f1-game js/perf/loop-health.js:1-89; the IIFE
 * singleton became `createLoopHealth(clock?)` and `Log` the perf log sink.
 *
 * A run of consecutive frame faults is tolerated (a null player in the async
 * startRace window heals on the next frame) and any clean frame pays it back;
 * at the cap the loop reports and rethrows, so a deterministic fault still
 * stops loudly. The heartbeat exists because every other health surface
 * freezes when the loop dies: PerfGov.fpsEMA() is written only inside
 * PerfGov.tick, so the METRICS and gfx-debug overlays (both on timers) keep
 * painting a plausible 60 fps over a frozen canvas. A `lastFrame` stamp taken
 * at the top of the frame is not the heartbeat either — a loop throwing every
 * frame keeps it fresh. Only clean() below is reached by a frame that finished.
 *
 * Shell use (src/sim/loop.ts): wrap the frame body; on success `clean()`, on a
 * throw `if (!fault(e)) throw e` (report and stop), else schedule the next rAF.
 */
import { nowMs, perfLog } from "./env";

// Consecutive throws tolerated before the loop stops: the transient shapes
// this exists for heal in one frame, and 8 is still a fraction of a second.
// These count FAULTS, not time — the same cap on any refresh rate by design.
const RUN_CAP = 8;
// Absolute ceiling: a run counter that any clean frame resets can never stop
// a fault that alternates clean/throw. 240 is ~four seconds of a half-broken
// loop at 60 fps, less on a faster display; a count, not a clock.
const TOTAL_CAP = 240;
// Log the first few faults, then thin out: the record is for the ring buffer
// the debug log reads, not 60 identical console lines a second
const LOG_FIRST = 5;
const LOG_EVERY = 60;
// TOTAL_CAP was once a per-TAB lifetime count that was never paid back, so a
// long PWA session whose transients each healed could have its loop killed
// hours later by a harmless fault. A quiet stretch this long forgets the tally
const QUIET_RESET_MS = 4000;

export interface LoopHealthState {
  frames: number;
  faults: number;
  run: number;
  cap: number;
  totalCap: number;
  stopped: boolean;
  lastFault: string;
  /** ms since the last clean frame; null, NOT 0, before any frame has completed. */
  staleMs: number | null;
}

export interface LoopHealth {
  /** A frame finished: pay the run back and stamp the heartbeat. */
  clean(): void;
  /** A frame threw. TRUE: schedule another frame. FALSE: at the cap, so the caller must report and rethrow. */
  fault(e: unknown): boolean;
  state(): LoopHealthState;
}

function faultMessage(e: unknown): string {
  const m = e && typeof e === "object" && "message" in e ? (e as { message: unknown }).message : undefined;
  return String((e && (m || e)) || "?").slice(0, 200);
}

export function createLoopHealth(now: () => number = nowMs): LoopHealth {
  let run = 0;
  let total = 0;
  let frames = 0;
  let lastCleanAt = 0;
  let lastFaultAt = 0;
  let lastMsg = "";
  let stopped = false;

  return {
    clean() {
      run = 0;
      frames++;
      lastCleanAt = now();
      if (total && !stopped && lastCleanAt - lastFaultAt > QUIET_RESET_MS) total = 0;
    },

    fault(e) {
      total++;
      run++;
      lastFaultAt = now();
      lastMsg = faultMessage(e);
      const survive = run < RUN_CAP && total < TOTAL_CAP;
      if (total <= LOG_FIRST || total % LOG_EVERY === 0 || !survive) {
        perfLog.error("game", `frame fault ${run}/${RUN_CAP} (total ${total}/${TOTAL_CAP})` +
          (survive ? "" : " — CAP REACHED, stopping the loop"), e);
      }
      if (!survive) stopped = true;
      return survive;
    },

    // Read by ./gfx-debug-overlay.ts on a timer — the one surface that still
    // paints after the loop is gone. `frames` is the liveness signal and
    // staleMs only colour: a healthy headless page measured staleMs 6993 with
    // the loop running (compositor-driven rAF), so a millisecond threshold
    // cannot tell a dead loop from a slow one, while a count that does not
    // advance between two observations is a stall on any hardware
    state() {
      return {
        frames,
        faults: total,
        run,
        cap: RUN_CAP,
        totalCap: TOTAL_CAP,
        stopped,
        lastFault: lastMsg,
        staleMs: lastCleanAt ? Math.round(now() - lastCleanAt) : null,
      };
    },
  };
}
