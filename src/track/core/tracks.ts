/**
 * The track engine shell: centreline build, pit helpers, the build pipeline,
 * gate / start-line decals and terrainY. Ported from f1-game js/track/tracks.js
 * (Tracks, :1-776).
 *
 * What differs from f1-game, by design:
 * - No GPU upload. f1-game's buildSteps hands each buffer to `gfx.createMesh`;
 *   `buildTrack` keeps them as CPU buffers on `track.geo` (TODO(lane-render)
 *   uploads them). The buffers themselves are built by the same calls, in the
 *   same order.
 * - The scenery build (`TrackBuildProps`, js/track/scenery/build-props.js) is an
 *   injected `PropsBuilder`, stubbed to empty by default (TODO(lane-scenery)).
 *   With the stub there are no barriers, so `barL`/`barR` stay unset and
 *   `wallAt` uses spline.js's pre-build fallback; `openBoundary` is a no-op.
 * - The hidden-face strip / compaction, instanced batches, pit signs and the
 *   build profile stopwatch are render/scenery concerns and are not run.
 * - `Log.info` calls are dropped (logging only).
 */
import { CIRCUITS } from "../../circuits/index";
import { Teams } from "../../car/teams";
import { elevationAt, fromRaw, hasRealElevation, type BuiltDef, type RawDef } from "./def";
import { addBox, cross, norm } from "./geom";
import { bake as bakeLine } from "./line";
import { lerp } from "./math/scalar";
import {
  bankAngle, banking, bankingProfile, buildFloor, buildGridBoxes, buildPitBoxes, buildPitLane,
  buildRoad, buildTerrainSteps, onKerb, upOf,
} from "./mesh";
import { at as pitAt, build as buildPit, openBoundary, pitWindow as pitWindowOf, type PitWindow, type PitLaneAt, type TeamsLike } from "./pit";
import { racingNodeToSource, wrap01 } from "./space";
import { cr, crc, curvature, curvatureRaw, postLimits, project, sample, surfaceFolds, wallAt } from "./spline";
import { profile as surfaceProfile } from "./surface";
import type { GeometryDiagnostic, GeomOut, RV3, Sample, TerrainGrid, Track, V3 } from "./types";

export { sample, curvature, onKerb, banking, bankAngle, project, wallAt, postLimits };

const WORLD_UP: RV3 = [0, 1, 0];
const __M = Math;

export interface CenterlineOpts {
  /** false skips ONLY the racing-line bake (the designer's preview build). */
  line?: boolean;
}

