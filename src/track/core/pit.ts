/**
 * TrackPit: the PIT COMPLEX as one model every consumer reads (lane ribbon,
 * painted boxes, stop row, wall, garages). Ported verbatim from f1-game
 * js/track/core/pit.js (TrackPit, :1-490); the long design notes there
 * (docs/research/PIT-LANE-REDESIGN-2026-09.md) are summarised here.
 *
 * Differences from f1-game, none of which change a number:
 * - `window` is exported as `pitWindow` (and aliased `window`).
 * - `row()` reads f1-game's `Teams` global at call time; here the team list is an
 *   optional argument (TODO(lane-race): pass the team table). Without it the row
 *   is twelve unnamed bays, exactly as in f1-game's bare Node VM, so geometry
 *   never depends on it.
 */
import type { PitArchitecture, PitBands, PitSpec, RoofKnot } from "../../circuits/types";
import type { RV3, Track } from "./types";

/** Bands in metres from the racing-surface edge outward (Appendix O §7.9, FIM §9). pit.js:17 */
export interface Bands {
  verge: number;
  platform: number;
  fast: number;
  corridor: number;
  work: number;
}
export const BANDS: Readonly<Bands> = { verge: 2.0, platform: 2.0, fast: 3.5, corridor: 1.0, work: 5.5 };
/** Street circuit bands (Monaco-real, 10 m wall-to-garage). pit.js:25 */
export const STREET: Readonly<Bands> = { verge: 0.6, platform: 1.6, fast: 3.2, corridor: 1.0, work: 4.2 };
/** The painted opt-out: no ribbon, no wall. pit.js:26 */
export const NARROW: Readonly<Bands> = { verge: 0.6, platform: 0.0, fast: 3.0, corridor: 0.6, work: 3.4 };

/** One bay: the setup screen's room. pit.js:33 */
export const BAY = { w: 10.8, gap: 0.2, depth: 12.8, h: 5.0, doorW: 5.4, doorH: 4.8 } as const;
export type Bay = typeof BAY;
/** The one pitch (paint, stop, door): 11.0 m. pit.js:34 */
export const PITCH = BAY.w + BAY.gap;
/** The FIA grid slot and a real box's frontage. pit.js:35 */
export const BOX_LEN = 8;
/** The lintel sign / crest / board / signal atlas layout. pit.js:41 */
export const SIGN = {
  w: 1024, h: 1024, cols: 2, cells: 12, cellW: 512, cellH: 70,
  quadW: 5.2, quadH: 0.7, y0: 4.85, proud: 0.275,
  crests: 12, crestPx: 160, crestCols: 6, crestY: 512, crestW: 1.8, crestY0: 1.5,
  boards: 2, boardW: 2.4, boardH: 0.33, boardY: 1.5, boardM: [45, 110] as readonly number[],
  signals: 2, signalPx: 64, signalY: 848, signalW: 0.34,
} as const;
/** Share of the road width the exit wall runs along. pit.js:78 */
export const EXIT_WALL_W = 0.75;

export const ENTRY_MAX = 260, ENTRY_MIN = 150, EXIT_M = 110, EXIT_MIN = 40;
export const PIT_K = 0.0035;
const STEP = 8;
export const ENTRY_ROAD = 70, EXIT_ROAD = 90, ROAD_MIN = 30, WALL_GROW = 30;
export const MOUTH_RUN = 20;
export const EXIT_ROAD_MIN = 80;
const MERGE_RUN = 40;
export const LIMIT_KPH = 80, LIMIT_KPH_STREET = 60;
export const GRID_POLE_M = 14, GRID_CLEAR = 40, ROW_END = 30, ROW_TAIL = 16;
export const BAY_FLARE = 24;

const wrap = (v: number, L: number) => ((v % L) + L) % L;
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Curvature reader injected into window()/build() so this file owns no spline. */
export type CurvatureFn = (track: Track, s: number) => number;

/** The validated architecture recipe. pit.js:121 */
export interface ResolvedArchitecture {
  roofProfile: number[][];
  roofColor?: number[];
  fasciaColor?: number[];
  soffitColor?: number[];
  edgeColor?: number[];
}

