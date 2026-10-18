/**
 * TrackStamps: the designer's STRAIGHT / CORNER / HAIRPIN / CHICANE / S-BEND tools.
 * Ported verbatim from f1-game js/editor/stamps.js (TrackStamps IIFE, :1-199).
 *
 * A stamp is sampled exactly (arcs and straights from the anchor point's pose),
 * pre-compensated for the engine's two Laplacian passes at the step it is actually
 * sampled at, so the requested radius is the BUILT one (to ~2 % mid-arc for
 * R ≥ 30 m), then spliced into the loop: the stamp replaces the selected span and a
 * Dubins path (TrackShape.dubins, r ≥ the hairpin floor) rejoins its end to the first
 * reachable downstream point. The loop therefore stays closed by construction and
 * nothing solves closure globally. seedFromSegments() turns a straights-and-turns
 * list into a first loop through the engine's dormant integrator
 * (src/track/core/spline.ts centerline).
 *
 * Differs from f1-game:
 * - TrackSpline is an import, so seedFromSegments' `typeof TrackSpline` guard
 *   (stamps.js:190) takes the loaded branch and is gone.
 * - `!` non-null assertions and `as` casts are type-only; no runtime change.
 */
import * as S from "./shape";
import type { DubinsChord, Pose, Pt, PtsEnd, RPt } from "./shape";
import * as TrackSpline from "../track/core/spline";
import type { Segment } from "../track/core/spline";

const DEG = Math.PI / 180;
/** The hairpin floor the validator reds below (built radius). stamps.js:16 */
export const R_MIN = 15;
/** Control points never closer than this. stamps.js:17 */
export const SPACING = 8;
const CHORD_MAX = 25;       // …nor further apart on an arc than the 25 m straights beside it
// The Dubins rejoin: straights every ≤ 60 m, arcs on 8-25 m chords at the stamp's
// 10° grain where it leaves the stamp and ≤ 20° beyond (point budget).
const FILL_STEP = 60, FILL_CHORD: DubinsChord = [SPACING, CHORD_MAX, 20 * DEG];

/** The engine smooths control points twice with L = 0.25 (TrackDef.realPoints): on a
 *  sampled arc each pass scales the radius by 1 − L(1 − cos(h/R)), so sample at R'
 *  to land near R after both. Ends still soften; WYSIWYG shows it. stamps.js:26 */
export function compensate(R: number, h: number): number {
  const f = 1 - 0.25 * (1 - Math.cos(h / R));
  return R / (f * f);
}
/** An arc of R and sweep A: n steps of ≈ 10° with chords SPACING..CHORD_MAX m (the
 *  spacing rule wins on tight arcs; the cap keeps uniform Catmull-Rom from
 *  overshooting wide ones), sampled at Rc = R / f(φ)² for the step φ = A/n it is
 *  ACTUALLY sampled at. n depends on Rc, so iterate to the fixed point, then make
 *  sure Rc's chords still clear the spacing rule (fewer steps only grow Rc). stamps.js:36 */
export function arcFor(R: number, A: number): { Rc: number; n: number } {
  const comp = (n: number) => compensate(R, R * A / n);   // compensate() reads φ as h / R
  const cMin = SPACING + 0.5;   // half a metre over the rule: the 0.25 m save lattice moves each end (as spiralArc)
  let Rc = R, n = 1;
  for (let it = 0; it < 6; it++) { n = S.arcSteps(Rc, A, cMin, CHORD_MAX); Rc = comp(n); }
  while (n > 1 && 2 * Rc * Math.sin(A / (2 * n)) < cMin) Rc = comp(--n);
  return { Rc, n };
}

