/**
 * AI DRIVE: situation-aware decisions for the kinematic AI field: ratings,
 * house style and team orders, follow gaps, the brake planner, overtaking and
 * defending, side-by-side yield rules, mistakes, launch and pace phase.
 *
 * Port of f1-game js/physics/ai-drive.js (`AiDrive`, :2-1748), verbatim in
 * float operation order, for every function the race step calls with TYRE
 * WEAR off. The wear-on strategy planner (stintPlan, splitStints, degCost,
 * compoundFor, pitNow, wornPays, strategyTemper, tasteRoll; :1150-1380) is
 * TODO(lane-physics): it runs only with wear on, behind the pit lane.
 * The contact / wall helpers live in src/physics/ai-contact.ts (re-exported).
 *
 * AI-only. Curvature reaches the AI's choices here (corner speed, pass side),
 * never the driver: nothing in this file runs for a human car.
 */
import { clamp, lerp } from "../../physics/math";

export {
  bumpRestitution,
  humanInvMass,
  humanPuntCap,
  rubDecel,
  sideYieldsA,
  towGain,
  wallAiScrub,
  wallHitLoss,
  wallSteerScrub,
} from "../../physics/ai-contact";

const damp = (c: number, t: number, l: number, dt: number): number => lerp(c, t, 1 - Math.exp(-l * dt));

// ── ratings, house style, team orders (ai-drive.js:9-77) ─────────────────────
export interface Traits {
  craft: number;
  awareness: number;
  experience: number;
  skill: number;
  consistency: number;
  aggression: number;
  optimism: number;
}
/** The rating fields traits() reads off a car. */
export interface RatedCar {
  craft?: number | null | undefined;
  awareness?: number | null | undefined;
  experience?: number | null | undefined;
  skill?: number | null | undefined;
  consistency?: number | null | undefined;
  aggression?: number | null | undefined;
  optimism?: number | null | undefined;
}
const _traits: Traits = { craft: 0.75, awareness: 0.75, experience: 0.75, skill: 0.97, consistency: 0.75, aggression: 0, optimism: 0 };
/** SHARED SCRATCH: read the fields before the next traits() call (ai-drive.js:9-12). */
export function traits(c: RatedCar): Traits {
  _traits.craft = c.craft != null ? c.craft : 0.75;
  _traits.awareness = c.awareness != null ? c.awareness : 0.75;
  _traits.experience = c.experience != null ? c.experience : 0.75;
  _traits.skill = c.skill != null ? c.skill : 0.97;
  _traits.consistency = c.consistency != null ? c.consistency : 0.75;
  _traits.aggression = c.aggression != null ? c.aggression : 0;
  _traits.optimism = c.optimism != null ? c.optimism : 0;
  return _traits;
}

export interface TeamStats {
  readonly speed: number;
  readonly accel: number;
  readonly cornering: number;
  readonly braking: number;
}
export interface TeamRef {
  readonly id?: string;
  readonly stats?: TeamStats | null;
}
/** A car as the team-orders rules see "the other car". */
export interface OtherCar {
  readonly team?: TeamRef | null | undefined;
  readonly seat?: number | null | undefined;
  readonly human?: boolean;
  readonly _snapX?: number | undefined;
  readonly x?: number;
}
const _house = { attack: 0, hold: 0 };
export function houseStyle(team: TeamRef | null | undefined, seat: number | null | undefined, stats: TeamStats | null | undefined): { attack: number; hold: number } {
  const s = stats || (team && team.stats);
  if (!s) {
    _house.attack = 0;
    _house.hold = 0;
    return _house;
  }
  _house.attack = clamp(((s.speed + s.accel) * 0.5 - 85) / 25, -1, 1);
  _house.hold = clamp(((s.cornering + s.braking) * 0.5 - 85) / 25, -1, 1);
  if (seat === 0) {
    _house.attack = clamp(_house.attack + 0.1, -1, 1);
    _house.hold = clamp(_house.hold - 0.06, -1, 1);
  } else if (seat === 1) {
    _house.attack = clamp(_house.attack - 0.14, -1, 1);
    _house.hold = clamp(_house.hold + 0.12, -1, 1);
  }
  return _house;
}
function houseMul(
  team: TeamRef | null | undefined,
  lo: number,
  hi: number,
  axis: "hold" | "attack",
  seat: number | null | undefined,
  stats: TeamStats | null | undefined,
): number {
  const h = houseStyle(team, seat, stats);
  return lerp(lo, hi, ((axis === "hold" ? h.hold : h.attack) + 1) * 0.5);
}
interface HouseCtx {
  readonly team?: TeamRef | null | undefined;
  readonly seat?: number | null | undefined;
  readonly stats?: TeamStats | null | undefined;
}
function houseMulCtx(ctx: HouseCtx | null | undefined, lo: number, hi: number, axis: "hold" | "attack"): number {
  return houseMul(ctx && ctx.team, lo, hi, axis, ctx && ctx.seat, ctx && ctx.stats);
}

export function isMate(team: TeamRef | null | undefined, other: OtherCar | null | undefined): boolean {
  const id = team && team.id;
  const oid = other && other.team && other.team.id;
  return !!(id && oid && id === oid);
}
export function ordersMul(team: TeamRef | null | undefined, seat: number | null | undefined, other: OtherCar | null | undefined, kind: "ot" | "defend" | "follow"): number {
  if (!isMate(team, other)) return 1;
  const os = (other as OtherCar).seat;
  if (seat == null || os == null) return kind === "ot" ? 0.55 : kind === "defend" ? 0.4 : 1;
  if (kind === "ot") {
    if (seat > os) return 0.22;
    if (seat < os) return 1.18;
    return 0.55;
  }
  if (kind === "defend") {
    if (seat > os) return 0.15;
    if (seat < os) return 1.06;
    return 0.35;
  }
  if (seat > os) return 1.12;
  if (seat < os) return 0.88;
  return 1;
}

// ── the brake look-ahead (ai-drive.js:79-90) ────────────────────────────────
export interface LookSample {
  d: number;
  k: number;
  bank: number;
  mu: number;
}
const _look: LookSample[] = [];
const _lookPool: LookSample[] = [];
export function beginLook(): void {
  _look.length = 0;
}
export function pushLook(d: number, k: number, bank: number, mu?: number): void {
  let s = _lookPool[_look.length];
  if (!s) s = _lookPool[_look.length] = { d: 0, k: 0, bank: 0, mu: 1 };
  s.d = d;
  s.k = k;
  s.bank = bank;
  s.mu = mu === undefined ? bankGrip(bank) : mu;
  _look.push(s);
}
export function bankGrip(bank: number): number {
  return 1 + Math.sin(bank || 0) * 0.8;
}
export function endLook(): LookSample[] {
  return _look;
}

