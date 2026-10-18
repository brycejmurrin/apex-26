/**
 * TrackLine: the baked RACING LINE, a lateral offset per centreline node,
 * computed once at track build beside track.curv. Ported verbatim from
 * f1-game js/track/core/line.js (the TrackLine IIFE, :67-611).
 *
 * Summary of the f1-game header (line.js:1-66): per corner (a run of |curv|
 * above K_ON, same-sign runs within MERGE_M merged) the seed line is
 * outside-inside-outside knots (turn-in, an apex plateau on the inside edge,
 * a 1.25x exit) joined with a cosine ease; it is then RELAXED (Gauss-Seidel
 * SOR, coarse-to-fine 120/40/30 passes) toward the minimum of
 * Σ κ_line² + RELAX_LAM·Σ κ_road·x + SLOPE_NU·Σ x'² (κ_line the offset
 * curve's exact curvature), clamped to the road, and held under the lurch cap
 * SLOPE_MAX by projected trims. `lineW` is 1 inside a corner window, easing
 * to 0 over BLEND_M. `lineIn` / `lineOut` are the line shifted FAM_SHIFT_M
 * toward / away from the inside, weighted by `lineW`. `def.lineHints` lets a
 * circuit author a late apex or an apex bound (resolveHints). Coordinates: x
 * +right, +curv a LEFT turn, so the inside of a corner is -sign(curv) in x.
 *
 * Deviations from verbatim (types only, no math change):
 * - IIFE → ES module; `"use strict"` and `Object.freeze(TrackLine)` dropped
 *   (module exports are already immutable bindings).
 * - resolveHints' `Log.warn(...)` (wrapped in try/catch, line.js:352) is a
 *   plain `console.warn`; the `continue` is kept.
 * - Non-null assertions (`!`) on indexed reads and on track fields bakeFresh
 *   has already set/checked (curv in bakePathK, lineW/toTurnIn in at/attackAt).
 */
import type { Track } from "./types";
import { clamp, lerp } from "./math/scalar";

/** A baked corner window, as stored in `track.lineCorners` (line.js:232). */
export interface LineCorner {
  /** Arc s of the turn-in (entry knot), wrapped to [0, total). */
  s0: number;
  /** Arc s of the apex (curvature-weighted centre, after any apexShift hint). */
  sApex: number;
  /** Arc s of the exit knot. */
  s1: number;
  /** Signed peak curvature, rad/m (+ = left turn). */
  k: number;
  /** x sign of the inside edge (-sign(k)). */
  inside: number;
  /** Length of the curvature run, m. */
  len: number;
}

/** The shared sample `at()` returns (line.js:587). */
export interface LineSample {
  x: number;
  w: number;
}

/** The shared sample `attackAt()` returns (line.js:575). */
export interface AttackSample {
  q: number;
  toTurnIn: number;
}

/** rad/m (R < ~170 m) — gentler bends are flat-out kinks, not corners to apex (line.js:71). */
export const K_ON = 0.006;
const K_OFF = 0.0036;     // a corner that has begun ENDS only once the road is this straight (hysteresis)
const MERGE_M = 30;       // same-sign runs closer than this are one corner
const MIN_LEN_M = 12;     // shorter runs are wiggles, not corners
/** m inside the road edge the line keeps (line.js:76). */
export const MARGIN = 1.2;
const BLEND_M = 45;       // m over which the line's weight eases in/out at a corner window
const RELAX_LAM = 0.001;  // 1/m² — path-length weight against curvature²
const RELAX_OMEGA = 1.5;  // over-relaxation
const RELAX_PASSES = 30;  // fine passes
const RELAX_COARSE = 4;   // coarse stride (nodes) and its pass count
const RELAX_CPASSES = 120;
const RELAX_MPASSES = 40; // a stride-2 level between
const SLOPE_NU = 1e-4;    // 1/m² — weight of Σ x'² against Σ κ² (relaxLine): a light regulariser
/** m/m — the steepest road crossing the line ships with (24°) (line.js:90). */
export const SLOPE_MAX = 0.45;
const TRIM_ROUNDS = 6;    // rounds of {TRIM_RELAX relaxation passes, TRIM_PASSES projected trims}
const TRIM_RELAX = 5;
const TRIM_PASSES = 10;
const FAM_SHIFT_M = 1.5;       // m the INNER / OUTER families sit off the racing line inside a corner
const HINT_SNAP_M = 80;        // a hint's turn must sit within this of a baked corner's apex

