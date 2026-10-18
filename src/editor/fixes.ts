/**
 * TrackFixes: one-click remedies for the track designer's CHECKS (TrackValidate).
 * Ported verbatim from f1-game js/editor/fixes.js (TrackFixes IIFE, :1-398).
 *
 * Each remedy takes a design and one issue and returns a NEW design (never the input
 * mutated) on the 0.25 m storage lattice, with point 0 still the start (except the
 * start remedy, whose whole job is to move it) and every zone still where it was on
 * the road: START moves the line to the longest straight (the designer's START HERE
 * shift), LENGTH and BOUNDS scale or centre the loop, SPACING / POINTS merge and thin
 * with RDP, KINK / RADIUS / FOLD relax the control points under the issue, CROSSING
 * adds a bridge, and CLEARANCE pushes two close sections apart. fixAll runs them over
 * every RED (≤ 3 rounds). Pure.
 *
 * Differs from f1-game:
 * - TrackShape, TrackRandom, TrackValidate, CustomTracks and TrackPit are imports, so
 *   every `typeof X !== "undefined"` guard takes the branch the browser takes with all
 *   modules loaded: LIM() is TrackValidate.LIMITS (fixes.js:28), zonesCap() is
 *   CustomTracks.LIMITS.zones (:29), fixStart never returns early (:155), fixSmooth
 *   always re-checks through TrackValidate (the Menger-only branch, :239-241, is
 *   gone), fixClearance never breaks for a missing validator (:324), pitReach's guard
 *   (:286) is gone, and fixAll's default judge is TrackValidate.check (:373).
 * - The `warn()` helper (:30) and apply's Log.warn in its catch (:364) are dropped.
 * - `!` non-null assertions and `as` casts are type-only; no runtime change.
 */
import * as CustomTracks from "./custom-tracks";
import * as TrackRandom from "./randomise";
import * as S from "./shape";
import type { Pt } from "./shape";
import * as TrackValidate from "./validate";
import type { Verdict } from "./validate";
import * as TrackPit from "../track/core/pit";
import type { PitDefLike } from "../track/core/pit";

/** A design record as the remedies read it: anything a caller hands in (JSON-shaped). */
export type FixDesign = { [key: string]: unknown };
/** An issue as the remedies read it (TrackValidate.Issue, or garbage). */
export interface FixIssue { code?: unknown; level?: unknown; fix?: unknown; s?: unknown; s2?: unknown; msg?: unknown }
/** The `built` argument: a TrackValidate.check verdict, its tr, or anything else. */
export interface BuiltLike {
  px?: ArrayLike<number>; pz?: ArrayLike<number>; hw?: ArrayLike<number>; n?: number; total?: number;
  tr?: BuiltLike | null; stats?: { lengthM?: number } | null; def?: unknown;
}
/** A remedy's result: a NEW design and what it did. */
export interface FixResult { design: FixDesign & { pts: Pt[] }; msg: string }
/** fixAll's judge: TrackValidate.check, or a stand-in with its verdict shape. */
export type Judge = (design: unknown) => Verdict | null | undefined;

/** The built centreline columns the remedies read. */
interface TrLike { n: number; total: number; px: ArrayLike<number>; pz: ArrayLike<number>; hw: ArrayLike<number> }
type Rec = { [key: string]: unknown };
type Pairs = [number, number][];

/** fixes.js:15 */
export const BRIDGE = Object.freeze({ halfM: 160, rise: 8 });
/** fixes.js:16 */
export const LAP = Object.freeze({ short: 4000, long: 6500 });
const MAP = 9500, SPACING = 8, PTS_CAP = 180, PULL = 0.3, PASSES = 3, ROUNDS = 3;
// fixAll's order: the start and the scale first (they move everything), the
// point count before the local edits (an index window must stay put), the
// bridge before clearance (a crossing is also the closest approach).
/** fixes.js:21 */
export const ORDER = Object.freeze(["start", "length", "bounds", "spacing", "points", "kink", "radius", "fold", "crossing", "clearance"] as const);
const REPEAT: { [code: string]: number } = { crossing: 4, clearance: 3 };            // several crossings in one round; one try for the rest

