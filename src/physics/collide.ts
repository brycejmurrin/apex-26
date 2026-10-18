/**
 * Collide: car-to-car contact in the Frenet (prog, x) plane: the arc-bucket
 * broadphase and traffic scans, the mass-weighted relaxation passes, the hard
 * separation pass, the post-contact barrier clamp and the world-pose writeback.
 *
 * Port of f1-game js/physics/collide.js (`Collide`, :12-548), verbatim in
 * operation order; the design notes for every block are in that file. The
 * f1-game globals it touched (IncidentSim, DebrisWorld, Log) arrive as
 * optional deps; `G` is the live `CollideCtx`, read at each call.
 */
import type { NetPlayOwnership } from "../contracts";
import * as AiContact from "./ai-contact";
import type { PhysCar } from "./car";
import { PhysicsConsts } from "./consts";
import * as ContactGeometry from "./contact-geometry";
import type { ContactBody, Impulse, Overlap, Sweep } from "./contact-geometry";
import { NO_DEBRIS, NO_INCIDENTS } from "./fx";
import type { DebrisFx, IncidentFx } from "./fx";
import { clamp, wrapDelta } from "./math";
import type { PhysicsTrack, PostLimits, WallLimits } from "./track";

const TWO_PI = 2 * Math.PI;
const FIXED_DT = PhysicsConsts.FIXED_DT || 1 / 60;
export const LCAR = 4.8,
  WCAR = 2.0;
const HL = LCAR / 2,
  WL = WCAR / 2;

// YAW-AWARE EXTENTS (collide.js:22-60): only a human's yawVis widens a car.
const YAW_LO = (20 * Math.PI) / 180,
  YAW_HI = (60 * Math.PI) / 180;
function yawMix(psi: number): number {
  const a = psi < 0 ? -psi : psi;
  if (!(a > YAW_LO)) return 0;
  if (a >= YAW_HI) return 1;
  const t = (a - YAW_LO) / (YAW_HI - YAW_LO);
  return t * t * (3 - 2 * t);
}
function extLong(c: PhysCar): number {
  const psi = c.human ? c.yawVis || 0 : 0;
  const k = yawMix(psi);
  return HL * Math.abs(Math.cos(psi * k)) + WL * Math.abs(Math.sin(psi * k));
}
function extLat(c: PhysCar): number {
  const psi = c.human ? c.yawVis || 0 : 0;
  const k = yawMix(psi);
  return HL * Math.abs(Math.sin(psi * k)) + WL * Math.abs(Math.cos(psi * k));
}
function bodyAngle(c: PhysCar): number {
  const psi = c.human && Number.isFinite(c.yawVis) ? (c.yawVis as number) : 0;
  return psi * yawMix(psi);
}
const LCAR_MAX = 2 * Math.hypot(HL, WL);

// Wrap-aware arc buckets (collide.js:62-150).
type ProgOf = (c: PhysCar) => number;
const _arcBuckets: (PhysCar[] | undefined)[] = [];
const _arcBucketIds: number[] = [];
const _arcN: number[] = [];
let _arcNB = 0,
  _arcWidth = LCAR_MAX,
  _arcL = 1;
function _arcProg(c: PhysCar | null | undefined): number {
  if (c && c._snapProg != null && Number.isFinite(c._snapProg)) return c._snapProg;
  return c && c._nOk ? (c._nProg as number) : c ? c.prog : 0;
}
function _arcClear(): void {
  for (let i = 0; i < _arcBucketIds.length; i++) {
    const id = _arcBucketIds[i] as number;
    _arcN[id] = 0;
  }
  _arcBucketIds.length = 0;
}
export function fillArcBuckets(ranked: readonly PhysCar[], L: number, width?: number, progOf?: ProgOf): number {
  _arcClear();
  L = L || 1;
  width = width || LCAR_MAX;
  const nB = Math.max(1, Math.floor(L / width) | 0);
  _arcNB = nB;
  _arcWidth = width;
  _arcL = L;
  const of = progOf || _arcProg;
  const n = ranked.length;
  for (let i = 0; i < n; i++) {
    const c = ranked[i] as PhysCar;
    const prog = of(c);
    let b = Math.floor((((prog % L) + L) % L) / width) % nB;
    if (b < 0) b += nB;
    let arr = _arcBuckets[b];
    if (!arr) {
      arr = _arcBuckets[b] = [];
      _arcN[b] = 0;
    }
    const len = _arcN[b] as number;
    if (len === 0) _arcBucketIds.push(b);
    arr[len] = c;
    _arcN[b] = len + 1;
  }
  return nB;
}
export function forArcNear(c: PhysCar, L: number, reach: number, fn: (o: PhysCar) => void, progOf?: ProgOf): void {
  const nB = _arcNB;
  if (!nB || !fn) return;
  const of = progOf || _arcProg;
  const p = of(c);
  const W = _arcWidth;
  const LL = L || _arcL || 1;
  let b0 = Math.floor((((p % LL) + LL) % LL) / W) % nB;
  if (b0 < 0) b0 += nB;
  const span = Number.isFinite(reach) ? (Math.floor(reach / W) | 0) + 1 : nB;
  if (!Number.isFinite(reach) || nB <= 2 * span + 1) {
    const nIds = _arcBucketIds.length;
    for (let k = 0; k < nIds; k++) {
      const bid = _arcBucketIds[k] as number,
        arr = _arcBuckets[bid];
      if (!arr) continue;
      for (let i = 0, n = _arcN[bid] as number; i < n; i++) {
        const o = arr[i] as PhysCar;
        if (o !== c) fn(o);
      }
    }
    return;
  }
  for (let d = -span; d <= span; d++) {
    let id = b0 + d;
    id %= nB;
    if (id < 0) id += nB;
    const arr = _arcBuckets[id],
      n = arr ? (_arcN[id] as number) : 0;
    if (!n) continue;
    for (let i = 0; i < n; i++) {
      const o = (arr as PhysCar[])[i] as PhysCar;
      if (o !== c) fn(o);
    }
  }
}
function _liveProg(c: PhysCar): number {
  return c.prog;
}
const PC = PhysicsConsts;
const _towRange = PC.TOW_RANGE || 34,
  _towHalfW = PC.TOW_HALF_W || 4,
  _blockerHalfW = PC.BLOCKER_HALF_W || 2.2;