// MEMO (line.js:108-145). Rebuilding the SAME circuit re-ran the whole bake for
// a byte-identical LUT. The key is everything bakeFresh reads: n, total, the
// curv and hw arrays (bit-for-bit) and def.lineHints / def.turns. The two most
// recent circuits are kept as private copies; a hit hands out fresh copies.
const MEMO_MAX = 2;
const OUT = ["line", "lineW", "lineIn", "lineOut", "lineK", "attackQ", "toTurnIn"] as const;
type LineBakeOut = Pick<Track, (typeof OUT)[number] | "lineCorners">;
interface MemoEntry {
  n: number;
  total: number;
  hints: string;
  curv: Float32Array;
  hw: Float32Array;
  out: LineBakeOut;
}
const _memo: MemoEntry[] = [];
// realm-safe (a Node VM test hands in the host's Float32Array)
const isF32 = (a: unknown): a is Float32Array => Object.prototype.toString.call(a) === "[object Float32Array]";
const bits = (a: Float32Array) => new Uint32Array(a.buffer, a.byteOffset, a.length);
function sameBits(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const u = bits(a), v = bits(b);
  for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
  return true;
}
const copyOut = <T extends LineBakeOut>(src: LineBakeOut, dst: T): T => {
  for (const f of OUT) { const a = src[f]; if (a) (dst as LineBakeOut)[f] = new Float32Array(a); }
  dst.lineCorners = src.lineCorners!.map((c) => ({ ...c }));
  return dst;
};

/** Bake the racing line onto `track` (memoised). f1-game line.js:134 */
export function bake(track: Track): Track {
  const curv = track.curv, hw = track.hw, def = track.def;
  if (!isF32(curv) || !isF32(hw)) return bakeFresh(track);
  const hints = JSON.stringify([def && def.lineHints, def && def.turns]);
  const hit = _memo.findIndex((m) => m.n === track.n && m.total === track.total && m.hints === hints &&
    sameBits(m.curv, curv) && sameBits(m.hw, hw));
  if (hit >= 0) { const m = _memo.splice(hit, 1)[0]!; _memo.unshift(m); return copyOut(m.out, track); }
  bakeFresh(track);
  _memo.unshift({ n: track.n, total: track.total, hints, curv: new Float32Array(curv), hw: new Float32Array(hw), out: copyOut(track, {}) });
  _memo.length = Math.min(_memo.length, MEMO_MAX);
  return track;
}

interface Run {
  i0: number;
  i1: number;
  sgn: number;
  sumK: number;
  sumKS: number;
  kMax: number;
  ks: number[];
}

interface Corner {
  apexStep: number;
  inside: number;
  wRoad: number;
  kMax: number;
  sgn: number;
  apexIn: number;
  apexOut: number;
  entryStep: number;
  exitStep: number;
  i0: number;
  i1: number;
}

interface Knot {
  step: number;
  x: number;
  edge?: "entry" | "apex" | "exit";
  shared?: boolean;
}

interface ResolvedHint {
  corner: Corner;
  apexShift: number;
  apexInside: number;
}

