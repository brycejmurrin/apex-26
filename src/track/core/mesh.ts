/**
 * TrackMesh: the kerb/banking band and the road / terrain / floor / grid /
 * pit-lane mesh builders. upOf() is the shared per-node up basis, hash() the
 * deterministic per-index noise. Ported verbatim from f1-game
 * js/track/core/mesh.js (TrackMesh, :1-1568); comments trimmed, float
 * operation order unchanged.
 *
 * Differences from f1-game, none of which change a number:
 * - The three `Log.info("track", "... start " + id)` calls (mesh.js:676, :910,
 *   :1150) are dropped: logging only, no side effect on the build.
 * - mesh.js:866 guards `typeof TrackSurface !== "undefined"`; as an ES module
 *   ./surface is always loaded, so the guard is always true and is dropped.
 * - "GLX" (mesh.js:604, :1283) appears only in comments; there is no runtime
 *   reference to port.
 * - `buildKerbs` stays private, as in f1-game (mesh.js:1563).
 */
import { MAT, cross, norm } from "./geom";
import { lerp } from "./math/scalar";
import { wrap01 as _wrap01 } from "./space";
import { cr as catmull, curvature, sample } from "./spline";
import { profile as surfaceProfile } from "./surface";
import type { GeomOut, RV3, Sample, Track, V3 } from "./types";

const __M = Math;

/** Per-node banking (mesh.js:90 bankingProfile): outer-edge lift (m) and the outer side (+1 right, -1 left). */
export interface BankProfile {
  lift: Float32Array;
  bsign: Float32Array;
}

/** A corner apex (mesh.js:37 findCorners). sign > 0 = LEFT turn. */
export interface Corner {
  k: number;
  sign: number;
  lo: number;
  hi: number;
}

/** The `{ dy, roll }` scratch banking() writes (mesh.js:555). */
export interface BankingOut {
  dy: number;
  roll: number;
}

/** The shared node grid (mesh.js:601 nodeGrid). */
export interface NodeGrid {
  maxHw: number;
  query: (x: number, z: number, R: number, out: number[], doSort: boolean) => number;
  queryRects: (x: number, z: number, R: number, a: readonly number[], b: readonly number[] | null | undefined, out: number[]) => number;
}

/** A geometry accumulator that may carry the road's track-space `trk` (s, x, hw) stream. */
export interface TrkGeomOut extends GeomOut {
  trk?: number[];
}

/** buildRoad's output (mesh.js:900). */
export interface RoadGeom extends GeomOut {
  mat: number[];
  trk: number[];
}

/** A grid slot (mesh.js:1193 gridSlot). */
export interface GridSlot {
  s: number;
  x: number;
}

/** One entry-hatch stripe (mesh.js:1461 pitHatch). */
export interface PitHatchStripe {
  s: number;
  x0: number;
  x1: number;
  w: number;
}

// The ground material a def names (def.terrainMat), else GRASS. mesh.js:9
const GROUND_MATS: Record<string, number | undefined> = { SAND: MAT.SAND, SNOW: MAT.SNOW, CONCRETE: MAT.CONCRETE };
const groundMatOf = (def: Track["def"]): number =>
  GROUND_MATS[def.terrainMat as string] != null ? GROUND_MATS[def.terrainMat as string]! : MAT.GRASS;

/** mesh.js:14 */
function accumFaceN(nrm: number[], pos: number[], ia: number, ib: number, ic: number): void {
  const ax = pos[ia * 3]!, ay = pos[ia * 3 + 1]!, az = pos[ia * 3 + 2]!;
  const ex1 = pos[ib * 3]! - ax, ey1 = pos[ib * 3 + 1]! - ay, ez1 = pos[ib * 3 + 2]! - az;
  const ex2 = pos[ic * 3]! - ax, ey2 = pos[ic * 3 + 1]! - ay, ez2 = pos[ic * 3 + 2]! - az;
  const nx = ey1 * ez2 - ez1 * ey2;
  const ny = ez1 * ex2 - ex1 * ez2;
  const nz = ex1 * ey2 - ey1 * ex2;
  nrm[ia * 3]! += nx; nrm[ia * 3 + 1]! += ny; nrm[ia * 3 + 2]! += nz;
  nrm[ib * 3]! += nx; nrm[ib * 3 + 1]! += ny; nrm[ib * 3 + 2]! += nz;
  nrm[ic * 3]! += nx; nrm[ic * 3 + 1]! += ny; nrm[ic * 3 + 2]! += nz;
}

/** The per-node up axis, cross(r, t). mesh.js:26 */
export function upOf(track: Pick<Track, "tx" | "ty" | "tz" | "rx" | "ry" | "rz">, k: number): V3 {
  const t: V3 = [track.tx[k]!, track.ty[k]!, track.tz[k]!];
  const r: V3 = [track.rx[k]!, track.ry[k]!, track.rz[k]!];
  return cross(r, t);
}

/** Deterministic [0, 1) noise per index. mesh.js:31 */
export const hash = (i: number): number => { const x = __M.sin(i * 12.9898) * 43758.5453; return x - __M.floor(x); };

/**
 * Corner apexes: local maxima of |curvature| above thresh. sign > 0 = LEFT
 * turn; lo/hi = node span where curvature stays above ~half the apex. mesh.js:37
 */
export function findCorners(track: Track, thresh: number): Corner[] {
  const n = track.n, ds = track.total / n;
  const kv = new Float32Array(n), sg = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const c = curvature(track, k * ds);
    kv[k] = Math.abs(c); sg[k] = Math.sign(c) || 1;
  }
  const sm = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = (k - 1 + n) % n, b = (k + 1) % n;
    sm[k] = 0.25 * kv[a]! + 0.5 * kv[k]! + 0.25 * kv[b]!;
  }
  const corners: Corner[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k - 1 + n) % n, b = (k + 1) % n;
    if (sm[k]! >= thresh && sm[k]! >= sm[a]! && sm[k]! > sm[b]!) {
      const half = sm[k]! * 0.45;
      let lo = 0, hi = 0;
      while (lo < n / 4 && sm[(k - lo - 1 + n) % n]! > half) lo++;
      while (hi < n / 4 && sm[(k + hi + 1) % n]! > half) hi++;
      corners.push({ k, sign: sg[k]!, lo, hi });
    }
  }
  return corners;
}

// Below this the curvature SIGN is LUT noise, not a direction. rad/m. mesh.js:66
const BANK_STRAIGHT_K = 0.004;
const BANK_RESEAT_M = 60;
const BANK_MAX_EDGE_GRADE = 0.05;

/**
 * Author-driven banked corners: `bankZones` ({ turn } or { frac }) or the
 * legacy `banked: true` auto-pick of the two highest-curvature corners at 18°.
 * Returns null when neither is present; otherwise per-node outer-edge lift
 * (cosine-ramped over each corner span) and its side. mesh.js:90
 */
