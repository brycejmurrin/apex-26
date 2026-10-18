/**
 * The AiDrive helpers the contact and wall code reads: masses, restitution,
 * rub and wall scrub rates, and which car of a level pair yields.
 *
 * Port of f1-game js/physics/ai-drive.js:289-315 (humanInvMass, rubDecel,
 * bumpRestitution, humanPuntCap), :1509-1516 (sideYieldsA) and :1597-1609
 * (wallHitLoss, wallSteerScrub, wallAiScrub), verbatim. The AI driving half of
 * AiDrive lands in src/sim/ai/ and re-exports these.
 */

export function humanInvMass(street: boolean): number {
  return street ? 0.42 : 0.5;
}

/** Side-rub deceleration, m/s^2. */
export function rubDecel(street: boolean): number {
  return street ? 3.5 : 3;
}

/** Rear-end restitution by closing speed: 0 below 1 m/s, 0.1 from 3 m/s, a ramp between. */
export function bumpRestitution(relV: number): number {
  const v = relV || 0;
  if (v <= 1) return 0;
  if (v >= 3) return 0.1;
  return (0.1 * (v - 1)) / 2;
}

/** Closing speed (m/s at PACE 1) above which the player's forward punt stops growing. */
export function humanPuntCap(): number {
  return 8;
}

const SIDE_LEVEL = 2.4;
/** `kTurn` is AI-only curvature; callers pass 0 whenever a human is in the pair. */
export function sideYieldsA(dProg: number, xA: number, xB: number, kTurn: number | undefined): boolean {
  if (dProg < -SIDE_LEVEL) return true;
  if (dProg > SIDE_LEVEL) return false;
  if (Math.abs(kTurn || 0) > 0.004 && xA !== xB) return (xA - xB) * Math.sign(kTurn as number) > 0;
  return Math.abs(xA) >= Math.abs(xB);
}

export function wallHitLoss(street: boolean): number {
  return street ? 0.3 : 0.28;
}

/** Steer-into-wall scrub (m/s^2). */
export function wallSteerScrub(street: boolean): number {
  return street ? 20 : 16;
}

/** AI has no heading slide; this is the clamp-frame speed scrub. */
export function wallAiScrub(street: boolean): number {
  return street ? 12 : 12;
}
