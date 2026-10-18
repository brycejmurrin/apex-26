/**
 * Build-time strip of prop triangles no camera can see (enclosed in an opaque
 * box, buried under terrain, down-facing on the ground), then compaction of the
 * vertices no kept triangle references.
 *
 * Port of f1-game js/track/core/hidden-faces.js:1-603 (`TrackHiddenFaces`).
 * The IIFE becomes an ES module; its frozen return object `{ strip, stripSteps,
 * compact }` becomes three named exports. The logic is token-for-token; the
 * only additions are type annotations, non-null assertions (`!`) the
 * `noUncheckedIndexedAccess` index reads need, and casts where f1-game reads a
 * column that may be a typed array, a plain array or a growable accumulator
 * (`_data`).
 *
 * f1-game's header comment (hidden-faces.js:2-26), kept:
 *
 * strip(geo, groundY) rewrites geo.idx WITHOUT the triangles that no camera can
 * ever see, and leaves pos/nrm/col/mat exactly as they were, so every audit that
 * reads a primitive's vertex range [s, e) sees the same data as before.
 *
 * Three classes, each CONSERVATIVE (a doubt keeps the triangle):
 *   enclosed  all 3 corners strictly (1 cm) inside another closed box — found
 *             in the sealed buffer by its addBox signature (24 verts, 6 quads,
 *             outward normals, winding agreeing with the normals). The
 *             encloser must be opaque and static: never GLASS, never the FLAG
 *             band (its vertices wave in the shader), never HDR-bright colour.
 *   buried    corners, centroid and edge midpoints all > 5 cm below the drawn
 *             terrain (groundY = terrainY: the max over REAL terrain triangles,
 *             null over a hole, and a null keeps the triangle).
 *   bottom    front face points down (n.y < -0.95) and the same five points sit
 *             no more than 10 cm above the terrain directly beneath them — the
 *             eye would have to be under the face to see it.
 * FLAG triangles are never stripped (their vertices move at draw time).
 *
 * compact(geo) is the SECOND, separate step: it drops every vertex no index
 * references any more (a stripped box's faces), order-preserving, and remaps
 * idx and the `__blocks` bookkeeping. It DOES move vertex ranges.
 */

/** A column as f1-game's `arr()` reads it: an array (plain or typed) or a growable accumulator. hidden-faces.js:53 */
export type HiddenFacesColumn = ArrayLike<number> | { readonly _data: ArrayLike<number>; readonly length: number };

/** A provenance block (models.js appendBuffer) that compact() shifts. hidden-faces.js:590-596 */
export interface GeomBlock {
  base: number;
  count: number;
  id?: string | null;
  /** The stage buffer the block came from; tracks.js:367 nulls it after compaction. */
  from?: unknown;
}

/**
 * The geometry strip() and compact() rewrite in place. strip() may replace
 * `idx` with a Uint32Array; compact() replaces each per-vertex column with one
 * of the same kind (plain array or the same typed-array class).
 */
export interface HiddenFacesGeo {
  pos?: HiddenFacesColumn | null | undefined;
  nrm?: HiddenFacesColumn | null | undefined;
  col?: HiddenFacesColumn | null | undefined;
  mat?: HiddenFacesColumn | null | undefined;
  idx?: HiddenFacesColumn | null | undefined;
  trk?: HiddenFacesColumn | null | undefined;
  uv?: HiddenFacesColumn | null | undefined;
  __blocks?: GeomBlock[] | undefined;
}

/** The terrain buffer terrainCeil reads. hidden-faces.js:162 */
export interface HiddenFacesTerrain {
  pos?: HiddenFacesColumn | null | undefined;
  idx?: HiddenFacesColumn | null | undefined;
}

/** strip()'s options. hidden-faces.js:503 */
export interface StripOpts {
  /** Exact drawn-terrain height under (x, z), null over a hole (Tracks.terrainY). */
  groundY?: ((x: number, z: number) => number | null | undefined) | null | undefined;
  terrain?: HiddenFacesTerrain | null | undefined;
}

/** hidden-faces.js:513 */
export interface StripStats {
  trisBefore: number;
  trisAfter: number;
  enclosed: number;
  buried: number;
  bottom: number;
  boxes: number;
  ms: number;
}

/** hidden-faces.js:557 */
export interface CompactStats {
  vertsBefore: number;
  vertsAfter: number;
  ms: number;
}

/** A writable numeric column (typed or plain array). */
type NumCol = { [i: number]: number; readonly length: number };

/** The CSR box grid buildGrid returns. hidden-faces.js:238-285 */
interface Grid {
  gx0: number;
  gz0: number;
  gnx: number;
  gnz: number;
  start: Int32Array;
  list: Int32Array;
  E: Float64Array;
  cell: number;
  next: Grid | null;
}

/** The terrain ceiling terrainCeil returns. hidden-faces.js:181 */
interface Ceil {
  top: Float64Array;
  mnx: number;
  mnz: number;
  nx: number;
  nz: number;
}

/** scanBoxes' result. hidden-faces.js:226 */
interface Scan {
  B: Float64Array;
  BB: Float64Array;
  BV: Int32Array;
  NB: number;
}

// Local scalar helpers, not Math.* (hidden-faces.js:30-32: the VM harness's
// host-context Math does not inline across contexts).
const abs = (x: number): number => (x < 0 ? -x : x);
const floor = (x: number): number => { const t = x | 0; return t > x ? t - 1 : t; };   // |x| < 2^31
const min = (a: number, b: number): number => (a < b ? a : b), max = (a: number, b: number): number => (a > b ? a : b);
const isFlag = (m: number): boolean => m >= MAT_FLAG - 0.5 && m < MAT_FLAG + 0.5;
// Same reason for these (hidden-faces.js:37-39).
const INF = 1 / 0, NAN = 0 / 0;
const IN_EPS = 0.01, MIN_HALF = 0.03, BURY = 0.05, BOTTOM = 0.10, BOTTOM_NY = -0.95;
const CELL = 8, TCELL = 8;
// A box whose XZ AABB covers more than BIG_CELLS fine cells goes to its own
// COARSE grid (CELL_BIG) instead of every 8 m cell it spans (hidden-faces.js:43-48).
const BIG_CELLS = 1024, CELL_BIG = 128;
const MAT_GLASS = 3, MAT_FLAG = 15;

