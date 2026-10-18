/**
 * TYRE MODEL: wear, the grip it costs, the fuel burn that argues with it, the
 * lateral force curve and the brake-stability split.
 *
 * Port of f1-game js/physics/tyre-model.js (`TyreModel`, :29-873), verbatim in
 * operation order. The design notes behind every constant are in that file;
 * the line cited on each block is where to read them.
 *
 * THE ARC MUST NOT REACH THE DRIVER: nothing here reads curvature or the
 * racing line (tyre-model.js:23-27). Wear integrates the forces the car made.
 */
import { PhysicsConsts } from "./consts";
import { clamp, lerp } from "./math";
import type { TyreWearLevel, WeatherArc } from "../contracts";

/** A non-finite input costs one neutral tick (tyre-model.js:33-36). */
const fin = (v: unknown, d: number): number => (typeof v === "number" && isFinite(v) ? v : d);

// ── LEVELS (tyre-model.js:38-50) ────────────────────────────────────────────
export const LEVELS: Readonly<Record<TyreWearLevel, number>> = { off: 0, light: 0.55, real: 1 };
export function isLevel(v: unknown): v is TyreWearLevel {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(LEVELS, v);
}

// ── LATERAL FORCE CURVE (tyre-model.js:52-109) ──────────────────────────────
export const CURVE_PEAK_X = Math.PI / 2;
export const CURVE_PEAK_X_F = (Math.PI / 2) * (8.5 / 10.5);
export const CURVE_FLOOR = 0.75;
export const CURVE_FALL_W = 1.4;
export const CURVE_FLOOR_R = 0.8;
export const CURVE_FALL_W_R = 2.0;
export const CURVE_HOLD_R = 2.6;

/**
 * Normalised lateral force at x = cs·α/mu. With `hold` given: the rear curve
 * (sin to π/2, plateau to `hold`, Gaussian fall to `floor` of width `fallW`).
 * Without: the front curve (rescaled to peak at CURVE_PEAK_X_F). :94-109.
 */
export function lateralCurve(x: number, floor?: number, fallW?: number, hold?: number): number {
  if (hold != null) {
    const ax = Math.abs(x);
    if (ax <= CURVE_PEAK_X) return Math.sin(x);
    if (ax <= hold) return x < 0 ? -1 : 1;
    // f1-game passes floor/fallW together with hold at every call site.
    const d = (ax - hold) / (fallW as number);
    const g = (floor as number) + (1 - (floor as number)) * Math.exp(-d * d);
    return x < 0 ? -g : g;
  }
  const ax = Math.abs(x);
  const k = Math.PI / 2 / CURVE_PEAK_X_F;
  if (ax <= CURVE_PEAK_X_F) return Math.sin(x * k);
  const d = (ax - CURVE_PEAK_X_F) / CURVE_FALL_W;
  const g = CURVE_FLOOR + (1 - CURVE_FLOOR) * Math.exp(-d * d);
  return x < 0 ? -g : g;
}

// ── COMPOUND LIFE (tyre-model.js:111-171) ───────────────────────────────────
const LIFE_MID = 0.88;
const LIFE_K = 2.31;
export const LIFE_MIN = 0.3,
  LIFE_MAX = 1.2;
export function deriveLife(cornering: unknown): number {
  const c = Number(cornering);
  return clamp(LIFE_MID * Math.exp(LIFE_K * (1 - (isFinite(c) ? c : 1))), LIFE_MIN, LIFE_MAX);
}
/** A catalog tyre row (f1-game js/car/parts.js), the fields the model reads. */
export interface TyreOption {
  readonly id?: string;
  readonly life?: number | null;
  readonly cornering?: number | null;
  readonly speed?: number | null;
  readonly accel?: number | null;
  readonly braking?: number | null;
  readonly wetTread?: number | null;
  readonly visual?: { readonly band?: readonly number[] | null } | null;
}
export function lifeOf(opt: TyreOption | null | undefined): number {
  if (!opt) return LIFE_MID;
  return opt.life != null ? clamp(+opt.life, LIFE_MIN, LIFE_MAX) : deriveLife(opt.cornering);
}

export const MIN_LIFE_LAPS = 5;
export function lifeLaps(life: number, lapsTarget: number): number {
  return Math.max(MIN_LIFE_LAPS, (life || LIFE_MID) * Math.max(1, lapsTarget || 1));
}

// ── LOAD (tyre-model.js:173-281) ────────────────────────────────────────────
const LOAD_REF = 0.49;
const LOAD_IDLE = 0.3;
const W_LAT = 0.95;
const W_LONG = 0.3;
const W_SLIDE = 0.9;
const W_KERB = 0.35;
const W_OFF = 1.2;
const LOAD_MIN = 0.2,
  LOAD_MAX = 3.0;

