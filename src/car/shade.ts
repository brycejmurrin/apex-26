// Rounded body sections and smooth shading for the procedural car. Ported verbatim
// from f1-game js/car/car-shade.js:50-858 (the `CarShade` IIFE); its module-level
// smoothing pref is module-level state here.
//
//   ROUNDED SECTIONS (loft): car3d's {z, y, w, h, t, x} span station swept as a
//   superellipse instead of a trapezoid. The ENVELOPE is the trapezoid's (top and
//   bottom centres, flank at mid-height), so a stripe, number or light placed on a
//   panel centre still sits on the skin. Only the corners pull in.
//   SMOOTH SHADING (smooth): vertices at the same position and surface average the
//   normals of the faces that meet there within a crease angle. Normals only.
//   ROUNDED SIDEPODS (podLoft), SHADED TYRE SHOULDERS (vertexNormals), COKE BOTTLE +
//   DOWNWASH (downwash/cokeFoot/coverLoft), SMALL PARTS (skin/pipe/strut/block/...).
//
// THE SWITCH (car-shade.js:43). `a26.carSmooth` in storage (f1-game: apex26.carSmooth),
// or `?carsmooth=` in the URL (the URL wins for that page load): "1" / "all" for every
// car, a team id for that team's car only, "0" / "off" for none. Nothing chosen is the
// DEFAULT, every car, so an opt-out is stored as "0" rather than removed. Read once per
// page; set() saves it (the meshes rebuild on the next page load).
import type { ColArg, Station, SurfaceArg } from "./geometry";
import type { MVec3, MeshOut, Vec3 } from "./types";

/** car3d's addTri (car-geometry.js:20): `tri(out, a, b, c, col, surface)`. */
export type TriFn = (out: MeshOut, a: Vec3, b: Vec3, c: Vec3, col: Vec3, surface?: SurfaceArg) => void;
type P2 = [number, number];
type Ring = readonly Vec3[];

export const KEY = "a26.carSmooth";
const DEFAULT = "*";
let _pref: string | null | undefined;   // undefined = not read yet; null = off; "*" = every car; else a team id

// car-shade.js:55
function norm(v: unknown): string | null {
  const s = v == null ? "" : String(v).trim().toLowerCase();
  if (!s) return DEFAULT;   // nothing chosen
  if (s === "1" || s === "all" || s === "on" || s === "true") return "*";
  if (s === "0" || s === "off" || s === "false") return null;
  return /^[a-z0-9_-]{1,40}$/.test(s) ? s : DEFAULT;
}
export function pref(): string | null {
  if (_pref !== undefined) return _pref;
  let v: string | null = null;
  try {
    const q = typeof location !== "undefined" && location.search ? new URLSearchParams(location.search) : null;
    if (q && q.has("carsmooth")) v = q.get("carsmooth");
    else if (typeof localStorage !== "undefined") v = localStorage.getItem(KEY);
  } catch (_) { v = null; }
  _pref = norm(v);
  return _pref;
}
/** Set the switch ("1", a team id, "0" for off, or null/"" back to the default) and
 *  save it. Returns what took effect (car-shade.js:75). */
export function set(v: unknown): string | null {
  _pref = norm(v);
  const empty = v == null || !String(v).trim();
  try {
    if (typeof localStorage !== "undefined") {
      if (empty) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, _pref === "*" ? "1" : _pref || "0");
    }
  } catch (_) { /* storage refused: live for this page only */ }
  return _pref;
}
/** Is it on for this team's car? */
export function on(teamId?: string | null): boolean { const p = pref(); return p === "*" || (!!p && p === teamId); }
/** On for ANY car: wheels are built and cached apart from teams, so they follow the switch whenever it is on. */
export function any(): boolean { return !!pref(); }

// Points round a ROUNDED TRAPEZOID (car-shade.js:91): |u|^p + |v|^p = 1, then the
// half-width tapers from w/2 at the bottom to t*w/2 at the top exactly as frame() does.
// Counter-clockwise seen from +Z, starting at the right flank (mid-height).
export const RING_N = 24, EXP = 3;
// The UPPER half is squarer: a real nose and tub are flat-topped with rounded
// shoulders. Both halves meet at the flank (u = ±1, v = 0), so the envelope is
// unchanged; the sharpest step at 24 points is ~29°, inside smooth()'s 55° crease.
export const EXP_TOP = 6;
/** A ring() section: car3d's span station; x and t optional. */
export type Section = Pick<Station, "z" | "y" | "w" | "h"> & { t?: number | undefined; x?: number | undefined };
// One point of the section at angle `a` (0 = right flank, pi/2 = top centre).
function ringAt(f: Section, a: number, p: number, pt: number): MVec3 {
  const x0 = f.x || 0, hw = f.w / 2, hh = f.h / 2, t = f.t !== undefined ? f.t : 1;
  const snap = (x: number) => (Math.abs(x) < 1e-9 ? 0 : x);   // cos(pi/2) is 6e-17, not 0
  const c = snap(Math.cos(a)), s = snap(Math.sin(a)), e = 2 / (s > 0 ? pt : p);
  const u = Math.sign(c) * Math.pow(Math.abs(c), e), v = Math.sign(s) * Math.pow(Math.abs(s), e);
  return [x0 + u * hw * (1 + (t - 1) * (v + 1) / 2), f.y + v * hh, f.z];
}
export function ring(f: Section, n?: number, p?: number, pt?: number): MVec3[] {
  n = n || RING_N; p = p || EXP; pt = pt || EXP_TOP;
  const pts: MVec3[] = [];
  for (let i = 0; i < n; i++) pts.push(ringAt(f, (i / n) * Math.PI * 2, p, pt));
  return pts;
}
/** car3d nose anchor fields sink/capLoft read. */
export interface NoseAnchor { top: number; bottom: number; topSide: number; side: number }
/** How far the rounded top has fallen at half-width `halfW` of a car3d nose anchor:
 *  sink a flat plate this much and its edges sit on the skin (car-shade.js:118). */
export function sink(st: Pick<NoseAnchor, "top" | "bottom" | "topSide">, halfW: number): number {
  const k = Math.min(1, Math.abs(halfW) / st.topSide), hh = (st.top - st.bottom) / 2;
  return hh * (1 - Math.pow(1 - Math.pow(k, EXP_TOP), 1 / EXP_TOP));
}
/** A livery cap over the rounded nose: the body section at each end, grown by the
 *  cap's own margin; `nf`/`nr` the nose anchors (topSide/side is the taper) (car-shade.js:126). */
export function capLoft(out: MeshOut, front: Section, rear: Section, nf: Pick<NoseAnchor, "topSide" | "side">,
                        nr: Pick<NoseAnchor, "topSide" | "side">, col: Vec3, tri: TriFn): void {
  loft(out, Object.assign({}, front, { t: nf.topSide / nf.side }), Object.assign({}, rear, { t: nr.topSide / nr.side }), col, tri);
}
export interface LoftOpts { n?: number; p?: number; pt?: number; surface?: SurfaceArg; frontCol?: ColArg }
/** Loft `front` to `rear` with rounded sections and both ends capped (car-shade.js:133).
 *  opts.frontCol paints the front (+Z) cap (an intake mouth), opts.surface the surface id. */
export function loft(out: MeshOut, front: Section, rear: Section, col: Vec3, tri: TriFn, opts?: LoftOpts | null): void {
  const n = (opts && opts.n) || RING_N, p = (opts && opts.p) || EXP, pt = (opts && opts.pt) || EXP_TOP;
  const sf = opts && opts.surface, fc = (opts && opts.frontCol) || col;
  const F = ring(front, n, p, pt), R = ring(rear, n, p, pt);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(out, F[i]!, R[i]!, R[j]!, col, sf);
    tri(out, F[i]!, R[j]!, F[j]!, col, sf);
  }
  const cf: Vec3 = [front.x || 0, front.y, front.z], cr: Vec3 = [rear.x || 0, rear.y, rear.z];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(out, cf, F[i]!, F[j]!, fc, sf);   // +Z
    tri(out, cr, R[j]!, R[i]!, col, sf);  // -Z
  }
}

