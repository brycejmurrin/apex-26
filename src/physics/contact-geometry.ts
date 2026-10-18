/**
 * Physical road boundaries and oriented boxes in the local road plane. No car mutation.
 * Port of f1-game js/physics/contact-geometry.js (`ContactGeometry`, :3-190), verbatim.
 */
import { bumpRestitution } from "./ai-contact";
import { EXIT_WALL_W } from "./track";
import type { PostLimits, WallLimits, WallLimitsTrack, WallPrevious } from "./track";

const HALF_LONG = 2.4,
  HALF_WIDE = 1;
export const INERTIA = (4.8 * 4.8 + 2 * 2) / 12;
export const FRICTION = 0.5;

function radius(angle: number, nx: number, ny: number): number {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return HALF_LONG * Math.abs(nx * c + ny * s) + HALF_WIDE * Math.abs(-nx * s + ny * c);
}

export interface Overlap {
  depth: number;
  nx: number;
  ny: number;
}

/** Normal points from B to A. Four SAT axes give the exact rectangle test. :11-22. */
export function overlap(dx: number, dy: number, angleA: number, angleB: number, out: Partial<Overlap> = {}): Overlap | null {
  let depth = Infinity,
    nx = 0,
    ny = 0;
  for (let i = 0; i < 4; i++) {
    const a = (i < 2 ? angleA : angleB) + ((i % 2) * Math.PI) / 2;
    const x = Math.cos(a),
      y = Math.sin(a),
      d = dx * x + dy * y;
    const p = radius(angleA, x, y) + radius(angleB, x, y) - Math.abs(d);
    if (!(p > 1e-9)) return null;
    if (p < depth) {
      depth = p;
      const sign = d < 0 ? -1 : 1;
      nx = x * sign;
      ny = y * sign;
    }
  }
  out.depth = depth;
  out.nx = nx;
  out.ny = ny;
  return out as Overlap;
}

export interface Sweep extends Overlap {
  time: number;
}

/** Linear time-of-impact for fixed orientations. :25-43. */
export function sweep(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  angleA: number,
  angleB: number,
  out: Partial<Sweep> = {},
): Sweep | null {
  let enter = 0,
    leave = 1,
    nx = 0,
    ny = 0;
  for (let i = 0; i < 4; i++) {
    const a = (i < 2 ? angleA : angleB) + ((i % 2) * Math.PI) / 2;
    const x = Math.cos(a),
      y = Math.sin(a);
    const r = radius(angleA, x, y) + radius(angleB, x, y);
    const start = x0 * x + y0 * y,
      delta = (x1 - x0) * x + (y1 - y0) * y;
    if (Math.abs(delta) < 1e-9) {
      if (Math.abs(start) >= r) return null;
      continue;
    }
    let lo = (-r - start) / delta,
      hi = (r - start) / delta;
    if (lo > hi) [lo, hi] = [hi, lo];
    if (lo > enter) {
      enter = lo;
      const sign = delta > 0 ? -1 : 1;
      nx = x * sign;
      ny = y * sign;
    }
    leave = Math.min(leave, hi);
    if (enter > leave) return null;
  }
  if (!(enter > 0 && enter <= 1) || leave < 0) return null;
  out.time = enter;
  out.nx = nx;
  out.ny = ny;
  out.depth = 0;
  return out as Sweep;
}

interface Pt {
  x: number;
  y: number;
}
function support(angle: number, nx: number, ny: number, out: Pt): void {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const l = nx * c + ny * s,
    w = -nx * s + ny * c;
  const a = Math.abs(l) < 1e-8 ? 0 : Math.sign(l) * HALF_LONG;
  const b = Math.abs(w) < 1e-8 ? 0 : Math.sign(w) * HALF_WIDE;
  out.x = a * c - b * s;
  out.y = a * s + b * c;
}

/** One body in the contact plane (collide.js `body()`). */
export interface ContactBody {
  angle: number;
  vx: number;
  vy: number;
  omega: number;
  invMass: number;
  invInertia: number;
}

export interface Impulse {
  ax: number;
  ay: number;
  aw: number;
  bx: number;
  by: number;
  bw: number;
  closing: number;
  magnitude: number;
  slide: number;
}

const pa: Pt = { x: 0, y: 0 },
  pb: Pt = { x: 0, y: 0 };