/** The car fields TyreModel reads and writes. All optional: f1-game cars carry them as undefined until set. */
export interface TyreCar {
  human?: boolean;
  speed?: number;
  yawRateCur?: number;
  axFrac?: number | undefined;
  axEstSm?: number | undefined;
  skidIntensity?: number | undefined;
  onKerb?: boolean | undefined;
  offroad?: boolean | undefined;
  consistency?: number | undefined;
  corridorAccel?: number | undefined;
  accSm?: number | undefined;
  brakeBias?: number | null | undefined;
  lap?: number;
  fuelLap?: number | null | undefined;
  prog?: number;
  s?: number;
  _progGift?: number | undefined;
  retired?: boolean;
  finished?: boolean;
  tread?: number | null | undefined;
  tyre?: TyreRecord | undefined;
  tyreOpt?: TyreOption | null | undefined;
  tyreClass?: string | null | undefined;
  tyreBaseMods?: Readonly<Record<StatKey, number>> | null | undefined;
  mods?: Partial<Record<StatKey, number>> | undefined;
  pitPlan?: { readonly start: string } | null | undefined;
  tyreWear?: number | undefined;
  tyreWearF?: number | undefined;
  tyreWearR?: number | undefined;
  tyreTs?: number | undefined;
  tyreTb?: number | undefined;
  tyreGrain?: number | undefined;
  tyreBlister?: number | undefined;
  flatSpot?: number | undefined;
  tyreLap0?: number | undefined;
  tyrePhysicalOffset?: number | null | undefined;
  tyreLapAdj?: number | undefined;
  tyreStints?: number | undefined;
  tyreLog?: TyreStint[] | undefined;
  _tyreLoad?: number | undefined;
}

export function humanLoad(c: TyreCar, latMax: number): number {
  const lat = clamp(Math.abs(fin(c.speed, 0) * fin(c.yawRateCur, 0)) / Math.max(1, fin(latMax, 1)), 0, 1.2);
  const lng = clamp(fin(c.axFrac, 0), 0, 1);
  const slide = clamp(fin(c.skidIntensity, 0), 0, 1);
  const raw = clamp(
    LOAD_IDLE + W_LAT * lat * lat + W_LONG * lng * lng + W_SLIDE * slide + (c.onKerb ? W_KERB : 0) + (c.offroad ? W_OFF : 0),
    LOAD_MIN,
    LOAD_MAX,
  );
  return raw / LOAD_REF;
}

export const FUEL_LOAD = 0.22;
export function fuelLoadMul(c: TyreCar, lapsTarget: number): number {
  return 1 + FUEL_LOAD * fuelFrac(c, lapsTarget);
}

const LOAD_AI_BASE = 0.92;
const LOAD_AI_STYLE = 0.45;
const LOAD_AI_LONG = 0.3;
const LOAD_AI_REF = 1.23;
function aiLong(c: TyreCar): number {
  return fin(c.corridorAccel, fin(c.accSm, 0));
}
export function aiLoad(c: TyreCar, aTop: number): number {
  const cons = clamp(fin(c.consistency, 0.75), 0, 1);
  const lng = clamp(fin(Math.abs(aiLong(c)) / Math.max(1, aTop), 0), 0, 1);
  return (
    clamp(LOAD_AI_BASE + LOAD_AI_STYLE * (1 - cons) + LOAD_AI_LONG * lng * lng + (c.offroad ? W_OFF : 0), LOAD_MIN, LOAD_MAX) /
    LOAD_AI_REF
  );
}

// ── GRIP (tyre-model.js:283-310) ────────────────────────────────────────────
export const DROP_LIN = 0.05;
export const DROP_CLIFF = 0.5;
export const GRIP_FLOOR = 0.55;
export const LONG_SHARE = 0.45;

export function gripFor(wear: number | undefined): number {
  const w = Math.max(0, wear || 0);
  return clamp(1 - DROP_LIN * Math.min(w, 1) - DROP_CLIFF * Math.max(0, w - 1), GRIP_FLOOR, 1);
}
export function longFor(wear: number | undefined): number {
  return 1 - (1 - gripFor(wear)) * LONG_SHARE;
}

// ── PER-AXLE (tyre-model.js:312-355) ────────────────────────────────────────
export const AXLE_LONG = 0.55;
export const AXLE_REST = 0.06;
const AXLE_BB = 1.8;
export const BB_REF = PhysicsConsts.BB_REF;

/** Signed longitudinal effort: -1 full braking .. +1 full traction. */
export function longSigned(c: TyreCar, aTop: number): number {
  if (c.human) return ((c.axEstSm || 0) < 0 ? -1 : 1) * clamp(fin(c.axFrac, 0), 0, 1);
  return clamp(fin(aiLong(c) / Math.max(1, aTop), 0), -1, 1);
}
/** [frontShare, rearShare] for this tick. Averages to exactly 1. */
export function axleShare(c: TyreCar, aTop: number): [number, number] {
  const d = axleTilt(c, aTop);
  return [1 + d, 1 - d];
}
function axleTilt(c: TyreCar, aTop: number): number {
  const lng = longSigned(c, aTop);
  const bb = c.brakeBias != null && isFinite(c.brakeBias) ? c.brakeBias : BB_REF;
  const bias = lng < 0 ? clamp(1 + AXLE_BB * (bb - BB_REF), 0.3, 1.7) : 1;
  return clamp(AXLE_REST - lng * AXLE_LONG * bias, -0.9, 0.9);
}
export interface AxleSplit {
  f: number;
  r: number;
}
const AXLE_EVEN: Readonly<AxleSplit> = Object.freeze({ f: 1, r: 1 });

