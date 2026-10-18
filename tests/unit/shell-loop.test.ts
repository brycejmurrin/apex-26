import { describe, expect, it } from "vitest";
import { FIXED_DT, FixedStepLoop, MAX_SUBSTEPS, lerpAngle } from "../../src/sim/loop";

function counting() {
  let steps = 0, snaps = 0;
  const loop = new FixedStepLoop({ beforeStep: () => { snaps++; }, step: (dt) => { expect(dt).toBe(FIXED_DT); steps++; } });
  return { loop, steps: () => steps, snaps: () => snaps };
}

describe("FixedStepLoop (game.js tickBody accumulator)", () => {
  it("steps once per 1/60 s regardless of the display rate", () => {
    for (const hz of [30, 60, 120, 144]) {
      const c = counting();
      let t = 1000;
      c.loop.frame(t);
      for (let i = 0; i < hz * 2; i++) { t += 1000 / hz; c.loop.frame(t); }
      // Two seconds of frames: 120 steps, give or take the sub-step remainder.
      expect(Math.abs(c.steps() - 120)).toBeLessThanOrEqual(1);
      expect(c.snaps()).toBe(c.steps());
    }
  });

  it("caps at 5 substeps and drops the whole-step backlog, keeping the remainder", () => {
    const c = counting();
    c.loop.frame(0);
    const r = c.loop.frame(250);   // 0.25 s = 15 steps owed
    expect(r.steps).toBe(MAX_SUBSTEPS);
    expect(r.dropped).toBeGreaterThan(0);
    expect(c.loop.acc).toBeLessThan(FIXED_DT);
    expect(c.loop.acc).toBeGreaterThanOrEqual(0);
  });

  it("clamps a long gap to 1/4 s and a backwards stamp to 0", () => {
    const c = counting();
    c.loop.frame(0);
    expect(c.loop.frame(10_000).dt).toBe(0.25);
    expect(c.loop.frame(9_000).dt).toBe(0);
  });

  it("reports alpha as the leftover fraction in 0..1", () => {
    const c = counting();
    const r = c.loop.advance(FIXED_DT * 1.5);
    expect(r.steps).toBe(1);
    expect(r.alpha).toBeCloseTo(0.5, 9);
  });

  it("does not step while not simulating", () => {
    const c = counting();
    c.loop.advance(0.1, false);
    expect(c.steps()).toBe(0);
    expect(c.loop.acc).toBe(0);
  });

  it("interpolates angles the short way round", () => {
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI, 9);
  });
});