const q = (v: number) => Math.round(v * 4) / 4;
const wrap01 = (v: number) => ((v % 1) + 1) % 1;
const lattice = (pts: readonly (readonly number[])[]): Pt[] => pts.map((p) => [q(p[0]!), q(p[1]!)]);
const km = (m: number) => (m / 1000).toFixed(2) + " km";
const LIM = () => TrackValidate.LIMITS;
const zonesCap = () => CustomTracks.LIMITS.zones;

/** A clean copy of the control points, or null when any is malformed. fixes.js:33 */
function ptsOf(d: unknown): Pt[] | null {
  if (!d || typeof d !== "object" || !Array.isArray((d as Rec).pts)) return null;
  const out: Pt[] = [];
  for (const p of (d as Rec).pts as unknown[]) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = +p[0], z = +p[1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    out.push([x, z]);
  }
  return out.length >= 3 ? out : null;
}
const clone = <T>(d: T): T => JSON.parse(JSON.stringify(d)) as T;
function cum(pts: readonly Pt[]): number[] {
  const c = [0];
  for (let i = 0; i < pts.length; i++) { const a = pts[i]!, b = pts[(i + 1) % pts.length]!; c.push(c[i]! + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  return c;
}
const samePts = (a: readonly Pt[], b: readonly Pt[]) => a.length === b.length && a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1]);

/** Every zone list through one fraction map (the designer's zoneMap shapes). fixes.js:53 */
function mapZones(d: Rec, at: (f: number) => number): Rec {
  const pt = (key: string) => (z: unknown) => (z && Number.isFinite((z as Rec)[key]) ? Object.assign({}, z, { [key]: wrap01(at((z as Rec)[key] as number)) }) : z);
  const range = (z: unknown) => (z && Number.isFinite((z as Rec).s0) && Number.isFinite((z as Rec).s1) ? Object.assign({}, z, { s0: wrap01(at((z as Rec).s0 as number)), s1: wrap01(at((z as Rec).s1 as number)) }) : z);
  const each = (list: unknown, fn: (z: unknown) => unknown) => (Array.isArray(list) ? list.map(fn) : list);
  const out: Rec = { hwZones: each(d.hwZones, range), bankZones: each(d.bankZones, pt("frac")), elevations: each(d.elevations, pt("s")), bridges: each(d.bridges, pt("s")) };
  if (Array.isArray(d.props)) out.props = each(d.props, pt("s"));   // authored scenery rides the road like any zone
  return out;
}
/** Zones follow the road through an edit: anchors are the control points both loops
 *  share (`pairs` [oldIdx, newIdx], starting [0, 0]); a zone keeps its share of the
 *  stretch between its two anchors, so one on an untouched segment stays on the
 *  same metre of road. fixes.js:65 */
function remap<D extends Rec>(d: D, oldPts: readonly Pt[], newPts: readonly Pt[], pairs: Pairs): D {
  const cO = cum(oldPts), cN = cum(newPts), LO = cO[oldPts.length]!, LN = cN[newPts.length]!;
  if (!(LO > 0 && LN > 0)) return d;
  const A = pairs.map(([o, n]): [number, number] => [cO[o]!, cN[n]!]).concat([[LO, LN]]);
  const at = (f: number) => {
    const x = wrap01(f) * LO;
    let k = 0;
    while (k < A.length - 2 && x >= A[k + 1]![0]) k++;
    const span = A[k + 1]![0] - A[k]![0];
    return (A[k]![1] + (span > 0 ? (x - A[k]![0]) / span : 0) * (A[k + 1]![1] - A[k]![1])) / LN;
  };
  return Object.assign(d, mapZones(d, at));
}
/** [old, new] index pairs for points that survived by reference (enforceSpacing / rdp keep references). fixes.js:79 */
function survivors(aligned: readonly Pt[], out: readonly Pt[]): Pairs | null {
  const idx = new Map(aligned.map((p, i) => [p, i])), pairs: Pairs = [];
  out.forEach((p, j) => { if (idx.has(p)) pairs.push([idx.get(p)!, j]); });
  return pairs.length && pairs[0]![0] === 0 && pairs[0]![1] === 0 ? pairs : null;
}
/** The new design: a clone with `pts` (on the lattice) and zones + heights remapped by `pairs` (null: fractions stand). fixes.js:85 */
function rebuilt(d: FixDesign, oldPts: readonly Pt[], newPts: readonly Pt[], pairs: Pairs | null): FixDesign & { pts: Pt[] } {
  const out = clone(d) as FixDesign & { pts: Pt[] };
  out.pts = lattice(newPts);
  // Heights are parallel to pts BY INDEX: a merged or thinned point would otherwise
  // slide every later height one point down the road. Every new point is a survivor
  // (enforceSpacing / rdp only drop), so each has a pair.
  if (pairs && Array.isArray(d.heights) && d.heights.length === oldPts.length) {
    const heights: number[] = out.pts.map(() => 0);
    out.heights = heights;
    for (const [o, n] of pairs) if (Number.isFinite(+d.heights[o])) heights[n] = +d.heights[o];
  }
  return pairs ? remap(out, oldPts, out.pts, pairs) : out;
}

