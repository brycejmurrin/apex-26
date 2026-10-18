/**
 * OVERTAKE MODE (FIA 2026 SR B7.2.3(c)): one Detection Line per circuit, the
 * 1 s check there, and the 0.5 MJ allowance granted at the Activation Line and
 * spent at will over the following lap. Pure per-car rules; the caller supplies
 * the gap and the gates.
 *
 * Ported from f1-game js/race/overtake-mode.js (main @ 2026-10-18). Constants
 * from js/physics/consts.js:191-193. `Log` lines are dropped; the track-space
 * remap of a circuit's `otDetectFrac` (TrackSpace.sceneryFrac) is passed in.
 */
import type { RaceCar } from "../contracts/race";

/** js/physics/consts.js:191-193. */
export const OT_GAP = 1.0;
export const OT_MJ = 0.5;
export const ES_MJ = 4;
/** Default Detection Line: 90 % of the lap from the timing line (:33). */
export const DETECT_FRAC = 0.9;

export type OtCar = Pick<RaceCar, "s" | "lap" | "human" | "otE" | "otOn" | "otEarned" | "otArmed" | "otT" | "_otS" | "_otLap" | "_otHold">;

/** The allowance in battery units, OT_MJ / ES_MJ (:37). */
export function energy(): number { return OT_MJ / ES_MJ; }
/** Allowance left, MJ (:38). */
export function mj(c: Pick<RaceCar, "otE"> | null | undefined): number { return c && (c.otE as number) > 0 ? (c.otE as number) * ES_MJ : 0; }

/** The circuit fields the Detection Line reads. */
export interface OtTrack {
  readonly total: number;
  readonly def?: { readonly otDetectFrac?: number } | null;
}

/** The Detection Line as a racing-frame lap fraction (:45-49). */
export function detectFrac(def: OtTrack["def"], sceneryFrac?: (def: NonNullable<OtTrack["def"]>, f: number) => number): number {
  const f = def && def.otDetectFrac;
  if (Number.isFinite(f) && sceneryFrac && def) return sceneryFrac(def, f as number);
  return DETECT_FRAC;
}

const detectBy = new WeakMap<object, number>();
/** The Detection Line in arc metres, memoised per track object (:50-56). */
export function detectS(track: OtTrack | null | undefined, sceneryFrac?: (def: NonNullable<OtTrack["def"]>, f: number) => number): number {
  if (!track) return 0;
  let s = detectBy.get(track);
  if (s === undefined) { s = detectFrac(track.def, sceneryFrac) * track.total; detectBy.set(track, s); }
  return s;
}

/** Did a forward step prevS -> s pass `at` on a lap of L? Wrap-safe (:60-66). */
export function crossed(prevS: number | null | undefined, s: number, at: number, L: number): boolean {
  if (!(L > 0) || !Number.isFinite(prevS) || !Number.isFinite(s)) return false;
  const p = prevS as number;
  const step = ((s - p) % L + L) % L;
  if (!(step > 0) || step >= L / 2) return false;
  const to = ((at - p) % L + L) % L;
  return to > 0 && to <= step;
}

/** :74-78. */
export function reset(c: OtCar): void {
  c.otE = 0; c.otOn = false; c.otEarned = false; c.otArmed = false; c.otT = 0;
  c._otS = null; c._otLap = null;
  c._otHold = false;
}

/**
 * Once per car per tick, before arming: the Detection and Activation lines
 * (:83-114). `open` is RaceControl's otDetectOpen.
 */
export function lines(c: OtCar, track: OtTrack | null | undefined, gapAhead: number, open: boolean,
  sceneryFrac?: (def: NonNullable<OtTrack["def"]>, f: number) => number): void {
  if (c._otLap == null || c._otS == null) { c._otLap = c.lap | 0; c._otS = c.s; }
  if (track && crossed(c._otS, c.s, detectS(track, sceneryFrac), track.total)) {
    c.otEarned = !!open && gapAhead < OT_GAP;
  }
  c._otS = c.s;
  if ((c.lap | 0) > c._otLap) {
    c._otLap = c.lap | 0;
    const left = c.otE as number;
    if (c.otEarned) {
      c.otE = energy();
      c._otHold = (c.lap | 0) === 1;
    } else if (c._otHold && left > 0) {
      c._otHold = false;
    } else {
      c.otE = 0;
      c._otHold = false;
    }
    c.otEarned = false; c.otOn = false;
  }
}

/** `gate`: race-wide otEnabled and the car's own; `speedOK`: above OT_MIN_SPEED (:118-122). */
export function arm(c: OtCar, gate: boolean, speedOK: boolean): boolean {
  if (!gate) c.otOn = false;
  c.otArmed = !!gate && !!speedOK && (c.otE as number) > 0 && !c.otOn;
  return c.otArmed;
}

/** After the fire decision; true on the tick deploying starts (:128-139). */
export function prepare(c: OtCar, fire: boolean, gate: boolean, speedOK: boolean, pushS?: number): boolean {
  let started = false;
  if (!gate || !((c.otE as number) > 0)) c.otOn = false;
  else if (fire && c.otOn && c.human) c.otOn = false;
  else if (fire && c.otArmed) { c.otOn = true; started = true; }
  c.otT = c.otOn && speedOK ? (c.otE as number) / (energy() / Math.max(0.5, pushS || 4)) : 0;
  return started;
}

/** Only actual current-tick thrust pays the allowance; returns the fundable fraction (:142-150). */
export function consume(c: OtCar, dt: number, thrust: boolean, pushS?: number): number {
  if (!(thrust && c.otOn && (c.otT as number) > 0 && dt > 0)) { c.otT = 0; return 0; }
  const cost = energy() / Math.max(0.5, pushS || 4) * dt;
  const fraction = Math.min(1, (c.otE as number) / cost);
  c.otE = Math.max(0, (c.otE as number) - cost);
  if (c.otE <= 0) c.otOn = false;
  c.otT = c.otOn ? c.otE / (cost / dt) : 0;
  return fraction;
}

/** Legacy pedal-based adapter (:153-157). */
export function spend(c: OtCar & { brakeDemand?: number }, dt: number, fire: boolean, gate: boolean, speedOK: boolean, pushS?: number): boolean {
  const started = prepare(c, fire, gate, speedOK, pushS);
  consume(c, dt, !((c.brakeDemand as number) > 0), pushS);
  return started;
}