// ── clothoid entry / exit (an Euler spiral each side of the arc) ──────────
// SPIRAL m on a curved stamp: the curvature ramps 0 → 1/Rc over Ls' m, holds on the
// arc, and ramps back down (https://en.wikipedia.org/wiki/Euler_spiral). Each spiral
// turns Ls'/(2Rc), so the arc keeps A − Ls'/Rc and the stamp's total heading change
// stays exactly A. Ls' is whole chords of the arc's own step (≈ 10°, 8.5-25 m); under
// two chords there is no spiral, and Ls' is capped so two chords of true arc stay at
// the apex (stamps.js:45-56).
/** stamps.js:57 */
export const LS_MAX = 80;
/** One spiral of a stamped arc (R requested, A radians, Ls m): { Rc, n, Ls, sweep, arc }
 *  (Ls the length each spiral runs (0: the plain arc), sweep the heading each turns,
 *  arc the sweep left on Rc; n: arcFor's steps for the plain arc). stamps.js:61 */
export function spiralSweep(R: number, Ls: number, A: number): { Rc: number; n: number; Ls: number; sweep: number; arc: number } {
  A = A > 0 ? A : Math.PI / 2;
  const { Rc, n } = arcFor(R, A), len = Rc * A, cMin = SPACING + 0.5;
  const h = Math.min(CHORD_MAX, Math.max(cMin, 10 * DEG * Rc));
  const m = Math.min(Math.round(Math.min(LS_MAX, Math.max(0, +Ls || 0)) / h), Math.floor(len / h) - 2);
  const L = m >= 2 ? m * h : 0;
  return { Rc, n, Ls: L, sweep: L / (2 * Rc), arc: Math.max(0, A - L / Rc) };
}
/** Spiral in → arc → mirrored spiral out from the pose cur() returns; each piece's end is a tangent point. stamps.js:70 */
function spiralArc(cur: () => Pose, R: number, A: number, dir: number, Ls: number, push: (r: PtsEnd) => void): void {
  const sp = spiralSweep(R, Ls, A), k = 1 / sp.Rc, STEP = 10 * DEG;
  if (!(sp.Ls > 0)) { push(S.arcPts(cur(), sp.Rc, dir * A, 0, sp.n)); return; }   // too short to ease: the plain arc
  // Chords keep half a metre over the spacing rule: the 0.25 m save lattice moves each end.
  const cMin = SPACING + 0.5;
  push(S.clothoidPts(cur(), 0, k, sp.Ls, dir, cMin, CHORD_MAX, STEP));
  if (sp.arc * sp.Rc > 1e-6) push(S.arcPts(cur(), sp.Rc, dir * sp.arc, 0, S.arcSteps(sp.Rc, sp.arc, cMin, CHORD_MAX)));
  push(S.clothoidPts(cur(), k, 0, sp.Ls, dir, cMin, CHORD_MAX, STEP));
}

/** A stamp's parameters (each kind uses its own subset; `dir` ±1, + = left). */
export interface StampParams { L?: number; R?: number; deg?: number; dir?: number; Ls?: number }
/** One stamp kind: its label, defaults and clamps. */
export interface StampKind { label: string; params: StampParams; min: StampParams; max: StampParams }
export type StampKindName = "straight" | "corner" | "hairpin" | "chicane" | "sbend";

/** stamps.js:80 */
export const KINDS: { [K in StampKindName]: StampKind } = {
  straight: { label: "STRAIGHT", params: { L: 300 }, min: { L: 30 }, max: { L: 1500 } },
  corner:   { label: "CORNER",   params: { R: 60, deg: 90, dir: 1, Ls: 0 }, min: { R: R_MIN, deg: 10, Ls: 0 }, max: { R: 600, deg: 270, Ls: LS_MAX } },
  hairpin:  { label: "HAIRPIN",  params: { R: 18, dir: 1, Ls: 0 }, min: { R: R_MIN, Ls: 0 }, max: { R: 25, Ls: LS_MAX } },
  chicane:  { label: "CHICANE",  params: { R: 20, deg: 35, dir: 1, Ls: 0 }, min: { R: R_MIN, deg: 15, Ls: 0 }, max: { R: 60, deg: 60, Ls: LS_MAX } },
  sbend:    { label: "S-BEND",   params: { R: 45, deg: 45, dir: 1, Ls: 0 }, min: { R: R_MIN, deg: 15, Ls: 0 }, max: { R: 300, deg: 120, Ls: LS_MAX } },
};
/** The kind's defaults overlaid with `p`, each clamped to the kind's range (dir to ±1);
 *  null for an unknown kind. stamps.js:87 */
