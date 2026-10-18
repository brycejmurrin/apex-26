// The physics provider: physicsTrack binds the physics lane's wallLimitsOf to a built track.
import { describe, expect, it } from "vitest";
import { wallLimitsOf } from "../../src/physics/contact-geometry";
import type { PostLimits, WallLimits } from "../../src/physics/track";
import { loadPhysicsTrack, physicsTrack, wallLimitsTrack } from "../../src/track/build/query";
import { buildTrack, defById } from "../../src/track/core/tracks";

const lim = (): WallLimits => ({ r: 0, l: 0, laneMin: 0, side: 0 });
const post = (): PostLimits => ({ r: 0, l: 0, minOut: 0, side: 0 });

describe("physicsTrack", () => {
  const { track, query } = loadPhysicsTrack("monza");

  it("exposes TrackQuery, street, and no curvature / racing line", () => {
    expect(query.length).toBe(track.total);
    expect(query.street).toBe(false);
    expect("curvature" in query).toBe(false);
    expect("line" in query).toBe(false);
  });

  it("wallLimits equals wallAt away from the pit complex", () => {
    const p = track.pit!;
    const s = (p.sB + 800) % track.total;
    const k = Math.round((s / track.total) * track.n) % track.n;
    expect(p.w[k]).toBe(0);
    const out = query.wallLimits(s, 0, lim(), post());
    expect(out).toEqual({ r: query.wallAt(s, 1), l: query.wallAt(s, -1), laneMin: 0, side: 0 });
  });

  it("the pit wall bounds the pit side on the pit straight, and opens the lane for a car beyond it", () => {
    const p = track.pit!;
    const s = (p.sIn + p.lenM / 2) % track.total;
    const inside = query.wallLimits(s, 0, lim(), post());
    const side = p.side > 0 ? inside.r : inside.l;
    expect(side).toBeLessThan(query.wallAt(s, p.side));
    const lane = query.wallLimits(s, p.side * 14, lim(), post());
    expect(lane.laneMin).toBeGreaterThan(0);
    expect(lane.side).toBe(p.side);
  });

  it("is the verbatim wallLimitsOf over the raw track, and sees a boundary set after binding", () => {
    const t = buildTrack(defById("spa")!);
    const q = physicsTrack(t);
    t.barL = new Float32Array(t.n).fill(5);
    t.barR = new Float32Array(t.n).fill(6);
    for (let s = 0; s < t.total; s += 37) {
      for (const x of [-12, 0, 12]) {
        expect(q.wallLimits(s, x, lim(), post())).toEqual(wallLimitsOf(wallLimitsTrack(t), s, x, lim(), post()));
      }
    }
    const far = (t.pit!.sB + 900) % t.total;
    expect(q.wallLimits(far, 0, lim(), post()).l).toBe(5);
  });
});
