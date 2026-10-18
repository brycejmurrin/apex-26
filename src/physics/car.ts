/**
 * PhysCar: the car fields the physics modules read and write, beyond the
 * `CarState` contract subset. Every extra field is optional because f1-game
 * cars carry them as `undefined` until a module first writes them
 * (js/race/car-fields.js GROUPS), and several readers are behaviour-bearing on
 * that (`c.axEstSm ?? 0`, `c.brakeStab == null`).
 *
 * Lane-local on purpose: when the player step settles, the stable subset goes
 * to the coordinator as a `CarState` contract PR.
 * TODO(coordinator): fold the fields the sim needs into `CarState`.
 */
import type { CarState } from "../contracts";
import type { StatKey, TyreCar } from "./tyre-model";

/** Per-car performance multipliers (f1-game Parts.getMods / NEUTRAL_MODS). */
export type CarMods = Partial<Record<StatKey, number>>;

export interface PhysCar extends CarState, TyreCar {
  // CarState fields TyreCar also lists, re-stated required
  human: boolean;
  speed: number;
  yawRateCur: number;
  lap: number;
  prog: number;
  s: number;
  retired: boolean;
  finished: boolean;
  onKerb: boolean | undefined;
  offroad: boolean;
  mods?: CarMods | undefined;
  tyreWear: number;

  // combined slip / grip circle (player-forces.js)
  axEstSm?: number | undefined;
  axFrac?: number | undefined;
  axFracF?: number | undefined;
  axFracR?: number | undefined;
  brakeStab?: number | undefined;
  rearUtil?: number | undefined;
  frontUtil?: number | undefined;
  brakeBias?: number | null | undefined;
  rollBalance?: number | undefined;
  wheelLock?: number | undefined;
  lockHapT?: number | undefined;
  slipFactor?: number | undefined;
  gripFront?: number | undefined;
  gripRear?: number | undefined;
  forceFront?: number | undefined;
  forceRear?: number | undefined;
  gripSteerCapSm?: number | undefined;
  uslipDwell?: number | undefined;
  uslipHapT?: number | undefined;
  oslipHapT?: number | undefined;
  skidIntensity?: number | undefined;
  _dirtyAirMul?: number | undefined;
  _coachAssisted?: boolean | undefined;
  _aeroGrip?: number | undefined;
  _cueConditionGrip?: number | undefined;
  _cueCornering?: number | undefined;
  _cueBraking?: number | undefined;

  // walls (wall-clamp.js, wall-end-face.js)
  _prevS?: number | undefined;
  wasOnWall?: boolean | undefined;
  wallT?: number | undefined;
  wallHits?: number | undefined;
  collideT: number;
  team?: { readonly id: string } | null | undefined;
  seat?: number | undefined;
  _wireId?: number | null | undefined;

  // contact (collide.js)
  yawVis?: number | undefined;
  contactT?: number | undefined;
  kTurn?: number | undefined;
  _pushD?: number | undefined;
  _preColSpd?: number | undefined;
  _preColS?: number | undefined;
  _preColX?: number | undefined;
  _snapProg?: number | undefined;
  _snapX?: number | undefined;
  _snapSpeed?: number | undefined;
  _nOk?: boolean | undefined;
  _nProg?: number | undefined;
  _nX?: number | undefined;
  _nSpd?: number | undefined;
  passFailOf?: PhysCar | null | undefined;
  passFailT?: number | undefined;
}