// line.js:147
function bakeFresh(track: Track): Track {
  const n = track.n, L = track.total, ds = L / n, curv = track.curv, hw = track.hw;
  const x = new Float32Array(n), w = new Float32Array(n);
  if (!n || !curv) { track.line = x; track.lineW = w; track.lineCorners = []; return track; }
  const wrapI = (i: number) => ((i % n) + n) % n;
  // 1. corner runs (wrap-aware): start the scan at a node the hysteresis cannot be holding
  //    (|curv| <= K_OFF), so no corner is split at the scan seam (#2545).
  let start = 0;
  for (let i = 0; i < n; i++) if (Math.abs(curv[i]!) <= K_OFF) { start = i; break; }
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let step = 0; step < n; step++) {
    const i = wrapI(start + step), k = curv[i]!, ak = Math.abs(k);
    const sgn = k > 0 ? 1 : -1;
    const on = cur && cur.sgn === sgn ? ak > K_OFF : ak > K_ON;
    if (on && cur && cur.sgn === sgn) { cur.i1 = step; cur.sumK += ak; cur.sumKS += ak * step; if (ak > cur.kMax) cur.kMax = ak; cur.ks.push(ak); }
    else if (on) { if (cur) runs.push(cur); cur = { i0: step, i1: step, sgn, sumK: ak, sumKS: ak * step, kMax: ak, ks: [ak] }; }
    else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  // A lap with no node at or below K_OFF cannot be cut at a straight: join the
  // last run to the first, the first shifted one lap, so the pair is one run.
  if (runs.length > 1) {
    const f = runs[0]!, l = runs[runs.length - 1]!;
    if (f.sgn === l.sgn && (f.i0 + n - l.i1) * ds < MERGE_M) {
      for (let g = l.i1 + 1; g < f.i0 + n; g++) l.ks.push(0);
      l.ks = l.ks.concat(f.ks);
      l.sumKS += f.sumKS + n * f.sumK; l.sumK += f.sumK; l.kMax = Math.max(l.kMax, f.kMax);
      l.i1 = f.i1 + n;
      runs.shift();
    }
  }
  // merge same-sign runs separated by less than MERGE_M
  const merged: Run[] = [];
  for (const r of runs) {
    const p = merged[merged.length - 1];
    if (p && p.sgn === r.sgn && (r.i0 - p.i1) * ds < MERGE_M) {
      for (let g = p.i1 + 1; g < r.i0; g++) p.ks.push(0);   // the gap's nodes, so ks stays aligned with i0..i1
      p.i1 = r.i1; p.sumK += r.sumK; p.sumKS += r.sumKS; p.kMax = Math.max(p.kMax, r.kMax); p.ks = p.ks.concat(r.ks);
    } else merged.push({ ...r, ks: r.ks.slice() });
  }
  // 2. corners with their knots (in scan-relative node units, may exceed n; wrapped on write)
  const corners: Corner[] = [];
  for (const r of merged) {
    if ((r.i1 - r.i0 + 1) * ds < MIN_LEN_M) continue;
    const apexStep = r.sumKS / r.sumK;
    const apexI = wrapI(start + Math.round(apexStep));
    const inside = -r.sgn;                                   // x sign of the inside edge
    const wRoad = Math.max(hw[apexI]! - MARGIN, 0.5);
    // The path's radius is larger than the road's: 1.5 R for the crossing distance.
    const R = 1.5 / Math.max(r.kMax, 1e-4);
    const turnIn = clamp(Math.sqrt(2 * R * 2 * wRoad), 25, 110);
    const exit = clamp(turnIn * 1.25, 30, 140);
    // The apex is a PLATEAU: every node at or above 55 % of the corner's peak
    // curvature, at least 6 m of it.
    let pIn = -1, pOut = -1;
    for (let q = 0; q < r.ks.length; q++) if (r.ks[q]! >= 0.55 * r.kMax) { if (pIn < 0) pIn = q; pOut = q; }
    let apexIn = r.i0 + pIn, apexOut = r.i0 + pOut;
    const minP = 6 / ds;
    if (apexOut - apexIn < minP) { const m = (apexIn + apexOut) / 2; apexIn = m - minP / 2; apexOut = m + minP / 2; }
    corners.push({ apexStep, inside, wRoad, kMax: r.kMax, sgn: r.sgn,
      apexIn, apexOut,
      entryStep: apexIn - turnIn / ds, exitStep: apexOut + exit / ds,
      i0: r.i0, i1: r.i1 });
  }
  // AUTHORED HINTS (def.lineHints): `apexShift` metres moves the whole corner's
  // knots later; `apexInside` (−1..1) bounds the apex plateau to the inside
  // (positive) or outside (negative). `turn` is 1-based into def.turns.
  const hints = resolveHints(track, corners, start, ds);
  for (const h of hints) if (h.apexShift) {
    const d = h.apexShift / ds, c = h.corner;
    c.apexStep += d; c.apexIn += d; c.apexOut += d; c.entryStep += d; c.exitStep += d;
  }
  track.lineCorners = corners.map((c) => ({
    s0: wrapS(L, (start + c.entryStep) * ds), sApex: wrapS(L, (start + c.apexStep) * ds), s1: wrapS(L, (start + c.exitStep) * ds),
    k: c.kMax * c.sgn, inside: c.inside, len: (c.i1 - c.i0 + 1) * ds,
  }));
  if (!corners.length) { track.line = x; track.lineW = w; return track; }
  // 3. knots: entry (outside), apex (inside), exit (outside); overlapping neighbours share a midpoint knot
  const knots: Knot[] = [];
  for (let ci = 0; ci < corners.length; ci++) {
    const c = corners[ci]!, prev = corners[ci - 1];
    const out = -c.inside * c.wRoad, apx = c.inside * c.wRoad;
    if (prev && prev.exitStep > c.entryStep) {
      // overlap: replace prev's exit knot and this entry knot with one shared knot
      const last = knots[knots.length - 1]!;
      const mid = (prev.apexStep + c.apexStep) / 2;
      const xm = (-prev.inside * prev.wRoad + out) / 2;
      last.step = mid; last.x = xm; last.shared = true;
    } else knots.push({ step: c.entryStep, x: out, edge: "entry" });
    knots.push({ step: c.apexIn, x: apx, edge: "apex" });
    knots.push({ step: c.apexOut, x: apx, edge: "apex" });
    knots.push({ step: c.exitStep, x: out, edge: "exit" });
  }
  // wrap closure: the lap's last exit joins the first entry
  knots.sort((a, b) => a.step - b.step);
  const first = knots[0]!, last = knots[knots.length - 1]!;
  if (last.step - n > first.step) { // the last exit wraps past the first entry: share
    const mid = (last.step - n + first.step) / 2, xm = (last.x + first.x) / 2;
    first.step = mid; first.x = xm; first.shared = true; knots.pop();
  }
  // 4. interpolate knots around the lap with a cosine ease
  const K = knots.length;
  for (let ki = 0; ki < K; ki++) {
    const a = knots[ki]!, b = knots[(ki + 1) % K]!;
    const bStep = ki + 1 < K ? b.step : b.step + n;
    const span = Math.max(bStep - a.step, 1e-6);
    const i0 = Math.ceil(a.step), i1 = Math.ceil(bStep);
    for (let i = i0; i < i1; i++) {
      const t = clamp((i - a.step) / span, 0, 1);
      const e = 0.5 - 0.5 * Math.cos(Math.PI * t);
      x[wrapI(start + i)] = lerp(a.x, b.x, e);
    }
  }
  // 5. weight: 1 from entry to exit of each corner window, easing over BLEND_M outside it
  const blendN = BLEND_M / ds;
  const insideSgn = new Float32Array(n);   // which way is the INSIDE of the corner at this node
  for (const c of corners) {
    const e0 = c.entryStep - blendN, e1 = c.exitStep + blendN;
    for (let i = Math.floor(e0); i <= Math.ceil(e1); i++) {
      let v = 1;
      if (i < c.entryStep) v = clamp((i - e0) / blendN, 0, 1);
      else if (i > c.exitStep) v = clamp((e1 - i) / blendN, 0, 1);
      const idx = wrapI(start + i);
      if (v > w[idx]!) { w[idx] = v; insideSgn[idx] = c.inside; }
    }
  }
  // 6. bounds (the road, MARGIN in, plus any authored apex bound), the seed
  //    clamped to them, then relaxed: coarse first, then fine.
  const lo = new Float32Array(n), hi = new Float32Array(n);
  for (let i = 0; i < n; i++) { const l = Math.max(hw[i]! - MARGIN, 0.5); lo[i] = -l; hi[i] = l; }
  for (const h of hints) if (h.apexInside) {
    const c = h.corner, f = clamp(h.apexInside, -1, 1), side = f > 0 ? c.inside : -c.inside, m = Math.abs(f);
    for (let q = Math.floor(c.apexIn); q <= Math.ceil(c.apexOut); q++) {
      const i = wrapI(start + q), l = Math.max(hw[i]! - MARGIN, 0.5);
      if (side < 0) hi[i] = Math.min(hi[i]!, -m * l); else lo[i] = Math.max(lo[i]!, m * l);
    }
  }
  for (let i = 0; i < n; i++) x[i] = clamp(x[i]!, lo[i]!, hi[i]!);
  relaxCoarse(x, curv, lo, hi, n, ds, RELAX_LAM, RELAX_CPASSES, RELAX_COARSE);
  relaxCoarse(x, curv, lo, hi, n, ds, RELAX_LAM, RELAX_MPASSES, 2);
  relaxLine(x, curv, lo, hi, n, ds, RELAX_PASSES, RELAX_LAM);
  for (let r = 0; r < TRIM_ROUNDS; r++) {
    trimSlopes(x, lo, hi, n, ds, TRIM_PASSES);
    relaxLine(x, curv, lo, hi, n, ds, TRIM_RELAX, RELAX_LAM);
  }
  trimSlopes(x, lo, hi, n, ds, TRIM_PASSES);
  // FAMILIES — the racing line shifted FAM_SHIFT_M toward the inside (INNER)
  // and the outside (OUTER), weighted by `lineW`, clamped to the road bounds.
  // O(n) construction (was two more relaxations; line.js:314-319).
  const xi = new Float32Array(n), xo = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = w[i]! * FAM_SHIFT_M * insideSgn[i]!;
    xi[i] = clamp(x[i]! + d, lo[i]!, hi[i]!);
    xo[i] = clamp(x[i]! - d, lo[i]!, hi[i]!);
  }
  track.line = x; track.lineW = w; track.lineIn = xi; track.lineOut = xo;
  bakeAttack(track, ds);
  bakePathK(track, ds);
  return track;
}