// ---- SMALL PARTS (car-shade.js:150): struts, rounded blocks, plates ----
// Each helper takes car3d's own datums (its corners, its stations, its addTri) and
// keeps their ENVELOPE, so a decal, light or part placed against the old box still
// lands on the new skin.
const sub = (a: Vec3, b: Vec3): MVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a: Vec3, b: Vec3): MVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): MVec3 | null => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null; };
const mix = (a: Vec3, b: Vec3, t: number): MVec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mid = (r: Ring): MVec3 => r.reduce<MVec3>((m, p) => [m[0] + p[0] / r.length, m[1] + p[1] / r.length, m[2] + p[2] / r.length], [0, 0, 0]);
function newell(r: Ring): MVec3 {   // polygon normal, length = twice its area
  const N: MVec3 = [0, 0, 0];
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!, b = r[(i + 1) % r.length]!;
    N[0] += (a[1] - b[1]) * (a[2] + b[2]); N[1] += (a[2] - b[2]) * (a[0] + b[0]); N[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return N;
}
// A triangle with no area would carry a zero normal (and fail every unit-normal
// check downstream), so it is never emitted.
function face(out: MeshOut, a: Vec3, b: Vec3, c: Vec3, col: Vec3, tri: TriFn, sf?: SurfaceArg): void {
  if (len(crs(sub(b, a), sub(c, a))) > 1e-12) tri(out, a, b, c, col, sf);
}
/** Ear-clip a simple planar polygon (convex or not: a C, an arch) into index triples
 *  wound like the polygon (car-shade.js:178). */
export function earcut(r: Ring): [number, number, number][] {
  const N = newell(r), A = N.map(Math.abs) as MVec3;
  const ax = A[0] >= A[1] ? (A[0] >= A[2] ? 0 : 2) : (A[1] >= A[2] ? 1 : 2), sg = N[ax] >= 0 ? 1 : -1;
  const P = r.map((p): P2 => [p[(ax + 1) % 3]!, p[(ax + 2) % 3]! * sg]), idx = r.map((_, i) => i), tris: [number, number, number][] = [];
  const cr = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const same = (a: P2, b: P2) => Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
  while (idx.length > 3) {
    const n = idx.length;
    let cut = 0;
    for (let k = 0; k < n; k++) {
      const a = P[idx[(k + n - 1) % n]!]!, b = P[idx[k]!]!, c = P[idx[(k + 1) % n]!]!;
      if (cr(a, b, c) <= 1e-14) continue;   // reflex (or flat): not an ear
      const blocked = idx.some((m) => { const q = P[m]!;
        return !same(q, a) && !same(q, b) && !same(q, c) && cr(a, b, q) > 1e-14 && cr(b, c, q) > 1e-14 && cr(c, a, q) > 1e-14; });
      if (!blocked) { cut = k; break; }
    }
    tris.push([idx[(cut + n - 1) % n]!, idx[cut]!, idx[(cut + 1) % n]!]);
    idx.splice(cut, 1);
  }
  tris.push(idx as [number, number, number]);
  return tris;
}
export interface SkinOpts { frontCol?: ColArg; caps?: boolean; segCol?: ((i: number) => Vec3) | undefined }
/** Loft closed rings (equal counts, any one winding) into a skin that faces OUT, both
 *  ends capped by earcut (car-shade.js:203). o: {frontCol (rings[0]'s cap), caps:
 *  false, segCol(i) (colour of the strip from ring point i to i+1)}. */
export function skin(out: MeshOut, rings: readonly Ring[], col: Vec3, tri: TriFn, sf?: SurfaceArg, o?: SkinOpts | null): void {
  o = o || {};
  const n = rings[0]!.length, last = rings.length - 1;
  // Directions are LOCAL (ring 0 -> 1, last-1 -> last): a path that bends back on
  // itself (the headrest's U) has its ends side by side.
  const d0 = sub(mid(rings[1]!), mid(rings[0]!)), d1 = sub(mid(rings[last]!), mid(rings[last - 1]!));
  const flip = dot(newell(rings[0]!), d0) > 0;   // the rings wind the other way round the loft
  for (let r = 0; r < last; r++) {
    const F = rings[r]!, R = rings[r + 1]!;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, c = o.segCol ? o.segCol(i) : col;
      if (flip) { face(out, F[i]!, R[j]!, R[i]!, c, tri, sf); face(out, F[i]!, F[j]!, R[j]!, c, tri, sf); }
      else { face(out, F[i]!, R[i]!, R[j]!, c, tri, sf); face(out, F[i]!, R[j]!, F[j]!, c, tri, sf); }
    }
  }
  if (o.caps === false) return;
  const cap = (ring: Ring, c: Vec3, d: Vec3) => {   // the cap faces along d
    const keep = dot(newell(ring), d) > 0;
    for (const [a, b, e] of earcut(ring)) face(out, ring[a]!, keep ? ring[b]! : ring[e]!, keep ? ring[e]! : ring[b]!, c, tri, sf);
  };
  cap(rings[0]!, o.frontCol || col, d0.map((v) => -v) as MVec3);
  cap(rings[last]!, col, d1);
}
/** Unit superellipse, n points CCW from (1, 0): exponent pPos where v > 0, pNeg below. */
export function sect(n: number, pPos: number, pNeg: number): P2[] {
  const pts: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p = ringAt({ y: 0, z: 0, w: 2, h: 2 }, (i / n) * Math.PI * 2, pNeg, pPos);
    pts.push([p[0], p[1]]);
  }
  return pts;
}
export interface PipeOpts extends SkinOpts {
  chord: number; thick: number; chord1?: number | null | undefined; thick1?: number | null | undefined;
  n?: number | undefined; p?: number | undefined; pt?: number | undefined; up?: Vec3 | undefined;
}
/** Sweep a superellipse section along a polyline, OUT-facing and capped (car-shade.js:240).
 *  The CHORD lies along `up` (default +Z, the airstream) squared to the path and carried
 *  along it, the THICKNESS across; both may taper end to end. */
export function pipe(out: MeshOut, path: Ring, col: Vec3, tri: TriFn, sf: SurfaceArg, o: PipeOpts): void {
  const n = o.n || 8, S = sect(n, o.pt || o.p || 2, o.p || 2), L = [0];
  for (let i = 1; i < path.length; i++) L.push(L[i - 1]! + len(sub(path[i]!, path[i - 1]!)));
  const tot = L[L.length - 1] || 1, c1 = o.chord1 != null ? o.chord1 : o.chord, t1 = o.thick1 != null ? o.thick1 : o.thick;
  const off = (U: Vec3, T: Vec3) => unit(sub(U, T.map((x) => x * dot(U, T)) as MVec3));
  let U: Vec3 = o.up || [0, 0, 1];
  const rings = path.map((p, i) => {
    const T = unit(sub(path[Math.min(path.length - 1, i + 1)]!, path[Math.max(0, i - 1)]!)) || [0, 0, 1];
    U = off(U, T) || off([0, 1, 0], T) || off([1, 0, 0], T)!;
    const V = crs(T, U), f = L[i]! / tot;
    const ch = (o.chord + (c1 - o.chord) * f) / 2, th = (o.thick + (t1 - o.thick) * f) / 2;
    return S.map(([u, v]) => ([0, 1, 2] as const).map((k) => p[k] + U[k] * u * ch + V[k] * v * th) as MVec3);
  });
  skin(out, rings, col, tri, sf, o);
}
export interface StrutOpts extends Partial<Omit<PipeOpts, "chord" | "thick" | "chord1" | "thick1">> { taper?: number | null | undefined }
/** A STRUT from p0 to p1: pipe() on one segment, o.taper scaling the far end (car-shade.js:256). */
export function strut(out: MeshOut, p0: Vec3, p1: Vec3, chord: number, thick: number, col: Vec3, tri: TriFn,
                      sf?: SurfaceArg, o?: StrutOpts | null): void {
  o = o || {};
  const k = o.taper == null ? 1 : o.taper;
  pipe(out, [p0, p1], col, tri, sf, Object.assign({}, o, { chord, thick, chord1: chord * k, thick1: thick * k }));
}
/** Catmull-Rom through a polyline, k points per segment: original point i lands at
 *  index k * (i - from), so it still marks what it marked. `from` and `to` take a run
 *  of the points while the curve keeps bending with the neighbours outside it (car-shade.js:265). */
