/**
 * GaragePrims: the garage bay's mesh primitives and shared constants. The
 * room's dimensions and wall colours, and the block / cylinder / tube / hose /
 * panel-grid builders every part of the bay is made of.
 *
 * Ported verbatim from f1-game js/garage/scene-prims.js:1-203 (GaragePrims).
 * Float operation order is f1-game's, including its own Math.hypot calls.
 * Differences from the IIFE, none of which change a number:
 * - `MAT` is src/track/core/geom.ts's table (f1-game read TrackGeom.MAT lazily,
 *   scene-prims.js:173-174, with a fallback for a VM without TrackGeom; here it
 *   is always present, so the fallback is gone).
 * - The bay's dimensions come from src/track/core/pit.ts `BAY` (scene-prims.js:10
 *   read TrackPit.BAY at eval).
 * - Accumulators stay f1-game's plain `number[]` (they are push-built and
 *   handed to the renderer facade as-is); ./three.ts converts them to typed
 *   arrays for three.
 */
import { MAT as TRACK_MAT } from "../../track/core/geom";
import { BAY } from "../../track/core/pit";

/** A 3-vector / linear RGB triple. */
export type V3 = readonly [number, number, number];

/**
 * f1-game's mesh accumulator `{ pos, nrm, col, mat, idx }` (scene.js:913 `acc`).
 * `mat` is optional only because pushMat (scene-prims.js:185) skips an
 * accumulator without one; every accumulator this module family builds has it.
 */
export interface MeshAcc {
  pos: number[];
  nrm: number[];
  col: number[];
  mat?: number[];
  idx: number[];
}

/** A textured (decal) accumulator: the dress and live atlas quads (scene-dress.js:381). */
export interface TexAcc {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
}

/** A fresh accumulator with a material column (scene.js:913). */
export const acc = (): Required<MeshAcc> => ({ pos: [], nrm: [], col: [], mat: [], idx: [] });

// Interior, metres. The car spans z -2.69..3.18 and x +/-0.95; its nose is +Z,
// so +Z is the pit-lane end and the deep end of the bay is behind it.
// THE ROOM IS THE TRACKSIDE GARAGE. src/track/core/pit.ts owns the bay's
// dimensions (BAY), so the setup screen and the pit complex cannot disagree
// about the box you drive into: 10.8 m of frontage, 12.8 m deep, 5 m to the
// ceiling. scene-prims.js:6-12
export const HALF_W = BAY.w / 2, Z_BACK = -BAY.depth / 2, Z_DOOR = BAY.depth / 2, CEIL_Y = BAY.h;

export const PANEL: V3 = [0.150, 0.156, 0.170];   // upper wall panels
export const STEEL: V3 = [0.230, 0.235, 0.250];
export const DARK: V3 = [0.055, 0.058, 0.066];

/** Per-vertex colour callback for panelGrid: (u01, v01) -> RGB. */
export type ColAt = (u: number, v: number) => V3;

// ── mesh helpers ───────────────────────────────────────────────────────────
// A flat rectangle spanned by uVec/vVec from origin, subdivided nu x nv and
// shaded per-vertex by colAt(u01, v01). Winding is derived from the requested
// normal rather than assumed, which is what lets the same helper build a wall
// seen from INSIDE and a prop face seen from outside. scene-prims.js:22-53
export function panelGrid(out: MeshAcc, origin: V3, uVec: V3, vVec: V3, nu: number, nv: number,
  nrm: V3, colAt: ColAt, mid?: number): void {
  const base = out.pos.length / 3;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv, c = colAt(u, v);
      out.pos.push(origin[0] + uVec[0] * u + vVec[0] * v,
                   origin[1] + uVec[1] * u + vVec[1] * v,
                   origin[2] + uVec[2] * u + vVec[2] * v);
      out.nrm.push(nrm[0], nrm[1], nrm[2]);
      out.col.push(c[0], c[1], c[2]);
    }
  }
  pushMat(out, (nu + 1) * (nv + 1), mid);
  const cr: V3 = [uVec[1] * vVec[2] - uVec[2] * vVec[1],
                  uVec[2] * vVec[0] - uVec[0] * vVec[2],
                  uVec[0] * vVec[1] - uVec[1] * vVec[0]];
  // (a,d,c)/(a,b,d) is the order that is CCW about +cr, where cr = uVec x vVec:
  // in (u,v) the quad is a(0,0) b(1,0) c(0,1) d(1,1), and a->d->c turns the same
  // way as u->v. So when cr already points along the wanted normal, THAT is the
  // order to emit; the other one faces the wall the wrong way and a room built
  // from it is a solid box that hides its own interior.
  const along = cr[0] * nrm[0] + cr[1] * nrm[1] + cr[2] * nrm[2] > 0;
  const row = nu + 1;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = base + j * row + i, b = a + 1, c = a + row, d = c + 1;
      if (along) out.idx.push(a, d, c, a, b, d);
      else out.idx.push(a, c, d, a, d, b);
    }
  }
}

