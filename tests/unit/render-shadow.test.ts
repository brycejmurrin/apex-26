import { describe, expect, it } from "vitest";
import { shadowAnchor, SHADOW_RANGE } from "../../src/render/shadow";
import { sunMapSize } from "../../src/render/renderer";

const R: [number, number, number] = [1, 0, 0];
const U: [number, number, number] = [0, 0, 1];

describe("shadowAnchor (shadow-pass.js:251-284)", () => {
  it("biases min(20, 0.3 sBox) along the heading from the eye, at target height", () => {
    const a = shadowAnchor([10, 5, 10], [10, 1, 50], 0, R, U);
    expect(a.ctr).toEqual([10, 1, 10 + 20]);
    const b = shadowAnchor([0, 5, 0], [0, 0, 0], Math.PI / 2, R, U, 40);
    expect(b.ctr[0]).toBeCloseTo(12, 12);
    expect(b.ctr[2]).toBeCloseTo(0, 12);
  });

  it("falls back to the look direction without a heading", () => {
    const a = shadowAnchor([0, 5, 0], [30, 0, 40], null, R, U);
    expect(a.ctr[0]).toBeCloseTo(12, 12);
    expect(a.ctr[2]).toBeCloseTo(16, 12);
  });

  it("snaps to sBox/4 cells in light space", () => {
    const step = SHADOW_RANGE / 4;
    const a = shadowAnchor([33, 0, -7], [33, 0, 100], 0, R, U);
    expect(a.lu % step).toBe(0);
    expect(Math.abs(a.lv % step)).toBe(0);
    expect(a.lu).toBe(40);
  });

  it("does not move when only the camera rotates (heading fixed)", () => {
    const a = shadowAnchor([5, 2, 5], [50, 0, 5], 1, R, U);
    const b = shadowAnchor([5, 2, 5], [5, 0, -50], 1, R, U);
    expect(b).toEqual(a);
  });
});

describe("sunMapSize (tlx-shadow.js:65)", () => {
  it("is 1024 on phones, 512 on software GL, else 2048", () => {
    expect(sunMapSize(true, false)).toBe(1024);
    expect(sunMapSize(false, true)).toBe(512);
    expect(sunMapSize(false, false)).toBe(2048);
  });
});
