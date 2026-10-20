/**
 * TRACKSIDE fixed cameras: one eye per measured corner, outside the fence,
 * auto-switching as the subject car passes. Ported verbatim from f1-game
 * js/camera/trackside.js:1-140 (`TracksideCams`).
 *
 * Appended CAM_MODES id "trackside" (mode-switch.js); vantage.js asks pose()
 * each frame. Pure track / prop geometry — broadcast-only, no sim RNG, no car
 * forces.
 *
 * Port notes: f1-game caches the cameras and the active index on the track
 * (`track._tsCams`, `track._tsIdx`); here they live in a per-instance WeakMap
 * keyed by the track (`setIndex` is the write tests and seeks made to
 * `_tsIdx`). FlybySeq / CamAvoid / Tracks are injected (a missing `flyby` or
 * `avoid` behaves as f1-game's `typeof X === "undefined"`); `flyby.cornerList`
 * replaces the direct `track._fbCorners` read. `tracks` defaults to the track
 * lane's sample/project/wallAt.
 * TODO(lane-shell): vantage's "trackside" mode calls pose()/status().
 */
import type { Sample } from "../track/core/types";
import { CORE_TRACK_OPS, type CamTrackOps, type RoadFrame } from "./cam-avoid";
import type { FlybyCorner, FlybyTrack, Vec3 } from "./flyby-seq";

/** The FlybySeq members TracksideCams reads. */
export interface TracksideFlyby {
  cornerS(track: FlybyTrack, n?: number | string): number;
  cornerList(track: FlybyTrack): readonly FlybyCorner[];
  cornerSide?: ((track: FlybyTrack, n?: number | string) => number) | null;
  clearEye?: ((track: FlybyTrack, eye: Vec3, margin?: number) => Vec3) | null;
}

export interface TracksideDeps {
  readonly flyby: TracksideFlyby | null;
  readonly avoid?: { freeEye(track: FlybyTrack, eye: Vec3, frame?: RoadFrame | null): Vec3 } | null;
  readonly tracks?: CamTrackOps;
}

/** One fixed camera (trackside.js:160). */
export interface TracksideCam { n: number; s: number; eye: Vec3; lookS: number; fov: number }

/** pose()'s result (trackside.js:228). `eye`/`tgt` are pooled. */
export interface TracksidePose { eye: Vec3; tgt: Vec3; fov: number; index: number; count: number; n: number; cut: boolean }

export interface TracksideExtra {
  /** [px, pz] (vantage's free-world path) or [x, y, z]. */
  readonly carPos?: readonly number[] | null;
  readonly snap?: boolean;
}

export const FENCE = 1.5;           // metres beyond half-width (or barrier)
export const HEIGHT = 4.8;          // metres above the road
const LOOK_UP = 0.9;
export const HYST_M = 18;           // hold the previous cam until the car is this far past the next
export const FOV = 42;
const FOV_NEAR = 50;         // car filling the lens
const FOV_FAR = 18;          // long lens so a car down the straight stays readable
const FOV_SPAN = 16;         // metres of circuit the lens is framed to hold

function wrapS(track: { readonly total: number }, s: number): number {
  const L = track.total || 1;
  s %= L; return s < 0 ? s + L : s;
}

/** Arc distance of `b` ahead of `a` on a loop of length `L` (0..L). trackside.js:123 */
function ahead(a: number, b: number, L: number): number {
  let d = b - a;
  if (d < 0) d += L;
  return d;
}

/** Index of the camera the car has most recently passed (with hysteresis). trackside.js:175 */
export function pick(cams: readonly { readonly s: number }[] | null | undefined, s: number, total: number, prev: number, snap?: boolean): number {
  if (!cams || !cams.length) return 0;
  const L = total || 1;
  const ss = wrapS({ total: L }, s);
  let best = 0, bestBehind = Infinity;
  for (let i = 0; i < cams.length; i++) {
    const behind = ahead(cams[i]!.s, ss, L);   // how far the car is past this cam
    if (behind < bestBehind) { bestBehind = behind; best = i; }
  }
  const prevIdx = ((prev | 0) % cams.length + cams.length) % cams.length;
  if (!snap && prevIdx !== best) {
    // Stick with the previous cam until the car is HYST_M past the new one's s,
    // so a weave near a corner does not flicker.
    const pastNew = ahead(cams[best]!.s, ss, L);
    if (pastNew < HYST_M) return prevIdx;
  }
  return best;
}