/** Centreline only, no meshes. tracks.js:25 */
export function buildCenterline(def: BuiltDef, opts?: CenterlineOpts | null): Track {
  const P = def.points, N = P.length;
  const idx = (i: number) => ((i % N) + N) % N;
  const SUB = 16;
  // def.splineAlpha (opt-in): knot exponent for crc(); unset = uniform Catmull-Rom.
  const alpha = def.splineAlpha! > 0 ? Math.min(1, +def.splineAlpha!) : 0, crOut: V3 = [0, 0, 0];
  const dx: number[] = [], dy: number[] = [], dz: number[] = [], dhw: number[] = [], dbank: number[] = [], dlen: number[] = [0];
  for (let i = 0; i < N; i++) {
    const a = P[idx(i - 1)]!, b = P[i]!, c = P[idx(i + 1)]!, d = P[idx(i + 2)]!;
    for (let j = 0; j < SUB; j++) {
      const t = j / SUB;
      let x: number, y: number, z: number;
      if (alpha) { crc(a, b, c, d, t, alpha, crOut); x = crOut[0]; y = crOut[1]; z = crOut[2]; }
      else {
        x = cr(a[0], b[0], c[0], d[0], t);
        y = cr(a[1], b[1], c[1], d[1], t);
        z = cr(a[2], b[2], c[2], d[2], t);
      }
      dx.push(x); dy.push(y); dz.push(z);
      dhw.push(lerp(b[3], c[3], t));
      dbank.push(lerp(b[4], c[4], t));
      const k = dx.length - 1;
      if (k > 0) dlen.push(dlen[k - 1]! + Math.hypot(dx[k]! - dx[k - 1]!, dy[k]! - dy[k - 1]!, dz[k]! - dz[k - 1]!));
    }
  }
  const M = dx.length;
  const closeGap = Math.hypot(dx[0]! - dx[M - 1]!, dy[0]! - dy[M - 1]!, dz[0]! - dz[M - 1]!);
  const total = dlen[M - 1]! + closeGap;
  // A zero-length lap has no arc to sample (tracks.js:55).
  if (!(total > 1)) throw new Error("degenerate loop: lap length " + total + " m");
  // The final chord is a real interpolation interval (tracks.js:60).
  dx.push(dx[0]!); dy.push(dy[0]!); dz.push(dz[0]!);
  dhw.push(dhw[0]!); dbank.push(dbank[0]!); dlen.push(total);

  if (def.sceneryStartFrac != null) {
    const offNew = Math.round(wrap01(def.startFrac) * N) % N;
    const iOld = Math.round(wrap01(def.sceneryStartFrac) * N) % N;
    const j = (((def.reverse ? offNew - iOld : iOld - offNew) % N) + N) % N;
    def._sceneryShift = total ? dlen[j * SUB]! / total : 0;
  }

  const n = Math.max(200, Math.round(total / 4));
  const ds = total / n;
  const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n);
  const tx = new Float32Array(n), ty = new Float32Array(n), tz = new Float32Array(n);
  const rx = new Float32Array(n), ry = new Float32Array(n), rz = new Float32Array(n);
  const hw = new Float32Array(n), bank = new Float32Array(n);

  let di = 0;
  for (let k = 0; k < n; k++) {
    const target = k * ds;
    while (di < M - 1 && dlen[di + 1]! < target) di++;
    const seg = dlen[di + 1]! - dlen[di]! || 1;
    const f = (target - dlen[di]!) / seg;
    px[k] = lerp(dx[di]!, dx[di + 1]!, f);
    py[k] = lerp(dy[di]!, dy[di + 1]!, f);
    pz[k] = lerp(dz[di]!, dz[di + 1]!, f);
    hw[k] = lerp(dhw[di]!, dhw[di + 1]!, f);
    bank[k] = lerp(dbank[di]!, dbank[di + 1]!, f);
  }
  if (def.path && def.id && hasRealElevation(def.id)) surveyHeights(def, px, py, pz, n);
  const dress = def._sceneryShift || 0;
  const bridges = def.bridges;
  if (bridges) for (const b of bridges) {
    const cs = ((b.s + dress) % 1) * total;
    for (let k = 0; k < n; k++) {
      let d = Math.abs(k * ds - cs);
      d = Math.min(d, total - d);
      if (d < b.halfM) py[k]! += b.rise * 0.5 * (1 + Math.cos(Math.PI * d / b.halfM));
    }
  }
  // Elevation changes: terrain follows road (unlike bridges).
  const elevs = def.elevations;
  if (elevs) for (const e of elevs) {
    const cs = ((e.s + dress) % 1) * total;
    for (let k = 0; k < n; k++) {
      let d = Math.abs(k * ds - cs);
      d = Math.min(d, total - d);
      if (d < e.halfM) py[k]! += e.rise * 0.5 * (1 + Math.cos(Math.PI * d / e.halfM));
    }
  }
  // Low-amplitude ripple: 3 harmonics, whole cycles per lap, seeded off the id (tracks.js:114).
  if (def.undulate !== false) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < n; k++) { if (py[k]! < lo) lo = py[k]!; if (py[k]! > hi) hi = py[k]!; }
    const relief = hi - lo;
    const amp = Math.min(0.42, 0.14 + relief * 0.0028);
    let seed = 0;
    for (let i = 0; i < String(def.id).length; i++) seed = (seed * 31 + String(def.id).charCodeAt(i)) % 9973;
    const rnd = (i: number) => { const x = Math.sin((seed + i * 78.233) * 12.9898) * 43758.5453; return x - Math.floor(x); };
    const waves: { cycles: number; phase: number; w: number }[] = [];
    for (let h = 0; h < 3; h++) {
      const targetLen = 30 + h * 38 + rnd(h) * 22;
      const cycles = Math.max(4, Math.round(total / targetLen));
      waves.push({ cycles, phase: rnd(h + 7) * Math.PI * 2, w: h + 1 });
    }
    const normW = waves.reduce((a, b) => a + b.w, 0) || 1;
    for (let k = 0; k < n; k++) {
      const u = ((k / n - dress) % 1 + 1) % 1;
      let v = 0;
      for (const wv of waves) v += Math.sin(u * wv.cycles * Math.PI * 2 + wv.phase) * wv.w;
      py[k]! += (v / normW) * amp;
    }
  }

  // Tangents by central difference (wrap), then right + banking.
  for (let k = 0; k < n; k++) {
    const a = (k - 1 + n) % n, b = (k + 1) % n;
    const t = norm([px[b]! - px[a]!, py[b]! - py[a]!, pz[b]! - pz[a]!]);
    tx[k] = t[0]; ty[k] = t[1]; tz[k] = t[2];
    let r = norm(cross(t, WORLD_UP));
    const bk = bank[k]!;
    if (bk) {
      const u = cross(r, t);
      const cb = Math.cos(bk), sb = Math.sin(bk);
      r = [r[0] * cb + u[0] * sb, r[1] * cb + u[1] * sb, r[2] * cb + u[2] * sb];
    }
    rx[k] = r[0]; ry[k] = r[1]; rz[k] = r[2];
  }

  const track: Track = { def, total, n, px, py, pz, tx, ty, tz, rx, ry, rz, hw, bank, street: !!def.street, meshes: {}, map: null };
  track.map = buildMap(px, pz, n);
  // The static curvature LUT, before anything derives from it (tracks.js:159).
  track.curv = new Float32Array(n);
  { const cds = total / n; for (let k = 0; k < n; k++) track.curv[k] = curvatureRaw(track, k * cds); }
  if (opts && opts.line === false) track.line = null; else bakeLine(track);
  track.bankP = bankingProfile(track);
  return track;
}

