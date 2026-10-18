/**
 * Pure 3D geometry emitters shared by the track and scenery builders. Each
 * add*(out, ...) pushes positions / normals / colours / indices into a
 * GeomOut accumulator. Ported verbatim from f1-game js/track/core/geom.js
 * (TrackGeom, :1-370); comments trimmed, float order unchanged.
 */
import type { GeomOut, MatAt, RV3, V3 } from "./types";

const __M = Math, __isFinite = Number.isFinite;

/** Material ids. ASPHALT (16) must stay above the flag's 15..16 window. geom.js:7 */
export const MAT = {
  FLAT: 0, CONCRETE: 1, BRICK: 2, GLASS: 3, METAL: 4, WOOD: 5,
  FOLIAGE: 6, FABRIC: 7, SAND: 8, GRASS: 9, ROCK: 10, SNOW: 11,
  ROOF: 12, STONE: 13, RUST: 14,
  FLAG: 15,
  ASPHALT: 16,
} as const;

/** Wind-sway weight carried in the fraction of a FOLIAGE material id. geom.js:29 */
export const SWAY_FRAC = 0.45;

/** Per-vertex material callback for one swaying emitter. geom.js:32 */
export function swayMatAt(id: number, base: RV3, up: RV3, y0: number, y1: number): MatAt {
  const inv = 1 / Math.max(1e-6, y1 - y0);
  return (x, y, z) => {
    const hv = (x - base[0]) * up[0] + (y - base[1]) * up[1] + (z - base[2]) * up[2];
    const w = (hv - y0) * inv;
    return id + (w <= 0 ? 0 : w >= 1 ? 1 : w) * SWAY_FRAC;
  };
}

/** Crown rounding blend. geom.js:50 */
export const ROUND_K = 0.6;

/**
 * Blend the normals emitted since v0 toward the radial direction from the
 * crown axis (base, up) by k. geom.js:59. f1-game returns early for its
 * non-array scratch accumulators; here `pos` is always an array.
 */
export function roundNormals(out: GeomOut, v0: number, base: RV3, up: RV3, k?: number | null): void {
  const pos = out.pos, nrm = out.nrm;
  if (!Array.isArray(pos) && !ArrayBuffer.isView(pos)) return;
  const n = pos.length / 3;
  const kk = k == null ? ROUND_K : k;
  if (kk <= 0) return;
  for (let i = v0; i < n; i++) {
    const px = pos[i * 3]! - base[0], py = pos[i * 3 + 1]! - base[1], pz = pos[i * 3 + 2]! - base[2];
    const h = px * up[0] + py * up[1] + pz * up[2];
    let rx = px - up[0] * h, ry = py - up[1] * h, rz = pz - up[2] * h;
    const rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-4) continue;
    rx /= rl; ry /= rl; rz /= rl;
    const nx = nrm[i * 3]! * (1 - kk) + rx * kk, ny = nrm[i * 3 + 1]! * (1 - kk) + ry * kk, nz = nrm[i * 3 + 2]! * (1 - kk) + rz * kk;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nrm[i * 3] = nx / nl; nrm[i * 3 + 1] = ny / nl; nrm[i * 3 + 2] = nz / nl;
  }
}