/** The built centreline: the verdict's / the tr passed in, else a fresh engine build. fixes.js:99 */
function trOf(d: unknown, built: BuiltLike | null): TrLike | null {
  if (built && built.px && (built.total as number) > 0) return built as TrLike;
  if (built && built.tr && built.tr.px && (built.tr.total as number) > 0) return built.tr as TrLike;
  try { const b = TrackValidate.build(d); return b && b.tr && b.tr.total > 0 ? b.tr : null; } catch (_) { return null; }
}
/** The built lap length (m): built.total / built.tr.total / built.stats.lengthM, else a build, else the control polygon. fixes.js:106 */
function lapOf(d: unknown, pts: readonly Pt[], built: BuiltLike | null): number {
  if (built && (built.total as number) > 0) return built.total!;
  if (built && built.tr && (built.tr.total as number) > 0) return built.tr.total!;
  if (built && built.stats && (built.stats.lengthM as number) > 0) return built.stats.lengthM!;
  const tr = trOf(d, null);
  return tr ? tr.total : S.polyLen(pts, true);
}
/** The control point under built arc s: within ±8 % of the lap by arc fraction, the
 *  one nearest the built node at s (exact when the tr is known). skip0: never point 0. fixes.js:116 */
function nearestCtrl(pts: readonly Pt[], tr: TrLike | null, s: number, skip0: boolean): number {
  const N = pts.length, c = cum(pts), L = c[N]!, Lb = tr ? tr.total : L, x = wrap01(s / Lb) * L;
  const arcD = (i: number) => { const v = Math.abs(c[i]! - x) % L; return Math.min(v, L - v); };
  let target: [number, number] | null = null;
  if (tr && tr.px && tr.n) { const k = ((Math.round(s / (tr.total / tr.n)) % tr.n) + tr.n) % tr.n; target = [tr.px[k]!, tr.pz[k]!]; }
  const win = Math.max(0.08 * L, 150);
  let best = -1, bd = Infinity;
  for (let i = skip0 ? 1 : 0; i < N; i++) {
    const a = arcD(i);
    if (a > win) continue;
    const score = target ? Math.hypot(pts[i]![0] - target[0], pts[i]![1] - target[1]) : a;
    if (score < bd) { bd = score; best = i; }
  }
  if (best < 0) for (let i = skip0 ? 1 : 0; i < N; i++) { const a = arcD(i); if (a < bd) { bd = a; best = i; } }
  return best;
}
/** Three consecutive control indices around c that leave point 0 alone. fixes.js:133 */
function windowAt(c: number, N: number): number[] {
  const w = (i: number) => ((i % N) + N) % N;
  if (c === 0) return [N - 1, 1, 2];
  if (c === 1) return [1, 2, 3];
  if (c === N - 1) return [N - 3, N - 2, N - 1];
  return [w(c - 1), c, w(c + 1)];
}
const circ = (a: number, b: number, L: number) => { const v = Math.abs(a - b) % L; return Math.min(v, L - v); };
/** Is a `code` issue at `level` (or worse) still within `nearM` of built arc s? fixes.js:142 */
function stillThere(v: Verdict | null, code: unknown, level: unknown, s: unknown, nearM: number): boolean {
  if (!v || !Array.isArray(v.issues)) return true;
  const L = (v.tr && v.tr.total) || (v.stats && v.stats.lengthM) || 1;
  return v.issues.some((i) => i.code === code && (level === "amber" ? i.level !== "info" : i.level === "red") && (!Number.isFinite(i.s) || !Number.isFinite(s) || circ(i.s!, s as number, L) < nearM));
}
const check = (d: unknown): Verdict | null => { try { return TrackValidate.check(d); } catch (_) { return null; } };

