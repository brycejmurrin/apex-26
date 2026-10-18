/**
 * TrackSpline: pure centreline / spline math. Ported verbatim from f1-game
 * js/track/core/spline.js (TrackSpline, :1-299); float order unchanged.
 * `Log.info` in `centerline` is dropped (logging only).
 */
import { lerp } from "./math/scalar";
import type { PostLimitsOut, Sample, Track, V3 } from "./types";

/** Scale for authored segment lengths (arcade racing). spline.js:5 */
export const SCALE = 1.45;

/** An authored segment: turn deg (+left), length m, hill delta m, bank rad, half-width. */
export interface Segment {
  t?: number;
  l: number;
  h?: number;
  b?: number;
  w?: number;
}

/** Integrate an authored segment list into closed control points. spline.js:15 */
export function centerline(segs: readonly Segment[], baseHW: number): [number, number, number, number, number][] {
  const steps: { dl: number; deg: number; dy: number; w: number; b: number }[] = [];
  let totalDeg = 0;
  for (const s of segs) {
    const len = s.l * SCALE;
    const nst = Math.max(1, Math.ceil(Math.max(len / 14, Math.abs(s.t || 0) / 13)));
    const dlDeg = (s.t || 0) / nst;
    for (let i = 0; i < nst; i++) {
      steps.push({ dl: len / nst, deg: dlDeg, dy: (s.h || 0) / nst, w: s.w || baseHW, b: s.b || 0 });
      totalDeg += dlDeg;
    }
  }
  const target = 360 * (totalDeg >= 0 ? 1 : -1);
  const corr = (target - totalDeg) / steps.length;
  const pts: [number, number, number, number, number][] = [];
  let x = 0, z = 0, y = 0, th = 0;
  for (const st of steps) {
    th += (st.deg + corr) * Math.PI / 180;
    x += Math.sin(th) * st.dl; z += Math.cos(th) * st.dl; y += st.dy;
    pts.push([x, y, z, st.w, st.b]);
  }
  const N = pts.length;
  const ex = pts[N - 1]![0], ez = pts[N - 1]![2], ey = pts[N - 1]![1];
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1);
    pts[i]![0] -= ex * f; pts[i]![2] -= ez * f; pts[i]![1] -= ey * f;
  }
  for (let it = 0; it < 2; it++) {
    const sx = pts.map((p) => p[0]), sz = pts.map((p) => p[2]);
    const L = 0.18;
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      pts[i]![0] = sx[i]! + L * ((sx[a]! + sx[b]!) * 0.5 - sx[i]!);
      pts[i]![2] = sz[i]! + L * ((sz[a]! + sz[b]!) * 0.5 - sz[i]!);
    }
  }
  return pts;
}

/** Uniform Catmull-Rom for one component. spline.js:62 */
export function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

type P3 = readonly number[];

/** Opt-in chord-length Catmull-Rom (Barry-Goldman), segment b->c. spline.js:73 */
export function crc(a: P3, b: P3, c: P3, d: P3, t: number, alpha: number, out: V3): V3 {
  const EPS = 1e-6;
  const k1 = Math.pow(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!) + EPS, alpha);
  const k2 = k1 + Math.pow(Math.hypot(c[0]! - b[0]!, c[1]! - b[1]!, c[2]! - b[2]!) + EPS, alpha);
  const k3 = k2 + Math.pow(Math.hypot(d[0]! - c[0]!, d[1]! - c[1]!, d[2]! - c[2]!) + EPS, alpha);
  const u = k1 + t * (k2 - k1);
  for (let i = 0; i < 3; i++) {
    const a1 = ((k1 - u) * a[i]! + u * b[i]!) / k1;
    const a2 = ((k2 - u) * b[i]! + (u - k1) * c[i]!) / (k2 - k1);
    const a3 = ((k3 - u) * c[i]! + (u - k2) * d[i]!) / (k3 - k2);
    const b1 = ((k2 - u) * a1 + u * a2) / k2;
    const b2 = ((k3 - u) * a2 + (u - k1) * a3) / (k3 - k1);
    out[i] = ((k2 - u) * b1 + (u - k1) * b2) / (k2 - k1);
  }
  return out;
}

/** The arrays sample() and friends read; a full Track satisfies it. */
export type CentrelineArrays = Pick<Track, "n" | "total" | "px" | "py" | "pz" | "tx" | "ty" | "tz" | "rx" | "ry" | "rz" | "hw">;