// def.lineHints → [{ corner, apexShift, apexInside }]: each hint's turn is
// snapped to the nearest baked corner's apex; a hint more than HINT_SNAP_M
// from any apex is dropped with a warning, never guessed. (line.js:336)
function resolveHints(track: Track, corners: Corner[], start: number, ds: number): ResolvedHint[] {
  const def = track.def, out: ResolvedHint[] = [];
  const list = def && def.lineHints, turns = def && def.turns;
  if (!list || !list.length || !turns || !turns.length || !corners.length) return out;
  const L = track.total;
  for (const h of list) {
    if (!h || !Number.isFinite(h.turn)) continue;
    const ti = ((Math.round(h.turn) - 1) % turns.length + turns.length) % turns.length;
    const sT = wrapS(L, (((turns[ti]! % 1) + 1) % 1) * L);
    let best: Corner | null = null, bd = Infinity;
    for (const c of corners) {
      const sA = wrapS(L, (start + c.apexStep) * ds);
      let d = Math.abs(sA - sT); if (d > L / 2) d = L - d;
      if (d < bd) { bd = d; best = c; }
    }
    if (!best || bd > HINT_SNAP_M) {
      console.warn("track", "lineHints: turn " + h.turn + " of " + def.id + " is " + Math.round(bd) + " m from any baked corner — dropped");
      continue;
    }
    out.push({ corner: best, apexShift: +(h.apexShift as number) || 0, apexInside: +(h.apexInside as number) || 0 });
  }
  return out;
}

