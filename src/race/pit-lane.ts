/**
 * PIT LANE, the strategy-facing half: the pit window, the lane speed limit,
 * the pit-loss estimate (plain and under a caution), the two-compound rule's
 * applicability and warning, whether a stop is worth making, and where a
 * car's box sits in the window.
 *
 * Ported from f1-game js/race/pit-lane.js (main @ 2026-10-18): constants
 * :71-330, `entryRunM` :105-115, `laneWidth[On]` :207-217, `zoneOf` :334-375,
 * `inWindow`/`throughM` :378-390, `limit` :408-411, `boxThroughFor` (painted
 * lane) :467-505, `estimate` :509-524, `worthStopping` :637-644, the planner's
 * rules :1530-1590. The state machine that drives a car through the lane
 * (`update`, `laneX`, approach speeds) moves with the AI/physics step: it reads
 * the car's lateral pose every tick. TODO(lane-race): port it once the sim
 * step exists to call it.
 */
import type { RaceCar } from "../contracts/race";
import { compoundShort, type StintEntry } from "./sporting-regs";

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const ENTRY_M = 260;
export const ENTRY_MIN = 150;
export const EXIT_M = 110;
export const BOX_M = 40;
export const PIT_K = 0.0035;
export const PIT_STEP = 8;
export const LIMIT_FRAC = 22.2 / 72;
export const STRAIGHT_V = 0.85;
export const LIMIT_FRAC_STREET = 16.7 / 72;
export const BOX_S = 2.2;
export const PIT_SIDE = 1;
export const LANE_W = 3.2;
export const LANE_MIN = 2.4;
export const MIN_RACING = 7.0;
/** TrackPit.PITCH, js/track/core/pit.js:34. */
export const PITCH = 11;
export const GRID_POLE_M = 14;
export const COMMIT_M = 120;
export const CUE_WEAR = 0.55;
export const COMMIT_CLEAR = 25;
export const GRID_CLEAR = COMMIT_CLEAR + 15;
export const TWO_COMPOUND_MIN_LAPS = 8;
export const COMPOUND_WARN_LAPS = 5;

/** A circuit's authored pit overrides (def.pitZone). */
export interface PitZoneDef {
  readonly entryM?: number;
  readonly exitM?: number;
  readonly boxM?: number;
  readonly limitFrac?: number;
  readonly boxS?: number;
  readonly side?: number;
}

/** A built pit complex (TrackPit), when the track has one. */
export interface PitModel {
  readonly sIn: number;
  readonly sOut: number;
  readonly lenM: number;
  readonly limitKph: number;
  readonly side: number;
  readonly painted?: boolean;
  readonly entryRoadM: number;
  readonly exitRoadM: number;
}

/** The track fields the pit rules read. */
export interface PitTrack {
  readonly total: number;
  readonly def?: { readonly pitZone?: PitZoneDef | null; readonly street?: boolean } | null;
  readonly pit?: PitModel | null;
  readonly pitW?: { readonly laneW: number } | null;
  /** Tracks.curvature (signed, 1/m); the entry run reads |k|. */
  readonly curvature?: (s: number) => number;
  /** Tracks.pitWindow: the engine's own entry run, when it has one. */
  readonly pitWindow?: { readonly entryM: number } | null;
}

export interface PitZone {
  sIn: number;
  sOut: number;
  sBox: number;
  lenM: number;
  limitFrac: number;
  boxS: number;
  side: number;
}

/** How far before the line the pit straight starts, clamped to a lane (:105-115). */
export function entryRunM(track: PitTrack): number {
  const L = track.total;
  if (!(L > 0) || !track.curvature) return ENTRY_M;
  let d = 0;
  for (; d < ENTRY_M; d += PIT_STEP) {
    const s = ((-(d + PIT_STEP / 2)) % L + L) % L;
    if (Math.abs(track.curvature(s)) > PIT_K) break;
  }
  return clamp(d, ENTRY_MIN, ENTRY_M);
}