/** The traffic scan result. POOLED: `scanTraffic` returns the same object every call. */
export interface TrafficScan {
  c: PhysCar | null;
  L: number;
  BACK: number;
  REJ: number;
  MIN_GAP: number;
  street: boolean;
  roomL: number;
  roomR: number;
  nearbyN: number;
  sep: number;
  blocker: PhysCar | null;
  blockerGap: number;
  towCar: PhysCar | null;
  towGap: number;
  chaser: PhysCar | null;
  chaserGap: number;
  alongO: PhysCar | null;
  alongDx: number;
  alongDprog: number;
  alongAdx: number;
}
const _traf: TrafficScan = {
  c: null,
  L: 0,
  BACK: 0,
  REJ: 0,
  MIN_GAP: 0,
  street: false,
  roomL: 0,
  roomR: 0,
  nearbyN: 0,
  sep: 0,
  blocker: null,
  blockerGap: Infinity,
  towCar: null,
  towGap: Infinity,
  chaser: null,
  chaserGap: Infinity,
  alongO: null,
  alongDx: 0,
  alongDprog: 0,
  alongAdx: Infinity,
};
const _brakePlan = 0.5 * (PC.BRAKE || 22),
  _blockerMargin = 10,
  _blockerReachMax = 160;
export function blockerReach(closing: number): number {
  return closing > 0 ? Math.min(_blockerReachMax, _blockerMargin + (closing * closing) / (2 * _brakePlan)) : 0;
}
function _onTrafO(o: PhysCar): void {
  const s = _traf,
    c = s.c as PhysCar;
  const fin = !!o.finished;
  let dprog = (o._snapProg as number) - c.prog;
  if (!Number.isFinite(dprog)) return;
  const ad = dprog < 0 ? -dprog : dprog,
    L = s.L,
    REJ = s.REJ;
  if (ad > REJ && ad < L - REJ) return;
  dprog = ((((dprog + L / 2) % L) + L) % L) - L / 2;
  if (dprog < -s.BACK) return;
  if (dprog > 34) {
    if (
      dprog < s.blockerGap &&
      dprog < blockerReach(c.speed - (o._snapSpeed || 0)) &&
      Math.abs((o._snapX as number) - c.x) < _blockerHalfW
    ) {
      s.blocker = o;
      s.blockerGap = dprog;
    }
    return;
  }
  const dx = (o._snapX as number) - c.x;
  const adp = dprog < 0 ? -dprog : dprog;
  if (adp < 5.5) {
    if (dx >= 0) s.roomR = Math.min(s.roomR, Math.abs(dx) - 1.0);
    else s.roomL = Math.min(s.roomL, Math.abs(dx) - 1.0);
    const adx = dx < 0 ? -dx : dx;
    if (adx < s.alongAdx) {
      s.alongO = o;
      s.alongDx = dx;
      s.alongDprog = dprog;
      s.alongAdx = adx;
    }
  }
  if (adp < 6.5) {
    s.nearbyN++;
    const deficit = s.MIN_GAP - (dx < 0 ? -dx : dx);
    if (deficit > 0) s.sep += (dx <= 0 ? 1 : -1) * deficit * (1 - adp / 6.5);
  }
  if (
    dprog > 0.5 &&
    dprog < s.blockerGap &&
    Math.abs(dx) < (o === c.passFailOf && (c.passFailT as number) > 0 && !s.street ? 6 : _blockerHalfW)
  ) {
    s.blocker = o;
    s.blockerGap = dprog;
  }
  if (fin) return;
  if (dprog > 0.5 && dprog < s.towGap && Math.abs(dx) < _towHalfW) {
    s.towCar = o;
    s.towGap = dprog;
  }
  if (dprog < -0.5 && -dprog < s.chaserGap && Math.abs(dx) < (!s.street && -dprog < 0.5 * Math.max(c.speed, 10) ? 5.5 : 3)) {
    s.chaser = o;
    s.chaserGap = -dprog;
  }
}
/** collide.js:206-219. Needs `fillArcBuckets` over the field first. */
export function scanTraffic(
  c: PhysCar,
  L: number,
  BACK: number,
  REJ: number,
  MIN_GAP: number,
  street: boolean,
  roomL: number,
  roomR: number,
): TrafficScan {
  const s = _traf;
  s.c = c;
  s.L = L;
  s.BACK = BACK;
  s.REJ = REJ;
  s.MIN_GAP = MIN_GAP;
  s.street = !!street;
  s.roomL = roomL;
  s.roomR = roomR;
  s.nearbyN = 0;
  s.sep = 0;
  s.blocker = null;
  s.blockerGap = Infinity;
  s.towCar = null;
  s.towGap = Infinity;
  s.chaser = null;
  s.chaserGap = Infinity;
  s.alongO = null;
  s.alongDx = 0;
  s.alongDprog = 0;
  s.alongAdx = Infinity;
  const reach = Math.max(REJ, blockerReach(c.speed));
  s.REJ = reach;
  forArcNear(c, L, reach, _onTrafO, _liveProg);
  s.roomL = Math.max(0, s.roomL);
  s.roomR = Math.max(0, s.roomR);
  return s;
}