export function fine(path: Ring, k: number, from?: number, to?: number | null): MVec3[] {
  from = from || 0; to = to == null ? path.length : to;
  const last = path.length - 1;
  const P = (i: number): Vec3 => (i < 0 ? mix(path[0]!, path[1]!, -1) : i > last ? mix(path[last]!, path[last - 1]!, -1) : path[i]!);
  const pts: MVec3[] = [];
  for (let i = from; i < to - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      pts.push(([0, 1, 2] as const).map((a) => 0.5 * (2 * p1[a] + (p2[a] - p0[a]) * t +
        (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (3 * p1[a] - p0[a] - 3 * p2[a] + p3[a]) * t3)) as MVec3);
    }
  }
  pts.push(path[to - 1]!.slice() as MVec3);
  return pts;
}
// Corner radii as edge FRACTIONS [toward the previous corner, toward the next]
// (<= 0.5), measured on one quad and reused on its partner so both ends of a loft get
// the same point count. Infinity rounds all the way.
function fracs(q: Ring, r: number | readonly number[]): P2[] {
  const R = Array.isArray(r) ? r as readonly number[] : [r as number, r as number, r as number, r as number];
  return q.map((B, k): P2 => [Math.min(0.5, (R[k] || 0) / (len(sub(q[(k + 3) % 4]!, B)) || 1)),
                              Math.min(0.5, (R[k] || 0) / (len(sub(q[(k + 1) % 4]!, B)) || 1))]);
}
/** A quad with its corners rounded: a quadratic arc through each corner (seg steps);
 *  where two arcs meet mid-edge the point is emitted once (car-shade.js:291). */
export function rquad(q: Ring, fr: readonly (readonly [number, number])[], seg: number): MVec3[] {
  const pts: MVec3[] = [];
  for (let k = 0; k < 4; k++) {
    const A = q[(k + 3) % 4]!, B = q[k]!, C = q[(k + 1) % 4]!, [fa, fc] = fr[k]!;
    if (!(fa > 0) && !(fc > 0)) { pts.push(B.slice() as MVec3); continue; }
    const p0 = mix(B, A, fa), p2 = mix(B, C, fc), meets = fc >= 0.5 - 1e-9 && fr[(k + 1) % 4]![0] >= 0.5 - 1e-9;
    for (let j = 0; j <= seg - (meets ? 1 : 0); j++) { const t = j / seg; pts.push(mix(mix(p0, B, t), mix(B, p2, t), t)); }
  }
  return pts;
}
export interface BlockOpts extends SkinOpts { r?: number | readonly number[] | null | undefined; seg?: number | undefined }
/** car3d's addBlock (8 corners, q[0..3] the +Z end) with the section's corners rounded:
 *  o.r metres, one number or one per corner, default Infinity — a smooth section through
 *  the four edge MIDPOINTS, so every flat face's centre line stays where it was (car-shade.js:305). */
export function block(out: MeshOut, q: Ring, col: Vec3, tri: TriFn, sf?: SurfaceArg, o?: BlockOpts | null): void {
  o = o || {};
  const a = q.slice(0, 4), b = q.slice(4, 8), fr = fracs(a, o.r == null ? Infinity : o.r), seg = o.seg || 3;
  skin(out, [rquad(a, fr, seg), rquad(b, fr, seg)], col, tri, sf, o);
}
/** addBox's numbers as a rounded block lofted along z (corners rounded in x-y). */
export function box(out: MeshOut, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number,
                    col: Vec3, tri: TriFn, sf?: SurfaceArg, o?: BlockOpts | null): void {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, zf = cz + sz / 2, zr = cz - sz / 2;
  block(out, [[x0, y0, zf], [x1, y0, zf], [x1, y1, zf], [x0, y1, zf],
              [x0, y0, zr], [x1, y0, zr], [x1, y1, zr], [x0, y1, zr]], col, tri, sf, o);
}
/** addBox's own signature, rounded — a one-line swap at the call site (car-shade.js:318). */
export function boxFn(tri: TriFn, o?: BlockOpts | null) {
  return (out: MeshOut, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: Vec3, sf?: SurfaceArg) =>
    box(out, cx, cy, cz, sx, sy, sz, col, tri, sf, o);
}
/** addBlock's signature, rounded (o as block()). */
export function blockFn(tri: TriFn, o?: BlockOpts | null) {
  return (out: MeshOut, q: Ring, col: Vec3, colFront?: ColArg, sf?: SurfaceArg) =>
    block(out, q, col, tri, sf, Object.assign({ frontCol: colFront }, o));
}

/** A MIRROR HOUSING from car3d's addBlock corners (q[0], q[1]: the back face's inboard
 *  and outboard bottom, q[3] inboard top, q[4], q[5] the front face): lofted along x, a
 *  flat back for the glass and a rounded nose, the toe kept. The outboard end still sits
 *  at the old x across mid-height, where the mirror light anchors (car-shade.js:328). */
export function housing(out: MeshOut, q: Ring, col: Vec3, tri: TriFn, sf?: SurfaceArg): void {
  const S = sect(12, 6, 2.6), y0 = q[0]![1], y1 = q[3]![1];
  skin(out, ([[0, 0.80], [0.14, 1], [0.86, 1], [1, 0.90]] as const).map(([f, k]) => {
    const x = q[0]![0] + (q[1]![0] - q[0]![0]) * f;
    const zb = q[0]![2] + (q[1]![2] - q[0]![2]) * f, zf = q[4]![2] + (q[5]![2] - q[4]![2]) * f;
    const cy = (y0 + y1) / 2, hy = (y1 - y0) / 2 * k, cz = (zb + zf) / 2, hz = (zf - zb) / 2 * k;
    return S.map(([u, v]): Vec3 => [x, cy + u * hy, cz - v * hz]);   // v > 0 is the flat back (-z)
  }), col, tri, sf);
}
/** cTub station: a span station plus the opening half-width and the rail-top y. */
export interface TubStation extends Section { open: number; rail: number }
/** The COCKPIT TUB beside and under the opening (car-shade.js:344): per station the
 *  ring() of the rail trapezoid with the opening (|x| < open above the seat floor) cut
 *  out of it, a C, lofted and capped. The top half is flatter (exponent 10) so the
 *  coaming sits on the rail. */
