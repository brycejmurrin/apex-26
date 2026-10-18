/**
 * TrackQuery over a built track: f1-game's `Tracks` facade (js/track/tracks.js:775)
 * with the `track` argument bound. Each member calls the ported function directly,
 * so the doubles are the ones f1-game computes.
 */
import type { BankingOut, TrackQuery, TrackSample } from "../../contracts/track";
import { banking, onKerb } from "../core/mesh";
import { sample, wallAt } from "../core/spline";
import { inPitLane } from "../core/tracks";
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