// ── the remedies ─────────────────────────────────────────────────────────
/** START: the designer's startOnLongestStraight + START HERE's zone shift. Twice, as
 *  TrackRandom.generate does: the 4 m resample starts at control 0, so rotating
 *  re-phases it, and a second look settles the line where a second click would not
 *  move it again. fixes.js:154 */
function fixStart(d: FixDesign, pts: Pt[]): FixResult | null {
  let cur = pts, f = 0, rot = 0;
  for (let pass = 0; pass < 2; pass++) {
    const ls = TrackRandom.longestStraight(cur);
    if (!ls || !ls.dense || !ls.dense.length || !(ls.lenM > 0)) break;
    const along = Math.min(Math.max(ls.lenM * 0.6, 240), Math.max(ls.lenM - 140, 0));
    const p = ls.dense[(ls.start + Math.round(along / 4)) % ls.dense.length]!;
    const j = S.project(cur, p[0], p[1]).i;
    if (!(j > 0)) break;
    const c = cum(cur);
    f += c[j]! / c[cur.length]!;
    cur = S.rotate(cur, j);
    rot += j;
  }
  if (cur === pts || samePts(lattice(cur), lattice(pts))) return null;   // already there (or a full turn)
  const out = clone(d) as FixDesign & { pts: Pt[] };
  out.pts = lattice(cur);
  Object.assign(out, mapZones(out, (v) => v - f));
  // Heights are parallel to pts: rotate them with it (the designer's START HERE does).
  if (Array.isArray(out.heights) && out.heights.length === pts.length) { const k = rot % pts.length; out.heights = out.heights.slice(k).concat(out.heights.slice(0, k)); }
  return { design: out, msg: "Moved the start to the longest straight" };
}
/** Scale about the centroid by k; recentre and fit the map when that pushes a point past it. fixes.js:178 */
function scaled(pts: readonly Pt[], k: number): Pt[] {
  const c = S.centroid(pts);
  let out = pts.map((p): Pt => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);
  if (out.some((p) => Math.abs(p[0]) > MAP || Math.abs(p[1]) > MAP)) out = out.map((p): Pt => [p[0] - c[0], p[1] - c[1]]);
  return out;
}
/** LENGTH: scale the loop to 4 km (short) or 6.5 km (long) on the BUILT lap, one corrective build. fixes.js:185 */
function fixLength(d: FixDesign, pts: Pt[], built: BuiltLike | null): FixResult | null {
  const lim = LIM(), L = lapOf(d, pts, built);
  if (!(L > 0)) return null;
  const target = L < lim.lenAmber ? LAP.short : L > lim.lenMax ? LAP.long : 0;
  if (!target) return null;
  let next = scaled(pts, target / L);
  const tr = trOf(Object.assign({}, d, { pts: lattice(next) }), null);
  if (tr && Math.abs(target / tr.total - 1) > 0.005) next = scaled(next, target / tr.total);
  // Shrinking can pull two points under the spacing floor: merge them (zones follow the survivors).
  const aligned = lattice(next), out = S.enforceSpacing(aligned, SPACING);
  if (out.length < lim.ptsMin) return null;
  const pairs = out.length === aligned.length ? null : survivors(aligned, out);
  const res = rebuilt(d, pts, out, pairs);
  if (samePts(res.pts, pts)) return null;
  return { design: res, msg: "Scaled the lap to " + km(target) };
}
/** BOUNDS: centroid to the origin, then into ±9.5 km. fixes.js:202 */
function fixBounds(d: FixDesign, pts: Pt[]): FixResult | null {
  const max = (P: readonly Pt[]) => P.reduce((m, p) => Math.max(m, Math.abs(p[0]), Math.abs(p[1])), 0);
  if (max(pts) <= 10000) return null;                     // in range: the refusal is the point count or a malformed record
  const c = S.centroid(pts);
  let next = pts.map((p): Pt => [p[0] - c[0], p[1] - c[1]]);
  const m = max(next), fit = m > MAP;
  if (fit) next = next.map((p): Pt => [p[0] * MAP / m, p[1] * MAP / m]);
  return { design: rebuilt(d, pts, next, null), msg: fit ? "Centred the loop and scaled it to fit the map" : "Centred the loop on the map" };
}
/** SPACING / POINTS: merge points under 8 m, then RDP with a growing tolerance to ≤ 180. fixes.js:212 */
function fixSpacing(d: FixDesign, pts: Pt[]): FixResult | null {
  const lim = LIM(), base = S.enforceSpacing(pts, SPACING);
  let out = base;
  for (let eps = 0.5; out.length > PTS_CAP && eps < 1000; eps *= 1.6) out = S.rdp(base.concat([base[0]!]), eps).slice(0, -1);
  if (out.length < lim.ptsMin || out.length === pts.length) return null;
  const pairs = survivors(pts, out);
  if (!pairs) return null;
  const dropped = pts.length - out.length;
  return { design: rebuilt(d, pts, out, pairs), msg: base.length < pts.length && out.length === base.length ? "Merged " + dropped + " point" + (dropped === 1 ? "" : "s") + " closer than " + SPACING + " m" : "Thinned the loop to " + out.length + " points" };
}
/** KINK / RADIUS / FOLD: pull the three control points under the issue 30 % toward
 *  their neighbours' midpoint, ≤ 3 passes, until the engine's road there clears the
 *  rule. fixes.js:225 */