const now = (): number => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
function arr(a: HiddenFacesColumn): ArrayLike<number>;
function arr(a: HiddenFacesColumn | null | undefined): ArrayLike<number> | null | undefined;
function arr(a: HiddenFacesColumn | null | undefined): ArrayLike<number> | null | undefined {
  return (a && (a as { _data?: ArrayLike<number> })._data) ? (a as { _data: ArrayLike<number> })._data : a as ArrayLike<number> | null | undefined;
}

// Scratch for boxAt: axes (3x3), half extents, per-corner axis signs, and
// each corner's projection on each axis (computed once, read twice).
const ax = new Float64Array(9), h = new Float64Array(3), sg = new Int8Array(72), D = new Float64Array(72);
const REC = new Float64Array(15);

// Is [v, v+24) an addBox? Fills REC = [cx,cy,cz, ax0(3), ax1(3), ax2(3), h0,h1,h2]
// and returns true. firstTri[v] is the first triangle whose FIRST index is v.
// hidden-faces.js:62
function boxAt(pos: ArrayLike<number>, nrm: ArrayLike<number>, col: ArrayLike<number> | null | undefined,
  mat: ArrayLike<number> | null | undefined, idx: ArrayLike<number>, firstTri: Int32Array, v: number): true | null {
  const o = v * 3;
  // cheap reject: face 0 and face 1 are four equal, mutually opposite normals
  if (nrm[o] !== nrm[o + 3] || nrm[o] !== nrm[o + 9] || nrm[o + 1] !== nrm[o + 7]) return null;
  if (abs(nrm[o]! + nrm[o + 12]!) > 1e-6 || abs(nrm[o + 1]! + nrm[o + 13]!) > 1e-6 ||
      abs(nrm[o + 2]! + nrm[o + 14]!) > 1e-6) return null;
  // Compare the ROUNDED id: a FOLIAGE box carries a per-vertex wind-sway weight
  // in its id's fraction (geom.js swayMatAt) (hidden-faces.js:68-72).
  const m0 = mat ? Math.round(mat[v]!) : 0;
  if ((m0 >= MAT_GLASS - 0.5 && m0 < MAT_GLASS + 0.5) || isFlag(m0)) return null;
  for (let k = 0; k < 24; k++) {
    const q = (v + k) * 3;
    if (mat && Math.round(mat[v + k]!) !== m0) return null;
    if (col && (col[q]! > 1 || col[q + 1]! > 1 || col[q + 2]! > 1)) return null;
    const f = (k >> 2) * 12 + o;             // this face's first normal
    if (nrm[q] !== nrm[f] || nrm[q + 1] !== nrm[f + 1] || nrm[q + 2] !== nrm[f + 2]) return null;
  }
  // three face pairs, opposite within a pair, orthogonal across pairs
  for (let p = 0; p < 3; p++) {
    const a = o + p * 24, b = a + 12;
    if (abs(nrm[a]! + nrm[b]!) > 1e-6 || abs(nrm[a + 1]! + nrm[b + 1]!) > 1e-6 ||
        abs(nrm[a + 2]! + nrm[b + 2]!) > 1e-6) return null;
    const L2 = nrm[a]! * nrm[a]! + nrm[a + 1]! * nrm[a + 1]! + nrm[a + 2]! * nrm[a + 2]!;
    if (abs(L2 - 1) > 2e-4) return null;
    ax[p * 3] = nrm[a]!; ax[p * 3 + 1] = nrm[a + 1]!; ax[p * 3 + 2] = nrm[a + 2]!;
  }
  for (let p = 0; p < 3; p++) for (let r = p + 1; r < 3; r++)
    if (abs(ax[p * 3]! * ax[r * 3]! + ax[p * 3 + 1]! * ax[r * 3 + 1]! + ax[p * 3 + 2]! * ax[r * 3 + 2]!) > 1e-4) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < 24; k++) { const q = (v + k) * 3; cx += pos[q]!; cy += pos[q + 1]!; cz += pos[q + 2]!; }
  cx /= 24; cy /= 24; cz /= 24;
  // (scalar locals and inline |x|: this is the per-box hot loop)
  const a0 = ax[0]!, a1 = ax[1]!, a2 = ax[2]!, b0 = ax[3]!, b1 = ax[4]!, b2 = ax[5]!, c0 = ax[6]!, c1 = ax[7]!, c2 = ax[8]!;
  let h0 = 0, h1 = 0, h2 = 0;
  for (let k = 0; k < 24; k++) {
    const q = (v + k) * 3, px = pos[q]! - cx, py = pos[q + 1]! - cy, pz = pos[q + 2]! - cz, s = k * 3;
    const d0 = px * a0 + py * a1 + pz * a2, d1 = px * b0 + py * b1 + pz * b2, d2 = px * c0 + py * c1 + pz * c2;
    D[s] = d0; D[s + 1] = d1; D[s + 2] = d2;
    sg[s] = d0 < 0 ? -1 : 1; sg[s + 1] = d1 < 0 ? -1 : 1; sg[s + 2] = d2 < 0 ? -1 : 1;
    const e0 = d0 < 0 ? -d0 : d0, e1 = d1 < 0 ? -d1 : d1, e2 = d2 < 0 ? -d2 : d2;
    if (e0 > h0) h0 = e0; if (e1 > h1) h1 = e1; if (e2 > h2) h2 = e2;
  }
  h[0] = h0; h[1] = h1; h[2] = h2;
  if (h0 < MIN_HALF || h1 < MIN_HALF || h2 < MIN_HALF) return null;
  // every vertex a true corner; each face's quad on its own outward side,
  // four DISTINCT corners with 0 and 2 diagonal, drawn as (0,1,2)+(0,2,3)
  // with winding agreeing with the outward normal.
  const tol = 1e-4 * (1 + h0 + h1 + h2);
  for (let k = 0; k < 72; k += 3) {
    const d0 = D[k]!, d1 = D[k + 1]!, d2 = D[k + 2]!;
    const f0 = (d0 < 0 ? -d0 : d0) - h0, f1 = (d1 < 0 ? -d1 : d1) - h1, f2 = (d2 < 0 ? -d2 : d2) - h2;
    if ((f0 < 0 ? -f0 : f0) > tol || (f1 < 0 ? -f1 : f1) > tol || (f2 < 0 ? -f2 : f2) > tol) return null;
  }
  for (let fc = 0; fc < 6; fc++) {
    const base = v + fc * 4, p = fc >> 1;
    const n = base * 3;
    // outward: the quad lies on the side its normal points to
    const d = (pos[n]! - cx) * nrm[n]! + (pos[n + 1]! - cy) * nrm[n + 1]! + (pos[n + 2]! - cz) * nrm[n + 2]!;
    if (d <= 0) return null;
    let mask = 0;
    const side = (nrm[n]! * ax[p * 3]! + nrm[n + 1]! * ax[p * 3 + 1]! + nrm[n + 2]! * ax[p * 3 + 2]!) < 0 ? -1 : 1;
    const r1 = p === 0 ? 1 : 0, r2 = p === 2 ? 1 : 2;   // the two other axes, ascending
    for (let i = 0; i < 4; i++) {
      const s = (fc * 4 + i) * 3;
      if (sg[s + p] !== side) return null;
      mask |= 1 << ((sg[s + r1]! > 0 ? 1 : 0) | (sg[s + r2]! > 0 ? 2 : 0));
    }
    if (mask !== 15) return null;
    const s0 = fc * 12, s2 = s0 + 6;                    // corners 0 and 2 of the quad
    if (sg[s0 + r1] === sg[s2 + r1] || sg[s0 + r2] === sg[s2 + r2]) return null;
    const t = firstTri[base]!;
    if (t < 0 || (t + 1) * 3 + 2 >= idx.length) return null;
    for (let u = t; u <= t + 1; u++) {
      const a = idx[u * 3]!, b = idx[u * 3 + 1]!, c = idx[u * 3 + 2]!;
      if (a !== base || b < base || b > base + 3 || c < base || c > base + 3 || b === c) return null;
      const lo = min(b, c) - base, hi = max(b, c) - base;
      if (!((lo === 1 && hi === 2) || (lo === 2 && hi === 3))) return null;
      if (u === t + 1 && min(idx[t * 3 + 1]!, idx[t * 3 + 2]!) === min(b, c)) return null;
      const A = a * 3, B = b * 3, C = c * 3;
      const e1x = pos[B]! - pos[A]!, e1y = pos[B + 1]! - pos[A + 1]!, e1z = pos[B + 2]! - pos[A + 2]!;
      const e2x = pos[C]! - pos[A]!, e2y = pos[C + 1]! - pos[A + 1]!, e2z = pos[C + 2]! - pos[A + 2]!;
      const gx = e1y * e2z - e1z * e2y, gy = e1z * e2x - e1x * e2z, gz = e1x * e2y - e1y * e2x;
      if (gx * nrm[n]! + gy * nrm[n + 1]! + gz * nrm[n + 2]! <= 0) return null;
    }
  }
  REC[0] = cx; REC[1] = cy; REC[2] = cz;
  for (let i = 0; i < 9; i++) REC[3 + i] = ax[i]!;
  REC[12] = h[0]!; REC[13] = h[1]!; REC[14] = h[2]!;
  return true;
}