/** geom.js:78 */
export function cross(a: RV3, b: RV3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** geom.js:81 */
export function norm(a: RV3): V3 {
  const l = __M.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** The six box faces as data: four corner sign-triples then (axis, sign). geom.js:102 */
const BOX_FACES = new Int8Array([
  -1, 1, 1,  -1, -1, 1,   1, -1, 1,   1, 1, 1,   2,  1,   // +f
   1, 1, -1,  1, -1, -1, -1, -1, -1, -1, 1, -1,  2, -1,   // -f
   1, 1, 1,   1, -1, 1,   1, -1, -1,  1, 1, -1,  0,  1,   // +r
  -1, 1, -1, -1, -1, -1, -1, -1, 1,  -1, 1, 1,   0, -1,   // -r
  -1, 1, -1, -1, 1, 1,    1, 1, 1,    1, 1, -1,  1,  1,   // +u
  -1, -1, 1, -1, -1, -1,  1, -1, -1,  1, -1, 1,  1, -1,   // -u
]);
const BOX_STRIDE = 14;

/** A basis `[right, up, fwd]`. */
export type Basis = readonly [RV3, RV3, RV3];

/**
 * Oriented box; basis optional [right, up, fwd]. Reverses winding on a
 * left-handed basis so the outward face survives culling. geom.js:113
 */
export function addBox(out: GeomOut, c: RV3, sz: RV3, col: RV3, basis?: Basis | null): void {
  const r = basis ? basis[0] : [1, 0, 0] as const, u = basis ? basis[1] : [0, 1, 0] as const, f = basis ? basis[2] : [0, 0, 1] as const;
  const hx = sz[0] / 2, hy = sz[1] / 2, hz = sz[2] / 2;
  const rx = r[0] * hx, ry = r[1] * hx, rz = r[2] * hx;
  const ux = u[0] * hy, uy = u[1] * hy, uz = u[2] * hy;
  const fx = f[0] * hz, fy = f[1] * hz, fz = f[2] * hz;
  const c0 = c[0], c1 = c[1], c2 = c[2];
  const cr = cross(r, u);
  const flip = (cr[0] * f[0] + cr[1] * f[1] + cr[2] * f[2]) < 0;
  const m = out._mat || 0, mm = out.mat, mAt = out._matAt || null;
  const col0 = col[0], col1 = col[1], col2 = col[2];
  const pos = out.pos, nrm = out.nrm, cols = out.col, idx = out.idx;
  for (let fi = 0; fi < 6; fi++) {
    const o = fi * BOX_STRIDE;
    const base = pos.length / 3;
    const ax = BOX_FACES[o + 12]!, sg = BOX_FACES[o + 13]!;
    const bv = ax === 0 ? r : ax === 1 ? u : f;
    const nx = bv[0] * sg, ny = bv[1] * sg, nz = bv[2] * sg;
    for (let i = 0; i < 4; i++) {
      const s = o + i * 3;
      const sx = BOX_FACES[s]!, sy = BOX_FACES[s + 1]!, sz2 = BOX_FACES[s + 2]!;
      const px = c0 + rx * sx + ux * sy + fx * sz2,
            py = c1 + ry * sx + uy * sy + fy * sz2,
            pz = c2 + rz * sx + uz * sy + fz * sz2;
      pos.push(px, py, pz);
      nrm.push(nx, ny, nz);
      cols.push(col0, col1, col2);
      if (mm) mm.push(mAt ? mAt(px, py, pz) : m);
    }
    if (flip) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * One flat convex polygon (3+ coplanar verts in perimeter order), fan-
 * triangulated and oriented away from `ref`. Returns false (emits nothing) on
 * a non-finite vertex. geom.js:163
 */
export function emit(out: GeomOut, verts: readonly RV3[], col: RV3, ref?: RV3 | null): false | undefined {
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    if (!v || !__isFinite(v[0]) || !__isFinite(v[1]) || !__isFinite(v[2])) return false;
  }
  const v0 = verts[0]!, v1 = verts[1]!, v2 = verts[2]!;
  let nv = norm(cross(
    [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]],
    [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]]));
  if (ref) {
    let fx = 0, fy = 0, fz = 0;
    for (const v of verts) { fx += v[0]; fy += v[1]; fz += v[2]; }
    fx = fx / verts.length - ref[0]; fy = fy / verts.length - ref[1]; fz = fz / verts.length - ref[2];
    if (nv[0] * fx + nv[1] * fy + nv[2] * fz < 0) { verts = verts.slice().reverse(); nv = [-nv[0], -nv[1], -nv[2]]; }
  }
  const base = out.pos.length / 3;
  const m = out._mat || 0, mm = out.mat, mAt = out._matAt || null;
  for (const v of verts) { out.pos.push(v[0], v[1], v[2]); out.nrm.push(nv[0], nv[1], nv[2]); out.col.push(col[0], col[1], col[2]); if (mm) mm.push(mAt ? mAt(v[0], v[1], v[2]) : m); }
  for (let i = 1; i < verts.length - 1; i++) out.idx.push(base, base + i, base + i + 1);
  return undefined;
}

/** geom.js:185 */
export const vadd = (p: RV3, v: RV3, s: number): V3 => [p[0] + v[0] * s, p[1] + v[1] * s, p[2] + v[2] * s];

/** geom.js:187 */
export function addPrism(out: GeomOut, c: RV3, sz: RV3, col: RV3, basis?: Basis | null): void {
  const r = basis ? basis[0] : [1, 0, 0] as const, u = basis ? basis[1] : [0, 1, 0] as const, f = basis ? basis[2] : [0, 0, 1] as const;
  const hx = sz[0] / 2, hl = sz[2] / 2, h = sz[1], ref = vadd(c, u, h * 0.4);
  const b0 = vadd(vadd(c, r, -hx), f, -hl), b1 = vadd(vadd(c, r, hx), f, -hl);
  const b2 = vadd(vadd(c, r, hx), f, hl), b3 = vadd(vadd(c, r, -hx), f, hl);
  const p0 = vadd(vadd(c, u, h), f, -hl), p1 = vadd(vadd(c, u, h), f, hl);
  emit(out, [b0, b1, p0], col, ref); emit(out, [b3, b2, p1], col, ref);
  emit(out, [b1, b2, p1, p0], col, ref); emit(out, [b0, p0, p1, b3], col, ref);
}

/** Pyramid: base sz[0]×sz[2] up to an apex at sz[1]. geom.js:198 */
export function addPyramid(out: GeomOut, c: RV3, sz: RV3, col: RV3, basis?: Basis | null): void {
  const r = basis ? basis[0] : [1, 0, 0] as const, u = basis ? basis[1] : [0, 1, 0] as const, f = basis ? basis[2] : [0, 0, 1] as const;
  const hx = sz[0] / 2, hl = sz[2] / 2, ref = vadd(c, u, sz[1] * 0.35);
  const b0 = vadd(vadd(c, r, -hx), f, -hl), b1 = vadd(vadd(c, r, hx), f, -hl);
  const b2 = vadd(vadd(c, r, hx), f, hl), b3 = vadd(vadd(c, r, -hx), f, hl);
  const ap = vadd(c, u, sz[1]);
  emit(out, [b0, b1, ap], col, ref); emit(out, [b1, b2, ap], col, ref);
  emit(out, [b2, b3, ap], col, ref); emit(out, [b3, b0, ap], col, ref);
}

/** Cone: n-gon base radius `rad` up to an apex at `h`. geom.js:209 */
export function addCone(out: GeomOut, c: RV3, rad: number, h: number, col: RV3, seg?: number | null, basis?: Basis | null): void {
  seg = seg || 8;
  const r = basis ? basis[0] : [1, 0, 0] as const, u = basis ? basis[1] : [0, 1, 0] as const, f = basis ? basis[2] : [0, 0, 1] as const;
  const ap = vadd(c, u, h), ref = vadd(c, u, h * 0.35);
  const ring = (a: number) => vadd(vadd(c, r, __M.cos(a) * rad), f, __M.sin(a) * rad);
  for (let i = 0; i < seg; i++) {
    const p0 = ring(i / seg * 6.2832), p1 = ring((i + 1) / seg * 6.2832);
    emit(out, [p0, p1, ap], col, ref);
  }
}

/** Cylinder: n-gon column radius `rad`, height `h`, with a top cap. geom.js:221 */
export function addCyl(out: GeomOut, c: RV3, rad: number, h: number, col: RV3, seg?: number | null, basis?: Basis | null): void {
  seg = seg || 8;
  const r = basis ? basis[0] : [1, 0, 0] as const, u = basis ? basis[1] : [0, 1, 0] as const, f = basis ? basis[2] : [0, 0, 1] as const;
  const ref = vadd(c, u, h * 0.5), top = vadd(c, u, h);
  const lo = (a: number) => vadd(vadd(c, r, __M.cos(a) * rad), f, __M.sin(a) * rad);
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * 6.2832, a1 = (i + 1) / seg * 6.2832;
    const p0 = lo(a0), p1 = lo(a1), q0 = vadd(p0, u, h), q1 = vadd(p1, u, h);
    emit(out, [p0, p1, q1, q0], col, ref);
    emit(out, [q0, q1, top], col, ref);
  }
}