/**
 * The offset curve's EXACT curvature (the same expression relaxLine
 * minimises), for audits and tests:
 *   κ_line = [(1+κx)²κ − (1+κx)x'' + x'(κ'x + 2κx')] / ((1+κx)² + x'²)^{3/2}.
 * f1-game line.js:371
 */
export function lineCurvature(track: Track): Float32Array {
  const n = track.n, ds = track.total / n, x = track.line, k = track.curv, out = new Float32Array(n);
  if (!x || !k) return out;
  const h = 0.5 / ds, inv2 = 1 / (ds * ds);
  for (let i = 0; i < n; i++) {
    const a = i ? i - 1 : n - 1, b = i + 1 < n ? i + 1 : 0;
    const u = 1 + k[i]! * x[i]!, xp = (x[b]! - x[a]!) * h, xpp = (x[a]! - 2 * x[i]! + x[b]!) * inv2, kp = (k[b]! - k[a]!) * h;
    out[i] = (u * u * k[i]! - u * xpp + xp * (kp * x[i]! + 2 * k[i]! * xp)) / Math.pow(u * u + xp * xp, 1.5);
  }
  return out;
}

// One SOR sweep per pass over the 3-node stencil of Σ κ_line² + λ Σ κ x: the
// 1-D Gauss-Newton step of the local sum, over-relaxed and clamped to the road,
// with the exact κ_line's partials per neighbour. (line.js:388)
function relaxLine(x: Float32Array, curv: Float32Array, lo: Float32Array, hi: Float32Array,
  n: number, ds: number, passes: number, lamK: number): void {
  const inv2 = 1 / (ds * ds), h = 0.5 / ds, lam = 0.5 * lamK;
  for (let p = 0; p < passes; p++) {
    // Alternate the sweep direction (symmetric SOR) so a conflict the bounds
    // cannot both satisfy is decided by the objective, not the sweep order.
    const fwd = (p & 1) === 0;
    for (let q = 0; q < n; q++) {
      const i = fwd ? q : n - 1 - q;
      const a = i ? i - 1 : n - 1, b = i + 1 < n ? i + 1 : 0;
      const aa = a ? a - 1 : n - 1, bb = b + 1 < n ? b + 1 : 0;
      const ci = curv[i]!, ca = curv[a]!, cb = curv[b]!;
      const xi = x[i]!, xa = x[a]!, xb = x[b]!, xaa = x[aa]!, xbb = x[bb]!;
      // node i: u depends on x_i, x'' does, x' does not
      const ui = Math.max(1 + ci * xi, 0.2), xpi = (xb - xa) * h, xppi = (xa - 2 * xi + xb) * inv2, kpi = (cb - ca) * h;
      const ri = Math.sqrt(ui * ui + xpi * xpi), Di = ri * ri * ri;
      const ki = (ui * ui * ci - ui * xppi + xpi * (kpi * xi + 2 * ci * xpi)) / Di;
      const gi = ((2 * ui * ci * ci - ci * xppi + 2 * ui * inv2 + xpi * kpi) - ki * 3 * ui * ci * ri) / Di;
      // node a: x_i is its NEXT neighbour (∂x'_a = h, ∂x''_a = inv2)
      const ua = Math.max(1 + ca * xa, 0.2), xpa = (xi - xaa) * h, xppa = (xaa - 2 * xa + xi) * inv2, kpa = (ci - curv[aa]!) * h;
      const ra = Math.sqrt(ua * ua + xpa * xpa), Da = ra * ra * ra;
      const ka = (ua * ua * ca - ua * xppa + xpa * (kpa * xa + 2 * ca * xpa)) / Da;
      const ga = ((-ua * inv2 + h * (kpa * xa + 4 * ca * xpa)) - ka * 3 * xpa * h * ra) / Da;
      // node b: x_i is its PREVIOUS neighbour (∂x'_b = −h, ∂x''_b = inv2)
      const ub = Math.max(1 + cb * xb, 0.2), xpb = (xbb - xi) * h, xppb = (xi - 2 * xb + xbb) * inv2, kpb = (curv[bb]! - ci) * h;
      const rb = Math.sqrt(ub * ub + xpb * xpb), Db = rb * rb * rb;
      const kb = (ub * ub * cb - ub * xppb + xpb * (kpb * xb + 2 * cb * xpb)) / Db;
      const gb = ((-ub * inv2 - h * (kpb * xb + 4 * cb * xpb)) + kb * 3 * xpb * h * rb) / Db;
      // + the crossing-angle term (a Laplacian, linear and SPD, so the sweep stays stable)
      const num = ki * gi + ka * ga + kb * gb + lam * ci - SLOPE_NU * xppi;
      const den = gi * gi + ga * ga + gb * gb + 2 * SLOPE_NU * inv2;
      const xn = xi - RELAX_OMEGA * num / den;
      x[i] = xn > hi[i]! ? hi[i]! : xn < lo[i]! ? lo[i]! : xn;
    }
  }
}

