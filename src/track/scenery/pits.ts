/**
 * SceneryPits: the pit complex's 3D furniture, built FROM TrackPit. The
 * signalling platform and pit wall swept along the lane, the entry/exit boards
 * and the exit lights, and the garages: the setup screen's own bay
 * (GarageScene.buildStatic) placed once per team on the row the model laid
 * out, under a roof and a hospitality storey that follow the arc bay by bay.
 * Nothing here decides WHERE anything is: every position is track.pit's.
 * Emits with the RAW emitters on purpose (pits.js:7-8).
 *
 * Port of f1-game js/track/scenery/pits.js:1-791 (`SceneryPits`). Verbatim:
 * float math keeps f1-game's operation order (including its own Math.hypot
 * calls). Differences from the IIFE:
 * - Engine globals come from the injected `core` (`build(ctx, core)`):
 *   TrackGeom (MAT, MIN_SEP, norm, cross, addMesh), TrackSpline.sample,
 *   TrackPit (SIGN, EXIT_WALL_W, outerAt), GLX.mobileTier (`core.glx`) and
 *   GarageScene.buildStatic (`core.garage`). f1-game's
 *   `typeof X !== "undefined"` guards become null checks on `core.glx` /
 *   `core.garage`; TrackGeom/TrackSpline/TrackPit are always present in core.
 * - BAY_CACHE stays module state as in f1-game (pits.js:22); `bayMesh` and
 *   `lowTier` take `core` as their last parameter.
 * - pits.js does not call TrackModels (only a comment at :161 names it).
 */
import type { Basis, RVec3, SceneryBuffer } from "../../contracts/scenery";
import type { Vec3 } from "../../contracts/track";
import type { BuildTrack, GarageBayMesh, SceneryCore, SplineSample } from "./core";

const CONCRETE: RVec3 = [0.70, 0.70, 0.68], PLATFORM: RVec3 = [0.62, 0.62, 0.60];
const WALL: RVec3 = [0.82, 0.82, 0.84], WALL_TOP: RVec3 = [0.46, 0.47, 0.50];
const BARRIER: RVec3 = [0.86, 0.86, 0.88], GLASS: RVec3 = [0.24, 0.34, 0.44];
const SHELL: RVec3 = [0.86, 0.87, 0.89], ROOF: RVec3 = [0.30, 0.32, 0.36], DARK: RVec3 = [0.16, 0.17, 0.19];
const POST: RVec3 = [0.22, 0.24, 0.28];

/** A team's entry in the garage row. f1-game js/track/core/pit.js:344-347 (a Teams.LIST row + arc position). */
export interface PitRowBox {
  readonly team: string;
  readonly col: RVec3;
  readonly col2: RVec3;
  readonly s: number;
  readonly k: number;
  readonly through?: number;
}

/** The garage row. pit.js:396. `placed` is written by the build (pits.js:778). */
export interface PitRow {
  readonly pitch: number;
  readonly boxLen: number;
  readonly first: number;
  readonly count: number;
  readonly boxes: readonly PitRowBox[];
  readonly s0: number;
  readonly s1: number;
  readonly tail: number;
  placed?: number[];
}

/** The pit model the build reads (`track.pit`). f1-game js/track/core/pit.js:388-398. */
export interface PitModel {
  readonly side: number;
  readonly bands: { readonly verge: number; readonly platform: number };
  readonly off: { readonly fastIn: number; readonly fastOut: number; readonly corrOut: number; readonly workOut: number };
  readonly painted?: boolean;
  readonly hasWall?: boolean;
  readonly hasBays?: boolean;
  /** pit.js:120-135; the colours are optional overrides. */
  readonly architecture?: {
    readonly roofProfile?: readonly (readonly number[])[];
    readonly roofColor?: RVec3;
    readonly fasciaColor?: RVec3;
    readonly soffitColor?: RVec3;
    readonly edgeColor?: RVec3;
  } | null;
  readonly sA: number;
  readonly sIn: number;
  readonly sOut: number;
  readonly sB: number;
  readonly lenM: number;
  readonly entryRoadM: number;
  readonly exitRoadM: number;
  readonly w: ArrayLike<number>;
  readonly v: ArrayLike<number>;
  readonly row: PitRow;
  readonly bay: { readonly w: number; readonly h: number; readonly depth: number; readonly doorW?: number; readonly doorH?: number };
}

/** A prop record (build-props.js:332-340), the fields the board clearance reads. */
export interface PitPropRecord {
  readonly kind: string;
  readonly x: number;
  readonly z: number;
  readonly w?: number;
  readonly d?: number;
}

/** The sign decal quads (`track.pitSigns`, pits.js:183). */
export interface PitSigns {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
  cells: { i: number; team: string }[];
  boards: { cell: number; k: number }[];
  panels: { cell: number; k: number; face: "lane" | "track" }[];
  crests: { cell: number; k: number }[];
  anchors: Vec3[];
  centre: Vec3 | null;
}

/** The entrance lamps' green aspect (`track.pitSignal`, pits.js:293). */
export interface PitSignal {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
  quads: { k: number; cell: number }[];
}

/** The built track as pits.js reads and writes it. */
export interface PitsTrack extends BuildTrack {
  readonly pit?: PitModel | null;
  readonly barL?: Float32Array;
  readonly barR?: Float32Array;
  readonly props?: { readonly list?: readonly PitPropRecord[] } | null;
  pitSigns?: PitSigns;
  pitSignal?: PitSignal;
}

/** A tagged vertex block (pits.js:164, :385-386); `from` is a staged buffer. */
export interface PitBlock {
  readonly base: number;
  readonly count: number;
  readonly id: string;
  readonly from?: PlainBuffer;
}

/** The props accumulator plus the block tags the audits read. */
export type PitsOut = SceneryBuffer & { __blocks?: PitBlock[] };

/** A plain-array staging buffer (pits.js:102). */
interface PlainBuffer {
  pos: number[];
  nrm: number[];
  col: number[];
  idx: number[];
  mat: number[];
  _mat: number;
}

/** `registerLamp` spec (build-props.js:1942). */
export interface PitLampSpec {
  readonly pos: Vec3;
  readonly k: number;
  readonly side: number;
  readonly kind: "signal" | "led";
  readonly radius: number;
  readonly aimAt: Vec3;
  readonly entry?: boolean;
}