export function stuckThreshold(t: Traits): number {
  return lerp(1.15, 0.45, t.awareness);
}
export function followBase(street: boolean): number {
  return street ? 8 : 6;
}

// ── the follow gap (ai-drive.js:97-134) ─────────────────────────────────────
const FOLLOW_TIGHT = 0.05,
  FOLLOW_MAX = 28;
export function followTime(t: Traits, street: boolean, team: TeamRef | null | undefined, seat: number | null | undefined, other: OtherCar | null | undefined, stats: TeamStats | null | undefined): number {
  void street;
  return lerp(0.15, 0.3, t.awareness) * houseMul(team, 0.92, 1.08, "hold", seat, stats) * ordersMul(team, seat, other, "follow");
}
export function followGap(
  t: Traits,
  street: boolean,
  speed: number,
  tight: number,
  team: TeamRef | null | undefined,
  seat: number | null | undefined,
  other: OtherCar | null | undefined,
  stats: TeamStats | null | undefined,
  extra: number,
): number {
  const v = Math.max(speed || 0, 0);
  if (street) {
    return followBase(true) + lerp(-0.8, 2.2, t.awareness) * houseMul(team, 0.92, 1.08, "hold", seat, stats) * 0.5 * ordersMul(team, seat, other, "follow") + v * (extra || 0);
  }
  const T = lerp(followTime(t, street, team, seat, other, stats), FOLLOW_TIGHT, clamp(tight || 0, 0, 1)) + (extra || 0);
  return Math.min(followBase(street) + v * T, FOLLOW_MAX);
}

// ── pass hunger / cover concede (ai-drive.js:152-197) ───────────────────────
export const PASS_EDGE = 0.007;
export const PASS_EDGE_FULL = 0.012;
export const CONCEDE_EDGE_FULL = 0.008;
export function paceEdgeN(fasterV: number | undefined, slowerV: number | undefined, vTop: number | undefined, full?: number): number {
  const ref = (vTop as number) > 0 ? (vTop as number) : 72;
  const edge = ((fasterV || 0) - (slowerV || 0)) / ref;
  if (edge < PASS_EDGE) return 0;
  const span = ((full as number) > PASS_EDGE ? (full as number) : PASS_EDGE_FULL) - PASS_EDGE;
  return clamp((edge - PASS_EDGE) / span, 0, 1);
}
export function pairEdgeN(
  fasterV: number | undefined,
  slowerV: number | undefined,
  fasterP: number | undefined,
  slowerP: number | undefined,
  vTop: number | undefined,
  full?: number,
): number {
  const a = (fasterV as number) > 0 && (slowerV as number) > 0 ? paceEdgeN(fasterV, slowerV, vTop, full) : 0;
  const b = (fasterP as number) > 0 && (slowerP as number) > 0 ? paceEdgeN((fasterP as number) / (slowerP as number), 1, 1, full) : 0;
  return Math.max(a, b);
}
export interface HungerCtx {
  readonly street?: boolean;
  readonly traits?: Traits | null;
  readonly vTop?: number;
  readonly queueT?: number;
  readonly blockerVmax?: number;
  readonly ourVmax?: number;
  readonly blockerPace?: number;
  readonly ourPace?: number;
}
export function passHunger(ctx: HungerCtx | null | undefined): number {
  if (!ctx || ctx.street) return 1;
  const edgeN = pairEdgeN(ctx.ourVmax, ctx.blockerVmax, ctx.ourPace, ctx.blockerPace, ctx.vTop);
  if (!edgeN) return 1;
  const stuckN = clamp((ctx.queueT || 0) / 12, 0, 1);
  const craft = lerp(0.75, 1.15, ctx.traits ? ctx.traits.craft : 0.75);
  return 1 + edgeN * Math.max(stuckN, 0.25) * 1.15 * craft;
}
export interface ConcedeCtx {
  readonly street?: boolean;
  readonly other?: OtherCar | null;
  readonly traits?: Partial<Traits> | null;
  readonly vTop?: number;
  readonly chaserVmax?: number;
  readonly ourVmax?: number;
  readonly chaserPace?: number;
  readonly ourPace?: number;
}
export function coverConcede(ctx: ConcedeCtx | null | undefined): number {
  if (!ctx || ctx.street) return 0;
  if (ctx.other && ctx.other.human) return 0;
  const edgeN = pairEdgeN(ctx.chaserVmax, ctx.ourVmax, ctx.chaserPace, ctx.ourPace, ctx.vTop, CONCEDE_EDGE_FULL);
  if (!edgeN) return 0;
  const t = ctx.traits || {};
  return edgeN * lerp(0.55, 1.0, t.awareness != null ? t.awareness : 0.75) * lerp(0.55, 1.0, t.experience != null ? t.experience : 0.75);
}