/** The limiter window. tracks.js:198 */
export function pitWindow(track: Track): PitWindow {
  if (track && track.pit) return { entryM: track.pit.entryM, exitM: track.pit.exitM };
  return pitWindowOf(track, curvature);
}

/** Where the lane is at one arc position, in the car's lateral frame. tracks.js:217 */
export function pitLaneAt(track: Track, s: number): PitLaneAt | null { return pitAt(track, s); }

/** The lane's extent between the entry and exit lines. tracks.js:220 */
export function pitLaneSpan(track: Track): { sIn: number; lenM: number; side: number } | null {
  const p = track && track.pit;
  return p ? { sIn: p.sIn, lenM: p.lenM, side: p.side } : null;
}

/** Inside the lane, with half a car of tolerance at the inner edge. tracks.js:228 */
export function inPitLane(track: Track, s: number, x: number): boolean {
  const l = pitLaneAt(track, s);
  if (!l) return false;
  const a = Math.min(l.inner, l.outer) - (l.side > 0 ? 0.9 : 0);
  const b = Math.max(l.inner, l.outer) + (l.side > 0 ? 0 : 0.9);
  return x >= a && x <= b;
}

/** Scenery buffers a PropsBuilder returns (build-props.js build()). */
export interface PropsResult {
  out: GeomOut;
  glass: GeomOut;
  water: GeomOut;
}

/**
 * The scenery seam: f1-game's `TrackBuildProps` (js/track/scenery/build-props.js).
 * `build` also sets the driving boundary (`barL`/`barR`, `posts`) on the track;
 * `featherAfterOpen` runs after TrackPit.openBoundary. TODO(lane-scenery).
 */
export interface PropsBuilder {
  build(track: Track): PropsResult;
  featherAfterOpen?(track: Track): void;
}

const emptyGeo = (): GeomOut => ({ pos: [], nrm: [], col: [], idx: [], mat: [] });

/** The stub: no scenery, no barriers. */
export const EMPTY_PROPS: PropsBuilder = {
  build: () => ({ out: emptyGeo(), glass: emptyGeo(), water: emptyGeo() }),
};