/** The ctx build-props.js:2218-2219 passes. */
export interface PitsCtx {
  readonly track: PitsTrack | null | undefined;
  readonly out: PitsOut | null | undefined;
  /** TrackGeom.addBox, unguarded (build-props.js:13 `RAW.addBox`). */
  rawBox(o: SceneryBuffer, c: RVec3, sz: RVec3, col: RVec3, basis?: Basis): boolean;
  /** TrackGeom.emit (geom.js:163). */
  readonly rawEmit?: ((out: SceneryBuffer, verts: readonly RVec3[], col: RVec3, ref?: RVec3 | null) => boolean) | undefined;
  upOf(track: BuildTrack, k: number): Vec3;
  bankOffsetAt(track: BuildTrack, k: number, o: number): number;
  /** Scenery placement only: the arc factor that sizes roof slices (pits.js:620, :643). */
  readonly curvature?: ((s: number) => number) | undefined;
  readonly night?: boolean | undefined;
  readonly lensAlbedo?: ((kind: string) => RVec3) | undefined;
  readonly registerLamp?: ((spec: PitLampSpec) => unknown) | undefined;
}

/** The roof report foldedRoof() returns (pits.js:169). */
export interface PitRoofReport {
  readonly vertices: number;
  readonly triangles: number;
  readonly segments: number;
  readonly spanM: number;
}

/** What build() returns (pits.js:785-786). */
export interface PitsBuildResult {
  readonly bays: number;
  readonly wall: boolean;
  readonly lamps: number;
  readonly entryLamps?: number;
  readonly signs?: number;
  readonly boards?: number;
  readonly panels?: number;
  readonly crests?: number;
  readonly roof?: PitRoofReport;
}

/** A packed bay mesh (pits.js:33-34). A type alias so it stays assignable to `BakedMesh`. */
export type PackedBay = {
  readonly pos: ArrayLike<number>;
  readonly idx: ArrayLike<number>;
  readonly nrm?: ArrayLike<number> | null | undefined;
  readonly col?: ArrayLike<number> | null | undefined;
  readonly mat?: ArrayLike<number> | null | undefined;
};

// pits.js:18-26: one bay mesh per team, shared across circuits. BOUNDED.
const BAY_CACHE = new Map<string, PackedBay | null>(), BAY_CACHE_MAX = 48;
type NumArrayCtor = { from(a: ArrayLike<number>): ArrayLike<number> };
const narrow = <A extends ArrayLike<number> | null | undefined>(a: A, T: NumArrayCtor): ArrayLike<number> | A =>
  (a ? T.from(a) : a);
export function packBay(m: GarageBayMesh | null): PackedBay | null {
  if (!m || !m.pos || !m.idx || typeof Float32Array === "undefined") return m;
  let hi = 0, mx = 0;
  for (let i = 0; i < m.idx.length; i++) if (m.idx[i]! > hi) hi = m.idx[i]!;
  if (m.mat) for (let i = 0; i < m.mat.length; i++) if (m.mat[i]! > mx) mx = m.mat[i]!;
  return { pos: narrow(m.pos, Float64Array), nrm: narrow(m.nrm, Float64Array), col: narrow(m.col, Float32Array),
           mat: narrow(m.mat, mx < 256 ? Uint8Array : Uint16Array), idx: narrow(m.idx, hi < 65536 ? Uint16Array : Uint32Array) };
}
const lowTier = (core: SceneryCore) => !!core.glx && !!core.glx.mobileTier;
function bayMesh(rowEntry: PitRowBox, core: SceneryCore): PackedBay | null {
  const GarageScene = core.garage;
  if (!GarageScene || typeof GarageScene.buildStatic !== "function") return null;
  const key = rowEntry.team + "|" + rowEntry.col.join(",") + "|" + rowEntry.col2.join(",");
  let m = BAY_CACHE.get(key);
  if (!m) {
    // `props: "lite"`: the furniture that reads from the lane.
    m = packBay(GarageScene.buildStatic({ c1: rowEntry.col, c2: rowEntry.col2, accent: rowEntry.col2 }, { props: "lite" }));
    if (BAY_CACHE.size >= BAY_CACHE_MAX) BAY_CACHE.delete(BAY_CACHE.keys().next().value!);
    BAY_CACHE.set(key, m);
  }
  return m;
}

type V3 = Vec3;
interface FrameS {
  p: V3; r: V3; t: V3; u: V3; hw: number; basis: Basis;
}

