/**
 * The three scalar helpers the physics modules share.
 * Port of f1-game js/core/mat4.js:5-12 (`M4.clamp`, `M4.lerp`, `M4.wrapDelta`), verbatim.
 */

/** NaN passes through (both comparisons are false), exactly as f1-game. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function wrapDelta(d: number, period: number): number {
  const half = period * 0.5;
  if (d > half) return d - period;
  if (d < -half) return d + period;
  return d;
}