// ── queue braking (ai-drive.js:199-269) ─────────────────────────────────────
export function queueBrake(
  speed: number,
  blockerSpeed: number,
  street: boolean,
  gap: number | null | undefined,
  follow: number | null | undefined,
  brakeRef: number,
  vScale: number,
): number {
  const vs = vScale > 0 ? vScale : 1;
  const excess = (speed || 0) - (blockerSpeed || 0);
  const thresh = (street ? 4.5 : 3) * vs;
  let lvl = 0;
  if (excess > thresh && !(gap != null && follow != null && gap > follow + excess * 1.2)) lvl = clamp((excess - thresh) / ((street ? 4 : 5) * vs), 0.2, 1);
  if (excess > 0.5 * vs && gap != null && follow != null) {
    const room = Math.max(gap - follow, 0.5);
    const aReq = (excess * excess) / (2 * room);
    if (room / excess < 3 && aReq > 5 * vs) lvl = Math.max(lvl, clamp(aReq / (brakeRef || 22), 0.15, 1));
  }
  if (gap != null && follow != null && gap < follow && excess > 0.3 * vs) {
    lvl = Math.max(lvl, clamp(0.12 + (excess / (3 * vs)) * (1 - gap / follow), 0.12, 0.6));
  }
  return lvl;
}
export function queueReach(base: number, speed: number, blockerSpeed: number, brake: number, vScale: number): number {
  const vs = vScale > 0 ? vScale : 1,
    excess = (speed || 0) - (blockerSpeed || 0);
  if (!(excess > 3 * vs) || !(brake > 0)) return base;
  return Math.max(base, (excess * excess) / (2 * 0.6 * brake) + 6);
}
export function holdLineGap(speed: number): number {
  return Math.max(8, speed || 0);
}
const _defOnce = { defend: 0, side: 0 };
export function defendOnce(defend: number, side: number, out?: { defend: number; side: number }): { defend: number; side: number } {
  const o = out || _defOnce;
  const sgn = defend > 0 ? 1 : defend < 0 ? -1 : 0;
  if (!defend) {
    o.defend = 0;
    o.side = side;
  } else if (!side) {
    o.defend = defend;
    o.side = sgn;
  } else {
    o.defend = sgn === side ? defend : 0;
    o.side = side;
  }
  return o;
}
export function sepClamp(street: boolean): number {
  return street ? 1.55 : 2.6;
}
export function squeezeEase(street: boolean): number {
  return street ? 0.88 : 0.9;
}
export function squeezeBrake(): number {
  return 0.25;
}
export function contactGive(contacting: boolean, t: Traits, street: boolean): number {
  if (!contacting) return 1;
  const give = lerp(0.55, 0.25, t.awareness);
  return street ? give * 0.72 : give;
}
export function steerDamp(t: Traits): number {
  return lerp(5.5, 12.5, t.experience);
}
export function queueFloor(street: boolean): number {
  return street ? 2.5 : 3.5;
}
export function laneFollow(): number {
  return 9;
}
export function unstuckLatFloor(street: boolean): number {
  return street ? 0.1 : 0.16;
}
export function unstuckPull(t: Traits, street: boolean): number {
  const pull = lerp(3.4, 2.0, t.experience);
  return street ? pull * 0.55 : pull;
}
export function streetOtScale(t: Traits): number {
  return lerp(0.72, 1.0, t.awareness);
}

// ── overtake fire / ERS / X-mode (ai-drive.js:383-456) ──────────────────────
export interface OtFireCtx extends HouseCtx {
  traits: Traits;
  blockerGap?: number | null;
  gapAhead?: number;
  roomL?: number;
  roomR?: number;
  speed?: number;
  aheadSpeed?: number | null;
  vTop?: number;
  kAhead?: number;
  street?: boolean;
  other?: OtherCar | null;
}
export function otFireRate(ctx: OtFireCtx): number {
  const t = ctx.traits;
  const gap = ctx.blockerGap != null ? ctx.blockerGap : ctx.gapAhead;
  const room = Math.max(ctx.roomL || 0, ctx.roomR || 0);
  const closing = (ctx.speed || 0) - (ctx.aheadSpeed != null ? ctx.aheadSpeed : ctx.speed || 0);
  const ref = (ctx.vTop as number) > 0 ? (ctx.vTop as number) : 72;
  const gapScore = clamp(1 - (gap || 9) / 9, 0, 1);
  const roomScore = clamp(room / 3.2, 0, 1);
  const closeScore = clamp(0.45 + closing / ((8 * ref) / 72), 0, 1);
  const straight = clamp(1 - Math.abs(ctx.kAhead || 0) / 0.012, 0, 1);
  const situ = (0.34 * gapScore + 0.28 * roomScore + 0.22 * closeScore + 0.16 * straight) * (ctx.street ? streetOtScale(t) : 1);
  const craftMul = lerp(0.45, 1.55, t.craft);
  const awareMul = lerp(1.25, 0.7, t.awareness);
  const expMul = lerp(0.75, 1.15, t.experience);
  const aggrMul = 1 + clamp(t.aggression != null ? t.aggression : 0, -1, 1) * 0.22;
  const house = houseMulCtx(ctx, 0.88, 1.12, "attack");
  const orders = ordersMul(ctx.team, ctx.seat, ctx.other, "ot");
  return clamp(0.55 * situ * craftMul * awareMul * expMul * aggrMul * house * orders, 0.08, 2.4);
}
export function otShouldFire(roll: number, dt: number, ctx: OtFireCtx): boolean {
  const rate = otFireRate(ctx);
  return roll < 1 - Math.exp(-rate * dt);
}
export interface BoostCtx extends HouseCtx {
  traits: Traits;
  energy?: number;
  otActive?: boolean;
  kAhead60?: number;
  towCar?: boolean;
  towGap?: number;
  towSpeed?: number;
  speed?: number;
  chaser?: boolean;
  chaserGap?: number;
  chaserSpeed?: number;
  ersDeploy?: number | null;
  ersRegen?: number | null;
  vTop?: number;
  street?: boolean;
  towVmax?: number;
  ourVmax?: number;
  ourPace?: number;
  towPace?: number;
}
export function wantBoost(ctx: BoostCtx): boolean {
  const energy = ctx.energy || 0;
  if (energy <= 0.02) return false;
  if (ctx.otActive) return true;
  const kAhead = Math.abs(ctx.kAhead60 || 0);
  const straight = kAhead < 0.006;
  if (!straight) return false;
  const vs = (ctx.vTop as number) > 0 ? (ctx.vTop as number) / 72 : 1;
  const ref = (ctx.vTop as number) > 0 ? (ctx.vTop as number) : 72;
  const catchEdge = !ctx.street && pairEdgeN(ctx.ourVmax, ctx.towVmax, ctx.ourPace, ctx.towPace, ref) > 0;
  const catching = !!(ctx.towCar && (ctx.towGap as number) < 28 && ((ctx.speed || 0) >= (ctx.towSpeed || 0) - 1 * vs || catchEdge));
  const defending = !!(ctx.chaser && (ctx.chaserGap as number) < 14 && (ctx.chaserSpeed || 0) > (ctx.speed || 0) - 2 * vs);
  const hs = houseStyle(ctx.team, ctx.seat, ctx.stats);
  const dep = ctx.ersDeploy != null ? ctx.ersDeploy : 0.5;
  const regen = ctx.ersRegen != null ? ctx.ersRegen : 0.5;
  const rich = energy > 0.55 - hs.attack * 0.08 - (dep - 0.5) * 0.1;
  const desperate = energy > 0.25 && catching;
  const bank = ctx.traits.awareness > 0.8 - hs.hold * 0.08 && energy < 0.4 - hs.hold * 0.05 + (regen - 0.5) * 0.08 && !catching && !defending;
  if (bank) return false;
  return desperate || defending || rich || (energy > 0.25 && straight && ctx.traits.awareness < 0.55);
}
export interface WantXCtx extends HouseCtx {
  armed?: boolean;
  catching?: boolean;
  otActive?: boolean;
  energy?: number | null;
}
export function wantX(ctx: WantXCtx | null | undefined): boolean {
  if (ctx && ctx.armed === false) return false;
  if (ctx && (ctx.catching || ctx.otActive)) return true;
  const hs = houseStyle(ctx && ctx.team, ctx && ctx.seat, ctx && ctx.stats);
  const energy = ctx && ctx.energy;
  if (energy == null) return true;
  return energy > 0.2 - hs.attack * 0.08;
}

