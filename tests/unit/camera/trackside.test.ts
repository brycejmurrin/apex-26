/**
 * TracksideCams (src/camera/trackside.ts): f1-game tests/unit/trackside.test.mjs,
 * ported with its stub world (a straight road along +z, three corners). The
 * fov-fit and mode-switch cases belong to the shell's camera family and are
 * not ported here. Bit-for-bit parity on built circuits is in flyby-parity.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { CamTrackOps } from "../../../src/camera/cam-avoid";
import type { FlybyCorner, FlybyTrack } from "../../../src/camera/flyby-seq";
import { createTracksideCams, HYST_M, pick, type TracksideFlyby } from "../../../src/camera/trackside";

function load() {
  const tracks: CamTrackOps = {
    sample(_t, s, out) {
      out.p[0] = 0; out.p[1] = 2; out.p[2] = s;
      out.t[0] = 0; out.t[1] = 0; out.t[2] = 1;
      out.r[0] = 1; out.r[1] = 0; out.r[2] = 0;
      out.hw = 7;
      return out;
    },
  };
  const corners: FlybyCorner[] = [{ f: 0.1, r: 20 }, { f: 0.4, r: 20 }, { f: 0.7, r: 20 }];
  const flyby: TracksideFlyby = {
    cornerS: (t) => corners[0]!.f * t.total,
    cornerList: () => corners,
    cornerSide: (_t, n) => (int(n) % 2 ? 1 : -1),
    clearEye: (_t, e) => e,
  };
  return createTracksideCams({ flyby, avoid: { freeEye: (_t, e) => e }, tracks });
}
const int = (v: unknown): number => (v as number) | 0;
const mk = (total: number) => ({ total, def: { street: false } }) as unknown as FlybyTrack;

describe("TracksideCams stub world (trackside.test.mjs)", () => {
  it("build places one cam per measured corner outside the half-width", () => {
    const TS = load(), track = mk(1000);
    const cams = TS.build(track);
    expect(cams.length).toBe(3);
    expect(cams[0]!.eye[0]).toBeGreaterThan(7);
    expect(cams[0]!.eye[1]).toBeGreaterThan(2);
    expect(TS.build(track)).toBe(cams);
  });

  it("pick advances as the car passes each cam, with hysteresis", () => {
    const cams = [{ s: 100 }, { s: 400 }, { s: 700 }];
    expect(pick(cams, 150, 1000, 0)).toBe(0);
    expect(pick(cams, 430, 1000, 0)).toBe(1);
    expect(pick(cams, 405, 1000, 0)).toBe(0);
    expect(pick(cams, 400 + HYST_M + 1, 1000, 0)).toBe(1);
  });

  it("pose tightens the lens when the car is far and opens it when the car is close", () => {
    const TS = load(), track = mk(1000);
    const near = TS.pose(track, 100, 0, { carPos: [0, 100] })!;
    const nearFov = near.fov;
    TS.setIndex(track, 0);
    const far = TS.pose(track, 280, 0, { carPos: [0, 280] })!;
    expect(nearFov).toBeGreaterThan(far.fov);
    expect(far.fov).toBeLessThanOrEqual(22);
    expect(nearFov <= 50 && far.fov >= 18).toBe(true);
    expect(far.fov).toBe(18);
  });

  it("pose aims at the subject car when carPos is supplied", () => {
    const TS = load(), track = mk(1000);
    const p = TS.pose(track, 160, 0, { carPos: [3, 160] })!;
    expect(p.tgt[0]).toBe(3);
    expect(p.tgt[2]).toBe(160);
    expect(p.count).toBe(3);
    expect(TS.status(track)).toEqual({ count: 3, index: 0, n: 1 });
  });

  it("trackside snap selects the seek destination without inheriting hysteresis", () => {
    const TS = load(), track = mk(1000);
    for (const previous of [0, 2]) {
      TS.setIndex(track, previous);
      expect(TS.pose(track, 405, 0, { carPos: [0, 405] })!.index).toBe(previous);
      const shot = TS.pose(track, 405, 0, { carPos: [0, 405], snap: true })!;
      expect(shot.index).toBe(1);
      expect(shot.eye[2]).toBe(400);
      expect(shot.cut).toBe(true);
      expect(TS.pose(track, 405, 0, { snap: true })!.cut).toBe(false);
    }
    expect(TS.pose(track, 1105, 0, { snap: true })!.index).toBe(0);
  });

  it("no FlybySeq: no corners, no cameras", () => {
    const TS = createTracksideCams({ flyby: null });
    expect(TS.build(mk(1000))).toEqual([]);
    expect(TS.pose(mk(1000), 10, 0)).toBeNull();
    expect(TS.status(null)).toEqual({ count: 0, index: 0 });
  });
});