export function clampParams(kind: string, p?: object | null): StampParams | null {
  const k = (KINDS as { [kind: string]: StampKind | undefined })[kind]; if (!k) return null;
  const out = Object.assign({}, k.params, p || {}) as { [key: string]: unknown };
  const min = k.min as { [key: string]: number }, max = k.max as { [key: string]: number }, def = k.params as { [key: string]: number };
  for (const key of Object.keys(k.params)) {
    if (key === "dir") { out.dir = (out.dir as number) < 0 ? -1 : 1; continue; }
    const v = +(out[key] as number);
    out[key] = Number.isFinite(v) ? Math.min(max[key]!, Math.max(min[key]!, v)) : def[key];
  }
  return out as StampParams;
}

/** sample()'s result: points (start excluded), end pose, the tangent points between
 *  its pieces (by reference) and the clamped params. */
export interface StampSample { pts: Pt[]; end: Pose; ends: Set<Pt>; params: StampParams }
/** Sample a stamp from `pose` ({x, z, th}); returns { pts, end, ends } (start
 *  excluded; `ends` holds the tangent points between its pieces, by reference). stamps.js:100 */
export function sample(kind: string, params: object | null | undefined, pose: Pose): StampSample | null {
  const p = clampParams(kind, params); if (!p) return null;
  const pts: Pt[] = [], ends = new Set<Pt>(); let cur = pose;
  const push = (r: PtsEnd) => { pts.push(...r.pts); ends.add(r.pts[r.pts.length - 1]!); cur = r.end; };
  const arc = (R: number, deg: number, dir: number) => {
    if ((p.Ls as number) > 0) return spiralArc(() => cur, R, deg * DEG, dir, p.Ls!, push);
    const a = arcFor(R, deg * DEG); push(S.arcPts(cur, a.Rc, dir * deg * DEG, 0, a.n));
  };
  const run = (L: number) => push(S.straightPts(cur, L, 25));
  switch (kind) {
    case "straight": run(p.L!); break;
    case "corner": arc(p.R!, p.deg!, p.dir!); break;
    case "hairpin": run(40); arc(p.R!, 180, p.dir!); break;
    case "chicane": arc(p.R!, p.deg!, p.dir!); run(20); arc(p.R!, 2 * p.deg!, -p.dir!); run(20); arc(p.R!, p.deg!, p.dir!); break;
    case "sbend": arc(p.R!, p.deg!, p.dir!); arc(p.R!, p.deg!, -p.dir!); break;
    default: return null;
  }
  return { pts, end: cur, ends, params: p };
}

/** splice()'s result. */
export type SpliceResult = { ok: true; pts: Pt[]; sel: [number, number]; word: string } | { ok: false; reason: string };
/** Replace the control span (i0, i1) exclusive with a stamp anchored at i0, rejoining
 *  downstream. i0 === i1 inserts after i0. Returns { ok, pts, sel: [from, to] } or
 *  { ok: false, reason }. Index 0 (the start line) is kept at index 0 unless the span
 *  covers it. stamps.js:124 */