export function bankingProfile(track: Track): BankProfile | null {
  const def = track.def;
  const zones = def.bankZones;
  if (!def.banked && !(zones && zones.length)) return null;
  const n = track.n;
  const ds = track.total / n;
  if (!(ds > 0)) return null;   // zero-length loop: 12 / ds below would be an endless window
  const lift = new Float32Array(n);
  const bsign = new Float32Array(n);   // outer side: +1 = right edge, -1 = left

  // Smoothed curvature (~±12 m); every direction decision reads THIS.
  const SM = Math.max(1, Math.round(12 / ds));
  const ksm = new Float64Array(n);
  {
    const raw = new Float64Array(n);
    for (let k = 0; k < n; k++) raw[k] = curvature(track, k * ds);
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (let j = -SM; j <= SM; j++) sum += raw[(k + j + n) % n]!;
      ksm[k] = sum / (2 * SM + 1);
    }
  }

  function paint(kc: number, lo: number, hi: number, tanA: number, peak: number | null): void {
    lo = Math.max(1, lo); hi = Math.max(1, hi);
    const span = lo + hi + 1;
    let dom = 0;
    for (let i = -lo; i <= hi; i++) dom += ksm[(kc + i + n) % n]!;
    const domSign = dom >= 0 ? 1 : -1;
    const signed = new Float64Array(span);
    for (let i = -lo; i <= hi; i++) {
      const k = (kc + i + n) % n, idx = i + lo;
      // cosine window: 1 at apex, 0 at the span edges
      const t = i <= 0 ? (i + lo) / lo : (hi - i) / hi;
      const w = 0.5 * (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, t))));
      const mag = (peak != null ? peak : 2 * track.hw[k]! * tanA) * w;
      // +curv is a LEFT turn, so its OUTER edge is the right one. Read PER
      // NODE; on a straight the window's dominant direction fills in.
      const kk = ksm[k]!;
      const dir = Math.abs(kk) >= BANK_STRAIGHT_K ? (kk > 0 ? 1 : -1) : domSign;
      signed[idx] = mag * dir;
    }
    for (let i = -lo; i <= hi; i++) {
      const k = (kc + i + n) % n, v = signed[i + lo]!, a = Math.abs(v);
      if (a > lift[k]!) { lift[k] = a; bsign[k] = v >= 0 ? 1 : -1; }
    }
  }

  // Camber that reverses must cross THROUGH flat, holding BANK_MAX_EDGE_GRADE;
  // the blend may only ever REDUCE a node's lift.
  function relaxSignSteps(): void {
    const signed = new Float64Array(n);
    for (let k = 0; k < n; k++) signed[k] = lift[k]! * bsign[k]!;
    const cuts: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = signed[k]!, b = signed[(k + 1) % n]!;
      if (a === 0 || b === 0) continue;
      if ((a > 0) !== (b > 0)) cuts.push(k);
    }
    if (!cuts.length) return;
    const out = Float64Array.from(signed);
    for (const c of cuts) {
      const jump = Math.max(Math.abs(signed[c]!), Math.abs(signed[(c + 1) % n]!));
      const R = Math.max(2, Math.ceil(jump / (2 * BANK_MAX_EDGE_GRADE * ds)));
      for (let i = -R; i <= R; i++) {
        const k = (c + i + n) % n;
        let sum = 0;
        for (let j = -R; j <= R; j++) sum += signed[(k + j + n) % n]!;
        const v = sum / (2 * R + 1);
        if (Math.abs(v) < Math.abs(out[k]!)) out[k] = v;
      }
    }
    for (let k = 0; k < n; k++) {
      lift[k] = Math.abs(out[k]!);
      if (out[k] !== 0) bsign[k] = out[k]! > 0 ? 1 : -1;
    }
  }

  // Explicit authored zones take precedence over the curvature auto-pick.
  if (zones && zones.length) {
    // frac zones get the `_sceneryShift` rotation compensation and the
    // sceneryLapMirror negation (cf. TrackSpace.sceneryFrac).
    const dress = def._sceneryShift || 0;
    const mirror = def.reverse && def.sceneryLapMirror ? -1 : 1;
    const turns = (def.turns && def.turns.length) ? def.turns : null;
    const wrap01 = _wrap01;
    const centre: (number | null)[] = new Array<number | null>(zones.length).fill(null);
    const taken = new Set<number>();

    // `turn:` anchors resolve straight off the curated apex table.
    zones.forEach((z, i) => {
      if (!turns || !Number.isFinite(z.turn)) return;
      const ti = ((Math.round(z.turn as number) - 1) % turns.length + turns.length) % turns.length;
      centre[i] = wrap01(turns[ti]);
      taken.add(ti);
    });

    // Frac anchors: rotation compensation, then a re-seat when the centre
    // lands on a STRAIGHT more than BANK_RESEAT_M from any apex.
    const loose: { i: number; f: number }[] = [];
    zones.forEach((z, i) => {
      if (centre[i] !== null) return;
      const f = wrap01((z.frac || 0) * mirror + dress);
      centre[i] = f;
      if (!turns) return;
      if (Math.abs(ksm[Math.round(f * n) % n]!) >= BANK_STRAIGHT_K) return;
      loose.push({ i, f });
    });
    if (loose.length) {
      const cand: { i: number; ti: number; d: number }[] = [];
      for (const p of loose) {
        turns!.forEach((tf, ti) => {
          let d = Math.abs(wrap01(tf) - p.f);
          if (d > 0.5) d = 1 - d;
          cand.push({ i: p.i, ti, d });
        });
      }
      cand.sort((a, b) => a.d - b.d);
      const seated = new Set<number>();
      for (const c of cand) {
        if (seated.has(c.i) || taken.has(c.ti)) continue;
        seated.add(c.i); taken.add(c.ti);
        if (c.d * track.total > BANK_RESEAT_M) centre[c.i] = wrap01(turns![c.ti]);
      }
    }

    zones.forEach((z, i) => {
      const half = Math.max(1, Math.round((z.widthM || 40) / ds / 2));
      paint(Math.round((centre[i] as number) * n) % n, half, half,
            Math.tan((z.angleDeg || 18) * Math.PI / 180), null);
    });
    relaxSignSteps();
    return { lift, bsign };
  }

  // Legacy auto-pick: the two highest-curvature corners, banked at 18°.
  const corners = findCorners(track, 0.006);
  if (!corners.length) return null;
  const scored = corners.map((c) => ({ c, k: Math.abs(curvature(track, c.k * ds)) }));
  scored.sort((a, b) => b.k - a.k);
  const picks = scored.slice(0, 2).map((s) => s.c);
  const TAN18 = Math.tan(18 * Math.PI / 180);
  const RUN = 6;                       // extra run-in/out nodes each side
  for (const c of picks) {
    paint(c.k, c.lo + RUN, c.hi + RUN, TAN18, 2 * track.hw[c.k]! * TAN18);
  }
  relaxSignSteps();
  return { lift, bsign };
}

/**
 * Cross-track banking offset (m along the node's up axis) at lateral `o`.
 * THE single source of truth for the pivot: the section rotates about its
 * centreline, clamped past the tarmac. mesh.js:289
 */
export function bankOffsetAt(track: Track, k: number, o: number): number {
  const bp = track.bankP;
  if (!bp) return 0;
  const lift = bp.lift[k]!;
  if (!(lift > 0)) return 0;
  const w = track.hw[k]!;
  let frac = (bp.bsign[k]! * o + w) / (2 * w);
  frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  return lift * (frac - 0.5);
}

// The banked running surface's NORMAL at node k, lateral `o`. mesh.js:313
function bankNormalAt(track: Track, k: number, o: number, u: RV3, r: RV3): RV3 {
  const bp = track.bankP;
  if (!bp) return u;
  const n = track.n, kp = (k - 1 + n) % n, kn = (k + 1) % n, lift = bp.lift;
  if (!(lift[k]! > 0) && !(lift[kp]! > 0) && !(lift[kn]! > 0)) return u;
  const w = track.hw[k]!;
  const g = (lift[k]! > 0 && w > 0 && __M.abs(o) <= w) ? bp.bsign[k]! * lift[k]! / (2 * w) : 0;
  const { px, py, pz, rx, ry, rz } = track;
  const at = (j: number): V3 => {
    const uj = upOf(track, j), b = bankOffsetAt(track, j, o);
    return [px[j]! + rx[j]! * o + uj[0] * b, py[j]! + ry[j]! * o + uj[1] * b, pz[j]! + rz[j]! * o + uj[2] * b];
  };
  const A = at(kp), B = at(kn);
  const L: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];              // along the lap
  const X: V3 = [r[0] + u[0] * g, r[1] + u[1] * g, r[2] + u[2] * g];  // across, +right
  const nx = X[1] * L[2] - X[2] * L[1], ny = X[2] * L[0] - X[0] * L[2], nz = X[0] * L[1] - X[1] * L[0];
  const len = __M.hypot(nx, ny, nz);
  if (!(len > 1e-9)) return u;
  const sg = (nx * u[0] + ny * u[1] + nz * u[2]) < 0 ? -1 / len : 1 / len;
  return [nx * sg, ny * sg, nz * sg];
}