// Upper bound on the drawn terrain's height per coarse XZ cell: the max
// vertex y of every terrain triangle whose AABB touches the cell. A prop
// vertex above it cannot be buried (nor resting under a down face), so the
// exact groundY lookups only run on the few that pass. -Infinity = no terrain.
// Returns the raw grid; classify() does the lookup inline. hidden-faces.js:162
function terrainCeil(terrain: HiddenFacesTerrain | null | undefined): Ceil | null {
  const tp = terrain && arr(terrain.pos), ti = terrain && arr(terrain.idx);
  if (!tp || !ti || !ti.length) return null;
  let mnx = INF, mxx = -INF, mnz = INF, mxz = -INF;
  for (let i = 0; i < tp.length; i += 3) {
    const x = tp[i]!, z = tp[i + 2]!;
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const C = TCELL, nx = floor((mxx - mnx) / C) + 1, nz = floor((mxz - mnz) / C) + 1;
  const top = new Float64Array(nx * nz).fill(-INF);
  for (let t = 0; t + 2 < ti.length; t += 3) {
    const a = ti[t]! * 3, b = ti[t + 1]! * 3, c = ti[t + 2]! * 3;
    const xa = tp[a]!, xb = tp[b]!, xc = tp[c]!, za = tp[a + 2]!, zb = tp[b + 2]!, zc = tp[c + 2]!;
    const y = max(max(tp[a + 1]!, tp[b + 1]!), tp[c + 1]!);
    const i0 = floor((min(min(xa, xb), xc) - mnx) / C), i1 = floor((max(max(xa, xb), xc) - mnx) / C);
    const j0 = floor((min(min(za, zb), zc) - mnz) / C), j1 = floor((max(max(za, zb), zc) - mnz) / C);
    for (let j = j0; j <= j1; j++) for (let i = i0, k = j * nx + i0; i <= i1; i++, k++) if (y > top[k]!) top[k] = y;
  }
  return { top, mnx, mnz, nx, nz };
}

// Each phase below is its own function on purpose (hidden-faces.js:184-187):
// split, each is optimised on its own.

// firstTri[v] = the first triangle whose FIRST index is v, else -1. hidden-faces.js:190
function firstTris(idx: ArrayLike<number>, T: number, V: number): Int32Array {
  const firstTri = new Int32Array(V).fill(-1);
  for (let t = T - 1; t >= 0; t--) firstTri[idx[t * 3]!] = t;
  return firstTri;
}

// Every addBox, in vertex order → flat records B (REC layout), their AABBs
// BB = [mnx, mxx, mnz, mxz, mny, mxy], and first vertices BV. Boxes never
// overlap in the scan (v += 24), so V/24 bounds their count. hidden-faces.js:199
function scanBoxes(pos: ArrayLike<number>, nrm: ArrayLike<number>, col: ArrayLike<number> | null | undefined,
  mat: ArrayLike<number> | null | undefined, idx: ArrayLike<number>, firstTri: Int32Array, V: number): Scan {
  const cap = ((V / 24) | 0) + 1;
  const B = new Float64Array(cap * 15), BB = new Float64Array(cap * 6), BV = new Int32Array(cap);
  let NB = 0;
  for (let v = 0; v + 24 <= V;) {
    // boxAt's own necessary conditions, cheapest first: each face quad
    // starts a triangle, and face 0's first normals agree.
    const o = v * 3;
    if (firstTri[v]! < 0 || firstTri[v + 4]! < 0 || firstTri[v + 8]! < 0 || firstTri[v + 12]! < 0 ||
        firstTri[v + 16]! < 0 || firstTri[v + 20]! < 0 ||
        nrm[o] !== nrm[o + 3] || nrm[o] !== nrm[o + 9] || nrm[o + 1] !== nrm[o + 7] ||
        !boxAt(pos, nrm, col, mat, idx, firstTri, v)) { v++; continue; }
    const r = NB * 15;
    for (let i = 0; i < 15; i++) B[r + i] = REC[i]!;
    let mnx = INF, mxx = -INF, mny = INF, mxy = -INF, mnz = INF, mxz = -INF;
    for (let q = o; q < o + 72; q += 3) {
      const x = pos[q]!, y = pos[q + 1]!, z = pos[q + 2]!;
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    const w = NB * 6;
    BB[w] = mnx; BB[w + 1] = mxx; BB[w + 2] = mnz; BB[w + 3] = mxz; BB[w + 4] = mny; BB[w + 5] = mxy;
    BV[NB] = v;
    NB++;
    v += 24;
  }
  return { B: B.subarray(0, NB * 15), BB: BB.subarray(0, NB * 6), BV: BV.subarray(0, NB), NB };
}

// Dense CSR grid over the boxes' XZ AABBs. Each cell's list is sorted by
// AABB bottom (NaN first, as -INF) and carries the running max of AABB top
// (NaN as +INF), packed per entry so a walk reads one cache line per box:
// E[n*8] = running top max, E[n*8+1..6] = the AABB as in BB, E[n*8+7] = the
// sort key. A centroid at y then only needs the entries before the first
// bottom >= y (the rest fail `y <= bottom`), walked backwards until the
// running top <= y (that entry and all before it fail `y >= top`).
// `ks` (ascending box ids) picks the boxes this grid holds, `cell` its cell
// size; `next` chains the coarse grid of giant boxes (see BIG_CELLS).
// hidden-faces.js:238
function buildGrid(BB: Float64Array, NB: number, ks: Int32Array, cell: number): Grid {
  const NK = ks.length;
  if (!NK) return { gx0: 0, gz0: 0, gnx: 0, gnz: 0, start: new Int32Array(1), list: new Int32Array(0), E: new Float64Array(0), cell, next: null };
  let gx0 = INF, gz0 = INF, gx1 = -INF, gz1 = -INF;
  for (let q = 0; q < NK; q++) {
    const k = ks[q]!;
    if (BB[k * 6]! < gx0) gx0 = BB[k * 6]!; if (BB[k * 6 + 1]! > gx1) gx1 = BB[k * 6 + 1]!;
    if (BB[k * 6 + 2]! < gz0) gz0 = BB[k * 6 + 2]!; if (BB[k * 6 + 3]! > gz1) gz1 = BB[k * 6 + 3]!;
  }
  const gnx = floor((gx1 - gx0) / cell) + 1, gnz = floor((gz1 - gz0) / cell) + 1, NC = gnx * gnz;
  const start = new Int32Array(NC + 1), SP = new Int32Array(NK * 4);
  for (let q = 0; q < NK; q++) {
    const k = ks[q]!;
    const i0 = floor((BB[k * 6]! - gx0) / cell), i1 = floor((BB[k * 6 + 1]! - gx0) / cell);
    const j0 = floor((BB[k * 6 + 2]! - gz0) / cell), j1 = floor((BB[k * 6 + 3]! - gz0) / cell);
    SP[q * 4] = i0; SP[q * 4 + 1] = i1; SP[q * 4 + 2] = j0; SP[q * 4 + 3] = j1;
    for (let j = j0; j <= j1; j++) for (let c = j * gnx + i0, e = j * gnx + i1; c <= e; c++) start[c + 1]!++;
  }
  for (let c = 0; c < NC; c++) start[c + 1]! += start[c]!;
  const list = new Int32Array(start[NC]!);
  // start[c] doubles as cell c's fill cursor, then shifts back one slot.
  for (let q = 0; q < NK; q++) {
    const k = ks[q]!, i0 = SP[q * 4]!, i1 = SP[q * 4 + 1]!, j0 = SP[q * 4 + 2]!, j1 = SP[q * 4 + 3]!;
    for (let j = j0; j <= j1; j++) for (let c = j * gnx + i0, e = j * gnx + i1; c <= e; c++) list[start[c]!++] = k;
  }
  for (let c = NC; c > 0; c--) start[c] = start[c - 1]!;
  start[0] = 0;
  const bot = new Float64Array(NB);
  for (let q = 0; q < NK; q++) { const k = ks[q]!, y = BB[k * 6 + 4]!; bot[k] = y === y ? y : -INF; }
  const E = new Float64Array(list.length * 8);
  for (let c = 0; c < NC; c++) {
    const s = start[c]!, e = start[c + 1]!;
    for (let n = s + 1; n < e; n++) {             // stable insertion sort; lists are short
      const k = list[n]!, y = bot[k]!;
      let m = n;
      while (m > s && bot[list[m - 1]!]! > y) { list[m] = list[m - 1]!; m--; }
      list[m] = k;
    }
    let pm = -INF;
    for (let n = s; n < e; n++) {
      const k = list[n]!, o = k * 6, w = n * 8, top = BB[o + 5]!;
      if (!(top <= pm)) pm = top === top ? top : INF;
      E[w] = pm; E[w + 1] = BB[o]!; E[w + 2] = BB[o + 1]!; E[w + 3] = BB[o + 2]!; E[w + 4] = BB[o + 3]!;
      E[w + 5] = BB[o + 4]!; E[w + 6] = top; E[w + 7] = bot[k]!;
    }
  }
  return { gx0, gz0, gnx, gnz, start, list, E, cell, next: null };
}
// The fine grid of ordinary boxes, chaining a coarse grid of the giant ones
// when there are any. A NaN extent stays fine, as it always was. hidden-faces.js:288
function buildGrids(BB: Float64Array, NB: number): Grid {
  const small = new Int32Array(NB), big = new Int32Array(NB);
  let ns = 0, nb = 0;
  for (let k = 0; k < NB; k++) {
    const cells = ((BB[k * 6 + 1]! - BB[k * 6]!) / CELL + 1) * ((BB[k * 6 + 3]! - BB[k * 6 + 2]!) / CELL + 1);
    if (cells > BIG_CELLS) big[nb++] = k; else small[ns++] = k;
  }
  if (!nb) return buildGrid(BB, NB, small, CELL);
  const G = buildGrid(BB, NB, small.subarray(0, ns), CELL);
  G.next = buildGrid(BB, NB, big.subarray(0, nb), CELL_BIG);
  return G;
}

// inBox(k, ·) for all three corners (pos offsets A, Bq, C) of box record
// r = k * 15: each strictly (IN_EPS) inside on every axis. hidden-faces.js:303
function in3(B: Float64Array, pos: ArrayLike<number>, r: number, A: number, Bq: number, C: number): boolean {
  const ox = B[r]!, oy = B[r + 1]!, oz = B[r + 2]!;
  const u0 = B[r + 3]!, u1 = B[r + 4]!, u2 = B[r + 5]!, v0 = B[r + 6]!, v1 = B[r + 7]!, v2 = B[r + 8]!;
  const w0 = B[r + 9]!, w1 = B[r + 10]!, w2 = B[r + 11]!;
  const hu = B[r + 12]! - IN_EPS, hv = B[r + 13]! - IN_EPS, hw = B[r + 14]! - IN_EPS;
  let dx = pos[A]! - ox, dy = pos[A + 1]! - oy, dz = pos[A + 2]! - oz;
  let pu = dx * u0 + dy * u1 + dz * u2, pv = dx * v0 + dy * v1 + dz * v2, pw = dx * w0 + dy * w1 + dz * w2;
  if (!((pu < 0 ? -pu : pu) < hu && (pv < 0 ? -pv : pv) < hv && (pw < 0 ? -pw : pw) < hw)) return false;
  dx = pos[Bq]! - ox; dy = pos[Bq + 1]! - oy; dz = pos[Bq + 2]! - oz;
  pu = dx * u0 + dy * u1 + dz * u2; pv = dx * v0 + dy * v1 + dz * v2; pw = dx * w0 + dy * w1 + dz * w2;
  if (!((pu < 0 ? -pu : pu) < hu && (pv < 0 ? -pv : pv) < hv && (pw < 0 ? -pw : pw) < hw)) return false;
  dx = pos[C]! - ox; dy = pos[C + 1]! - oy; dz = pos[C + 2]! - oz;
  pu = dx * u0 + dy * u1 + dz * u2; pv = dx * v0 + dy * v1 + dz * v2; pw = dx * w0 + dy * w1 + dz * w2;
  return (pu < 0 ? -pu : pu) < hu && (pv < 0 ? -pv : pv) < hv && (pw < 0 ? -pw : pw) < hw;
}

// Is the triangle (pos offsets A, Bq, C) inside some box whose AABB
// strictly holds its centroid? hidden-faces.js:321
function enclosedTri(G: Grid, B: Float64Array, pos: ArrayLike<number>, A: number, Bq: number, C: number): boolean {
  const mx = (pos[A]! + pos[Bq]! + pos[C]!) / 3, my = (pos[A + 1]! + pos[Bq + 1]! + pos[C + 1]!) / 3;
  const mz = (pos[A + 2]! + pos[Bq + 2]! + pos[C + 2]!) / 3;
  for (let g: Grid | null = G; g; g = g.next) if (enclosedIn(g, B, pos, A, Bq, C, mx, my, mz)) return true;
  return false;
}
// hidden-faces.js:327
function enclosedIn(G: Grid, B: Float64Array, pos: ArrayLike<number>, A: number, Bq: number, C: number,
  mx: number, my: number, mz: number): boolean {
  const i = floor((mx - G.gx0) / G.cell), j = floor((mz - G.gz0) / G.cell);
  if (!(i >= 0 && j >= 0 && i < G.gnx && j < G.gnz)) return false;
  const E = G.E, list = G.list, cell = j * G.gnx + i, s = G.start[cell]!;
  let lo = s, hi = G.start[cell + 1]!;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (E[mid * 8 + 7]! < my) lo = mid + 1; else hi = mid; }
  for (let n = lo - 1; n >= s; n--) {
    const w = n * 8;
    if (E[w]! <= my) break;
    if (mx <= E[w + 1]! || mx >= E[w + 2]! || mz <= E[w + 3]! || mz >= E[w + 4]! || my <= E[w + 5]! || my >= E[w + 6]!) continue;
    if (in3(B, pos, list[n]! * 15, A, Bq, C)) return true;
  }
  return false;
}

// The same question for the boxes' OWN triangles (most of the buffer: 12
// per box, known from the scan), a box at a time: its triangles that share
// a grid cell share one walk, bounded by their joint centroid extent.
// Returns enc[t]: 0 = not a box triangle, 1 = enclosed, 2 = not. A centroid
// with a NaN coordinate stays 2: its triangle has a non-finite corner,
// which no inBox test passes.
// A chained coarse grid (G.next) runs as a second pass over the triangles
// the first left at 2; one enclosing box in either grid is enough.
// hidden-faces.js:350
function boxEnclosure(G: Grid, B: Float64Array, BV: Int32Array, NB: number, firstTri: Int32Array,
  pos: ArrayLike<number>, idx: ArrayLike<number>, T: number, encIn?: Uint8Array): Uint8Array {
  const enc = encIn || new Uint8Array(T), E = G.E, list = G.list, start = G.start;
  const gx0 = G.gx0, gz0 = G.gz0, gnx = G.gnx, gnz = G.gnz, CELL = G.cell;
  const TT = new Int32Array(12), TC = new Int32Array(12);
  const TX = new Float64Array(12), TY = new Float64Array(12), TZ = new Float64Array(12);
  for (let k = 0; k < NB; k++) {
    const v = BV[k]!;
    for (let f = 0; f < 6; f++) { const t = firstTri[v + f * 4]!; TT[f * 2] = t; TT[f * 2 + 1] = t + 1; }
    for (let q = 0; q < 12; q++) {
      const t = TT[q]!, A = idx[t * 3]! * 3, Bq = idx[t * 3 + 1]! * 3, C = idx[t * 3 + 2]! * 3;
      const mx = (pos[A]! + pos[Bq]! + pos[C]!) / 3, my = (pos[A + 1]! + pos[Bq + 1]! + pos[C + 1]!) / 3;
      const mz = (pos[A + 2]! + pos[Bq + 2]! + pos[C + 2]!) / 3;
      const i = floor((mx - gx0) / CELL), j = floor((mz - gz0) / CELL);
      TX[q] = mx; TY[q] = my; TZ[q] = mz;
      TC[q] = (mx === mx && my === my && mz === mz && i >= 0 && j >= 0 && i < gnx && j < gnz) ? j * gnx + i : -1;
      if (!encIn) enc[t] = 2;
      else if (enc[t] === 1) TC[q] = -1;
    }
    for (let q = 0; q < 12; q++) {
      const cell = TC[q]!;
      if (cell < 0) continue;
      let x0 = INF, x1 = -INF, y0 = INF, y1 = -INF, z0 = INF, z1 = -INF, left = 0;
      for (let p = q; p < 12; p++) if (TC[p] === cell) {
        const x = TX[p]!, y = TY[p]!, z = TZ[p]!;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
        left++;
      }
      const s = start[cell]!;
      let lo = s, hi = start[cell + 1]!;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (E[mid * 8 + 7]! < y1) lo = mid + 1; else hi = mid; }
      for (let n = lo - 1; n >= s && left; n--) {
        const w = n * 8;
        if (E[w]! <= y0) break;
        // no centroid of the group can be strictly inside this AABB
        if (E[w + 2]! <= x0 || E[w + 1]! >= x1 || E[w + 4]! <= z0 || E[w + 3]! >= z1 || E[w + 6]! <= y0 || E[w + 5]! >= y1) continue;
        const r = list[n]! * 15;
        for (let p = q; p < 12; p++) {
          const t = TT[p]!;
          if (TC[p] !== cell || enc[t] === 1) continue;
          const mx = TX[p]!, my = TY[p]!, mz = TZ[p]!;
          if (mx <= E[w + 1]! || mx >= E[w + 2]! || mz <= E[w + 3]! || mz >= E[w + 4]! || my <= E[w + 5]! || my >= E[w + 6]!) continue;
          if (in3(B, pos, r, idx[t * 3]! * 3, idx[t * 3 + 1]! * 3, idx[t * 3 + 2]! * 3)) { enc[t] = 1; left--; }
        }
      }
      for (let p = q; p < 12; p++) if (TC[p] === cell) TC[p] = -1;
    }
  }
  if (!encIn && G.next) boxEnclosure(G.next, B, BV, NB, firstTri, pos, idx, T, enc);
  return enc;
}