// Solid axis-aligned block, outward-wound, one flat colour. Props are SOLIDS,
// never planes: a camera that wanders inside one then sees only back faces and
// the prop silently vanishes instead of smearing across the frame.
export const BOX_F: readonly V3[] = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
// A WALL-KEYED material must never land on a horizontal face. f1-game's
// matWallLike() (js/render/glx/shaders/glsl-lit.js) makes CONCRETE/BRICK/METAL/
// WOOD/FABRIC/ROOF/STONE/RUST key their triplanar UV off
// `(an.x > an.z ? worldZ : worldX, worldY)`; on a face whose normal is +-Y,
// worldY is constant, so the UV collapses to one axis and the material renders
// as streaks smeared down it. A box cannot know which of its faces a caller
// cared about, so it decides per face: the four sides take the id, the top and
// bottom drop to FLAT. That kills the whole class of bug at the primitive
// instead of at ~150 call sites. scene-prims.js:59-71
export const WALL_KEYED: readonly number[] = [1, 2, 4, 5, 7, 12, 13, 14];
export const sideOnly = (mid: number | undefined, ny: number): number | undefined =>
  (ny !== 0 && WALL_KEYED.indexOf(mid as number) >= 0 ? 0 : mid);

/** scene-prims.js:72-95 */
export function block(out: MeshAcc, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number,
  col: V3, mid?: number): void {
  const c = [cx, cy, cz] as const, h = [hx, hy, hz] as const;
  for (let f = 0; f < 6; f++) {
    const n = BOX_F[f]!;
    const i0 = n[0] ? 1 : 0, i1 = n[2] ? 1 : 2;   // the two in-plane axes
    const base = out.pos.length / 3;
    for (let s = 0; s < 4; s++) {
      const p: [number, number, number] = [c[0] + n[0] * h[0], c[1] + n[1] * h[1], c[2] + n[2] * h[2]];
      p[i0] += ((s === 1 || s === 2) ? 1 : -1) * h[i0];
      p[i1] += (s >= 2 ? 1 : -1) * h[i1];
      out.pos.push(p[0], p[1], p[2]);
      out.nrm.push(n[0], n[1], n[2]);
      out.col.push(col[0], col[1], col[2]);
    }
    pushMat(out, 4, sideOnly(mid, n[1]));
    const e: [number, number, number] = [0, 0, 0]; e[i0] = 1;
    const g: [number, number, number] = [0, 0, 0]; g[i1] = 1;
    const cr = [e[1] * g[2] - e[2] * g[1], e[2] * g[0] - e[0] * g[2], e[0] * g[1] - e[1] * g[0]] as const;
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] > 0)
      out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else out.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}

/** Vertical cylinder with a top cap (no bottom). scene-prims.js:97-119 */
export function cyl(out: MeshAcc, cx: number, cy: number, cz: number, rad: number, h: number, col: V3,
  seg?: number, mid?: number): void {
  seg = seg || 10;
  const base = out.pos.length / 3;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    for (let k = 0; k < 2; k++) {
      out.pos.push(cx + ca * rad, cy + k * h, cz + sa * rad);
      out.nrm.push(ca, 0, sa); out.col.push(col[0], col[1], col[2]);
    }
  }
  pushMat(out, seg * 2, mid);
  for (let i = 0; i < seg; i++) {
    const a = base + i * 2, b = base + ((i + 1) % seg) * 2;
    out.idx.push(a, b, b + 1, a, b + 1, a + 1);
  }
  const top = out.pos.length / 3;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    out.pos.push(cx + Math.cos(a) * rad, cy + h, cz + Math.sin(a) * rad);
    out.nrm.push(0, 1, 0); out.col.push(col[0], col[1], col[2]);
  }
  pushMat(out, seg, sideOnly(mid, 1));      // the cap is horizontal, same rule
  for (let i = 1; i < seg - 1; i++) out.idx.push(top, top + i, top + i + 1);
}