// ── TEMPERATURE (tyre-model.js:357-486) ─────────────────────────────────────
type WeatherKey = "dry" | "overcast" | "fog" | "wet" | "rain";
export const T_AMBIENT: Readonly<Record<WeatherKey, number>> = { dry: 30, overcast: 22, fog: 18, wet: 16, rain: 13 };
export const T_BLANKET = 70;
export const T_OPT_MID = 105,
  T_OPT_SPAN = 35,
  T_WINDOW = 18;
export function optTemp(life: number | null | undefined): number {
  return T_OPT_MID + T_OPT_SPAN * ((life == null ? LIFE_MID : life) - LIFE_MID);
}

export const HEAT_K = 7.8,
  HEAT_ROLL = 1.0,
  HEAT_SLIP = 0.55;
const COOL_K = 0.06,
  COOL_V = 0.8;
void COOL_K; // declared and unused in f1-game too (tyre-model.js:404)
export const SINK_TRACK = 0.45;
export const T_TRACK_DELTA: Readonly<Record<WeatherKey, number>> = { dry: 18, overcast: 10, fog: 5, wet: 3, rain: 1 };
const EXCH = 0.02,
  COOL_B = 0.008;
export function warmRate(life: number | null | undefined): number {
  return clamp(1.35 - 0.4 * ((life == null ? LIFE_MID : life) / LIFE_MID), 0.7, 1.5);
}

const T_REF_LOAD = 1.1,
  T_REF_V = 0.95;
function sinkOf(amb: number, track: number | null | undefined): number {
  const tr = track != null && isFinite(track) ? track : amb;
  return (1 - SINK_TRACK) * amb + SINK_TRACK * tr;
}
export function coolFor(life: number | null | undefined): number {
  const refAmb = T_AMBIENT.dry;
  const refSink = sinkOf(refAmb, refAmb + T_TRACK_DELTA.dry);
  const rise = Math.max(20, optTemp(life) - refSink);
  return (HEAT_K * warmRate(life) * HEAT_ROLL * T_REF_LOAD * T_REF_V) / ((1 + COOL_V * T_REF_V) * rise);
}

export interface TempStepArgs {
  readonly load: number;
  readonly vFrac: number;
  readonly amb: number;
  readonly track?: number | null;
  readonly life?: number | null;
  readonly slide?: number;
  readonly dt: number;
}
/** One tick of the two-state thermal model. Returns [surface, bulk] in C. */
export function stepTemp(ts: number, tb: number, { load, vFrac, amb, track, life, slide, dt }: TempStepArgs): [number, number] {
  return tempInto([0, 0], ts, tb, load, vFrac, amb, track, life, slide, dt);
}
function tempInto(
  out: [number, number],
  ts: number,
  tb: number,
  load: number,
  vFrac: number,
  amb: number,
  track: number | null | undefined,
  life: number | null | undefined,
  slide: number | undefined,
  dt: number,
): [number, number] {
  const w = warmRate(life);
  const v = clamp(vFrac, 0, 1);
  const ld = Math.max(0, load);
  const sl = clamp(slide || 0, 0, 1);
  const heat = HEAT_K * w * (HEAT_ROLL * ld * v + HEAT_SLIP * sl * ld * v);
  const sink = sinkOf(amb, track);
  const cool = coolFor(life) * (1 + COOL_V * v) * (ts - sink);
  const ns = ts + (heat - cool - EXCH * (ts - tb)) * dt;
  const nb = tb + (EXCH * (ts - tb) - COOL_B * (tb - amb)) * dt;
  out[0] = Number.isFinite(ns) ? clamp(ns, -40, 400) : Number.isFinite(ts) ? ts : 0;
  out[1] = Number.isFinite(nb) ? clamp(nb, -40, 400) : Number.isFinite(tb) ? tb : 0;
  return out;
}

const COLD_PEN = 0.12,
  HOT_PEN = 0.12,
  TEMP_SPAN = 40;
export const TEMP_FLOOR = 0.8;
export function tempGrip(ts: number | null | undefined, life: number | null | undefined): number {
  if (ts == null) return 1;
  const opt = optTemp(life);
  const cold = Math.max(0, opt - T_WINDOW - ts) / TEMP_SPAN;
  const hot = Math.max(0, ts - (opt + T_WINDOW)) / TEMP_SPAN;
  return clamp(1 - COLD_PEN * cold * cold - HOT_PEN * hot * hot, TEMP_FLOOR, 1);
}

const GRAIN_RATE = 0.055,
  GRAIN_HEAL = 0.02;
export const GRAIN_GRIP = 0.05;
export const BLIST_OVER = 35;
const BLIST_RATE = 0.0012;
export const BLIST_GRIP = 0.14;
export function stepGrain(
  grain: number | undefined,
  { ts, life, slide, dt }: { readonly ts: number; readonly life?: number | null; readonly slide: number; readonly dt: number },
): number {
  return grainStep(grain, ts, life, slide, dt);
}
export function stepBlister(
  blister: number | undefined,
  { tb, life, dt }: { readonly tb: number; readonly life?: number | null; readonly dt: number },
): number {
  return blisterStep(blister, tb, life, dt);
}
function grainStep(grain: number | undefined, ts: number, life: number | null | undefined, slide: number, dt: number): number {
  const opt = optTemp(life);
  const cold = clamp((opt - T_WINDOW - ts) / TEMP_SPAN, 0, 1);
  const g = (grain || 0) + (cold > 0 ? GRAIN_RATE * cold * clamp(slide, 0, 1) : -GRAIN_HEAL) * dt;
  return clamp(g, 0, 1);
}
function blisterStep(blister: number | undefined, tb: number, life: number | null | undefined, dt: number): number {
  const over = tb - (optTemp(life) + T_WINDOW + BLIST_OVER);
  return clamp((blister || 0) + (over > 0 ? BLIST_RATE * over * dt : 0), 0, 1);
}
/** The two surface defects, as one grip multiplier. */
export function defectGrip(grain: number | undefined, blister: number | undefined): number {
  return clamp(1 - GRAIN_GRIP * clamp(grain || 0, 0, 1) - BLIST_GRIP * clamp(blister || 0, 0, 1), 0.6, 1);
}