/** pit.js:121 */
export function architecture(spec: PitArchitecture | null | undefined): ResolvedArchitecture | null {
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.roofProfile)) return null;
  const profile: readonly RoofKnot[] = spec.roofProfile;
  if (profile.length < 2 || profile.length > 7) return null;
  let previous = -1;
  for (const knot of profile) {
    if (!Array.isArray(knot) || knot.length !== 3 || !Array.from(knot).every(Number.isFinite) ||
        knot[0] < 0 || knot[0] > 1 || knot[0] <= previous ||
        knot[1] < 9.6 || knot[1] > 18 || knot[2] < 9.6 || knot[2] > 18) return null;
    previous = knot[0];
  }
  if (profile[0]![0] !== 0 || profile[profile.length - 1]![0] !== 1) return null;
  const result: ResolvedArchitecture = { roofProfile: profile.map((knot) => knot.slice()) };
  for (const key of ["roofColor", "fasciaColor", "soffitColor", "edgeColor"] as const) {
    const color: unknown = spec[key];
    if (color === undefined) continue;
    if (!Array.isArray(color) || color.length !== 3 ||
        !Array.from(color as unknown[]).every((value) => Number.isFinite(value) && (value as number) >= 0 && (value as number) <= 1)) return null;
    result[key] = (color as number[]).slice();
  }
  return result;
}

/** Lateral offsets of the band edges from the road edge. */
export interface BandOffsets {
  fastIn: number;
  fastOut: number;
  corrOut: number;
  workOut: number;
  outer: number;
}

export interface ResolvedPit {
  side: -1 | 1;
  mode: "full" | "street" | "narrow";
  limitKph: number;
  bands: Bands;
  off: BandOffsets;
  painted: boolean;
  hasWall: boolean;
  hasBays: boolean;
  architecture: ResolvedArchitecture | null;
}

/** The def fields resolve() reads. */
export interface PitDefLike {
  pit?: PitSpec | null;
  street?: boolean;
}

/** Resolve a def's pit choices: side, mode, limit and the band set. pit.js:144 */
export function resolve(def: PitDefLike | null | undefined): ResolvedPit {
  const p: PitSpec = (def && def.pit) || {};
  const street = !!(def && def.street);
  const mode = p.mode === "narrow" || p.mode === "full" || p.mode === "street" ? p.mode : (street ? "street" : "full");
  const b: Bands = Object.assign({}, mode === "narrow" ? NARROW : mode === "street" ? STREET : BANDS, (p.bands || {}) as PitBands) as Bands;
  const off: BandOffsets = {
    fastIn: b.verge + b.platform,
    fastOut: b.verge + b.platform + b.fast,
    corrOut: b.verge + b.platform + b.fast + b.corridor,
    workOut: b.verge + b.platform + b.fast + b.corridor + b.work,
    outer: 0,
  };
  off.outer = off.workOut;
  const painted = mode === "narrow";
  return {
    side: p.side === -1 ? -1 : 1,
    mode,
    limitKph: Number.isFinite(p.limitKph) ? p.limitKph! : (painted ? LIMIT_KPH_STREET : LIMIT_KPH),
    bands: b, off,
    painted,
    hasWall: !painted && b.platform > 0,
    hasBays: !painted && p.bays !== false,
    architecture: architecture(p.architecture),
  };
}

/** How far the road stays straight from `s0` in direction `dir`, up to `max`. pit.js:179 */
function straightRun(track: Track, curvature: CurvatureFn | null | undefined, s0: number, dir: number, max: number): number {
  if (typeof curvature !== "function") return max;
  const L = track.total;
  let d = 0;
  for (; d < max; d += STEP) {
    if (Math.abs(curvature(track, wrap(s0 + dir * (d + STEP / 2), L))) > PIT_K) break;
  }
  return d;
}

export interface PitWindow {
  entryM: number;
  exitM: number;
}

