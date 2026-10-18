/**
 * The road chart the player step reads and writes through: arc wrap, the
 * world ↔ (s, x) maps, and the Frenet stretch h.
 *
 * Port of f1-game js/game.js:1046 (`wrapS`), :472-490 (`trackFrom`),
 * :516-523 (`worldFromTrack`) and :450, :524-531 (`H_D`, `frenetH`), verbatim.
 * Each instance owns its pooled scratch, as f1-game's module-level `_trk`,
 * `_tf`, `_wf`, `_hA`, `_hB` were.
 *
 * None of this is curvature: frenetH is the metric stretch of the chart at
 * lateral x (f1-game docs/PHYSICS.md "Curvature channels": not an arc read).
 */
import type { TrackQuery, TrackSample } from "../contracts";
import { clamp } from "../physics/math";

export const H_D = 2;

export interface TrackPoint {
  s: number;
  x: number;
}
export interface WorldXZ {
  x: number;
  z: number;
}

export interface Frenet {
  wrapS(s: number): number;
  /** World → (s, x), refining from `sPredicted`. POOLED result. game.js:472. */
  trackFrom(px: number, pz: number, sPredicted: number): Readonly<TrackPoint>;
  /** (s, x) → world; samples into `out`. POOLED result. game.js:516. */
  worldFromTrack(s: number, x: number, out: TrackSample): Readonly<WorldXZ>;
  /** The Frenet stretch at (s, x), clamped 0.45..1.8. game.js:524. */
  frenetH(s: number, x: number): number;
}

const newSample = (): TrackSample => ({ p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 });

export function createFrenet(track: TrackQuery): Frenet {
  const _trk = newSample();
  const _tf: TrackPoint = { s: 0, x: 0 };
  const _wf: WorldXZ = { x: 0, z: 0 };
  const _hA = newSample(),
    _hB = newSample();

  function wrapS(s: number): number {
    const L = track.length;
    s %= L;
    return s < 0 ? s + L : s;
  }

  function trackFrom(px: number, pz: number, sPredicted: number): Readonly<TrackPoint> {
    let s = wrapS(sPredicted);
    for (let i = 0; i < 2; i++) {
      track.sample(s, _trk);
      let tx = _trk.t[0],
        tz = _trk.t[2];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const along = (px - _trk.p[0]) * tx + (pz - _trk.p[2]) * tz;
      if (Math.abs(along) < 1e-3) break;
      s = wrapS(s + clamp(along, -12, 12));
    }
    track.sample(s, _trk);
    let rx = _trk.r[0],
      rz = _trk.r[2];
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;
    _tf.s = s;
    _tf.x = (px - _trk.p[0]) * rx + (pz - _trk.p[2]) * rz;
    return _tf;
  }

  function worldFromTrack(s: number, x: number, out: TrackSample): Readonly<WorldXZ> {
    track.sample(s, out);
    let rx = out.r[0],
      rz = out.r[2];
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;
    _wf.x = out.p[0] + rx * x;
    _wf.z = out.p[2] + rz * x;
    return _wf;
  }

  function frenetH(s: number, x: number): number {
    track.sample(wrapS(s - H_D), _hA);
    track.sample(wrapS(s + H_D), _hB);
    const cx = _hB.p[0] - _hA.p[0],
      cz = _hB.p[2] - _hA.p[2];
    const ox = cx + (_hB.r[0] - _hA.r[0]) * x,
      oz = cz + (_hB.r[2] - _hA.r[2]) * x;
    const cLen = Math.hypot(cx, cz);
    if (!(cLen > 1e-4)) return 1;
    return clamp(Math.hypot(ox, oz) / cLen, 0.45, 1.8);
  }

  return { wrapS, trackFrom, worldFromTrack, frenetH };
}