// Kerb ribbons on every corner's inside and exit, appended to the road's buffers. mesh.js:335
function buildKerbs(track: Track, out: TrkGeomOut): void {
  const { n, px, py, pz, hw } = track;
  const pal = track.def.palette, ka = pal.kerbA, kb = pal.kerbB;
  const ds = track.total / n;
  // per-node kerb map (which side has a kerb) so the car can detect riding one
  track.kerbL = new Uint8Array(n);
  track.kerbR = new Uint8Array(n);
  const markKerb = (k0: number, k1: number, side: number): void => {
    for (let i = 0; i <= k1 - k0; i++) { const k = (k0 + i + n) % n; if (side > 0) track.kerbR![k] = 1; else track.kerbL![k] = 1; }
  };
  // Kerb STYLE: flat = historic ribbon; sausage = crowned block; rumble = corrugated.
  const style = track.def && track.def.kerbStyle;
  const KW = style === "sausage" ? 1.05 : 0.9;
  const KH0 = style === "sausage" ? 0.09 : style === "rumble" ? 0.07 : 0.06;
  // Stripes are ~STRIPE_M of TRUE ARC, below node resolution.
  const STRIPE_M = 1.6;
  const kerbH = (arc: number, latT: number): number => {
    let h = KH0;
    if (style === "sausage") {
      h = KH0 * (0.70 + 0.30 * latT);
    } else if (style === "rumble") {
      const step = ((Math.floor(arc / 0.8) % 2) + 2) % 2;
      h = KH0 * (step ? 1.0 : 0.45);
    }
    return h;
  };
  const par = (m: number): number => ((m % 2) + 2) % 2;   // stripe parity, safe for negative arcs
  // one ribbon strip over node range, on `side` (-1 left edge, +1 right).
  function ribbon(k0: number, k1: number, side: number): void {
    const count = k1 - k0;
    const base: number[] = [];         // ring vertex indices, one per emitted ring
    const arcs: number[] = [];         // arc length of each emitted ring, for striping
    const dup: boolean[] = [];         // ring i is coincident with ring i-1
    let prev: readonly number[] | null = null;  // [ax,ay,az,bx,by,bz] of the previous NODE ring
    let prevArc = 0;
    for (let i = 0; i <= count; i++) {
      const k = (k0 + i + n) % n;
      const u = upOf(track, k);
      const r: V3 = [track.rx[k]!, track.ry[k]!, track.rz[k]!];
      const w = hw[k]!;
      // two rails; push the smaller offset first so winding matches the road
      const oA = side > 0 ? w + 0.05 : -(w + 0.05 + KW);
      const oB = side > 0 ? w + 0.05 + KW : -(w + 0.05);
      const arc = k0 * ds + i * ds;   // monotone along the strip (ds-spaced nodes)
      const hA = kerbH(arc, side > 0 ? 0 : 1) + bankOffsetAt(track, k, oA);
      const hB = kerbH(arc, side > 0 ? 1 : 0) + bankOffsetAt(track, k, oB);
      const cur = [px[k]! + r[0]*oA + u[0]*hA, py[k]! + r[1]*oA + u[1]*hA + 0.03, pz[k]! + r[2]*oA + u[2]*hA,
                   px[k]! + r[0]*oB + u[0]*hB, py[k]! + r[1]*oB + u[1]*hB + 0.03, pz[k]! + r[2]*oB + u[2]*hB] as const;
      const pv = prev;   // emitRing runs before `prev = cur` below, so this is the closure's `prev`
      // A ring at t in [0,1] along this node span, coloured by stripe PARITY.
      const emitRing = (t: number, parity: number, coincident: boolean): void => {
        const rA: V3 = pv ? [pv[0]! + (cur[0]-pv[0]!)*t, pv[1]! + (cur[1]-pv[1]!)*t, pv[2]! + (cur[2]-pv[2]!)*t] : [cur[0],cur[1],cur[2]];
        const rB: V3 = pv ? [pv[3]! + (cur[3]-pv[3]!)*t, pv[4]! + (cur[4]-pv[4]!)*t, pv[5]! + (cur[5]-pv[5]!)*t] : [cur[3],cur[4],cur[5]];
        const a = prevArc + (arc - prevArc) * t;
        // Rumble must land on THIS ring's arc.
        if (style === "rumble" && pv) {
          const hA0 = kerbH(prevArc, side > 0 ? 0 : 1), hA1 = kerbH(arc, side > 0 ? 0 : 1);
          const hB0 = kerbH(prevArc, side > 0 ? 1 : 0), hB1 = kerbH(arc, side > 0 ? 1 : 0);
          const hAL = hA0 + (hA1 - hA0) * t, hBL = hB0 + (hB1 - hB0) * t;
          const hA = kerbH(a, side > 0 ? 0 : 1), hB = kerbH(a, side > 0 ? 1 : 0);
          rA[0] += u[0] * (hA - hAL); rA[1] += u[1] * (hA - hAL); rA[2] += u[2] * (hA - hAL);
          rB[0] += u[0] * (hB - hBL); rB[1] += u[1] * (hB - hBL); rB[2] += u[2] * (hB - hBL);
        }
        const ai = out.pos.length / 3;
        out.pos.push(rA[0], rA[1], rA[2]); out.nrm.push(u[0], u[1], u[2]);
        out.pos.push(rB[0], rB[1], rB[2]); out.nrm.push(u[0], u[1], u[2]);
        const c = parity === 0 ? ka : kb;
        out.col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
        if (out.mat) out.mat.push(MAT.FLAT, MAT.FLAT);
        if (out.trk) out.trk.push(a, oA, 0, a, oB, 0);   // hw=0 → roadMarkings() skips the ribbon
        base.push(ai); arcs.push(a); dup.push(coincident);
      };
      if (i === 0) {
        emitRing(1, par(Math.floor(arc / STRIPE_M + 1e-6)), false);   // node 0: only its own ring
      } else {
        // CRISP STRIPES: a ring at every stripe boundary, emitted TWICE.
        const span = arc - prevArc;
        let nodeDone = false;
        for (let m = Math.floor(prevArc / STRIPE_M + 1e-6) + 1; m * STRIPE_M <= arc + 1e-6; m++) {
          const t = Math.min(1, (m * STRIPE_M - prevArc) / span);
          emitRing(t, par(m - 1), false);
          emitRing(t, par(m), true);
          if (t >= 1) nodeDone = true;
        }
        if (!nodeDone) emitRing(1, par(Math.floor(arc / STRIPE_M + 1e-6)), false);
      }
      prev = cur; prevArc = arc;
    }
    for (let i = 0; i < base.length - 1; i++) {
      if (dup[i + 1]) continue;   // the boundary pair: coincident rings, zero-area quad
      const a = base[i]!, b = base[i + 1]!;
      // match buildRoad winding (top face up under BACK-face culling)
      out.idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  // One ribbon per contiguous run of covered QUADS per side (no stacked
  // duplicates); a quad remembers the lap (wrap) of the first span covering it.
  const quad: Record<string, Int8Array> = { "-1": new Int8Array(n), "1": new Int8Array(n) };   // 0 = bare, else wrap + 2
  const cover = (k0: number, k1: number, side: number): void => {   // ribbon(k0, k1) lays quads k0..k1-1
    const q = quad[side]!;
    for (let k = k0; k < k1; k++) {
      const i = ((k % n) + n) % n;
      if (!q[i]) q[i] = (k - i) / n + 2;
    }
  };
  for (const c of findCorners(track, 0.006)) {
    const inside = c.sign > 0 ? -1 : 1;
    cover(c.k - c.lo, c.k + c.hi, inside);
    markKerb(c.k - c.lo, c.k + c.hi, inside);
    const exLen = Math.max(2, Math.round(c.hi * 0.7));
    cover(c.k + 1, c.k + 1 + exLen, -inside);
    markKerb(c.k + 1, c.k + 1 + exLen, -inside);
  }
  for (const side of [-1, 1]) {
    const q = quad[side]!;
    const U = (i: number): number => i + (q[i]! - 2) * n;                       // unwrapped node index of quad i
    const joins = (i: number): boolean => { const j = (i + n - 1) % n; return !!(q[i] && q[j] && U(i) === U(j) + 1); };
    let s0 = 0;
    while (s0 < n && joins(s0)) s0++;   // a strip start; always exists
    for (let m = 0; m < n; ) {
      const i = (s0 + m) % n;
      if (!q[i]) { m++; continue; }
      let len = 1;
      while (len < n - m && joins((i + len) % n)) len++;
      ribbon(U(i), U(i) + len, side);
      m += len;
    }
  }
}

/** 1 when (s, x) rides a kerb, else 0. mesh.js:502 */
export function onKerb(track: Track, s: number, x: number): number {
  if (!track.kerbR) return 0;
  const n = track.n, L = track.total;
  const k = Math.floor((((s % L) + L) % L) / L * n) % n;
  const hw = track.hw[k]!, ax = Math.abs(x);
  if (ax < hw - 0.6 || ax > hw + 1.1) return 0;
  if (x > 0 && track.kerbR[k]) return 1;
  if (x < 0 && track.kerbL![k]) return 1;
  return 0;
}

/**
 * The road's ROLL at arc s (radians, + = right edge raised): banking() at
 * x = 0, inlined for the AI planner's hot loop. mesh.js:528
 */
export function bankAngle(track: Track, s: number): number {
  const bp = track.bankP;
  if (!bp) return 0;
  const n = track.n, L = track.total;
  const pos = (((s % L) + L) % L) / L * n;
  const k = Math.floor(pos) % n, j = (k + 1) % n, f = pos - Math.floor(pos);
  const sl0 = bp.lift[k]! * bp.bsign[k]!, sl1 = bp.lift[j]! * bp.bsign[j]!;
  const signedLift = sl0 + (sl1 - sl0) * f;
  if (!signedLift) return 0;
  const w0 = track.hw[k]!, w1 = track.hw[j]!;
  return Math.atan2(signedLift, 2 * (w0 + (w1 - w0) * f));
}

// Signed cross-track lift at node i. mesh.js:554
function _signedLift(bp: BankProfile, i: number): number { return bp.lift[i]! * bp.bsign[i]!; }

/**
 * Banked-surface height offset `dy` at lateral x and `roll` at arc s, or null
 * on non-banked sections. `out` is an optional reusable scratch; `smooth`
 * interpolates with Catmull-Rom (camera sites) instead of a lerp. mesh.js:555
 */
export function banking(track: Track, s: number, x: number, out?: BankingOut | null, smooth?: boolean): BankingOut | null {
  const bp = track.bankP;
  if (!bp) return null;
  const n = track.n, L = track.total;
  const pos = (((s % L) + L) % L) / L * n;
  const k = Math.floor(pos) % n, j = (k + 1) % n, f = pos - Math.floor(pos);
  const signedLift = smooth
    ? catmull(_signedLift(bp, (k - 1 + n) % n), _signedLift(bp, k),
              _signedLift(bp, j), _signedLift(bp, (k + 2) % n), f)
    : lerp(_signedLift(bp, k), _signedLift(bp, j), f);
  if (!signedLift) return null;
  const w = smooth
    ? catmull(track.hw[(k - 1 + n) % n]!, track.hw[k]!, track.hw[j]!, track.hw[(k + 2) % n]!, f)
    : lerp(track.hw[k]!, track.hw[j]!, f);
  const cx = x < -w ? -w : x > w ? w : x;
  const o = out || ({} as BankingOut);
  o.dy = signedLift * cx / (2 * w);
  o.roll = Math.atan2(signedLift, 2 * w);
  return o;
}

/**
 * Coarse XZ bucket (10 m cells) of centreline node indices, built once per
 * track and cached on `track._nodeGrid`. Queries return a candidate superset
 * only, so callers' geometry is unchanged. mesh.js:601
 */
export function nodeGrid(track: Track): NodeGrid {
  if (track._nodeGrid) return track._nodeGrid;
  const n = track.n, px = track.px, pz = track.pz, hw = track.hw;
  const CELL = 10, OFFSET = 2048, STRIDE = 4096;   // numeric packed key, cf. glx.createChunkedMesh
  const map = new Map<number, number[]>();
  let maxHw = 0;
  for (let k = 0; k < n; k++) {
    if (hw[k]! > maxHw) maxHw = hw[k]!;
    const key = (__M.floor(px[k]! / CELL) + OFFSET) * STRIDE + (__M.floor(pz[k]! / CELL) + OFFSET);
    let arr = map.get(key); if (!arr) { arr = []; map.set(key, arr); } arr.push(k);
  }
  const grid = { maxHw } as NodeGrid;
  grid.query = (x, z, R, out, doSort) => {
    let cnt = 0;
    const x0 = __M.floor((x - R) / CELL), x1 = __M.floor((x + R) / CELL);
    const z0 = __M.floor((z - R) / CELL), z1 = __M.floor((z + R) / CELL);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const arr = map.get((cx + OFFSET) * STRIDE + (cz + OFFSET));
        if (!arr) continue;
        for (let a = 0; a < arr.length; a++) out[cnt++] = arr[a]!;
      }
    if (doSort) for (let a = 1; a < cnt; a++) { const v = out[a]!; let b = a - 1; while (b >= 0 && out[b]! > v) { out[b + 1] = out[b]!; b--; } out[b + 1] = v; }
    return cnt;
  };
  // query()'s square, narrowed to the cells of rectangle A UNION rectangle B
  // (world [x0, x1, z0, z1]; B may be null), in query()'s own order.
  grid.queryRects = (x, z, R, a, b, out) => {
    let cnt = 0;
    const X0 = __M.floor((x - R) / CELL), X1 = __M.floor((x + R) / CELL);
    const Z0 = __M.floor((z - R) / CELL), Z1 = __M.floor((z + R) / CELL);
    const ax0 = __M.max(X0, __M.floor(a[0]! / CELL)), ax1 = __M.min(X1, __M.floor(a[1]! / CELL));
    const az0 = __M.max(Z0, __M.floor(a[2]! / CELL)), az1 = __M.min(Z1, __M.floor(a[3]! / CELL));
    let bx0 = 1, bx1 = 0, bz0 = 1, bz1 = 0;
    if (b) {
      bx0 = __M.max(X0, __M.floor(b[0]! / CELL)); bx1 = __M.min(X1, __M.floor(b[1]! / CELL));
      bz0 = __M.max(Z0, __M.floor(b[2]! / CELL)); bz1 = __M.min(Z1, __M.floor(b[3]! / CELL));
    }
    const aOk = ax0 <= ax1 && az0 <= az1, bOk = bx0 <= bx1 && bz0 <= bz1;
    if (!aOk && !bOk) return 0;
    const cx0 = aOk ? (bOk ? __M.min(ax0, bx0) : ax0) : bx0, cx1 = aOk ? (bOk ? __M.max(ax1, bx1) : ax1) : bx1;
    for (let cx = cx0; cx <= cx1; cx++) {
      const inA = aOk && cx >= ax0 && cx <= ax1, inB = bOk && cx >= bx0 && cx <= bx1;
      if (!inA && !inB) continue;
      // One cz interval, or two ascending ones (merged when they touch).
      let lo0: number, hi0: number, lo1 = 1, hi1 = 0;
      if (inA && inB) {
        const fa = az0 <= bz0;
        lo0 = fa ? az0 : bz0; hi0 = fa ? az1 : bz1; lo1 = fa ? bz0 : az0; hi1 = fa ? bz1 : az1;
        if (lo1 <= hi0 + 1) { if (hi1 > hi0) hi0 = hi1; lo1 = 1; hi1 = 0; }
      } else if (inA) { lo0 = az0; hi0 = az1; } else { lo0 = bz0; hi0 = bz1; }
      const key0 = (cx + OFFSET) * STRIDE + OFFSET;
      for (let cz = lo0; cz <= hi0; cz++) {
        const arr = map.get(key0 + cz);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) out[cnt++] = arr[i]!;
      }
      for (let cz = lo1; cz <= hi1; cz++) {
        const arr = map.get(key0 + cz);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) out[cnt++] = arr[i]!;
      }
    }
    return cnt;
  };
  track._nodeGrid = grid;
  return grid;
}