export function cTub(out: MeshOut, stations: readonly TubStation[], floorY: number, col: Vec3, tri: TriFn): void {
  const M = 22, PT = 10;
  skin(out, stations.map((st) => {
    const bot = st.y - st.h / 2, f: Section = { z: st.z, y: (bot + st.rail) / 2, w: st.w, h: st.rail - bot, t: st.t };
    let lo = 0, hi = Math.PI / 2;   // where the rail top meets the opening: x falls from flank to top centre
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (ringAt(f, m, EXP, PT)[0] > st.open) lo = m; else hi = m; }
    const pts: MVec3[] = [];
    for (let i = 0; i < M; i++) pts.push(ringAt(f, Math.PI - lo + (i / (M - 1)) * (Math.PI + 2 * lo), EXP, PT));
    // The seat floor (car3d's dark floor loft) tops out AT floorY: 2 mm under it, or the two z-fight.
    return pts.concat([[st.open, floorY - 0.002, st.z], [-st.open, floorY - 0.002, st.z]]);
  }), col, tri);
}
/** CHASSIS.floor's box numbers floor() reads. */
export interface FloorBox { cz: number; sz: number; sy: number }
/** The FLOOR as a plan shape instead of CHASSIS.floor's box (car-shade.js:361):
 *  half-width edgeAt(z) (car3d floorEdgeAt), rounded front corners, and held inboard of
 *  the rear tyre's inner face (x 0.57) over its length. Same datum: front, rear, thickness. */
export function floor(out: MeshOut, fl: FloorBox, cy: number, edgeAt: (z: number) => number, col: Vec3, tri: TriFn, sf?: SurfaceArg): void {
  const zF = fl.cz + fl.sz / 2, zR = fl.cz - fl.sz / 2, y0 = cy - fl.sy / 2, y1 = cy + fl.sy / 2, R = 0.15, TYRE = 0.555;
  const cap = (z: number) => (z < -1.30 ? TYRE : z < -1.15 ? TYRE + (z + 1.30) / 0.15 * 0.15 : Infinity);
  const hw = (z: number) => Math.min(edgeAt(z), cap(z)) - (z > zF - R ? R - Math.sqrt(Math.max(0, R * R - (z - zF + R) ** 2)) : 0);
  const zs = [0, 1, 2, 3, 4].map((k) => zF - R * (1 - Math.cos(k * Math.PI / 8)))
    .concat([0.78, 0.40, 0, -0.40, -0.80, -1.15, -1.30, -1.60, zR]).filter((z) => z <= zF && z >= zR);
  const S = zs.sort((a, b) => b - a).map((z): P2 => [z, hw(z)]);
  const q = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, want: Vec3) => {   // a quad facing `want`
    const k = dot(crs(sub(b, a), sub(c, a)), want) < 0;
    face(out, a, k ? c : b, k ? b : c, col, tri, sf); face(out, a, k ? d : c, k ? c : d, col, tri, sf);
  };
  for (let i = 0; i < S.length - 1; i++) {
    const [za, ha] = S[i]!, [zb, hb] = S[i + 1]!;
    q([-ha, y1, za], [ha, y1, za], [hb, y1, zb], [-hb, y1, zb], [0, 1, 0]);
    q([-ha, y0, za], [ha, y0, za], [hb, y0, zb], [-hb, y0, zb], [0, -1, 0]);
    for (const s of [-1, 1]) q([s * ha, y0, za], [s * ha, y1, za], [s * hb, y1, zb], [s * hb, y0, zb], [s * (za - zb), 0, hb - ha]);
  }
  const [zf0, hf] = S[0]!, [zr0, hr] = S[S.length - 1]!;
  q([-hf, y0, zf0], [hf, y0, zf0], [hf, y1, zf0], [-hf, y1, zf0], [0, 0, 1]);
  q([-hr, y0, zr0], [hr, y0, zr0], [hr, y1, zr0], [-hr, y1, zr0], [0, 0, -1]);
}
/** car3d endplateGeom `ep` fields endplate() reads. */
export interface EndplateEdge { z: number; top: number; bottom: number }
export interface EndplateGeom { front: EndplateEdge; rear: EndplateEdge }
/** A REAR-WING ENDPLATE (car3d endplateGeom `ep`, side s), car-shade.js:389: the plate
 *  as an outline with rounded corners — the big radii low, where the wing is not — 33 mm
 *  thick, and its accent crown swept over the top edge and round both top corners. Kept:
 *  the number board's footprint, the outer face the board sits on (x 0.521), the rear
 *  face across y 0.62 at every level (the endplate light), and the crown's height. */
export function endplate(out: MeshOut, ep: EndplateGeom, s: number, col: Vec3, crownCol: Vec3, crownSurf: SurfaceArg, tri: TriFn): void {
  const X0 = 0.488, X1 = 0.521, f = ep.front, r = ep.rear, seg = 4;
  const q = (x: number, e: number): Vec3[] => [[s * x, f.bottom, f.z - e], [s * x, f.top, f.z - e], [s * x, r.top, r.z + e], [s * x, r.bottom, r.z + e]];
  // Radii front-bottom, front-top, rear-top, rear-bottom. Cap rear radii so the
  // endplate light (y 0.62 ± 0.017) stays on the rear face: level 4's tall plate needs
  // the bottom cap, and the tier-0 plank (rear.top ≈ tyre crown) needs the top cap.
  const lightLo = 0.603, lightHi = 0.637;
  const rBot = Math.max(0.02, Math.min(0.07, lightLo - r.bottom - 0.01));
  const rTop = Math.max(0.015, Math.min(0.04, r.top - lightHi - 0.01));
  const fr = fracs(q(X1, 0), [0.10, 0.07, rTop, rBot]), CT = 0.018;
  skin(out, [rquad(q(X1, 0), fr, seg), rquad(q(X0, 0), fr, seg)], col, tri);
  // The crown straddles the top edge as the flat strip did (y top +- 9 mm), its ends
  // inset half its thickness so they finish flush with the plate's edges.
  pipe(out, rquad(q((X0 + X1) / 2, CT / 2), fr, seg).slice(seg + 1, 3 * (seg + 1)), crownCol, tri, crownSurf,
       { chord: 0.046, thick: CT, n: 6, p: 4, up: [1, 0, 0] });
}
/** One DIFFUSER TUNNEL (side s), car-shade.js:411: the ramped ceiling and the outer wall
 *  as ONE curved shell — the roof turns down into the wall through a radius of 0.4 x the
 *  tunnel's smaller dimension — from the throat (z -1.95) to the exit (z -2.52). Inner
 *  face in `inCol`, the outside in `col`. */