// An ORIENTED cylinder from a to b — cyl() is vertical only, and a garage is
// mostly things that are not: hoses, cables, booms, an upright tyre on a
// trolley, a jack handle. Basis: n along the axis, u perpendicular, and
// v = u x n, which gives (u, v, n) the SAME handedness as cyl's (X, Z, Y) so
// its index order (outward-wound) carries over unchanged; the b-end cap is
// cyl's top cap and the a-end reverses it. Caps take sideOnly on their axis so
// a horizontal cap of a wall-keyed material never streaks (see block()).
// scene-prims.js:121-165
export function tube(out: MeshAcc, a: V3, b: V3, rad: number, col: V3, seg?: number, mid?: number): void {
  seg = seg || 8;
  const sg0 = seg;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const L = Math.hypot(d[0], d[1], d[2]) || 1e-6;
  const n = [d[0] / L, d[1] / L, d[2] / L] as const;
  const h = Math.abs(n[1]) < 0.9 ? [0, 1, 0] as const : [1, 0, 0] as const;
  let u: V3 = [h[1] * n[2] - h[2] * n[1], h[2] * n[0] - h[0] * n[2], h[0] * n[1] - h[1] * n[0]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]];
  const ring = (i: number): V3 => { const t = (i / sg0) * Math.PI * 2, ca = Math.cos(t), sa = Math.sin(t);
    return [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa]; };
  const base = out.pos.length / 3;
  for (let i = 0; i < seg; i++) {
    const r = ring(i);
    for (let k = 0; k < 2; k++) {
      const pt = k ? b : a;
      out.pos.push(pt[0] + r[0] * rad, pt[1] + r[1] * rad, pt[2] + r[2] * rad);
      out.nrm.push(r[0], r[1], r[2]); out.col.push(col[0], col[1], col[2]);
    }
  }
  pushMat(out, seg * 2, mid);
  for (let i = 0; i < seg; i++) {
    const p = base + i * 2, q = base + ((i + 1) % seg) * 2;
    out.idx.push(p, q, q + 1, p, q + 1, p + 1);
  }
  for (const end of [[b, 1], [a, -1]] as const) {
    const pt = end[0], sg = end[1], top = out.pos.length / 3;
    for (let i = 0; i < seg; i++) {
      const r = ring(i);
      out.pos.push(pt[0] + r[0] * rad, pt[1] + r[1] * rad, pt[2] + r[2] * rad);
      out.nrm.push(n[0] * sg, n[1] * sg, n[2] * sg); out.col.push(col[0], col[1], col[2]);
    }
    pushMat(out, seg, sideOnly(mid, n[1] * sg));
    for (let i = 1; i < seg - 1; i++)
      if (sg > 0) out.idx.push(top, top + i, top + i + 1); else out.idx.push(top, top + i + 1, top + i);
  }
}
/** A hose or cable through a polyline of points: one tube per leg. scene-prims.js:167-169 */
export function hose(out: MeshAcc, pts: readonly V3[], rad: number, col: V3, seg?: number, mid?: number): void {
  for (let i = 1; i < pts.length; i++) tube(out, pts[i - 1]!, pts[i]!, rad, col, seg, mid);
}

// The shared material ids, so the bay names the same surfaces the track does
// rather than keeping a second copy that can drift. scene-prims.js:171-176
export const MAT = TRACK_MAT;

/** scene-prims.js:178-180 */
export const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const scale = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];
/** A colour slot that may be absent or malformed (a livery field). */
export type ColIn = readonly number[] | null | undefined | false;
/** `c && c.length === 3 ? c : dflt`, typed: the length test is what makes it a V3. */
export const rgb = (c: ColIn, dflt: V3): V3 => (c && c.length === 3 ? c as unknown as V3 : dflt);

/** scene-prims.js:182-183 */
const to255 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
export const css = (c: V3): string => `rgb(${to255(c[0])},${to255(c[1])},${to255(c[2])})`;

/** scene-prims.js:185-188 */
export const pushMat = (out: MeshAcc, n: number, mid: number | undefined): void => {
  if (!out.mat) return;
  for (let i = 0; i < n; i++) out.mat.push(mid || 0);
};

// One bay-floor rectangle at y = 0. The markings are REAL GEOMETRY in a gapless
// tiling, not decals: overlapping coplanar quads z-fight at grazing elevation,
// and a decal would miss the lamp pools entirely (the decal shader sees sun and
// ambient only, never the point lights). scene-prims.js:190-202
export function tile(out: MeshAcc, x0: number, x1: number, z0: number, z1: number, col: V3, y?: number, mid?: number): void {
  const base = out.pos.length / 3;
  const p = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as const;
  for (let k = 0; k < 4; k++) {
    out.pos.push(p[k]![0], y || 0, p[k]![1]); out.nrm.push(0, 1, 0);
    out.col.push(col[0], col[1], col[2]);
  }
  pushMat(out, 4, mid);
  out.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}