/**
 * The road mesh: 14 columns per node (verge, edge, centre), banked, verge
 * fold-clamped, with racing-line wear, the seam ring, the edge skirts, the
 * kerbs and the pit-entry hatch appended. Sets `track.asphaltCol` and
 * (via buildKerbs) `track.kerbL` / `track.kerbR`. mesh.js:675
 */
export function buildRoad(track: Track): RoadGeom {
  const { n, px, py, pz, hw } = track;
  const pos: number[] = [], nrm: number[] = [], col: number[] = [], mat: number[] = [], trk: number[] = [];
  const idxArr: number[] = [];
  const grid = nodeGrid(track);              // shared node grid (also used by buildTerrain/buildProps)
  const _cand: number[] = new Array<number>(n);   // reusable candidate scratch for the shoulder clip
  const pal = track.def.palette;
  const _did = track.def.id || "";
  let _idn = 0; for (let _i = 0; _i < _did.length; _i++) _idn += _did.charCodeAt(_i) * (_i + 3);
  const _aBri = 0.85 + hash(_idn * 1.3) * 0.32;            // 0.85 … 1.17 brightness
  const _aWarm = (hash(_idn * 2.7) - 0.5) * 0.05;          // warm(+R/−B) ↔ cool skew
  const _bA: RV3 = pal.asphalt || [0.17, 0.18, 0.21];
  const asphalt: V3 = [Math.max(0, _bA[0] * _aBri + _aWarm), _bA[1] * _aBri, Math.max(0, _bA[2] * _aBri - _aWarm)];
  // The pit ribbon is laid in this circuit's own asphalt (buildPitLane).
  track.asphaltCol = asphalt;
  const _gBri = 0.86 + hash(_idn * 3.9) * 0.30;            // verge lush ↔ dry
  const _gWarm = (hash(_idn * 4.4) - 0.5) * 0.07;
  const _bG: RV3 = pal.grass || [0.30, 0.42, 0.22];
  const grass: V3 = [_bG[0] * _gBri + _gWarm, _bG[1] * _gBri, Math.max(0, _bG[2] * _gBri - _gWarm)];
  const edgeMat = groundMatOf(track.def);
  // RACING-LINE WEAR FOLLOWS THE BAKED LINE (track.line, +right metres).
  // Vertex colour only: no car reads it (docs/PHYSICS.md §Curvature channels).
  const lineX = track.line && track.line.length === n ? track.line : null;
  const wearF = (v: number, k: number, o: number): number => {
    const f = (v === 4 || v === 9) ? 1.07 : 1.0;
    if (!lineX) return (v >= 5 && v <= 8) ? f * 0.86 : f;
    const d = __M.abs(o - lineX[k]!);
    const band = d < 1.2 ? 1 : d > 4.0 ? 0 : (4.0 - d) / 2.8;
    const off = d < 4.5 ? 0 : d > 7.0 ? 1 : (d - 4.5) / 2.5;
    return f * (1 - 0.14 * band + 0.035 * off);
  };
  // The road's verge is paved (not grass) wherever the pit complex stands beside it.
  const _pit = track.pit && !track.pit.painted ? track.pit : null;
  const pitPaved = (k: number, side: number): boolean => !!_pit && side === _pit.side && _pit.w[k]! > 0.01;
  const ds = track.total / n;
  const V = 14;
  for (let k = 0; k < n; k++) {
    const u = upOf(track, k);
    const r: V3 = [track.rx[k]!, track.ry[k]!, track.rz[k]!];
    const w = hw[k]!;
    const offs = [-w - 2.2, -w - 0.4,
                  -w, -w + 0.2, -w + 0.25,        // left edge line + step
                  -0.35, -0.30,                    // centre line (left half)
                  0.30, 0.35,                      // centre line (right half)
                  w - 0.25, w - 0.2, w,            // right step + edge line
                  w + 0.4, w + 2.2];
    // VERGE FOLD CLAMP: on the fold side, pull the verge (and, where the
    // fold limit is inside w, the edge columns) in so quads never fold back.
    for (let sp = 0; sp < 2; sp++) {
      const ka = sp ? k : (k - 1 + n) % n, kb = sp ? (k + 1) % n : k;
      const dx = px[kb]! - px[ka]!, dz = pz[kb]! - pz[ka]!, L = __M.hypot(dx, dz) || 1;
      const drx = track.rx[kb]! - track.rx[ka]!, drz = track.rz[kb]! - track.rz[ka]!;
      // Two readings of "along": the chord and the span's start-node tangent.
      for (let pass = 0; pass < 2; pass++) {
        const ux = pass ? track.tx[ka]! : dx / L, uz = pass ? track.tz[ka]! : dz / L;
        const D = dx * ux + dz * uz, drt = drx * ux + drz * uz;
        if (__M.abs(drt) < 1e-6 || D <= 0) continue;
        const limRun = 0.85 * D / __M.abs(drt), lim = __M.max(w, limRun);
        const v0 = drt > 0 ? 0 : 12, sg = drt > 0 ? -1 : 1;   // fold side: o·drt < 0
        for (let v = v0; v < v0 + 2; v++) if (__M.abs(offs[v]!) > lim) offs[v] = sg * lim;
        if (limRun < w) {
          const lr = __M.max(0.4, limRun), r0 = drt > 0 ? 0 : 9, r1 = drt > 0 ? 5 : 14;
          for (let v = r0; v < r1; v++) if (__M.abs(offs[v]!) > lr) offs[v] = sg * lr;
        }
      }
    }
    const rise = [-0.05, -0.02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.02, -0.05];
    for (let v = 0; v < V; v++) {
      const o = offs[v]!;
      // Shared with buildKerbs — see bankOffsetAt().
      const by = bankOffsetAt(track, k, o);
      // The verge does not dip beside the pit apron.
      const ri = pitPaved(k, v <= 1 ? -1 : 1) ? 0 : rise[v]!;
      const wx = px[k]! + r[0] * o + u[0] * (ri + by);
      let   wy = py[k]! + r[1] * o + u[1] * (ri + by) + 0.02;
      const wz = pz[k]! + r[2] * o + u[2] * (ri + by);
      if (v === 0 || v === 1 || v === 12 || v === 13) {
        const _cn = grid.query(wx, wz, grid.maxHw + 0.5, _cand, false);
        for (let _ci = 0; _ci < _cn; _ci++) {
          const j = _cand[_ci]!;
          let dd = __M.abs(j - k); dd = dd < n - dd ? dd : n - dd;
          if (dd * ds < 6) continue;
          const ex = wx - px[j]!, ez = wz - pz[j]!;
          const lim = hw[j]! - 0.3;
          if (ex * ex + ez * ez < lim * lim && wy > py[j]! - 0.05 && wy < py[j]! + 3)
            wy = py[j]! - 0.05;
        }
      }
      pos.push(wx, wy, wz);
      const nv = bankNormalAt(track, k, o, u, r);
      nrm.push(nv[0], nv[1], nv[2]);
      // Per-vertex material; painted markings are drawn by roadMarkings() from `trk`.
      let c: RV3, m: number;
      if (v <= 1 || v >= 12) {
        if (pitPaved(k, v <= 1 ? -1 : 1)) {
          // The pit apron, not a verge: asphalt, MAT.ASPHALT.
          const grain = (hash(k * 13 + v) - 0.5) * 0.016;
          c = [asphalt[0] + grain, asphalt[1] + grain, asphalt[2] + grain];
          m = MAT.ASPHALT;
        } else {
          c = grass; m = edgeMat;
        }
      } else {
        // asphalt running surface: racing-line wear + subtle aggregate grain
        const f = wearF(v, k, o), grain = (hash(k * 13 + v) - 0.5) * 0.016;
        c = [asphalt[0] * f + grain, asphalt[1] * f + grain, asphalt[2] * f + grain];
        m = MAT.ASPHALT;
      }
      col.push(c[0], c[1], c[2]);
      mat.push(m);
      // Track-space coords (s, x, hw) for the fragment-side marking SDF; hw > 0 = road SURFACE.
      trk.push(k * ds, o, w);
    }
  }
  // SEAM RING: node 0's columns again, with s = total.
  const seam = n * V;
  for (let v = 0; v < V; v++) {
    pos.push(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
    nrm.push(nrm[v * 3]!, nrm[v * 3 + 1]!, nrm[v * 3 + 2]!);
    col.push(col[v * 3]!, col[v * 3 + 1]!, col[v * 3 + 2]!);
    mat.push(mat[v]!);
    trk.push(track.total, trk[v * 3 + 1]!, trk[v * 3 + 2]!);
  }
  for (let k = 0; k < n; k++) {
    const a = k * V, b = k === n - 1 ? seam : (k + 1) * V;
    for (let v = 0; v < V - 1; v++) {
      idxArr.push(a + v, a + v + 1, b + v, a + v + 1, b + v + 1, b + v);
    }
  }
  {
    // mesh.js:865 also guards `typeof TrackSurface !== "undefined"`: always true here.
    const surf = track.surface || surfaceProfile(track.def, track);
    if (surf) {
      const innerLat = surf.rails[0]!;
      const topC: V3 = [grass[0] * 0.72, grass[1] * 0.72, grass[2] * 0.72];
      const botC: V3 = [grass[0] * 0.42, grass[1] * 0.42, grass[2] * 0.42];
      const skirt = (v: number): void => {
        const base = pos.length / 3;
        const sgn = v === 0 ? -1 : 1;
        for (let k = 0; k < n; k++) {
          const i3 = (k * V + v) * 3;
          const ex = pos[i3]!, ey = pos[i3 + 1]!, ez = pos[i3 + 2]!;
          // Deep enough for both the seam drop and the clip trench…
          let bottom = Math.min(surf.heightAt(k, innerLat), py[k]! - 1.6) - 0.6;
          if (py[k]! - surf.ground[k]! > 0.5) bottom = Math.max(bottom, py[k]! - 1.2);
          if (bottom > ey - 0.3) bottom = ey - 0.3;
          const nx = track.rx[k]! * sgn, nz = track.rz[k]! * sgn;
          pos.push(ex, ey, ez, ex, bottom, ez);
          nrm.push(nx, 0, nz, nx, 0, nz);
          col.push(topC[0], topC[1], topC[2], botC[0], botC[1], botC[2]);
          mat.push(MAT.FLAT, MAT.FLAT);
          // hw = 0: vertical seam filler, not road surface.
          trk.push(k * ds, 0, 0, k * ds, 0, 0);
        }
        for (let k = 0; k < n; k++) {
          const a = base + k * 2, b = base + ((k + 1) % n) * 2;
          idxArr.push(a, a + 1, b, a + 1, b + 1, b);
          idxArr.push(a, b, a + 1, a + 1, b, b + 1);
        }
      };
      skirt(0); skirt(13);
    }
  }
  buildKerbs(track, { pos, nrm, col, mat, trk, idx: idxArr });
  buildPitHatch(track, { pos, nrm, col, mat, trk, idx: idxArr });
  return { pos, nrm, col, mat, trk, idx: idxArr };
}

/** buildTerrainSteps run to completion. mesh.js:903 */
export function buildTerrain(track: Track): GeomOut {
  const it = buildTerrainSteps(track);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

/**
 * The terrain ribbons either side of the road, clipped under any nearby
 * tarmac, with real area-weighted normals. Yields between complete rows so a
 * caller can paint; the clip/face/normal order is preserved. mesh.js:909
 */
export function* buildTerrainSteps(track: Track): Generator<undefined, GeomOut, unknown> {
  const { n, px, py, pz, hw, total } = track;
  const pos: number[] = [], nrm: number[] = [], col: number[] = [], mat: number[] = [];
  const idxArr: number[] = [];
  const pal = track.def.palette, grass = pal.grass, runoff = pal.runoff;
  const bp = track.bankP;
  const ds = total / n;
  const grid = nodeGrid(track);              // shared node grid (built in buildRoad)
  const _cand: number[] = new Array<number>(n);   // reusable candidate scratch for the over-track clip
  // The terrain baseline and bridge carve are owned by TrackSurface.profile.
  const surface = track.surface || surfaceProfile(track.def, track);
  const NTV = surface.rails.length;
  const isStreet = !!track.def.street;
  const flat = !!track.def.flatTerrain;
  void flat;   // read but unused in mesh.js:937 too
  const groundMat = groundMatOf(track.def);
  const outerW = surface.outerW;
  void outerW; // read but unused in mesh.js:942 too
  const latsL = surface.rails.map((d) => -d);
  const latsR = surface.rails.slice();
  // flip: the right ribbon needs opposite winding to stay front-facing under BACK culling.
  function* ribbon(lats: readonly number[], flip: boolean): Generator<undefined, void, unknown> {
    const base = pos.length / 3;
    for (let k = 0; k < n; k++) {
      const r: V3 = [track.rx[k]!, track.ry[k]!, track.rz[k]!];
      const u = upOf(track, k);
      const w = hw[k]!;
      const bankLift = bp ? bp.lift[k]! : 0;
      const bankSide = bp ? bp.bsign[k]! : 0;
      for (let v = 0; v < NTV; v++) {
        const lv = lats[v]!;
        const o = (lv < 0 ? -w : w) + lv;
        const t = NTV <= 1 ? 1 : v / (NTV - 1);
        const yBase = surface.heightAt(k, __M.abs(lv), lv < 0 ? -1 : 1);
        let by = 0;
        if (bankLift > 0) {
          let frac = (bankSide * o + w) / (2 * w);
          frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
          by = bankLift * (frac - 0.5) * (1 - t);
        }
        const wx = px[k]! + r[0] * o + u[0] * by;
        const wz = pz[k]! + r[2] * o + u[2] * by;
        let wy = yBase + u[1] * by;
        // Clip terrain that rises OVER the track (heading discriminates own
        // run from a track that curved away). Sorted ascending so the
        // `wy`-dependent gates evaluate in the original 0..n-1 order.
        const _cn = grid.query(wx, wz, grid.maxHw + 27, _cand, true);
        for (let _ci = 0; _ci < _cn; _ci++) {
          const j = _cand[_ci]!;
          let dd = __M.abs(j - k); dd = dd < n - dd ? dd : n - dd;
          if (dd * ds < 6) continue;                  // always skip the vert's immediate own road
          const ex = wx - px[j]!, ez = wz - pz[j]!;
          const d2 = ex * ex + ez * ez;
          const oj = ex * track.rx[j]! + ez * track.rz[j]!;
          const roadYj = py[j]! + bankOffsetAt(track, j, oj);
          // ON another node's tarmac: buried unconditionally.
          const onEdge = hw[j]! - 0.3;
          if (d2 < onEdge * onEdge) {
            if (wy > roadYj - 0.5) wy = roadYj - 0.5;
            continue;
          }
          // Elevated terrain hanging over a LOWER road: carve its channel
          // (not against the vert's own road run).
          const _sameRun = track.tx[k]! * track.tx[j]! + track.tz[k]! * track.tz[j]! > 0.55 && dd * ds < 60;
          if (!_sameRun && wy > roadYj + 0.3) {
            const fr = hw[j]! + 26, nr = hw[j]! + 0.5;
            if (d2 < fr * fr) {
              const dist = __M.sqrt(d2);
              const tt = __M.max(0, __M.min(1, (dist - nr) / (fr - nr)));
              let tgt = (roadYj - 0.4) * (1 - tt * tt) + wy * (tt * tt);
              // A verge must still MEET its own tarmac: hold it at its own
              // road-edge height for the first 8 m.
              const ownDist = __M.abs(o) - w;
              if (ownDist < 8) {
                const hold = 1 - ownDist / 8;
                const floorY = py[k]! + bankOffsetAt(track, k, o) - 0.35;
                if (tgt < floorY) tgt += (floorY - tgt) * hold;
              }
              if (wy > tgt) wy = tgt;
            }
          }
          const align = track.tx[k]! * track.tx[j]! + track.tz[k]! * track.tz[j]!;
          if (align > 0.55 && dd * ds < 60 && !(isStreet && d2 > (hw[j]! + 6) * (hw[j]! + 6))) continue;
          const far = hw[j]! + 12;
          if (d2 > far * far) continue;               // not over/near this node's tarmac
          const near = hw[j]! + 1.0;
          const dist = __M.sqrt(d2);
          const tt = __M.max(0, __M.min(1, (dist - near) / (far - near)));
          const target = (roadYj - 1.6) + tt * tt * 1.6;   // dip under the road (banked), easing back to grade
          if (wy > target) wy = target;
        }
        pos.push(wx, wy, wz);
        nrm.push(0, 0, 0);
        const nz = (hash(k * 3 + v) - 0.5) * 0.04;
        // gravel/runoff verge at the road edge, grading out to grass (no apron)
        const gt = NTV <= 1 ? 1 : v / (NTV - 1);          // 0 inner edge → 1 far
        const tc: V3 = [lerp(runoff[0], grass[0], gt), lerp(runoff[1], grass[1], gt), lerp(runoff[2], grass[2], gt)];
        col.push(tc[0] + nz, tc[1] + nz, tc[2] + nz);
        mat.push(gt < 0.22 ? MAT.ROCK : groundMat);
      }
      if ((k + 1) % 32 === 0 || k + 1 === n) yield;
    }
    const faceSafe = (ia: number, ib: number, ic: number): boolean => {
      const ax = pos[ia * 3]!, ay = pos[ia * 3 + 1]!, az = pos[ia * 3 + 2]!;
      const bx = pos[ib * 3]!, by = pos[ib * 3 + 1]!, bz = pos[ib * 3 + 2]!;
      const cx = pos[ic * 3]!, cy = pos[ic * 3 + 1]!, cz = pos[ic * 3 + 2]!;
      const x = (ax + bx + cx) / 3, y = (ay + by + cy) / 3, z = (az + bz + cz) / 3;
      const cn = grid.query(x, z, grid.maxHw + 1, _cand, false);
      for (let qi = 0; qi < cn; qi++) {
        const j = _cand[qi]!, ex = x - px[j]!, ez = z - pz[j]!, lim = hw[j]! - 0.15;
        if (ex * ex + ez * ez < lim * lim && y > py[j]! + 0.12) return false;
      }
      return true;
    };
    const tri = (a: number, b: number, c: number): void => { if (faceSafe(a, b, c)) idxArr.push(a, b, c); };
    for (let k = 0; k < n; k++) {
      const a = base + k * NTV, b = base + ((k + 1) % n) * NTV;
      for (let v = 0; v < NTV - 1; v++) {
        if (flip) {
          tri(a + v, a + v + 1, b + v);
          tri(a + v + 1, b + v + 1, b + v);
        } else {
          tri(a + v, b + v, a + v + 1);
          tri(a + v + 1, b + v, b + v + 1);
        }
      }
      if ((k + 1) % 128 === 0 || k + 1 === n) yield;
    }

    // REAL NORMALS: area-weighted face normals accumulated over the full
    // strip, normalised once.
    for (let k = 0; k < n; k++) {
      const a = base + k * NTV, b = base + ((k + 1) % n) * NTV;
      for (let v = 0; v < NTV - 1; v++) {
        accumFaceN(nrm, pos, a + v, b + v, a + v + 1);
        accumFaceN(nrm, pos, a + v + 1, b + v, b + v + 1);
      }
      if ((k + 1) % 128 === 0 || k + 1 === n) yield;
    }
    for (let k = 0; k < n; k++) {
      for (let v = 0; v < NTV; v++) {
        const i3 = (base + k * NTV + v) * 3;
        const sgn = nrm[i3 + 1]! < 0 ? -1 : 1;
        const nx = nrm[i3]! * sgn, ny = nrm[i3 + 1]! * sgn, nz2 = nrm[i3 + 2]! * sgn;
        const l = __M.hypot(nx, ny, nz2);
        if (l > 1e-6) { nrm[i3] = nx / l; nrm[i3 + 1] = ny / l; nrm[i3 + 2] = nz2 / l; }
        else { nrm[i3] = 0; nrm[i3 + 1] = 1; nrm[i3 + 2] = 0; }
      }
      if ((k + 1) % 128 === 0 || k + 1 === n) yield;
    }
  }
  yield* ribbon(latsL, false); yield* ribbon(latsR, true);
  return { pos, nrm, col, mat, idx: idxArr };
}

/** The double-sided ground slab under everything. mesh.js:1149 */
export function buildFloor(track: Track): GeomOut {
  const { n, px, py, pz } = track;
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity, pyMin = Infinity;
  for (let k = 0; k < n; k++) {
    if (px[k]! < minx) minx = px[k]!; if (px[k]! > maxx) maxx = px[k]!;
    if (pz[k]! < minz) minz = pz[k]!; if (pz[k]! > maxz) maxz = pz[k]!;
    if (py[k]! < pyMin) pyMin = py[k]!;
  }
  const margin = Math.max(1400, (maxx - minx), (maxz - minz));
  const x0 = minx - margin, x1 = maxx + margin;
  const z0 = minz - margin, z1 = maxz + margin;
  const y = track.surface ? track.surface.floorY : pyMin - 1.0;
  const pal = track.def.palette;
  const g: RV3 = pal.grass || [0.30, 0.34, 0.22];
  const c: V3 = [g[0] * 0.88, g[1] * 0.88, g[2] * 0.88];
  const pos = [x0, y, z0,  x1, y, z0,  x1, y, z1,  x0, y, z1];
  const nrm = [0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0];
  const col = [c[0], c[1], c[2],  c[0], c[1], c[2],  c[0], c[1], c[2],  c[0], c[1], c[2]];
  // Double-sided (both windings) so the up-facing ground is never back-face culled.
  const idx = [0, 1, 2,  0, 2, 3,   0, 2, 1,  0, 3, 2];
  return { pos, nrm, col, idx };
}

// ---- STARTING GRID ----------------------------------------------------
// gridSlot() is the ONE definition of where slot `i` sits (cars and boxes).

/** The default box count: 11 teams x 2 seats. mesh.js:1191 */
export const GRID_SLOTS = 22;
const _gsSmp: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };

/** Grid slot `i`: 8 m pitch, pole 14 m before the line, stagger 40% hw capped at 3 m, P1 left. mesh.js:1193 */
export function gridSlot(track: Track, i: number): GridSlot {
  let s = track.total - 14 - i * 8;
  s %= track.total; if (s < 0) s += track.total;
  sample(track, s, _gsSmp);
  return { s, x: (i % 2 === 0 ? -1 : 1) * __M.min(_gsSmp.hw * 0.4, 3) };
}

// Box geometry: 2.7 m box, front and side lines, open at the rear. mesh.js:1214
const BOX_HALF_W = 1.35, BOX_LEN = 5.0, BOX_FRONT = 2.0;
// 0.20, deliberately bolder than the real thing, for legibility. mesh.js:1231
const PAINT_W = 0.20, GUIDE_GAP = 0.06, GUIDE_W = 0.20, GUIDE_OUT = 0.6;
const GRID_LIFT = 0.05;         // along the road normal, matching buildStartLine
const GUIDE_COL: RV3 = [0.92, 0.78, 0.12];

/**
 * The painted grid boxes, APPENDED to the caller's buffers (the start-line
 * decal's own `out`). Open-coded quads on purpose (coplanar audit). mesh.js:1234
 */
export function buildGridBoxes<O extends GeomOut>(track: Track, out: O, slots?: number | null): O {
  const n = Math.max(2, Math.round(slots != null && slots > 0 ? slots : (track._gridSlots || GRID_SLOTS)));
  const white: RV3 = track.def.palette.line || [0.95, 0.95, 0.98];
  const smp: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
  for (let i = 0; i < n; i++) {
    const slot = gridSlot(track, i);
    sample(track, slot.s, smp);
    const r = norm(smp.r), t = norm(smp.t);
    const u = norm(cross(r, t));
    const P = smp.p, edge = __M.max(1.0, smp.hw - 0.2);
    // Held to the tarmac (a fixed +-edge rail, not M4.clamp).
    const onRoad = (o: number): number => __M.max(-edge, __M.min(edge, o));
    const strip = (o0: number, o1: number, d0: number, d1: number, c: RV3): void => {
      const base = out.pos.length / 3;
      const vert = (o: number, d: number): void => {
        out.pos.push(P[0] + r[0] * o + t[0] * d + u[0] * GRID_LIFT,
                     P[1] + r[1] * o + t[1] * d + u[1] * GRID_LIFT,
                     P[2] + r[2] * o + t[2] * d + u[2] * GRID_LIFT);
        out.nrm.push(u[0], u[1], u[2]);
        out.col.push(c[0], c[1], c[2]);
      };
      // Same CCW winding as the road and as buildStartLine.
      vert(o0, d0); vert(o1, d0); vert(o0, d1); vert(o1, d1);
      out.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    };
    const oL = onRoad(slot.x - BOX_HALF_W), oR = onRoad(slot.x + BOX_HALF_W);
    const dF = BOX_FRONT, dB = BOX_FRONT - BOX_LEN;
    strip(oL, oR, dF - PAINT_W, dF, white);                       // front line
    strip(oL, oL + PAINT_W, dB, dF, white);                       // left side
    strip(oR - PAINT_W, oR, dB, dF, white);                       // right side
    const gF = dF - PAINT_W - GUIDE_GAP;                          // clear of the front line
    strip(onRoad(oL - GUIDE_OUT), onRoad(oR + GUIDE_OUT), gF - GUIDE_W, gF, GUIDE_COL);
  }
  return out;
}

// ── The pit lane, as an actual second road ──────────────────────────────────
// Built from track.pit (pit.js) and APPENDED to the start-line decal's
// buffers like buildGridBoxes. mesh.js:1272
const PIT_LIFT = 0.05;          // along the road normal, matching buildStartLine
// Paint on the lane rides the ribbon's OWN surface this much higher. mesh.js:1294
const PIT_PAINT = 0.015;

// The ribbon's vertex at node k, lateral `lat` (world-right). mesh.js:1297
function laneVert(track: Track, k: number, lat: number, lift: number): V3 {
  const u = upOf(track, k), by = bankOffsetAt(track, k, lat) + PIT_LIFT + lift;
  return [track.px[k]! + track.rx[k]! * lat + u[0] * by,
          track.py[k]! + track.ry[k]! * lat + u[1] * by,
          track.pz[k]! + track.rz[k]! * lat + u[2] * by];
}
// …and between nodes, lerped along the arc. mesh.js:1304
function laneAt(track: Track, s: number, lat: number, lift: number): V3 {
  const n = track.n, L = track.total, fi = ((s % L + L) % L) / L * n;
  const i = Math.floor(fi) % n, f = fi - Math.floor(fi);
  const A = laneVert(track, i, lat, lift), B = laneVert(track, (i + 1) % n, lat, lift);
  return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
}
// One flat paint quad ON the lane, PIT_PAINT above it, cut at every node. mesh.js:1316
function pitPaint(track: Track, out: GeomOut, s: number, lon0: number, lon1: number,
                  a0: number, a1: number, b0: number, b1: number, col: RV3, nrm: RV3): void {
  if (lon1 < lon0) { [lon0, lon1, a0, a1, b0, b1] = [lon1, lon0, b0, b1, a0, a1]; }
  const ds = track.total / track.n, rows = [lon0];
  for (let c = (Math.floor((s + lon0) / ds) + 1) * ds - s; c < lon1 - 1e-4; c += ds) if (c > lon0 + 1e-4) rows.push(c);
  rows.push(lon1);
  let prev: [V3, V3] | null = null;
  for (const lon of rows) {
    const t = lon1 > lon0 ? (lon - lon0) / (lon1 - lon0) : 0;
    const l0 = a0 + (b0 - a0) * t, l1 = a1 + (b1 - a1) * t;
    const row: [V3, V3] = [laneAt(track, s + lon, Math.min(l0, l1), PIT_PAINT), laneAt(track, s + lon, Math.max(l0, l1), PIT_PAINT)];
    if (prev) {
      const base = out.pos.length / 3;
      for (const P of [prev[0], prev[1], row[0], row[1]]) {
        out.pos.push(P[0], P[1], P[2]); out.nrm.push(nrm[0], nrm[1], nrm[2]); out.col.push(col[0], col[1], col[2]);
      }
      out.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    prev = row;
  }
}
const PIT_LINE_W = 0.10;        // FIM §4.11.10: 10 cm lines
const PIT_EDGE_W = 0.15;        // the lane's wall-side edge, a little bolder
// Fallback for a track built without a road mesh (else track.asphaltCol). mesh.js:1341
const PIT_TARMAC: RV3 = [0.135, 0.145, 0.165];

/**
 * The pit complex's tarmac ribbon (verge, fast lane, corridor, working lane,
 * apron) in the circuit's own asphalt, then its paint (buildPitMarks).
 * mesh.js:1342
 */
export function buildPitLane<O extends GeomOut>(track: Track, out: O): O {
  const p = track.pit;
  if (!p) return out;
  const { hw, n, total: L } = track;
  const white: RV3 = track.def.palette.line || [0.95, 0.95, 0.98];
  const sd = p.side, o = p.off, ds = L / n;
  const road: RV3 = track.asphaltCol || PIT_TARMAC;
  const shade = (f: number): V3 => [road[0] * f, road[1] * f, road[2] * f];
  const TARMAC = shade(0.94), WORK = shade(1.12), APRON = shade(1.34);
  // The bands at one node as [offset beyond hw, colour of the band that
  // starts here], ascending outward; the inner edge is dashed before the wall.
  const bands = (k: number): [number, RV3 | null][] | null => {
    const w = p.w[k]!;
    if (!(w > 0.01)) return null;
    const v = p.v[k]!, b = p.b ? p.b[k]! : w;
    const fi = o.fastIn * v, fo = o.fastOut * w;
    const co = fo + (o.corrOut - o.fastOut) * b, wo = co + (o.workOut - o.corrOut) * b;
    const apron = Math.max(wo, o.outer * w + 0.3);
    const dash = Math.floor((k * ds) / 2) % 2 === 0;
    const innerCol = v < 0.5 ? (dash ? white : TARMAC) : white;
    const edge = Math.min(PIT_EDGE_W, Math.max(0, fo - fi) * 0.5);
    const lw = Math.min(PIT_LINE_W, Math.max(0, co - fo) * 0.3);
    return [
      [0, TARMAC],
      [fi, innerCol], [fi + edge, TARMAC], [Math.max(fi + edge, fo - lw), white], [fo, TARMAC],
      [Math.max(fo, co - lw), white], [co, WORK], [Math.max(co, wo - lw), white], [wo, APRON],
      [apron, null],
    ];
  };
  const at = (k: number, lat: number): V3 => laneVert(track, k, lat, 0);
  // World-right ordered laterals so the winding matches the road on either side.
  const lat = (k: number, off: number): number => sd * (hw[k]! + off);
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    const a = bands(k), b = bands(k2);
    if (!a || !b) continue;
    const ua = upOf(track, k), ub = upOf(track, k2);
    for (let i = 0; i + 1 < a.length; i++) {
      const c = a[i]![1];
      if (!c) continue;
      if (Math.abs(a[i + 1]![0] - a[i]![0]) < 0.02 && Math.abs(b[i + 1]![0] - b[i]![0]) < 0.02) continue;
      const l0 = sd > 0 ? lat(k, a[i]![0]) : lat(k, a[i + 1]![0]);
      const l1 = sd > 0 ? lat(k, a[i + 1]![0]) : lat(k, a[i]![0]);
      const m0 = sd > 0 ? lat(k2, b[i]![0]) : lat(k2, b[i + 1]![0]);
      const m1 = sd > 0 ? lat(k2, b[i + 1]![0]) : lat(k2, b[i]![0]);
      const base = out.pos.length / 3;
      const vert = (P: RV3, u: RV3): void => {
        out.pos.push(P[0], P[1], P[2]);
        out.nrm.push(u[0], u[1], u[2]);
        out.col.push(c[0], c[1], c[2]);
      };
      vert(at(k, l0), ua); vert(at(k, l1), ua);
      vert(at(k2, m0), ub); vert(at(k2, m1), ub);
      out.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  return buildPitMarks(track, out);
}

/**
 * The lane's paint: the entry/exit lines (FIM §4.11.10.1/.2) and the entry
 * road's chevrons, every quad through pitPaint(). mesh.js:1423
 */
export function buildPitMarks<O extends GeomOut>(track: Track, out: O): O {
  const p = track.pit;
  if (!p) return out;
  const { n, total: L } = track, sd = p.side, o = p.off;
  const white: RV3 = track.def.palette.line || [0.95, 0.95, 0.98];
  // THE ENTRY LINE AND THE EXIT LINE.
  const smp: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
  for (const s of [p.sIn, p.sOut]) {
    const k = ((Math.round((s / L) * n) % n) + n) % n;
    if (!(p.w[k]! > 0.5)) continue;
    sample(track, s, smp);
    const uu = norm(cross(norm(smp.r), norm(smp.t)));
    const x0 = sd * (smp.hw + o.fastIn * p.v[k]! + 0.05), x1 = sd * (smp.hw + o.workOut * p.w[k]! - 0.05);
    pitPaint(track, out, s, -0.05, 0.05, x0, x1, x0, x1, white, uu);
  }
  // ARROWS down the entry road: a white chevron every 12 m (skipped while w < 0.25).
  for (let d = 10; d < p.entryRoadM - 4; d += 12) {
    const s = ((p.sA + d) % L + L) % L, k = ((Math.round((s / L) * n) % n) + n) % n;
    if (!(p.w[k]! > 0.25)) continue;
    sample(track, s, smp);
    const uu = norm(cross(norm(smp.r), norm(smp.t)));
    const xc = sd * (smp.hw + (o.fastIn * p.v[k]! + o.workOut * p.w[k]!) * 0.5);
    pitPaint(track, out, s, -1.2, 0.5, xc - 0.16, xc + 0.16, xc - 0.16, xc + 0.16, white, uu);   // the shaft
    pitPaint(track, out, s, 0.3, 1.4, xc - 0.7, xc + 0.7, xc, xc, white, uu);                     // the head (a triangle)
  }
  return out;
}

/**
 * The entry hatch as pure numbers, one stripe per 2 m from the entry road's
 * start until `v` reaches 0.5, 1.2 m in from the road edge. mesh.js:1461
 */
export function pitHatch(track: Track | null | undefined): PitHatchStripe[] {
  const p = track && track.pit, out: PitHatchStripe[] = [];
  if (!p || p.painted || !(p.entryRoadM > 0)) return out;
  const t = track!;
  const L = t.total, n = t.n, W = 1.2;
  const smp: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
  for (let d = 2; d < p.entryRoadM; d += 2) {
    const s = ((p.sA + d) % L + L) % L, k = ((Math.round((s / L) * n) % n) + n) % n;
    if (p.v[k]! >= 0.5) break;
    sample(t, s, smp);
    out.push({ s, x0: smp.hw - W, x1: smp.hw - 0.05, w: W });
  }
  return out;
}

/**
 * THE HATCH, into the ROAD buffer: a 45° white stripe every 2 m on the road
 * side of the peel line, 2 cm over the road's +0.02; `trk` hw = 0.
 * mesh.js:1487
 */
export function buildPitHatch<O extends TrkGeomOut>(track: Track, out: O): O {
  const hatch = pitHatch(track);
  if (!hatch.length) return out;
  const { n, total: L } = track, sd = track.pit!.side;
  const white: RV3 = track.def.palette.line || [0.95, 0.95, 0.98];
  const smp: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
  for (const h of hatch) {
    const k = ((Math.round((h.s / L) * n) % n) + n) % n;
    sample(track, h.s, smp);
    const rr = norm(smp.r), tt = norm(smp.t), uu = norm(cross(rr, tt));
    const P = (lon: number, x: number): [number, number, number, number] => {
      const by = bankOffsetAt(track, k, x) + 0.04;   // the road is at +0.02 (buildRoad)
      return [smp.p[0] + rr[0] * x + tt[0] * lon + uu[0] * by,
              smp.p[1] + rr[1] * x + tt[1] * lon + uu[1] * by,
              smp.p[2] + rr[2] * x + tt[2] * lon + uu[2] * by, x];
    };
    // Laterals SORTED (lo/hi) so the winding faces up on either pit side.
    const xa = Math.min(sd * h.x0, sd * h.x1), xb = Math.max(sd * h.x0, sd * h.x1);
    const base = out.pos.length / 3;
    const corners: [number, number][] = [[-h.w, xa], [0, xb], [-h.w + 0.16, xa], [0.16, xb]];
    for (const [lon, x] of corners) {
      const Q = P(lon, x);
      out.pos.push(Q[0], Q[1], Q[2]); out.nrm.push(uu[0], uu[1], uu[2]); out.col.push(white[0], white[1], white[2]);
      if (out.mat) out.mat.push(MAT.FLAT);
      if (out.trk) out.trk.push(h.s, x, 0);
    }
    out.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  return out;
}

/**
 * THE PAINTED BOXES, one per `row.boxes[i]`, 8 m long, open at the rear,
 * the team's colour on the front bar and the garage edge. Records the painted
 * arcs on `p.row.painted`. mesh.js:1524
 */
export function buildPitBoxes<O extends GeomOut>(track: Track, out: O): O {
  const p = track.pit;
  if (!p || !p.row) return out;
  const L = track.total, n = track.n, sd = p.side, o = p.off;
  const smp: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
  const white: RV3 = track.def.palette.line || [0.95, 0.95, 0.98];
  const painted: number[] = [];
  for (const box of p.row.boxes) {
    const s = box.s;
    const k = ((Math.round((s / L) * n) % n) + n) % n;
    if (!(p.w[k]! > 0.98)) continue;
    sample(track, s, smp);
    const uu = norm(cross(norm(smp.r), norm(smp.t)));
    const strip = (lon0: number, lon1: number, lat0: number, lat1: number, col: RV3): void =>
      pitPaint(track, out, s, lon0, lon1, lat0, lat1, lat0, lat1, col, uu);
    // A bay-less complex paints the box across the fast lane.
    const lane = p.hasBays === false;
    const wi = sd * (smp.hw + (lane ? o.fastIn * p.v[k]! + 0.15 : o.corrOut + 0.3));
    const wo = sd * (smp.hw + (lane ? o.fastOut * p.w[k]! - 0.15 : o.workOut - 0.3));
    const x0 = Math.min(wi, wo), x1 = Math.max(wi, wo);
    const boxLen = p.row.boxLen, paint = 0.16;
    const outer = sd > 0 ? x1 : x0;
    const outerIn = sd > 0 ? x1 - 0.28 : x0 + 0.28;
    strip(boxLen / 2 - paint, boxLen / 2, x0, x1, white);                     // front line
    strip(-boxLen / 2, boxLen / 2, x0, x0 + paint, white);                    // side lines
    strip(-boxLen / 2, boxLen / 2, x1 - paint, x1, white);
    strip(boxLen / 2 + 0.25, boxLen / 2 + 0.55, x0, x1, box.col);             // the team's bar ahead
    strip(-boxLen / 2, boxLen / 2, Math.min(outer, outerIn), Math.max(outer, outerIn), box.col);   // …and along the garage edge
    painted.push(s);
  }
  p.row.painted = painted;
  return out;
}