export function build(ctx: PitsCtx, core: SceneryCore): PitsBuildResult {
  const { track, out, rawBox, rawEmit, upOf, bankOffsetAt } = ctx;
  const p = track && track.pit;
  if (!p || !out || !track) return { bays: 0, wall: false, lamps: 0 };
  const TrackGeom = core.geom, TrackSpline = core.spline, TrackPit = core.pit;
  const night = !!ctx.night;
  const lensCol: RVec3 = ctx.lensAlbedo ? ctx.lensAlbedo("led") : [0.96, 1.00, 1.05];
  const MAT = TrackGeom.MAT;
  const { n, total: L, px, py, pz, rx, ry, rz, tx, ty, tz, hw } = track;
  const ds = L / n, sd = p.side, o = p.off;
  const wrap = (v: number) => ((v % L) + L) % L;
  const kOf = (s: number) => ((Math.round(wrap(s) / ds) % n) + n) % n;
  // pits.js:62-68: a world point at node k, lateral `lat` (+right), height y
  // above the (banked) road plane there.
  const at = (k: number, lat: number, y: number): V3 => {
    const u = upOf(track, k);
    const by = bankOffsetAt(track, k, lat) + y;
    return [px[k]! + rx[k]! * lat + u[0] * by, py[k]! + ry[k]! * lat + u[1] * by, pz[k]! + rz[k]! * lat + u[2] * by];
  };
  const basisAt = (k: number): Basis => [[sd * rx[k]!, sd * ry[k]!, sd * rz[k]!], upOf(track, k), [tx[k]!, ty[k]!, tz[k]!]];
  // pits.js:70-73: the row at EXACT arc positions, not the nearest node.
  const _smp: SplineSample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
  const frameAtS = (s: number): FrameS => {
    TrackSpline.sample(track, wrap(s), _smp);
    const r = TrackGeom.norm(_smp.r), t = TrackGeom.norm(_smp.t);
    const u = TrackGeom.norm(TrackGeom.cross(r, t));
    return { p: [_smp.p[0], _smp.p[1], _smp.p[2]], r, t, u, hw: _smp.hw,
             basis: [[sd * r[0], sd * r[1], sd * r[2]], u, t] };
  };
  const atF = (f: FrameS, lat: number, y: number, k: number): V3 => {
    const by = bankOffsetAt(track, k, lat) + y;
    return [f.p[0] + f.r[0] * lat + f.u[0] * by, f.p[1] + f.r[1] * lat + f.u[1] * by, f.p[2] + f.r[2] * lat + f.u[2] * by];
  };
  const pushMat = (count: number, m: number) => { if (out.mat) for (let i = 0; i < count; i++) out.mat.push(m); };

  // pits.js:88-170: a bounded folded crown on the EXISTING row.
  const foldedRoof = (): PitRoofReport | null => {
    const a = p.architecture, row = p.row, B = p.bay;
    if (!a || !row || !B || typeof rawEmit !== "function" ||
        !Array.isArray(row.boxes) || row.boxes.length < 1 || row.boxes.length > 24) return null;
    const span = wrap(row.s1 - row.s0), profile = a.roofProfile;
    if (!(span > 0) || !Number.isFinite(span) || !Array.isArray(profile)) return null;
    const stations = profile.map((knot) => knot[0]!);
    for (let i = 0; i <= row.boxes.length; i++) stations.push(i / row.boxes.length);
    stations.sort((x, y) => x - y);
    const us = stations.filter((u, i) => i === 0 || u - stations[i - 1]! > 1e-9);
    if (us.length < 2 || us.length > 25) return null;
    const stage: PlainBuffer = { pos: [], nrm: [], col: [], idx: [], mat: [], _mat: 0 };
    const roofCol = a.roofColor || ROOF, fasciaCol = a.fasciaColor || SHELL;
    const soffitCol = a.soffitColor || SHELL, edgeCol = a.edgeColor || roofCol;
    const baseY = B.h + 4.2 + 2 * TrackGeom.MIN_SEP, thickness = 0.25;
    const frames = us.map((u) => {
      const s = wrap(row.s0 + u * span), f = frameAtS(s), k = kOf(s);
      let j = 0;
      while (j + 2 < profile.length && u > profile[j + 1]![0]!) j++;
      const l = profile[j]!, r = profile[j + 1]!, blend = (u - l[0]!) / (r[0]! - l[0]!);
      const heights = [l[1]! + (r[1]! - l[1]!) * blend, l[2]! + (r[2]! - l[2]!) * blend] as const;
      const point = (q: number, y: number) => atF(f, sd * (f.hw + o.workOut + q), y, k);
      return { u: f.u, r: f.r, t: f.t,
               top: [point(0, heights[0]), point(B.depth, heights[1])] as const,
               low: [point(0, heights[0] - thickness), point(B.depth, heights[1] - thickness)] as const,
               base: [point(0, baseY), point(B.depth, baseY)] as const };
    });
    let valid = true;
    const centre = (points: readonly RVec3[]): V3 =>
      [0, 1, 2].map((axis) => points.reduce((sum, P) => sum + P[axis]!, 0) / points.length) as V3;
    const triangle = (points: readonly [RVec3, RVec3, RVec3], col: RVec3, material: number, outward: RVec3) => {
      if (!valid) return;
      if (!points.every((P) => P.every(Number.isFinite))) { valid = false; return; }
      const ab = points[1].map((v, i) => v - points[0][i]!) as unknown as V3;
      const ac = points[2].map((v, i) => v - points[0][i]!) as unknown as V3;
      if (Math.hypot(...TrackGeom.cross(ab, ac)) < 1e-8) { valid = false; return; }
      // A warped panel's volume centroid can be ABOVE one of its top
      // triangles. Orient each triangle against its intended exterior.
      const ref = centre(points).map((v, i) => v - outward[i]!) as V3;
      stage._mat = material;
      if (rawEmit(stage, points, col, ref) === false) valid = false;
    };
    const quad = (points: readonly [RVec3, RVec3, RVec3, RVec3], col: RVec3, material: number, outward: RVec3) => {
      // Changing cross-slopes or the sampled road can warp a quad. Each
      // triangle gets its own geometric normal and outward winding.
      triangle([points[0], points[1], points[2]], col, material, outward);
      triangle([points[0], points[2], points[3]], col, material, outward);
    };
    for (let i = 0; i + 1 < frames.length; i++) {
      const l = frames[i]!, r = frames[i + 1]!;
      const up = TrackGeom.norm(l.u.map((v, axis) => v + r.u[axis]!) as V3);
      const across = TrackGeom.norm(l.r.map((v, axis) => v + r.r[axis]!) as V3);
      quad([l.top[0], l.top[1], r.top[1], r.top[0]], roofCol, MAT.ROOF, up);
      quad([l.base[0], r.base[0], r.base[1], l.base[1]], soffitCol, MAT.METAL, up.map((v) => -v) as V3);
      for (const side of [0, 1] as const) {
        const outward = across.map((v) => v * sd * (side === 0 ? -1 : 1)) as V3;
        quad([l.top[side], r.top[side], r.low[side], l.low[side]], edgeCol, MAT.METAL, outward);
        quad([l.low[side], r.low[side], r.base[side], l.base[side]], fasciaCol, MAT.METAL, outward);
      }
    }
    for (const i of [0, frames.length - 1]) {
      const f = frames[i]!, outward = f.t.map((v) => v * (i === 0 ? -1 : 1)) as V3;
      quad([f.top[0], f.top[1], f.low[1], f.low[0]], edgeCol, MAT.METAL, outward);
      quad([f.low[0], f.low[1], f.base[1], f.base[0]], fasciaCol, MAT.METAL, outward);
    }
    const vertices = stage.pos.length / 3, triangles = stage.idx.length / 3;
    if (!valid || vertices > 1400 || triangles > 500 ||
        stage.nrm.length !== stage.pos.length || stage.col.length !== stage.pos.length ||
        stage.mat.length !== vertices ||
        ![stage.pos, stage.nrm, stage.col].every((values) => Array.from(values).every(Number.isFinite)) ||
        !Array.from(stage.idx).every((index) => Number.isInteger(index) && index >= 0 && index < vertices)) return null;
    // pits.js:161-162: same staged-buffer remap as TrackModels' private
    // appendBuffer (VM primitive captures refer to stage until mapped).
    const base = out.pos.length / 3;
    (out.__blocks || (out.__blocks = [])).push({ base, from: stage, count: vertices, id: "pit-architecture-roof" });
    for (const key of ["pos", "nrm", "col", "mat"] as const) {
      const dst = out[key];
      if (dst) for (const value of stage[key]) dst.push(value);
    }
    for (const index of stage.idx) out.idx.push(base + index);
    return { vertices, triangles, segments: us.length - 1, spanM: span };
  };

  // ── 1. The platform, the wall and the lane-side barrier (pits.js:172-213) ──
  // The SIGNS: twelve fascia cells on the lintels (§3) and the BOARDS (cells
  // 12 and 13 on posts). Corners [BL, BR, TR, TL], V flipped for FLIP_Y.
  const S = TrackPit.SIGN;
  const signs: PitSigns = { pos: [], nrm: [], uv: [], idx: [], cells: [], boards: [], panels: [], crests: [], anchors: [], centre: null };
  // Deferred until after the fascias (§3), so quad i is fascia i for the
  // twelve and the boards follow: the painter and the tests index them so.
  const boardsWanted: [number, number, number, number][] = [];
  const boardAt = (k: number, lat: number, y: number, cell: number) => { if (S) boardsWanted.push([k, lat, y, cell]); };
  const emitBoard = (k: number, lat: number, y: number, cell: number) => {
    const c = at(k, lat, y), r: V3 = [rx[k]!, ry[k]!, rz[k]!], u = upOf(track, k), t: V3 = [tx[k]!, ty[k]!, tz[k]!];
    const hw2 = S.boardW / 2, hh = S.boardH / 2;
    const P = (sx: number, sy: number): V3 => [c[0] + r[0] * sx * hw2 + u[0] * sy * hh, c[1] + r[1] * sx * hw2 + u[1] * sy * hh, c[2] + r[2] * sx * hw2 + u[2] * sy * hh];
    const corners = [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)] as const;
    const cx = (cell % S.cols) * S.cellW, cy = Math.floor(cell / S.cols) * S.cellH;
    const uL = cx / S.w, uR = (cx + S.cellW) / S.w, vT = 1 - cy / S.h, vB = 1 - (cy + S.cellH) / S.h;
    const uvs = [[uL, vB], [uR, vB], [uR, vT], [uL, vT]] as const;
    const base = signs.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      const cr = corners[i as 0 | 1 | 2 | 3], uv = uvs[i as 0 | 1 | 2 | 3];
      signs.pos.push(cr[0], cr[1], cr[2]);
      signs.nrm.push(-t[0], -t[1], -t[2]);
      signs.uv.push(uv[0], uv[1]);
    }
    signs.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    signs.boards.push({ cell, k });
    signs.anchors.push(c);
    const bs = basisAt(k);
    rawBox(out, [c[0] + t[0] * 0.05, c[1] + t[1] * 0.05, c[2] + t[2] * 0.05], [S.boardW + 0.06, S.boardH + 0.06, 0.06], DARK, bs);
    const postH = y - hh;
    rawBox(out, at(k, lat, postH / 2), [0.07, postH, 0.07], POST, bs);
  };
  // pits.js:214-257: a team's crest PANEL on the pit wall opposite its bay,
  // read from BOTH sides. After the boards in the quad order.
  const panelsWanted: [FrameS, number, number][] = [];
  const panelAt = (f: FrameS, k: number, cell: number) => { if (S) panelsWanted.push([f, k, cell]); };
  const PANEL_SCALE = 0.46, WALL_TOP_Y = 1.42;
  const emitPanel = (f: FrameS, k: number, cell: number) => {
    const pw = S.quadW * PANEL_SCALE, ph = S.quadH * PANEL_SCALE;
    const wallLat = sd * (f.hw + p.bands.verge + 0.125);
    const cx = (cell % S.cols) * S.cellW, cy = Math.floor(cell / S.cols) * S.cellH;
    const uL = cx / S.w, uR = (cx + S.cellW) / S.w, vT = 1 - cy / S.h, vB = 1 - (cy + S.cellH) / S.h;
    const uvs = [[uL, vB], [uR, vB], [uR, vT], [uL, vT]] as const;
    for (const face of [1, -1]) {                       // +1 the lane face, -1 the track face
      const c = atF(f, wallLat - sd * (face > 0 ? 0 : 0.08), WALL_TOP_Y + 0.03 + ph / 2, k);
      const right: V3 = [face * sd * f.t[0], face * sd * f.t[1], face * sd * f.t[2]], up = f.u;
      const nrm: V3 = [face * sd * f.r[0], face * sd * f.r[1], face * sd * f.r[2]];
      const P = (sx: number, sy: number): V3 => [c[0] + right[0] * sx * pw / 2 + up[0] * sy * ph / 2,
                                                 c[1] + right[1] * sx * pw / 2 + up[1] * sy * ph / 2,
                                                 c[2] + right[2] * sx * pw / 2 + up[2] * sy * ph / 2];
      const corners = [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)] as const;
      const base = signs.pos.length / 3;
      for (let i = 0; i < 4; i++) {
        const cr = corners[i as 0 | 1 | 2 | 3], uv = uvs[i as 0 | 1 | 2 | 3];
        signs.pos.push(cr[0], cr[1], cr[2]);
        signs.nrm.push(nrm[0], nrm[1], nrm[2]);
        signs.uv.push(uv[0], uv[1]);
      }
      signs.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      signs.panels.push({ cell, k, face: face > 0 ? "lane" : "track" });
    }
    // pits.js:249-254: the plate, grounded THROUGH the wall.
    const top = WALL_TOP_Y + 0.06 + ph;
    rawBox(out, atF(f, wallLat - sd * 0.04, top / 2, k), [0.06, top, pw + 0.06], DARK, f.basis);
  };
  // pits.js:258-286: the team's CREST plaque on the door's approach-side pier.
  const crestsWanted: [FrameS, number, number, number][] = [];
  const crestAt = (f: FrameS, k: number, i: number, along: number) => { if (S && S.crests && i < S.crests) crestsWanted.push([f, k, i, along]); };
  const emitCrest = (f: FrameS, k: number, i: number, along: number) => {
    const cw = S.crestW, h = f.hw;
    const lat = sd * (h + p.off.workOut - 0.13 - 0.125 - 0.01);   // the pier's lane face, a centimetre proud
    const c0 = atF(f, lat, S.crestY0 + cw / 2, k);
    const c: V3 = [c0[0] + f.t[0] * along, c0[1] + f.t[1] * along, c0[2] + f.t[2] * along];
    const right: V3 = [-sd * f.t[0], -sd * f.t[1], -sd * f.t[2]], up = f.u, nrm: V3 = [-sd * f.r[0], -sd * f.r[1], -sd * f.r[2]];
    const P = (sx: number, sy: number): V3 => [c[0] + right[0] * sx * cw / 2 + up[0] * sy * cw / 2,
                                               c[1] + right[1] * sx * cw / 2 + up[1] * sy * cw / 2,
                                               c[2] + right[2] * sx * cw / 2 + up[2] * sy * cw / 2];
    const corners = [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)] as const;
    const cx = (i % S.crestCols) * S.crestPx, cy = S.crestY + Math.floor(i / S.crestCols) * S.crestPx;
    const uL = cx / S.w, uR = (cx + S.crestPx) / S.w, vT = 1 - cy / S.h, vB = 1 - (cy + S.crestPx) / S.h;
    const uvs = [[uL, vB], [uR, vB], [uR, vT], [uL, vT]] as const;
    const base = signs.pos.length / 3;
    for (let q = 0; q < 4; q++) {
      const cr = corners[q as 0 | 1 | 2 | 3], uv = uvs[q as 0 | 1 | 2 | 3];
      signs.pos.push(cr[0], cr[1], cr[2]);
      signs.nrm.push(nrm[0], nrm[1], nrm[2]);
      signs.uv.push(uv[0], uv[1]);
    }
    signs.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    signs.crests.push({ cell: i, k });
  };

  // pits.js:288-312: the entrance lamps' GREEN aspect, in its OWN buffer
  // (track.pitSignal) so the painter draws it only while the lane is open.
  const signal: PitSignal = { pos: [], nrm: [], uv: [], idx: [], quads: [] };
  let entryLamps = 0;
  const signalAt = (k: number, face: RVec3, bs: Basis) => {
    if (!S || !S.signals) return;
    const w = S.signalW / 2, right = bs[0], up = bs[1], t = bs[2];
    const c: V3 = [face[0] - t[0] * 0.07, face[1] - t[1] * 0.07, face[2] - t[2] * 0.07];   // the aspect is 0.12 deep: its −t face + 1 cm
    const P = (sx: number, sy: number): V3 => [c[0] + right[0] * sx * w + up[0] * sy * w, c[1] + right[1] * sx * w + up[1] * sy * w, c[2] + right[2] * sx * w + up[2] * sy * w];
    const corners = [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)] as const;
    const cx = 0, cy = S.signalY;                                          // cell 0: GREEN (cell 1, RED, is the painted face)
    const uL = cx / S.w, uR = (cx + S.signalPx) / S.w, vT = 1 - cy / S.h, vB = 1 - (cy + S.signalPx) / S.h;
    const uvs = [[uL, vB], [uR, vB], [uR, vT], [uL, vT]] as const;
    const base = signal.pos.length / 3;
    for (let q = 0; q < 4; q++) {
      const cr = corners[q as 0 | 1 | 2 | 3], uv = uvs[q as 0 | 1 | 2 | 3];
      signal.pos.push(cr[0], cr[1], cr[2]);
      signal.nrm.push(-t[0], -t[1], -t[2]);
      signal.uv.push(uv[0], uv[1]);
    }
    signal.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    signal.quads.push({ k, cell: 0 });
  };

  let wallBuilt = false;
  if (p.hasWall) {
    const b = p.bands;
    // pits.js:317-334: nodes from `s0` forward while `keep(k)` holds, over at
    // most `maxM`; `seekM` lets the run SEARCH for its start.
    const nodesFrom = (s0: number, keep: (k: number) => boolean, maxM: number, seekM?: number): number[] => {
      let s0b = s0;
      for (let d = 0; d < (seekM || 0) && !keep(kOf(s0b)); d += ds) s0b = wrap(s0b + ds);
      const list: number[] = [];
      for (let s = s0b; ; s = wrap(s + ds)) {
        const k = kOf(s);
        if (!keep(k)) break;
        if (!(list.length && list[list.length - 1] === k)) list.push(k);
        if (wrap(s - s0b) >= maxM || list.length > n) break;
      }
      return list;
    };
    // pits.js:335-340: seek forward to the wall's own first node.
    const ks = nodesFrom(p.sIn, (k) => p.v[k]! >= 0.98, p.lenM, 24);
    // `shift(k)`, when given, slides the whole profile laterally per node.
    const sweep = (ks: readonly number[], profile: readonly (readonly [number, number])[], col: RVec3, mat: number,
      shift: ((k: number) => number) | null, blockId?: string) => {
      if (ks.length < 2) return;
      const vert0 = out.pos.length / 3;
      const m = profile.length;
      const latOf = (k: number, q: readonly [number, number]) => sd * (hw[k]! + q[0] + (shift ? shift(k) : 0));
      for (let i = 0; i + 1 < ks.length; i++) {
        const k = ks[i]!, k2 = ks[i + 1]!;
        for (let e = 0; e < m; e++) {
          const a = profile[e]!, c = profile[(e + 1) % m]!;
          const A = at(k, latOf(k, a), a[1]), B = at(k, latOf(k, c), c[1]);
          const C = at(k2, latOf(k2, a), a[1]), D = at(k2, latOf(k2, c), c[1]);
          // Outward normal of this face of the extrusion: (along) x (around),
          // flipped by the side so the strip faces out on either side.
          const ax = C[0] - A[0], ay = C[1] - A[1], az = C[2] - A[2];
          const bx = B[0] - A[0], by = B[1] - A[1], bz = B[2] - A[2];
          let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
          const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
          if (sd < 0) { nx = -nx; ny = -ny; nz = -nz; }
          const base = out.pos.length / 3;
          for (const P of [A, B, C, D]) { out.pos.push(P[0], P[1], P[2]); out.nrm.push(nx, ny, nz); out.col.push(col[0], col[1], col[2]); }
          pushMat(4, mat);
          if (sd > 0) out.idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
          else out.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
      }
      // End caps, so the strip is closed where it starts and stops.
      for (const [k, flip] of [[ks[0]!, sd < 0], [ks[ks.length - 1]!, sd > 0]] as const) {
        const base = out.pos.length / 3;
        const u = upOf(track, k), t: V3 = [tx[k]!, ty[k]!, tz[k]!];
        const nrm: V3 = flip ? t : [-t[0], -t[1], -t[2]];
        for (const q of profile) { const P = at(k, latOf(k, q), q[1]); out.pos.push(P[0], P[1], P[2]); out.nrm.push(nrm[0], nrm[1], nrm[2]); out.col.push(col[0], col[1], col[2]); }
        pushMat(m, mat);
        for (let e = 1; e + 1 < m; e++) {
          if (flip) out.idx.push(base, base + e + 1, base + e); else out.idx.push(base, base + e, base + e + 1);
        }
        void u;
      }
      // pits.js:380-382: S4: tag the strip so clip/coplanar/float can name it.
      const count = out.pos.length / 3 - vert0;
      if (count > 0) {
        (out.__blocks || (out.__blocks = []))
          .push({ base: vert0, count, id: blockId || "pit-sweep" });
      }
    };
    const v0 = b.verge, v1 = b.verge + b.platform;
    // Platform: 35 cm above the lane (FIM §9.2).
    sweep(ks, [[v0, 0], [v1, 0], [v1, 0.35], [v0, 0.35]], PLATFORM, MAT.CONCRETE, null, "pit-platform");
    // The pit wall on the TRACK side of the platform: 25 cm thick, 1 m high.
    sweep(ks, [[v0, 0.35], [v0 + 0.25, 0.35], [v0 + 0.25, 1.35], [v0, 1.35]], WALL, MAT.CONCRETE, null, "pit-wall");
    sweep(ks, [[v0 - 0.02, 1.35], [v0 + 0.27, 1.35], [v0 + 0.27, 1.42], [v0 - 0.02, 1.42]], WALL_TOP, MAT.METAL, null, "pit-wall-cap");
    // The 65 cm barrier between the platform and the lane.
    sweep(ks, [[v1 - 0.10, 0.35], [v1, 0.35], [v1, 1.0], [v1 - 0.10, 1.0]], BARRIER, MAT.METAL, null, "pit-lane-barrier");
    wallBuilt = ks.length >= 2;

    // ── 1b. THE EXIT WALL (pits.js:399-410) ──
    const EXW = TrackPit.EXIT_WALL_W;
    const kx = nodesFrom(p.sOut, (k) => p.w[k]! >= EXW, p.exitRoadM);
    const slide = (k: number) => v0 * p.v[k]!;
    sweep(kx, [[-0.05, 0], [0.30, 0], [0.30, 1.0], [-0.05, 1.0]], WALL, MAT.CONCRETE, slide, "pit-exit-wall");
    sweep(kx, [[-0.07, 1.0], [0.32, 1.0], [0.32, 1.07], [-0.07, 1.07]], WALL_TOP, MAT.METAL, slide, "pit-exit-wall-cap");

    // ── 1d. THE OUTER WALL (pits.js:412-437): at the LANE's own outer edge. ──
    const outerShift = (k: number) => (TrackPit.outerAt
      ? TrackPit.outerAt(p, k) : o.workOut * p.w[k]!);
    const outerWall = (ks2: readonly number[]) => {
      sweep(ks2, [[0.02, 0], [0.32, 0], [0.32, 1.0], [0.02, 1.0]], WALL, MAT.CONCRETE, outerShift, "pit-outer-wall");
      sweep(ks2, [[0.0, 1.0], [0.34, 1.0], [0.34, 1.07], [0.0, 1.07]], WALL_TOP, MAT.METAL, outerShift, "pit-outer-wall-cap");
    };
    const hasRibbon = (k: number) => p.w[k]! > 0.02;
    if (p.hasBays && p.row) {
      const gap0 = wrap(p.row.s0 - 0.5), gap1 = wrap(p.row.s1 + p.row.tail + 0.5);   // …to race control's far face
      outerWall(nodesFrom(wrap(p.sA + 6), hasRibbon, Math.max(0, wrap(gap0 - p.sA) - 6)));
      outerWall(nodesFrom(gap1, hasRibbon, wrap(p.sB - gap1)));
    } else {
      outerWall(nodesFrom(wrap(p.sA + 6), hasRibbon, wrap(p.sB - p.sA) - 6));
    }

    // ── 1c. CONES down the entry road's inner edge (pits.js:439-451) ──
    const CONE: RVec3 = [0.95, 0.42, 0.08], CBAND: RVec3 = [0.97, 0.97, 0.97];
    for (let d = 6; d < p.entryRoadM; d += 8) {
      const k = kOf(p.sA + d);
      if (p.v[k]! > 0.5 || !(p.w[k]! > 0.05)) continue;
      const bs = basisAt(k), lat = sd * (hw[k]! + 0.45);
      rawBox(out, at(k, lat, 0.03), [0.36, 0.06, 0.36], DARK, bs);
      rawBox(out, at(k, lat, 0.33), [0.20, 0.60, 0.20], CONE, bs);
      rawBox(out, at(k, lat, 0.46), [0.22, 0.08, 0.22], CBAND, bs);
    }

    // ── 2. Boards on the approach and at the entry line, lights at the exit
    // (pits.js:453-501).
    const kIn = kOf(p.sIn), kOut = kOf(p.sOut);
    if (S && S.boards) {
      // pits.js:460-475: on the verge, only where the barrier leaves room and
      // no single-object prop of the circuit's own scenery already stands.
      const bar = sd > 0 ? track.barR : track.barL;
      const SKIP: { readonly [kind: string]: number } = { structure: 1, building: 1, backdrop: 1, place: 1, grandstand: 1,
                     mountain: 1, ridge: 1, peak: 1, plane: 1 };   // …and the landforms, whose boxes are the horizon
      const props = (track.props && track.props.list) || [];
      const clear = (k: number, off: number) => {
        if (bar && bar[k]! < off + S.boardW / 2 + 0.1) return false;   // a decimetre to spare: the board rides above barrier height
        const c = at(k, sd * off, 0), reach = S.boardW / 2 + 0.4;
        for (const r of props) {
          if (SKIP[r.kind] || !Number.isFinite(r.x)) continue;
          const rr = Math.max(r.w || 0, r.d || 0) / 2 + reach;
          const dx = r.x - c[0], dz = r.z - c[2];
          if (dx * dx + dz * dz < rr * rr) return false;
        }
        return true;
      };
      for (const back of S.boardM) {
        for (let extra = 0; extra <= 24; extra += 4) {
          const k = kOf(p.sA - back - extra);
          const off = hw[k]! + 0.3 + S.boardW / 2;
          if (!clear(k, off)) continue;
          boardAt(k, sd * off, S.boardY, S.cells);
          break;
        }
      }
      if (p.v[kIn]! >= 0.98) boardAt(kIn, sd * (hw[kIn]! + v1 - 0.6), S.boardY, S.cells + 1);
    }
    // pits.js:502-525: the ENTRANCE LAMPS on the wall's own first node.
    let kGate = -1;
    if (!p.painted && p.hasWall) {
      for (let d = 0; d <= 24 && kGate < 0; d += 4) {
        const kk = kOf(p.sIn + d);
        if (p.v[kk]! >= 0.98) kGate = kk;
      }
    }
    if (kGate >= 0) {
      const laneCentreAt = (kk: number) => {
        const fIn = hw[kk]! + o.fastIn * p.v[kk]!, fOut = hw[kk]! + o.fastOut * p.w[kk]!;
        return sd * (fIn + Math.max(fIn, fOut)) / 2;
      };
      // The aim is the lane's own middle a car's length in.
      const kAim = kOf(p.sIn + 10);
      const aim = at(kAim, laneCentreAt(kAim), 0);
      // pits.js:542-551: each post stands on the LANE FLOOR.
      const HEAD_Y = 2.55;                       // above the lane floor, the same on both
      const posts = [{ lat: v0 + 0.55, toLane: 1 },        // the platform wall's nose, track side
                     { lat: o.workOut - 0.45, toLane: -1 }];  // the outer wall opposite
      for (const q of posts) {
        const c = at(kGate, sd * (hw[kGate]! + q.lat), 0), bs = basisAt(kGate);
        const rise = HEAD_Y;
        rawBox(out, [c[0], c[1] + rise / 2, c[2]], [0.14, rise, 0.14], POST, bs);
        rawBox(out, [c[0], c[1] + rise, c[2]], [0.5, 0.9, 0.34], DARK, bs);
        const red: RVec3 = night ? [1.45, 0.22, 0.16] : [0.95, 0.14, 0.10];
        const face: V3 = [c[0] - bs[2][0] * 0.2, c[1] + rise - bs[2][1] * 0.2, c[2] - bs[2][2] * 0.2];
        rawBox(out, face, [S ? S.signalW : 0.34, S ? S.signalW : 0.34, 0.12], red, bs);
        const lf: V3 = [c[0] + bs[0][0] * q.toLane * 0.28, c[1] + rise, c[2] + bs[0][2] * q.toLane * 0.28];
        rawBox(out, lf, [0.12, 0.22, 0.22], red, bs);
        // pits.js:565-568: the radius is the throw it needs and no more.
        const radius = Math.ceil(Math.hypot(face[0] - aim[0], face[1] - aim[1], face[2] - aim[2])) + 1;
        if (typeof ctx.registerLamp === "function" &&
            ctx.registerLamp({ pos: face, k: kGate, side: sd, kind: "signal", radius, aimAt: aim, entry: true })) entryLamps++;
        signalAt(kGate, face, bs);
      }
    }
    if (p.v[kOut]! >= 0.98) {
      // pits.js:576-580: the post is footed on the LANE FLOOR.
      const rise = 3.95;
      const c = at(kOut, sd * (hw[kOut]! + v1 - 0.5), 0);
      const bs = basisAt(kOut);
      rawBox(out, [c[0], c[1] + rise / 2, c[2]], [0.16, rise, 0.16], POST, bs);
      rawBox(out, [c[0], c[1] + rise + 0.15, c[2]], [0.5, 0.9, 0.34], DARK, bs);
      // pits.js:586-589: the exit signal.
      const go: RVec3 = night ? [0.30, 1.40, 0.45] : [0.2, 0.9, 0.3], stop: RVec3 = night ? [0.30, 0.06, 0.04] : [0.9, 0.15, 0.1];
      rawBox(out, [c[0] + bs[0][0] * 0.2, c[1] + rise + 0.35, c[2] + bs[0][2] * 0.2], [0.12, 0.28, 0.28], go, bs);
      rawBox(out, [c[0] + bs[0][0] * 0.2, c[1] + rise - 0.05, c[2] + bs[0][2] * 0.2], [0.12, 0.28, 0.28], stop, bs);
    }
  }

  // ── 3. The garages: the setup screen's bay, once per team, on the row
  // (pits.js:596-692).
  let bays = 0, lamps = 0, roof: PitRoofReport | null = null;
  const placed: number[] = [];
  if (p.hasBays) {
    const B = p.bay, doorW = B.doorW || 5.4, doorH = B.doorH || 4.8;
    const garage = o.workOut;                 // the garage line, beyond the road edge
    const boxes = p.row.boxes, count = boxes.length;
    // pits.js:608-615: each bay's slice SHORT of the pitch (10 cm seam).
    const seg = p.row.pitch - 0.10;
    // pits.js:616-620: …scaled by the arc's own factor at its lateral.
    const segAt = (kap: number, lat: number) => seg * Math.max(0.5, 1 + kap * lat);
    for (let i = 0; i < count; i++) {
      const box = boxes[i]!, k = box.k;
      const f = frameAtS(box.s), bs = f.basis, h = f.hw;
      const mesh = bayMesh(box, core);
      // Bay local +Z is the door end; it must point at the TRACK.
      const rotY = Math.atan2(-sd * f.r[0], -sd * f.r[2]);
      const c = atF(f, sd * (h + garage + B.depth / 2), 0.02, k);
      if (mesh) {
        if (TrackGeom.addMesh(out, mesh, { x: c[0], y: c[1], z: c[2], rotY })) bays++;
      }
      placed.push(box.s);
      // pits.js:633-641: the skin; every other slice sits MIN_SEP higher, and
      // the vertical faces get the same step sideways.
      const lift = (i & 1) ? TrackGeom.MIN_SEP : 0, bump = sd * lift;
      const kap = ctx.curvature ? ctx.curvature(box.s) : 0;   // +k = left turn; lateral +x right
      // pits.js:644-646: the jambs' back face stands MIN_SEP proud of the bay.
      const front = sd * (h + garage - 0.125 - TrackGeom.MIN_SEP) - bump;
      const jamb = (B.w - doorW) / 2;
      for (const side of [-1, 1]) {
        const cj = atF(f, front, B.h / 2, k);
        rawBox(out, [cj[0] + bs[2][0] * side * (B.w / 2 - jamb / 2), cj[1] + bs[2][1] * side * (B.w / 2 - jamb / 2), cj[2] + bs[2][2] * side * (B.w / 2 - jamb / 2)],
               [0.25, B.h, jamb], SHELL, bs);
      }
      const lintH = B.h - doorH + 0.6;
      const cl = atF(f, sd * (h + garage - 0.125 - 2 * TrackGeom.MIN_SEP) - bump, doorH + lintH / 2, k);   // one MIN_SEP proud of the jambs
      rawBox(out, cl, [0.25, lintH, doorW], box.col, bs);
      if (S && i < S.cells) {
        const right: V3 = [-sd * f.t[0], -sd * f.t[1], -sd * f.t[2]];   // the viewer's right, facing the bay from the lane
        const lat = sd * (h + garage - S.proud) - bump, hw2 = S.quadW / 2;
        const lo = atF(f, lat, S.y0, k), hi = atF(f, lat, S.y0 + S.quadH, k);
        const cx = (i % S.cols) * S.cellW, cy = Math.floor(i / S.cols) * S.cellH;
        const uL = cx / S.w, uR = (cx + S.cellW) / S.w, vT = 1 - cy / S.h, vB = 1 - (cy + S.cellH) / S.h;
        const corners = [[lo, -1], [lo, 1], [hi, 1], [hi, -1]] as const, uvs = [[uL, vB], [uR, vB], [uR, vT], [uL, vT]] as const;
        const base = signs.pos.length / 3;
        for (let c2 = 0; c2 < 4; c2++) {
          const cr = corners[c2 as 0 | 1 | 2 | 3], uv = uvs[c2 as 0 | 1 | 2 | 3];
          const P = cr[0], s2 = cr[1] * hw2;
          signs.pos.push(P[0] + right[0] * s2, P[1] + right[1] * s2, P[2] + right[2] * s2);
          signs.nrm.push(-bs[0][0], -bs[0][1], -bs[0][2]);
          signs.uv.push(uv[0], uv[1]);
        }
        signs.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        signs.cells.push({ i, team: box.team });
        if (i === (count >> 1)) signs.centre = atF(f, sd * (h + garage), 3, k);
      }
      const cr = atF(f, sd * (h + garage + B.depth / 2), B.h + 0.05 + 0.175 + lift, k);
      rawBox(out, cr, [B.depth + 0.5, 0.35, segAt(kap, sd * (h + garage + B.depth / 2))], ROOF, bs);
      // pits.js:677-679: 2 cm under the roof line.
      const cb = atF(f, sd * (h + garage + B.depth + 0.2) + bump, (B.h + 0.38) / 2 + lift, k);
      rawBox(out, cb, [0.3, B.h + 0.38, segAt(kap, sd * (h + garage + B.depth + 0.2))], SHELL, bs);
      const ch = atF(f, sd * (h + garage + B.depth / 2 + 0.6), B.h + 0.4 + 1.7 + lift, k);
      rawBox(out, ch, [B.depth - 1.0, 3.4, segAt(kap, sd * (h + garage + B.depth / 2 + 0.6))], GLASS, bs);
      const ct = atF(f, sd * (h + garage + B.depth / 2 + 0.6), B.h + 0.4 + 3.4 + 0.2 + lift, k);
      rawBox(out, ct, [B.depth - 0.4, 0.4, segAt(kap, sd * (h + garage + B.depth / 2 + 0.6))], ROOF, bs);
      if (i === 0 || i === count - 1) {
        const ce = atF(f, sd * (h + garage + B.depth / 2), (B.h + 0.38) / 2, k);   // 2 cm under the roof line
        const along = (i === 0 ? -1 : 1) * (seg / 2 + 0.15);
        rawBox(out, [ce[0] + bs[2][0] * along, ce[1] + bs[2][1] * along, ce[2] + bs[2][2] * along],
               [B.depth + 0.5, B.h + 0.38, 0.3], SHELL, bs);
      }
    }
    // ── 4. The canopy over the working lane, and its luminaires
    // (pits.js:693-758).
    for (let i = 0; i < count; i++) {
      const box = boxes[i]!, k = box.k;
      const f = frameAtS(box.s), bs = f.basis, h = f.hw;
      const lift = (i & 1) ? TrackGeom.MIN_SEP : 0, bump = sd * lift;
      const kap = ctx.curvature ? ctx.curvature(box.s) : 0;
      const canLat = sd * (h + garage - 1.45) - bump;
      rawBox(out, atF(f, canLat, B.h + 0.45 + lift, k), [2.6, 0.25, segAt(kap, canLat)], ROOF, bs);
      // pits.js:713-716: the TEAM'S LED STRIP under the canopy's front edge.
      const stripLat = sd * (h + garage - 2.70) - bump;
      const tc = box.col || [0.6, 0.6, 0.65];
      const led: RVec3 = night ? [tc[0] * 2.2 + 0.25, tc[1] * 2.2 + 0.25, tc[2] * 2.2 + 0.25] : [tc[0] * 1.15, tc[1] * 1.15, tc[2] * 1.15];
      rawBox(out, atF(f, stripLat, B.h + 0.45 - 0.125 - 0.05 + lift, k), [0.08, 0.06, segAt(kap, stripLat) - 0.5], led, bs);
      // pits.js:721-730: NEON at the box, and the strip's twin ON THE GROUND.
      rawBox(out, atF(f, sd * (h + garage - 0.16) - bump, 0.02 + lift, k), [0.08, 0.04, segAt(kap, stripLat) - 0.5], led, bs);
      const jamb2 = (B.w - doorW) / 2;
      const tubeLat = sd * (h + garage - 0.13 - 0.125 - 0.03) - bump;
      for (const side of [-1, 1]) {
        const ct = atF(f, tubeLat, 1.45, k), along = side * (doorW / 2 + 0.08);   // framing the door, on the piers' faces
        rawBox(out, [ct[0] + bs[2][0] * along, ct[1] + bs[2][1] * along, ct[2] + bs[2][2] * along], [0.04, 2.0, 0.05], led, bs);
      }
      // The crest plaque on the pier the driver reaches first (along -t).
      crestAt(f, k, i, -(B.w / 2 - jamb2 / 2));
      const lane0 = h + o.corrOut + 0.3, lane1 = h + o.workOut - 0.3;   // the painted box's own edges (TrackMesh.buildPitBoxes)
      const lon = p.row.boxLen / 2 + 0.9;
      const gc = atF(f, sd * (lane0 + lane1) / 2, 0.015, k);
      rawBox(out, [gc[0] + bs[2][0] * lon, gc[1] + bs[2][1] * lon, gc[2] + bs[2][2] * lon], [lane1 - lane0, 0.03, 0.08], led, bs);
      for (const e of [lane0 + 0.15, lane1 - 0.15]) {
        const sc = atF(f, sd * e, 0.015, k), l2 = lon - 0.64;
        rawBox(out, [sc[0] + bs[2][0] * l2, sc[1] + bs[2][1] * l2, sc[2] + bs[2][2] * l2], [0.08, 0.03, 1.2], led, bs);
      }
      if (p.hasWall && p.v[k]! >= 0.98) panelAt(f, k, i);
      if ((i & 1) === 0 && i + 1 < count && typeof ctx.registerLamp === "function") {
        const along = seg / 2;                                   // the party line with bay i + 1
        const cl0 = atF(f, sd * (h + garage - 1.7), B.h + 0.45 - 0.125 - 0.04, k);   // its top 2 cm inside the soffit
        const lens: V3 = [cl0[0] + bs[2][0] * along, cl0[1] + bs[2][1] * along, cl0[2] + bs[2][2] * along];
        rawBox(out, lens, [0.5, 0.12, 2.4], lensCol, bs);
        const wc = atF(f, sd * (h + (o.corrOut + o.workOut) / 2), 0, k);
        if (ctx.registerLamp({ pos: lens, k, side: sd, kind: "led", radius: 18,
                               aimAt: [wc[0] + bs[2][0] * along, wc[1] + bs[2][1] * along, wc[2] + bs[2][2] * along] })) lamps++;
      }
    }
    roof = foldedRoof();
    // pits.js:760-765: race control, stepped up at the exit end of the row,
    // offset along the LAST BAY's own tangent.
    const last = boxes[count - 1]!, sR = wrap(last.s + p.row.pitch / 2 + 9), kr = kOf(sR);
    if (p.w[kr]! > 0.98) {
      const f = frameAtS(last.s), bs = f.basis, h = f.hw, step = p.row.pitch / 2 + 9;
      const off = (lat: number, y: number): V3 => {
        const c = atF(f, sd * (h + garage + lat), y, last.k);
        return [c[0] + f.t[0] * step, c[1] + f.t[1] * step, c[2] + f.t[2] * step];
      };
      rawBox(out, off(7, 7), [12, 14, 12], SHELL, bs);
      rawBox(out, off(7 - 6.2, 11.5), [0.3, 3.0, 11], GLASS, bs);
      rawBox(out, off(7, 14.3), [13, 0.6, 13], ROOF, bs);
    }
  }
  if (p.row) p.row.placed = placed;
  for (const b of boardsWanted) emitBoard(b[0], b[1], b[2], b[3]);
  for (const q of panelsWanted) emitPanel(q[0], q[1], q[2]);
  for (const q of crestsWanted) emitCrest(q[0], q[1], q[2], q[3]);
  if (signs.cells.length || signs.boards.length) track.pitSigns = signs;
  if (signal.quads.length) track.pitSignal = signal;
  if (lowTier(core)) BAY_CACHE.clear();
  return { bays, wall: wallBuilt, lamps, entryLamps, signs: signs.cells.length, boards: signs.boards.length,
           panels: signs.panels.length, crests: signs.crests.length, ...(roof ? { roof } : {}) };
}

/** pits.js:789. */
export const bayCacheSize = (): number => BAY_CACHE.size;
