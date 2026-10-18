/** CamFovFit (src/camera/fov-fit.ts): landscape HFOV cap + portrait floor.
 *  Assertions ported from f1-game tests/unit/fov-fit.test.mjs:30-104; parity
 *  against f1-game js/camera/fov-fit.js run in a VM (Object.is on every value). */
import { describe, expect, it } from "vitest";
import { FOVY_MAX, HFOV_MAX, HFOV_MIN, fitFovY, hfovFromVfov } from "../../../src/camera/fov-fit";
import { f1Cam, hasCam } from "./f1-cam-vm";

const DEG = Math.PI / 180;

/** Old game.js inline formula (cap only) — landscape must stay bit-identical. */
function oldCapOnly(fovYRad: number, aspect: number, cine: boolean): number {
  if (cine) return fovYRad;
  const HMAX = 86 * Math.PI / 180;
  const fovYCap = 2 * Math.atan(Math.tan(HMAX / 2) / Math.max(aspect, 0.0001));
  return Math.min(fovYRad, fovYCap);
}

describe("fov-fit", () => {
  it("16:9 landscape: bit-identical to the old HFOV_MAX cap", () => {
    for (const deg of [18, 20, 30, 48, 62, 64, 78, 90]) {
      expect(Object.is(fitFovY(deg * DEG, 16 / 9, { cine: false }), oldCapOnly(deg * DEG, 16 / 9, false))).toBe(true);
    }
  });

  it("21:9 ultrawide: cap unchanged; the cap binds at HFOV_MAX", () => {
    for (const deg of [18, 20, 30, 62, 64, 78]) expect(fitFovY(deg * DEG, 21 / 9, {})).toBe(oldCapOnly(deg * DEG, 21 / 9, false));
    expect(Math.abs(hfovFromVfov(fitFovY(78 * DEG, 21 / 9, {}), 21 / 9) - HFOV_MAX)).toBeLessThan(1e-12);
  });

  it("square and near-landscape keep authored telephoto framing", () => {
    for (const aspect of [1, 1.0001, 4 / 3]) for (const deg of [18, 20, 30, 64, 90]) {
      expect(fitFovY(deg * DEG, aspect)).toBe(oldCapOnly(deg * DEG, aspect, false));
    }
  });

  it("portrait floor remains active up to the square boundary", () => {
    for (const aspect of [0.46, 9 / 16, 0.8, 0.9999]) {
      expect(fitFovY(20 * DEG, aspect)).toBe(Math.min(2 * Math.atan(Math.tan(HFOV_MIN / 2) / aspect), FOVY_MAX));
    }
  });

  it("0.46 portrait: HFOV floor widens VFOV, never past FOVY_MAX", () => {
    const aspect = 0.46;
    for (const deg of [64, 70, 78]) {
      const inY = deg * DEG, got = fitFovY(inY, aspect, { cine: false });
      expect(got).toBeGreaterThan(oldCapOnly(inY, aspect, false));
      expect(got).toBeGreaterThan(inY);
      const target = Math.min(HFOV_MIN, hfovFromVfov(FOVY_MAX, aspect));
      expect(hfovFromVfov(got, aspect) + 1e-9).toBeGreaterThanOrEqual(target);
      expect(got).toBeLessThanOrEqual(FOVY_MAX + 1e-12);
    }
  });

  it("cine passthrough: authored VFOV untouched on every aspect", () => {
    for (const deg of [18, 60, 120]) for (const aspect of [16 / 9, 21 / 9, 0.46, 1]) {
      expect(fitFovY(deg * DEG, aspect, { cine: true })).toBe(deg * DEG);
    }
  });

  it("spot values (f1-game reference)", () => {
    expect(fitFovY(64 * DEG, 0.46)).toBe(1.7453292519943295);
    expect(fitFovY(78 * DEG, 21 / 9)).toBe(0.7604080649677369);
    expect(fitFovY(20 * DEG, 9 / 16)).toBe(1.5968513788836174);
    expect(fitFovY(90 * DEG, 16 / 9)).toBe(0.9661722373633782);
  });

  it.skipIf(!hasCam)("bit-exact against f1-game fov-fit.js over an aspect x FOV grid", () => {
    const F = f1Cam<{ fitFovY(f: number, a: number, o?: unknown): number; hfovFromVfov(f: number, a: number): number; HFOV_MAX: number; HFOV_MIN: number; FOVY_MAX: number }>(["fov-fit.js"], "CamFovFit");
    expect([F.HFOV_MAX, F.HFOV_MIN, F.FOVY_MAX].every((v, i) => Object.is(v, [HFOV_MAX, HFOV_MIN, FOVY_MAX][i]))).toBe(true);
    let n = 0;
    for (const aspect of [0.0001, 0.3, 0.46, 0.5625, 0.75, 0.9999, 1, 1.3333, 1.7777, 2.3333, 3.5]) {
      for (let deg = 10; deg <= 130; deg += 0.75) {
        for (const opts of [undefined, { cine: false }, { cine: true }]) {
          const a = fitFovY(deg * DEG, aspect, opts), b = F.fitFovY(deg * DEG, aspect, opts);
          if (!Object.is(a, b)) throw new Error(`fitFovY(${deg}°, ${aspect}) ${a} vs ${b}`);
          n++;
        }
        if (!Object.is(hfovFromVfov(deg * DEG, aspect), F.hfovFromVfov(deg * DEG, aspect))) throw new Error("hfovFromVfov");
      }
    }
    expect(n).toBeGreaterThan(5000);
  });
});
