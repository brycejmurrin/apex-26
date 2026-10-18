/**
 * PACE / ERS math: vTop/vStd/aStd, X-mode aero gains, ERS drain/regen/overtake
 * duration, aeroDfMult, and gearHi/rpmFor.
 *
 * Port of f1-game js/race/pace-math.js (`PaceMath.create`, :9-110), verbatim.
 * `paceRef` (the AI's learned per-node pace profile) lands with the AI port.
 */
import { PhysicsConsts as PC } from "./consts";
import { clamp, lerp } from "./math";

export interface PaceDeps {
  /** Live OVERALL SPEED scale (DriveTune.PACE). */
  readonly getPACE: () => number;
  /** RaceControl `lowGrip()` (FIA 2026 B7.1.2(b): active aero is partial in the wet). */
  readonly lowGrip: () => boolean;
}

/** The car fields PaceMath reads. */
export interface PaceCar {
  aeroLoad?: number | null | undefined;
  aeroX?: number | undefined;
  ersDeploy?: number | null | undefined;
  ersRegen?: number | null | undefined;
  deploying?: boolean | undefined;
}

export interface PaceMath {
  vTop(): number;
  vStd(v: number): number;
  aStd(a: number): number;
  xVmaxGain(c: PaceCar | null | undefined): number;
  xDfLoss(c: PaceCar | null | undefined): number;
  xCoastCut(c: PaceCar | null | undefined): number;
  isErsDeploying(c: PaceCar | null | undefined): boolean;
  drainFor(c: PaceCar | null | undefined): number;
  regenFor(c: PaceCar | null | undefined): number;
  otTimeFor(c: PaceCar | null | undefined): number;
  aeroDfMult(c: PaceCar | null | undefined): number;
  gearHi(g: number): number;
  rpmFor(gear: number, speed: number): number;
}

export function create(deps: PaceDeps): PaceMath {
  const getPACE = deps.getPACE;
  const VMAX = PC.VMAX;
  const GEAR_TOP = PC.GEAR_TOP;

  function vTop(): number {
    return VMAX * Math.max(getPACE(), 0.05);
  }
  function vStd(v: number): number {
    return (v * VMAX) / vTop();
  }
  function aStd(a: number): number {
    return a / Math.max(getPACE(), 0.05);
  }
  function aeroLoadOf(c: PaceCar | null | undefined): number {
    return c && c.aeroLoad != null ? c.aeroLoad : 0.5;
  }
  function aeroWetK(): number {
    return deps.lowGrip() ? 0.5 : 1;
  }
  function xVmaxGain(c: PaceCar | null | undefined): number {
    return aeroWetK() * lerp(PC.X_VMAX_GAIN_LO, PC.X_VMAX_GAIN_HI, aeroLoadOf(c));
  }
  function xDfLoss(c: PaceCar | null | undefined): number {
    return aeroWetK() * lerp(PC.X_DF_LOSS_LO, PC.X_DF_LOSS_HI, aeroLoadOf(c));
  }
  function xCoastCut(c: PaceCar | null | undefined): number {
    return aeroWetK() * lerp(PC.X_COAST_CUT_LO, PC.X_COAST_CUT_HI, aeroLoadOf(c));
  }
  function isErsDeploying(c: PaceCar | null | undefined): boolean {
    if (!c) return false;
    return !!c.deploying;
  }
  function ersDeployOf(c: PaceCar | null | undefined): number {
    return c && c.ersDeploy != null ? c.ersDeploy : 0.5;
  }
  function ersRegenOf(c: PaceCar | null | undefined): number {
    return c && c.ersRegen != null ? c.ersRegen : 0.5;
  }
  function drainFor(c: PaceCar | null | undefined): number {
    return lerp(PC.DRAIN_HI, PC.DRAIN_LO, ersDeployOf(c));
  }
  function regenFor(c: PaceCar | null | undefined): number {
    return lerp(PC.REGEN_LO, PC.REGEN_HI, ersRegenOf(c));
  }
  function otTimeFor(c: PaceCar | null | undefined): number {
    return lerp(PC.OT_TIME_LO, PC.OT_TIME_HI, ersDeployOf(c));
  }
  function aeroDfMult(c: PaceCar | null | undefined): number {
    return 1 - xDfLoss(c) * ((c && c.aeroX) || 0);
  }
  function gearHi(g: number): number {
    return vTop() * (GEAR_TOP[g - 1] as number);
  }
  function rpmFor(gear: number, speed: number): number {
    const hi = gearHi(gear);
    const rpm = PC.MAX_RPM * (speed / Math.max(hi, 1));
    return clamp(rpm, PC.IDLE_RPM, PC.MAX_RPM * 1.04);
  }

  return { vTop, vStd, aStd, xVmaxGain, xDfLoss, xCoastCut, isErsDeploying, drainFor, regenFor, otTimeFor, aeroDfMult, gearHi, rpmFor };
}
