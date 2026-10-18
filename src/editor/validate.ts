/**
 * TrackValidate: WYSIWYG validation for the track designer. Ported verbatim from
 * f1-game js/editor/validate.js (TrackValidate, :1-267).
 *
 * A design is judged on the road the ENGINE would build from it (custom-tracks.ts
 * toRaw → def.ts fromRaw → tracks.ts buildCenterline), never on the editor's own
 * approximation, so what the player sees RED is what the car would meet. Rules
 * mirror the engine's floors: TrackPit's entry/exit straights, the tarmac-fold test
 * (R ≤ hw), the grade caps, and the hairpin floor the stamps are built to. RED
 * blocks SAVE / RACE / SHARE; AMBER is advice.
 *
 * Differs from f1-game:
 * - `TrackMaps` (f1-game js/ui/track-maps.js) is an injected dependency
 *   (`setTrackMaps`), absent by default. f1-game's headless VM (and so the goldens)
 *   does not load it, which is the default here.
 * - TrackPit, Tracks and TrackInsight are imports, so their `typeof X !==
 *   "undefined"` guards are always true and are gone; the try/catch around each
 *   call stays. The `Log.warn` in judge's insight catch is dropped.
 */
import * as CustomTracks from "./custom-tracks";
import * as TrackInsight from "./insight";
import * as S from "./shape";
import type { RPt } from "./shape";
import { fromRaw, type BuiltDef, type RawDef } from "../track/core/def";
import * as TrackPit from "../track/core/pit";
import type { PitDefLike } from "../track/core/pit";
import * as Tracks from "../track/core/tracks";
import type { Track } from "../track/core/types";

// ── TrackMaps (injected) ────────────────────────────────────────────────
/** The part of f1-game's TrackMaps (js/ui/track-maps.js) the editor core reads. */
export interface TrackMapsImpl {
  /** Curated-style corners over a built centreline; `f` is the apex lap fraction. */
  detectCorners?: (tr: Track) => readonly { f: number }[];
  /** FAST / MEDIUM / SLOW (or the impl's own classes) from radius and |angle| in degrees. */
  classifyCorner?: (R: number, angDeg: number) => string;
}
// TODO(lane-editor): port js/ui/track-maps.js detectCorners/classifyCorner and inject them.
let trackMaps: TrackMapsImpl | null = null;
/** Inject (or clear, with null) TrackMaps. Absent by default: the goldens' "TrackMaps not loaded" branch. */
export function setTrackMaps(impl: TrackMapsImpl | null): void { trackMaps = impl; }
/** The injected TrackMaps, or null (insight.ts reads it too). */
export function getTrackMaps(): TrackMapsImpl | null { return trackMaps; }

/** validate.js:13 */
export const LIMITS = Object.freeze({
  lenMin: 2500, lenMax: 7000, lenAmber: 3500,
  // Shipped hairpins build down to 10 m (Monaco, Korea), so RED sits at 9 m with the
  // hairpin floor as advice; real gradients reach 15-22 % over the 40 m grade window
  // (Spa reads 22.1 %), so grade is advice above 8 % and RED only for a wall.
  rMin: 9, rAmber: 15, kinkMin: 7,                      // Korea's hairpin measures 8 m on a 24 m chord; a control-point kink reads 2-5
  gradeRed: 0.15, gradeAmber: 0.08, gradeWindowM: 40,
  // The start straight against the pit model (src/track/core/pit.ts). BEHIND the
  // line: RED under ENTRY_MIN; under gridM AMBER. AHEAD: RED under EXIT_MIN +
  // ROAD_MIN, and RED whenever TrackPit's own window leaves no room for the garages.
  startBackRed: 150, startBackAmber: 240, gridM: 198,     // ENTRY_MIN; ENTRY_MIN + ENTRY_ROAD + MOUTH_RUN; 14 + 23·8
  startFwdRed: 70, startFwdAmber: 240,                    // EXIT_MIN + ROAD_MIN; EXIT_M + EXIT_ROAD + MERGE_RUN
  bridgeSep: 7,                                           // overheadSpan's 4.8 m clearance + deck
  foldFrac: 0.67, foldAmberFrac: 0.8,                     // node-scale radius / half-width (see the fold rule)
  ptsMin: 8, ptsMax: 200, ptsAmber: 180, spacing: 8, hwMin: 5, hwMax: 8,
});
// The clearance scan's grid cell: a 3×3 neighbourhood sees every pair closer than
// one cell, and the AMBER threshold reaches hw_i + hw_j + 10 m.
const CLEAR_CELL = Math.max(24, 2 * LIMITS.hwMax + 10);
const MAX_CROSSINGS = 64, MAP_HALF = 10000;   // MAP_HALF: CustomTracks.LIMITS.coord

