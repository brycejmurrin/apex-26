/**
 * QUALIFYING: one flying lap, and the simulated times it is measured against.
 * A quasi-steady lap model (corner caps from |curvature|, forward/backward
 * acceleration passes, trapezoid integration), the per-car execution draw, the
 * classification rows, time-trial medals, and the persisted-order checks.
 *
 * Ported from f1-game js/race/quali-model.js (main @ 2026-10-18). PhysicsConsts
 * (VMAX js/physics/consts.js:11, DIFF :257-271) are inlined; the |curvature|
 * samples (Tracks.curvature), DriverRatings' consistency and the seed/round
 * selection come in as arguments. This model is the AI field's lap, never the
 * player's physics: the arc rule (AGENTS.md) is not touched by it.
 */
import type { RaceCar } from "../contracts/race";
import { unit } from "./hash32";

export const STEP = 4;
export const QUALI_TRIM = 0.75;
export const PACE_CORNER = 1.1;
export const EXEC_SPREAD = 0.012;
/** js/physics/consts.js:11. */
export const VMAX = 72;
/** js/physics/consts.js:257-271 (the `ai` column). */
export const DIFF_AI: Readonly<Record<string, number>> = { easy: 0.851, normal: 0.911, hard: 1.030 };

export const MEDALS: readonly (readonly [string, number])[] = [["gold", 1.0], ["silver", 1.03], ["bronze", 1.07]];
export const MEDAL_RANK: Readonly<Record<string, number>> = { bronze: 1, silver: 2, gold: 3 };

/** The time-trial medal for `t` against the reference pole (:91-95). */
export function medalFor(t: number, pole: number): string | null {
  if (!(t > 0) || !(pole > 0)) return null;
  for (const [m, k] of MEDALS) if (t <= pole * k) return m;
  return null;
}

/** The pace envelope the model reads (G.LAT_MAX, G.aTop(), G.BRAKE, G.vTop(), G.difficulty). */
export interface QualiEnv {
  readonly latMax: number;
  readonly aTop: number;
  readonly brake: number;
  readonly vTop: number;
  readonly difficulty: string;
}

/** The circuit as the model reads it: `n` nodes, `total` metres, and |k| at arc `s`. */
export interface QualiTrack {
  readonly n: number;
  readonly total: number;
  readonly id: string;
  readonly absCurvature: (s: number) => number;
}

interface LapShape { pace: number; free: number; corner: number }

const kCache = new WeakMap<QualiTrack, Float64Array>();
function kSamples(track: QualiTrack, m: number): Float64Array {
  let k = kCache.get(track);
  if (!k || k.length !== m) {
    k = new Float64Array(m);
    for (let i = 0; i < m; i++) k[i] = Math.abs(track.absCurvature((i / m) * track.total));
    kCache.set(track, k);
  }
  return k;
}

/** max(PACE, 0.05) read through vTop (:263-264). */
export function paceNow(env: QualiEnv): number { return VMAX > 0 ? env.vTop / VMAX : 1; }

/** The quasi-steady flying lap (:122-186). */
export function lapTime(env: QualiEnv, track: QualiTrack, vCap: number, grip: number, shape?: LapShape): number {
  const n = track.n, total = track.total;
  const m = Math.max(8, Math.floor(n / STEP));
  const ds = total / m;
  const latMax = env.latMax * grip;
  const accel = (shape ? env.aTop / paceNow(env) * shape.pace : env.aTop) * grip;
  const brake = env.brake * grip;
  const vFree = shape ? shape.free : 0, cornerK = shape ? shape.corner : 1;
  const ks = kSamples(track, m);
  const v = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const k = ks[i] as number;
    v[i] = k > 1e-5 ? Math.min(vCap, Math.sqrt(latMax / k) * cornerK) : vCap;
  }
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const vi = v[i] as number;
      const a = vFree ? accel * Math.max(0.02, 1 - vi / vFree) : accel;
      const reach = Math.sqrt(vi * vi + 2 * a * ds);
      if ((v[j] as number) > reach) v[j] = reach;
    }
  for (let pass = 0; pass < 2; pass++)
    for (let i = m - 1; i >= 0; i--) {
      const j = (i + 1) % m;
      const vj = v[j] as number;
      const reach = Math.sqrt(vj * vj + 2 * brake * ds);
      if ((v[i] as number) > reach) v[i] = reach;
    }
  let t = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    t += (2 * ds) / Math.max((v[i] as number) + (v[j] as number), 1);
  }
  return t;
}

