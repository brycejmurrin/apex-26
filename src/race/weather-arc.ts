/**
 * THE DYNAMIC WEATHER ARC: a race's weather walking dry ↔ wet ↔ rain ↔ storm,
 * road wetness as a lagged closed-form state, the stage read off that wetness,
 * and the seeded CHANGEABLE (MIXED) plan.
 *
 * Ported from f1-game js/race/weather-arc.js (main @ 2026-10-18), lap-wide
 * arcs. What f1-game did as side effects (`setWeatherLive`: rain overlay,
 * audio, lighting, `G.announce`) is returned to the caller as the new weather.
 * TODO(lane-race): local showers (js/race/rain-cells.js, `a.cell` / `a.w0s`).
 */
import type { Weather } from "../contracts/sim";
import { unit } from "./hash32";

/** f1-game weathers; sim.ts `Weather` lacks "storm" (TODO coordinator: add it). */
export type Wx = Weather | "storm";

export const LADDER: readonly Wx[] = ["dry", "wet", "rain", "storm"];
export const VALID: readonly Wx[] = ["dry", "wet", "rain", "overcast", "fog", "storm"];
export const TARGETS: readonly Wx[] = ["dry", "overcast", "wet", "rain", "fog", "storm"];
const DRAWN = TARGETS.slice(0, 5);
export const STORM_ODDS = 0.25;
const asRain = (w: string): string => (w === "storm" ? "rain" : w);
const INTENSITY: Readonly<Record<string, number>> = { wet: 0.5, rain: 1, storm: 1.5 };
const intOf = (w: string): number => INTENSITY[w] || 0;
export const STORM_AT = 1.25;
/** Lag time constants, s: wetting / drying (:233). */
export const TAU_WET = 8, TAU_DRY = 36;
export const SETTLE = 0.005;
export const WET_ROAD = 0.25, RAINING = 0.72;

/** The stage sequence an arc walks (:27-35). */
export function arcSeq(from: Wx, to: Wx): Wx[] {
  const a = LADDER.indexOf(from), b = LADDER.indexOf(to);
  if (a >= 0 && b >= 0 && a !== b) {
    const seq: Wx[] = [];
    for (let i = a; (a < b) ? i <= b : i >= b; i += (a < b) ? 1 : -1) seq.push(LADDER[i] as Wx);
    return seq;
  }
  return [from, to];
}

/** A weather's wetness (TyreModel.wetValue via asRain, :263). */
export function wetOf(w: string): number { w = asRain(w); return w === "rain" ? 1 : w === "wet" ? 0.5 : 0; }
/** The tread ladder (TyreModel.treadFor on a wetness, :264). */
export function treadOf(w: number): number { return w >= 0.72 ? 2 : w >= 0.25 ? 1 : 0; }

/** A live arc. `t` is seconds into it, read off the shared race clock via `t0`. */
export interface WxArc {
  from: Wx;
  to: Wx;
  t: number;
  dur: number;
  seq: Wx[];
  w0: number;
  i0: number;
  t0: number | null;
  _tt: number;
  /** Seconds into the arc the road turns inter-wet; 0 already, null never. */
  wetIn: number | null;
  _wt?: number;
  _w?: number;
}

/** Road wetness `e` s into the arc: the exact first-order lag on the ramp (:271-279). */
export function wetAt(a: Pick<WxArc, "w0" | "to" | "dur">, e: number): number {
  if (!(e > 0)) return a.w0;
  const w1 = wetOf(a.to), dur = a.dur, s = (w1 - a.w0) / dur, tau = s >= 0 ? TAU_WET : TAU_DRY;
  const ramp = (u: number): number => a.w0 + s * u - s * tau * (1 - Math.exp(-u / tau));
  if (e <= dur) return ramp(e);
  const wE = ramp(dur);
  return w1 + (wE - w1) * Math.exp(-(e - dur) / (w1 >= wE ? TAU_WET : TAU_DRY));
}

/** When the road turns inter-wet, by bisection (:283-290). */
export function wetInOf(a: Pick<WxArc, "w0" | "to" | "dur">): number | null {
  if (treadOf(a.w0) >= 1) return 0;
  if (treadOf(wetOf(a.to)) < 1) return null;
  let lo = 0, hi = a.dur + 20 * TAU_WET;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (treadOf(wetAt(a, m)) >= 1) hi = m; else lo = m; }
  return hi;
}

/** Live road wetness; with no arc, the weather's own value (:296-306). */
export function wetness(arc: WxArc | null, raceWeather: string): number {
  const a = arc;
  if (!a) return wetOf(raceWeather);
  if (a._wt !== a.t) { a._wt = a.t; a._w = wetAt(a, a.t); }
  return a._w as number;
}