/** geom.js:235 */
export function addFrustum(out: GeomOut, c: RV3, rBase: number, rTop: number, h: number, col: RV3, seg?: number | null, basis?: Basis | null): void {
  seg = seg || 8;
  const r = basis ? basis[0] : [1, 0, 0] as const, u = basis ? basis[1] : [0, 1, 0] as const, f = basis ? basis[2] : [0, 0, 1] as const;
  const ref = vadd(c, u, h * 0.5);
  const lo = (a: number) => vadd(vadd(c, r, __M.cos(a) * rBase), f, __M.sin(a) * rBase);
  const hi = (a: number) => vadd(vadd(vadd(c, u, h), r, __M.cos(a) * rTop), f, __M.sin(a) * rTop);
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * 6.2832, a1 = (i + 1) / seg * 6.2832;
    const p0 = lo(a0), p1 = lo(a1), q0 = hi(a0), q1 = hi(a1);
    emit(out, [p0, p1, q1, q0], col, ref);
  }
}

export interface MountainOpts {
  seg?: number;
  seed?: number;
  rough?: number;
  forest?: RV3;
  rock?: RV3;
  snow?: RV3;
  snowline?: number;
  lowMat?: number;
  right?: RV3;
  fwd?: RV3;
  profile?: "cone" | "massif";
  stretch?: number;
  crest?: number;
}

