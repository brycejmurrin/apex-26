/**
 * The two SetupTune functions the player force model reads: the brake-bias
 * split of the friction ellipse and the anti-roll-bar axle grip.
 *
 * Port of f1-game js/garage/setup-tune.js:34 (`BB_REF`), :100-114 (`axleGrip`)
 * and :145-149 (`bbScales`), verbatim. The rest of SetupTune (the persisted
 * per-team sheet) is garage-lane work.
 */
import { PhysicsConsts } from "./consts";

export const BB_REF = PhysicsConsts.BB_REF;

export interface AxleGrip {
  f: number;
  r: number;
}

const axleOut: AxleGrip = { f: 1, r: 1 };
/** POOLED: the next call overwrites the returned object (setup-tune.js:100). */
export function axleGrip(bias: number | null | undefined, lateralAccel: number, frontLoad = 0.47): Readonly<AxleGrip> {
  axleOut.f = 1;
  axleOut.r = 1;
  if (!Number.isFinite(bias) || !bias || !Number.isFinite(lateralAccel)) return axleOut;
  const demand = Math.min(1, Math.abs(lateralAccel) / PhysicsConsts.LAT_MAX);
  const share = Math.max(0.2, Math.min(0.8, frontLoad + bias));
  const transfer = demand * 0.28;
  function capacity(load: number, shift: number): number {
    const half = load * 0.5,
      d = Math.min(half * 0.95, shift);
    return Math.pow(half + d, 0.85) + Math.pow(half - d, 0.85);
  }
  axleOut.f = capacity(frontLoad, transfer * share) / capacity(frontLoad, transfer * frontLoad);
  axleOut.r = capacity(1 - frontLoad, transfer * (1 - share)) / capacity(1 - frontLoad, transfer * (1 - frontLoad));
  return axleOut;
}

/** BRAKE BIAS → the friction ellipse's per-axle split. Allocates, as f1-game does. */
export function bbScales(bb: number | null | undefined): AxleGrip {
  const b = Number.isFinite(bb) ? (bb as number) : BB_REF;
  const cl = (v: number): number => Math.min(1.5, Math.max(0.6, v));
  return { f: cl(b / BB_REF), r: cl((1 - b) / (1 - BB_REF)) };
}
