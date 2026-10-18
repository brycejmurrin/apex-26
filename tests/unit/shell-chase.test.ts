import { describe, expect, it } from "vitest";
import { ChaseCam } from "../../src/camera/chase";
import { FlatLoop } from "../../src/app/flat-loop";
import { makePlaceholderCar, placeCar, stepPlaceholder } from "../../src/app/placeholder-body";
import type { PlayerInput } from "../../src/contracts/sim";
import type { TrackSample } from "../../src/contracts/track";

const flat: PlayerInput = { steer: 0, throttle: true, brake: false, throttleLevel: 1, brakeLevel: 0, shiftUp: false, shiftDown: false, aero: false, aeroToggle: false, overtake: false, boost: false };

describe("FlatLoop", () => {
  it("is a closed unit-speed loop with r = t x up = (-t.z, 0, t.x)", () => {
    const L = new FlatLoop(100);
    const a: TrackSample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
    const b: TrackSample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
    L.sample(0, a); L.sample(L.length, b);
    expect(b.p[0]).toBeCloseTo(a.p[0], 9); expect(b.p[2]).toBeCloseTo(a.p[2], 9);
    L.sample(1, b);
    expect(Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2])).toBeCloseTo(1, 4);
    L.sample(30, a);
    expect(a.r[0]).toBeCloseTo(-a.t[2], 12); expect(a.r[2]).toBeCloseTo(a.t[0], 12);
    // A right-hander: the centre is on the +r side.
    expect((-100 - a.p[0]) * a.r[0] + (0 - a.p[2]) * a.r[2]).toBeCloseTo(100, 6);
    expect(L.wrapS(-1)).toBeCloseTo(L.length - 1, 9);
  });
});

describe("placeholder body", () => {
  it("drives a lap of the flat loop on full throttle and steering toward the centre", () => {
    const track = new FlatLoop();
    const c = makePlaceholderCar();
    placeCar(c, track, -20);
    let crossings = 0;
    for (let i = 0; i < 60 * 120 && crossings < 2; i++) {
      // A simple driver: steer to hold x = 0 (reads only its own state).
      const steer = Math.max(-1, Math.min(1, -c.x * 0.3 + 0.4));   // + = right
      if (stepPlaceholder(c, { ...flat, steer }, track, 1 / 60)) crossings++;
    }
    expect(crossings).toBe(2);
    expect(c.prog).toBeGreaterThan(track.length);
  });
});

describe("ChaseCam", () => {
  it("sits behind and above the car, looking ahead of it", () => {
    const track = new FlatLoop();
    const cam = new ChaseCam(track);
    const c = makePlaceholderCar();
    placeCar(c, track, 100);
    const pose = cam.solve({ s: c.s, x: 0, speed: 0, px: c.px, pz: c.pz, head: c.head, yawRate: 0, pitch: 0, deploy: false, dt: 0 });
    const hx = Math.sin(c.head), hz = Math.cos(c.head);
    const eyeAlong = (pose.eye[0] - c.px) * hx + (pose.eye[2] - c.pz) * hz;
    const tgtAlong = (pose.target[0] - c.px) * hx + (pose.target[2] - c.pz) * hz;
    expect(eyeAlong).toBeLessThan(-3);
    expect(eyeAlong).toBeGreaterThan(-8);
    expect(tgtAlong).toBeGreaterThan(3);
    expect(pose.eye[1]).toBeCloseTo(1.35, 6);
    expect(pose.fovY).toBeCloseTo(57 * Math.PI / 180, 9);
  });

  it("widens the FOV and opens the rig with speed", () => {
    const track = new FlatLoop();
    const cam = new ChaseCam(track);
    const c = makePlaceholderCar();
    placeCar(c, track, 100);
    const at = (speed: number) => {
      const p = cam.solve({ s: c.s, x: 0, speed, px: c.px, pz: c.pz, head: c.head, yawRate: 0, pitch: 0, deploy: false, dt: 0 });
      return { fov: p.fovY, back: Math.hypot(p.eye[0] - c.px, p.eye[2] - c.pz) };
    };
    const slow = at(0), fast = at(72);
    expect(fast.fov).toBeGreaterThan(slow.fov);
    expect(fast.back).toBeGreaterThan(slow.back);
  });
});