/** Centreline sample at arc s (wrapped): linear between baked nodes. spline.js:90 */
export function sample<S extends Sample>(track: CentrelineArrays, s: number, out: S): S {
  const n = track.n, L = track.total;
  s %= L; if (s < 0) s += L;
  const fi = s / L * n;
  const i = Math.floor(fi) % n, j = (i + 1) % n, f = fi - Math.floor(fi);
  out.p[0] = lerp(track.px[i]!, track.px[j]!, f);
  out.p[1] = lerp(track.py[i]!, track.py[j]!, f);
  out.p[2] = lerp(track.pz[i]!, track.pz[j]!, f);
  out.t[0] = lerp(track.tx[i]!, track.tx[j]!, f);
  out.t[1] = lerp(track.ty[i]!, track.ty[j]!, f);
  out.t[2] = lerp(track.tz[i]!, track.tz[j]!, f);
  out.r[0] = lerp(track.rx[i]!, track.rx[j]!, f);
  out.r[1] = lerp(track.ry[i]!, track.ry[j]!, f);
  out.r[2] = lerp(track.rz[i]!, track.rz[j]!, f);
  out.hw = lerp(track.hw[i]!, track.hw[j]!, f);
  return out;
}

/** Curvature from the heading over a ±12 m window (the LUT's source). spline.js:113 */
export function curvatureRaw(track: Pick<Track, "n" | "total" | "tx" | "tz">, s: number): number {
  const n = track.n, L = track.total, w = 12;
  const tx = track.tx, tz = track.tz;
  let fi = (((s + w) % L + L) % L) / L * n;
  let i = Math.floor(fi) % n, j = (i + 1) % n, f = fi - Math.floor(fi);
  const h1 = Math.atan2(tx[i]! + (tx[j]! - tx[i]!) * f, tz[i]! + (tz[j]! - tz[i]!) * f);
  fi = (((s - w) % L + L) % L) / L * n;
  i = Math.floor(fi) % n; j = (i + 1) % n; f = fi - Math.floor(fi);
  const h2 = Math.atan2(tx[i]! + (tx[j]! - tx[i]!) * f, tz[i]! + (tz[j]! - tz[i]!) * f);
  let d = h1 - h2;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d / (2 * w);
}

/** Curvature from the baked LUT (track.curv), falling back to curvatureRaw. spline.js:138 */
export function curvature(track: Pick<Track, "n" | "total" | "tx" | "tz" | "curv">, s: number): number {
  const cv = track.curv;
  if (!cv) return curvatureRaw(track, s);
  const n = track.n, L = track.total;
  s %= L; if (s < 0) s += L;
  const fi = s / L * n;
  const i = Math.floor(fi) % n, j = (i + 1) % n, f = fi - Math.floor(fi);
  return cv[i]! + (cv[j]! - cv[i]!) * f;
}

export interface Projection {
  s: number;
  lat: number;
  k: number;
  heading: number;
  dist: number;
}

/**
 * Project a world ground point onto the centreline polyline. `hint` (last
 * arc s) restricts the search to ±16 nodes; `wy` adds a height term that
 * separates crossing legs. spline.js:168
 */
export function project(track: Track, wx: number, wz: number, hint?: number | null, wy?: number | null): Projection {
  const n = track.n, L = track.total, ds = L / n;
  const px = track.px, pz = track.pz, rx = track.rx, rz = track.rz, tx = track.tx, tz = track.tz;
  const py = track.py;
  const useY = (wy != null && isFinite(wy) && py && py.length === n);
  let bestD2 = Infinity, bestCost = Infinity, bestK = 0, bestT = 0, bestCx = 0, bestCz = 0;
  const hs = (hint != null && isFinite(hint)) ? (((hint % L) + L) % L) : -1;
  const CONT = 0.08;
  function evalSeg(i: number) {
    const j = (i + 1) % n;
    const ax = px[i]!, az = pz[i]!;
    const dx = px[j]! - ax, dz = pz[j]! - az;
    const len2 = dx * dx + dz * dz || 1e-6;
    let t = ((wx - ax) * dx + (wz - az) * dz) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = ax + t * dx, cz = az + t * dz;
    const ex = wx - cx, ez = wz - cz;
    const d2 = ex * ex + ez * ez;
    let cost = d2;
    if (hs >= 0) {
      let da = Math.abs(((i + t) * ds) - hs); da = Math.min(da, L - da);
      cost += CONT * da * da;
    }
    if (useY) {
      const cy = py[i]! + (py[j]! - py[i]!) * t;
      const ey = wy - cy;
      cost += ey * ey;
    }
    if (cost < bestCost) { bestCost = cost; bestD2 = d2; bestK = i; bestT = t; bestCx = cx; bestCz = cz; }
  }
  if (hint != null && isFinite(hint)) {
    const h = ((Math.round(hint / ds) % n) + n) % n;
    const W = 16;
    for (let d = -W; d <= W; d++) evalSeg(((h + d) % n + n) % n);
  } else {
    for (let i = 0; i < n; i++) evalSeg(i);
  }
  const j = (bestK + 1) % n;
  const s = ((bestK + bestT) * ds) % L;
  let r0 = rx[bestK]! + (rx[j]! - rx[bestK]!) * bestT;
  let r2 = rz[bestK]! + (rz[j]! - rz[bestK]!) * bestT;
  const rl = Math.hypot(r0, r2) || 1; r0 /= rl; r2 /= rl;
  const lat = (wx - bestCx) * r0 + (wz - bestCz) * r2;
  const h0 = tx[bestK]! + (tx[j]! - tx[bestK]!) * bestT;
  const h2 = tz[bestK]! + (tz[j]! - tz[bestK]!) * bestT;
  const heading = Math.atan2(h0, h2);
  return { s, lat, k: bestK, heading, dist: Math.sqrt(bestD2) };
}