export function tunnel(out: MeshOut, s: number, keel: number, thr: number, exitHalf: number, yFloor: number, yThroat: number,
                       yExit: number, inCol: Vec3, col: Vec3, tri: TriFn, sf?: SurfaceArg): void {
  const T = 0.03, seg = 5, m = seg + 3;
  const ring = (z: number, xo: number, yc: number): MVec3[] => {
    const A: P2 = [s * keel, yc], B: P2 = [s * xo, yc], C: P2 = [s * xo, yFloor], r = 0.4 * Math.min(xo - keel, yc - yFloor);
    const p0: P2 = [B[0] - s * r, yc], p2: P2 = [B[0], yc - r], P: P2[] = [A];
    for (let j = 0; j <= seg; j++) { const t = j / seg, u = 1 - t; P.push([u * u * p0[0] + 2 * u * t * B[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * B[1] + t * t * p2[1]]); }
    P.push(C);
    const Q = P.map((p, i): P2 => {   // the outer skin: T out along the profile's normal (up on the roof, outboard on the wall)
      const a = P[Math.max(0, i - 1)]!, b = P[Math.min(P.length - 1, i + 1)]!, dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [p[0] - s * T * dy / l, p[1] + s * T * dx / l];
    });
    return P.concat(Q.reverse()).map(([x, y]): MVec3 => [x, y, z]);
  };
  skin(out, [ring(-1.95, thr, yThroat), ring(-2.52, exitHalf, yExit)], col, tri, sf, { segCol: (i) => (i < m - 1 ? inCol : col) });
}
/** The HEADREST (car-shade.js:435): a horseshoe pad round the back of the helmet (car3d
 *  draws the head at (0, 0.715, -0.075), r 0.145), sitting on the cockpit coaming.
 *  `style` mirrors car3d's recipe headrest: 0 coaming hoop only / 1 raised horseshoe
 *  bolster / 2 winged bolster, all as pipes. */
export function headrest(out: MeshOut, col: Vec3, tri: TriFn, sf?: SurfaceArg, style?: number | null): void {
  const st = Math.max(0, Math.min(2, style == null ? 0 : style | 0));
  const half: Vec3[] = [[0.205, 0.640, 0.02], [0.208, 0.650, -0.08], [0.196, 0.660, -0.17], [0.150, 0.666, -0.245], [0.078, 0.669, -0.285]];
  const path = half.map(([x, y, z]): Vec3 => [-x, y, z]).concat([[0, 0.670, -0.298]], half.slice().reverse());
  // Style 0 keeps the thin dark coaming hoop; 1–2 thicken it into the carbon bolster.
  const chord = st === 0 ? 0.075 : st === 1 ? 0.092 : 0.108;
  const thick = st === 0 ? 0.055 : st === 1 ? 0.068 : 0.082;
  pipe(out, fine(path, 2), col, tri, sf, { chord, thick, n: 8, p: 2.5, up: [0, 1, 0] });
  if (st < 1) return;
  // Side bolsters forward of the horseshoe, clear of the helmet dome (r 0.145).
  for (const s of [-1, 1]) {
    const wing: Vec3[] = st === 1
      ? [[s * 0.200, 0.645, -0.04], [s * 0.200, 0.645, -0.16], [s * 0.200, 0.645, -0.28]]
      : [[s * 0.210, 0.670, -0.05], [s * 0.210, 0.678, -0.18], [s * 0.210, 0.685, -0.30]];
    pipe(out, fine(wing, 2), col, tri, sf, {
      chord: st === 1 ? 0.052 : 0.048, thick: st === 1 ? 0.055 : 0.060, n: 6, p: 2.5, up: [0, 1, 0],
    });
  }
  if (st < 2) return;
  // Upper cheek pads (winged recipe): short pipes above the side bolsters.
  for (const s of [-1, 1]) {
    pipe(out, fine([[s * 0.215, 0.700, -0.08], [s * 0.215, 0.705, -0.18]], 2), col, tri, sf, {
      chord: 0.036, thick: 0.024, n: 6, p: 2.5, up: [0, 1, 0],
    });
  }
}

// A SIDEPOD section (car-shade.js:462; car3d sidepodStations: inner/outer x, bottom/top
// y at each edge) with its two OUTER corners rounded. The radii bite mostly into the top
// and the underside and only the outer 12 % / 10 % of the flank, so the flank decal
// (32-80 % of its height) and every flank detail stay on flat skin. CCW from +Z.
const POD_ARC = 4;
/** car3d sidepodStations entry. */
export interface PodStation {
  z: number; inner: number; outer: number;
  innerBottom: number; innerTop: number; outerBottom: number; outerTop: number;
}
export function podRing(st: PodStation, side: number): MVec3[] {
  const w = st.outer - st.inner, hO = st.outerTop - st.outerBottom;
  const rxT = Math.min(0.07, 0.25 * w), ryT = Math.min(0.05, 0.12 * hO);
  const rxB = Math.min(0.06, 0.22 * w), ryB = Math.min(0.035, 0.10 * hO);
  const pts: P2[] = [[st.inner, st.innerBottom]];
  for (let k = 0; k <= POD_ARC; k++) {   // underside -> flank
    const a = -Math.PI / 2 + (k / POD_ARC) * Math.PI / 2;
    pts.push([st.outer - rxB + rxB * Math.cos(a), st.outerBottom + ryB + ryB * Math.sin(a)]);
  }
  for (let k = 0; k <= POD_ARC; k++) {   // flank -> top
    const a = (k / POD_ARC) * Math.PI / 2;
    pts.push([st.outer - rxT + rxT * Math.cos(a), st.outerTop - ryT + ryT * Math.sin(a)]);
  }
  pts.push([st.inner, st.innerTop]);
  const ring = pts.map(([x, y]): MVec3 => [side * x, y, st.z]);
  return side < 0 ? ring.reverse() : ring;
}
/** Loft closed rings front -> rear (each CCW from +Z, same count), capped: the front
 *  cap in `frontCol`, the rear in `col` (car-shade.js:489). */
export function loftRings(out: MeshOut, rings: readonly Ring[], col: Vec3, frontCol: ColArg, tri: TriFn): void {
  const n = rings[0]!.length;
  for (let r = 0; r < rings.length - 1; r++) {
    const F = rings[r]!, R = rings[r + 1]!;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tri(out, F[i]!, R[i]!, R[j]!, col);
      tri(out, F[i]!, R[j]!, F[j]!, col);
    }
  }
  const cap = (ring: Ring, c: Vec3, flip: boolean) => {
    const m: MVec3 = [0, 0, 0];
    for (const p of ring) { m[0] += p[0] / n; m[1] += p[1] / n; m[2] += p[2] / n; }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (flip) tri(out, m, ring[j]!, ring[i]!, c); else tri(out, m, ring[i]!, ring[j]!, c);
    }
  };
  cap(rings[0]!, frontCol || col, false);
  cap(rings[rings.length - 1]!, col, true);
}
/** Both sidepods from car3d's station list, rounded. */
export function podLoft(out: MeshOut, stations: readonly PodStation[], col: Vec3, frontCol: ColArg, tri: TriFn): void {
  for (const side of [-1, 1]) loftRings(out, stations.map((st) => podRing(st, side)), col, frontCol, tri);
}

// ---- COKE BOTTLE + DOWNWASH (car-shade.js:515) ----
// The engine recipe's `coke` knob (0.72-1.38) read as the downwash concept it stands
// for. car3d bodyAnchors(.., round) carries the shape, so everything mounted off
// podAt / coverAt / coverFlankX follows.
//
//   DOWNWASH RAMP (downwash): only station TOPS at z <= -0.38 move; no station is added
//   or moved, so every loft and flank span keeps its stop count.
//     r = clamp((coke - 0.95) / 0.35, 0, 1),   w(z) = 0 at -0.38 .. 1 at -1.48
//     outerTop = outerBottom + max(0.03, h  (1 - 0.75 r w))
//     innerTop = innerBottom + max(0.03, hi (1 - 0.50 r w)), never below the cover's
//                bottom + 0.01 (nor raised), so no slot opens between pod and cover.
//   It starts at -0.38 because everything ahead of it must not move: the sponsor board
//   and both pod decals (z 0.46..-0.34), and f1-game's parts-physics spec, which scores
//   the rounded car against FLAT bodyAnchors over z -0.40..0.50. Keep it there.
//
//   COKE PINCH (cokeFoot): the cover's FOOT half-width, t = 0 at the airbox (z -0.55)
//   .. 1 at the gearbox (-2.00):
//     xb = xF (1 - s) + xR s,  s = 1 - (1 - t)^p,  p = 1 + 2 max(0, coke - 0.9)
//   clamped to xb >= 0.76 x. Exact at t 0 and 1, only ever narrower than the linear x.
//
//   COVER LOFT (coverLoft): the cover as ONE closed skin through coverProfile at the
//   COVER_Z rings. car-mesh drapes the flank decal at the same rings, so the graphic
//   stays its 14 mm off the skin where one straight quad, a chord across the pinch,
//   stood up to 40 mm off it.
// Mid / far track LOD (field body, silhouette): the original nine rings.
export const COVER_Z = Object.freeze([-0.55, -0.66, -0.90, -1.13, -1.28, -1.47, -1.70, -1.90, -2.00]);
// Garage / near: same envelope + rings that tighten the taper into the rear wing.
// car-mesh drapes flank decals on COVER_Z; extras only refine the skin.
export const COVER_Z_NEAR = Object.freeze([
  -0.55, -0.66, -0.90, -1.13, -1.28, -1.47, -1.58, -1.70, -1.80, -1.90, -1.95, -2.00,
]);
/** Dense garage/near cross-section (car-shade.js:563): keys = [foot, shoulder, facet,
 *  crown]. A fuller quarter-ellipse shoulder→crown (the sparse polyline's chords are the
 *  boxy look); a light mid tug toward the facet keeps crest width near ±0.55x so mounted
 *  decals stay on the skin. */