export interface OtScan {
  c: PhysCar | null;
  L: number;
  W: number;
  ahead: PhysCar | null;
  gapAhead: number;
  skip: ((o: PhysCar) => boolean) | null;
}
const _ot: OtScan = { c: null, L: 0, W: 0, ahead: null, gapAhead: Infinity, skip: null };
function _onOtO(o: PhysCar): void {
  const s = _ot,
    c = s.c as PhysCar;
  if (o.finished || o.retired || (s.skip && s.skip(o))) return;
  const dp = (o._snapProg as number) - c.prog,
    adp = dp < 0 ? -dp : dp,
    L = s.L,
    otW = s.W;
  if (adp > otW && adp < L - otW) return;
  const d = ((((dp + L / 2) % L) + L) % L) - L / 2;
  if (d > 0.5 && d < s.gapAhead) {
    s.ahead = o;
    s.gapAhead = d;
  }
}
export function scanOtAhead(c: PhysCar, L: number, otW: number, skip?: ((o: PhysCar) => boolean) | null): OtScan {
  _ot.c = c;
  _ot.L = L;
  _ot.W = otW;
  _ot.ahead = null;
  _ot.gapAhead = Infinity;
  _ot.skip = skip || null;
  forArcNear(c, L, otW, _onOtO, _liveProg);
  return _ot;
}
export interface TowScan {
  c: PhysCar | null;
  L: number;
  tc: PhysCar | null;
  tg: number;
}
const _tow: TowScan = { c: null, L: 0, tc: null, tg: Infinity };
function _onTowO(o: PhysCar): void {
  const s = _tow,
    c = s.c as PhysCar;
  if (o.finished || o.retired) return;
  let dprog = (o._snapProg as number) - c.prog;
  if (!Number.isFinite(dprog)) return;
  const ad = dprog < 0 ? -dprog : dprog,
    L = s.L;
  if (ad > _towRange + 0.1 && ad < L - _towRange - 0.1) return;
  dprog = ((((dprog + L / 2) % L) + L) % L) - L / 2;
  if (dprog > 0.5 && dprog < s.tg && Math.abs((o._snapX as number) - c.x) < _towHalfW) {
    s.tc = o;
    s.tg = dprog;
  }
}
export function scanTow(c: PhysCar, L: number): TowScan {
  _tow.c = c;
  _tow.L = L;
  _tow.tc = null;
  _tow.tg = Infinity;
  forArcNear(c, L, _towRange + 0.1, _onTowO, _liveProg);
  return _tow;
}

const CORR_EPS = 1e-3;
const _lim: WallLimits = { r: 0, l: 0, laneMin: 0, side: 0 },
  _postLim: PostLimits = { r: 0, l: 0, minOut: 0, side: 0 };

/** The live façade `resolveCollisions` reads once per step (collide.js:419). */
export interface CollideCtx {
  readonly wrapS: (s: number) => number;
  readonly track: PhysicsTrack | null;
  readonly player: PhysCar | null;
  readonly netPlay: NetPlayOwnership;
  readonly raceT: number;
  readonly PACE: number;
  /** POOLED {x, z}: copy before the next call. */
  readonly worldFromTrack: (s: number, x: number) => Readonly<{ x: number; z: number }>;
}