export interface BuildOpts {
  night?: boolean | null;
  gridSlots?: number | null;
  props?: PropsBuilder;
  /** The garage row's teams; defaults to src/car/teams.ts. null = twelve unnamed bays (f1-game's bare VM). */
  teams?: TeamsLike | null;
}

interface GeometryCheck {
  ok: boolean;
  reason?: string;
  vertices?: number;
  indices?: number;
}

const isNumList = (a: unknown): a is ArrayLike<number> =>
  Array.isArray(a) || !!(a && (a as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT && typeof (a as { length?: unknown }).length === "number");
function firstNonFinite(a: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (!(v > -Infinity && v < Infinity)) return true;
  }
  return false;
}
/** f1-game js/track/scenery/models.js:177 validateGeometry (the build's `safe()` gate). */
export function validateGeometry(geo: GeomOut | null | undefined): GeometryCheck {
  if (!geo || !isNumList(geo.pos) || geo.pos.length % 3)
    return { ok: false, reason: "invalid position layout" };
  if (firstNonFinite(geo.pos))
    return { ok: false, reason: "non-finite position" };
  if (geo.nrm && (geo.nrm.length !== geo.pos.length || firstNonFinite(geo.nrm)))
    return { ok: false, reason: "invalid or non-finite normal" };
  if (geo.col && (geo.col.length !== geo.pos.length || firstNonFinite(geo.col)))
    return { ok: false, reason: "invalid or non-finite color" };
  const count = geo.pos.length / 3;
  if (!isNumList(geo.idx)) return { ok: false, reason: "invalid index" };
  for (let i = 0; i < geo.idx.length; i++) {
    const v = geo.idx[i]!;
    if (!Number.isInteger(v) || v < 0 || v >= count)
      return { ok: false, reason: "invalid index" };
  }
  return { ok: true, vertices: count, indices: geo.idx.length };
}

/**
 * A full build without upload: f1-game tracks.js:255 buildSteps' order with the
 * CPU buffers kept on `track.geo`. `buildTrack(def)` must reproduce f1-game's
 * centreline, sample tables and mesh buffers.
 */
export function buildTrack(def: BuiltDef, opts?: BuildOpts | null): Track {
  const track = buildCenterline(def);
  // The pit complex first: the terrain profile and the scenery read it.
  // f1-game always has Teams loaded (TRACK_VM includes js/data/teams.js), and the pit
  // boxes are painted in the row's team colours, so the game's table is the default.
  track.pit = buildPit(track, def, curvature, opts && opts.teams !== undefined ? opts.teams : Teams);
  track.surface = surfaceProfile(def, track);
  track._night = opts && opts.night != null ? !!opts.night : !!def.night;
  track._gridSlots = opts && opts.gridSlots! > 0 ? Math.round(opts.gridSlots!) : null;
  const diags: GeometryDiagnostic[] = track.geometryDiagnostics = [];
  diags.push(Object.assign({ name: "centreline", ok: true }, surfaceFolds(track)));
  const safe = (name: string, geo: GeomOut): GeomOut => {
    const result = validateGeometry(geo);
    diags.push(Object.assign({ name }, result));
    if (result.ok) return geo;
    return { pos: [], nrm: [], col: [], idx: [], mat: [] };
  };
  const floor = safe("floor", buildFloor(track));
  const road = safe("road", buildRoad(track));
  track.roadGeo = road;
  const terrainIt = buildTerrainSteps(track);
  let r = terrainIt.next();
  while (!r.done) r = terrainIt.next();
  const terrain = safe("terrain", r.value);
  track.terrainGeo = terrain;
  const builder = (opts && opts.props) || EMPTY_PROPS;
  const props = builder.build(track);
  // After the props: the scenery kept out of the complex, so opening the boundary puts nothing in a car's path.
  openBoundary(track);
  if (builder.featherAfterOpen) builder.featherAfterOpen(track);
  const propsGeo = safe("props", props.out);
  track.propsGeo = propsGeo;
  track.propTop = propTop(track, propsGeo);
  const glass = safe("glass", props.glass);
  const water = safe("water", props.water);
  track.glassGeo = glass;
  track.waterGeo = water;
  const gate = safe("gate", buildGate(track));
  const startline = safe("startline", buildStartLine(track));
  track.geo = { floor, road, terrain, props: propsGeo, glass, water, gate, startline };
  return track;
}