function fixSmooth(d: FixDesign, pts: Pt[], issue: FixIssue, built: BuiltLike | null): FixResult | null {
  if (!Number.isFinite(issue.s) || pts.length < 4) return null;
  const s = issue.s as number;
  const tr = trOf(d, built), N = pts.length;
  const c = nearestCtrl(pts, tr, s, false);
  if (c < 0) return null;
  const win = windowAt(c, N);
  let cur = pts.slice();
  for (let pass = 0; pass < PASSES; pass++) {
    const next = cur.slice();
    for (const i of win) {
      const a = cur[(i - 1 + N) % N]!, b = cur[i]!, e = cur[(i + 1) % N]!;
      next[i] = [q(b[0] + PULL * ((a[0] + e[0]) / 2 - b[0])), q(b[1] + PULL * ((a[1] + e[1]) / 2 - b[1]))];
    }
    cur = next;
    // f1-game's `typeof TrackValidate === "undefined"` Menger-only branch (fixes.js:239-241) is gone.
    if (!stillThere(check(Object.assign({}, d, { pts: lattice(cur) })), issue.code, issue.level, issue.s, 150)) break;
  }
  if (samePts(lattice(cur), pts)) return null;
  const out = S.enforceSpacing(cur, SPACING);
  const pairs = survivors(cur, out);
  if (!pairs || out.length < LIM().ptsMin) return null;
  return { design: rebuilt(d, pts, out, pairs), msg: "Smoothed the " + (issue.code === "kink" ? "kink" : "corner") + " at " + km(s) };
}
/** CROSSING: a bridge (sanitize's BUMP shape { s, halfM, rise }) over the road
 *  farther from the start line, when the other road clears its span. fixes.js:252 */
