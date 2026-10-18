/**
 * TiltRoll: the one roll-from-orientation function, in degrees, shared by the
 * desktop's tilt input and the phone controller page.
 * Port of f1-game js/input/tilt-roll.js:1-48 (TiltRoll).
 *
 * deviceorientation reports beta (front-back) and gamma (left-right) in the
 * DEVICE frame, and a phone held sideways swaps which one is the roll the
 * player means. f1-game's input.js resolves that by rebuilding the gravity
 * vector and taking the angle between screen-right and the rest, per
 * screen.orientation.angle. The PHONE AS CONTROLLER page (controller.html,
 * src/net/phone-pad.ts) needs the identical number on the phone, so the math
 * lives here and both ends call it: a fix to one orientation case cannot drift
 * between the two ends.
 *
 * Float operation order is f1-game's (AGENTS.md §Porting): Math.hypot stays.
 */

const DEG = Math.PI / 180;

/**
 * Signed roll in degrees (+ = screen-right edge down = steer right) from the
 * deviceorientation angles and the screen rotation (0/90/180/270). Null when
 * the event carries no angles at all (a device with no sensor).
 * tilt-roll.js:15-34.
 */
export function rollDeg(
  beta: number | null | undefined,
  gamma: number | null | undefined,
  angle?: number | null,
): number | null {
  if (beta == null && gamma == null) return null;
  const b = (beta || 0) * DEG, g = (gamma || 0) * DEG;
  const cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);
  const gx = sg * cb;   // gravity along device right
  const gy = -sb;       // gravity along device top
  const gz = -cg * cb;  // gravity along device out-of-screen
  let h: number, v: number; // gravity along screen-right (h) vs the rest (v)
  switch ((((angle || 0) % 360) + 360) % 360) {
    case 90:  h = -gy; v = Math.hypot(gx, gz); break;
    case 180: h = -gx; v = Math.hypot(gy, gz); break;
    case 270: h =  gy; v = Math.hypot(gx, gz); break;
    default:  h =  gx; v = Math.hypot(gy, gz); break;
  }
  return Math.atan2(h, v) / DEG;
}

/** The screen rotation the browser reports, 0 when it reports nothing. tilt-roll.js:36-44. */
export function screenAngle(): number {
  const g = globalThis as { screen?: { orientation?: { angle?: unknown } }; window?: { orientation?: unknown } };
  if (typeof g.screen !== "undefined" && g.screen.orientation &&
      typeof g.screen.orientation.angle === "number") {
    return g.screen.orientation.angle;
  }
  if (typeof g.window !== "undefined" && typeof g.window.orientation === "number") return g.window.orientation;
  return 0;
}
