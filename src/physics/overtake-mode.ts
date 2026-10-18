/**
 * OVERTAKE MODE (FIA 2026 Sporting Regs B7.2.3(c)): one Detection Line per
 * circuit, the 1 s check there, and the 0.5 MJ allowance granted at the
 * Activation Line and spent at will over the following lap. Pure per-car rules;
 * the step supplies the gap and the gates.
 *
 * Port of f1-game js/race/overtake-mode.js (`OvertakeMode`, :2-155), verbatim.
 * The race lane may re-export it; it lives here because the player step's
 * ERS deploy depends on it bit for bit.
 */
import { PhysicsConsts } from "./consts";

export const DETECT_FRAC = 0.9;

/** The car fields OvertakeMode owns or reads. */
export interface OtCar {
  human: boolean;
  lap: number;
  s: number;
  code?: string | undefined;
  otE?: number | undefined;
  otOn?: boolean | undefined;
  otEarned?: boolean | undefined;
  otArmed?: boolean | undefined;
  otT?: number | undefined;
  _otS?: number | null | undefined;
  _otLap?: number | null | undefined;
  _otHold?: boolean | undefined;
  brakeDemand?: number | undefined;
}

/** The circuit fields detectS reads. `sceneryFrac` maps an authored frac into the racing frame (f1-game TrackSpace.sceneryFrac). */
export interface OtTrack {
  readonly total: number;
  readonly def?: { readonly otDetectFrac?: number } | null;
}

export function energy(): number {
  const P = PhysicsConsts;
  return (P.OT_MJ || 0.5) / (P.ES_MJ || 4);
}
export function mj(c: OtCar | null | undefined): number {
  return c && (c.otE as number) > 0 ? (c.otE as number) * (PhysicsConsts.ES_MJ || 4) : 0;
}

/**
 * The Detection Line as a racing-frame lap fraction. f1-game routes an authored
 * `otDetectFrac` through TrackSpace.sceneryFrac; that mapping is the track lane's,
 * so it arrives as `sceneryFrac` (identity when absent).
 */
export function detectFrac(def: OtTrack["def"], sceneryFrac?: (def: NonNullable<OtTrack["def"]>, f: number) => number): number {
  const f = def && def.otDetectFrac;
  if (Number.isFinite(f) && sceneryFrac) return sceneryFrac(def as NonNullable<OtTrack["def"]>, f as number);
  return DETECT_FRAC;
}
const _detectBy = new WeakMap<object, number>();
export function detectS(track: OtTrack | null | undefined, sceneryFrac?: (def: NonNullable<OtTrack["def"]>, f: number) => number): number {
  if (!track) return 0;
  let s = _detectBy.get(track);
  if (s === undefined) {
    s = detectFrac(track.def, sceneryFrac) * track.total;
    _detectBy.set(track, s);
  }
  return s;
}

/** Did a FORWARD step prevS → s pass `at`? Wrap-safe; a backward step or a jump of half a lap never counts. */
export function crossed(prevS: number, s: number, at: number, L: number): boolean {
  if (!(L > 0) || !Number.isFinite(prevS) || !Number.isFinite(s)) return false;
  const step = (((s - prevS) % L) + L) % L;
  if (!(step > 0) || step >= L / 2) return false;
  const to = (((at - prevS) % L) + L) % L;
  return to > 0 && to <= step;
}

export function reset(c: OtCar): void {
  c.otE = 0;
  c.otOn = false;
  c.otEarned = false;
  c.otArmed = false;
  c.otT = 0;
  c._otS = null;
  c._otLap = null;
  c._otHold = false;
}

/** Once per car per tick, BEFORE arming: the two lines. overtake-mode.js:72-109. */
export function lines(c: OtCar, track: OtTrack | null | undefined, gapAhead: number, open: boolean, at?: number): void {
  if (c._otLap == null || c._otS == null) {
    c._otLap = c.lap | 0;
    c._otS = c.s;
  }
  if (track && crossed(c._otS, c.s, at ?? detectS(track), track.total)) {
    c.otEarned = !!open && gapAhead < (PhysicsConsts.OT_GAP || 1);
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
    c.otEarned = false;
    c.otOn = false;
  }
}

export function arm(c: OtCar, gate: boolean, speedOK: boolean): boolean {
  if (!gate) c.otOn = false;
  c.otArmed = !!gate && !!speedOK && (c.otE as number) > 0 && !c.otOn;
  return c.otArmed;
}

/** After the fire decision; returns true on the tick it starts deploying. overtake-mode.js:126-137. */
export function prepare(c: OtCar, fire: boolean, gate: boolean, speedOK: boolean, pushS: number): boolean {
  let started = false;
  if (!gate || !((c.otE as number) > 0)) c.otOn = false;
  else if (fire && c.otOn && c.human) c.otOn = false;
  else if (fire && c.otArmed) {
    c.otOn = true;
    started = true;
  }
  c.otT = c.otOn && speedOK ? (c.otE as number) / (energy() / Math.max(0.5, pushS || 4)) : 0;
  return started;
}

/** Only actual current-tick thrust pays the allowance. overtake-mode.js:140-148. */
export function consume(c: OtCar, dt: number, thrust: boolean, pushS: number): number {
  if (!(thrust && c.otOn && (c.otT as number) > 0 && dt > 0)) {
    c.otT = 0;
    return 0;
  }
  const cost = (energy() / Math.max(0.5, pushS || 4)) * dt;
  const fraction = Math.min(1, (c.otE as number) / cost);
  c.otE = Math.max(0, (c.otE as number) - cost);
  if (c.otE <= 0) c.otOn = false;
  c.otT = c.otOn ? c.otE / (cost / dt) : 0;
  return fraction;
}