// ── FUEL (tyre-model.js:488-517) ────────────────────────────────────────────
const FUEL_ACCEL = 0.06;
const FUEL_VMAX = 0.012;
const lapsDone = (lap: number | undefined): number => Math.max(0, (lap || 0) - 1);
export function fuelFrac(c: TyreCar, lapsTarget: number): number {
  const n = Math.max(1, lapsTarget || 1);
  return clamp(1 - lapsDone(c.fuelLap == null ? c.lap : c.fuelLap) / n, 0, 1);
}

// ── COMPOUND RECORDS (tyre-model.js:519-697) ────────────────────────────────
export type StatKey = "speed" | "accel" | "cornering" | "braking";
export interface TyreRecord {
  readonly id: string | null | undefined;
  readonly code: string;
  readonly life: number;
  readonly off: number;
  readonly tread: number;
  readonly colour: readonly number[];
  readonly mods: Readonly<Record<StatKey, number>> | null;
}
export interface TyreStint {
  readonly code: string;
  readonly id: string | null | undefined;
  readonly colour: readonly number[];
  readonly lap0: number;
  lap1: number | null;
}

export function codeForLife(life: number, tread: number): string {
  if (tread === 2) return "W";
  if (tread === 1) return "I";
  return life < 0.7 ? "S" : life < 0.95 ? "M" : "H";
}

interface AiClass {
  readonly code: string;
  readonly life: number;
  readonly off: number;
  readonly tread: number;
  readonly colour: readonly number[];
  readonly mods?: Readonly<Record<StatKey, number>>;
}
export const AI_CLASS: Readonly<Record<string, AiClass>> = {
  soft: { code: "S", life: 0.48, off: 0.004, tread: 0, colour: [0.92, 0.12, 0.1] },
  medium: { code: "M", life: 0.74, off: 0, tread: 0, colour: [0.96, 0.8, 0.1] },
  hard: { code: "H", life: 1.05, off: -0.004, tread: 0, colour: [0.9, 0.9, 0.93] },
  inter: {
    code: "I",
    life: 1.0,
    off: -0.01,
    tread: 1,
    colour: [0.1, 0.72, 0.24],
    mods: { speed: 0.92, accel: 0.93, cornering: 0.94, braking: 0.98 },
  },
  wet: {
    code: "W",
    life: 1.1,
    off: -0.02,
    tread: 2,
    colour: [0.1, 0.4, 0.92],
    mods: { speed: 0.88, accel: 0.9, cornering: 0.9, braking: 0.94 },
  },
};
export function classRecord(cls: string | null | undefined): TyreRecord {
  const t = (cls != null ? AI_CLASS[cls] : undefined) || (AI_CLASS["medium"] as AiClass);
  return { id: cls, code: t.code, life: t.life, off: t.off, tread: t.tread || 0, colour: t.colour, mods: t.mods || null };
}

export function asRain(w: string): string {
  return w === "storm" ? "rain" : w;
}
function wetValue(w: string): number {
  return w === "rain" || w === "storm" ? 1 : w === "wet" ? 0.5 : 0;
}
export function wetness(weather: string, arc: Pick<WeatherArc, "from" | "to" | "t" | "dur"> | null | undefined): number {
  if (!arc) return wetValue(weather);
  const f = clamp(arc.t / Math.max(1, arc.dur), 0, 1);
  return wetValue(arc.from) + (wetValue(arc.to) - wetValue(arc.from)) * f;
}
export function weatherGrip(tread: unknown, w: number): number {
  const table = PhysicsConsts.WET_GRIP,
    t = Number.isInteger(tread) && (tread as number) >= 0 && (tread as number) <= 2 ? (tread as 0 | 1 | 2) : 0;
  w = clamp(w, 0, 1);
  return w <= 0.5 ? 1 + (table.wet[t] - 1) * w * 2 : table.wet[t] + (table.rain[t] - table.wet[t]) * (w - 0.5) * 2;
}
export function treadFor(weather: string, wetness?: number): 0 | 1 | 2 {
  if (Number.isFinite(wetness)) return (wetness as number) >= 0.72 ? 2 : (wetness as number) >= 0.25 ? 1 : 0;
  return weather === "rain" || weather === "storm" ? 2 : weather === "wet" ? 1 : 0;
}
export function classForTread(tread: number): "wet" | "inter" | null {
  return tread === 2 ? "wet" : tread === 1 ? "inter" : null;
}