// The per-triangle pass: enclosed, else buried, else bottom. Fills keep[]
// and returns [kept, enclosed, buried, bottom]. hidden-faces.js:404
function classify(pos: ArrayLike<number>, idx: ArrayLike<number>, mat: ArrayLike<number> | null | undefined, T: number,
  G: Grid | null, B: Float64Array, enc: Uint8Array | null, ceil: Ceil | null,
  groundY: StripOpts["groundY"], keep: Uint8Array): [number, number, number, number] {
  // terrain ceiling over vertex v (recomputed: a vertex is shared by ~1.5
  // triangles here, too few to pay for a per-vertex cache)
  let cTop: Float64Array | null = null, cMnx = 0, cMnz = 0, cNx = 0, cNz = 0;
  if (ceil) { cTop = ceil.top; cMnx = ceil.mnx; cMnz = ceil.mnz; cNx = ceil.nx; cNz = ceil.nz; }
  const cAt = (v: number): number => {
    const i = floor((pos[v * 3]! - cMnx) / TCELL), j = floor((pos[v * 3 + 2]! - cMnz) / TCELL);
    return (i < 0 || j < 0 || i >= cNx || j >= cNz) ? -INF : cTop![j * cNx + i]!;
  };
  // exact ground under a point; NaN over a hole (a NaN comparison is false,
  // so a hole never strips anything)...
  const gRaw = (x: number, z: number): number => {
    const h = groundY!(x, z);
    if (h == null) return NAN;
    return (typeof h === "number" ? h - h === 0 : isFinite(h)) ? h : NAN;   // isFinite, without the global lookup
  };
  // ...memoised on the exact bit pattern of (x, z): a box repeats each
  // corner on three vertices and neighbouring triangles share edge
  // midpoints (~1 in 4 groundY calls at vegas). Open addressing, grown at
  // half full.
  const HB = new Float64Array(2), HU = new Uint32Array(HB.buffer);
  let hCap = 1 << 12, hN = 0, hK = new Uint32Array(hCap * 4), hV = new Float64Array(hCap), hUsed = new Uint8Array(hCap);
  const hSlot = (k0: number, k1: number, k2: number, k3: number, cap: number, K: Uint32Array, used: Uint8Array): number => {
    // 16-bit multipliers keep every product exact in a double
    let x = (((k0 ^ k1) * 0x9E37) | 0) ^ (((k2 ^ (k3 >>> 7)) * 0x85EB) | 0) ^ (k1 >>> 11) ^ (k3 << 9);
    x ^= x >>> 15; x = (x * 0xC2B3) | 0; x ^= x >>> 13;
    let i = x & (cap - 1);
    while (used[i] && !(K[i * 4] === k0 && K[i * 4 + 1] === k1 && K[i * 4 + 2] === k2 && K[i * 4 + 3] === k3)) i = (i + 1) & (cap - 1);
    return i;
  };
  const gPt = (x: number, z: number): number => {
    HB[0] = x; HB[1] = z;
    const k0 = HU[0]!, k1 = HU[1]!, k2 = HU[2]!, k3 = HU[3]!;
    const i = hSlot(k0, k1, k2, k3, hCap, hK, hUsed);
    if (hUsed[i]) return hV[i]!;
    const g = gRaw(x, z);
    hUsed[i] = 1; hV[i] = g; hK[i * 4] = k0; hK[i * 4 + 1] = k1; hK[i * 4 + 2] = k2; hK[i * 4 + 3] = k3;
    if (++hN * 2 > hCap) {
      const cap = hCap * 2, K = new Uint32Array(cap * 4), Vv = new Float64Array(cap), used = new Uint8Array(cap);
      for (let j = 0; j < hCap; j++) if (hUsed[j]) {
        const a = hK[j * 4]!, b = hK[j * 4 + 1]!, c = hK[j * 4 + 2]!, d = hK[j * 4 + 3]!;
        const w = hSlot(a, b, c, d, cap, K, used);
        used[w] = 1; Vv[w] = hV[j]!; K[w * 4] = a; K[w * 4 + 1] = b; K[w * 4 + 2] = c; K[w * 4 + 3] = d;
      }
      hCap = cap; hK = K; hV = Vv; hUsed = used;
    }
    return g;
  };
  const gAt = (v: number): number => gPt(pos[v * 3]!, pos[v * 3 + 2]!);     // exact ground under vertex v
  // centroid and edge midpoints all satisfy y < ground + off (strictly)
  const interiorUnder = (A: number, Bq: number, C: number, off: number): boolean => {
    for (let s = 0; s < 4; s++) {
      const wa = s === 0 ? 1 / 3 : s === 2 ? 0 : 0.5, wb = s === 0 ? 1 / 3 : s === 3 ? 0 : 0.5, wc = 1 - wa - wb;
      const x = pos[A]! * wa + pos[Bq]! * wb + pos[C]! * wc, y = pos[A + 1]! * wa + pos[Bq + 1]! * wb + pos[C + 1]! * wc;
      const z = pos[A + 2]! * wa + pos[Bq + 2]! * wb + pos[C + 2]! * wc;
      if (!(y < gPt(x, z) + off)) return false;
    }
    return true;
  };

  let kept = 0, nEnc = 0, nBur = 0, nBot = 0;
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3]!, b = idx[t * 3 + 1]!, c = idx[t * 3 + 2]!;
    let hide = 0;
    if (!(mat && (isFlag(mat[a]!) || isFlag(mat[b]!) || isFlag(mat[c]!)))) {
      const A = a * 3, Bq = b * 3, C = c * 3;
      if (G) {
        const e = enc![t];
        if (e === 1 || (e === 0 && enclosedTri(G, B, pos, A, Bq, C))) { hide = 1; nEnc++; }
      }
      if (!hide && ceil) {
        const ya = pos[A + 1]!, yb = pos[Bq + 1]!, yc = pos[C + 1]!;
        const ca = cAt(a);
        if (ya < ca - BURY && yb < cAt(b) - BURY && yc < cAt(c) - BURY &&
            ya < gAt(a) - BURY && yb < gAt(b) - BURY && yc < gAt(c) - BURY &&
            interiorUnder(A, Bq, C, -BURY)) { hide = 1; nBur++; }
        else if (ya <= ca + BOTTOM && yb <= cAt(b) + BOTTOM && yc <= cAt(c) + BOTTOM) {
          const e1x = pos[Bq]! - pos[A]!, e1y = yb - ya, e1z = pos[Bq + 2]! - pos[A + 2]!;
          const e2x = pos[C]! - pos[A]!, e2y = yc - ya, e2z = pos[C + 2]! - pos[A + 2]!;
          const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
          const L2 = nx * nx + ny * ny + nz * nz;
          if (L2 > 1e-24 && ny < 0 && ny * ny > BOTTOM_NY * BOTTOM_NY * L2 &&
              ya <= gAt(a) + BOTTOM && yb <= gAt(b) + BOTTOM && yc <= gAt(c) + BOTTOM &&
              interiorUnder(A, Bq, C, BOTTOM + 1e-9)) { hide = 1; nBot++; }
        }
      }
    }
    if (!hide) { keep[t] = 1; kept++; }
  }
  return [kept, nEnc, nBur, nBot];
}

