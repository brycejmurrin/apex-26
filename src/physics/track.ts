/**
 * The track as the physics modules see it: `PhysicsTrack` (src/contracts/track.ts,
 * re-exported here) is `TrackQuery` plus the driving boundary (`wallLimits`) and
 * the `street` flag.
 *
 * `wallLimits` is f1-game js/physics/contact-geometry.js:146-184
 * (`ContactGeometry.wallLimits`): it reads pit-lane and gantry-post internals
 * of the built track that `TrackQuery` does not expose, so the physics takes
 * it as one query. `wallLimitsOf` (contact-geometry.ts) is the verbatim port
 * over `WallLimitsTrack`, for the track lane to bind.
 *
 * No curvature and no racing line here, on purpose (AGENTS.md, the arc rule).
 */
import type { PostLimits } from "../contracts";

export type { PhysicsTrack, PostLimits, WallLimits, WallPrevious } from "../contracts";

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