/** The minimap polyline in [0,1]^2. tracks.js:480 */
function buildMap(px: Float32Array, pz: Float32Array, n: number): [number, number][] {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let i = 0; i < n; i++) {
    if (px[i]! < minx) minx = px[i]!; if (px[i]! > maxx) maxx = px[i]!;
    if (pz[i]! < minz) minz = pz[i]!; if (pz[i]! > maxz) maxz = pz[i]!;
  }
  const w = maxx - minx || 1, h = maxz - minz || 1, sc = 1 / Math.max(w, h);
  const ox = (1 - w * sc) / 2, oz = (1 - h * sc) / 2;
  const out: [number, number][] = [], step = Math.max(1, Math.floor(n / 200));
  for (let i = 0; i < n; i += step) out.push([ox + (maxx - px[i]!) * sc, oz + (maxz - pz[i]!) * sc]);
  return out;
}

/** The start gantry boxes. tracks.js:495 */
export function buildGate(track: Track): GeomOut {
  const out: GeomOut = { pos: [], nrm: [], col: [], idx: [] };
  const backDist = 15;
  const tmp: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
  sample(track, track.total - backDist, tmp);
  const r = norm(tmp.r), t = norm(tmp.t), u = norm(cross(r, t));
  const w = tmp.hw;
  const gateX = tmp.p[0], gateY = tmp.p[1], gateZ = tmp.p[2];
  const basis = [r, u, t] as const;
  for (const side of [-1, 1]) {
    const o = side * (w + 1.5);
    addBox(out,
      [gateX + r[0] * o + u[0] * 3, gateY + r[1] * o + u[1] * 3, gateZ + r[2] * o + u[2] * 3],
      [1, 6, 1], [0.85, 0.1, 0.1], basis);
  }
  const beam: V3 = [gateX + u[0] * 6.2, gateY + u[1] * 6.2, gateZ + u[2] * 6.2];
  track.startGate = { c: beam, t, face: 0.65 };
  addBox(out, beam, [w * 2 + 4, 0.8, 1.2], [0.1, 0.1, 0.12], basis);
  addBox(out,
    [gateX + u[0] * 6.8, gateY + u[1] * 6.8, gateZ + u[2] * 6.8],
    [w * 1.4, 0.6, 0.6], [0.95, 0.95, 0.97], basis);
  return out;
}

/** The chequered start line, then pit lane, pit boxes and the grid (the grid is the buffer's tail). tracks.js:520 */
export function buildStartLine(track: Track): GeomOut {
  const out: GeomOut = { pos: [], nrm: [], col: [], idx: [] };
  const r = [track.rx[0]!, track.ry[0]!, track.rz[0]!];
  const t = [track.tx[0]!, track.ty[0]!, track.tz[0]!];
  const u = upOf(track, 0);
  const w = track.hw[0]!;
  const P = [track.px[0]!, track.py[0]!, track.pz[0]!];
  const white = track.def.palette.line || [0.95, 0.95, 0.98];
  const dark = [0.05, 0.05, 0.06];
  const SQ = 0.5;
  const rows = 2;
  const depth = rows * SQ;
  const cols = Math.max(2, Math.round((2 * w) / SQ));
  const colW = (2 * w) / cols;
  const lift = 0.05;
  let base = 0;
  for (let ri = 0; ri < rows; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      const c = (((ri + ci) & 1) === 0) ? white : dark;
      const o0 = -w + ci * colW, o1 = o0 + colW;
      const d0 = -depth / 2 + ri * SQ, d1 = d0 + SQ;
      const vert = (o: number, d: number) => {
        out.pos.push(P[0]! + r[0]! * o + t[0]! * d + u[0] * lift,
                     P[1]! + r[1]! * o + t[1]! * d + u[1] * lift,
                     P[2]! + r[2]! * o + t[2]! * d + u[2] * lift);
        out.nrm.push(u[0], u[1], u[2]);
        out.col.push(c[0]!, c[1]!, c[2]!);
      };
      vert(o0, d0); vert(o1, d0); vert(o0, d1); vert(o1, d1);
      out.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      base += 4;
    }
  }
  buildPitLane(track, out);
  buildPitBoxes(track, out);
  buildGridBoxes(track, out);
  return out;
}