// The lurch cap (SLOPE_MAX), as alternating projected sweeps over the EDGES of
// the converged line: an edge steeper than the cap has its two ends moved
// toward each other by half the excess, inside the road. (line.js:439)
function trimSlopes(x: Float32Array, lo: Float32Array, hi: Float32Array, n: number, ds: number, passes: number): void {
  const sm = SLOPE_MAX * ds;
  for (let p = 0; p < passes; p++) {
    const fwd = (p & 1) === 0;
    for (let q = 0; q < n; q++) {
      const i = fwd ? q : n - 1 - q, b = i + 1 < n ? i + 1 : 0;
      const d = x[b]! - x[i]!, ad = d < 0 ? -d : d;
      if (ad <= sm) continue;
      const e = (ad - sm) * 0.5 * (d < 0 ? -1 : 1);
      const xi = x[i]! + e, xb = x[b]! - e;
      x[i] = xi > hi[i]! ? hi[i]! : xi < lo[i]! ? lo[i]! : xi;
      x[b] = xb > hi[b]! ? hi[b]! : xb < lo[b]! ? lo[b]! : xb;
    }
  }
}

// Coarse-to-fine: relax every st-th node as its own lap, then interpolate back. (line.js:457)
function relaxCoarse(x: Float32Array, curv: Float32Array, lo: Float32Array, hi: Float32Array,
  n: number, ds: number, lamK: number, passes: number, st: number): void {
  const m = Math.floor(n / st);
  if (m < 8) return;
  const xc = new Float32Array(m), kc = new Float32Array(m), loc = new Float32Array(m), hic = new Float32Array(m);
  for (let j = 0; j < m; j++) { const i = j * st; xc[j] = x[i]!; kc[j] = curv[i]!; loc[j] = lo[i]!; hic[j] = hi[i]!; }
  relaxLine(xc, kc, loc, hic, m, ds * st, passes, lamK);
  for (let j = 0; j < m; j++) {
    const x0 = xc[j]!, x1 = xc[j + 1 < m ? j + 1 : 0]!;
    const span = j + 1 < m ? st : n - j * st;                 // the last span wraps to node 0
    for (let q = 0; q < span; q++) x[j * st + q] = x0 + (x1 - x0) * q / span;
  }
}

