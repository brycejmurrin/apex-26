// Hand-written invariants the f1-game unit tests pin for these modules
// (tests/unit/{player-forces,tyre-model,grip-steer,contact-geometry}.test.mjs),
// kept beside the bit-exact fixtures because they say WHY a number matters.
import { describe, expect, it } from "vitest";
import { bumpRestitution } from "../../src/physics/ai-contact";
import { PhysicsConsts } from "../../src/physics/consts";
import { impulse, overlap } from "../../src/physics/contact-geometry";
import * as GripSteer from "../../src/physics/grip-steer";
import { tyreSat } from "../../src/physics/player-forces";
import * as Tyre from "../../src/physics/tyre-model";

const ctx: Tyre.TyreCtx = {
  raceTyreWear: "off",
  track: { length: 5793 },
  weatherArc: null,
  raceWeather: "dry",
  lapsTarget: 10,
  session: "race",
  LAT_MAX: 22,
  aTop: () => 7.3,
  vTop: () => 75.2,
};

describe("physics invariants", () => {
  it("tyreSat opposes slip and is odd in it (player-forces.test.mjs)", () => {
    expect(tyreSat(130, 0.1, 20)).toBeLessThan(0);
    expect(tyreSat(130, -0.1, 20)).toBeGreaterThan(0);
    expect(tyreSat(130, 0.1, 20) + tyreSat(130, -0.1, 20)).toBe(0);
  });

  it("the front curve peaks at exactly mu at CURVE_PEAK_X_F and never falls below the floor past it", () => {
    expect(Tyre.lateralCurve(Tyre.CURVE_PEAK_X_F)).toBe(1);
    for (let x = Tyre.CURVE_PEAK_X_F; x < 20; x += 0.25) expect(Tyre.lateralCurve(x)).toBeGreaterThanOrEqual(Tyre.CURVE_FLOOR - 1e-12);
  });

  it("tyre wear OFF is a true no-op: every multiplier is exactly 1", () => {
    const t = Tyre.create(ctx);
    const c: Tyre.TyreCar = { human: true, speed: 50, tyreWear: 0.9, tyreWearF: 1.1, tyreWearR: 0.7, tyreTs: 140 };
    t.update(c, 1 / 60);
    expect(c.tyreWear).toBe(0.9);
    expect([t.gripMul(c), t.tractionMul(c), t.fuelAccelMul(c), t.fuelVmaxMul(c)]).toEqual([1, 1, 1, 1]);
    expect(t.axleSplit(c)).toEqual({ f: 1, r: 1 });
  });

  it("GripSteer at notch 1 (the default) is the identity", () => {
    const gs = GripSteer.create();
    expect(gs.k()).toBe(0);
    expect(gs.forPlayer(0.42, { speed: 50, vLat: 3, yawRateCur: 0.4 }, { muF: 20, csFront: 130, af: 1.6, ar: 1.6, braking: false, shaped: 0.5, dt: 1 / 60 })).toBe(0.42);
  });

  it("an unyawed pair takes no restitution and the impulse never adds energy (contact-geometry.test.mjs)", () => {
    expect(bumpRestitution(0.5)).toBe(0);
    const a = { angle: 0.4, vx: 30, vy: 1, omega: 0.2, invMass: 0.5, invInertia: 0.5 / 2.253 };
    const b = { angle: -0.2, vx: 20, vy: -1, omega: 0, invMass: 1, invInertia: 0 };
    const ov = overlap(3, 0.5, a.angle, b.angle, {});
    expect(ov).not.toBeNull();
    const j = impulse(a, b, 3, 0.5, ov as { nx: number; ny: number }, {});
    const ke = (m: number, I: number, vx: number, vy: number, w: number): number =>
      (m ? (vx * vx + vy * vy) / m : 0) + (I ? (w * w) / I : 0);
    const before = ke(a.invMass, a.invInertia, a.vx, a.vy, a.omega) + ke(b.invMass, b.invInertia, b.vx, b.vy, b.omega);
    const after =
      ke(a.invMass, a.invInertia, a.vx + j.ax, a.vy + j.ay, a.omega + j.aw) + ke(b.invMass, b.invInertia, b.vx + j.bx, b.vy + j.by, b.omega + j.bw);
    expect(after).toBeLessThanOrEqual(before + 1e-9);
  });

  it("the consts carry f1-game's REVISION and fixed step", () => {
    expect(PhysicsConsts.REVISION).toBe("2026-09-ai-mistakes-1");
    expect(PhysicsConsts.FIXED_DT).toBe(1 / 60);
    expect(PhysicsConsts.BAND_CEIL).toBe(1);
  });
});