/** geom.js:248 */
export function addMountain(out: GeomOut, c: RV3, baseR: number, h: number, opts?: MountainOpts | null): void {
  const o = opts || {};
  const seg = o.seg || 10, seed = o.seed || 0, rough = o.rough != null ? o.rough : 0.34;
  const forest = o.forest || [0.22, 0.38, 0.22];
  const rock = o.rock || [0.40, 0.38, 0.36];
  const snow = o.snow || [0.93, 0.95, 0.99];
  const snowline = o.snowline != null ? o.snowline : 0.62;
  const lowMat = o.lowMat != null ? o.lowMat : MAT.FOLIAGE;
  const rx = o.right || [1, 0, 0], fz = o.fwd || [0, 0, 1];
  const h2 = (a: number, b: number) => { const x = __M.sin(a * 12.9898 + b * 78.233 + seed * 0.137) * 43758.5453; return x - __M.floor(x); };
  const ridgeOff: number[] = [];
  for (let i = 0; i < seg; i++) ridgeOff.push(h2(i, 7) - 0.5);
  const PROFILES: Record<string, readonly (readonly [number, number])[]> = {
    cone: [[0, 1], [0.38, 0.64], [0.70, 0.34]],
    massif: [[0, 1], [0.16, 0.86], [0.38, 0.68], [0.62, 0.46], [0.82, 0.27]],
  };
  const rings = (o.profile && PROFILES[o.profile]) || PROFILES.cone!;
  const stretch = o.stretch != null && o.stretch > 0 ? o.stretch : 1;
  const crest = o.crest != null ? Math.max(0, Math.min(1, o.crest)) : 0;
  const lastHf = rings[rings.length - 1]![0];
  const pt = (hf: number, rf: number, i: number): V3 => {
    const a = i / seg * 6.2832;
    const rad = baseR * rf * (1 + ridgeOff[i]! * rough * 1.4) * (1 + (h2(i, hf * 97 + 3) - 0.5) * rough * 0.7);
    const y = h * (hf + (h2(i, hf * 97 + 9) - 0.5) * rough * 0.12);
    const rr = hf === lastHf ? rad * (1 + crest * 0.8) : rad, co = __M.cos(a), si = __M.sin(a);
    return [c[0] + rx[0] * co * rr + fz[0] * si * rr * stretch, c[1] + y, c[2] + rx[2] * co * rr + fz[2] * si * rr * stretch];
  };
  const ref: V3 = [c[0], c[1] + h * 0.4, c[2]];
  const zoneAt = (fy: number, i: number): number => {
    const fr = fy / h + (h2(i, 99) - 0.5) * 0.07;
    if (fr > snowline + 0.04) return MAT.SNOW;
    if (fr > snowline - 0.16) return MAT.ROCK;
    if (fr > 0.34) return MAT.ROCK;
    return lowMat;
  };
  const colAt = (fy: number, i: number): RV3 => {
    const fr = fy / h + (h2(i, 99) - 0.5) * 0.07;
    if (fr > snowline + 0.04) return snow;
    if (fr > snowline - 0.16) return [(rock[0] + snow[0]) / 2, (rock[1] + snow[1]) / 2, (rock[2] + snow[2]) / 2];
    if (fr > 0.34) return rock;
    const j = 0.88 + 0.24 * h2(i, 21);
    return [forest[0] * j, forest[1] * j, forest[2] * j];
  };
  const V = rings.map(([hf, rf]) => { const row: V3[] = []; for (let i = 0; i < seg; i++) row.push(pt(hf, rf, i)); return row; });
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < seg; i++) {
      const a = V[r]![i]!, b = V[r]![(i + 1) % seg]!, cc = V[r + 1]![(i + 1) % seg]!, d = V[r + 1]![i]!;
      const fy = (a[1] + b[1] + cc[1] + d[1]) / 4 - c[1];
      out._mat = zoneAt(fy, i + r);
      emit(out, [a, b, cc, d], colAt(fy, i + r), ref);
    }
  }
  const apex: V3 = [c[0] + (h2(1, 1) - 0.5) * baseR * 0.14, c[1] + h * (0.97 + h2(2, 2) * 0.06), c[2] + (h2(3, 3) - 0.5) * baseR * 0.14];
  const tr = rings.length - 1;
  for (let i = 0; i < seg; i++) {
    const a = V[tr]![i]!, b = V[tr]![(i + 1) % seg]!;
    const fy = (a[1] + b[1] + apex[1]) / 3 - c[1];
    out._mat = zoneAt(fy, i);
    emit(out, [a, b, apex], colAt(fy, i), ref);
  }
  out._mat = 0;
}