const intAt = (a: WxArc, f: number): number => a.i0 + (intOf(a.to) - a.i0) * f;

/** The stage the sky shows at wetness `w` (:401-409). */
export function stageFor(a: WxArc, w: number, f: number): Wx {
  const w0 = wetOf(a.from), w1 = wetOf(a.to);
  if (w0 === 0 && w1 === 0 && !(a.w0 > 0)) return a.seq[Math.min(a.seq.length - 1, Math.floor(f * a.seq.length))] as Wx;
  const tread = treadOf(w);
  if (tread >= 2) return intAt(a, f) >= STORM_AT ? "storm" : "rain";
  if (tread >= 1) return "wet";
  return w1 === 0 ? a.to : w0 === 0 ? a.from : "dry";
}

/** What arming or ticking an arc asks the caller to do. */
export interface ArcResult {
  arc: WxArc | null;
  /** Set the live weather to this (setWeatherLive); undefined = unchanged. */
  weather?: Wx;
  /** Cross-fade the lighting (the arc), else cut. */
  blend?: boolean;
  /** "WEATHER: RAIN" banner, when a stage flipped mid-arc. */
  announce?: string;
}

/**
 * Arm an arc; a call while one is live re-targets it from the road's wetness
 * now (:416-433). `now` is the race clock; `inRace` false starts the arc at the green.
 */
export function startArc(cur: WxArc | null, raceWeather: Wx, from: Wx, to: Wx, dur: number, now: number, inRace: boolean): ArcResult {
  if (VALID.indexOf(from) < 0 || VALID.indexOf(to) < 0) return { arc: cur };
  const live = !!cur;
  const w0 = cur ? wetness(cur, raceWeather) : wetOf(from);
  const i0 = cur ? intAt(cur, Math.min(1, cur.t / cur.dur)) : intOf(from);
  if (from === to && (!live || (Math.abs(w0 - wetOf(to)) < SETTLE && Math.abs(i0 - intOf(to)) < SETTLE))) {
    if (live && raceWeather !== to) return { arc: null, weather: to, blend: true };
    return { arc: live ? null : cur };
  }
  const t0 = inRace ? now : 0;
  const arc: WxArc = { from, to, t: 0, dur: Math.max(1, dur || 60), seq: arcSeq(from, to), w0, i0, t0, _tt: 0, wetIn: null };
  arc.wetIn = wetInOf(arc);
  if (!live && raceWeather !== from) return { arc, weather: from };
  return { arc };
}

/** One tick on the shared clock (:434-489, lap-wide). */
export function tickArc(arc: WxArc | null, raceWeather: Wx, now: number): ArcResult {
  if (!arc) return { arc };
  if (arc.t0 == null || arc.t !== arc._tt) arc.t0 = now - (arc.t || 0);
  arc.t = arc._tt = Math.max(0, now - arc.t0);
  const f = Math.min(1, arc.t / arc.dur);
  const w = wetness(arc, raceWeather);
  const want = stageFor(arc, w, f);
  const res: ArcResult = { arc };
  let weather = raceWeather;
  if (weather !== want) { weather = want; res.weather = want; res.blend = true; res.announce = "WEATHER: " + want.toUpperCase(); }
  if (f >= 1 && Math.abs(wetness(arc, weather) - wetOf(arc.to)) < SETTLE) {
    if (weather !== arc.to) { res.weather = arc.to; res.blend = true; }
    res.arc = null;
  }
  return res;
}

/** Cap a derived MIXED walk so a short race reaches `to` before the flag (:110-115). */
export function capPlanDur(dur: number, laps: number, len: number | null | undefined): number {
  dur = Math.max(1, dur | 0);
  if (!(laps > 0) || !((len as number) > 0)) return dur;
  const cap = Math.max(90, Math.floor(laps * ((len as number) / 48) * 0.72));
  return Math.min(dur, cap);
}

/** The CHANGEABLE plan from (seed, round): 2–7 minutes to a target that is never `from` (:143-149). */
export function drawPlan(seed: number, round: number, from: Wx, laps: number, len: number | null | undefined): { to: Wx; dur: number } {
  const r = (k: string): number => unit(seed, round, "wx", k);
  const opts = DRAWN.filter((w) => w !== from);
  let to: Wx = opts[Math.floor(r("to") * opts.length)] || "wet";
  if (to === "rain" && from !== "storm" && r("storm") < STORM_ODDS) to = "storm";
  return { to, dur: capPlanDur(120 + Math.floor(r("dur") * 300), laps, len) };
}