export type CollideFx = (a: PhysCar, b: PhysCar, severity: number) => void;

export interface CollideDeps {
  readonly incidents?: IncidentFx | null;
  readonly debris?: DebrisFx | null;
}

interface Motion {
  prog: number;
  x: number;
  angle: number;
  sweepGeneration?: number;
  sweepD?: number;
  sweepX?: number;
  sweepEligible?: boolean;
  sweepAngle?: number;
}

interface Contact {
  dProg: number;
  dX: number;
  penLong: number;
  penLat: number;
  iA: number;
  iB: number;
  iSum: number;
  sA: number;
  sB: number;
  aSp: number;
  bSp: number;
  sideContact: boolean;
  oriented: boolean;
  depth: number;
  nx: number;
  ny: number;
}

type SweepHit = Sweep & { dProg: number; dX: number; aSp: number; bSp: number; sA: number; sB: number };

export interface Collide {
  resolveCollisions(ranked: readonly PhysCar[], dt?: number): void;
  pairContact(a: PhysCar, b: PhysCar): Contact | null;
}

export function create(G: CollideCtx, collideFx: CollideFx, ownsPose: (c: PhysCar) => boolean = () => false, deps: CollideDeps = {}): Collide {
  const wrapS = G.wrapS;
  const incidentSim = deps.incidents ?? NO_INCIDENTS;
  const DebrisWorld = deps.debris ?? NO_DEBRIS;
  // Bound at resolveCollisions entry; every helper below runs inside it.
  let track = null as unknown as PhysicsTrack,
    player: PhysCar | null = null,
    netPlay = null as unknown as NetPlayOwnership;
  let motion = new WeakMap<PhysCar, Motion>(),
    motionTrack: PhysicsTrack | null = null,
    motionTime = -1;
  let sweepGeneration = 0;
  const _fxStep = new WeakMap<PhysCar, number>();
  const _swP: (Motion | undefined)[] = [];
  const geom: Partial<Overlap> = {},
    swept: Partial<SweepHit> = {},
    impulse: Partial<Impulse> = {},
    bodyA: ContactBody = { angle: 0, vx: 0, vy: 0, omega: 0, invMass: 0, invInertia: 0 },
    bodyB: ContactBody = { angle: 0, vx: 0, vy: 0, omega: 0, invMass: 0, invInertia: 0 };
  function deltaS(d: number): number {
    const L = track.length;
    return ((((d + L / 2) % L) + L) % L) - L / 2;
  }
  function sweepMotion(c: PhysCar, p: Motion, dt: number): void {
    if (p.sweepGeneration === sweepGeneration) return;
    p.sweepGeneration = sweepGeneration;
    p.sweepD = deltaS(c.prog - p.prog);
    p.sweepX = c.x - p.x;
    p.sweepEligible = false;
    if (Math.hypot(p.sweepD, p.sweepX) > Math.max(6, Math.abs(c.speed) * dt * 2 + 1)) return;
    p.sweepAngle = bodyAngle(c);
    p.sweepEligible = !(Math.abs(wrapDelta(p.sweepAngle - p.angle, TWO_PI)) > 0.15);
  }
  function body(c: PhysCar, speed: number, out: ContactBody): ContactBody {
    const angle = c.human ? c.yawVis || 0 : 0,
      cs = Math.cos(angle),
      sn = Math.sin(angle);
    out.angle = bodyAngle(c);
    out.vx = speed * cs - (c.vLat || 0) * sn;
    out.vy = speed * sn + (c.vLat || 0) * cs;
    out.omega = c.human ? c.yawRateCur || 0 : 0;
    out.invMass = netPlay.owns(c) || c.retired ? 0 : c.human ? AiContact.humanInvMass(!!track.street) : 1;
    out.invInertia = c.human ? out.invMass / ContactGeometry.INERTIA : 0;
    return out;
  }
  function floorFwd(c: PhysCar, v: number): number {
    return c.human && c.speed < 0 ? v : Math.max(0, v);
  }
  function scrub(v: number, d: number): number {
    return v > 0 ? Math.max(0, v - d) : Math.min(0, v + d);
  }
  function pushVelocity(c: PhysCar, state: ContactBody, dx: number, dy: number, dw: number): void {
    if (netPlay.owns(c) || c.retired) return;
    const angle = c.human ? c.yawVis || 0 : 0,
      cs = Math.cos(angle),
      sn = Math.sin(angle);
    const vx = state.vx + dx,
      vy = state.vy + dy;
    c.speed = floorFwd(c, vx * cs + vy * sn);
    if (c.human) {
      c.vLat = clamp(vy * cs - vx * sn, -40, 40);
      c.yawRateCur = clamp(state.omega + dw, -4, 4);
    }
  }
  function orientedResponse(
    a: PhysCar,
    b: PhysCar,
    ct: { depth: number; nx: number; ny: number; sA: number; sB: number; aSp: number; bSp: number; dProg: number; dX: number },
    last: boolean,
  ): void {
    const correction = Math.max(0, ct.depth - COL_SLOP) * 0.7;
    shiftLong(a, ct.nx * correction * ct.sA);
    shiftLong(b, -ct.nx * correction * ct.sB);
    a.x += ct.ny * correction * ct.sA;
    b.x -= ct.ny * correction * ct.sB;
    const ba = body(a, ct.aSp, bodyA),
      bb = body(b, ct.bSp, bodyB);
    const j = ContactGeometry.impulse(ba, bb, ct.dProg, ct.dX, ct, impulse);
    pushVelocity(a, ba, j.ax, j.ay, j.aw);
    pushVelocity(b, bb, j.bx, j.by, j.bw);
    if (correction > CORR_EPS || j.magnitude > CORR_EPS) {
      if (!netPlay.owns(a)) a.contactT = 0.22;
      if (!netPlay.owns(b)) b.contactT = 0.22;
      if (last) collideFx(a, b, clamp(j.closing * 0.03, 0.15, 1));
      if (j.magnitude > CORR_EPS && !netPlay.owns(a) && !netPlay.owns(b) && !a.retired && !b.retired) {
        if (DebrisWorld.active()) DebrisWorld.carImpact(a, b, j.closing);
        incidentSim.notifyCar(a, b, j.closing);
      }
    }
  }
  function sweepContacts(ranked: readonly PhysCar[], dt: number): void {
    sweepGeneration++;
    _swP.length = ranked.length;
    for (let i = 0; i < ranked.length; i++) _swP[i] = motion.get(ranked[i] as PhysCar);
    for (let i = 0; i < ranked.length; i++) {
      const a = ranked[i] as PhysCar,
        pa = _swP[i];
      if (!pa || ownsPose(a) || incidentSim.owns(a) || netPlay.owns(a)) continue;
      sweepMotion(a, pa, dt);
      if (!pa.sweepEligible) continue;
      const da = pa.sweepD as number,
        xa = pa.sweepX as number,
        reachA = LCAR_MAX + Math.abs(da) + 1;
      for (let k = i + 1; k < ranked.length; k++) {
        const b = ranked[k] as PhysCar,
          pb = _swP[k];
        if (!pb) continue;
        const sx = b.x - pb.x,
          sd = b.prog - pb.prog;
        if (sx === sx && sd - sd === 0) {
          const reach = reachA + Math.max(6, Math.abs(b.speed) * dt * 2 + 1),
            dp = pa.prog - pb.prog,
            ad = dp < 0 ? -dp : dp;
          if (ad > reach + 1e-3 && ad < track.length - reach - 1e-3) continue;
          if (Math.abs(deltaS(dp)) > reach) continue;
        }
        if (ownsPose(b) || incidentSim.owns(b) || netPlay.owns(b)) continue;
        sweepMotion(b, pb, dt);
        if (!pb.sweepEligible) continue;
        const db = pb.sweepD as number,
          xb = pb.sweepX as number;
        if (Math.hypot(da - db, xa - xb) < 1) continue;
        const x0 = deltaS(pa.prog - pb.prog),
          y0 = pa.x - pb.x,
          x1 = x0 + da - db,
          y1 = y0 + xa - xb;
        if (Math.min(x0, x1) > LCAR_MAX || Math.max(x0, x1) < -LCAR_MAX) continue;
        if (ContactGeometry.overlap(x1, y1, pa.sweepAngle as number, pb.sweepAngle as number, geom)) continue;
        const hit = ContactGeometry.sweep(x0, y0, x1, y1, pa.angle, pb.angle, swept) as SweepHit | null;
        if (!hit) continue;
        const t = hit.time;
        shiftLong(a, da * (t - 1));
        shiftLong(b, db * (t - 1));
        a.x = pa.x + xa * t;
        b.x = pb.x + xb * t;
        const shares = sepShares(a, b);
        hit.dProg = x0 + (da - db) * t;
        hit.dX = y0 + (xa - xb) * t;
        hit.aSp = a.speed;
        hit.bSp = b.speed;
        hit.sA = shares.sA;
        hit.sB = shares.sB;
        orientedResponse(a, b, hit, true);
        pa.sweepGeneration = pb.sweepGeneration = 0;
        break;
      }
    }
  }

  function shiftLong(c: PhysCar, d: number): void {
    if (d === 0) return;
    c.s = wrapS(c.s + d);
    c.prog += d;
    c._pushD = (c._pushD || 0) + d;
    _colShifted = true;
  }

  const _sep = { iA: 1, iB: 1, iSum: 2, sA: 0.5, sB: 0.5 };
  const _ct: Contact = {
    dProg: 0,
    dX: 0,
    penLong: 0,
    penLat: 0,
    iA: 1,
    iB: 1,
    iSum: 2,
    sA: 0.5,
    sB: 0.5,
    aSp: 0,
    bSp: 0,
    sideContact: false,
    oriented: false,
    depth: 0,
    nx: 0,
    ny: 0,
  };
  const COL_BUCKET_M = LCAR_MAX;
  let _colShifted = false;
  function _colProgOf(c: PhysCar): number {
    return c._nOk ? (c._nProg as number) : c.prog;
  }
  function _colFillBuckets(ranked: readonly PhysCar[]): number {
    return fillArcBuckets(ranked, track.length || 1, COL_BUCKET_M, _colProgOf);
  }
  function sepShares(a: PhysCar, b: PhysCar): typeof _sep {
    const hum = AiContact.humanInvMass(!!track.street);
    const netA = netPlay.owns(a) || !!a.retired,
      netB = netPlay.owns(b) || !!b.retired;
    const iA = netA ? 0 : a.human ? hum : 1,
      iB = netB ? 0 : b.human ? hum : 1;
    _sep.iA = iA;
    _sep.iB = iB;
    _sep.iSum = iA + iB;
    _sep.sA = netA ? 0 : netB ? 1 : iA / _sep.iSum;
    _sep.sB = netB ? 0 : netA ? 1 : iB / _sep.iSum;
    return _sep;
  }

  let _colCbLast = false,
    _colCbRub = 1;
  let _colTouched = false;
  const COL_SLOP = 0.05;
  function _colResolveCB(a: PhysCar, b: PhysCar): void {
    _colResolvePair(a, b, _colCbLast, _colCbRub);
  }
  function _colSepCB(a: PhysCar, b: PhysCar): void {
    _colSepPair(a, b, COL_SLOP);
  }

  function pairContact(a: PhysCar, b: PhysCar): Contact | null {
    if (ownsPose(a) || ownsPose(b)) return null;
    if ((a.retired || netPlay.owns(a)) && (b.retired || netPlay.owns(b))) return null;
    const aProg = a._nOk ? (a._nProg as number) : a.prog;
    const bProg = b._nOk ? (b._nProg as number) : b.prog;
    const aX = a._nOk ? (a._nX as number) : a.x;
    const bX = b._nOk ? (b._nX as number) : b.x;
    const aSp = a._nOk ? (a._nSpd as number) : a.speed;
    const bSp = b._nOk ? (b._nSpd as number) : b.speed;
    let dProg = aProg - bProg;
    if (!Number.isFinite(dProg)) return null;
    const L = track.length;
    const adProg = dProg < 0 ? -dProg : dProg;
    if (adProg > LCAR_MAX && adProg < L - LCAR_MAX) return null;
    dProg = ((((dProg + L / 2) % L) + L) % L) - L / 2;
    if (Math.abs(dProg) > LCAR_MAX) return null;
    const dX = aX - bX;
    if (!Number.isFinite(dX)) return null;
    const eLong = extLong(a) + extLong(b);
    const eLat = extLat(a) + extLat(b);
    const penLong = eLong - Math.abs(dProg);
    const penLat = eLat - Math.abs(dX);
    if (penLong <= 0 || penLat <= 0) return null;
    const angleA = bodyAngle(a),
      angleB = bodyAngle(b);
    const oriented = angleA !== 0 || angleB !== 0;
    const exact = oriented ? ContactGeometry.overlap(dProg, dX, angleA, angleB, geom) : null;
    if (oriented && !exact) return null;
    const { iA, iB, iSum, sA, sB } = sepShares(a, b);
    const closing = (dProg >= 0 ? bSp - aSp : aSp - bSp) > 0.5;
    const nestEdge = closing && penLong > 1.0 && penLat < 0.5;
    const forceRear = nestEdge && ((dProg >= 0 && b.human) || (dProg < 0 && a.human));
    _ct.dProg = dProg;
    _ct.dX = dX;
    _ct.penLong = penLong;
    _ct.penLat = penLat;
    _ct.iA = iA;
    _ct.iB = iB;
    _ct.iSum = iSum;
    _ct.sA = sA;
    _ct.sB = sB;
    _ct.aSp = aSp;
    _ct.bSp = bSp;
    _ct.oriented = oriented;
    if (exact) {
      _ct.depth = exact.depth;
      _ct.nx = exact.nx;
      _ct.ny = exact.ny;
    }
    _ct.sideContact = penLat * eLong < penLong * eLat && !forceRear;
    return _ct;
  }

  function _colResolvePair(a: PhysCar, b: PhysCar, last: boolean, rubScrub: number): void {
    if (incidentSim.owns(a) || incidentSim.owns(b)) return;
    if (a.finished && b.finished) return;
    const ct = pairContact(a, b);
    if (!ct) return;
    _colTouched = true;
    if (ct.oriented) {
      orientedResponse(a, b, ct, last);
      return;
    }
    const { dProg, dX, penLong, penLat, iA, iB, iSum, sA, sB, sideContact, aSp, bSp } = ct;
    if (sideContact) {
      const sgn = dX >= 0 ? 1 : -1;
      const corr = Math.max(penLat - 0.05, 0) * 0.35;
      a.x += sgn * corr * sA;
      b.x -= sgn * corr * sB;
      if (corr > CORR_EPS) {
        if (a.human || b.human) a.contactT = b.contactT = 0.22;
        if (AiContact.sideYieldsA(dProg, a.x, b.x, a.human || b.human ? 0 : (a.kTurn ?? b.kTurn))) {
          if (last) a.speed = scrub(a.speed, rubScrub);
          a.contactT = 0.22;
        } else {
          if (last) b.speed = scrub(b.speed, rubScrub);
          b.contactT = 0.22;
        }
        if (last) collideFx(a, b, Math.abs(aSp - bSp) * 0.02 + 0.18);
      }
    } else {
      const sgn = dProg >= 0 ? 1 : -1;
      const corr = Math.max(penLong - 0.05, 0) * 0.4;
      shiftLong(a, sgn * corr * sA);
      shiftLong(b, -sgn * corr * sB);
      const relV = sgn >= 0 ? bSp - aSp : aSp - bSp;
      if (relV > 0) {
        if (iSum > 0 && !(incidentSim.owns(a) || incidentSim.owns(b))) {
          const aSp0 = Number.isFinite(a._preColSpd) ? (a._preColSpd as number) : aSp;
          const bSp0 = Number.isFinite(b._preColSpd) ? (b._preColSpd as number) : bSp;
          const relV0 = sgn >= 0 ? bSp0 - aSp0 : aSp0 - bSp0;
          const e = AiContact.bumpRestitution(relV0 > 0 ? relV0 : relV);
          const jImp = ((1 + e) * relV) / iSum;
          const capV = AiContact.humanPuntCap() * Math.max(G.PACE, 0.05);
          if (sgn >= 0) {
            if (iB) b.speed = floorFwd(b, b.speed - iB * jImp);
            if (iA) a.speed += iA * (a.human ? Math.min(jImp, ((1 + e) * capV) / iSum) : jImp);
          } else {
            if (iA) a.speed = floorFwd(a, a.speed - iA * jImp);
            if (iB) b.speed += iB * (b.human ? Math.min(jImp, ((1 + e) * capV) / iSum) : jImp);
          }
        }
        if (corr > CORR_EPS) {
          if (!netPlay.owns(a)) a.contactT = 0.22;
          if (!netPlay.owns(b)) b.contactT = 0.22;
        }
        const fx = _fxStep.get(a) !== sweepGeneration || _fxStep.get(b) !== sweepGeneration;
        if (fx) {
          _fxStep.set(a, sweepGeneration);
          _fxStep.set(b, sweepGeneration);
        }
        if (fx) collideFx(a, b, clamp(relV * 0.03 + penLong * 0.05, 0.15, 1));
        if (fx && DebrisWorld.active()) DebrisWorld.carImpact(a, b, relV);
        if (fx && !netPlay.owns(a) && !netPlay.owns(b) && !a.retired && !b.retired) incidentSim.notifyCar(a, b, relV);
      }
    }
  }

  function _colSepPair(a: PhysCar, b: PhysCar, SLOP: number): void {
    if (incidentSim.owns(a) || incidentSim.owns(b)) return;
    if (a.finished && b.finished) return;
    const ct = pairContact(a, b);
    if (!ct) return;
    _colTouched = true;
    if (ct.oriented) {
      const corr = Math.max(0, ct.depth - SLOP);
      shiftLong(a, ct.nx * corr * ct.sA);
      shiftLong(b, -ct.nx * corr * ct.sB);
      a.x += ct.ny * corr * ct.sA;
      b.x -= ct.ny * corr * ct.sB;
      return;
    }
    const { dProg, dX, penLong, penLat, sA, sB, sideContact } = ct;
    if (sideContact) {
      const c = Math.max(penLat - SLOP, 0) * 0.6;
      if (c <= 0) return;
      const sgn = dX >= 0 ? 1 : -1;
      a.x += sgn * c * sA;
      b.x -= sgn * c * sB;
    } else {
      const c = Math.max(penLong - SLOP, 0) * 0.6;
      if (c <= 0) return;
      const sgn = dProg >= 0 ? 1 : -1;
      shiftLong(a, sgn * c * sA);
      shiftLong(b, -sgn * c * sB);
    }
  }

  function _colForBucketPairs(nB: number, fn: (a: PhysCar, b: PhysCar) => void, fwd?: boolean): void {
    const nIds = _arcBucketIds.length;
    for (let k = 0; k < nIds; k++) {
      const bi = fwd === false ? nIds - 1 - k : k;
      const id = _arcBucketIds[bi] as number;
      const A = _arcBuckets[id],
        nA = A ? (_arcN[id] as number) : 0;
      if (!nA) continue;
      const AA = A as PhysCar[];
      for (let i = 0; i < nA; i++) {
        const a = AA[i] as PhysCar;
        for (let j = i + 1; j < nA; j++) fn(a, AA[j] as PhysCar);
      }
      if (nB < 2) continue;
      const id2 = (id + 1) % nB;
      const B = _arcBuckets[id2],
        nB2 = B ? (_arcN[id2] as number) : 0;
      if (!nB2) continue;
      const BB = B as PhysCar[];
      for (let i = 0; i < nA; i++) {
        const a = AA[i] as PhysCar;
        for (let j = 0; j < nB2; j++) fn(a, BB[j] as PhysCar);
      }
    }
  }

  function resolveCollisions(ranked: readonly PhysCar[], dt?: number): void {
    track = G.track as PhysicsTrack;
    player = G.player;
    netPlay = G.netPlay;
    const PASSES = 4;
    const _preColS = player ? player.s : 0,
      _preColX = player ? player.x : 0;
    if (motionTrack !== track || G.raceT < motionTime) {
      motion = new WeakMap();
      motionTrack = track;
    }
    motionTime = G.raceT;
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i] as PhysCar;
      if (!ownsPose(c) && !c.human) {
        c._preColS = c.s;
        c._preColX = c.x;
      }
    }
    sweepContacts(ranked, dt || FIXED_DT);
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i] as PhysCar;
      if (!ownsPose(c)) c._preColSpd = c._nOk ? c._nSpd : c.speed;
    }
    const rubScrub = AiContact.rubDecel(!!track.street) * (dt || FIXED_DT);
    const useBuckets = ranked.length > 12;
    let nB = 0;
    if (useBuckets) {
      nB = _colFillBuckets(ranked);
      _colShifted = false;
    }
    for (let pass = 0; pass < PASSES; pass++) {
      if (pass > 0 && !_colTouched) break;
      _colTouched = false;
      const last = pass === PASSES - 1;
      if (useBuckets) {
        if (pass > 0 && _colShifted) {
          nB = _colFillBuckets(ranked);
          _colShifted = false;
        }
        _colCbLast = last;
        _colCbRub = rubScrub;
        _colForBucketPairs(nB, _colResolveCB, (pass & 1) === 0);
      } else {
        const fwd = (pass & 1) === 0;
        for (let ii = 0; ii < ranked.length; ii++) {
          const i = fwd ? ii : ranked.length - 1 - ii;
          const a = ranked[i] as PhysCar;
          if (incidentSim.owns(a)) continue;
          for (let j = i + 1; j < ranked.length; j++) {
            _colResolvePair(a, ranked[j] as PhysCar, last, rubScrub);
          }
        }
      }
    }
    if (useBuckets) {
      if (_colShifted) nB = _colFillBuckets(ranked);
      _colForBucketPairs(nB, _colSepCB);
    } else {
      for (let i = 0; i < ranked.length; i++) {
        const a = ranked[i] as PhysCar;
        if (incidentSim.owns(a)) continue;
        for (let j = i + 1; j < ranked.length; j++) {
          _colSepPair(a, ranked[j] as PhysCar, COL_SLOP);
        }
      }
    }
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i] as PhysCar;
      if (ownsPose(c) || incidentSim.owns(c)) continue;
      const lim = track.wallLimits(c.s, c.x, _lim, _postLim);
      if (c.x > lim.r) c.x = lim.r;
      else if (c.x < -lim.l) c.x = -lim.l;
      if (lim.laneMin > 0 && c.x * lim.side < lim.laneMin) c.x = lim.laneMin * lim.side;
      if (!c.human && (c.s !== c._preColS || c.x !== c._preColX)) {
        const w = G.worldFromTrack(c.s, c.x);
        c.px = w.x;
        c.pz = w.z;
      }
    }
    if (
      player &&
      player.px != null &&
      !player.finished &&
      !ownsPose(player) &&
      !incidentSim.owns(player) &&
      (player.s !== _preColS || player.x !== _preColX)
    ) {
      const w = G.worldFromTrack(player.s, player.x);
      player.px = w.x;
      player.pz = w.z;
    }
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i] as PhysCar;
      if (ownsPose(c)) {
        motion.delete(c);
        continue;
      }
      let p = motion.get(c);
      if (!p) {
        p = { prog: 0, x: 0, angle: 0 };
        motion.set(c, p);
      }
      p.prog = c.prog;
      p.x = c.x;
      p.angle = bodyAngle(c);
    }
  }

  return { resolveCollisions, pairContact };
}

/** The nearest PARKED retirement ahead of (or still beside) `c`, within `reach` m of arc. collide.js:537-545. */
export function parkedAhead(c: PhysCar, parked: readonly PhysCar[], L: number, reach: number): PhysCar | null {
  let best: PhysCar | null = null,
    bestD = reach;
  for (let i = 0; i < parked.length; i++) {
    const o = parked[i] as PhysCar;
    const d = ((((o.s - c.s + L / 2) % L) + L) % L) - L / 2;
    if (d > -LCAR && d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}