export function densifyCoverPts(keys: readonly (readonly [number, number])[], n?: number | null): (readonly [number, number])[] {
  n = n == null ? 6 : n;
  const foot = keys[0]!, shoulder = keys[1]!, facet = keys[2]!, crown = keys[3]!;
  const pts: (readonly [number, number])[] = [foot, shoulder];
  // Inflate the ellipse slightly past the chord so the hump reads as round, not three
  // planks, under garage lighting.
  const rx = Math.max(1e-6, (shoulder[0] - crown[0]) * 1.12);
  const ry = Math.max(1e-6, (crown[1] - shoulder[1]) * 1.04);
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1), th = t * Math.PI * 0.5;
    let x = crown[0] + rx * Math.cos(th), y = shoulder[1] + ry * Math.sin(th);
    // Never wider than the shoulder or above the crown (envelope of the keys).
    x = Math.min(shoulder[0], Math.max(crown[0], x));
    y = Math.max(shoulder[1], Math.min(crown[1], y));
    if (t > 0.40 && t < 0.60) {
      const w = 1 - Math.abs(t - 0.5) / 0.10;
      x += (facet[0] - x) * 0.18 * w; y += (facet[1] - y) * 0.18 * w;
    }
    pts.push([x, y]);
  }
  pts.push(crown);
  return pts;
}
export const RAMP = Object.freeze({ from: -0.38, to: -1.48, coke: 0.95, span: 0.35, outer: 0.75, inner: 0.50, min: 0.03, gap: 0.01 });
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const cokeOf = (c: number | null | undefined) => Math.max(0.72, Math.min(1.38, c == null ? 1 : c));   // car3d sidepodStations' clamp
/** car3d sidepodStations with the downwash ramp: a NEW array of new stations (the input
 *  is not touched), or the input itself when coke gives no ramp (car-shade.js:592).
 *  coverBottomAt(z) is the engine cover's bottom y there. */
export function downwash<T extends PodStation>(stations: readonly T[], coverBottomAt: (z: number) => number,
                                                coke: number | null | undefined): readonly T[] {
  const r = clamp01((cokeOf(coke) - RAMP.coke) / RAMP.span);
  if (!(r > 0)) return stations;
  return stations.map((st) => {
    const k = r * clamp01((RAMP.from - st.z) / (RAMP.from - RAMP.to));
    if (!(k > 0)) return st;   // ahead of the ramp, and AT its start (-0.38): untouched, to the bit
    const ho = st.outerTop - st.outerBottom, hi = st.innerTop - st.innerBottom;
    const dropped = st.innerBottom + Math.max(RAMP.min, hi * (1 - RAMP.inner * k));
    return Object.assign({}, st, {
      outerTop: st.outerBottom + Math.max(RAMP.min, ho * (1 - RAMP.outer * k)),
      innerTop: Math.max(dropped, Math.min(st.innerTop, coverBottomAt(st.z) + RAMP.gap)),
    });
  });
}
/** A sampled cover anchor `c` ({z, x, bottom, top}) with its pinched foot `xb` added;
 *  `stations` are the cover's two end stations. Returned as is (no xb) when coke gives
 *  no pinch (car-shade.js:609). */
export function cokeFoot<T extends { z: number; x: number }>(c: T, stations: readonly { z: number; x: number }[],
                                                             coke: number | null | undefined): T & { xb?: number } {
  const p = 1 + 2 * Math.max(0, cokeOf(coke) - 0.9);
  if (!(p > 1)) return c;
  const F = stations[0]!, R = stations[stations.length - 1]!, t = clamp01((F.z - c.z) / (F.z - R.z));
  const s = 1 - Math.pow(1 - t, p);
  return Object.assign({}, c, { xb: Math.max(0.76 * c.x, F.x * (1 - s) + R.x * s) });
}
/** The ENGINE COVER from zF to zR as one closed skin (car-shade.js:620): per ring the
 *  section is car3d's coverProfile(…).pts — foot, shoulder, facet(s), crown on the right,
 *  mirrored — closed along the bottom. `o.zs` selects the ring table (COVER_Z mid/far,
 *  COVER_Z_NEAR garage/near); default COVER_Z. */
export function coverLoft<C>(out: MeshOut, anchors: { coverAt(z: number): C }, profile: (c: C) => { pts: readonly (readonly [number, number])[] },
                             zF: number, zR: number, col: Vec3, tri: TriFn, o?: { zs?: readonly number[] | undefined } | null): void {
  const table = (o && o.zs) || COVER_Z;
  const zs = [zF].concat(table.filter((z) => z < zF && z > zR), [zR]);
  skin(out, zs.map((z) => {
    const p = profile(anchors.coverAt(z)).pts;
    return p.map(([x, y]): Vec3 => [x, y, z]).concat(p.slice().reverse().map(([x, y]): Vec3 => [-x, y, z]));
  }), col, tri);
}

/** Smooth vertex normals from the faces of an INDEXED vertex range [from, to): the tyre
 *  tread, whose ring normals were purely radial, so its rounded shoulder never caught the
 *  light. Only triangles wholly inside the range (car-shade.js:632). */
export function vertexNormals(out: MeshOut, from: number, to: number): void {
  const P = out.pos, N = out.nrm, I = out.idx, acc = new Float64Array((to - from) * 3);
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t]!, b = I[t + 1]!, c = I[t + 2]!;
    if (a < from || a >= to || b < from || b >= to || c < from || c >= to) continue;
    const ux = P[b * 3]! - P[a * 3]!, uy = P[b * 3 + 1]! - P[a * 3 + 1]!, uz = P[b * 3 + 2]! - P[a * 3 + 2]!;
    const wx = P[c * 3]! - P[a * 3]!, wy = P[c * 3 + 1]! - P[a * 3 + 1]!, wz = P[c * 3 + 2]! - P[a * 3 + 2]!;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;   // area-weighted
    for (const v of [a, b, c]) { const k = (v - from) * 3; acc[k]! += nx; acc[k + 1]! += ny; acc[k + 2]! += nz; }
  }
  for (let v = from; v < to; v++) {
    const k = (v - from) * 3, l = Math.hypot(acc[k]!, acc[k + 1]!, acc[k + 2]!);
    if (l > 0) { N[v * 3] = acc[k]! / l; N[v * 3 + 1] = acc[k + 1]! / l; N[v * 3 + 2] = acc[k + 2]! / l; }
  }
}
// ---- UPPER/LOWER TWO-TONE (livery `lower` / `upper`, car-shade.js:647) ----
// A second body colour on one side of a line along the sidepods and on forward along
// the monocoque side:
//   y(z) = podAt(z).bottom + 0.80 (top - bottom),  z -2.00 .. +1.05
// straight between pod stations, held at the end stations beyond them. It stops at z
// +1.05, the monocoque/nose joint, so the nose stays primary. 0.80 is the TOP edge of
// the opaque sponsor board (pod fractions 0.32-0.80): along the board the seam hides
// behind its top edge. `lower` paints BELOW the line; `upper` ABOVE it.
// No vertex row lies on the line — the pod flank is ONE segment of podRing, the cover
// flank one quad — so recolouring vertices alone would smear a gradient down the flank:
// a triangle across the line is CUT along it. Absent either field, the build is
// byte-identical (neither zone runs).
export const LOWER = Object.freeze({ frac: 0.80, front: 1.05, rear: -2.00 });
/** car3d bodyAnchors fields heightZone reads. */
export interface ZoneAnchors { podStations: readonly { z: number }[]; podAt(z: number): { bottom: number; top: number } }
/** Paint one side of the sidepod line in `tintCol`, in place, over triangles whose
 *  vertices all lie in [from, to) (car-shade.js:681): only those whose three vertices are
 *  `paint` in the body colour (c1, clamped as addTri clamps paint) and used by no other
 *  triangle. Wholly on the tinted side: recoloured. Across: cut where the line crosses
 *  its edges — its own slot rewritten, the other pieces appended, normals interpolated —
 *  so the colour edge is crisp; call it before smooth(). Returns vertices appended. */
