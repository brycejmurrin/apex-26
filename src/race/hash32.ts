/**
 * Stateless FNV-1a + murmur-style mix: the same string always yields the same
 * uint32 / unit float. Ported from f1-game js/core/hash32.js:5-28; `Career.hash`
 * (js/career/career.js:85) is `unit`.
 */
export function fnv1a(str: unknown): number {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** seed + colon-joined parts → [0, 1). */
export function unit(seed: number | string, ...parts: readonly (string | number)[]): number {
  return mix(fnv1a(seed + ":" + parts.join(":"))) / 4294967296;
}
