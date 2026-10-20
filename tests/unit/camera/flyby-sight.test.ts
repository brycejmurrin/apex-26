/**
 * FlybySight (src/camera/flyby-sight.ts): the FlybySight cases of f1-game
 * tests/unit/flyby-shots.test.mjs:1689-1849. The box-world cases run always (a
 * fake track with no spline, as f1-game's own test uses); the offRoad / mix
 * cases need a built circuit and run on f1-game's Monza build when present.
 */
import { describe, expect, it } from "vitest";
import { createFlybySeq, type FlybyTrack, type Vec3 } from "../../../src/camera/flyby-seq";
import * as S from "../../../src/camera/flyby-sight";
import { sample } from "../../../src/track/core/tracks";
import { f1Cam, haveF1, type F1Cam } from "./f1-flyby-vm";

const fake = {
  total: 100,
  props: {
    list: [
      { kind: "building", x: 0, y: 5, z: 20, w: 10, h: 10, d: 2 },
      { kind: "bush", x: 50, y: 1, z: 0, w: 4, h: 2, d: 4 },
    ],
    spans: [],
  },
} as unknown as FlybyTrack;

describe("FlybySight box world (always run)", () => {
  it("a box between the eye and a point hides it; a box the point sits in hides only the DRAWN share", () => {
    const hidden = S.transmit(fake, [0, 5, 0], [0, 5, 40]);
    expect(hidden.T).toBe(0);
    expect(hidden.near).toBeGreaterThan(0.99);
    expect(S.transmit(fake, [0, 5, 0], [30, 5, 0]).T).toBe(1);
    const inBush = S.transmit(fake, [0, 1, 0], [50, 1, 0]);
    expect(inBush.T).toBe(1);
    expect(Math.abs(inBush.Tdrawn - 0.4)).toBeLessThan(1e-9);
    const cam = S.camera([0, 5, 0], [0, 5, 100], 40, 16 / 9);
    const th = S.nearThirds(fake, cam, null);
    expect(th[1]! > 0.3 && th[0]! < th[1]!).toBe(true);
  });

  it("rayBox: entry distance, 0 from inside, Infinity on a miss; a rotated slab", () => {
    const b = { kind: "x", id: 0, x: 0, y: 0, z: 10, w: 2, h: 2, d: 2, op: 1 };
    expect(S.rayBox([0, 0, 0], [0, 0, 1], b)).toBe(9);
    expect(S.rayBox([0, 0, 10], [0, 0, 1], b)).toBe(0);
    expect(S.rayBox([0, 0, 0], [0, 0, -1], b)).toBe(Infinity);
    expect(S.rayBox([5, 0, 0], [0, 0, 1], b)).toBe(Infinity);
    const c = Math.SQRT1_2;
    const rot = { ...b, w: 0.5, d: 6, rot: [c, c] as [number, number] };
    expect(S.rayBox([0, 0, 0], [0, 0, 1], rot)).toBeLessThan(10);
  });

  it("propBoxes: trees are trunk + canopy, mountains three tiers, sparse structures as opaque as their fill", () => {
    const t = { total: 1, props: { list: [
      { kind: "stonePine", x: 0, y: 10, z: 0, w: 8, h: 20, d: 8 },
      { kind: "mountain", x: 0, y: 50, z: 0, w: 300, h: 100, d: 300 },
      { kind: "structure", x: 0, y: 5, z: 0, w: 50, h: 10, d: 2, fill: 0.02 },
      { kind: "structure", x: 0, y: 5, z: 0, w: 50, h: 10, d: 2, fill: 0.5 },
      { kind: "gantry", x: 0, y: 6, z: 0, w: 20, h: 9, d: 2 },
    ] } } as unknown as FlybyTrack;
    const boxes = S.propBoxes(t);
    expect(boxes.map((b) => b.part ?? b.kind)).toEqual(["trunk", "canopy", "tier0", "tier1", "tier2", "structure", "gantry"]);
    expect(boxes[1]!.op).toBe(0.8);
    expect(boxes[5]!.op).toBe(0.8);
    expect(boxes[5]!.solid).toBe(true);
    expect(boxes[6]!.y).toBe(9);
  });

  it("mixCost: the report's thresholds", () => {
    expect(S.GROUND_OK).toBeLessThan(0.7);
    expect(S.mixCost({ ground: 0.5, sky: 0.2 })).toBe(0);
    expect(S.mixCost({ ground: 0.8, sky: 0 })).toBeGreaterThanOrEqual(15);
    expect(S.NEAR_M).toBe(30);
  });
});

describe.skipIf(!haveF1)("FlybySight on f1-game's Monza build", () => {
  const f1 = haveF1 ? f1Cam() : (null as unknown as F1Cam);

  it("offRoad: a box across the road at running height is dropped, a bridge-height one and a tree part kept; sceneOf applies it", () => {
    const track = f1.track("monza");
    const smp = { p: [0, 0, 0] as Vec3, t: [0, 0, 0] as Vec3, r: [0, 0, 0] as Vec3, hw: 10 };
    sample(track, track.total * 0.3, smp);
    const [x, y, z] = smp.p;
    const low = { kind: "building", id: 0, x, y: y + 2, z, w: 10, h: 4, d: 10, op: 1 };
    const high = { kind: "building", id: 1, x, y: y + 10, z, w: 10, h: 4, d: 10, op: 1 };
    const trunk = { kind: "tree", id: 2, x, y: y + 2, z, w: 10, h: 4, d: 10, op: 1, part: "trunk" };
    const kept = S.offRoad([low, high, trunk], track);
    expect(kept.map((b) => (b === low ? "low" : b === high ? "high" : "trunk"))).toEqual(["high", "trunk"]);
    expect(kept.droppedOverRoad).toBe(1);
    const clear = S.offRoad(S.propBoxes(track), track);
    expect(clear.droppedOverRoad).toBeGreaterThan(0);
    expect(S.sceneOf(track).boxes.length).toBe(clear.length + S.spanBoxes(track).length);
  }, 120_000);

  it("mix: the frame's sky / ground / prop shares", () => {
    const track = f1.track("monza");
    const b = createFlybySeq().bounds(track);
    const up = S.mix(track, S.camera([b.x, b.y + 400, b.z], [b.x + 100, b.y + 500, b.z], 40, 16 / 9));
    expect(up.sky).toBeGreaterThan(0.99);
    const down = S.mix(track, S.camera([b.x, b.y + 300, b.z], [b.x + 300, b.y, b.z], 40, 16 / 9));
    expect(down.ground + down.prop).toBeGreaterThan(0.6);
    expect(Math.abs(down.sky + down.ground + down.prop - 1)).toBeLessThan(1e-6);
  }, 120_000);
});