// hidden-faces.js:496
function keptIndices(idx: ArrayLike<number>, keep: Uint8Array, kept: number, T: number): Uint32Array {
  const out = new Uint32Array(kept * 3);
  let w = 0;
  for (let t = 0; t < T; t++) if (keep[t]) { out[w++] = idx[t * 3]!; out[w++] = idx[t * 3 + 1]!; out[w++] = idx[t * 3 + 2]!; }
  return out;
}

/**
 * strip's passes as a generator that yields between them, so a paced build can
 * keep animating (Tracks.buildSteps). Every test is the same arithmetic as the
 * single-pass original, only ordered and indexed to skip work whose answer is
 * already known. hidden-faces.js:511
 */
export function* stripSteps(geo: HiddenFacesGeo | null | undefined, opts?: StripOpts | null): Generator<undefined, StripStats, unknown> {
  let t0 = now(), active = 0;
  const stats: StripStats = { trisBefore: 0, trisAfter: 0, enclosed: 0, buried: 0, bottom: 0, boxes: 0, ms: 0 };
  if (!geo || !geo.pos || !geo.idx) return stats;
  const pos = arr(geo.pos), nrm = arr(geo.nrm), col = arr(geo.col), mat = arr(geo.mat), idx = arr(geo.idx);
  const V = (pos.length / 3) | 0, T = (idx.length / 3) | 0;
  stats.trisBefore = stats.trisAfter = T;
  if (!T || !nrm || nrm.length !== pos.length) return stats;
  const groundY = opts && opts.groundY;
  const ceil = groundY ? terrainCeil(opts.terrain) : null;

  const firstTri = firstTris(idx, T, V);
  active += now() - t0; yield; t0 = now();
  const S = scanBoxes(pos, nrm, col, mat, idx, firstTri, V);
  stats.boxes = S.NB;
  active += now() - t0; yield; t0 = now();
  const G = S.NB ? buildGrids(S.BB, S.NB) : null;
  const enc = G ? boxEnclosure(G, S.B, S.BV, S.NB, firstTri, pos, idx, T) : null;
  active += now() - t0; yield; t0 = now();
  const keep = new Uint8Array(T);
  const n = classify(pos, idx, mat, T, G, S.B, enc, ceil, groundY, keep);
  const kept = n[0];
  stats.enclosed = n[1]; stats.buried = n[2]; stats.bottom = n[3];
  active += now() - t0; yield; t0 = now();
  if (kept !== T) geo.idx = keptIndices(idx, keep, kept, T);
  stats.trisAfter = kept;
  stats.ms = active + (now() - t0);
  return stats;
}