// THE PATH'S CURVATURE (line.js:470-484): the widest arc touching the outside
// edge at the corner's ends and the inside edge at its apex,
//   ρ = (a² + b² - 2ab cos(θ/2)) / (2 (b - a cos(θ/2))),
// with the road's curvature eased toward it, never below PATH_FLOOR of it.
/** Floor of the path curvature as a fraction of the road's (line.js:485). */
export const PATH_FLOOR = 0.85;
// line.js:486
function bakePathK(track: Track, ds: number): void {
  const n = track.n, curv = track.curv!;
  const pk = new Float32Array(n);
  pk.set(curv);
  const wrapI = (i: number) => ((i % n) + n) % n;
  for (const c of track.lineCorners || []) {
    const i0 = Math.floor(c.s0 / (track.total) * n), i1 = Math.floor(c.s1 / track.total * n);
    const len = ((i1 - i0) % n + n) % n;
    // the corner's angle: |k| integrated over its window
    let theta = 0; for (let q = 0; q <= len; q++) theta += Math.abs(curv[wrapI(i0 + q)]!) * ds;
    const R = 1 / Math.max(Math.abs(c.k), 1e-4);
    const iA = Math.floor(c.sApex / track.total * n) % n;
    const w = Math.max(track.hw[iA]! - MARGIN, 0.5);
    const a = R + w, b = R - w, cs = Math.cos(Math.min(theta, Math.PI) / 2);
    const den = 2 * (b - a * cs);
    // den <= 0: the arc would need the straights beyond the corner's ends — the floor.
    const rho = den > 1e-3 ? (a * a + b * b - 2 * a * b * cs) / den : Infinity;
    const kArc = 1 / Math.max(rho, R);   // never tighter than the road
    for (let q = 0; q <= len; q++) {
      const i = wrapI(i0 + q), k = curv[i]!, ak = Math.abs(k);
      if (ak < 1e-6) continue;
      const eased = Math.max(Math.min(ak, kArc), PATH_FLOOR * ak);
      pk[i] = k >= 0 ? eased : -eased;
    }
  }
  track.lineK = pk;
}

/** The racing line's path curvature at arc `s` (0 before a bake). f1-game line.js:515 */
export function pathK(track: Track, s: number): number {
  const pk = track.lineK;
  if (!pk) return 0;
  const n = track.n, L = track.total;
  s %= L; if (s < 0) s += L;
  const fi = s / L * n;
  const i = Math.floor(fi) % n, j = (i + 1) % n, f = fi - Math.floor(fi);
  return lerp(pk[i]!, pk[j]!, f);
}

