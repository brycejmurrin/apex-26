/**
 * TrackQuery: the per-step track reads the player physics makes, from f1-game's
 * `Tracks` facade (js/track/tracks.js:775) bound to one built track.
 *
 * Every member is allocation-free: results go into caller-owned scratch
 * objects (`out`), exactly as f1-game pools `{ p, t, r, hw }` samples
 * (js/game.js:461-463, :1165). Vectors are plain 3-tuples because f1-game's
 * samples are plain arrays (`p: [0, 0, 0]`), so a port keeps the same doubles.
 *
 * Curvature and the racing line are NOT here on purpose: they may not reach
 * the driver (see `PlayerInput` in ./sim.ts). AI and assists get them through
 * their own seams.
 */

/** A mutable world-space 3-vector, `[x, y, z]`; +Y up, metres. f1-game: plain `[0, 0, 0]` arrays. */
export type Vec3 = [number, number, number];

/**
 * One centreline sample at arc `s`. f1-game js/track/core/spline.js:90
 * `sample(track, s, out)`: `p` position, `t` unit tangent, `r` unit right
 * vector (lateral +x), `hw` road half-width in metres. Shape as declared in
 * f1-game types/game-ctx.d.ts:206 `TrackSample`.
 */
export interface TrackSample {
  p: Vec3;
  t: Vec3;
  r: Vec3;
  hw: number;
}

/**
 * Banking scratch. f1-game js/track/core/mesh.js:555 `banking(track, s, x, out, smooth)`
 * writes `dy` (height of the banked road at lateral `x`, metres, `x` clamped to
 * the half-width) and `roll` (radians, + = right edge raised).
 */
export interface BankingOut {
  dy: number;
  roll: number;
}

/**
 * The track as the player step sees it. Members map 1:1 onto f1-game functions
 * with the `track` argument bound:
 *
 * - `sample`    js/track/core/spline.js:90
 * - `banking`   js/track/core/mesh.js:555
 * - `onKerb`    js/track/core/mesh.js:502
 * - `inPitLane` js/track/tracks.js:228
 * - `wallAt`    js/track/core/spline.js:224
 * - `wrapS`     js/game.js:1266 (and js/track/core/line.js:585)
 * - `length`    `track.total` (spline.js:91)
 */
export interface TrackQuery {
  /** Lap length in arc metres (`track.total`). */
  readonly length: number;

  /**
   * Write the centreline sample at arc `s` (any real; wrapped internally) into
   * `out` and return `out`. Linear interpolation between baked nodes.
   */
  sample(s: number, out: TrackSample): TrackSample;

  /**
   * Banked-road offset at (`s`, `x`). Writes into `out` and returns it, or
   * returns `null` on an unbanked section (f1-game returns null when the
   * signed lift is 0 or the track has no `bankP`). `smooth` selects the
   * Catmull-Rom lift used by cameras; physics passes nothing (linear, matches
   * the road mesh).
   */
  banking(s: number, x: number, out: BankingOut, smooth?: boolean): BankingOut | null;

  /**
   * 1 when lateral `x` at arc `s` is on a kerb strip (|x| within hw-0.6 .. hw+1.1
   * on a side with a kerb at that node), else 0. f1-game returns the number,
   * and game.js:5590 compares `> 0`.
   */
  onKerb(s: number, x: number): 0 | 1;

  /**
   * True when (`s`, `x`) is inside the pit lane's lateral band, with half a car
   * of tolerance on the inner edge. False when the track has no pit lane at `s`.
   */
  inPitLane(s: number, x: number): boolean;

  /**
   * Driving boundary: the maximum |x| from the centreline before the barrier on
   * one side (`sideSign >= 0` right, `< 0` left), the tighter of the two
   * bracketing nodes.
   */
  wallAt(s: number, sideSign: number): number;

  /** `s` wrapped into [0, length): `s %= L; s < 0 ? s + L : s`. */
  wrapS(s: number): number;
}

/** The barrier limits at (s, x): max |x| right / left, and the pit-lane floor. f1-game js/physics/contact-geometry.js:183. */
export interface WallLimits {
  r: number;
  l: number;
  laneMin: number;
  side: number;
}

/** Gantry-post scratch. f1-game js/track/core/spline.js:244 `postLimits(track, s, x, out)`. */
export interface PostLimits {
  r: number;
  l: number;
  minOut: number;
  side: number;
}

/** A previous validated pose for `wallLimits` (incident takeover only). f1-game contact-geometry.js:146. */
export interface WallPrevious {
  readonly s: number;
  readonly x: number;
}

/**
 * The track as the physics modules see it: `TrackQuery` plus the `street` flag
 * and the driving boundary. Still no curvature and no racing line (the arc rule).
 */
export interface PhysicsTrack extends TrackQuery {
  /** f1-game js/track/tracks.js:157 `street: !!def.street`. */
  readonly street: boolean;
  /**
   * The driving boundary at (s, x): barriers, pit wall, pit-exit wall and gantry
   * legs. f1-game js/physics/contact-geometry.js:146-184 `ContactGeometry.wallLimits`.
   * Writes `out` (and uses `postLim` as scratch) and returns `out`.
   */
  wallLimits(s: number, x: number, out: WallLimits, postLim: PostLimits, previous?: WallPrevious | null): WallLimits;
}