export function heightZone(out: MeshOut, from: number, to: number, c1: Vec3, tintCol: unknown, anchors: ZoneAnchors,
                           paint: number, above: boolean): number {
  if (!Array.isArray(tintCol) || tintCol.length < 3) return 0;   // a garage file keeps a string in a colour slot (settings-export cleanLivery)
  const tc = tintCol as readonly number[];
  const P = out.pos, N = out.nrm, C = out.col, M = out.mat, I = out.idx, nt = Math.floor(I.length / 3), EPS = 1e-7;
  const body = ([0, 1, 2] as const).map((k) => Math.min(c1[k], 1)) as MVec3, zone = ([0, 1, 2] as const).map((k) => Math.min(tc[k]!, 1)) as MVec3;
  // The line at its KNOTS (the range ends and the pod stations between them): podAt is
  // linear between stations, so interpolating these is exact.
  const knots = ([LOWER.front] as number[]).concat(anchors.podStations.map((s) => s.z).filter((z) => z < LOWER.front && z > LOWER.rear), [LOWER.rear])
    .map((z): P2 => { const p = anchors.podAt(z); return [z, p.bottom + LOWER.frac * (p.top - p.bottom)]; });
  const line = (z: number): number => {
    for (let i = 1; i < knots.length; i++) {
      const [za, ya] = knots[i - 1]!, [zb, yb] = knots[i]!;
      if (z >= zb) return z >= za ? ya : yb + (ya - yb) * (z - zb) / (za - zb);
    }
    return knots[knots.length - 1]![1];
  };
  // < 0 below the line; linear between two knots. Outside the z range nothing is below.
  const inZ = (z: number) => z <= LOWER.front && z >= LOWER.rear, gLine = (_x: number, y: number, z: number) => y - line(z);
  const f = (y: number, z: number) => (inZ(z) ? y - line(z) : 1);
  const uses = new Uint32Array(Math.max(0, to - from));
  for (let i = 0; i < nt * 3; i++) if (I[i]! >= from && I[i]! < to) uses[I[i]! - from]!++;
  const isBody = (v: number) => v >= from && v < to && uses[v - from] === 1 && M[v] === paint &&
    C[v * 3] === body[0] && C[v * 3 + 1] === body[1] && C[v * 3 + 2] === body[2];
  const tint = (v: number, c: Vec3) => { C[v * 3] = c[0]; C[v * 3 + 1] = c[1]; C[v * 3 + 2] = c[2]; };
  const at = (u: number, w: number, t: number, k: number) => P[u * 3 + k]! + (P[w * 3 + k]! - P[u * 3 + k]!) * t;
  const vert = (u: number, w: number, t: number): number => {   // a new vertex at t along edge u -> w (coloured by the caller)
    const n = P.length / 3, nrm = ([0, 1, 2] as const).map((k) => N[u * 3 + k]! + (N[w * 3 + k]! - N[u * 3 + k]!) * t) as MVec3, l = len(nrm) || 1;
    for (let k = 0; k < 3; k++) { P.push(at(u, w, t, k)); N.push(nrm[k]! / l); C.push(body[k]!); }
    M.push(M[u]!);
    return n;
  };
  type Tri3 = number[];
  // Triangle q (indices, winding kept) cut where g(x, y, z) changes sign, as [piece,
  // side] pairs; a corner within EPS of zero is ON the cut. g is linear over q (a knot
  // plane, or the line inside one slab), so a crossing is where it interpolates to zero.
  // Pieces on one side share corners.
  function split(q: Tri3, g: (x: number, y: number, z: number) => number): [Tri3, number][] {
    const d = q.map((u) => g(P[u * 3]!, P[u * 3 + 1]!, P[u * 3 + 2]!)), s = d.map((x) => (x < -EPS ? -1 : x > EPS ? 1 : 0));
    if (s.every((x) => x >= 0)) return [[q, 1]];
    if (s.every((x) => x <= 0)) return [[q, -1]];
    // Rotate so `a` is the corner the cut runs through, or the one it cuts off.
    const on = s.indexOf(0), k = on >= 0 ? on : s[0] === s[1] ? 2 : s[0] === s[2] ? 1 : 0;
    const a = q[k]!, b = q[(k + 1) % 3]!, c = q[(k + 2) % 3]!, da = d[k]!, db = d[(k + 1) % 3]!, dc = d[(k + 2) % 3]!;
    if (on >= 0) { const t = db / (db - dc); return [[[a, b, vert(b, c, t)], s[(k + 1) % 3]!], [[vert(a, a, 0), vert(b, c, t), c], s[(k + 2) % 3]!]]; }
    const tb = da / (da - db), tc = da / (da - dc), ab = vert(a, b, tb);
    return [[[a, vert(a, b, tb), vert(a, c, tc)], s[k]!], [[ab, b, c], -s[k]!], [[ab, c, vert(a, c, tc)], -s[k]!]];
  }
  const n0 = P.length / 3;
  const yTop = Math.max(...knots.map(([, y]) => y)), yBot = Math.min(...knots.map(([, y]) => y));
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3]!, b = I[t * 3 + 1]!, c = I[t * 3 + 2]!;
    if (!isBody(a) || !isBody(b) || !isBody(c)) continue;
    const z0 = Math.min(P[a * 3 + 2]!, P[b * 3 + 2]!, P[c * 3 + 2]!), z1 = Math.max(P[a * 3 + 2]!, P[b * 3 + 2]!, P[c * 3 + 2]!);
    // Clear of the line: lower skips wholly-above; upper skips wholly-below.
    if (z1 < LOWER.rear || z0 > LOWER.front) continue;
    if (above) {
      if (Math.max(P[a * 3 + 1]!, P[b * 3 + 1]!, P[c * 3 + 1]!) < yBot - EPS) continue;
    } else if (Math.min(P[a * 3 + 1]!, P[b * 3 + 1]!, P[c * 3 + 1]!) > yTop + EPS) continue;
    const q = [a, b, c];
    // The line BENDS at a knot (and stops at the range ends), so a long triangle can dip
    // under it with all three corners above. Between knots it is straight: the corners
    // and the points where the knot planes cross the edges decide, and a crossing
    // triangle is cut on those planes first, then each piece on the line.
    const span = knots.map(([z]) => z).filter((z) => z > z0 + EPS && z < z1 - EPS);
    const probe = q.map((u) => f(P[u * 3 + 1]!, P[u * 3 + 2]!));
    for (const z of span) for (let e = 0; e < 3; e++) {
      const u = q[e]!, w = q[(e + 1) % 3]!, zu = P[u * 3 + 2]!, zw = P[w * 3 + 2]!;
      if ((zu - z) * (zw - z) < 0) probe.push(f(at(u, w, (z - zu) / (zw - zu), 1), z));
    }
    if (above) {
      if (probe.every((d) => d <= EPS)) continue;                                         // below (or on) the line
      if (probe.every((d) => d >= -EPS)) { for (const u of q) tint(u, zone); continue; }   // above it
    } else {
      if (probe.every((d) => d >= -EPS)) continue;                                         // above (or on) the line
      if (probe.every((d) => d <= EPS)) { for (const u of q) tint(u, zone); continue; }    // below it
    }
    let pieces: Tri3[] = [q];
    for (const z of span) pieces = pieces.flatMap((p) => split(p, (_x, _y, zz) => zz - z).map(([p2]) => p2));
    const seen = new Set<number>();   // the line may colour two plane pieces apart: none shares a corner
    pieces = pieces.map((p) => p.map((u) => (seen.has(u) ? vert(u, u, 0) : (seen.add(u), u))));
    pieces.flatMap((p): [Tri3, number][] => (inZ((P[p[0]! * 3 + 2]! + P[p[1]! * 3 + 2]! + P[p[2]! * 3 + 2]!) / 3) ? split(p, gLine) : [[p, 1]])).forEach(([p, sd], i) => {
      const take = above ? sd > 0 : sd < 0;
      for (const u of p) tint(u, take ? zone : body);
      if (i) I.push(p[0]!, p[1]!, p[2]!); else { I[t * 3] = p[0]!; I[t * 3 + 1] = p[1]!; I[t * 3 + 2] = p[2]!; }
    });
  }
  return P.length / 3 - n0;
}
export function lowerZone(out: MeshOut, from: number, to: number, c1: Vec3, lower: unknown, anchors: ZoneAnchors, paint: number): number {
  return heightZone(out, from, to, c1, lower, anchors, paint, false);
}
/** Paint the body ABOVE the sidepod line in `upper` — the W17 silver band. Same cut
 *  rules as lowerZone; absent = today's car. bodySplit lr wins. */