/** A car's free pace at the current PACE (:268-271). */
export function freeFor(env: QualiEnv, tierV: number, skill: number): number {
  const ai = DIFF_AI[env.difficulty] ?? (DIFF_AI["normal"] as number);
  return env.vTop * tierV * skill * ai;
}

/** The trimmed straight-line cap (:272). */
export function capFor(env: QualiEnv, c: { tierV: number; skill: number }): number { return freeFor(env, c.tierV, c.skill) * QUALI_TRIM; }

/** The flying lap of a car of free pace `free`, carried from PACE 1 by the shape model (:276-284). */
export function paceLap(env: QualiEnv, track: QualiTrack, free: number, grip: number): number {
  const p = paceNow(env);
  const free1 = free / p;
  const anchor = lapTime(env, track, free1 * QUALI_TRIM, grip, { pace: 1, free: 0, corner: 1 });
  if (p === 1) return anchor;
  const shape = (q: number): number => lapTime(env, track, free1 * q, grip, { pace: q, free: free1 * q, corner: PACE_CORNER });
  return anchor * shape(p) / shape(1);
}

/** The time-trial reference pole: skill 1 in the tier-0 car (:290-294). `tierV0` is Teams.TIER_V[0]. */
export function referencePole(env: QualiEnv, track: QualiTrack | null, grip: number, tierV0 = 0.9695): number {
  if (!track || !track.n) return 0;
  return paceLap(env, track, freeFor(env, tierV0, 1), grip);
}

export type QualiCar = Pick<RaceCar, "driverId" | "code" | "team" | "isPlayer"> & { tierV: number; skill: number; name?: string };

/** One car's lap, deterministic for (seed, round, car) (:306-313). `consistency` is DriverRatings' 0..100. */
export function simLap(env: QualiEnv, c: QualiCar, track: QualiTrack, grip: number, round: number, seed: number, consistency: number): number {
  const base = paceLap(env, track, freeFor(env, c.tierV, c.skill), grip);
  const spread = EXEC_SPREAD * (1 - consistency / 100);
  const draw = unit(seed, round, "quali", c.driverId || c.code) - 0.5;
  return base * (1 + draw * 2 * spread);
}

/** One row of the classification (:341-347). */
export interface QualiRow {
  driverId: string;
  code: string;
  name?: string | undefined;
  team: string | undefined;
  isPlayer: boolean;
  human: boolean;
  t: number;
  pos: number;
  gap: number;
  noTime?: boolean;
}

/** Driven laps: one number for the player, or a map/record by driver id (:315-327). */
export type Driven = number | Map<string, number> | Readonly<Record<string, number>> | null | undefined;

export function drivenMap(driven: Driven, cars: readonly QualiCar[]): Map<string, number> | null {
  if (!driven) return null;
  if (typeof driven === "number") {
    if (!(driven > 0)) return null;
    const me = cars.find((c) => c.isPlayer);
    return me ? new Map([[me.driverId, driven]]) : null;
  }
  if (driven instanceof Map) return driven.size ? driven : null;
  const m = new Map<string, number>();
  for (const k of Object.keys(driven)) if ((driven[k] as number) > 0) m.set(k, driven[k] as number);
  return m.size ? m : null;
}

export interface ComputeOpts<C extends QualiCar> {
  readonly env: QualiEnv;
  readonly track: QualiTrack | null;
  readonly cars: readonly C[];
  readonly round: number;
  readonly seed: number;
  readonly grip: (c: C) => number;
  readonly consistency: (c: C) => number;
  readonly driven?: Driven;
}

