/**
 * Broadcast-camera wall / building avoidance for open circuits. Ported
 * verbatim from f1-game js/camera/cam-avoid.js:1-98 (`CamAvoid`).
 *
 * Street circuits already clamp lateral offset via vantage.js `corr`; open
 * circuits only had a soft ground floor, so heli / side / cinematic / low could
 * sit inside a grandstand or tower. This module steps the eye toward the road
 * when it is inside a solid prop box, then lifts over any remaining roof using
 * FlybySeq.clearEye (same solid set as the flyby planner). Broadcast-only —
 * never touches car forces.
 *
 * Port notes: the IIFE's globals become injected deps — `flyby` is a FlybySeq
 * instance (./flyby-seq) or any object with its insideProp/clearEye, `tracks`
 * defaults to the track lane's sample/project (src/track/core/tracks.ts), and
 * is injectable so f1-game's stub-world tests port as they are. A missing
 * `flyby` behaves as f1-game's `typeof FlybySeq === "undefined"`.
 * TODO(lane-shell): vantage (CAM_MODES heli/side/cinematic/low/pitwall) calls freeEye.
 */
import { project as coreProject, sample as coreSample, wallAt as coreWallAt } from "../track/core/tracks";
import type { Sample } from "../track/core/types";
import type { FlybyTrack, PropRec, Vec3 } from "./flyby-seq";

/** The FlybySeq members CamAvoid reads. */
export interface CamAvoidFlyby {
  insideProp(track: FlybyTrack, p: Readonly<Vec3>, margin?: number | null): PropRec | null;
  clearEye(track: FlybyTrack, eye: Vec3, margin?: number): Vec3;
}

/** The Tracks members CamAvoid and TracksideCams read (cam-avoid.js:44, trackside.js:143-146). */
export interface CamTrackOps {
  sample(track: FlybyTrack, s: number, out: Sample): Sample;
  project?: ((track: FlybyTrack, x: number, z: number, hint?: number | null, y?: number | null) => { s: number; lat: number } | null) | null;
  wallAt?: ((track: FlybyTrack, s: number, side: number) => number) | null;
}

/** The track lane's implementations (src/track/core/tracks.ts). */
export const CORE_TRACK_OPS: CamTrackOps = {
  sample: (track, s, out) => coreSample(track, s, out),
  project: (track, x, z, hint, y) => coreProject(track, x, z, hint, y),
  wallAt: (track, s, side) => coreWallAt(track, s, side),
};

/** A road frame at the car (`{ p, r, hw }`, vantage.js cvA). */
export interface RoadFrame { readonly p: Readonly<Vec3>; readonly r: Readonly<Vec3>; readonly hw: number }

export interface CamAvoidDeps {
  readonly flyby: CamAvoidFlyby | null;
  readonly tracks?: CamTrackOps;
}

export const MODES: Readonly<Record<string, 1>> = { heli: 1, side: 1, cinematic: 1, low: 1 };
export const MARGIN = 2.0;          // metres of facade clear (matches FlybySeq CLEAR_M spirit)
export const STEP = 1.5;            // lateral step toward the centreline per try
const MAX_STEP = 12;         // bound the work per frame
const IN_MIN = 1.5;          // never step closer than hw + this

const ROAD_PAD = 2.0;        // metres past the kerb that still counts as "on the road corridor"
const ROAD_TOL = 0.5;        // a gantry box starts AT the road; float noise must not un-exempt it

/** cam-avoid.js:20 */
export function applies(mode: string): boolean { return !!MODES[mode]; }