export type Level = "red" | "amber" | "info";
/** One validator / insight finding. */
export interface Issue {
  code: string; level: Level; msg: string;
  fix?: string; s?: number; s2?: number; k?: number; ctrl?: number; x?: number; z?: number;
}
type IssueExtra = Omit<Issue, "code" | "level" | "msg">;
/** The verdict's numbers. */
export interface Stats {
  lengthM: number; turns: number; minR: number; estLapS: number; startBackM: number; startFwdM: number;
  pitEntryM: number; pitExitM: number; elevM: number; gradeMax: number; crossings: number; passZones: number;
}
/** check()'s verdict. */
export interface Verdict {
  ok: boolean; red: number; amber: number; issues: Issue[]; stats: Stats;
  def: BuiltDef | null; tr: Track | null; turns: number[];
}
/** A design as check() / judge() read it (unsanitised: anything a caller hands in). */
export interface DesignInput { pts?: unknown; baseHW?: unknown; bridges?: unknown; [k: string]: unknown }

/** The built-def for a design under its CONTENT id (sanitize's it.id; the id seeds
 *  the elevation ripple). Never registered on LIST. validate.js:45 */
export function previewDef(design: unknown): BuiltDef | null {
  // { loose: true }: a work in progress still builds, so the length / spacing rules
  // below can say what is wrong with it.
  const it = CustomTracks.sanitize(design, { loose: true });
  if (!it) return null;
  // The cast as custom-tracks.ts buildDef: fromRaw tolerates CustomRawDef's nulls.
  return fromRaw(CustomTracks.toRaw(it) as unknown as RawDef);
}
/** The engine's centreline for a design, without the racing-line bake. validate.js:55 */
export function build(design: unknown): { def: BuiltDef; tr: Track | null; error?: string } | null {
  const def = previewDef(design);
  if (!def) return null;
  try { return { def, tr: Tracks.buildCenterline(def, { line: false }) }; } catch (e) { return { def, tr: null, error: String(e && (e as Error).message || e) }; }
}

/** True when the def wants garages (TrackPit.resolve) but the pit model built over
 *  this centreline has no room for the row. False when the model throws. validate.js:64 */
export function noBays(tr: Track, def: PitDefLike): boolean {
  try {
    if (!TrackPit.resolve(def).hasBays) return false;
    const pit = TrackPit.build(tr, def, Tracks.curvature);
    return !!pit && !pit.hasBays;
  } catch (_) { return false; }
}
/** How far the road stays straight from arc s0 in direction dir (±1), up to max. validate.js:73 */
export function straightRun(tr: Track, s0: number, dir: number, max: number): number {
  const K = TrackPit.PIT_K || 0.0035, STEP = 8, L = tr.total;
  let d = 0;
  for (; d < max; d += STEP) if (Math.abs(Tracks.curvature(tr, (((s0 + dir * (d + STEP / 2)) % L) + L) % L)) > K) break;
  return d;
}
/** Curated-style apex fractions from the built curvature (TrackMaps.detectCorners), ≥ 3. validate.js:80 */
export function bakeTurns(tr: Track): number[] {
  let turns: number[] = [];
  try { if (trackMaps && trackMaps.detectCorners) turns = trackMaps.detectCorners(tr).map((c) => c.f).filter(Number.isFinite); } catch (_) { turns = []; }
  if (turns.length < 3) {
    const n = tr.n, curv = tr.curv!, peaks: { k: number; v: number }[] = [];
    for (let k = 0; k < n; k++) { const v = Math.abs(curv[k]!); if (v >= Math.abs(curv[(k - 1 + n) % n]!) && v > Math.abs(curv[(k + 1) % n]!) && v > 0.002) peaks.push({ k, v }); }
    peaks.sort((a, b) => b.v - a.v);
    turns = peaks.slice(0, Math.max(3, Math.min(peaks.length, 3))).map((p) => p.k / n);
  }
  return turns.map((f) => ((f % 1) + 1) % 1).sort((a, b) => a - b);
}
/** The point-mass speed (m/s) at every node: corner speed √(32/|k|) capped at 92 m/s,
 *  then 11 m/s² accel forward and 38 m/s² brake backward, twice round. validate.js:94 */
