// GradeTint: car-paint bases, the tuner scratch, and sky grade hue/sat.
//
// Port of f1-game js/fx/grade-tint.js:1-48, verbatim (same operation order in hue/sat;
// `M4.clamp` is ../physics/math.ts `clamp`, the same port of mat4.js:5). Pure.
//
// f1-game note (grade-tint.js:1-3): moved out of game.js (#1654). carPaint reuses one
// scratch; gfx.draw reads it synchronously, so one object is still safe across every
// car in the frame.
import { clamp } from "../physics/math";

/** A paint base (the four presets below, or a livery's own). */
export interface PaintBase {
  readonly emissive?: number;
  readonly roughness?: number | null;
  readonly metalness?: number;
  readonly specular?: number;
  readonly clearcoat?: number;
  readonly carPaint?: number | null;
  readonly sparkle?: number | null;
}

/** The `LightTune.LT` car-paint knobs carPaint scales by.
 *  TODO(lane-render): the lighting tuner owns these; the shell passes LT. */
export interface PaintTune {
  readonly carGloss: number;
  readonly carMetal: number;
  readonly carSpecular: number;
  readonly carClearcoat: number;
  readonly carGlow: number;
}

/** The scratch carPaint fills and returns (one object, reused per call). */
export interface CarPaint {
  roughness: number;
  metalness: number;
  specular: number;
  clearcoat: number;
  emissive: number;
  carPaint: number;
  sparkle: number;
  doubleSided: boolean;
}

export type Rgb = readonly [number, number, number] | readonly number[];

export const PAINT_WET_NIGHT: PaintBase = Object.freeze({ emissive: 0.20, roughness: 0.16, metalness: 0.12, specular: 0.85, clearcoat: 1.0, carPaint: 1.0 });
export const PAINT_WET_DAY: PaintBase   = Object.freeze({ roughness: 0.16, metalness: 0.12, specular: 0.85, clearcoat: 0.8, carPaint: 1.0 });
export const PAINT_DRY_NIGHT: PaintBase = Object.freeze({ emissive: 0.20, roughness: 0.22, metalness: 0.12, specular: 0.85, clearcoat: 1.0, carPaint: 1.0 });
export const PAINT_DRY_DAY: PaintBase   = Object.freeze({ roughness: 0.22, metalness: 0.12, specular: 0.85, clearcoat: 0.9, carPaint: 1.0 });
const _carPaintScratch: CarPaint = { roughness: 0, metalness: 0, specular: 0, clearcoat: 0, emissive: 0, carPaint: 0, sparkle: 0, doubleSided: true };

export function carPaint(base: PaintBase, LT: PaintTune): CarPaint {
  const m = _carPaintScratch;
  m.roughness = clamp((base.roughness != null ? base.roughness : 0.4) / LT.carGloss, 0.02, 1);
  m.metalness = clamp((base.metalness || 0) * LT.carMetal, 0, 1);
  m.specular  = (base.specular  || 0) * LT.carSpecular;
  m.clearcoat = (base.clearcoat || 0) * LT.carClearcoat;
  m.emissive  = (base.emissive  || 0) * LT.carGlow;
  m.carPaint  = base.carPaint != null ? base.carPaint : 0;
  m.sparkle   = base.sparkle  != null ? base.sparkle  : 1;
  m.doubleSided = true;
  return m;
}

/** Rotate `rgb`'s hue by `deg` about the luma axis (0 or a missing rgb: returned as is). */
export function hue<T extends Rgb | null | undefined>(rgb: T, deg: number | null | undefined): T | [number, number, number] {
  if (!deg || !rgb) return rgb;
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const r0 = rgb[0]!, g0 = rgb[1]!, b0 = rgb[2]!;
  const m = r0 * 0.213 + g0 * 0.715 + b0 * 0.072;
  const r = r0 - m, g = g0 - m, b = b0 - m;
  return [
    m + (r * (0.213 + c * 0.787 - s * 0.213) + g * (0.715 - c * 0.715 - s * 0.715) + b * (0.072 - c * 0.072 + s * 0.928)),
    m + (r * (0.213 - c * 0.213 + s * 0.143) + g * (0.715 + c * 0.285 + s * 0.140) + b * (0.072 - c * 0.072 - s * 0.283)),
    m + (r * (0.213 - c * 0.213 - s * 0.787) + g * (0.715 - c * 0.715 + s * 0.715) + b * (0.072 + c * 0.928 + s * 0.072)),
  ];
}

/** Scale `rgb`'s saturation about its luma by `amt`, floored at 0 (1 or a missing rgb: as is). */
export function sat<T extends Rgb | null | undefined>(rgb: T, amt: number): T | [number, number, number] {
  if (!rgb || amt === 1) return rgb;
  const r0 = rgb[0]!, g0 = rgb[1]!, b0 = rgb[2]!;
  const m = r0 * 0.213 + g0 * 0.715 + b0 * 0.072;
  return [Math.max(0, m + (r0 - m) * amt),
          Math.max(0, m + (g0 - m) * amt),
          Math.max(0, m + (b0 - m) * amt)];
}