function fixCrossing(d: FixDesign, issue: FixIssue, built: BuiltLike | null): FixResult | null {
  if (!Number.isFinite(issue.s)) return null;
  const s = issue.s as number;
  const tr = trOf(d, built);
  const L = tr ? tr.total : 0;
  if (!(L > 0)) return null;
  let s2 = issue.s2 as number;
  if (!Number.isFinite(s2)) {
    const ds = L / tr!.n;
    let best: number | null = null, bd = Infinity;
    for (const x of S.crossings(tr!.px, tr!.pz, tr!.n, 3)) {
      const di = circ(x.i * ds, s, L), dj = circ(x.j * ds, s, L);
      if (di < bd) { bd = di; best = x.j * ds; }
      if (dj < bd) { bd = dj; best = x.i * ds; }
    }
    if (best == null || bd > 40) return null;
    s2 = best;
  }
  if (circ(s, s2, L) <= BRIDGE.halfM) return null;  // the span would lift both roads
  const bridges: unknown[] = Array.isArray(d.bridges) ? d.bridges : [];
  if (bridges.length >= zonesCap()) return null;
  for (const b of bridges as (Rec | null)[]) {
    if (!b || !Number.isFinite(b.s)) continue;
    const sb = wrap01(b.s as number) * L, h = +(b.halfM as number) || 0;
    if (circ(sb, s, L) < h || circ(sb, s2, L) < h) return null;   // already bridged here: not a second deck
  }
  // Lift the road farther from the line, so the grid stays flat.
  const up = circ(s2, 0, L) > circ(s, 0, L) ? s2 : s;
  const out = clone(d) as FixDesign & { pts: Pt[] };
  out.pts = lattice(out.pts);
  out.bridges = bridges.map((b) => Object.assign({}, b)).concat([{ s: wrap01(up / L), halfM: BRIDGE.halfM, rise: BRIDGE.rise }]);
  return { design: out, msg: "Added a bridge at " + km(up) };
}
/** The pit complex's reach past the road edge (validate.js's pitReach). fixes.js:285 */
function pitReach(d: FixDesign, built: BuiltLike | null): number {
  try {
    const def = ((built && built.def) || TrackValidate.previewDef(d)) as PitDefLike | null, off = def && TrackPit.resolve(def).off;
    return Math.max(0, ((off && off.workOut) || 0) - 0.9);
  } catch (_) { return 0; }
}
/** CLEARANCE: push the control points under s and s2 apart along the line joining
 *  the two roads, (limit − dist)/2 + 2 m each (their neighbours half that, so the
 *  road bends instead of spiking), ≤ 3 passes. fixes.js:295 */
function fixClearance(d: FixDesign, pts: Pt[], issue: FixIssue, built: BuiltLike | null): FixResult | null {
  if (!Number.isFinite(issue.s) || !Number.isFinite(issue.s2)) return null;
  const s = issue.s as number, s2 = issue.s2 as number;
  let tr: TrLike | null = trOf(d, built), cur = pts.slice(), moved = false;
  const N = pts.length, reach = pitReach(d, built);
  for (let pass = 0; pass < PASSES && tr; pass++) {
    const n = tr.n, ds = tr.total / n, at = (x: number) => ((Math.round(x / ds) % n) + n) % n;
    // Re-find the pair near the issue on this build (the arc shifts as points move).
    let ki = at(s), kj = at(s2);
    const best: { d: number; i?: number; j?: number } = { d: Infinity };
    for (let a = -12; a <= 12; a++) for (let b = -12; b <= 12; b++) {
      const i = (ki + a + n) % n, j = (kj + b + n) % n, dd = Math.hypot(tr.px[i]! - tr.px[j]!, tr.pz[i]! - tr.pz[j]!);
      if (dd < best.d) Object.assign(best, { d: dd, i, j });
    }
    ki = best.i!; kj = best.j!;
    const dist = best.d, need = tr.hw[ki]! + tr.hw[kj]!, limit = need + Math.max(10, reach + 1);
    if (pass > 0 && dist >= limit) break;
    // Two roads that CROSS here want a bridge, not a shove.
    if (dist < 1 || S.crossings(tr.px, tr.pz, n, 3).some((x) => circ(x.i, ki, n) < 20 && circ(x.j, kj, n) < 20 || circ(x.j, ki, n) < 20 && circ(x.i, kj, n) < 20)) return null;
    const move = (limit - dist) / 2 + 2;
    if (!(move > 0)) break;
    const ux = (tr.px[kj]! - tr.px[ki]!) / dist, uz = (tr.pz[kj]! - tr.pz[ki]!) / dist;
    const ci = nearestCtrl(cur, tr, ki * ds, true), cj = nearestCtrl(cur, tr, kj * ds, true);
    if (ci < 0 || cj < 0 || ci === cj) return null;
    const next = cur.slice(), touched = new Set([0]);
    const push = (i: number, sgn: number, m: number) => { if (touched.has(i)) return; touched.add(i); next[i] = [cur[i]![0] + sgn * ux * m, cur[i]![1] + sgn * uz * m]; };
    push(ci, -1, move); push(cj, +1, move);
    for (const [c0, sgn] of [[ci, -1], [cj, +1]] as const) { push((c0 - 1 + N) % N, sgn, move / 2); push((c0 + 1) % N, sgn, move / 2); }
    cur = next.map((p): Pt => [q(p[0]), q(p[1])]);
    moved = true;
    // f1-game's `if (typeof TrackValidate === "undefined") break;` (fixes.js:324) is gone.
    const v = check(Object.assign({}, d, { pts: cur }));
    if (!v || !stillThere(v, "clearance", issue.level, issue.s, 200)) break;
    tr = v.tr;
  }
  if (!moved || samePts(cur, pts)) return null;
  const out = S.enforceSpacing(cur, SPACING), pairs = survivors(cur, out);
  if (!pairs || out.length < LIM().ptsMin) return null;
  return { design: rebuilt(d, pts, out, pairs), msg: "Moved the two close sections apart" };
}