/** The limiter window: how far before the line it opens, how far after it closes. pit.js:189 */
export function pitWindow(track: Track, curvature: CurvatureFn | null | undefined): PitWindow {
  const L = track.total;
  if (!(L > 0)) return { entryM: ENTRY_MAX, exitM: EXIT_M };
  const cap = L / 3;
  const back = straightRun(track, curvature, 0, -1, ENTRY_MAX + ENTRY_ROAD + MOUTH_RUN);
  const entryM = Math.min(Math.max(back - ENTRY_ROAD - MOUTH_RUN, ENTRY_MIN), ENTRY_MAX, cap * 0.7);
  const fwd = straightRun(track, curvature, 0, 1, EXIT_M + ROAD_MIN);
  let exitM = Math.min(EXIT_M, cap * 0.3, Math.max(EXIT_MIN, fwd - ROAD_MIN));
  const roadFor = (eM: number) => {
    const room = Math.max(ROAD_MIN, (L / 3 - (entryM + eM)) * 0.4);
    return Math.min(EXIT_ROAD, room,
      Math.max(EXIT_ROAD_MIN, straightRun(track, curvature, wrap(eM, L), 1, EXIT_ROAD)));
  };
  const entryRoad0 = Math.min(ENTRY_ROAD, Math.max(ROAD_MIN, (L / 3 - (entryM + exitM)) * 0.4),
    Math.max(ROAD_MIN, straightRun(track, curvature, wrap(-entryM, L), -1, ENTRY_ROAD)));
  const span = (12 - 1) * PITCH;
  const budgetFor = (eM: number) => {
    const grow = Math.min(WALL_GROW, entryRoad0 * 0.5, roadFor(eM) * 0.5);
    return (entryM + eM) - ROW_END - span - grow - 20;
  };
  // A rejoining car must see a straight: pull the exit back inside the bay row's budget (pit.js:249).
  const mergeRun = (eM: number) => straightRun(track, curvature, wrap(eM + roadFor(eM), L), 1, MERGE_RUN);
  if (mergeRun(exitM) < MERGE_RUN) {
    const room = Math.max(0, budgetFor(exitM));
    for (let back = 4; back <= room; back += 4) {
      const cand = exitM - back;
      if (cand < EXIT_MIN || budgetFor(cand) < 0) break;
      if (mergeRun(cand) >= MERGE_RUN) { exitM = cand; break; }
    }
  }
  return { entryM, exitM };
}
export { pitWindow as window };

/** A team row entry (f1-game js/data/teams.js shape, the fields row() reads). */
export interface TeamLike {
  id: string;
  name?: string;
  short?: string;
  color?: RV3;
  color2?: RV3;
  livery?: { logo3?: unknown } | null;
  legends?: boolean;
}
export interface TeamsLike {
  LIST?: readonly TeamLike[];
  DEFAULT_CUSTOM?: { id: string; name: string; short?: string; color?: RV3; color2?: RV3 } | null;
}

export interface BayRow {
  team: string;
  name: string;
  short: string;
  col: RV3;
  col2: RV3;
  logo3: unknown;
}

/** The garage row: one bay per team, plus MY TEAM, padded to twelve. pit.js:268 */
export function row(teams?: TeamsLike | null): BayRow[] {
  const out: BayRow[] = [];
  const T = teams || null;
  const list = T && Array.isArray(T.LIST) ? T.LIST : [];
  for (const t of list) { if (t.legends) continue; out.push({ team: t.id, name: t.name || t.id, short: t.short || t.id.slice(0, 3).toUpperCase(),
                                   col: t.color || [0.6, 0.6, 0.65], col2: t.color2 || [0.9, 0.9, 0.9],
                                   logo3: (t.livery && t.livery.logo3) || null }); }
  const custom = T && T.DEFAULT_CUSTOM;
  const customId = custom ? custom.id : "custom";
  if (!out.some((b) => b.team === customId))
    out.push({ team: customId, name: custom ? custom.name : "MY TEAM", short: (custom && custom.short) || "MY",
               col: (custom && custom.color) || [0.55, 0.55, 0.6], col2: (custom && custom.color2) || [0.9, 0.9, 0.9], logo3: null });
  while (out.length < 12) out.push({ team: "row" + out.length, name: "ROW " + out.length, short: "R" + out.length, col: [0.6, 0.6, 0.65], col2: [0.9, 0.9, 0.9], logo3: null });
  return out;
}

export interface PitBox extends BayRow {
  through: number;
  s: number;
  k: number;
}