/**
 * The survey at every 4 m node: align once on the source trace, then read
 * monotonic arc fractions of the periodic elevation table. tracks.js:573
 */
function surveyHeights(def: BuiltDef, px: Float32Array, py: Float32Array, pz: Float32Array, n: number): void {
  const P = def.path!.pts, N = P.length, arc = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) arc[i] = arc[i - 1]! + __M.hypot(P[i % N]![0] - P[i - 1]![0], P[i % N]![1] - P[i - 1]![1]);
  const pathLen = arc[N] || 1;
  const near = (x: number, z: number, i: number): [number, number] => {
    const a = P[i]!, b = P[(i + 1) % N]!, ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez || 1;
    const t = __M.max(0, __M.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2));
    const qx = a[0] + ex * t - x, qz = a[1] + ez * t - z;
    return [qx * qx + qz * qz, arc[i]! + t * (arc[i + 1]! - arc[i]!)];
  };
  let seg = 0, bd = Infinity;
  for (let i = 0; i < N; i++) { const d = near(px[0]!, pz[0]!, i)[0]; if (d < bd) { bd = d; seg = i; } }
  const startFrac = near(px[0]!, pz[0]!, seg)[1] / pathLen;
  const dir = def.reverse ? -1 : 1, y0 = elevationAt(def.id, startFrac)!, base = py[0]!;
  for (let k = 0; k < n; k++) {
    const f = ((startFrac + dir * (k / n)) % 1 + 1) % 1;
    py[k] = base + elevationAt(def.id, f)! - y0;
  }
}

/** Every circuit as a built def, in f1-game's curated Tracks.LIST order. tracks.js:594 */
export const LIST: readonly BuiltDef[] = CIRCUITS.map((d) => fromRaw(d as RawDef));
/** tracks.js:632 */
export const SEASON: readonly BuiltDef[] = LIST.filter((t) => !t.classic);

/** A fresh built def for one circuit id (fresh, so a build's def mutations never leak between builds). */
export function defById(id: string): BuiltDef | undefined {
  const raw = CIRCUITS.find((c) => c.id === id);
  return raw ? fromRaw(raw as RawDef) : undefined;
}

/** tracks.js:634 */
export function seasonIndex(round: number): number {
  const t = SEASON[round];
  return t ? LIST.indexOf(t) : -1;
}

// Inclusion margin of terrainY, metres of world distance from a triangle edge. tracks.js:642
const TRI_EPS = 0.01;

/** tracks.js:643 */
function terrainGrid(track: Track): TerrainGrid | null {
  const g = track.terrainGeo;
  if (!g || !g.pos || !g.idx) return null;
  if (track._terrGrid && track._terrGrid.geo === g) return track._terrGrid;
  const pos = g.pos, idx = g.idx, CELL = 24;
  let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i]! < mnx) mnx = pos[i]!; if (pos[i]! > mxx) mxx = pos[i]!;
    if (pos[i + 2]! < mnz) mnz = pos[i + 2]!; if (pos[i + 2]! > mxz) mxz = pos[i + 2]!;
  }
  if (!isFinite(mnx)) return null;
  const nx = Math.max(1, Math.ceil((mxx - mnx) / CELL));
  const nz = Math.max(1, Math.ceil((mxz - mnz) / CELL));
  const cells: (number[] | undefined)[] = new Array<number[] | undefined>(nx * nz);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3;
    const x0 = __M.min(pos[a]!, pos[b]!, pos[c]!) - TRI_EPS, x1 = __M.max(pos[a]!, pos[b]!, pos[c]!) + TRI_EPS;
    const z0 = __M.min(pos[a + 2]!, pos[b + 2]!, pos[c + 2]!) - TRI_EPS;
    const z1 = __M.max(pos[a + 2]!, pos[b + 2]!, pos[c + 2]!) + TRI_EPS;
    const i0 = __M.max(0, __M.floor((x0 - mnx) / CELL));
    const i1 = __M.min(nx - 1, __M.floor((x1 - mnx) / CELL));
    const j0 = __M.max(0, __M.floor((z0 - mnz) / CELL));
    const j1 = __M.min(nz - 1, __M.floor((z1 - mnz) / CELL));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = j * nx + i;
        (cells[k] || (cells[k] = [])).push(t);
      }
    }
  }
  track._terrGrid = { geo: g, mnx, mnz, mxx, mxz, nx, nz, cell: CELL, cells };
  return track._terrGrid;
}