/** A baked model's buffers (js/render/shared/assets.js pack shape). */
export interface MeshData {
  pos: ArrayLike<number>;
  idx: ArrayLike<number>;
  nrm?: ArrayLike<number> | null;
  col?: ArrayLike<number> | null;
  mat?: ArrayLike<number> | null;
}

export interface AddMeshOpts {
  x?: number;
  y?: number;
  z?: number;
  scale?: number;
  rotY?: number;
  tint?: RV3 | null;
  mat?: number | null;
}

/** Stamp a baked model: uniform scale, yaw about +Y, translate. geom.js:323 */
export function addMesh(out: GeomOut, mesh: MeshData | null | undefined, opts?: AddMeshOpts | null): boolean {
  if (!mesh || !mesh.pos || !mesh.idx || !mesh.pos.length) return false;
  const o = opts || {};
  const bad = (v: number | undefined) => v != null && !isFinite(v);
  if (bad(o.x) || bad(o.y) || bad(o.z) || bad(o.scale) || bad(o.rotY)) return false;
  const s = o.scale != null ? o.scale : 1;
  const x = o.x || 0, y = o.y || 0, z = o.z || 0;
  const ry = o.rotY || 0, cs = Math.cos(ry), sn = Math.sin(ry);
  const tint = o.tint || null;
  const nv = mesh.pos.length / 3;
  const base = out.pos.length / 3;
  const mm = out.mat;
  const forced = o.mat != null ? o.mat : null;
  const fallback = out._mat || 0;
  const P = mesh.pos, N = mesh.nrm, C = mesh.col, Mt = mesh.mat;
  for (let i = 0; i < nv; i++) {
    const px = P[i * 3]! * s, py = P[i * 3 + 1]! * s, pz = P[i * 3 + 2]! * s;
    out.pos.push(px * cs + pz * sn + x, py + y, -px * sn + pz * cs + z);
    const nx = N ? N[i * 3]! : 0;
    const ny = N ? N[i * 3 + 1]! : 1;
    const nz = N ? N[i * 3 + 2]! : 0;
    out.nrm.push(nx * cs + nz * sn, ny, -nx * sn + nz * cs);
    const cr = C ? C[i * 3]! : 0.7;
    const cg = C ? C[i * 3 + 1]! : 0.7;
    const cb = C ? C[i * 3 + 2]! : 0.7;
    if (tint) out.col.push(cr * tint[0], cg * tint[1], cb * tint[2]);
    else out.col.push(cr, cg, cb);
    if (mm) mm.push(forced != null ? forced : (Mt ? Mt[i]! : fallback));
  }
  for (let i = 0; i < mesh.idx.length; i++) out.idx.push(base + mesh.idx[i]!);
  return true;
}

/** Smallest same-facing plane separation that does not z-fight within 388 m. geom.js:360 */
export const MIN_SEP = 0.03;
/** Per-call nudges for emitters whose calls can share a plane. geom.js:366 */
export const SEP_SLOTS: readonly number[] = Object.freeze([0.035, 0.065, 0.135, 0.165]);