// ATTACK ZONES (line.js:525-533): each corner's zone is the ZONE_M before its
// turn-in; quality q is the feeding straight's length (0 at 60 m, 1 at 450 m)
// times the road width there (0 at 4 m half-width, 1 at 6.5 m). `toTurnIn` is
// the metres to the next turn-in.
/** m of braking zone before each turn-in (line.js:534). */
export const ZONE_M = 130;
// line.js:535
function bakeAttack(track: Track, ds: number): void {
  const n = track.n, L = track.total, cs = track.lineCorners || [], hw = track.hw;
  const q = new Float32Array(n), toIn = new Float32Array(n);
  toIn.fill(L);
  track.attackQ = q; track.toTurnIn = toIn;
  if (!cs.length) return;
  const sorted = cs.slice().sort((a, b) => a.s0 - b.s0);
  for (let ci = 0; ci < sorted.length; ci++) {
    const c = sorted[ci]!, prev = sorted[(ci - 1 + sorted.length) % sorted.length]!;
    // A NEGATIVE gap wraps the seam only at ci === 0 (and only when prev's own
    // window does not wrap); anywhere else it is an overlap (chicane / esses),
    // fed by no straight at all (line.js:544-556).
    let straight = c.s0 - prev.s1;
    if (straight < 0) straight = ci === 0 && prev.s1 >= prev.s0 ? straight + L : 0;
    if (sorted.length === 1) straight = L - (c.s1 - c.s0);
    const iMid = Math.floor(wrapS(L, c.s0 - ZONE_M / 2) / L * n) % n;
    const width = clamp((hw[iMid]! - 4) / 2.5, 0, 1);
    const qc = clamp((straight - 60) / 390, 0, 1) * width;
    const i0 = Math.floor(wrapS(L, c.s0 - ZONE_M) / L * n), i1 = Math.floor(c.s0 / L * n);
    for (let i = i0; i <= i0 + ((i1 - i0 + n) % n); i++) { const idx = ((i % n) + n) % n; if (qc > q[idx]!) q[idx] = qc; }
  }
  // metres to the next turn-in, walking backwards from each corner's s0
  const s0s = sorted.map((c) => c.s0);
  for (let i = 0; i < n; i++) {
    const s = i * ds; let best = L;
    for (const s0 of s0s) { let d = s0 - s; if (d < 0) d += L; if (d < best) best = d; }
    toIn[i] = best;
  }
}

const _atk: AttackSample = { q: 0, toTurnIn: 0 };
/** Attack-zone quality and metres to the next turn-in at `s`. Returns a shared object. f1-game line.js:576 */
export function attackAt(track: Track, s: number): AttackSample {
  if (!track.attackQ) { _atk.q = 0.5; _atk.toTurnIn = 1e9; return _atk; }
  const n = track.n, L = track.total;
  s %= L; if (s < 0) s += L;
  const i = Math.floor(s / L * n) % n;
  _atk.q = track.attackQ[i]!; _atk.toTurnIn = track.toTurnIn![i]! - (s - i * (L / n));
  return _atk;
}

// line.js:585
function wrapS(L: number, s: number): number { s %= L; if (s < 0) s += L; return s; }

const _out: LineSample = { x: 0, w: 0 };
_out.w = 0.5; _out.w = 0;   // born a Double field: a 0 literal is a Smi (PERF-HUNT-5)
/**
 * Racing-line offset `x` and weight `w` at arc `s`: O(1) index + lerp. `fam`
 * (optional, −1..1) blends toward a FAMILY: +1 the inner line, −1 the outer;
 * 0 / absent is the racing line. Returns a shared object. f1-game line.js:592
 */
export function at(track: Track, s: number, fam?: number): LineSample {
  const ln = track.line;
  if (!ln) { _out.x = 0; _out.w = 0; return _out; }
  const n = track.n, L = track.total;
  s %= L; if (s < 0) s += L;
  const fi = s / L * n;
  const i = Math.floor(fi) % n, j = (i + 1) % n, f = fi - Math.floor(fi);
  let xv = lerp(ln[i]!, ln[j]!, f);
  if (fam) {
    const alt = fam > 0 ? track.lineIn : track.lineOut;
    if (alt) xv = lerp(xv, lerp(alt[i]!, alt[j]!, f), Math.min(Math.abs(fam), 1));
  }
  _out.x = xv;
  _out.w = lerp(track.lineW![i]!, track.lineW![j]!, f);
  return _out;
}
