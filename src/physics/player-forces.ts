/**
 * PLAYER FORCES: combined-slip budget, axle grip circle, soft tyre forces and
 * the human rigid-body yaw/lateral integrate.
 *
 * Port of f1-game js/physics/player-forces.js (`PlayerForces`, :13-410),
 * verbatim in operation order. `create(G)` reads only the live tunables
 * (PLAYER_GRIP, FRONT_GRIP, DRIFT, YAW_*); per-tick locals arrive as an
 * explicit ctx bag. The Frenet world writeback (px/pz → s, x) stays in the
 * player step. Design notes for every block are in the f1-game file.
 */
import type { SimCtx } from "../contracts";
import type { PhysCar } from "./car";
import { PhysicsConsts as PC } from "./consts";
import type { DebrisFx, HapticsFx } from "./fx";
import type { GripSteer } from "./grip-steer";
import { clamp } from "./math";
import { axleGrip, bbScales, BB_REF } from "./setup-axle";
import {
  brakeBeta,
  brakeFront,
  CURVE_FALL_W_R,
  CURVE_FLOOR_R,
  CURVE_HOLD_R,
  CURVE_PEAK_X,
  CURVE_PEAK_X_F,
  lateralCurve,
  type Tyres,
} from "./tyre-model";

/** Soft-saturating lateral tyre force (accel units). player-forces.js:22-24. */
export function tyreSat(cs: number, a: number, mu: number, floor?: number, fallW?: number, hold?: number): number {
  return -mu * lateralCurve((cs * a) / mu, floor, fallW, hold);
}

/** The tunables `step` reads off the façade each call (player-forces.js:81-85). */
export type PlayerForcesTunables = Pick<SimCtx, "PLAYER_GRIP" | "FRONT_GRIP" | "DRIFT" | "YAW_INERTIA" | "YAW_DAMP">;

/** Per-tick locals from the player step. player-forces.js:36-41. */
export interface PlayerForcesCtx {
  readonly dt: number;
  readonly driverDelta: number;
  readonly assistDelta?: number;
  readonly lineDelta?: number;
  readonly onThrottle: boolean;
  readonly throttleLvl: number;
  readonly gearMult: number;
  readonly deploy: number;
  readonly braking: boolean;
  readonly surfaceMu: number;
  readonly kerbGrip: number;
  readonly bankMu: number;
  readonly modsCornering: number;
  readonly modsBraking?: number;
  readonly loadF: number;
  readonly loadR: number;
  readonly vertLoad: number;
  readonly af: number;
  readonly ar: number;
  readonly sp: number;
  readonly steer: number;
  readonly weatherGrip: number;
  readonly aeroDf: number;
  readonly dirtyMul: number;
  readonly coastCut: number;
  readonly vTopNow: number;
  readonly tyres: Pick<Tyres, "gripMul" | "axleSplit">;
}

/** Optional collaborators; absent = f1-game with that module unloaded or inert. */
export interface PlayerForcesDeps {
  readonly gripSteer?: GripSteer | null;
  readonly haptics?: HapticsFx | null;
  readonly debris?: DebrisFx | null;
}

export interface PlayerForces {
  step(c: PhysCar, ctx: PlayerForcesCtx): void;
  tyreSat: typeof tyreSat;
}