/** The built pit complex (pit.js:385 build's return). */
export interface PitModel {
  side: -1 | 1;
  mode: "full" | "street" | "narrow";
  limitKph: number;
  bands: Bands;
  off: BandOffsets;
  painted: boolean;
  hasWall: boolean;
  hasBays: boolean;
  architecture: ResolvedArchitecture | null;
  sA: number; sIn: number; sOut: number; sB: number;
  entryM: number; exitM: number; lenM: number; entryRoadM: number; exitRoadM: number; grow: number;
  /** Per node: lane width weight, wall weight, bay-lane weight, keep-out lateral (m past hw). */
  w: Float32Array; v: Float32Array; b: Float32Array; keep: Float32Array;
  row: { pitch: number; boxLen: number; first: number; count: number; boxes: PitBox[]; s0: number; s1: number; tail: number; painted?: number[] };
  bay: Bay;
}

/** Build the model for a built centreline, once, before terrain and scenery. pit.js:300 */
export function build(track: Track, def: PitDefLike, curvature: CurvatureFn | null | undefined, teams?: TeamsLike | null): PitModel | null {
  const n = track.n, L = track.total;
  if (!(n > 0) || !(L > 0)) return null;
  const r = resolve(def);
  const win = pitWindow(track, curvature);
  const ds = L / n;
  const sIn = wrap(-win.entryM, L), sOut = wrap(win.exitM, L);
  const lenM = win.entryM + win.exitM;
  const room = Math.max(ROAD_MIN, (L / 3 - lenM) * 0.4);
  const entryRoadM = Math.min(ENTRY_ROAD, room,
    Math.max(ROAD_MIN, straightRun(track, curvature, sIn, -1, ENTRY_ROAD)));
  const exitRoadM = Math.min(EXIT_ROAD, room,
    Math.max(EXIT_ROAD_MIN, straightRun(track, curvature, sOut, 1, EXIT_ROAD)));
  const sA = wrap(sIn - entryRoadM, L), sB = wrap(sOut + exitRoadM, L);
  const grow = Math.min(WALL_GROW, entryRoadM * 0.5, exitRoadM * 0.5);

  const w = new Float32Array(n), v = new Float32Array(n), b = new Float32Array(n), keep = new Float32Array(n);
  const rows = row(teams);
  const through = (s: number) => wrap(s - sIn, L);
  const count = rows.length;
  const lo = grow + 20, hi = Math.max(lo, lenM - ROW_END);
  let pitch: number = PITCH;
  // The epsilon is load-bearing: a row that just fits is a row that fits.
  if ((count - 1) * pitch > hi - lo + 1e-6) pitch = Math.max(BOX_LEN + 1, (hi - lo) / (count - 1));
  const hasBays = r.hasBays && pitch >= PITCH - 1e-6;
  const span = (count - 1) * pitch;
  const poleT = through(wrap(-GRID_POLE_M, L));
  const first = Math.min(Math.max(poleT + GRID_CLEAR, lo), Math.max(lo, hi - span));
  const boxes: PitBox[] = rows.map((row_, i) => {
    const t = first + i * pitch;
    return Object.assign({}, row_, { through: t, s: wrap(sIn + t, L), k: Math.round(wrap(sIn + t, L) / ds) % n });
  });
  const rowS0 = wrap(sIn + first - pitch / 2, L), rowS1 = wrap(sIn + first + span + pitch / 2, L);
  const rowKeepS1 = wrap(sIn + first + span + pitch / 2 + ROW_TAIL, L);
  const inArc = (s: number, a: number, b: number) => (a <= b ? (s >= a && s <= b) : (s >= a || s <= b));
  for (let k = 0; k < n; k++) {
    if (r.painted) break;
    const s = k * ds;
    let wk = 0, vk = 0;
    if (inArc(s, sA, sIn)) {                       // the entry road
      const d = wrap(s - sA, L);
      wk = smooth(d / Math.max(1, entryRoadM - grow));
      vk = smooth((d - (entryRoadM - grow)) / grow);
    } else if (inArc(s, sIn, sOut)) {              // the lane proper
      wk = 1; vk = 1;
    } else if (inArc(s, sOut, sB)) {               // the exit road
      const d = wrap(s - sOut, L);
      vk = 1 - smooth(d / grow);
      wk = 1 - smooth((d - grow) / Math.max(1, exitRoadM - grow));
    }
    w[k] = wk; v[k] = vk;
    // The working lane exists where the bays do, flaring over BAY_FLARE (pit.js:362).
    if (hasBays) {
      const span2 = wrap(rowS1 - rowS0, L) + 2 * BAY_FLARE;
      const d = wrap(s - wrap(rowS0 - BAY_FLARE, L), L);
      if (d <= span2) b[k] = Math.min(smooth(d / BAY_FLARE), smooth((span2 - d) / BAY_FLARE)) * wk;
    }
    if (wk > 0) {
      keep[k] = r.off.outer * wk + 0.3;
      if (hasBays && inArc(s, rowS0, rowKeepS1)) keep[k]! += BAY.depth + 3.0;
    }
  }
  return {
    side: r.side, mode: r.mode, limitKph: r.limitKph, bands: r.bands, off: r.off,
    painted: r.painted, hasWall: r.hasWall, hasBays,
    architecture: r.architecture,
    sA, sIn, sOut, sB, entryM: win.entryM, exitM: win.exitM, lenM, entryRoadM, exitRoadM, grow,
    w, v, b, keep,
    row: { pitch, boxLen: BOX_LEN, first, count, boxes, s0: rowS0, s1: rowS1, tail: ROW_TAIL },
    bay: BAY,
  };
}