/** The classification, fastest first; NO TIME behind the field a second apart (:329-358). */
export function computeQuali<C extends QualiCar>(o: ComputeOpts<C>): QualiRow[] | null {
  const track = o.track;
  if (!track || !o.cars.length) return null;
  const real = drivenMap(o.driven, o.cars);
  const rows: QualiRow[] = o.cars.map((c) => ({
    driverId: c.driverId, code: c.code, name: c.name,
    team: c.team && c.team.id, isPlayer: !!c.isPlayer,
    human: !!(real && real.has(c.driverId)),
    t: (real && (real.get(c.driverId) as number) > 0) ? real.get(c.driverId) as number
      : simLap(o.env, c, track, o.grip(c), o.round, o.seed, o.consistency(c)),
    pos: 0, gap: 0,
  }));
  let slow = 0;
  for (const r of rows) if (Number.isFinite(r.t) && r.t > slow) slow = r.t;
  for (const r of rows) if (!Number.isFinite(r.t)) { slow += 1; r.t = slow; r.noTime = true; }
  rows.sort((a, b) => a.t - b.t);
  const pole = (rows[0] as QualiRow).t;
  rows.forEach((r, i) => { r.pos = i + 1; r.gap = +(r.t - pole).toFixed(3); r.t = +r.t.toFixed(3); });
  return rows;
}

/** The grid order mapped onto the live cars; null unless every car is placed (:463-473). */
export function qualiOrder<C extends Pick<RaceCar, "driverId">>(rows: readonly Pick<QualiRow, "driverId">[] | null, live: readonly C[] | null): C[] | null {
  if (!rows || !live || !live.length) return null;
  const byId = new Map(live.map((c) => [c.driverId, c]));
  const out: C[] = [];
  for (const r of rows) {
    const c = byId.get(r.driverId);
    if (c) out.push(c);
  }
  return out.length === live.length ? out : null;
}

/** A persisted qualifying order (season.qualiOrder entries, :389-391). */
export interface PersistedEntry { id: string; t: number; human: boolean; noTime?: true }

/** seatKey (:369). */
export function seatKey(driverId: string, team: string | { id?: string } | null | undefined): string {
  return driverId + "|" + ((team && typeof team === "object" ? team.id : team) || "");
}

/** Rows to persist; null for a provisional all-AI sheet (:371-399, the pure part). */
export function persistRows(rows: readonly QualiRow[] | null): PersistedEntry[] | null {
  if (!rows || !rows.some((r) => r.human)) return null;
  return rows.map((r) => r.noTime
    ? { id: r.driverId, t: r.t, human: !!r.human, noTime: true as const }
    : { id: r.driverId, t: r.t, human: !!r.human });
}

export interface RestoreCtx<C extends QualiCar> {
  readonly order: readonly (PersistedEntry | string)[] | null | undefined;
  readonly qualiTrack?: string | null;
  readonly qualiMode?: string | null;
  readonly qualiSeat?: string | null;
  readonly here: string | null;
  readonly mode: string;
  readonly cars: readonly C[];
}

/** Restore a persisted order when it is this circuit's, mode's and seat's, with every live car exactly once (:401-463). */
export function restoreRows<C extends QualiCar>(o: RestoreCtx<C>): QualiRow[] | null {
  const raw = o.order;
  if (!Array.isArray(raw) || !raw.length) return null;
  if (o.qualiTrack && o.here && o.qualiTrack !== o.here) return null;
  if (o.qualiMode && o.qualiMode !== o.mode) return null;
  const byId = new Map<string, C>();
  for (const c of o.cars) byId.set(c.driverId, c);
  const ids = raw.map((e) => e && typeof e === "object" ? e.id : e);
  if (ids.length !== byId.size || new Set(ids).size !== byId.size || ids.some((id) => !byId.has(id))) return null;
  if (o.qualiSeat) {
    const me = o.cars.find((c) => c.isPlayer);
    if (me && seatKey(me.driverId, me.team) !== o.qualiSeat) return null;
  }
  const rows: QualiRow[] = raw.map((entry, i) => {
    const obj = entry && typeof entry === "object";
    const driverId = obj ? entry.id : entry as string;
    const car = byId.get(driverId);
    const row: QualiRow = {
      driverId, pos: i + 1,
      t: obj && entry.t > 0 ? entry.t : 0,
      gap: 0,
      code: car ? car.code : "",
      name: car ? car.name : "",
      team: car && car.team ? (car.team.id || undefined) : undefined,
      isPlayer: !!(car && car.isPlayer),
      human: !!(obj && entry.human),
    };
    if (obj && entry.noTime) row.noTime = true;
    return row;
  });
  const pole = rows[0] && rows[0].t > 0 ? rows[0].t : 0;
  for (const r of rows) r.gap = pole && r.t > 0 ? +(r.t - pole).toFixed(3) : 0;
  return rows;
}