export function createTracksideCams(deps: TracksideDeps) {
  const FlybySeq = deps.flyby;
  const CamAvoid = deps.avoid || null;
  const Tracks = deps.tracks || CORE_TRACK_OPS;
  const state = new WeakMap<object, { cams?: TracksideCam[]; idx?: number }>();
  const stateOf = (track: object) => { let st = state.get(track); if (!st) state.set(track, st = {}); return st; };
  const _smp: Sample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };
  const _eye: Vec3 = [0, 0, 0], _tgt: Vec3 = [0, 0, 0];

  /** Build fixed cameras for a built track (cached on the track object). trackside.js:130 */
  function build(track: FlybyTrack | null | undefined): TracksideCam[] {
    if (!track) return [];
    const st = stateOf(track);
    if (st.cams) return st.cams;
    const out: TracksideCam[] = [];
    if (FlybySeq && FlybySeq.cornerS) {
      FlybySeq.cornerS(track, 1);
    }
    const corners = FlybySeq ? FlybySeq.cornerList(track) : [];
    for (let i = 0; i < corners.length; i++) {
      const n = i + 1;
      const s = wrapS(track, (corners[i]!.f || 0) * track.total);
      const side = (FlybySeq && FlybySeq.cornerSide)
        ? FlybySeq.cornerSide(track, n) : ((n % 2) ? 1 : -1);
      Tracks.sample(track, s, _smp);
      let lat = (_smp.hw || 7) + FENCE;
      if (track.def && track.def.street && Tracks.wallAt) {
        const w = Tracks.wallAt(track, s, side > 0 ? 1 : -1);
        if (w > 0) lat = Math.min(lat, w + FENCE);
      }
      const eye: Vec3 = [
        _smp.p[0] + _smp.r[0] * side * lat,
        _smp.p[1] + HEIGHT,
        _smp.p[2] + _smp.r[2] * side * lat,
      ];
      // Prefer a clear eye (open-circuit buildings) without re-planning the slot.
      if (CamAvoid) {
        CamAvoid.freeEye(track, eye, _smp);
      } else if (FlybySeq && FlybySeq.clearEye) {
        FlybySeq.clearEye(track, eye);
      }
      out.push({
        n: n,
        s: s,
        eye: eye,
        lookS: s,
        fov: FOV,
      });
    }
    // Sort by arc so pick() walks in track order.
    out.sort((a, b) => a.s - b.s);
    st.cams = out;
    return out;
  }

  /** The index pose() last chose (f1-game `track._tsIdx | 0`). */
  function index(track: FlybyTrack): number { return (stateOf(track).idx ?? 0) | 0; }
  /** Seat the active index (f1-game's direct `track._tsIdx = i`). */
  function setIndex(track: FlybyTrack, i: number): void { stateOf(track).idx = i; }

  /**
   * Live pose for vantage.js. Mutates nothing on the car; caches the active
   * index on the track. `extra.carPos` (when present) aims at the subject car.
   * trackside.js:198
   */
  function pose(track: FlybyTrack, s: number, _x: number, extra?: TracksideExtra | null): TracksidePose | null {
    const cams = build(track);
    if (!cams.length) return null;
    const prev = index(track);
    const idx = pick(cams, s, track.total, prev, extra ? extra.snap : undefined);
    setIndex(track, idx);
    const c = cams[idx]!;
    const cut = idx !== prev;
    _eye[0] = c.eye[0]; _eye[1] = c.eye[1]; _eye[2] = c.eye[2];
    if (extra && extra.carPos) {
      // vantage free-world path passes [px, pz]; keep a 3-vector path for tests.
      const cp = extra.carPos;
      if (cp.length >= 3) {
        _tgt[0] = cp[0]!; _tgt[1] = cp[1]! + LOOK_UP; _tgt[2] = cp[2]!;
      } else {
        Tracks.sample(track, wrapS(track, s), _smp);
        _tgt[0] = cp[0]!; _tgt[1] = _smp.p[1] + LOOK_UP; _tgt[2] = cp[1]!;
      }
    } else {
      Tracks.sample(track, wrapS(track, c.lookS), _smp);
      _tgt[0] = _smp.p[0]; _tgt[1] = _smp.p[1] + LOOK_UP; _tgt[2] = _smp.p[2];
    }
    // A fixed 42° lens makes the car a speck once it is a straight away, and
    // a fisheye when it passes the camera. Hold ~FOV_SPAN metres of circuit
    // in frame and clamp so neither end blows out. `cut` is the auto-switch:
    // the live rig snaps instead of damping across the circuit.
    const dist = Math.hypot(_tgt[0] - _eye[0], _tgt[1] - _eye[1], _tgt[2] - _eye[2]) || 1;
    let fov = 2 * Math.atan((FOV_SPAN * 0.5) / dist) * (180 / Math.PI);
    if (fov < FOV_FAR) fov = FOV_FAR;
    if (fov > FOV_NEAR) fov = FOV_NEAR;
    return { eye: _eye, tgt: _tgt, fov: fov, index: idx, count: cams.length, n: c.n, cut: cut };
  }

  /** trackside.js:231 */
  function status(track: FlybyTrack | null | undefined): { count: number; index: number; n?: number } {
    if (!track) return { count: 0, index: 0 };
    const cams = build(track);
    return { count: cams.length, index: index(track), n: cams.length ? cams[index(track)]!.n : 0 };
  }

  return Object.freeze({ build, pick, pose, status, setIndex, FENCE, HEIGHT, HYST_M, FOV });
}

export type TracksideCams = ReturnType<typeof createTracksideCams>;
