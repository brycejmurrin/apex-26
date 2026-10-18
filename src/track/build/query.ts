/**
 * TrackQuery over a built track: f1-game's `Tracks` facade (js/track/tracks.js:775)
 * with the `track` argument bound. Each member calls the ported function directly,
 * so the doubles are the ones f1-game computes.
 *
 * `physicsTrack` adds what the physics reads beyond TrackQuery (src/physics/track.ts
 * PhysicsTrack): `street` and `wallLimits`, the latter the physics lane's verbatim
 * port of f1-game contact-geometry.js:146 (`wallLimitsOf`) bound to this track.
 * Neither exposes curvature or the racing line (AGENTS.md, the arc rule).
 */
import type { BankingOut, TrackQuery, TrackSample } from "../../contracts/track";
import { wallLimitsOf } from "../../physics/contact-geometry";
import type { PhysicsTrack, PostLimits, WallLimits, WallLimitsTrack, WallPrevious } from "../../physics/track";
import { banking, onKerb } from "../core/mesh";
import { postLimits, sample, wallAt } from "../core/spline";
import { buildTrack, defById, inPitLane, type BuildOpts } from "../core/tracks";
import type { Track } from "../core/types";

export function trackQuery(track: Track): TrackQuery {
  const L = track.total;
  return {
    length: L,
    sample: (s: number, out: TrackSample) => sample(track, s, out),
    banking: (s: number, x: number, out: BankingOut, smooth?: boolean) => banking(track, s, x, out, smooth),
    onKerb: (s: number, x: number) => (onKerb(track, s, x) > 0 ? 1 : 0),
    inPitLane: (s: number, x: number) => inPitLane(track, s, x),
    wallAt: (s: number, sideSign: number) => wallAt(track, s, sideSign),
    // js/game.js:1266: s %= L; s < 0 ? s + L : s
    wrapS: (s: number) => { s %= L; return s < 0 ? s + L : s; },
  };
}

/**
 * The raw-track view `wallLimitsOf` reads. Fields are read live off `track`, so a
 * driving boundary the scenery build sets later (barL/barR, posts) is seen.
 */
export function wallLimitsTrack(track: Track): WallLimitsTrack {
  return {
    get total() { return track.total; },
    get n() { return track.n; },
    get hw() { return track.hw; },
    get pit() { return track.pit; },
    get posts() { return track.posts; },
    wallAt: (s: number, sideSign: number) => wallAt(track, s, sideSign),
    postLimits: (s: number, x: number, out: PostLimits) => postLimits(track, s, x, out),
  };
}

/** The default track provider for the physics: TrackQuery + street + wallLimits. */
export function physicsTrack(track: Track): PhysicsTrack {
  const raw = wallLimitsTrack(track);
  return {
    ...trackQuery(track),
    street: track.street,
    wallLimits: (s: number, x: number, out: WallLimits, postLim: PostLimits, previous?: WallPrevious | null) =>
      wallLimitsOf(raw, s, x, out, postLim, previous),
  };
}

/** Build a circuit by id and return its physics provider (and the built track). */
export function loadPhysicsTrack(id: string, opts?: BuildOpts | null): { track: Track; query: PhysicsTrack } {
  const def = defById(id);
  if (!def) throw new Error("unknown circuit id " + id);
  const track = buildTrack(def, opts);
  return { track, query: physicsTrack(track) };
}