/** The lane at one arc position, in the car's lateral frame (signed, +x right). */
export interface PitLaneAt {
  side: -1 | 1;
  w: number;
  v: number;
  inner: number;
  outer: number;
  centre: number;
  fastOut: number;
  workIn: number;
  workCentre: number;
  width: number;
}

/** The lane at arc s, or null outside the complex. pit.js:406 */
export function at(track: Pick<Track, "pit" | "n" | "total" | "hw">, s: number): PitLaneAt | null {
  const p = track && track.pit;
  if (!p) return null;
  const n = track.n, L = track.total;
  const k = ((Math.round((s / L) * n) % n) + n) % n;
  const wk = p.w[k]!;
  if (!(wk > 0.01)) return null;
  const vk = p.v[k]!, sd = p.side, h = track.hw[k]!, o = p.off;
  const bk = p.b ? p.b[k]! : wk;
  const fastIn = h + o.fastIn * vk;
  const fastOut = h + o.fastOut * wk;
  const corrOut = fastOut + (o.corrOut - o.fastOut) * bk;
  const workOut = corrOut + (o.workOut - o.corrOut) * bk;
  // No bays: the stop happens in the fast lane (pit.js:425).
  const lane = p.hasBays === false;
  return {
    side: sd, w: wk, v: vk,
    inner: sd * fastIn, outer: sd * workOut,
    centre: sd * (fastIn + Math.max(fastIn, fastOut)) / 2,
    fastOut: sd * fastOut, workIn: sd * (lane ? fastIn : corrOut),
    workCentre: sd * (lane ? (fastIn + fastOut) / 2 : (corrOut + workOut) / 2),
    width: Math.max(0, workOut - fastIn),
  };
}

/** The lane's outer edge at node k, beyond hw. pit.js:446 */
export function outerAt(p: PitModel | null | undefined, k: number): number {
  if (!p) return 0;
  const o = p.off, wk = p.w[k]!, bk = p.b ? p.b[k]! : wk;
  return o.fastOut * wk + (o.workOut - o.fastOut) * bk;
}

/** Push the driving boundary out to the complex's far edge across the window. pit.js:455 */
export function openBoundary(track: Track): void {
  const p = track && track.pit;
  if (!p || !track.barL || !track.barR) return;
  const bar = p.side > 0 ? track.barR : track.barL;
  for (let k = 0; k < track.n; k++) {
    if (!(p.keep[k]! > 0)) continue;
    const lim = track.hw[k]! + outerAt(p, k) - 0.9;
    bar[k] = lim > track.hw[k]! + 1.2 ? lim : Math.max(bar[k]!, lim);
  }
}

/** The row index of a team id; -1 when unknown. pit.js:477 */
export function rowOf(pit: PitModel | null | undefined, teamId: string | null | undefined): number {
  if (!pit || !teamId) return -1;
  const boxes = pit.row.boxes;
  for (let i = 0; i < boxes.length; i++) if (boxes[i]!.team === teamId) return i;
  return -1;
}