export function speedProfile(tr: Pick<Track, "n" | "total" | "curv">): Float64Array {
  const n = tr.n, ds = tr.total / n, v = new Float64Array(n), curv = tr.curv!;
  for (let k = 0; k < n; k++) { const c = Math.abs(curv[k]!); v[k] = c > 1e-6 ? Math.min(92, Math.sqrt(32 / c)) : 92; }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 2 * n; i++) { const k = i % n, j = (k + 1) % n; v[j] = Math.min(v[j]!, Math.sqrt(v[k]! * v[k]! + 2 * 11 * ds)); }
    for (let i = 2 * n; i > 0; i--) { const k = i % n, j = (k - 1 + n) % n; v[j] = Math.min(v[j]!, Math.sqrt(v[k]! * v[k]! + 2 * 38 * ds)); }
  }
  return v;
}
const lapOf = (tr: Pick<Track, "n" | "total">, v: ArrayLike<number>) => { const n = tr.n, ds = tr.total / n; let t = 0; for (let k = 0; k < n; k++) t += ds / Math.max(8, v[k]!); return t; };
/** Point-mass lap estimate (s) over speedProfile. validate.js:105 */
export function estLap(tr: Track): number { return lapOf(tr, speedProfile(tr)); }

/** The verdict: { ok, red, amber, issues, stats, def, tr, turns }. validate.js:108 */
export function check(designIn: unknown): Verdict {
  let design = designIn as DesignInput;
  if (!design || typeof design !== "object") design = {};
  const issues: Issue[] = [];
  const add = (code: string, level: Level, msg: string, extra?: IssueExtra) => issues.push(Object.assign({ code, level, msg }, extra || {}));
  // Coordinates may be anything a caller hands in; the arithmetic coerces as f1-game's does.
  const pts = (design && Array.isArray(design.pts) ? design.pts : []) as readonly RPt[];
  if (pts.length < LIMITS.ptsMin) add("points", "red", "Needs at least " + LIMITS.ptsMin + " points — keep drawing");
  // A loop thousands of km long would build ~500 k nodes: judge the control polygon
  // first and say so without building. Past 2× the lap cap the built lap is red on
  // length whatever the smoothing does.
  const onMap = (p: unknown) => Array.isArray(p) && Math.abs(+p[0]) <= MAP_HALF && Math.abs(+p[1]) <= MAP_HALF;   // off the map is the `bounds` refusal below, which builds nothing
  const poly = pts.length >= LIMITS.ptsMin && pts.every(onMap) ? S.polyLen(pts.map((p) => [+p[0]!, +p[1]!]), true) : 0;
  if (poly > 2 * LIMITS.lenMax) {
    add("length", "red", "Lap is " + (poly / 1000).toFixed(1) + " km — at most 7 km", { fix: "length" });
    const stats = Object.assign(emptyStats(), { lengthM: Math.round(poly) });
    return { ok: false, red: issues.length, amber: 0, issues, stats, def: null, tr: null, turns: [] };
  }
  if (pts.length > LIMITS.ptsMax) add("points", "red", "Too many points (" + pts.length + "/" + LIMITS.ptsMax + ") — delete some", { fix: "points" });
  else if (pts.length > LIMITS.ptsAmber) add("points", "amber", pts.length + " points — near the " + LIMITS.ptsMax + " cap", { fix: "points" });
  for (let i = 0; i < pts.length && pts.length >= 2; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    if (Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!) < LIMITS.spacing) { add("spacing", "red", "Two points closer than " + LIMITS.spacing + " m at point " + (i + 1), { ctrl: i, fix: "spacing" }); break; }
  }
  const hw = +(design.baseHW as number);
  if (!(hw >= LIMITS.hwMin && hw <= LIMITS.hwMax)) add("width", "red", "Track half-width must be " + LIMITS.hwMin + "–" + LIMITS.hwMax + " m");
  const built = pts.length >= LIMITS.ptsMin ? build(design) : null;
  // The registry refused it even as a work in progress (a point off the ±10 km map,
  // a malformed point): nothing can be built, saved or raced.
  // (More than ptsMax points is refused too, but "Too many points" above already says so.)
  if (pts.length >= LIMITS.ptsMin && pts.length <= LIMITS.ptsMax && !built) add("bounds", "red", "This loop cannot be built — keep every point inside the ±10 km map", { fix: "bounds" });
  if (built && built.error) add("build", "red", "The engine could not build this loop: " + built.error);
  const tr = built && built.tr;
  const j = tr ? judge(tr, design, built!.def) : { issues: [], stats: emptyStats(), turns: [] };
  issues.push(...j.issues);
  const red = issues.filter((i) => i.level === "red").length, amber = issues.filter((i) => i.level === "amber").length;
  return { ok: red === 0 && !!tr, red, amber, issues, stats: j.stats, def: built && built.def, tr, turns: j.turns };
}
const emptyStats = (): Stats => ({ lengthM: 0, turns: 0, minR: Infinity, estLapS: 0, startBackM: 0, startFwdM: 0, pitEntryM: 0, pitExitM: 0, elevM: 0, gradeMax: 0, crossings: 0, passZones: 0 });