// ── AQUAPLANING (tyre-model.js:411-464) ─────────────────────────────────────
export const AQUA_WET = 0.72;
export const AQUA_ONSET: readonly [number, number, number] = Object.freeze([140 / 3.6, 215 / 3.6, 290 / 3.6]);
export const AQUA_RAMP = 70 / 3.6;
export const AQUA_LOSS = 0.5;
const AQUA_AI = 0.1;
function aquaDepth(wetness: number): number {
  return clamp((fin(wetness, 0) - AQUA_WET) / (1 - AQUA_WET), 0, 1);
}
function aquaTread(tread: unknown): 0 | 1 | 2 {
  return Number.isInteger(tread) && (tread as number) >= 0 && (tread as number) <= 2 ? (tread as 0 | 1 | 2) : 0;
}
/** Grip multiplier in (0, 1] for a tyre at `speedStd` (m/s, vStd scale) on a road at `wetness`. */
export function aquaplane(speedStd: number, wetness: number, tread: unknown): number {
  const d = aquaDepth(wetness);
  if (!(d > 0)) return 1;
  const r = clamp((Math.abs(fin(speedStd, 0)) - AQUA_ONSET[aquaTread(tread)]) / AQUA_RAMP, 0, 1);
  return 1 - AQUA_LOSS * d * r * r;
}
export function aquaplaneSafeV(wetness: number, tread: unknown): number {
  const full = AQUA_LOSS * aquaDepth(wetness);
  if (!(full > AQUA_AI)) return Infinity;
  return AQUA_ONSET[aquaTread(tread)] + AQUA_RAMP * Math.sqrt(AQUA_AI / full);
}
export interface AquaOut {
  mul: number;
  safeV: number;
}
const _aq: AquaOut = { mul: 1, safeV: Infinity };
/** POOLED: the next call overwrites the returned object (tyre-model.js:458-464). */
export function aquaInto(c: TyreCar | null | undefined, speedStd: number, weather: string, wetness: number): AquaOut {
  const tread = c && c.tread != null ? c.tread : treadFor(weather, wetness);
  _aq.mul = aquaplane(speedStd, wetness, tread);
  _aq.safeV = aquaplaneSafeV(wetness, tread);
  return _aq;
}

export function optionRecord(opt: TyreOption | null | undefined): TyreRecord {
  if (!opt) return classRecord("medium");
  const life = lifeOf(opt);
  const tread = opt.wetTread || 0;
  return {
    id: opt.id,
    code: codeForLife(life, tread),
    life,
    off: 0,
    tread,
    colour: (opt.visual && opt.visual.band) || [0.9, 0.9, 0.93],
    mods: {
      speed: opt.speed == null ? 1 : opt.speed,
      accel: opt.accel == null ? 1 : opt.accel,
      cornering: opt.cornering == null ? 1 : opt.cornering,
      braking: opt.braking == null ? 1 : opt.braking,
    },
  };
}

const STAT_KEYS: readonly StatKey[] = ["speed", "accel", "cornering", "braking"];
export function applyCompound(c: TyreCar | null | undefined, record: TyreRecord | null | undefined): TyreRecord | null {
  if (!c) return null;
  const tyre = (c.tyre = record || classRecord("medium"));
  if (c.tread !== null || (c.pitPlan && !c.human)) c.tread = tyre.tread || 0;
  if (c.tyreBaseMods) {
    const out = c.mods || (c.mods = {}),
      tm = tyre.mods || null;
    for (const k of STAT_KEYS) out[k] = c.tyreBaseMods[k] * (tm && tm[k] != null ? tm[k] : 1);
  }
  return tyre;
}

export function startRecord(c: TyreCar | null | undefined, tread: number): TyreRecord {
  if (c && c.pitPlan && !c.human) {
    const wet = tread > 0 ? classForTread(tread) : null;
    return classRecord(wet || c.pitPlan.start);
  }
  return c && c.tyreOpt ? optionRecord(c.tyreOpt) : classRecord(c && c.tyreClass);
}

// ── BRAKE STABILITY (tyre-model.js:845-857) ─────────────────────────────────
/** The pedal's rear share, eased as the rear nears its cornering limit (last step's rearUtil). */
export function brakeBeta(prev: number | null | undefined, rearUtil: number | undefined, dt: number): number {
  const K = PhysicsConsts;
  const target = 1 - K.BRAKE_STAB * clamp(((rearUtil || 0) - K.BRAKE_STAB_LO) / (K.BRAKE_STAB_HI - K.BRAKE_STAB_LO), 0, 1);
  return prev == null ? target : lerp(prev, target, 1 - Math.exp(-12 * dt));
}
export function brakeFront(beta: number, loadF: number, loadR: number): number {
  return 1 + PhysicsConsts.BRAKE_STAB_SHIFT * (1 / (loadF + beta * loadR) - 1);
}

export const SEVERITY_DEFAULT = 1.0;

// ── SESSION (tyre-model.js:523-843) ─────────────────────────────────────────

/**
 * The live façade values a TyreModel instance reads, at call time (f1-game reads
 * them off `G` on every call; a getter-backed object here keeps that). A subset
 * of `SimCtx`; `track.length` is f1-game's `track.total`.
 */