export function upperZone(out: MeshOut, from: number, to: number, c1: Vec3, upper: unknown, anchors: ZoneAnchors, paint: number): number {
  return heightZone(out, from, to, c1, upper, anchors, paint, true);
}

export interface SmoothOpts { creaseDeg?: number | undefined; skip?: readonly number[] | undefined }
/** Crease-angle normal smoothing over a Car3D mesh, in place, read through `idx`
 *  (car-shade.js:785). Every vertex position+surface gathers the faces that touch it; a
 *  vertex takes the area-weighted mean of those within the crease of its own normal, and
 *  only when a face it is NOT part of joins in — so an already-smooth tube is left as
 *  built. `skip` lists surface ids left flat (emissive lights). Returns the number of
 *  vertices whose normal moved. */
export function smooth(out: MeshOut, opts?: SmoothOpts | null): number {
  const crease = Math.cos(((opts && opts.creaseDeg) || 55) * Math.PI / 180);
  const skip = new Set((opts && opts.skip) || []);
  const P = out.pos, N = out.nrm, M = out.mat, I = out.idx, nv = P.length / 3, nt = Math.floor(I.length / 3);
  if (!nv || N.length !== P.length || !nt) return 0;
  const fx = new Float64Array(nt), fy = new Float64Array(nt), fz = new Float64Array(nt), fa = new Float64Array(nt);
  // Triangles per vertex as a CSR table (counts, then offsets): no per-vertex arrays.
  const cnt = new Uint32Array(nv + 1);
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const wx = P[c]! - P[a]!, wy = P[c + 1]! - P[a + 1]!, wz = P[c + 2]! - P[a + 2]!;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) continue;
    fx[t] = nx / l; fy[t] = ny / l; fz[t] = nz / l; fa[t] = l / 2;
    cnt[I[t * 3]! + 1]!++; cnt[I[t * 3 + 1]! + 1]!++; cnt[I[t * 3 + 2]! + 1]!++;
  }
  for (let v = 0; v < nv; v++) cnt[v + 1]! += cnt[v]!;
  const vt = new Uint32Array(cnt[nv]!), fill = cnt.slice(0, nv);
  for (let t = 0; t < nt; t++) if (fa[t]! > 0) for (let k = 0; k < 3; k++) vt[fill[I[t * 3 + k]!]!++] = t;
  // Vertices SORTED by quantised position + surface, so each weld group is a contiguous
  // run; a group's triangles are gathered once (stamped, no Set).
  const qx = new Int32Array(nv), qy = new Int32Array(nv), qz = new Int32Array(nv);
  const order: number[] = [];
  for (let v = 0; v < nv; v++) {
    if (skip.has(M[v]!) || cnt[v + 1] === cnt[v]) continue;
    qx[v] = Math.round(P[v * 3]! * 1e4); qy[v] = Math.round(P[v * 3 + 1]! * 1e4); qz[v] = Math.round(P[v * 3 + 2]! * 1e4);
    order.push(v);
  }
  order.sort((u, v) => (qx[u]! - qx[v]!) || (qy[u]! - qy[v]!) || (qz[u]! - qz[v]!) || (M[u]! - M[v]!));
  const stamp = new Int32Array(nt).fill(-1), tris: number[] = [];
  let moved = 0;
  for (let i = 0; i < order.length;) {
    const u0 = order[i]!;
    let j = i + 1;
    while (j < order.length) {
      const w = order[j]!;
      if (qx[w] !== qx[u0] || qy[w] !== qy[u0] || qz[w] !== qz[u0] || M[w] !== M[u0]) break;
      j++;
    }
    if (j - i > 1) {
      tris.length = 0;
      for (let r = i; r < j; r++) {
        const u = order[r]!;
        for (let k = cnt[u]!; k < cnt[u + 1]!; k++) if (stamp[vt[k]!] !== i) { stamp[vt[k]!] = i; tris.push(vt[k]!); }
      }
      for (let r = i; r < j; r++) {
        const v = order[r]!, ax = N[v * 3]!, ay = N[v * 3 + 1]!, az = N[v * 3 + 2]!;
        let sx = 0, sy = 0, sz = 0, foreign = 0;
        for (const t of tris) {
          if (ax * fx[t]! + ay * fy[t]! + az * fz[t]! < crease) continue;
          sx += fx[t]! * fa[t]!; sy += fy[t]! * fa[t]!; sz += fz[t]! * fa[t]!;
          let mine = false;
          for (let k = cnt[v]!; k < cnt[v + 1]!; k++) if (vt[k] === t) { mine = true; break; }
          if (!mine) foreign++;
        }
        const l = Math.hypot(sx, sy, sz);
        if (!foreign || !(l > 0)) continue;   // nothing new within the crease: the normal stands
        sx /= l; sy /= l; sz /= l;
        if (Math.abs(sx - ax) + Math.abs(sy - ay) + Math.abs(sz - az) > 1e-6) moved++;
        N[v * 3] = sx; N[v * 3 + 1] = sy; N[v * 3 + 2] = sz;
      }
    }
    i = j;
  }
  return moved;
}

export { norm as _norm };

/** f1-game's `CarShade` object (car-shade.js:853), frozen. */
export const CarShade = Object.freeze({
  KEY, RING_N, EXP, EXP_TOP, LOWER, COVER_Z, COVER_Z_NEAR, RAMP, on, any, set, pref, ring, sink, loft, capLoft, podRing, loftRings, podLoft,
  densifyCoverPts, downwash, cokeFoot, coverLoft, vertexNormals, lowerZone, upperZone, heightZone, smooth,
  skin, earcut, sect, pipe, strut, fine, rquad, block, box, boxFn, blockFn, housing, cTub, floor, endplate, tunnel, headrest,
  _norm: norm,
});
export type CarShadeApi = typeof CarShade;
