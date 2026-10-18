// src/fx/grade-tint.ts vs f1-game js/fx/grade-tint.js: hue/sat/carPaint over a seeded
// sweep compared with Object.is, plus spot values.
import { describe, expect, it } from "vitest";
import { carPaint, hue, PAINT_DRY_DAY, PAINT_DRY_NIGHT, PAINT_WET_DAY, PAINT_WET_NIGHT, sat, type PaintBase, type PaintTune } from "../../../src/fx/grade-tint";
import { f1Get, hasF1Fx, loadF1Fx, seeded } from "./f1-fx-vm";

interface GT {
  carPaint(b: PaintBase, LT: PaintTune): object;
  hue(rgb: number[] | null, deg: number): number[] | null;
  sat(rgb: number[] | null, amt: number): number[] | null;
  PAINT_WET_NIGHT: PaintBase; PAINT_WET_DAY: PaintBase; PAINT_DRY_NIGHT: PaintBase; PAINT_DRY_DAY: PaintBase;
}

const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return Object.is(a, b);
};

describe.skipIf(!hasF1Fx)("grade-tint parity with f1-game js/fx/grade-tint.js (VM)", () => {
  it("hue, sat and carPaint match bit for bit over 2000 seeded inputs; the presets are equal", () => {
    // grade-tint.js reads M4.clamp at call time: load f1-game's mat4.js first.
    const G = f1Get<GT>(loadF1Fx(["js/core/mat4.js", "js/fx/grade-tint.js"]), "GradeTint");
    expect({ ...G.PAINT_WET_NIGHT }).toEqual({ ...PAINT_WET_NIGHT });
    expect({ ...G.PAINT_WET_DAY }).toEqual({ ...PAINT_WET_DAY });
    expect({ ...G.PAINT_DRY_NIGHT }).toEqual({ ...PAINT_DRY_NIGHT });
    expect({ ...G.PAINT_DRY_DAY }).toEqual({ ...PAINT_DRY_DAY });
    const A = seeded(0x6ad3);
    for (let i = 0; i < 2000; i++) {
      const rgb = [A() * 1.5, A(), A() * 2];
      const deg = i % 10 === 0 ? 0 : A() * 720 - 360, amt = i % 13 === 0 ? 1 : A() * 3;
      expect(same(hue(rgb, deg), G.hue(rgb, deg)), `hue ${i}`).toBe(true);
      expect(same(sat(rgb, amt), G.sat(rgb, amt)), `sat ${i}`).toBe(true);
      const base: PaintBase = i % 5 === 0 ? {} : { roughness: A(), metalness: A(), specular: A(), clearcoat: A(), emissive: A(), carPaint: A(), sparkle: A() };
      const LT: PaintTune = { carGloss: 0.2 + A() * 2, carMetal: A() * 2, carSpecular: A() * 2, carClearcoat: A() * 2, carGlow: A() * 2 };
      expect(same({ ...carPaint(base, LT) }, { ...G.carPaint(base, LT) }), `carPaint ${i}`).toBe(true);
    }
  });
});

describe("grade-tint spot values (grade-tint.js:6-47)", () => {
  it("hue 0 and sat 1 return the same array; a null rgb passes through", () => {
    const rgb = [0.2, 0.4, 0.6];
    expect(hue(rgb, 0)).toBe(rgb);
    expect(sat(rgb, 1)).toBe(rgb);
    expect(hue(null, 30)).toBe(null);
    expect(sat(undefined, 0.5)).toBe(undefined);
  });

  it("grey is a fixed point of hue; sat 0 is luma grey; sat floors at 0", () => {
    const h = hue([0.5, 0.5, 0.5], 123) as number[];
    for (const v of h) expect(v).toBeCloseTo(0.5, 12);
    const m = 0.9 * 0.213 + 0.1 * 0.715 + 0.3 * 0.072;
    expect(sat([0.9, 0.1, 0.3], 0)).toEqual([m, m, m]);
    expect(sat([1, 0, 0], 5)![1]).toBe(0);
  });

  it("carPaint scales the base by the tuner and clamps roughness / metalness", () => {
    const LT: PaintTune = { carGloss: 2, carMetal: 10, carSpecular: 1, carClearcoat: 0.5, carGlow: 3 };
    const m = carPaint(PAINT_DRY_NIGHT, LT);
    expect(m).toEqual({ roughness: 0.22 / 2, metalness: 1, specular: 0.85, clearcoat: 0.5, emissive: 0.20 * 3, carPaint: 1, sparkle: 1, doubleSided: true });
    expect(carPaint({}, { ...LT, carGloss: 100 }).roughness).toBe(0.02);
    expect(carPaint(PAINT_DRY_DAY, LT), "one scratch object").toBe(m);
  });
});