export interface TyreCtx {
  readonly raceTyreWear: TyreWearLevel;
  readonly track: { readonly length: number; readonly def?: { readonly tyreSeverity?: number } | null } | null;
  readonly weatherArc: Pick<WeatherArc, "from" | "to" | "t" | "dur" | "cell"> | null;
  readonly raceWeather: string;
  readonly lapsTarget: number;
  readonly session: string;
  readonly LAT_MAX: number;
  readonly aTop: () => number;
  readonly vTop: () => number;
}

export interface StintRow {
  readonly code: string;
  readonly id: string | null | undefined;
  readonly colour: readonly number[];
  readonly lap0: number;
  readonly lap1: number;
  readonly laps: number;
}

export interface TyreInfo {
  readonly level: TyreWearLevel;
  readonly on: boolean;
  readonly compound: string | null | undefined;
  readonly code: string | null;
  readonly life: number | null;
  readonly lifeLaps: number | null;
  readonly wear: number;
  readonly wearF: number | null;
  readonly wearR: number | null;
  readonly lapsOn: number;
  readonly stints: number;
  readonly load: number;
  readonly severity: number;
  readonly tempS: number | null;
  readonly tempB: number | null;
  readonly tempOpt: number | null;
  readonly tempWindow: number;
  readonly ambient: number;
  readonly trackTemp: number;
  readonly grain: number;
  readonly blister: number;
  readonly tempGrip: number;
  readonly defectGrip: number;
  readonly grip: number;
  readonly traction: number;
  readonly axleF: number;
  readonly axleR: number;
  readonly fuel: number;
}

export interface Tyres {
  fit(c: TyreCar | null | undefined, record: TyreRecord): void;
  update(c: TyreCar | null | undefined, dt: number): void;
  gripMul(c: TyreCar | null | undefined): number;
  tractionMul(c: TyreCar | null | undefined): number;
  /** POOLED: one scratch per instance, read .f/.r before the next call. */
  axleSplit(c: TyreCar | null | undefined): Readonly<AxleSplit>;
  fuelAccelMul(c: TyreCar | null | undefined): number;
  fuelVmaxMul(c: TyreCar | null | undefined): number;
  stints(c: TyreCar | null | undefined): StintRow[];
  closeStints(c: TyreCar | null | undefined): void;
  lapsOn(c: TyreCar | null | undefined): number;
  spent(c: TyreCar | null | undefined): number;
  lapsLeft(c: TyreCar | null | undefined): number | null;
  belowWindow(c: TyreCar | null | undefined): number;
  info(c: TyreCar | null | undefined): TyreInfo | null;
  severity(): number;
  ambient(): number;
  trackTemp(): number;
  level(): TyreWearLevel;
  setLevel(v: unknown): TyreWearLevel;
  on(): boolean;
  planLaps(life: number, lapsTarget: number): number;
  classRecord: typeof classRecord;
  optionRecord: typeof optionRecord;
  applyCompound: typeof applyCompound;
  startRecord: typeof startRecord;
}