export function createCamAvoid(deps: CamAvoidDeps) {
  const FlybySeq = deps.flyby;
  const Tracks = deps.tracks || CORE_TRACK_OPS;

  /** True when FlybySeq reports the eye inside a solid prop (building, stand…). cam-avoid.js:23 */
  function blocked(track: FlybyTrack | null | undefined, eye: Readonly<Vec3>, margin?: number | null): PropRec | null {
    if (!track || !FlybySeq || !FlybySeq.insideProp) return null;
    return FlybySeq.insideProp(track, eye, margin == null ? MARGIN : margin);
  }

  const _rs: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 10 };

  /**
   * THE ROAD IS ALWAYS CLEAR (the rule FlybySeq.onRoadPose states for the
   * planner). A prop box whose footprint holds the road surface under the eye
   * is a gantry, bridge or tunnel mouth — or the axis-aligned box of an angled
   * structure — not a wall: cars drive through it. Without this the eye was
   * "inside" the start gantry (Monza LOW, +10 m) or a 51 m Monaco `structure`
   * (+35 m) for the few metres the road passes under, and dropped back the
   * moment it cleared, a heave per overhead structure per lap. Judged from the
   * road under the EYE (Tracks.project), not the one under the car: the broadcast
   * modes put the eye tens of metres off the car's arc.
   * True when, on the road corridor, the eye sits in a prop box's margin only or
   * in a box that reaches the tarmac beside it. cam-avoid.js:43
   */
  function roadClear(track: FlybyTrack, eye: Readonly<Vec3>, margin?: number | null): boolean {
    if (!Tracks.project || !Tracks.sample) return false;
    if (!blocked(track, eye, margin)) return false;
    const pr = Tracks.project(track, eye[0], eye[2], null, eye[1]);
    if (!pr) return false;
    Tracks.sample(track, pr.s, _rs);
    if (Math.abs(pr.lat) > (_rs.hw || 7) + ROAD_PAD) return false;
    // Only the 2 m facade margin reaches the eye: a stand beside the road, not a
    // volume the eye is in. Cars use this corridor; a lift here is a pop.
    const box = blocked(track, eye, 0);
    if (!box) return true;
    // The tarmac point nearest the eye. A box that reaches it (within the same
    // pad) is an angled structure's bounding box over a road that is clear —
    // Monza's grandstand box ends 0.16 m short of the centreline, so a test on
    // the centreline alone flickered on and off along the straight.
    const hw = _rs.hw || 7, c = Math.max(-hw, Math.min(hw, pr.lat));
    const qx = _rs.p[0] + _rs.r[0] * c, qz = _rs.p[2] + _rs.r[2] * c, qy = _rs.p[1];
    return Math.abs(qx - box.x) < box.w / 2 + ROAD_PAD && Math.abs(qz - box.z) < box.d / 2 + ROAD_PAD &&
      qy > box.y - box.h / 2 - ROAD_TOL && qy < box.y + box.h / 2;
  }

  /**
   * Pull `eye` out of solid props. Mutates eye in place; returns it.
   * `frame` is the road sample at the car (`{ p, r, hw }`) used to step inward.
   * Street circuits are already corridor-clamped; they only get the lift net.
   * cam-avoid.js:69
   */
  function freeEye(track: FlybyTrack | null | undefined, eye: Vec3, frame?: RoadFrame | null): Vec3 {
    if (!track || !eye) return eye;
    if (roadClear(track, eye, MARGIN)) return eye;
    const street = !!(track.def && track.def.street);
    if (!street && frame && frame.p && frame.r) {
      const hw = frame.hw > 0 ? frame.hw : 7;
      for (let i = 0; i < MAX_STEP; i++) {
        if (!blocked(track, eye, MARGIN)) break;
        const dx = frame.p[0] - eye[0], dz = frame.p[2] - eye[2];
        const len = Math.hypot(dx, dz);
        if (len < 0.05) break;
        const lat = (eye[0] - frame.p[0]) * frame.r[0] + (eye[2] - frame.p[2]) * frame.r[2];
        const abs = Math.abs(lat);
        if (abs <= hw + IN_MIN) break;   // already at the road edge — lift instead
        const step = Math.min(STEP, abs - hw);
        eye[0] += (dx / len) * step;
        eye[2] += (dz / len) * step;
        // Lost width → a little crane height (street corr does the same trade).
        eye[1] += step * 0.25;
      }
    }
    // The step-in can end on the corridor edge, under a different overhead box.
    if (FlybySeq && FlybySeq.clearEye && !roadClear(track, eye, MARGIN)) {
      FlybySeq.clearEye(track, eye, MARGIN);
    }
    return eye;
  }

  return Object.freeze({ applies, blocked, roadClear, freeEye, MODES, MARGIN, STEP });
}

export type CamAvoid = ReturnType<typeof createCamAvoid>;