export function splice(pts: readonly Pt[], i0: number, i1: number, kind: string, params?: object | null): SpliceResult {
  const N = pts.length;
  i0 = S.wrapI(i0, N); i1 = S.wrapI(i1, N);
  const anchor = pts[i0]!;
  const st = sample(kind, params, { x: anchor[0], z: anchor[1], th: S.heading(pts, i0) });
  if (!st || !st.pts.length) return { ok: false, reason: "unknown stamp" };
  // Downstream candidates: the span end itself, then further points.
  const covered = (j: number) => S.wrapI(j - i0, N);   // how many points from i0 to j
  // An INSERT (i0 === i1) adds road the loop must absorb, so it may reach further
  // downstream for its rejoin than a replacement does.
  const insert = i0 === i1, reach = insert ? 12 : 7;
  for (let k = 0; k < reach; k++) {
    const j = S.wrapI(i1 + (insert ? 1 : 0) + k, N);
    if (j === i0 || covered(j) > N - 4) break;   // never eat the whole loop
    const B = pts[j]!, goal = { x: B[0], z: B[1], th: S.heading(pts, j) };
    const E = st.end, straight = Math.hypot(B[0] - E.x, B[1] - E.z);
    let fill: ReturnType<typeof S.dubins> = null;
    // Gentlest rejoin first: a 15 m fill behind a 60 m corner would be the tightest
    // bend on the lap, which is not what the stamp asked for.
    for (const r of [70, 45, 30, 20, R_MIN]) {
      const d = S.dubins(E, goal, r, FILL_STEP, FILL_CHORD);
      // A fill that doubles back on itself (a full loop to turn around) is the sign
      // the goal is behind the stamp: skip to the next candidate.
      if (d && d.len <= 3 * straight + 2 * Math.PI * r + 60) { fill = d; break; }
    }
    if (!fill) continue;
    // Assemble: everything up to and including i0, the stamp, the fill (minus its
    // last point, which IS pts[j]), then pts[j..] round to i0.
    const fillPts = fill.pts.slice(0, -1);
    let out: Pt[];
    if (j > i0 || j === 0) {
      // simple order: [0..i0] + stamp + fill + [j..N-1] (j === 0 → nothing after; the loop closes onto index 0)
      out = pts.slice(0, i0 + 1).concat(st.pts, fillPts, j === 0 ? [] : pts.slice(j));
    } else {
      // the span wraps past the start line: [j..i0] survives, index 0 moves to j
      out = pts.slice(j, i0 + 1).concat(st.pts, fillPts);
    }
    // Spacing: arc chords are ≥ 8 m by construction, but a fill point may crowd the
    // stamp's end. The tangent points between its pieces are protected: dropping one
    // turns the arc's last step into a kink off the circle.
    const protect = new Set<number>();
    for (let m = 0; m < out.length; m++) if (st.ends.has(out[m]!)) protect.add(m);
    out = S.enforceSpacing(out, SPACING, protect);
    // The stamp's surviving points, by reference (spacing may have merged a few).
    const mine = new Set(st.pts);
    let selA = -1, selB = -1;
    for (let m = 0; m < out.length; m++) if (mine.has(out[m]!)) { if (selA < 0) selA = m; selB = m; }
    if (out.length > 200) {
      // thin the untouched remainder first (RDP at 1 m) on both sides, never the
      // stamp, its fill or the GUARD points next to them (a thinned 100 m chord beside
      // an 8 m one makes the uniform spline overshoot the junction)
      const GUARD = 2, a = Math.max(0, selA - GUARD), b = Math.min(out.length, selB + fillPts.length + 1 + GUARD);
      const pre = S.rdp(out.slice(0, a), 1), tail = S.rdp(out.slice(b), 1);
      out = pre.concat(out.slice(a, b), tail);
      selB -= a - pre.length; selA -= a - pre.length;
      if (out.length > 200) return { ok: false, reason: "too many points — delete some first" };
    }
    return { ok: true, pts: out, sel: [selA, selB], word: fill.word };
  }
  return { ok: false, reason: "no room to rejoin the loop here — pick a longer span or a smaller stamp" };
}

/** A first loop from a straights-and-turns list through the engine's dormant
 *  integrator: seg = { t: turnDeg (+left), l: metres, w?: halfWidth }. The integrator
 *  scales lengths by 1.45 (arcade), so lengths are pre-divided. stamps.js:189 */
export function seedFromSegments(segs: readonly Segment[], baseHW?: number | null): Pt[] {
  const scaled = segs.map((s) => Object.assign({}, s, { l: (s.l || 0) / 1.45 }));
  const raw = TrackSpline.centerline(scaled, baseHW || 7);
  const pts: RPt[] = raw.map((p) => [p[0], p[2]]);
  return S.resample(pts, 25, true);
}