// ── the lateral envelope and the brake planner (ai-drive.js:458-560) ────────
const AI_DF = 0.65;
export function lateralScale(speed: number, load = 0.5, grip = 1, pace = 1, vmax = 72, aero = 1): number {
  const q = Math.min(1, Math.abs(speed) / (Math.max(0.05, pace) * Math.max(1, vmax)));
  return (1 + (load - 0.5) * 0.16) * Math.max(0.01, grip) * (1 + AI_DF * aero * q * q);
}
const YAW_AERO = -0.28 / AI_DF;
export function yawScale(speed: number, load?: number, grip?: number, pace?: number, vmax?: number): number {
  return lateralScale(speed, load, grip, pace, vmax, YAW_AERO);
}
export function cornerSpeed(k: number, lat: number, pace = 1, vmax = 72): number {
  const V = Math.max(0.05, pace) * Math.max(1, vmax),
    kk = Math.max(k, 1e-5),
    L = Math.max(0, lat);
  return cornerSpeedEnvelope(kk, L, V, V * V);
}
function cornerSpeedEnvelope(kk: number, L: number, V: number, vSq: number): number {
  const den = kk - (L * AI_DF) / vSq;
  if (den > 0) {
    const v = Math.sqrt(L / den);
    if (v <= V) return v;
  }
  return Math.sqrt((L * (1 + AI_DF)) / kk);
}

export interface BrakeCtx extends HouseCtx {
  traits: Traits;
  samples: readonly LookSample[] | null;
  latMax?: number;
  diffCorner?: number;
  aeroLoad?: number | null | undefined;
  brake?: number;
  pace?: number;
  vmax?: number;
  grip?: number;
  speed?: number;
  blocker?: boolean;
  blockerGap?: number;
  blockerSpeed?: number;
  roomL?: number;
  roomR?: number;
  errMul?: number;
}
const _bind = { vC: 0, d: 1 };
export function brakeTarget(ctx: BrakeCtx): number {
  const t = ctx.traits;
  const samples = ctx.samples || [];
  const load = ctx.aeroLoad != null ? ctx.aeroLoad : 0.5;
  const latMax = (ctx.latMax || 22) * (1 + (load - 0.5) * 0.16);
  const brake = ctx.brake || 22;
  const grip = ctx.grip || 1;
  const skill = t.skill;
  const vs = Math.max(0.05, ctx.pace === undefined ? 1 : ctx.pace);
  const V = vs * Math.max(1, ctx.vmax === undefined ? 72 : ctx.vmax),
    vSq = V * V;
  let vLimSq = Infinity,
    bVC = 0,
    bD = 1;
  const scrub = 2 * brake * 0.85;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as LookSample;
    const d = Math.max(s.d || 0, 1);
    const dSq = scrub * d;
    if (dSq >= vLimSq) continue;
    const k = Math.max(Math.abs(s.k || 0), 1e-5);
    const bankMu = s.mu !== undefined ? s.mu : bankGrip(s.bank);
    const vC = cornerSpeedEnvelope(k, Math.max(0, latMax * bankMu * grip), V, vSq) * skill * (ctx.diffCorner || 1);
    const entrySq = vC * vC + dSq;
    if (entrySq >= 0 && entrySq < vLimSq) {
      vLimSq = entrySq;
      bVC = vC;
      bD = d;
    }
  }
  let vLim = Math.sqrt(vLimSq);
  if (!Number.isFinite(vLim)) vLim = 1e6;
  const vLimRaw = vLim;
  const hold = houseStyle(ctx.team, ctx.seat, ctx.stats).hold;
  if (hold) vLim *= 1 - hold * 0.025;
  const attacking = !!(ctx.blocker && (ctx.blockerGap as number) < 16 && (ctx.speed || 0) > (ctx.blockerSpeed || 0) - 1 * vs);
  const room = Math.max(ctx.roomL || 0, ctx.roomR || 0);
  if (attacking && room > 1.6) {
    vLim *= lerp(1.0, 1.07, t.craft) * houseMulCtx(ctx, 0.99, 1.03, "attack");
  }
  const opt = clamp(t.optimism != null ? t.optimism : 0, -1, 1);
  if (opt) vLim *= 1 + opt * 0.012;
  if (ctx.errMul) vLim *= ctx.errMul;
  _bind.vC = bVC * (vLimRaw > 0 && vLimRaw < 1e6 ? vLim / vLimRaw : 1);
  _bind.d = bD;
  return vLim;
}

export interface BrakeDecision {
  braking: boolean;
  brakeLvl: number;
  vLim: number;
  excess: number;
  ff: number;
}
const _br: BrakeDecision = { braking: false, brakeLvl: 0, vLim: 0, excess: 0, ff: 0 };
/** POOLED result (ai-drive.js:563). */
export function brakeDecision(ctx: BrakeCtx): BrakeDecision {
  const vLim = brakeTarget(ctx);
  const speed = ctx.speed || 0;
  const excess = speed - vLim;
  const pace = Math.max(0.05, Number.isFinite(ctx.pace) ? (ctx.pace as number) : 1);
  const excessStd = excess / pace;
  const d = (ctx.traits.consistency != null ? ctx.traits.consistency : 0.75) - 0.75;
  const soft = 1 - d * 0.8,
    full = 7 - d * 2;
  let brakeLvl = 0,
    ff = 0;
  let braking = false;
  if (excessStd > soft) {
    braking = true;
    const brake = ctx.brake || 22,
      vC = _bind.vC,
      d2 = Math.max(_bind.d, 1);
    ff = Math.max(0, (speed * speed - vC * vC) / (2 * d2 * brake));
    brakeLvl = clamp(ff + (excessStd - soft) / (full - soft), 0.2, 1);
  }
  _br.braking = braking;
  _br.brakeLvl = brakeLvl;
  _br.vLim = vLim;
  _br.excess = excess;
  _br.ff = ff;
  return _br;
}

