/**
 * Side effects the physics modules fire but never read back: pad/phone
 * haptics, collision audio, the cosmetic debris world and the incident sim.
 * In f1-game these are globals (`Input`, `GameAudio`, `DebrisWorld`,
 * `IncidentSim`); here they arrive as one optional bag, so a headless step
 * (tests, goldens) runs with none of them. None may change driving state.
 */
import type { PhysCar } from "./car";

export interface HapticsFx {
  /** f1-game js/input `Input.rumble(strength, ms, channel?)`. */
  rumble(strength: number, ms: number, channel?: string): void;
  /** f1-game `Input.vibrate(ms)`. */
  vibrate(ms: number): void;
}

export interface AudioFx {
  /** f1-game `GameAudio.collision(incidence, soft, side)`. */
  collision(incidence: number, soft: boolean, side: number): void;
  /** f1-game `GameAudio.fieldContact(kind, incidence, wx, wz, key)` (positional AI contact). */
  fieldContact?(kind: "bump" | "scrape", incidence: number, wx: number, wz: number, key: number): void;
}

/** The render-only Rapier debris side-world (f1-game js/physics/debris-world.js). Cosmetic. */
export interface DebrisFx {
  active(): boolean;
  marbleGrip(c: PhysCar): number;
  tyreMarble(c: PhysCar, arg: { readonly lock: number; readonly slip: number; readonly speed: number }): void;
  wallImpact(c: PhysCar, into: number, xOver: number): void;
  promoteBarrier(c: PhysCar, into: number, severity: number): void;
  carImpact(a: PhysCar, b: PhysCar, closing: number): void;
}

/** The incident-sim takeover (f1-game js/physics/incident-sim.js static API). */
export interface IncidentFx {
  owns(c: PhysCar): boolean;
  notifyWall(c: PhysCar, into: number, severity: number): void;
  notifyCar(a: PhysCar, b: PhysCar, closing: number): void;
}

export const NO_DEBRIS: DebrisFx = {
  active: () => false,
  marbleGrip: () => 1,
  tyreMarble: () => {},
  wallImpact: () => {},
  promoteBarrier: () => {},
  carImpact: () => {},
};

export const NO_INCIDENTS: IncidentFx = {
  owns: () => false,
  notifyWall: () => {},
  notifyCar: () => {},
};