type Remedy = (d: FixDesign, pts: Pt[], it: FixIssue, b: BuiltLike | null) => FixResult | null;
const REMEDY: { [code: string]: Remedy } = {
  start: (d, pts) => fixStart(d, pts),
  length: (d, pts, it, b) => fixLength(d, pts, b),
  bounds: (d, pts) => fixBounds(d, pts),
  spacing: (d, pts) => fixSpacing(d, pts),
  points: (d, pts) => (pts.length > PTS_CAP ? fixSpacing(d, pts) : null),
  kink: (d, pts, it, b) => fixSmooth(d, pts, it, b),
  radius: (d, pts, it, b) => fixSmooth(d, pts, it, b),
  fold: (d, pts, it, b) => fixSmooth(d, pts, it, b),
  crossing: (d, pts, it, b) => fixCrossing(d, it, b),
  clearance: (d, pts, it, b) => fixClearance(d, pts, it, b),
};

/** Does this issue have a one-click remedy? (validate.js tags each one with `fix`.) fixes.js:349 */
export function canFix(issue: unknown): boolean {
  return !!(issue && typeof issue === "object" && (issue as FixIssue).fix && Object.prototype.hasOwnProperty.call(REMEDY, (issue as FixIssue).code as PropertyKey));
}
/** One remedy: { design, msg } (a NEW design) or null when there is none or it cannot
 *  apply. `built`: the TrackValidate.check verdict (or its tr) the issue came from;
 *  optional, the engine is rebuilt when absent. Never throws. fixes.js:355 */
export function apply(design: unknown, issue: unknown, built?: BuiltLike | null): FixResult | null {
  try {
    if (!design || typeof design !== "object" || !issue || typeof issue !== "object") return null;
    const it = issue as FixIssue;
    const fn = Object.prototype.hasOwnProperty.call(REMEDY, it.code as PropertyKey) ? REMEDY[it.code as string]! : null;
    const pts = fn && ptsOf(design);
    if (!pts) return null;
    const r = fn!(design as FixDesign, pts, it, built || null);
    return r && r.design && Array.isArray(r.design.pts) ? r : null;
  } catch (_) {
    // f1-game: warn("TrackFixes." + code + " failed: " + message) (Log.warn, dropped).
    return null;
  }
}
/** Every RED, in ORDER, ≤ 3 rounds; stops when none is left or a round changed
 *  nothing. `check` is TrackValidate.check. Ambers stay. Returns { design, applied:
 *  [codes, first-applied order], msgs, verdict }; the input design itself when
 *  nothing applied. fixes.js:372 */
export function fixAll<D>(design: D, check?: Judge | null): { design: D | FixDesign; applied: string[]; msgs: string[]; verdict: Verdict | null | undefined } {
  const judge: Judge = typeof check === "function" ? check : TrackValidate.check;
  const applied: string[] = [], msgs: string[] = [];
  let d: D | FixDesign = design, v: Verdict | null | undefined = null;
  try { v = judge ? judge(d) : null; } catch (_) { v = null; }
  for (let round = 0; round < ROUNDS && v && v.red > 0; round++) {
    let changed = false;
    for (const code of ORDER) {
      for (let t = 0; t < (REPEAT[code] || 1) && v && v.red > 0; t++) {
        const reds = (v.issues || []).filter((i) => i && i.level === "red" && i.code === code);
        let r: FixResult | null = null;
        for (const it of reds) { r = apply(d, it, v); if (r) break; }
        if (!r) break;
        d = r.design; msgs.push(r.msg); changed = true;
        if (!applied.includes(code)) applied.push(code);
        try { v = judge(d); } catch (_) { v = null; }
      }
      if (!v || !(v.red > 0)) break;
    }
    if (!changed) break;
  }
  return { design: d, applied, msgs, verdict: v };
}
