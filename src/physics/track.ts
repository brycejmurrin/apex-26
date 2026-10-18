/**
 * The track as the physics modules see it: `TrackQuery` plus the driving
 * boundary (`wallLimits`) and the `street` flag.
 *
 * `wallLimits` is f1-game js/physics/contact-geometry.js:146-184
 * (`ContactGeometry.wallLimits`): it reads pit-lane and gantry-post internals
 * of the built track that `TrackQuery` does not expose, so the physics takes
 * it as one query. `wallLimitsOf` (contact-geometry.ts) is the verbatim port
 * over `WallLimitsTrack`, for the track lane to bind.
 * TODO(lane-track): implement `WallLimitsTrack` on the built track (or ask the
 * coordinator to add `wallLimits` to `TrackQuery`).
 *
 * No curvature and no racing line here, on purpose (AGENTS.md, the arc rule).
 */
import type { TrackQuery } from "../contracts";

/** The barrier limits at (s, x): max |x| right / left, and the pit-lane floor. contact-geometry.js:183. */
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

/** A previous validated pose for `wallLimits` (incident takeover only). */
export interface WallPrevious {
  readonly s: number;
  readonly x: number;
}

export interface PhysicsTrack extends TrackQuery {
  /** f1-game tracks.js:157 `street: !!def.street`. */
  readonly street: boolean;
  /**
   * The driving boundary at (s, x): barriers, pit wall, pit-exit wall and
   * gantry legs. Writes `out` (and uses `postLim` as scratch) and returns `out`.
   */
  wallLimits(s: number, x: number, out: WallLimits, postLim: PostLimits, previous?: WallPrevious | null): WallLimits;
}

/** The built pit-lane data `wallLimits` reads. f1-game js/track/core/pit.js. */
export interface PitLaneData {
  readonly painted: boolean;
  /** Per-node pit-wall visibility 0..1. */
  readonly v: ArrayLike<number>;
  /** Per-node pit-lane width blend 0..1. */
  readonly w: ArrayLike<number>;
  readonly side: number;
  readonly sOut: number;
  readonly exitRoadM: number;
  readonly bands: { readonly verge: number };
  readonly off: { readonly fastIn: number };
}

/** The raw built track `wallLimitsOf` reads (f1-game's `track` object). */
export interface WallLimitsTrack {
  readonly total: number;
  readonly n: number;
  readonly hw: ArrayLike<number>;
  readonly pit: PitLaneData | null | undefined;
  readonly posts: ArrayLike<unknown> | null | undefined;
  /** spline.js:224 `wallAt(track, s, sideSign)`. */
  wallAt(s: number, sideSign: number): number;
  /** spline.js:244 `postLimits(track, s, x, out)`. */
  postLimits(s: number, x: number, out: PostLimits): PostLimits;
}

/** f1-game js/track/core/pit.js:74. */
export const EXIT_WALL_W = 0.75;
