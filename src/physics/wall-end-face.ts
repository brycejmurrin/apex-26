/**
 * WALL END FACE: where the barrier steps inward along the track (a pit-wall
 * taper, the end of a run-off) the lateral clamp would teleport the car
 * sideways; this holds s, scrubs speed and keeps x instead.
 *
 * Port of f1-game js/physics/wall-end-face.js (`WallEndFace`, :15-44), verbatim.
 * Touches no tunable or curvature.
 */
import type { PhysCar } from "./car";
import type { PhysicsTrack, PostLimits, WallLimits } from "./track";

export const FACE_DROP = 1.5;
const FACE_KEEP = 0.2;
const _prev: WallLimits = { r: 0, l: 0, laneMin: 0, side: 0 };
const _post: PostLimits = { r: 1e9, l: 1e9, minOut: 0, side: 0 };

/**
 * Called by WallClamp.apply BEFORE the lateral pin, with the limits at the new
 * s. Returns true when it held the car at the face (c.s restored, speed scrubbed).
 */
export function apply(c: PhysCar, track: PhysicsTrack, lim: WallLimits, dt: number): boolean {
  void dt;
  if (!c.human || c._prevS == null) return false;
  let ds = c.s - c._prevS;
  const L = track.length;
  if (ds > L / 2) ds -= L;
  else if (ds < -L / 2) ds += L;
  if (!(ds > 1e-6) || ds > 20) return false;
  track.wallLimits(c._prevS, c.x, _prev, _post);
  const right = c.x > lim.r;
  if (!right && !(c.x < -lim.l)) return false;
  const oldLim = right ? _prev.r : _prev.l,
    newLim = right ? lim.r : lim.l;
  if (!(oldLim - newLim > FACE_DROP)) return false;
  if (Math.abs(c.x) > oldLim) return false;
  c.s = c._prevS;
  c.speed *= FACE_KEEP;
  c.wallT = 0.35;
  return true;
}
