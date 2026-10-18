/**
 * The scalar helpers the track engine shares. Ported verbatim from f1-game
 * js/core/mat4.js:5-12 (`M4.clamp`, `M4.lerp`, `M4.wrapDelta`); the matrix half of
 * mat4.js is renderer math and is not needed by the track core.
 */

/** f1-game js/core/mat4.js:5 */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** f1-game js/core/mat4.js:6 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** f1-game js/core/mat4.js:7 */
export function wrapDelta(d: number, period: number): number {
  const half = period * 0.5;
  if (d > half) return d - period;
  if (d < -half) return d + period;
  return d;
}