/** Restitution + Coulomb friction on oriented pairs only. :83-118 (design notes :50-82). */
export function impulse(
  a: ContactBody,
  b: ContactBody,
  dx: number,
  dy: number,
  contact: { readonly nx: number; readonly ny: number },
  out: Partial<Impulse> = {},
): Impulse {
  const { nx, ny } = contact;
  support(a.angle, -nx, -ny, pa);
  support(b.angle, nx, ny, pb);
  const px = (dx + pa.x + pb.x) / 2,
    py = (dy + pa.y + pb.y) / 2;
  const ax = px - dx,
    ay = py - dy,
    bx = px,
    by = py;
  const ca = ax * ny - ay * nx,
    cb = bx * ny - by * nx;
  const relative = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny + a.omega * ca - b.omega * cb;
  const denom = a.invMass + b.invMass + ca * ca * a.invInertia + cb * cb * b.invInertia;
  const oriented = a.angle !== 0 || b.angle !== 0;
  const closing = relative < 0 ? -relative : 0;
  const e = oriented ? bumpRestitution(closing) : 0;
  const j = relative < 0 && denom > 0 ? (-(1 + e) * relative) / denom : 0;
  let jax = j * a.invMass * nx,
    jay = j * a.invMass * ny,
    jaw = j * ca * a.invInertia;
  let jbx = -j * b.invMass * nx,
    jby = -j * b.invMass * ny,
    jbw = -j * cb * b.invInertia;
  if (oriented && j > 0) {
    const tx = -ny,
      ty = nx;
    const ta = ax * ty - ay * tx,
      tb = bx * ty - by * tx;
    const denomT = a.invMass + b.invMass + ta * ta * a.invInertia + tb * tb * b.invInertia;
    if (denomT > 0) {
      const slide = (a.vx + jax - b.vx - jbx) * tx + (a.vy + jay - b.vy - jby) * ty + (a.omega + jaw) * ta - (b.omega + jbw) * tb;
      const lim = FRICTION * j,
        want = -slide / denomT;
      const jt = want > lim ? lim : want < -lim ? -lim : want;
      jax += jt * a.invMass * tx;
      jay += jt * a.invMass * ty;
      jaw += jt * ta * a.invInertia;
      jbx -= jt * b.invMass * tx;
      jby -= jt * b.invMass * ty;
      jbw -= jt * tb * b.invInertia;
      out.slide = jt;
    } else out.slide = 0;
  } else out.slide = 0;
  out.ax = jax;
  out.ay = jay;
  out.aw = jaw;
  out.bx = jbx;
  out.by = jby;
  out.bw = jbw;
  out.closing = closing;
  out.magnitude = j;
  return out as Impulse;
}

/**
 * Shared driving/contact/takeover boundary over the raw built track. :146-184.
 * Caller-owned output and post scratch; the side is classified from the
 * candidate x before any clamping.
 */
export function wallLimitsOf(
  track: WallLimitsTrack,
  s: number,
  x: number,
  out: WallLimits,
  postLim: PostLimits,
  previous?: WallPrevious | null,
): WallLimits {
  let wallR = track.wallAt(s, 1),
    wallL = track.wallAt(s, -1);
  let laneMin = 0,
    pitSd = 0;
  const p = track.pit;
  const pitX = previous ? previous.x : x;
  let previousFace: number | null = null;
  const hw = track.hw;
  if (previous && p && !p.painted) {
    const pk = ((Math.round((previous.s / track.total) * track.n) % track.n) + track.n) % track.n;
    if ((p.v[pk] as number) >= 0.98) previousFace = (hw[pk] as number) + p.bands.verge;
    else if ((p.w[pk] as number) >= EXIT_WALL_W && (((previous.s - p.sOut) % track.total) + track.total) % track.total < p.exitRoadM)
      previousFace = (hw[pk] as number) + p.bands.verge * (p.v[pk] as number);
  }
  if (p && !p.painted) {
    const k = ((Math.round((s / track.total) * track.n) % track.n) + track.n) % track.n;
    if ((p.v[k] as number) >= 0.98) {
      pitSd = p.side;
      const face = (hw[k] as number) + p.bands.verge;
      if (previousFace === null ? pitX * pitSd < face + 0.125 : pitX * pitSd < previousFace + 0.125) {
        if (pitSd > 0) wallR = Math.min(wallR, face - 1.1);
        else wallL = Math.min(wallL, face - 1.1);
      } else laneMin = (hw[k] as number) + p.off.fastIn + 1.0;
    } else if ((p.w[k] as number) >= EXIT_WALL_W && (((s - p.sOut) % track.total) + track.total) % track.total < p.exitRoadM) {
      pitSd = p.side;
      const wallLat = (hw[k] as number) + p.bands.verge * (p.v[k] as number);
      if (previousFace === null ? pitX * pitSd < wallLat + 0.125 : pitX * pitSd < previousFace + 0.125) {
        if (pitSd > 0) wallR = Math.min(wallR, wallLat - 1.15);
        else wallL = Math.min(wallL, wallLat - 1.15);
      } else laneMin = wallLat + 0.3 + 1.0;
    }
  }
  if (track.posts && track.posts.length) {
    track.postLimits(s, previous ? previous.x : x, postLim);
    if (postLim.r < wallR) wallR = postLim.r;
    if (postLim.l < wallL) wallL = postLim.l;
    if (postLim.minOut > laneMin) {
      laneMin = postLim.minOut;
      pitSd = postLim.side;
    }
  }
  out.r = wallR;
  out.l = wallL;
  out.laneMin = laneMin;
  out.side = pitSd;
  return out;
}