/** :207-209. */
export function laneWidth(hw: number): number { return Math.min(LANE_W, Math.max(LANE_MIN, 2 * hw - MIN_RACING)); }
/** :215-217. */
export function laneWidthOn(track: PitTrack | null | undefined, hw: number): number { return track && track.pitW ? track.pitW.laneW : laneWidth(hw); }

/** The pit window in racing coordinates (:334-375). */
export function zoneOf(track: PitTrack | null | undefined): PitZone | null {
  if (!track || !(track.total > 0)) return null;
  const L = track.total;
  const z: PitZoneDef = (track.def && track.def.pitZone) || {};
  const wrap = (v: number): number => ((v % L) + L) % L;
  const model = track.pit;
  if (model) {
    return {
      sIn: model.sIn, sOut: model.sOut, sBox: wrap(-(z.boxM != null ? z.boxM : BOX_M)),
      lenM: model.lenM,
      limitFrac: z.limitFrac != null ? z.limitFrac : (model.limitKph / 3.6) / 72,
      boxS: z.boxS != null ? z.boxS : BOX_S,
      side: model.side,
    };
  }
  const eng = track.pitWindow || null;
  const entryM = z.entryM != null ? z.entryM : (eng ? eng.entryM : entryRunM(track));
  const exitM = z.exitM != null ? z.exitM : EXIT_M;
  const cap = L / 3;
  const inM = Math.min(entryM, cap * 0.7), outM = Math.min(exitM, cap * 0.3);
  return {
    sIn: wrap(-inM), sOut: wrap(outM), sBox: wrap(-(z.boxM != null ? z.boxM : BOX_M)),
    lenM: inM + outM,
    limitFrac: z.limitFrac != null ? z.limitFrac : (track.def && track.def.street ? LIMIT_FRAC_STREET : LIMIT_FRAC),
    boxS: z.boxS != null ? z.boxS : BOX_S,
    side: z.side === -1 ? -1 : PIT_SIDE,
  };
}

/** :378-383. */
export function inWindow(zone: PitZone | null, s: number, L: number): boolean {
  if (!zone) return false;
  const a = zone.sIn, b = zone.sOut;
  const v = ((s % L) + L) % L;
  return a <= b ? (v >= a && v <= b) : (v >= a || v <= b);
}

/** Metres into the window (:387-390). */
export function throughM(zone: PitZone, s: number, L: number): number {
  const v = ((s % L) + L) % L;
  return ((v - zone.sIn) % L + L) % L;
}

/** The lane speed cap, m/s at the current pace (:408-411). */
export function limit(zone: PitZone | null, vTop: number): number { return zone ? vTop * zone.limitFrac : Infinity; }

/** The pace envelope the loss reads (G.vTop(), G.aTop(), G.BRAKE). */
export interface PitEnv {
  readonly vTop: number;
  readonly aTop?: number;
  readonly brake?: number;
}

/** The lane's net cost, s, against the road at `roadFrac` of the envelope (:1566-1590). */
export function lossAt(track: PitTrack | null | undefined, zone: PitZone | null, env: PitEnv, roadFrac: number): number {
  if (!zone) return 0;
  const p = track && track.pit;
  const slowM = p && !p.painted ? p.lenM + p.entryRoadM + p.exitRoadM : zone.lenM;
  const straight = Math.max(1, env.vTop * roadFrac);
  const aUp = env.aTop ? Math.max(1, env.aTop) : 12, aDn = env.brake ? Math.max(1, env.brake) : 35;
  const lim = limit(zone, env.vTop);
  const dv = Math.max(0, straight - Math.max(1, lim));
  const swing = (dv * dv) / (2 * straight) * (1 / aUp + 1 / aDn);
  return Math.max(zone.boxS, slowM / Math.max(1, lim) + zone.boxS - slowM / straight + swing);
}