export function create(G: PlayerForcesTunables, deps: PlayerForcesDeps = {}): PlayerForces {
  const gripSteer = deps.gripSteer ?? null;
  const haptics = deps.haptics ?? null;
  const debris = deps.debris ?? null;
  // Pooled scratch for DebrisWorld.tyreMarble (read-only inside that hook).
  const _marbleArg = { lock: 0, slip: 0, speed: 0 };

  function step(c: PhysCar, ctx: PlayerForcesCtx): void {
    const dt = ctx.dt;
    const onThrottle = ctx.onThrottle;
    const throttleLvl = ctx.throttleLvl;
    const gearMult = ctx.gearMult;
    const deploy = ctx.deploy;
    const braking = ctx.braking;
    const loadF = ctx.loadF,
      loadR = ctx.loadR;
    const vertLoad = ctx.vertLoad;
    const surfaceMu = ctx.surfaceMu;
    const kerbGrip = ctx.kerbGrip;
    const bankMu = ctx.bankMu;
    const modsCornering = ctx.modsCornering;
    const af = ctx.af,
      ar = ctx.ar;
    let delta = 0;
    const driverDelta = Number.isFinite(ctx.driverDelta) ? ctx.driverDelta : 0;
    if (!(Number.isFinite(dt) && dt > 0)) return;
    const assistDelta = ctx.assistDelta || 0;
    const lineDelta = ctx.lineDelta || 0;
    const sp = ctx.sp;
    const steer = ctx.steer;
    const weatherGrip = ctx.weatherGrip;
    const aeroDf = ctx.aeroDf;
    const dirtyMul = ctx.dirtyMul;
    const coastCut = ctx.coastCut;
    const vTopNow = ctx.vTopNow;
    const tyres = ctx.tyres;

    const LONG_GRIP = PC.LONG_GRIP;
    const THR_VK = PC.THR_VK,
      THR_FLOOR = PC.THR_FLOOR,
      THR_CAP = PC.THR_CAP;
    const COAST_DRAG = PC.COAST_DRAG;
    const DOWNFORCE = PC.DOWNFORCE;
    const LAT_MAX = PC.LAT_MAX;
    const LOAD_SENS = PC.LOAD_SENS;
    const FRONT_WEIGHT = PC.FRONT_WEIGHT;
    const CS_FRONT = PC.CS_FRONT,
      CS_REAR = PC.CS_REAR;
    const BRAKE = PC.BRAKE;
    const PLAYER_GRIP = G.PLAYER_GRIP;
    const FRONT_GRIP = G.FRONT_GRIP;
    const DRIFT = G.DRIFT;
    const YAW_INERTIA = G.YAW_INERTIA;
    const YAW_DAMP = G.YAW_DAMP;

    // --- combined slip (traction circle), per axle. player-forces.js:87-125.
    const vAbs = Math.abs(c.speed);
    const vStdNow = (vAbs * (PC.VMAX || 72)) / Math.max(vTopNow, 0.05);
    const thrOn = onThrottle && !braking;
    const axThrDemand = thrOn
      ? clamp(THR_VK / Math.max(vStdNow, 1), THR_FLOOR, THR_CAP) * (c.human ? throttleLvl : 1) * gearMult + Math.max(0, deploy) / LONG_GRIP
      : 0;
    const longBudget = LONG_GRIP * weatherGrip;
    const decel = Math.max(0, -(c.axEstSm ?? 0));
    const cdNow = COAST_DRAG * (1 - coastCut * (c.aeroX || 0));
    const brakeMix = clamp((decel - cdNow) / (0.5 * cdNow), 0, 1);
    const brakeScale = Math.max(1, (c.mods && c.mods.braking) || 1);
    const pedal = (decel * brakeMix) / (longBudget * brakeScale),
      engine = (decel - decel * brakeMix) / longBudget,
      beta = (c.brakeStab = brakeBeta(c.brakeStab, c.rearUtil, dt));
    const axFracF = Math.min(1, pedal * brakeFront(beta, loadF, loadR)),
      axFracR = Math.min(1, Math.max(pedal * beta + engine, axThrDemand));
    const axFrac = Math.max(axFracF, axFracR);
    c.axFrac = axFrac;
    c.axFracF = axFracF;
    c.axFracR = axFracR;
    // --- friction limit per axle (the grip circle). player-forces.js:144-160.
    const aeroGrip = (1 + DOWNFORCE * aeroDf * Math.min(1, (vAbs / vTopNow) ** 2)) * dirtyMul;
    c._dirtyAirMul = dirtyMul;
    c._coachAssisted = Math.abs(assistDelta) + Math.abs(lineDelta) > 1e-6;
    c._aeroGrip = aeroGrip;
    const surfMu = surfaceMu;
    const marbleMu = debris && debris.active() ? debris.marbleGrip(c) : 1;
    const tyreMu = tyres.gripMul(c);
    c._cueConditionGrip = clamp(weatherGrip * tyreMu, 0.25, 1);
    c._cueCornering = clamp(modsCornering, 0.25, 1);
    c._cueBraking = Number.isFinite(ctx.modsBraking) ? clamp(ctx.modsBraking as number, 0.25, 1) : 1;
    const tyreAx = tyres.axleSplit(c);
    const bbOn = (c.axEstSm ?? 0) < 0 && c.brakeBias != null && c.brakeBias !== BB_REF;
    const bb = bbOn ? bbScales(c.brakeBias) : null;
    const afF = bb ? Math.min(1, axFracF * bb.f) : axFracF;
    const afR = bb ? Math.min(1, Math.max(engine + pedal * beta * bb.r, axThrDemand)) : axFracR;
    // LOCK-UP (render + feel only). player-forces.js:190-208.
    const lockOn = PC.WHEEL_LOCK_ONSET + PC.WHEEL_LOCK_ONSET_SLOW * clamp(1 - vStdNow / Math.max(PC.WHEEL_LOCK_V_HIGH, 1), 0, 1);
    const lockRange = PC.WHEEL_LOCK_RANGE;
    c.wheelLock = braking && c.speed > 0 && afF > lockOn ? clamp((afF - lockOn) / lockRange, 0, 1) : 0;
    c.flatSpot = clamp((c.flatSpot || 0) + c.wheelLock * dt * 0.4 - dt / 90, 0, 1);
    if (c.isPlayer && c.wheelLock > 0.25 && (c.lockHapT = (c.lockHapT || 0) - dt) <= 0) {
      if (haptics) haptics.rumble(0.25 + c.wheelLock * 0.45, 90, "brake");
      c.lockHapT = 0.14;
    }
    const bbSlipF = Math.sqrt(Math.max(0, 1 - afF * afF));
    const bbSlipR = Math.sqrt(Math.max(0, 1 - afR * afR));
    c.slipFactor = bbSlipR;
    const muBase =
      LAT_MAX * PLAYER_GRIP * aeroGrip * surfMu * kerbGrip * weatherGrip * modsCornering * bankMu * (1 + vertLoad) * marbleMu * tyreMu;
    const rollAx = axleGrip(c.rollBalance, c.lateralAccel || 0, loadF);
    const muF = Math.max(
      0.5,
      muBase * bbSlipF * loadF * (1 - LOAD_SENS * (loadF / FRONT_WEIGHT - 1)) * FRONT_GRIP * tyreAx.f * rollAx.f,
    );
    const gripped =
      gripSteer && gripSteer.forPlayer
        ? gripSteer.forPlayer(driverDelta, c, { muF, csFront: CS_FRONT, af, ar, braking, shaped: steer, dt })
        : driverDelta;
    delta = clamp(gripped + assistDelta + lineDelta, -0.7, 0.7);
    const muR = Math.max(
      0.5,
      muBase * bbSlipR * loadR * (1 - LOAD_SENS * (loadR / (1 - FRONT_WEIGHT) - 1)) * (1 - DRIFT * 0.55) * tyreAx.r * rollAx.r,
    );
    const csR = CS_REAR * (1 - DRIFT * 0.4);
    // --- slip angles. player-forces.js:225-240.
    const DIR_BLEND = 1;
    const vx = Math.max(vAbs, 4),
      dirS = clamp(c.speed / DIR_BLEND, -1, 1);
    const slipF = Math.atan2((c.vLat || 0) + af * (c.yawRateCur || 0), vx) - dirS * delta;
    const slipR = Math.atan2((c.vLat || 0) - ar * (c.yawRateCur || 0), vx);
    if (debris && debris.active()) {
      _marbleArg.lock = axFrac;
      _marbleArg.slip = Math.max(Math.abs(slipF), Math.abs(slipR));
      _marbleArg.speed = c.speed;
      debris.tyreMarble(c, _marbleArg);
    }
    const Fyf = tyreSat(CS_FRONT, slipF, muF) * sp;
    const Fyr = tyreSat(csR, slipR, muR, CURVE_FLOOR_R, CURVE_FALL_W_R, CURVE_HOLD_R) * sp;
    const cosD = Math.cos(delta);
    const sat = Math.abs(CS_FRONT * slipF) / Math.max(muF, 1e-3);
    const satR = Math.abs(csR * slipR) / Math.max(muR, 1e-3);
    // Front/rear saturation cues: feedback only (player-forces.js:265-327).
    // f1-game gates the block on `typeof Input !== "undefined"`, which is
    // always true in the game, so the cue timers advance whether or not a
    // haptics sink is attached.
    if (c.isPlayer && !c.offroad && sp > 0.5) {
      const asking = Math.abs(steer) > 0.15;
      const hot = sat > 1.15 && asking;
      c.uslipDwell = hot ? Math.min((c.uslipDwell || 0) + 1, 3) : 0;
      if (c.uslipDwell >= 2 && (c.uslipHapT = (c.uslipHapT || 0) - dt) <= 0) {
        const bite = clamp((sat - 1.15) / 0.85, 0, 1);
        if (haptics) {
          haptics.vibrate((10 + bite * 18) | 0);
          haptics.rumble(0.18 + bite * 0.32, 70);
        }
        c.uslipHapT = 0.16 - bite * 0.06;
      }
      const pastR = satR / CURVE_HOLD_R,
        pastF = sat / CURVE_PEAK_X_F;
      if (pastR > 1 && pastR > pastF && (c.oslipHapT = (c.oslipHapT || 0) - dt) <= 0) {
        const bite = clamp(pastR - 1, 0, 1);
        if (haptics) {
          haptics.vibrate((18 + bite * 22) | 0);
          haptics.rumble(0.3 + bite * 0.4, 110, "throttle");
        }
        c.oslipHapT = 0.24 - bite * 0.08;
      }
    }
    // --- rigid-body equations of motion (per unit mass). player-forces.js:328-404.
    const ay = Fyf * cosD + Fyr;
    c.lateralAccel = ay;
    c.slipFront = slipF;
    c.slipRear = slipR;
    c.steerAngle = delta;
    c.gripFront = muF;
    c.gripRear = muR;
    c.forceFront = Fyf;
    c.forceRear = Fyr;
    c.frontUtil = sat / CURVE_PEAK_X_F;
    c.rearUtil = satR / CURVE_PEAK_X;
    const kz2 = Math.max(1e-3, af * ar * YAW_INERTIA);
    const coastYaw =
      !onThrottle && !braking
        ? (PC.COAST_YAW_DAMP || 0) *
          clamp(((c.rearUtil || 0) - (PC.COAST_YAW_LO || 0.65)) / Math.max((PC.COAST_YAW_HI || 1.1) - (PC.COAST_YAW_LO || 0.65), 1e-3), 0, 1)
        : 0;
    const SPEED_YAW_LO = 50,
      SPEED_YAW_HI = 65,
      SPEED_YAW_EXTRA = 5;
    const _syT = clamp((vAbs - SPEED_YAW_LO) / (SPEED_YAW_HI - SPEED_YAW_LO), 0, 1);
    const speedYawDamp = 1 + SPEED_YAW_EXTRA * _syT * _syT * (3 - 2 * _syT);
    const yawBrakeCap = BRAKE * (1 + (brakeScale - 1) * brakeMix);
    const brakeYawDamp = 1 + 1.4 * clamp(decel / yawBrakeCap, 0, 1) + coastYaw;
    const vLat0 = c.vLat || 0;
    const r0 = c.yawRateCur || 0;
    const u0 = c.speed;
    const LOW_YAW_V = 8;
    const LOW_YAW_SUBS = 4;
    if (vAbs >= LOW_YAW_V) {
      const rdot = (af * Fyf * cosD - ar * Fyr) / kz2 - YAW_DAMP * brakeYawDamp * speedYawDamp * (c.yawRateCur || 0);
      c.vLat = clamp(vLat0 + (ay - u0 * r0) * dt, -40, 40);
      if (sp < 1 && c.vLat) c.vLat = Math.sign(c.vLat) * Math.max(0, Math.abs(c.vLat) - muBase * (1 - sp) * dt);
      c.yawRateCur = clamp(r0 + rdot * dt, -4, 4);
      c.head -= c.yawRateCur * dt;
    } else {
      const rdot1 = (af * Fyf * cosD - ar * Fyr) / kz2 - YAW_DAMP * brakeYawDamp * speedYawDamp * r0;
      let v1 = clamp(vLat0 + (ay - u0 * r0) * dt, -40, 40);
      if (sp < 1 && v1) v1 = Math.sign(v1) * Math.max(0, Math.abs(v1) - muBase * (1 - sp) * dt);
      const r1 = clamp(r0 + rdot1 * dt, -4, 4);
      const head1 = c.head - r1 * dt;
      const h = dt / LOW_YAW_SUBS;
      let vL = vLat0,
        r = r0,
        head = c.head;
      for (let si = 0; si < LOW_YAW_SUBS; si++) {
        const sF = Math.atan2(vL + af * r, vx) - dirS * delta;
        const sR = Math.atan2(vL - ar * r, vx);
        const FyfI = tyreSat(CS_FRONT, sF, muF) * sp;
        const FyrI = tyreSat(csR, sR, muR, CURVE_FLOOR_R, CURVE_FALL_W_R, CURVE_HOLD_R) * sp;
        const ayI = FyfI * cosD + FyrI;
        const rdotI = (af * FyfI * cosD - ar * FyrI) / kz2 - YAW_DAMP * brakeYawDamp * speedYawDamp * r;
        vL = clamp(vL + (ayI - u0 * r) * h, -40, 40);
        if (sp < 1 && vL) vL = Math.sign(vL) * Math.max(0, Math.abs(vL) - muBase * (1 - sp) * h);
        r = clamp(r + rdotI * h, -4, 4);
        head -= r * h;
      }
      const _lyT = clamp((LOW_YAW_V - vAbs) / LOW_YAW_V, 0, 1);
      const w = _lyT * _lyT * (3 - 2 * _lyT);
      c.vLat = (1 - w) * v1 + w * vL;
      c.yawRateCur = (1 - w) * r1 + w * r;
      c.head = (1 - w) * head1 + w * head;
    }
    // Lateral→longitudinal coupling (planar bicycle). player-forces.js:390-404.
    const COUPLE_V_MIN = 3;
    if (vAbs >= COUPLE_V_MIN) {
      const couple = vLat0 * r0 - Fyf * Math.sin(delta);
      if (Number.isFinite(couple)) {
        let u1 = u0 + couple * dt;
        if (u0 > 0) u1 = Math.max(0, u1);
        else if (u0 < 0) u1 = Math.min(0, u1);
        c.speed = u1;
      }
    }
  }

  return { step, tyreSat };
}
