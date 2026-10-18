/**
 * ElevPresets: Flat / Rolling / Hilly node-height profiles for the track designer.
 * Ported verbatim from f1-game js/editor/elev-presets.js (ElevPresets IIFE, :1-122).
 *
 * Control points stay [x, z]; heights[] is parallel metres on the 0.25 m lattice
 * (CustomTracks.LIMITS.rise). Presets sample a smooth cosine-bump mix onto each node
 * so the Catmull-Rom centreline stays driveable. Pure; no DOM.
 *
 * Differs from f1-game:
 * - CustomTracks is an import, so lim() (elev-presets.js:10) is CustomTracks.LIMITS
 *   (the loaded branch; its fallback { rise: 60 } carries the same rise).
 * - The IIFE's frozen return object is this module's named exports.
 * - `!` non-null assertions and `as` casts are type-only; no runtime change.
 */
import * as CustomTracks from "./custom-tracks";
import type { RPt } from "./shape";

const UNIT = 4; // 0.25 m lattice
const q = (v: number) => Math.round(v * UNIT) / UNIT;
const lim = () => CustomTracks.LIMITS;
/** elev-presets.js:11 */
export const NAMES = Object.freeze(["flat", "rolling", "hilly"] as const);
export type ElevStyle = (typeof NAMES)[number];

/** One cosine bump: centre (lap fraction), half-length (m), signed rise (m). */
export interface Bump { sFrac: number; halfM: number; rise: number }

/** Clamp one height onto the lattice inside ±rise. elev-presets.js:14 */
export function clampH(h: unknown): number {
  const cap = lim().rise;
  const v = Number.isFinite(+(h as number)) ? +(h as number) : 0;
  return q(Math.min(cap, Math.max(-cap, v))) || 0;
}

/** Parallel heights for pts.length. Missing / short / garbage → zeros (flat). Longer
 *  lists are truncated. Always returns a fresh array. elev-presets.js:22 */
export function sanitize(pts: unknown, heights: unknown): number[] {
  const n = Array.isArray(pts) ? pts.length : 0;
  const out: number[] = new Array(n);
  const src: unknown[] | null = Array.isArray(heights) ? heights : null;
  for (let i = 0; i < n; i++) out[i] = src && i < src.length ? clampH(src[i]) : 0;
  return out;
}

/** True when every height is 0 (or the list is empty). elev-presets.js:31 */
export function isFlat(heights: unknown): boolean {
  if (!Array.isArray(heights) || !heights.length) return true;
  for (let i = 0; i < heights.length; i++) if (heights[i]) return false;
  return true;
}

/** Control-polygon arc lengths (closing chord included). elev-presets.js:38 */
export function arcs(pts: readonly RPt[]): Float64Array {
  const n = pts.length, c = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    c[i + 1] = c[i]! + Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
  }
  return c;
}

/** Cosine bump height at arc metres s along lap L for {sFrac, halfM, rise}. elev-presets.js:48 */
function bumpAt(sM: number, L: number, b: Bump | null | undefined): number {
  if (!b || !(L > 0) || !(b.halfM > 0)) return 0;
  let d = Math.abs(sM - b.sFrac * L);
  d = Math.min(d, L - d);
  if (d >= b.halfM) return 0;
  return b.rise * 0.5 * (1 + Math.cos(Math.PI * d / b.halfM));
}

/** Sample bumps onto every control point; return lattice heights. elev-presets.js:57 */
export function sample(pts: readonly RPt[], bumps: readonly (Bump | null | undefined)[]): number[] {
  const n = pts.length;
  if (!n) return [];
  const c = arcs(pts), L = c[n] || 1;
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let y = 0;
    for (let k = 0; k < bumps.length; k++) y += bumpAt(c[i]!, L, bumps[k]);
    out[i] = clampH(y);
  }
  // Close the loop: pin start height, blend the last few metres into it.
  out[0] = 0;
  if (n > 2) {
    const blend = Math.min(3, n - 1);
    for (let j = 1; j <= blend; j++) {
      const i = n - j;
      const t = j / (blend + 1);
      out[i] = clampH(out[i]! * (1 - t));
    }
  }
  return out;
}

/** Deterministic [0,1) from seed + salt (same family as TrackRandom). elev-presets.js:81 */
function rnd(seed: number, salt: number): number {
  let x = Math.sin(((seed >>> 0) + salt * 78.233) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Build a bump list for style; empty for flat. elev-presets.js:87 */
export function plan(style: unknown, seed: number, L: number): Bump[] {
  const s = String(style || "flat").toLowerCase();
  if (s === "flat" || !(L > 0)) return [];
  const hilly = s === "hilly";
  const n = hilly ? 3 + Math.floor(rnd(seed, 1) * 4) : 2 + Math.floor(rnd(seed, 1) * 3); // 3–6 / 2–4
  const riseLo = hilly ? 12 : 4, riseHi = hilly ? 25 : 8;
  const halfLo = hilly ? 180 : 200, halfHi = hilly ? 420 : 400;
  const out: Bump[] = [];
  for (let i = 0; i < n; i++) {
    const sFrac = (i + 0.35 + rnd(seed, 10 + i) * 0.4) / n;
    const rise = (riseLo + rnd(seed, 20 + i) * (riseHi - riseLo)) * (rnd(seed, 30 + i) < 0.35 ? -1 : 1);
    const halfM = halfLo + rnd(seed, 40 + i) * (halfHi - halfLo);
    // Keep grade under ~8 %: |rise| ≤ halfM / 19.6
    const cap = halfM / 19.6;
    out.push({ sFrac: ((sFrac % 1) + 1) % 1, halfM, rise: Math.sign(rise) * Math.min(Math.abs(rise), cap) });
  }
  return out;
}

/** Apply a named preset onto pts. Returns { heights, style }. One UNDO entry at the
 *  screen. Unknown style → flat. elev-presets.js:108 */
export function apply(style: unknown, pts: unknown, opts?: { seed?: unknown } | null): { heights: number[]; style: ElevStyle } {
  const name = (NAMES as readonly string[]).includes(String(style || "").toLowerCase()) ? String(style).toLowerCase() as ElevStyle : "flat";
  const seed = opts && Number.isFinite(+(opts.seed as number)) ? (+(opts.seed as number) >>> 0) : 1;
  if (name === "flat" || !Array.isArray(pts) || pts.length < 3) {
    return { heights: sanitize(pts, null), style: "flat" };
  }
  const c = arcs(pts as readonly RPt[]), L = c[pts.length] || 0;
  return { heights: sample(pts as readonly RPt[], plan(name, seed, L)), style: name };
}
