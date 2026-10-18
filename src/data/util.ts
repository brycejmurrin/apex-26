/* Small pure helpers the data modules share, ported verbatim from f1-game:
 *   clamp       js/core/mat4.js:5      (M4.clamp)
 *   fnv1a, mix  js/core/hash32.js:5-22 (Hash32.fnv1a / Hash32.mix)
 * Stateless: same input, same uint32, in every realm. Not a simulation RNG.
 * TODO(lane-core): when a shared core module ports M4 / Hash32, re-export from
 * there and delete this file. */

/** M4.clamp (mat4.js:5): comparison-only, so NaN passes through as f1-game's does. */
export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/** Hash32.fnv1a (hash32.js:5-13): FNV-1a over UTF-16 code units, as uint32. */
export function fnv1a(str: unknown): number {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Hash32.mix (hash32.js:15-22): murmur3 fmix32 finaliser, as uint32. */
export function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