// ── lanes, overtaking, the pass latch (ai-drive.js:596-760) ─────────────────
export interface LaneCtx {
  traits: Traits;
  nearby?: number;
  roomL?: number;
  roomR?: number;
  street?: boolean;
  baseLane?: number | null;
  queueT?: number;
}
export function adaptLane(lane: number, ctx: LaneCtx, dt: number): number {
  const dens = ctx.nearby || 0;
  if (dens < 2 && !(ctx.street && queuePress(ctx) >= 0.5)) return lane;
  const freer = (ctx.roomR || 0) - (ctx.roomL || 0);
  const minFree = ctx.street ? 1.35 : 0.9;
  if (Math.abs(freer) < minFree) return lane;
  const sign = freer > 0 ? 1 : -1;
  const destRoom = sign > 0 ? ctx.roomR || 0 : ctx.roomL || 0;
  if (ctx.street && destRoom < 1.7) return lane;
  const step = lerp(0.08, 0.22, ctx.traits.craft) * lerp(0.7, 1.15, ctx.traits.awareness) * (ctx.street ? 0.55 : 1);
  const home = ctx.baseLane != null ? ctx.baseLane : lane;
  const target = clamp(home + sign * step, -0.85, 0.85);
  return damp(lane, target, 0.35, dt);
}

/** game.js `_aiOtPull` (:4664): the pull / want / attack / latch context. */
export interface OtPullCtx extends HouseCtx {
  street?: boolean;
  traits: Traits;
  speed?: number;
  blockerSpeed?: number;
  blockerGap: number;
  roomL?: number;
  roomR?: number;
  roadL?: number;
  roadR?: number;
  other?: OtherCar | null;
  kAhead?: number;
  lane?: number;
  freeSpeed?: number;
  blockerVmax?: number;
  vTop?: number;
  blockerAccel?: number;
  attackQ?: number;
  toTurnIn?: number;
  kTurn?: number;
  calm?: number;
  roll?: number | null;
  queueT?: number;
  ourVmax?: number;
  ourPace?: number;
  blockerPace?: number;
}
export function otPull(ctx: OtPullCtx): number {
  const street = !!ctx.street;
  const t = ctx.traits;
  const gap = ctx.blockerGap;
  if (gap >= (street ? 14 : 16)) return 0;
  if (!otWant(ctx)) return 0;
  const side = otSide(ctx);
  const need = side > 0 ? ctx.roomR || 0 : ctx.roomL || 0;
  const house = houseMulCtx(ctx, 0.9, 1.12, "attack") * ordersMul(ctx.team, ctx.seat, ctx.other, "ot");
  if (street) {
    return side * lerp(0.7, 2.35, clamp(1 - gap / 14, 0, 1)) * clamp(need / 2.3, 0, 1) * streetOtScale(t) * house;
  }
  return side * lerp(0.8, 2.6, clamp(1 - gap / 16, 0, 1)) * clamp(need / 2.2, 0, 1) * lerp(0.75, 1.3, t.craft) * house;
}
export function otWant(ctx: OtPullCtx): boolean {
  const street = !!ctx.street;
  const ref = (ctx.vTop as number) > 0 ? (ctx.vTop as number) : 72;
  const aggr = clamp(ctx.traits && ctx.traits.aggression != null ? ctx.traits.aggression : 0, -1, 1);
  const bv = (ctx.blockerVmax as number) > 0 ? (ctx.blockerVmax as number) : ctx.blockerSpeed || 0;
  const edgeN = street ? 0 : pairEdgeN(ctx.ourVmax, ctx.blockerVmax, ctx.ourPace, ctx.blockerPace, ref);
  let margin = (street ? 0.055 : 0.07) * ref * lerp(1, 0.3, queuePress(ctx)) * lerp(1.1, 0.88, (aggr + 1) * 0.5);
  if (edgeN) margin *= lerp(1, 0.42, edgeN);
  const crawling = (ctx.blockerSpeed || 0) < 0.12 * ref && (ctx.blockerAccel || 0) < 0.016 * ref;
  const closing = (ctx.speed || 0) >= (ctx.blockerSpeed || 0) + margin;
  const held = (ctx.freeSpeed || 0) >= bv + margin;
  const press = queuePress(ctx);
  const clear = Math.max(ctx.roomL || 0, ctx.roomR || 0) >= (street ? 2.2 : 2.8);
  const impatient = press >= 1 && clear && (ctx.freeSpeed || 0) + 0.005 * ref >= bv;
  const edgeHeld = edgeN > 0 && clear && press >= 0.25 && (ctx.freeSpeed || ctx.ourVmax || 0) + 0.002 * ref >= bv;
  return crawling || closing || held || impatient || edgeHeld;
}

// ── launch, first-lap calm, pace phase (ai-drive.js:684-764) ────────────────
export interface LaunchPlan {
  react: number;
  grip: number;
}
const _launch: LaunchPlan = { react: 0, grip: 1 };
export function launchPlan(t: Traits, roll: number): LaunchPlan {
  const r = roll || 0,
    r2 = (r * 7919) % 1;
  _launch.react = clamp(lerp(0.54, 0.15, t.awareness) + (r - 0.5) * 0.26, 0.05, 0.78);
  const hands = 0.5 * t.craft + 0.5 * clamp((t.skill - 0.9) * 10, 0, 1);
  _launch.grip = clamp(lerp(0.79, 1.0, hands) + (r2 - 0.5) * 0.22, 0.69, 1.08);
  return { react: _launch.react, grip: _launch.grip };
}
const LAUNCH_FADE = 3.2;
export function launchMul(tSince: number, plan: LaunchPlan | null | undefined): number {
  if (!plan) return 1;
  if (tSince < plan.react) return 0;
  return lerp(plan.grip, 1, clamp((tSince - plan.react) / LAUNCH_FADE, 0, 1));
}
export function launchDone(tSince: number, plan: LaunchPlan | null | undefined): boolean {
  return !plan || tSince > plan.react + LAUNCH_FADE;
}
const START_CALM = 24,
  START_GAP_T = 0.42,
  START_ATTACK = 0.45;