export function create(G: TyreCtx): Tyres {
  const _tT: [number, number] = [0, 0],
    _axOut: AxleSplit = { f: 1, r: 1 };
  let level: TyreWearLevel = G && isLevel(G.raceTyreWear) ? G.raceTyreWear : "off";

  function on(): boolean {
    return LEVELS[level] > 0;
  }
  function setLevel(v: unknown): TyreWearLevel {
    if (isLevel(v)) level = v;
    return level;
  }
  function effLifeLaps(life: number, lapsTarget: number): number {
    return effLifeLapsAt(life, lapsTarget, severity());
  }
  function effLifeLapsAt(life: number, lapsTarget: number, sev: number): number {
    return Math.max(MIN_LIFE_LAPS, ((life || LIFE_MID) * Math.max(1, lapsTarget || 1)) / sev);
  }
  function planLaps(life: number, lapsTarget: number): number {
    const k = LEVELS[level];
    return k > 0 ? effLifeLaps(life, lapsTarget) / k : Math.max(1, lapsTarget || 1);
  }

  function fit(c: TyreCar | null | undefined, record: TyreRecord): void {
    if (!c) return;
    const tyre = applyCompound(c, record) as TyreRecord;
    c.tyreWear = 0;
    c.tyreWearF = 0;
    c.tyreWearR = 0;
    c.tyreTs = T_BLANKET;
    c.tyreTb = T_BLANKET;
    if (quali()) {
      c.tyreTs = optTemp(tyre.life);
      c.tyreTb = c.tyreTs;
    }
    c.tyreGrain = 0;
    c.tyreBlister = 0;
    c.flatSpot = 0;
    c.tyreLap0 = c.lap || 0;
    const physical = physicalLaps(c);
    c.tyrePhysicalOffset = physical == null ? null : physical - lapsDone(c.tyreLap0);
    const len = G.track && G.track.length,
      at = physical == null ? c.s : (c.prog as number) - (c._progGift || 0);
    c.tyreLapAdj =
      (c.lap || 0) >= 1 && (len as number) > 0 && (physical == null ? at || 0 : (at as number) - physical * (len as number)) > (len as number) * 0.5
        ? 1
        : 0;
    c.tyreStints = (c.tyreStints || 0) + 1;
    const log = c.tyreLog || (c.tyreLog = []);
    const last = log[log.length - 1];
    if (last && last.lap1 == null) last.lap1 = c.lap || 0;
    log.push({ code: tyre.code, id: tyre.id, colour: tyre.colour, lap0: c.lap || 0, lap1: null });
  }
  function closeStints(c: TyreCar | null | undefined): void {
    const log = c && c.tyreLog;
    if (!log || !log.length) return;
    const last = log[log.length - 1] as TyreStint;
    if (last.lap1 == null) last.lap1 = (c as TyreCar).lap || 0;
  }
  function stints(c: TyreCar | null | undefined): StintRow[] {
    if (!c || !c.tyreLog) return [];
    const end = lapsDone(c.lap);
    return c.tyreLog.map(function (e) {
      const lap0 = lapsDone(e.lap0);
      const lap1 = e.lap1 == null ? end : lapsDone(e.lap1);
      return { code: e.code, id: e.id, colour: e.colour, lap0, lap1, laps: Math.max(0, lap1 - lap0) };
    });
  }

  function tAmb(w: string): number {
    const t = (T_AMBIENT as Record<string, number | undefined>)[asRain(w)];
    return t == null ? T_AMBIENT.dry : t;
  }
  function tTrackDelta(w: string): number {
    const d = (T_TRACK_DELTA as Record<string, number | undefined>)[asRain(w)];
    return d == null ? T_TRACK_DELTA.dry : d;
  }
  function ambient(): number {
    return ambientAt(G.weatherArc, G.raceWeather);
  }
  const TAU_DRY = 36;
  function arcFrac(arc: NonNullable<TyreCtx["weatherArc"]>): number {
    if (arc.cell && arc.t >= arc.cell.life) return Math.exp(-(arc.t - arc.cell.life) / TAU_DRY);
    return clamp(arc.t / arc.dur, 0, 1);
  }
  function ambientAt(arc: TyreCtx["weatherArc"], weather: string): number {
    if (arc && arc.dur > 0 && arc.from && arc.to) {
      const f = arcFrac(arc);
      return tAmb(arc.from) + (tAmb(arc.to) - tAmb(arc.from)) * f;
    }
    return tAmb(weather);
  }
  function trackTemp(): number {
    const arc = G.weatherArc,
      weather = G.raceWeather;
    return trackTempAt(arc, weather, ambientAt(arc, weather));
  }
  function trackTempAt(arc: TyreCtx["weatherArc"], weather: string, a: number): number {
    if (arc && arc.dur > 0 && arc.from && arc.to) {
      const f = arcFrac(arc);
      const d = tTrackDelta(arc.from) + (tTrackDelta(arc.to) - tTrackDelta(arc.from)) * f;
      return a + d;
    }
    return a + tTrackDelta(weather);
  }

  function severity(): number {
    return severityAt(G.track);
  }
  function severityAt(track: TyreCtx["track"]): number {
    const def = track && track.def;
    const v = def && def.tyreSeverity;
    return v != null && isFinite(v) ? clamp(+v, 0.4, 2.0) : SEVERITY_DEFAULT;
  }

  const W_SLIP_SPD = 0.35;

  function update(c: TyreCar | null | undefined, dt: number): void {
    if (!on() || !c || c.retired || c.finished) return;
    const track = G.track;
    if (!track || !(track.length > 0) || !(dt > 0)) return;
    if (!c.tyre) fit(c, classRecord("medium"));
    const tyre = c.tyre as TyreRecord;
    const aTop = G.aTop(),
      arc = G.weatherArc,
      weather = G.raceWeather;
    const load = (c.human ? humanLoad(c, G.LAT_MAX) : aiLoad(c, aTop)) * (1 + FUEL_LOAD * fuelOf(c));
    c._tyreLoad = load;
    const amb = ambientAt(arc, weather);
    const trk = trackTempAt(arc, weather, amb);
    if (c.tyreTs == null) {
      c.tyreTs = amb;
      c.tyreTb = amb;
    }
    const vFrac = fin(Math.abs(fin(c.speed, 0)) / Math.max(1, G.vTop()), 0);
    const slide = c.human ? c.skidIntensity || 0 : 0;
    const t = tempInto(_tT, c.tyreTs, c.tyreTb as number, load, vFrac, amb, trk, tyre.life, slide, dt);
    c.tyreTs = t[0];
    c.tyreTb = t[1];
    c.tyreGrain = grainStep(c.tyreGrain, c.tyreTs, tyre.life, slide, dt);
    c.tyreBlister = blisterStep(c.tyreBlister, c.tyreTb, tyre.life, dt);
    const lapFrac = (Math.abs(fin(c.speed, 0)) * dt) / track.length;
    if (!(lapFrac > 0)) return;
    const slipMul = 1 + W_SLIP_SPD * clamp(slide, 0, 1);
    const dw = (lapFrac * load * slipMul * LEVELS[level]) / effLifeLapsAt(tyre.life, G.lapsTarget, severityAt(track));
    if (!Number.isFinite(dw)) return;
    c.tyreWear = (c.tyreWear || 0) + dw;
    const d0 = axleTilt(c, aTop);
    const d = Number.isFinite(d0) ? d0 : 0;
    c.tyreWearF = (c.tyreWearF || 0) + dw * (1 + d);
    c.tyreWearR = (c.tyreWearR || 0) + dw * (1 - d);
  }

  function gripMul(c: TyreCar | null | undefined): number {
    if (!on() || !c) return 1;
    const life = c.tyre ? c.tyre.life : null;
    return gripFor(c.tyreWear) * tempGrip(c.tyreTs, life) * defectGrip(c.tyreGrain, c.tyreBlister);
  }
  function tractionMul(c: TyreCar | null | undefined): number {
    if (!on() || !c) return 1;
    return 1 - (1 - gripMul(c)) * LONG_SHARE;
  }
  function axleSplit(c: TyreCar | null | undefined): Readonly<AxleSplit> {
    if (!on() || !c || c.tyreWearF == null) return AXLE_EVEN;
    const base = gripFor(c.tyreWear);
    _axOut.f = gripFor(c.tyreWearF) / base;
    _axOut.r = gripFor(c.tyreWearR) / base;
    return _axOut;
  }
  function quali(): boolean {
    return G.session === "quali";
  }
  function fuelOf(c: TyreCar): number {
    return quali() ? 0 : fuelFrac(c, G.lapsTarget);
  }
  function fuelAccelMul(c: TyreCar | null | undefined): number {
    return on() && c ? 1 / (1 + FUEL_ACCEL * fuelOf(c)) : 1;
  }
  function fuelVmaxMul(c: TyreCar | null | undefined): number {
    return on() && c ? 1 / (1 + FUEL_VMAX * fuelOf(c)) : 1;
  }

  function physicalLaps(c: TyreCar | null | undefined): number | null {
    const length = G.track && G.track.length;
    return c && Number.isFinite(c.prog) && (length as number) > 0
      ? Math.floor(Math.max(0, (c.prog as number) - (c._progGift || 0)) / (length as number))
      : null;
  }
  function lapsOn(c: TyreCar | null | undefined): number {
    if (!c || !c.tyre) return 0;
    const physical = physicalLaps(c);
    return Math.max(
      0,
      physical != null && c.tyrePhysicalOffset != null
        ? physical - c.tyrePhysicalOffset - lapsDone(c.tyreLap0) - (c.tyreLapAdj || 0)
        : lapsDone(c.lap) - lapsDone(c.tyreLap0) - (c.tyreLapAdj || 0),
    );
  }
  function spent(c: TyreCar | null | undefined): number {
    return c ? clamp(c.tyreWear || 0, 0, 2) : 0;
  }
  function lapsLeft(c: TyreCar | null | undefined): number | null {
    if (!on() || !c || !c.tyre) return null;
    const w = spent(c),
      n = lapsOn(c);
    const life = n >= 1 && w > 0.02 ? n / w : planLaps(c.tyre.life, G.lapsTarget);
    return Math.max(0, life * (1 - Math.min(1, w)));
  }
  function belowWindow(c: TyreCar | null | undefined): number {
    if (!c || !c.tyre || c.tyreTs == null) return 0;
    const tempS = +c.tyreTs.toFixed(1),
      tempOpt = +optTemp(c.tyre.life).toFixed(1);
    return Math.max(0, tempOpt - T_WINDOW - tempS);
  }

  function info(c: TyreCar | null | undefined): TyreInfo | null {
    if (!c) return null;
    const t = c.tyre || null;
    return {
      level,
      on: on(),
      compound: t ? t.id : null,
      code: t ? t.code : null,
      life: t ? t.life : null,
      lifeLaps: t ? +lifeLaps(t.life, G.lapsTarget).toFixed(2) : null,
      wear: +spent(c).toFixed(4),
      wearF: c.tyreWearF != null ? +c.tyreWearF.toFixed(4) : null,
      wearR: c.tyreWearR != null ? +c.tyreWearR.toFixed(4) : null,
      lapsOn: lapsOn(c),
      stints: c.tyreStints || 0,
      load: +(c._tyreLoad || 0).toFixed(3),
      severity: +severity().toFixed(3),
      tempS: c.tyreTs != null ? +c.tyreTs.toFixed(1) : null,
      tempB: c.tyreTb != null ? +c.tyreTb.toFixed(1) : null,
      tempOpt: t ? +optTemp(t.life).toFixed(1) : null,
      tempWindow: T_WINDOW,
      ambient: ambient(),
      trackTemp: +trackTemp().toFixed(1),
      grain: +(c.tyreGrain || 0).toFixed(4),
      blister: +(c.tyreBlister || 0).toFixed(4),
      tempGrip: +tempGrip(c.tyreTs, t ? t.life : null).toFixed(4),
      defectGrip: +defectGrip(c.tyreGrain, c.tyreBlister).toFixed(4),
      grip: +gripMul(c).toFixed(4),
      traction: +tractionMul(c).toFixed(4),
      axleF: +axleSplit(c).f.toFixed(4),
      axleR: +axleSplit(c).r.toFixed(4),
      fuel: +fuelOf(c).toFixed(3),
    };
  }

  return {
    fit,
    update,
    gripMul,
    tractionMul,
    axleSplit,
    fuelAccelMul,
    fuelVmaxMul,
    stints,
    closeStints,
    lapsOn,
    spent,
    lapsLeft,
    belowWindow,
    info,
    severity,
    ambient,
    trackTemp,
    level: () => level,
    setLevel,
    on,
    planLaps,
    classRecord,
    optionRecord,
    applyCompound,
    startRecord,
  };
}
