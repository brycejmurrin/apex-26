/**
 * GripSteer: own-state steering cap at the front's peak slip. Assist-gated:
 * slider notch 1 = OFF, the shipped default. Reads only the player's bicycle
 * state (vLat, yawRate, speed, muF, steer), never the road arc.
 *
 * Port of f1-game js/physics/grip-steer.js (`GripSteer`, :10-142), verbatim.
 * The module-level slider state of f1-game becomes one instance per `create()`.
 *
 * Sign basis (f1-game docs/PHYSICS.md): +vLat = car RIGHT, +yawRate = nose
 * RIGHT, +steer turns RIGHT.
 */
import { clamp, lerp } from "./math";
import { CURVE_PEAK_X_F } from "./tyre-model";

export const TARGET = 0.95;
export const CR = 0.3;
export const TAU = 0.04;
export const V_LO = 2,
  V_HI = 6;
export const VX_FLOOR = 4;

export interface GripSteerState {
  vLat: number;
  yawRate: number;
  speed: number;
  muF: number;
  csFront: number;
  af: number;
  ar: number;
  braking: boolean;
  shaped: number;
  capSm: number;
  dt: number;
}

export interface GripSteerOut {
  delta: number;
  capSm: number;
}

/** Notch 1 = OFF (k = 0); notch 10 = full (k = 1). grip-steer.js:34-38. */
export function assistK(n: unknown): number {
  const v = +(n as number);
  if (!(v > 1)) return 0;
  return clamp((v - 1) / 9, 0, 1);
}
export function labelOf(v: number): string {
  return v <= 1 ? "OFF" : "GRIP " + v;
}

/** grip-steer.js:49-51: TyreModel is always loaded here, so its front peak. */
function frontPeakX(): number {
  return CURVE_PEAK_X_F || Math.PI / 2;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Pure over numbers. grip-steer.js:66-112. `kk` is required here (no module slider). */
export function apply(driverDelta: number, state: Partial<GripSteerState> | null | undefined, kk: number): GripSteerOut {
  const strength = +kk || 0;
  if (!(strength > 0) || !state) return { delta: driverDelta, capSm: (state && state.capSm) || 0 };

  const speed = +(state.speed as number) || 0;
  if (!(speed > 0)) return { delta: driverDelta, capSm: state.capSm || 0 };

  const blend = strength * smoothstep(V_LO, V_HI, speed);
  if (!(blend > 0)) return { delta: driverDelta, capSm: state.capSm || 0 };

  const vx = Math.max(Math.abs(speed), VX_FLOOR);
  const r = +(state.yawRate as number) || 0;
  const vLat = +(state.vLat as number) || 0;
  const af = +(state.af as number) || 1.2;
  const ar = +(state.ar as number) || 1.2;
  const muF = Math.max(+(state.muF as number) || 1, 0.5);
  const cs = Math.max(+(state.csFront as number) || 130, 1);

  const betaF = Math.atan2(vLat + af * r, vx);
  const betaR = Math.atan2(vLat - ar * r, vx);
  const s = Math.sign(driverDelta) || Math.sign(state.shaped as number) || 1;
  const alphaPk = ((frontPeakX() * muF) / cs) * TARGET;

  let capIn = alphaPk + Math.max(s * betaF, -0.5 * alphaPk);
  if (state.braking) capIn *= 0.9;
  const capCtr = (0.1 + 0.6 * CR) * alphaPk + s * betaR;
  const w = smoothstep(0, 0.05, s * betaR);
  let cap = lerp(capIn, capCtr, w);
  if (cap < 0.25 * alphaPk) cap = 0.25 * alphaPk;

  const dt = Math.max(+(state.dt as number) || 1 / 60, 1e-4);
  const a = 1 - Math.exp(-dt / TAU);
  const capSm = (state.capSm || 0) + (cap - (state.capSm || 0)) * a;

  const deltaCap = s * Math.min(Math.abs(driverDelta), capSm);
  const shaped = Math.abs(+(state.shaped as number) || 0);
  let self = clamp(-betaR * 0.35, -0.5 * alphaPk, 0.5 * alphaPk) - r * 0.012;
  self *= 1 - 0.7 * Math.min(shaped, 1);

  return { delta: lerp(driverDelta, deltaCap + self, blend), capSm };
}

/** The car fields `forPlayer` reads and writes. */
export interface GripSteerCar {
  vLat?: number;
  yawRateCur?: number;
  speed: number;
  gripSteerCapSm?: number | undefined;
}

export interface GripSteerOpts {
  readonly muF: number;
  readonly csFront: number;
  readonly af: number;
  readonly ar: number;
  readonly braking: boolean;
  readonly shaped: number;
  readonly dt: number;
}

export interface GripSteer {
  setLevel(v: unknown): void;
  level(): number;
  k(): number;
  /** Call-site helper for the player step: identity when the slider is OFF. grip-steer.js:115-133. */
  forPlayer(driverDelta: number, c: GripSteerCar | null | undefined, opts: GripSteerOpts | null | undefined): number;
}

export function create(): GripSteer {
  let level = 1;
  let k = 0;
  const _st: GripSteerState = {
    vLat: 0,
    yawRate: 0,
    speed: 0,
    muF: 0,
    csFront: 0,
    af: 0,
    ar: 0,
    braking: false,
    shaped: 0,
    capSm: 0,
    dt: 0,
  };
  const _out: GripSteerOut = { delta: 0, capSm: 0 };

  function setLevel(v: unknown): void {
    if (typeof v === "number" && isFinite(v)) {
      level = clamp(v, 1, 10);
      k = assistK(level);
    }
  }

  function forPlayer(driverDelta: number, c: GripSteerCar | null | undefined, opts: GripSteerOpts | null | undefined): number {
    if (!(k > 0) || !c || !opts) return driverDelta;
    _st.vLat = c.vLat || 0;
    _st.yawRate = c.yawRateCur || 0;
    _st.speed = c.speed;
    _st.muF = opts.muF;
    _st.csFront = opts.csFront;
    _st.af = opts.af;
    _st.ar = opts.ar;
    _st.braking = !!opts.braking;
    _st.shaped = opts.shaped;
    _st.capSm = c.gripSteerCapSm || 0;
    _st.dt = opts.dt;
    const out = apply(driverDelta, _st, k);
    c.gripSteerCapSm = out.capSm;
    _out.delta = out.delta;
    _out.capSm = out.capSm;
    return _out.delta;
  }

  return { setLevel, level: () => level, k: () => k, forPlayer };
}