/** The STRATEGY row's figure (:1564). */
export function lossS(track: PitTrack | null | undefined, zone: PitZone | null, env: PitEnv): number { return lossAt(track, zone, env, STRAIGHT_V); }

type EstCar = Pick<RaceCar, "prog" | "speed" | "retired" | "finished">;

/** The lane's cost and the gap behind, under the current flag (:509-524). */
export function estimate<C extends EstCar>(c: C, cars: readonly C[], track: PitTrack | null | undefined, zone: PitZone | null, env: PitEnv, flag: number):
  { lossS: number; gapS: number | null; marginS: number | null; caution: boolean; estimated: true } | null {
  if (!zone) return null;
  if (flag >= 4) return null;
  const roadFrac = Math.min(STRAIGHT_V, flag === 3 ? 0.45 : flag === 2 ? 0.6 : 1);
  const loss = lossAt(track, zone, env, roadFrac);
  let behind: C | null = null;
  for (const o of cars || []) {
    if (o !== c && !o.retired && !o.finished && o.prog < c.prog && (!behind || o.prog > behind.prog)) behind = o;
  }
  const gapS = behind ? (c.prog - behind.prog) / Math.max(1, behind.speed || env.vTop * roadFrac) : null;
  return { lossS: loss, gapS, marginS: gapS == null ? null : gapS - loss, caution: flag >= 2, estimated: true };
}

/** Where a car's box sits, metres into the window, on a lane without a built row (:467-505). */
export function boxThroughFor(zone: PitZone, L: number, teamRow: number, teams: number, ribbon: { a: number; b: number } | null = null): number {
  const n = teamRow < 0 ? 1 : teams;
  const span = (n - 1) * PITCH;
  const poleS = ((-GRID_POLE_M % L) + L) % L;
  const wantFirst = throughM(zone, poleS, L) + GRID_CLEAR;
  const lo = ribbon ? ribbon.a + 20 : COMMIT_M + 20;
  const hi = Math.max(lo, (ribbon ? ribbon.b : zone.lenM) - 30 - span);
  const first = clamp(Math.max(wantFirst, throughM(zone, zone.sBox, L) - span / 2), lo, hi);
  if (teamRow < 0) return first + span / 2;
  return first + teamRow * PITCH;
}

/** B6.3.6 applies: a dry Race of at least 8 laps, not a sprint (:1530-1534). `tread` is TyreModel.treadFor. */
export function twoCompoundRule(laps: number, tread: number, sprint: boolean): boolean {
  return laps >= TWO_COMPOUND_MIN_LAPS && tread === 0 && !sprint;
}

/** Racing laps still owed, the current one included (:1541-1543). */
export function lapsToFlag(c: Pick<RaceCar, "lap"> | null | undefined, lapsTarget: number): number {
  return Math.max(0, (lapsTarget || 0) - ((c && c.lap) || 0) + 1);
}

/** The engineer's two-compound warning (:1548-1551). `applies` is twoCompoundApplies(). */
export function compoundDue(c: (Pick<RaceCar, "lap"> & { tyreLog?: readonly StintEntry[] }) | null | undefined, applies: boolean, lapsTarget: number): boolean {
  if (!c || !applies) return false;
  return lapsToFlag(c, lapsTarget) <= COMPOUND_WARN_LAPS && compoundShort(c.tyreLog);
}

/** A used set, the wrong tread, or a cheap stop under a caution (:637-644). `wear` is tyres.spent(c). */
export function worthStopping(c: Pick<RaceCar, "retired" | "finished"> & { tyre?: { tread?: number } | null } | null | undefined,
  o: { enabled: boolean; wear: number; tread: number; caution: number }): boolean {
  if (!o.enabled || !c || c.retired || c.finished) return false;
  const wrongTread = !!c.tyre && (c.tyre.tread || 0) !== o.tread;
  const free = o.caution >= 2 && o.caution < 4 && o.wear >= 0.35;
  return o.wear >= CUE_WEAR || wrongTread || free;
}