/**
 * Driving boundary (max |x|) at s on one side (`sideSign >= 0` right), the
 * tighter of the two bracketing nodes; the pre-build fallback when the
 * scenery has not set barR/barL. spline.js:224
 */
export function wallAt(track: Pick<Track, "n" | "total" | "hw" | "def" | "barL" | "barR">, s: number, sideSign: number): number {
  const arr = sideSign >= 0 ? track.barR : track.barL;
  const n = track.n, L = track.total;
  if (!arr) {
    const i0 = (((Math.round(s / L * n) % n) + n) % n);
    return track.hw[i0]! + (track.def && track.def.street ? -0.8 : 9);
  }
  const f = (((s % L) + L) % L) / L * n;
  const i = Math.floor(f) % n, j = (i + 1) % n;
  return Math.min(arr[i]!, arr[j]!);
}

const POST_CLEAR = 1.1;
/** Posts (gantry legs) limit a car on each side without walling off the ground beyond. spline.js:244 */
export function postLimits(track: Pick<Track, "total" | "posts">, s: number, x: number, out: PostLimitsOut): PostLimitsOut {
  out.r = Infinity; out.l = Infinity; out.minOut = 0; out.side = 0;
  const P = track.posts;
  if (!P || !P.length) return out;
  const L = track.total;
  for (let i = 0; i < P.length; i++) {
    const p = P[i]!;
    let d = s - p.s;
    d -= L * Math.round(d / L);
    if (d > p.halfS || d < -p.halfS) continue;
    if (x * p.side < p.lat) {
      const lim = p.lat - p.halfX - POST_CLEAR;
      if (p.side > 0) { if (lim < out.r) out.r = lim; } else if (lim < out.l) out.l = lim;
    } else {
      const lim = p.lat + p.halfX + POST_CLEAR;
      if (lim > out.minOut) { out.minOut = lim; out.side = p.side; }
    }
  }
  return out;
}

export interface SurfaceFolds {
  minNodeRadius: number | null;
  minNodeRadiusNode: number;
  minNodeRadiusHw: number | null;
  foldCount: number;
  foldNodes: number[];
}

/** Centreline kink diagnostic (min node radius + surface-fold nodes). spline.js:273 */
export function surfaceFolds(track: Pick<Track, "n" | "px" | "pz" | "rx" | "rz" | "hw">): SurfaceFolds {
  const n = track.n, px = track.px, pz = track.pz, rx = track.rx, rz = track.rz, hw = track.hw;
  let minR = Infinity, minK = -1;
  const folds: number[] = [];
  let foldCount = 0;
  for (let k = 0; k < n; k++) {
    const a = (k - 1 + n) % n, b = (k + 1) % n;
    const ix = px[k]! - px[a]!, iz = pz[k]! - pz[a]!, ox = px[b]! - px[k]!, oz = pz[b]! - pz[k]!;
    const Li = Math.hypot(ix, iz), Lo = Math.hypot(ox, oz);
    const dth = Math.abs(Math.atan2(ix * oz - iz * ox, ix * ox + iz * oz));
    if (dth > 1e-9) {
      const R = 0.5 * (Li + Lo) / dth;
      if (R < minR) { minR = R; minK = k; }
    }
    if (Lo > 1e-9) {
      const drt = ((rx[b]! - rx[k]!) * ox + (rz[b]! - rz[k]!) * oz) / Lo;
      if (Math.max(hw[k]!, hw[b]!) * Math.abs(drt) > 0.97 * Lo) { foldCount++; if (folds.length < 16) folds.push(k); }
    }
  }
  return {
    minNodeRadius: minK < 0 ? null : Math.round(minR * 100) / 100,
    minNodeRadiusNode: minK, minNodeRadiusHw: minK < 0 ? null : Math.round(hw[minK]! * 100) / 100,
    foldCount, foldNodes: folds,
  };
}