export function startCalm(launching: boolean | undefined, until: number | undefined, t: number): number {
  if (launching) return 1;
  return (until as number) > t ? clamp(((until as number) - t) / 10, 0, 1) : 0;
}
export function startCalmS(): number {
  return START_CALM;
}
export function startGapT(calm: number | undefined): number {
  return START_GAP_T * (calm || 0);
}
export function startQWinBonus(_calm?: number, _t?: number): number {
  return 0;
}
export function pacePhase(t: number, consistency: number | null | undefined, roll: number | null | undefined): number {
  const r = roll || 0;
  const amp = lerp(0.016, 0.005, consistency == null ? 0.75 : consistency);
  const period = 24 + r * 36;
  return 1 + amp * Math.sin((t || 0) * ((2 * Math.PI) / period) + r * 6 * Math.PI);
}

// ── the pass position, patience and re-pass lockout (ai-drive.js:766-860) ───
export function passTarget(passX: number, side: number, clear: number, hw: number): number {
  const lim = (hw || 5) - 0.6;
  return clamp(passX + side * clear, -lim, lim);
}
export function passSideClosed(sideRoom: number, need: number, wcar: number): boolean {
  return sideRoom < Math.min(wcar || 2, Math.max(0, need || 0)) - 0.1;
}
export function passHold(t: Traits): number {
  const aggr = clamp(t && t.aggression != null ? t.aggression : 0, -1, 1);
  return lerp(2.4, 4.2, t.craft) * (1 + aggr * 0.12);
}
export function passCooldown(t: Traits): number {
  return lerp(3.5, 1.8, t.experience);
}
export function repassLock(t: Traits, edge: number): number {
  return 2 * passCooldown(t) * clamp(1 - (edge || 0) / 0.06, 0.3, 1);
}
export function attemptRoll(hash: number | undefined, lap: number, key: number): number {
  let h = (((hash as number) | 0) ^ Math.imul(lap | 0, 0x9e3779b1) ^ Math.imul(key | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const RUN_T = 0.15;
export function runExtra(kHere: number, qNext: number, want: boolean | undefined, street: boolean, hunger: number): number {
  if (street || !want || Math.abs(kHere || 0) <= 0.004 || qNext < 0.4) return 0;
  const h = clamp((hunger || 1) - 1, 0, 1);
  return RUN_T * (1 + h * 0.85);
}
export function latchLate(ctx: OtPullCtx): boolean {
  if (ctx.street) return true;
  if (!((ctx.toTurnIn as number) > 150) || Math.abs(ctx.kAhead || 0) > 0.004) return true;
  const ref = (ctx.vTop as number) > 0 ? (ctx.vTop as number) : 72;
  if ((ctx.blockerSpeed || 0) < 0.12 * ref || queuePress(ctx) >= 1) return true;
  return (ctx.speed || 0) - (ctx.blockerSpeed || 0) >= 0.015 * ref || (ctx.blockerGap || 0) <= 6 + (FOLLOW_TIGHT + 0.03) * (ctx.speed || 0);
}
export function cornerK(k1: number, k2: number, k3: number): number {
  let k = k1 || 0;
  if (Math.abs(k2 || 0) > Math.abs(k)) k = k2;
  if (Math.abs(k3 || 0) > Math.abs(k)) k = k3;
  return k;
}
export interface SbsCtx {
  street?: boolean;
  traits: Traits;
  vTop?: number;
  other?: OtherCar | null;
  ourVmax?: number;
  ourPace?: number;
  otherVmax?: number;
  otherPace?: number;
}
export function sbsCommitT(ctx: SbsCtx | null | undefined): number {
  if (ctx && !ctx.street) {
    const concede = coverConcede({
      street: false,
      traits: ctx.traits,
      ...(ctx.vTop !== undefined ? { vTop: ctx.vTop } : {}),
      ...(ctx.ourVmax !== undefined ? { ourVmax: ctx.ourVmax } : {}),
      ...(ctx.ourPace !== undefined ? { ourPace: ctx.ourPace } : {}),
      ...(ctx.otherVmax !== undefined ? { chaserVmax: ctx.otherVmax } : {}),
      ...(ctx.otherPace !== undefined ? { chaserPace: ctx.otherPace } : {}),
      other: ctx.other ?? null,
    });
    if (concede >= 0.7) return 1.15;
  }
  return 2;
}
export function sbsEase(ctx: SbsCtx | null | undefined): number {
  if (ctx && !ctx.street) {
    const concede = coverConcede({
      street: false,
      traits: ctx.traits,
      ...(ctx.vTop !== undefined ? { vTop: ctx.vTop } : {}),
      ...(ctx.ourVmax !== undefined ? { ourVmax: ctx.ourVmax } : {}),
      ...(ctx.ourPace !== undefined ? { ourPace: ctx.ourPace } : {}),
      ...(ctx.otherVmax !== undefined ? { chaserVmax: ctx.otherVmax } : {}),
      ...(ctx.otherPace !== undefined ? { chaserPace: ctx.otherPace } : {}),
      other: ctx.other ?? null,
    });
    if (concede >= 0.7) return 0.94;
  }
  return 0.97;
}

const SIDE_LEVEL = 2.4;
export function attackOK(ctx: OtPullCtx): boolean {
  const inZone = (ctx.toTurnIn != null ? ctx.toTurnIn : 1e9) < 130;
  const bend = clamp(1 - (Math.abs(ctx.kAhead || 0) - 0.004) / 0.016, 0, 1);
  let q = inZone ? ctx.attackQ || 0 : lerp(0.15, 0.6, bend);
  const ref = (ctx.vTop as number) > 0 ? (ctx.vTop as number) : 72;
  const bv = (ctx.blockerVmax as number) > 0 ? (ctx.blockerVmax as number) : ctx.blockerSpeed || 0;
  const deficit = clamp((((ctx.freeSpeed || 0) - bv) / ref - 0.06) / 0.06, 0, 1);
  if ((ctx.blockerSpeed || 0) < 0.12 * ref) q = 1;
  else q = Math.max(q, 0.6 * deficit);
  const closing = clamp(((ctx.speed || 0) - (ctx.blockerSpeed || 0)) / ((6 * ref) / 72), 0.25, 1);
  const craft = lerp(0.7, 1.25, ctx.traits ? ctx.traits.craft : 0.75);
  const roll = 0.85 + 0.3 * (ctx.roll != null ? ctx.roll : 0.5);
  q *= 1 - (1 - START_ATTACK) * (ctx.calm || 0);
  return q * Math.max(closing, deficit, 0.7 * queuePress(ctx)) * craft * roll >= 0.32 && passReach(ctx);
}
export function passReach(ctx: OtPullCtx): boolean {
  const to = ctx.toTurnIn as number;
  if (!(to < 1e8) || !(ctx.blockerGap > 0)) return true;
  const ref = (ctx.vTop as number) > 0 ? (ctx.vTop as number) : 72;
  if ((ctx.blockerSpeed || 0) < 0.12 * ref) return true;
  const gain = ctx.blockerGap - SIDE_LEVEL;
  if (gain <= 0) return true;
  const bv = (ctx.blockerVmax as number) > 0 ? (ctx.blockerVmax as number) : ctx.blockerSpeed || 0;
  const dv = Math.max((ctx.speed || 0) - (ctx.blockerSpeed || 0), (ctx.freeSpeed || 0) - bv, ref / 72);
  return ((ctx.speed || 0) * gain) / dv <= 1.25 * to;
}
export function queueTime(prevT: number | undefined, held: boolean, dt: number): number {
  return held ? (prevT || 0) + dt : Math.max(0, (prevT || 0) - 2 * dt);
}
export function queuePatience(t: Traits | null | undefined): number {
  const aggr = clamp(t && t.aggression != null ? t.aggression : 0, -1, 1);
  return lerp(7, 3.5, t ? t.craft : 0.75) * lerp(1.12, 0.88, (aggr + 1) * 0.5);
}
export function queuePress(ctx: { queueT?: number; traits?: Traits | null }): number {
  return clamp((ctx.queueT || 0) / queuePatience(ctx.traits), 0, 1);
}
export function sideLevel(): number {
  return SIDE_LEVEL;
}

// ── mistakes (ai-drive.js:1382-1397) ────────────────────────────────────────
export function mistakeChance(t: Traits | null | undefined, pressure: number, errMul: number): number {
  const cons = t && t.consistency != null ? t.consistency : 0.75;
  const em = errMul > 0 ? errMul : 1;
  const press = clamp(pressure || 0, 0, 1);
  const base = 0.004 * (1 + 7.0 * clamp((em - 1) / 1.2, 0, 1));
  const opt = clamp(t && t.optimism != null ? t.optimism : 0, -1, 1);
  const optMul = 1 + 0.25 * opt * press;
  return base * (1 + 2 * press) * (1.3 - cons) * em * optMul;
}
const ERR_LATE = 1.2,
  ERR_GATHER = 1.8;
export function mistakeTotal(): number {
  return ERR_LATE + ERR_GATHER;
}
export function mistakePhase(errT: number | undefined): 0 | 1 | 2 {
  return !((errT as number) > 0) ? 0 : (errT as number) > ERR_GATHER ? 1 : 2;
}
export function mistakeBrakeMul(): number {
  return 1.05;
}
export function mistakeGatherMul(): number {
  return 0.85;
}

// ── tyres without wear (ai-drive.js:1020-1031) ──────────────────────────────
const TYRE: Readonly<Record<string, { off: number; deg: number }>> = {
  soft: { off: 0.004, deg: 0.0012 },
  medium: { off: 0, deg: 0.0007 },
  hard: { off: -0.004, deg: 0.0004 },
};
export function tyreClass(roll: number, laps: number): "soft" | "medium" | "hard" {
  const r = roll || 0;
  if (laps <= 5) return r < 0.7 ? "soft" : "medium";
  if (laps <= 15) return r < 0.4 ? "soft" : r < 0.8 ? "medium" : "hard";
  return r < 0.25 ? "soft" : r < 0.7 ? "medium" : "hard";
}
export function tyrePace(cls: string, lapsDone: number): number {
  const t = TYRE[cls] || (TYRE["medium"] as { off: number; deg: number });
  return 1 + t.off - Math.min(t.deg * Math.max(lapsDone || 0, 0), 0.025);
}

// ── side-by-side with a human (ai-drive.js:1420-1462) ───────────────────────
export function humanYieldGrace(): number {
  return 0.3;
}
export function humanYieldBand(): number {
  return 0.3;
}
const HOLD_RATE = 0.25;
export function humanYieldT(prevT: number, close: boolean, aiElected: boolean, otherHuman: boolean, intruding: boolean, dt: number, inside: boolean): number {
  if (!close || !otherHuman) return 0;
  if (aiElected) return 0;
  if (intruding) return prevT + dt;
  return inside ? prevT + dt * HOLD_RATE : prevT;
}
export function humanYieldTakes(t: number | undefined): boolean {
  return (t || 0) > humanYieldGrace();
}

/** A human's pace against what the AI does on the same metre of road (ai-drive.js:1476-1483). */
export function paceSample(
  ref: Float32Array,
  i: number,
  c: { speed: number; human: boolean; paceF?: number | undefined },
  vmax: number,
  free: boolean,
  dt: number,
): void {
  if (!(vmax > 1)) return;
  const f = c.speed / vmax;
  if (!(f > 0.02)) return;
  if (!c.human) {
    if (free) ref[i] = (ref[i] as number) > 0 ? (ref[i] as number) + (f - (ref[i] as number)) * 0.2 : f;
    return;
  }
  const r = ref[i] as number;
  if (r > 0.05) c.paceF = damp((c.paceF as number) > 0 ? (c.paceF as number) : 1, clamp(f / r, 0.6, 1.25), 0.15, dt);
}
export function aimIntrudes(desiredX: number, x: number, otherX: number, clear: number): boolean {
  if (Math.abs(desiredX - otherX) >= clear) return false;
  return otherX <= x ? desiredX < x : desiredX > x;
}

// ── mirrors, defending (ai-drive.js:1523-1595) ──────────────────────────────
export function mirrorReach(t: Traits | null | undefined, speed: number): number {
  const v = Math.max(speed || 0, 10);
  return clamp(v * lerp(0.6, 1.05, t ? t.awareness : 0.75), 13, 72);
}
export function defendWindowT(t: Traits | null | undefined): number {
  return lerp(0.35, 0.7, t ? t.awareness : 0.75);
}
/** game.js `_aiDefend` (:4665). */
export interface DefendCtx extends HouseCtx {
  street?: boolean;
  traits: Traits;
  speed?: number;
  chaser?: boolean;
  chaserGap?: number | null;
  chaserSpeed?: number;
  kA?: number;
  roomL?: number;
  roomR?: number;
  other?: OtherCar | null;
  blocker?: unknown;
  blockerGap?: number;
  kTurn?: number;
  toTurnIn?: number;
  roadL?: number | null;
  roadR?: number | null;
  x?: number;
  vTop?: number;
  chaserVmax?: number;
  ourVmax?: number;
  chaserPace?: number;
  ourPace?: number;
}
export function defendPull(ctx: DefendCtx): number {
  if (!ctx.chaser || (ctx.blocker && (ctx.street || !((ctx.chaserGap as number) < (ctx.blockerGap as number))))) return 0;
  const gT = (ctx.chaserGap == null ? 99 : ctx.chaserGap) / Math.max(ctx.speed || 0, 10);
  const winT = defendWindowT(ctx.traits);
  if (gT >= winT) return 0;
  if ((ctx.chaserSpeed || 0) <= (ctx.speed || 0) - 3 * ((ctx.vTop as number) > 0 ? (ctx.vTop as number) / 72 : 1)) return 0;
  const kA = ctx.kA || 0;
  let coverSide: number,
    straight = false;
  if (Math.abs(kA) > 0.004) {
    coverSide = -Math.sign(kA);
  } else {
    const o = ctx.other;
    const ox = o ? (Number.isFinite(o._snapX) ? (o._snapX as number) : Number.isFinite(o.x) ? (o.x as number) : 0) : 0;
    const dx = ox - (ctx.x || 0);
    const kT = ctx.kTurn || 0;
    if (Math.abs(dx) >= 0.35) coverSide = dx > 0 ? 1 : -1;
    else if (!ctx.street && Math.abs(kT) > 0.004 && (ctx.toTurnIn as number) < 2 * Math.max(ctx.speed || 0, 10)) coverSide = -Math.sign(kT);
    else return 0;
    straight = true;
  }
  const coverRoom = coverSide > 0 ? ctx.roomR || 0 : ctx.roomL || 0;
  if (ctx.street && coverRoom < 2.2) return 0;
  const road = coverSide > 0 ? ctx.roadR : ctx.roadL;
  const edgeCap = road != null ? Math.max(0, road - 2.5) : Infinity;
  let mag =
    lerp(0.2, 1.1, ctx.traits.craft) *
    clamp(1 - gT / winT, 0, 1) *
    clamp(coverRoom / 2, 0, 1) *
    houseMulCtx(ctx, 0.9, 1.12, "hold") *
    ordersMul(ctx.team, ctx.seat, ctx.other, "defend");
  const concede = coverConcede(ctx);
  if (concede >= 0.7) return 0;
  mag *= 1 - concede;
  const scale = (ctx.street ? 0.45 : 1) * (straight ? 0.6 : 1);
  return coverSide * Math.min(mag * scale, edgeCap);
}

// ── boxed, dig-out, rescue (ai-drive.js:1616-1667) ──────────────────────────
export interface BoxedCtx {
  contactT?: number;
  roomL?: number;
  roomR?: number;
  blocker?: unknown;
  blockerGap?: number;
  street?: boolean;
}
export function isBoxed(ctx: BoxedCtx): boolean {
  const roomL = ctx.roomL || 0,
    roomR = ctx.roomR || 0;
  if (roomL < 1.3 && roomR < 1.3) return true;
  if ((ctx.contactT || 0) > 0 && roomL < 1.6 && roomR < 1.6) return true;
  if (!(ctx.blocker && (ctx.blockerGap as number) < 6)) return false;
  if (ctx.street) return roomL < 1.8 && roomR < 1.8;
  return true;
}
export function digOutBudget(t: Traits | null | undefined, street: boolean): number {
  const base = lerp(3.5, 2.0, t && t.awareness != null ? t.awareness : 0.75);
  return street ? base * 0.6 : base;
}
export function digOutEscalated(stuckT: number | undefined, t: Traits, street: boolean): boolean {
  return (stuckT || 0) > stuckThreshold(t) + digOutBudget(t, street);
}
export function digOutHeld(held: boolean | undefined, escalatedNow: boolean, digging: boolean): boolean {
  return !!escalatedNow || (!!held && !!digging);
}
export function aiRescueDelay(contacting: boolean, escalated: boolean): number {
  if (escalated) return contacting ? 2.0 : 1.25;
  return contacting ? 7 : 4;
}

// ── pass side, let pass (ai-drive.js:1669-1718) ─────────────────────────────
export function otSide(ctx: { roomL?: number; roomR?: number; kTurn?: number; kAhead?: number; lane?: number }): 1 | -1 {
  const roomL = ctx.roomL || 0,
    roomR = ctx.roomR || 0;
  const diff = roomR - roomL;
  if (Math.abs(diff) >= 0.6) return diff > 0 ? 1 : -1;
  const kA = Math.abs(ctx.kTurn || 0) > 0.002 ? (ctx.kTurn as number) : ctx.kAhead || 0;
  if (Math.abs(kA) > 0.002) return kA > 0 ? -1 : 1;
  const lane = ctx.lane || 0;
  if (Math.abs(lane) > 0.05) return lane > 0 ? 1 : -1;
  return diff >= 0 ? 1 : -1;
}
export function passSideBonus(ctx: OtPullCtx, side: number): number {
  const k = ctx.kTurn || 0;
  if (!ctx.street && Math.abs(k) > 0.004 && (ctx.toTurnIn as number) < 250) return side === -Math.sign(k) ? 0.8 : 0;
  return otSide(ctx) === side ? 0.3 : 0;
}
export function letPassCase(
  racing: boolean,
  blocker: unknown,
  chaser: unknown,
  chaserGap: number,
  chaserSpeed: number,
  speed: number,
  vScale: number,
  lapping: boolean,
): boolean {
  if (!racing || blocker || !chaser || !lapping || !(chaserGap < 9)) return false;
  return (chaserSpeed || 0) > (speed || 0) + 2.5 * (vScale > 0 ? vScale : 1);
}
export function letPassDelay(t: Traits): number {
  return lerp(4.2, 1.8, t.awareness);
}
export function letPassPull(t: Traits, street: boolean): number {
  const pull = lerp(0.9, 1.5, t.experience);
  return street ? pull * 0.5 : pull;
}
export function letPassEase(t: Traits): number {
  return lerp(0.965, 0.99, t.experience);
}
export function minLatGap(hw: number, street: boolean): number {
  if (!street) return 2.8;
  return clamp((hw || 5) * 0.44, 2.12, 2.45);
}
export function lineFollow(street: boolean, hold: number): number {
  const base = street ? 0.86 : 0.92;
  return hold ? clamp(base - hold * 0.06, 0.7, 0.95) : base;
}