/** The road rules over a BUILT centreline (any track, a shipped circuit too).
 *  `design.bridges` is the only authored input read; `def` (default: the design
 *  itself, as for a shipped def) gives TrackPit its pit choices. validate.js:152 */
export function judge(tr: Track, designIn?: DesignInput | null, defIn?: PitDefLike | null): { issues: Issue[]; stats: Stats; turns: number[] } {
  const design: DesignInput = designIn || {};
  const def: PitDefLike = defIn || design as PitDefLike;
  const issues: Issue[] = [];
  const add = (code: string, level: Level, msg: string, extra?: IssueExtra) => issues.push(Object.assign({ code, level, msg }, extra || {}));
  const stats = emptyStats();
  let turns: number[] = [];
  {
    const n = tr.n, ds = tr.total / n, px = tr.px, pz = tr.pz, py = tr.py, curv = tr.curv!, hwA = tr.hw;
    stats.lengthM = Math.round(tr.total);
    if (tr.total < LIMITS.lenMin) add("length", "red", "Lap is " + (tr.total / 1000).toFixed(2) + " km — at least 2.5 km", { fix: "length" });
    else if (tr.total > LIMITS.lenMax) add("length", "red", "Lap is " + (tr.total / 1000).toFixed(2) + " km — at most 7 km", { fix: "length" });
    else if (tr.total < LIMITS.lenAmber) add("length", "amber", "Lap is " + (tr.total / 1000).toFixed(2) + " km — F1 circuits run 3.5 km or more", { fix: "length" });
    // Radius from the engine's own LUT, plus a node-chord Menger pass for the tarmac
    // fold (a racing-surface rail running backwards at a NODE-scale kink the ±12 m
    // curvature window averages away). Measured on the fleet: radius / half-width
    // ≤ 0.64 on the four circuits verify-track knows fold, ≥ 0.70 on every other.
    let kMax = 0, kAt = 0, fold: { k: number; R: number; hw: number } | null = null, foldAmber: { k: number; R: number } | null = null;
    const P = (i: number): [number, number] => [px[(i + n) % n]!, pz[(i + n) % n]!];
    for (let k = 0; k < n; k++) {
      const c = Math.abs(curv[k]!);
      if (c > kMax) { kMax = c; kAt = k; }
      const R1 = S.menger(P(k - 1), P(k), P(k + 1));
      if (R1 <= hwA[k]! * LIMITS.foldFrac) { if (!fold || R1 / hwA[k]! < fold.R / fold.hw) fold = { k, R: R1, hw: hwA[k]! }; }
      else if (R1 < hwA[k]! * LIMITS.foldAmberFrac && !foldAmber) foldAmber = { k, R: R1 };
    }
    stats.minR = kMax > 1e-6 ? Math.round(1 / kMax) : Infinity;
    if (stats.minR < LIMITS.rMin) add("radius", "red", "Corner too tight: " + stats.minR + " m radius (minimum " + LIMITS.rMin + " m)", { s: kAt * ds, k: kAt, fix: "radius" });
    else if (stats.minR < LIMITS.rAmber) add("radius", "amber", "Very tight corner: " + stats.minR + " m radius (hairpins are " + LIMITS.rAmber + " m+)", { s: kAt * ds, k: kAt, fix: "radius" });
    // A kink between nodes the ±12 m curvature window averages away: Menger over a 24 m chord.
    let kinkR = Infinity, kinkAt = 0;
    for (let k = 0; k < n; k++) { const R = S.menger([px[(k - 3 + n) % n]!, pz[(k - 3 + n) % n]!], [px[k]!, pz[k]!], [px[(k + 3) % n]!, pz[(k + 3) % n]!]); if (R < kinkR) { kinkR = R; kinkAt = k; } }
    if (kinkR < LIMITS.kinkMin && stats.minR >= LIMITS.rMin) add("kink", "red", "Kink in the road (" + Math.round(kinkR) + " m) — smooth the points here", { s: kinkAt * ds, k: kinkAt, fix: "kink" });
    if (fold) add("fold", "red", "Corner tighter than the road is wide — the tarmac folds here", { s: fold.k * ds, k: fold.k, fix: "fold" });
    else if (foldAmber) add("fold", "amber", "Corner nearly as tight as the road is wide", { s: foldAmber.k * ds, k: foldAmber.k, fix: "fold" });
    // Crossings: covered by a bridge (built height difference) or at grade.
    const bridges = (Array.isArray(design.bridges) ? design.bridges : []) as readonly { s: number; halfM: number }[];
    // Capped: a tangle of a thousand crossings is one message, not a thousand rows.
    const xs = S.crossings(px, pz, n, 3).slice(0, MAX_CROSSINGS);
    for (const c of xs) {
      stats.crossings++;
      const sep = Math.abs(py[c.i]! - py[c.j]!);
      if (sep >= LIMITS.bridgeSep) add("bridge", "info", "Crossing bridged (" + sep.toFixed(1) + " m clearance)", { s: c.i * ds, s2: c.j * ds, x: c.x, z: c.z });
      else add("crossing", "red", "The road crosses itself at grade — add a bridge", { s: c.i * ds, s2: c.j * ds, x: c.x, z: c.z, fix: "bridge" });
    }
    // Both roads of a bridge must not rise together.
    for (const b of bridges) for (const c of xs) {
      const sb = ((b.s % 1) + 1) % 1 * tr.total;
      const near = (s: number) => { let d = Math.abs(s - sb); d = Math.min(d, tr.total - d); return d < b.halfM; };
      if (near(c.i * ds) && near(c.j * ds)) { add("bridge", "red", "Both roads rise under this bridge — shorten it or move it", { s: sb }); break; }
    }
    // Clearance between non-adjacent spans at the same level.
    const Dnodes = Math.ceil(3 * (2 * tr.hw[0]! + 10) / ds);
    // A custom design's pit complex reaches workOut past the road edge. Shipped defs
    // have no design.pts, so the fleet oracle does not take this gate.
    let pitReach = 0;
    if (Array.isArray(design.pts)) {
      try {
        const off = TrackPit.resolve(def).off;
        pitReach = Math.max(0, ((off && off.workOut) || 0) - 0.9);
      } catch (_) { pitReach = 0; }
    }
    // The cell must out-reach the widest threshold below (both half-widths + the pit
    // opening, or 10 m).
    const cell = Math.max(CLEAR_CELL, 2 * LIMITS.hwMax + Math.max(10, pitReach) + 2);
    for (const w of S.clearance(px, pz, py, n, Dnodes, LIMITS.bridgeSep, cell, 6)) {
      const need = hwA[w.i]! + hwA[w.j]!;
      if (w.dist < need + 2) { add("clearance", "red", "Two parts of the track overlap (" + Math.round(w.dist) + " m apart)", { s: w.i * ds, s2: w.j * ds, fix: "clearance" }); break; }
      if (pitReach > 2 && w.dist < need + pitReach) { add("clearance", "red", "The pit opening crosses the other part of the track", { s: w.i * ds, s2: w.j * ds, fix: "clearance" }); break; }
      if (w.dist < need + 10) { add("clearance", "amber", "Two parts of the track run very close (" + Math.round(w.dist) + " m)", { s: w.i * ds, s2: w.j * ds, fix: "clearance" }); break; }
    }
    // Grade over a gradeWindowM (40 m) window; elevation range for the stats.
    let lo = Infinity, hi = -Infinity, gMax = 0, gAt = 0;
    const W = Math.max(1, Math.round(LIMITS.gradeWindowM / ds));
    for (let k = 0; k < n; k++) { if (py[k]! < lo) lo = py[k]!; if (py[k]! > hi) hi = py[k]!; const g = Math.abs(py[(k + W) % n]! - py[k]!) / (W * ds); if (g > gMax) { gMax = g; gAt = k; } }
    stats.elevM = Math.round(hi - lo); stats.gradeMax = +(gMax * 100).toFixed(1);
    if (gMax > LIMITS.gradeRed) add("grade", "red", "Slope of " + stats.gradeMax + " % — that is a wall, not a hill", { s: gAt * ds, k: gAt });
    else if (gMax > LIMITS.gradeAmber) add("grade", "amber", "Steep: " + stats.gradeMax + " % slope (F1 circuits top out near 10 %)", { s: gAt * ds, k: gAt });
    // The start straight: grid behind the line, pit entry road before it, exit road after.
    stats.startBackM = straightRun(tr, 0, -1, 600); stats.startFwdM = straightRun(tr, 0, +1, 600);
    if (stats.startBackM < LIMITS.startBackRed) add("start", "red", "Only " + stats.startBackM + " m of straight before the start line — the grid and pit entry need " + LIMITS.startBackAmber + " m", { s: 0, fix: "start" });
    else if (stats.startBackM < LIMITS.gridM) add("start", "amber", stats.startBackM + " m of straight before the line — the back of the grid needs " + LIMITS.gridM + " m, the pit entry " + LIMITS.startBackAmber + " m", { s: 0, fix: "start" });
    else if (stats.startBackM < LIMITS.startBackAmber) add("start", "amber", stats.startBackM + " m of straight before the line — " + LIMITS.startBackAmber + " m fits the whole grid and pit entry", { s: 0, fix: "start" });
    if (stats.startFwdM < LIMITS.startFwdRed) add("start", "red", "Only " + stats.startFwdM + " m of straight after the start line — the pit exit needs " + LIMITS.startFwdRed + " m", { s: 0, fix: "start" });
    else if (noBays(tr, def)) add("start", "red", "The pit lane has no room for its garages — move the start line earlier on the straight (only " + stats.startFwdM + " m after it)", { s: 0, fix: "start" });
    else if (stats.startFwdM < LIMITS.startFwdAmber) add("start", "amber", stats.startFwdM + " m of straight after the line — " + LIMITS.startFwdAmber + " m lets the pit exit merge cleanly", { s: 0, fix: "start" });
    try { const w = TrackPit.window(tr, Tracks.curvature); stats.pitEntryM = Math.round(w.entryM); stats.pitExitM = Math.round(w.exitM); } catch (_) { /* informational */ }
    turns = bakeTurns(tr);
    stats.turns = turns.length;
    const v = speedProfile(tr);
    stats.estLapS = +lapOf(tr, v).toFixed(1);
    // The FIA Grade 1 layout advice (insight.ts): AMBER only, never a gate.
    try {
      stats.passZones = TrackInsight.passingZones(tr, v).length;
      issues.push(...TrackInsight.fia(tr, design, stats, { v, turns }));
    } catch (_) { /* f1-game logs a warning here (Log.warn); dropped */ }
  }
  return { issues, stats, turns };
}