/** Height of the tallest prop above its own ground (the sun shadow span). tracks.js:683 */
function propTop(track: Track, propsGeo: GeomOut | null | undefined): number {
  const t = track.terrainGeo && track.terrainGeo.pos, p = propsGeo && propsGeo.pos;
  if (!t || !t.length || !p || !p.length) return 0;
  let lo = Infinity, best = 0;
  for (let i = 1; i < t.length; i += 3) if (t[i]! < lo) lo = t[i]!;
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1]!;
    if (!(y - lo > best)) continue;
    const g = terrainY(track, p[i]!, p[i + 2]!);
    if (g != null && y - g > best) best = y - g;
  }
  return best;
}

/** Highest terrain triangle under (x, z), or null off the terrain. tracks.js:723 */
export function terrainY(track: Track, x: number, z: number): number | null {
  const g = track.terrainGeo; if (!g) return null;
  const pos = g.pos, idx = g.idx; let best: number | null = null;
  const G = terrainGrid(track);
  if (G) {
    if (x < G.mnx - TRI_EPS || z < G.mnz - TRI_EPS || x > G.mxx + TRI_EPS || z > G.mxz + TRI_EPS) return null;
    const i = __M.min(G.nx - 1, __M.max(0, __M.floor((x - G.mnx) / G.cell)));
    const j = __M.min(G.nz - 1, __M.max(0, __M.floor((z - G.mnz) / G.cell)));
    const list = G.cells[j * G.nx + i];
    if (!list) return null;
    for (let n = 0; n < list.length; n++) {
      const t = list[n]!;
      best = triY(pos, idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3, x, z, best);
    }
    return best;
  }
  for (let t = 0; t < idx.length; t += 3) {
    best = triY(pos, idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3, x, z, best);
  }
  return best;
}

/** tracks.js:746 _triY */
function triY(pos: number[], a: number, b: number, c: number, x: number, z: number, best: number | null): number | null {
  const ax = pos[a]!, az = pos[a + 2]!, bx = pos[b]!, bz = pos[b + 2]!, cx = pos[c]!, cz = pos[c + 2]!;
  const v0x = cx - ax, v0z = cz - az, v1x = bx - ax, v1z = bz - az, v2x = x - ax, v2z = z - az;
  const d00 = v0x * v0x + v0z * v0z, d01 = v0x * v1x + v0z * v1z, d11 = v1x * v1x + v1z * v1z, d20 = v2x * v0x + v2z * v0z, d21 = v2x * v1x + v2z * v1z;
  const den = d00 * d11 - d01 * d01; if (__M.abs(den) < 1e-9) return best;
  const u = (d11 * d20 - d01 * d21) / den, vv = (d00 * d21 - d01 * d20) / den;
  const tA = __M.sqrt(den), w = 1 - u - vv;
  if (u * tA < -TRI_EPS * __M.sqrt(d11) || vv * tA < -TRI_EPS * __M.sqrt(d00)
      || w * tA < -TRI_EPS * __M.sqrt((v0x - v1x) * (v0x - v1x) + (v0z - v1z) * (v0z - v1z))) return best;
  const y = pos[a + 1]! + u * (pos[c + 1]! - pos[a + 1]!) + vv * (pos[b + 1]! - pos[a + 1]!);
  return best === null || y > best ? y : best;
}

// racingNodeToSource is re-exported for callers that remap control points.
export { racingNodeToSource };
