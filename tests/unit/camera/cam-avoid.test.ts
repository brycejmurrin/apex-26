/**
 * CamAvoid (src/camera/cam-avoid.ts): f1-game tests/unit/cam-avoid.test.mjs,
 * ported with its stub worlds (FlybySeq and Tracks injected), plus the
 * corridor rule of cam-avoid-vm.test.mjs on f1-game's builds when present.
 * Bit-for-bit parity with f1-game's CamAvoid is in flyby-parity.test.ts.
 */
import { describe, expect, it } from "vitest";
import { applies, createCamAvoid, type CamAvoidFlyby, type CamTrackOps } from "../../../src/camera/cam-avoid";
import { createFlybySeq, type FlybyTrack, type PropRec, type Vec3 } from "../../../src/camera/flyby-seq";
import { sample } from "../../../src/track/core/tracks";
import { f1Cam, haveF1, type F1Cam } from "./f1-cam-vm";

type Box = PropRec;
const inside = (box: Box, eye: Readonly<Vec3>, m?: number | null): boolean => {
  const M = m || 0;
  return Math.abs(eye[0] - box.x) < box.w / 2 + M && Math.abs(eye[2] - box.z) < box.d / 2 + M &&
    eye[1] > box.y - box.h / 2 - M && eye[1] < box.y + box.h / 2 + M;
};
const trk = (street: boolean) => ({ def: { street } }) as unknown as FlybyTrack;

describe("CamAvoid stub worlds (cam-avoid.test.mjs)", () => {
  it("applies only to broadcast modes (heli/side/cinematic/low)", () => {
    for (const m of ["heli", "side", "cinematic", "low"]) expect(applies(m)).toBe(true);
    for (const m of ["chase", "trackside", "cockpit"]) expect(applies(m)).toBe(false);
    expect(createCamAvoid({ flyby: null }).applies("heli")).toBe(true);
  });

  it("open circuit: steps eye toward the road until clear, then clearEye lifts", () => {
    let clears = 0;
    const box: Box = { kind: "building", x: 20, y: 5, z: 0, w: 10, d: 10, h: 12 };
    const flyby: CamAvoidFlyby = {
      insideProp: (_t, eye, m) => (inside(box, eye, m) ? box : null),
      clearEye(_t, eye) { clears++; if (inside(box, eye, 2)) eye[1] = box.y + box.h / 2 + 2; return eye; },
    };
    const A = createCamAvoid({ flyby, tracks: { sample: (_t, _s, o) => o, project: null } });
    const frame = { p: [0, 0, 0] as Vec3, r: [1, 0, 0] as Vec3, hw: 7 };
    const eye: Vec3 = [20, 4, 0];
    A.freeEye(trk(false), eye, frame);
    expect(eye[0]).toBeLessThan(20);
    expect(eye[0]).toBeGreaterThanOrEqual(frame.hw);
    expect(clears).toBe(1);
    expect(flyby.insideProp(trk(false), eye, 2)).toBeNull();
  });

  it("street circuit: skips lateral step-in (corr already owns width)", () => {
    const flyby: CamAvoidFlyby = { insideProp: () => null, clearEye: (_t, e) => e };
    const A = createCamAvoid({ flyby });
    const eye: Vec3 = [25, 4, 0];
    A.freeEye(trk(true), eye, { p: [0, 0, 0], r: [1, 0, 0], hw: 7 });
    expect(eye[0]).toBe(25);
  });

  // A straight road along +z through the origin (hw 8, right = +x, road at y=0)
  // and one prop box whose footprint reaches x=3: a gantry's / angled stand's AABB.
  function roadWorld(box: Box) {
    const flyby: CamAvoidFlyby = {
      insideProp: (_t, eye, m) => (inside(box, eye, m) ? box : null),
      clearEye(t, eye) { const hit = flyby.insideProp(t, eye, 2); if (hit) eye[1] = hit.y + hit.h / 2 + 2; return eye; },
    };
    const tracks: CamTrackOps = {
      project: (_t, x, z) => ({ s: z, lat: x }),
      sample: (_t, s, out) => { out.p = [0, 0, s]; out.r = [1, 0, 0]; out.hw = 8; return out; },
    };
    return createCamAvoid({ flyby, tracks });
  }

  it("the road is clear: an eye on the corridor is not lifted by a box over the tarmac", () => {
    const A = roadWorld({ kind: "gantry", x: 0, y: 4.6, z: 0, w: 20, d: 3, h: 9.2 });
    const eye: Vec3 = [1, 0.8, 0];
    A.freeEye(trk(false), eye, { p: [0, 0, 0], r: [1, 0, 0], hw: 8 });
    expect(eye[1]).toBe(0.8);
  });

  it("the road is clear: a box that only its 2 m margin reaches does not lift a road-edge eye", () => {
    const A = roadWorld({ kind: "grandstand", x: 14, y: 5, z: 0, w: 10, d: 20, h: 10 });
    const eye: Vec3 = [8, 0.8, 0];
    A.freeEye(trk(false), eye, { p: [0, 0, 0], r: [1, 0, 0], hw: 8 });
    expect(eye[1]).toBe(0.8);
  });

  it("off the corridor a solid box still lifts the eye", () => {
    const A = roadWorld({ kind: "grandstand", x: 20, y: 5, z: 0, w: 10, d: 20, h: 10 });
    const eye: Vec3 = [22, 4, 0];
    A.freeEye(trk(true), eye, { p: [0, 0, 0], r: [1, 0, 0], hw: 8 });
    expect(eye[1]).toBe(12);
  });

  it("no FlybySeq: nothing is blocked and nothing moves (f1-game's typeof guard)", () => {
    const A = createCamAvoid({ flyby: null });
    const eye: Vec3 = [5, 5, 5];
    expect(A.freeEye(trk(false), eye, { p: [0, 0, 0], r: [1, 0, 0], hw: 7 })).toEqual([5, 5, 5]);
    expect(A.blocked(trk(false), eye)).toBeNull();
  });
});

describe.skipIf(!haveF1)("CamAvoid on f1-game's builds (cam-avoid-vm.test.mjs)", () => {
  const f1 = haveF1 ? f1Cam() : (null as unknown as F1Cam);
  it.each(["monza", "monaco"])("%s: an eye on the road corridor is never lifted, and one off it leaves every solid", (id) => {
    const track = f1.track(id);
    const F = createFlybySeq({ corners: (d) => f1.TrackMaps.corners(d) });
    const A = createCamAvoid({ flyby: F });
    const smp = { p: [0, 0, 0] as Vec3, t: [0, 0, 0] as Vec3, r: [0, 0, 0] as Vec3, hw: 10 };
    const bad: string[] = [];
    for (let s = 0; s < track.total; s += 3) {
      sample(track, s, smp);
      const frame = { p: [...smp.p] as Vec3, r: [...smp.r] as Vec3, hw: smp.hw };
      const road: Vec3 = [smp.p[0] + smp.r[0] * 2, smp.p[1] + 1.5, smp.p[2] + smp.r[2] * 2];
      const y0 = road[1];
      A.freeEye(track, road, frame);
      if (road[1] !== y0) bad.push(`s=${s}: corridor eye lifted ${(road[1] - y0).toFixed(2)} m`);
      for (const lat of [-30, 30]) {
        const eye: Vec3 = [smp.p[0] + smp.r[0] * lat, smp.p[1] + 4, smp.p[2] + smp.r[2] * lat];
        A.freeEye(track, eye, frame);
        if (F.insideProp(track, eye, 0) && !A.roadClear(track, eye, 0)) bad.push(`s=${s} lat=${lat}: still inside`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  }, 300_000);
});