/**
 * strip(geo, { groundY(x, z) -> y|null, terrain: terrainGeo }) -> stats: drives
 * stripSteps straight through (identical kept indices and stats by construction).
 * hidden-faces.js:540
 */
export function strip(geo: HiddenFacesGeo | null | undefined, opts?: StripOpts | null): StripStats {
  const it = stripSteps(geo, opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

// Per-vertex columns a props buffer can carry, with their stride. A column
// whose length is not V * stride is not per-vertex here and is left alone.
// hidden-faces.js:548
const STRIDE: readonly (readonly ["pos" | "nrm" | "col" | "trk" | "uv" | "mat", number])[] =
  [["pos", 3], ["nrm", 3], ["col", 3], ["trk", 3], ["uv", 2], ["mat", 1]];

/**
 * compact(geo) -> { vertsBefore, vertsAfter, ms }. Rewrites the per-vertex
 * columns WITHOUT the vertices no triangle references, keeping the survivors
 * in their original order, and remaps idx onto them. Every kept triangle
 * references exactly the same positions (and normals, colours, materials) as
 * before. hidden-faces.js:555
 */
export function compact(geo: HiddenFacesGeo | null | undefined): CompactStats {
  const t0 = now();
  const stats: CompactStats = { vertsBefore: 0, vertsAfter: 0, ms: 0 };
  if (!geo || !geo.pos || !geo.idx) return stats;
  const pos = arr(geo.pos), idx = arr(geo.idx);
  const V = (pos.length / 3) | 0, N = idx.length;
  stats.vertsBefore = stats.vertsAfter = V;
  const used = new Uint8Array(V);
  for (let i = 0; i < N; i++) {
    const v = idx[i]!;
    if (!(v >= 0 && v < V)) return stats;          // malformed: leave it for validateGeometry to name
    used[v] = 1;
  }
  // before[v] = kept vertices ahead of v; before[V] = kept total
  const before = new Int32Array(V + 1);
  for (let v = 0; v < V; v++) before[v + 1] = before[v]! + used[v]!;
  const n = before[V]!;
  if (n === V) { stats.ms = now() - t0; return stats; }
  for (const [key, k] of STRIDE) {
    const a = arr(geo[key]);
    if (!a || a.length !== V * k) continue;
    const out: NumCol = Array.isArray(a) ? new Array<number>(n * k) : new (a.constructor as new (n: number) => NumCol)(n * k);
    let w = 0;
    for (let v = 0; v < V; v++) {
      if (!used[v]) continue;
      const o = v * k;
      for (let j = 0; j < k; j++) out[w++] = a[o + j]!;
    }
    geo[key] = out;
  }
  const ni: NumCol = Array.isArray(idx) ? new Array<number>(N) : new (idx.constructor as new (n: number) => NumCol)(N);
  for (let i = 0; i < N; i++) ni[i] = before[idx[i]!]!;
  geo.idx = ni;
  // appendBuffer's provenance blocks: a block's surviving vertices stay
  // contiguous (order-preserving), so its new range is a prefix-count shift.
  if (Array.isArray(geo.__blocks)) {
    geo.__blocks = geo.__blocks.map((b) => {
      const s = b.base < 0 ? 0 : b.base > V ? V : b.base;
      const e = b.base + b.count > V ? V : b.base + b.count;
      return Object.assign({}, b, { base: before[s]!, count: e > s ? before[e]! - before[s]! : 0 });
    });
  }
  stats.vertsAfter = n;
  stats.ms = now() - t0;
  return stats;
}
