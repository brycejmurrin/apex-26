/**
 * Telemetry channels, lane identities and GPS/distance interpolation.
 * Ported verbatim from f1-game js/data/telemetry-model.js:1-304
 * (DataTelemetryModel). Float math keeps f1-game's operation order; the
 * cumulative series stay plain number[] as f1-game builds them.
 *
 *   cumDist / interp / distAtT / timeAtDist   telemetry-model.js:7-42
 *   brakingDuel                               telemetry-model.js:44-90
 *   lerpLoc / dateAtT / tAtDate / locAt       telemetry-model.js:92-169
 *   quantile / dropStrays / locBounds         telemetry-model.js:171-200
 *   gapLimitMs / isGap                        telemetry-model.js:201-217
 *   laneRole .. drsOpen                       telemetry-model.js:219-264
 *   CHANNELS, chartX, chanRaw, chanNorm       telemetry-model.js:266-287
 *   sampleAt                                  telemetry-model.js:288-297
 *   create (driverColor, laneColors)          telemetry-model.js:280-298
 *
 * The TelView / TelLane types below are the shape telemetry-view.js:98-116
 * builds and telemetry.js:238-239 fetches; f1-game leaves them implicit.
 */
import type { CarSample, Lap, LocationSample, PitStop, Session, SessionDriver, Stint } from "../../api";
import type { Rgb } from "../../teams";
import { driverColor as tabDriverColor, type ColoredDriver } from "../../tab-utils";
import { clamp } from "../../util";

export { clamp };   // M4.clamp (js/core/mat4.js:5), re-exported as DataTelemetryModel.clamp was

/* ---------- types ---------- */

/** Cumulative distance against lap time (cumDist). */
export interface Cum { t: number[]; d: number[] }

/** The fields cumDist reads. f1-game's tests feed bare {t, speed} samples. */
export interface SpeedSample { t: number; speed?: number | null | undefined }
/** The fields brakingDuel reads. */
export interface DuelSample extends SpeedSample { brake?: number | null | undefined; throttle?: number | null | undefined }
/** The fields dateAtT / tAtDate / locAt read. */
export interface DatedSample extends SpeedSample { date: number }

/** A lane as fetchDriverTel builds it (telemetry.js:202-241) plus what the view adds. */
export interface TelLane {
  d: SessionDriver;
  lap: Lap | null;
  car?: CarSample[];
  loc?: LocationSample[];
  stints?: Stint[];
  pits?: PitStop[];
  sessionLabel?: string;
  sessionName?: string;
  cum?: Cum;
}
/** A lane that carries car telemetry; the view gives it .cum (telemetry-view.js:134). */
export type CarLane = TelLane & { car: CarSample[]; cum: Cum };

export interface MapTransform {
  minx: number; miny: number; sc: number; ox: number; oy: number;
  W: number; H: number; spanx: number; spany: number;
}

/** Gauge cells built by player.buildGauges (telemetry-player.js:121-191). */
export interface Gauges {
  speed: HTMLElement[]; gear: HTMLElement[];
  thr: HTMLElement[]; brk: HTMLElement[]; rpm: HTMLElement[]; drs: HTMLElement[];
  delta?: HTMLElement;
  board?: { spd: HTMLElement; dl: HTMLElement; ref: boolean }[];
}

/** The live telemetry view (telemetry-view.js:98-122). */
export interface TelView {
  laps: CarLane[];
  laneCols: Rgb[];
  primary: CarLane;
  compare: CarLane | null;
  multi: boolean;
  visible: Record<string, boolean>;
  visibleC: Record<string, boolean>;
  cursorT: number | null;
  tMax: number; speedMax: number; rpmMax: number;
  playing: boolean; rate: number; _raf: number; _last: number; onboard: boolean;
  chart: HTMLCanvasElement | null; map: HTMLCanvasElement | null; delta: HTMLCanvasElement | null;
  chartBase: HTMLCanvasElement | null; mapBase: HTMLCanvasElement | null; deltaBase: HTMLCanvasElement | null;
  mapT: MapTransform | null;
  sectors: number[] | null;
  g: Gauges | null;
  playBtn: HTMLButtonElement | null;
  a11ySummary: HTMLElement | null;
  updateSummary: (() => void) | null;
  colP: Rgb | undefined; colC: Rgb | null;
  _dup: Record<string, number>;
  ratio: number;
  cw: number; ch: number; dw: number; dh: number; mw: number; mh: number;
  _ro?: ResizeObserver | null;
}

/** What locAt reads of the view: the primary lane's path and the shared clock. */
export interface LocView { primary: { loc?: readonly LocationSample[] | null | undefined }; tMax?: number }
/** What locAt reads of a lane (it caches .cum on it, as f1-game does). */
export interface LocLane { loc?: readonly LocationSample[] | null | undefined; car?: readonly DatedSample[] | null | undefined; cum?: Cum | undefined }
/** What brakingDuel reads of a lane. */
export interface DuelLane { car?: readonly DuelSample[] | null | undefined; cum?: Cum | undefined }

/* ---------- distance ---------- */

export function cumDist(car: readonly SpeedSample[]): Cum {
  const t: number[] = [], d: number[] = [];
  let acc = 0;
  for (let i = 0; i < car.length; i++) {
    const ci = car[i] as SpeedSample;
    if (i > 0) {
      const prev = car[i - 1] as SpeedSample;
      const dt = ci.t - prev.t;
      // An absent speed is unknown travel, never a stationary interval.
      const speed = ci.speed;
      const previous = prev.speed;
      const valid = typeof speed === "number" && isFinite(speed) &&
        typeof previous === "number" && isFinite(previous);
      acc = valid ? acc + speed / 3.6 * dt : NaN;
    }
    t.push(ci.t); d.push(acc);
  }
  return { t: t, d: d };
}
function interp(xs: readonly number[], ys: readonly number[], x: number): number {
  if (!xs.length || !isFinite(x)) return NaN;
  if (x <= (xs[0] as number)) return ys[0] as number;
  if (x >= (xs[xs.length - 1] as number)) return ys[ys.length - 1] as number;
  let lo = 0, hi = xs.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if ((xs[m] as number) < x) lo = m + 1; else hi = m; }
  if (xs[lo] === x) return ys[lo] as number;
  const x0 = xs[lo - 1] as number, x1 = xs[lo] as number, f = (x - x0) / ((x1 - x0) || 1);
  return (ys[lo - 1] as number) + ((ys[lo] as number) - (ys[lo - 1] as number)) * f;
}
export function distAtT(cum: Cum, t: number): number { return interp(cum.t, cum.d, t); }
export function timeAtDist(cum: Cum, dist: number): number {
  // Only the prefix before the first unknown interval can be inverted.
  const end = cum.d.findIndex(function (d) { return !isFinite(d); });
  if (end !== -1) {
    if (!end || dist > (cum.d[end - 1] as number)) return NaN;
    return interp(cum.d.slice(0, end), cum.t.slice(0, end), dist);
  }
  return interp(cum.d, cum.t, dist);
}

/* ---------- braking duel ---------- */

export interface DuelPoint { distance: number; t: number }
export interface DuelLaneResult {
  brake: DuelPoint | null;
  minSpeed: (DuelPoint & { value: number }) | null;
  throttle: DuelPoint | null;
  start: number; end: number;
}
export type DuelResult =
  | { available: false; reason: string }
  | { available: true; lanes: [DuelLaneResult, DuelLaneResult]; deltaBefore: number; deltaAfter: number; change: number };

// Bounded 128-step distance grid. Brake arms at <=10%, fires at >=20%;
// throttle arms at <=70%, recovers at >=90% after braking. Both require two
// consecutive distinct feed samples on that grid. Missing channels or a >1.5s feed gap invalidate
// the interval; absent threshold crossings remain unavailable markers.
export function brakingDuel(primary: DuelLane | null | undefined, compare: DuelLane | null | undefined, from: number, to: number): DuelResult {
  const unavailable = (reason: string): DuelResult => ({ available: false, reason });
  if (!isFinite(from) || !isFinite(to) || from < 0 || to <= from || !primary || !compare) return unavailable("Choose two lanes and a valid distance interval.");
  const lanes: DuelLaneResult[] = [];
  for (const lane of [primary, compare]) {
    const car = lane.car || [], cum = lane.cum || cumDist(car);
    if (car.length < 2 || (cum.d[0] as number) > from || (cum.d[cum.d.length - 1] as number) < to) return unavailable("Both lanes must cover the whole interval.");
    const start = timeAtDist(cum, from), end = timeAtDist(cum, to);
    for (let i = 0; i < car.length; i++) {
      const c = car[i] as DuelSample;
      if (i && (!(c.t > (car[i - 1] as DuelSample).t) || !((cum.d[i] as number) > (cum.d[i - 1] as number)))) return unavailable("Distance must increase through both lanes.");
      if (c.t >= start && c.t <= end && [c.speed, c.brake, c.throttle].some((v) => typeof v !== "number" || !isFinite(v))) return unavailable("Unavailable: missing telemetry channels.");
      if (i && (car[i - 1] as DuelSample).t <= end && c.t >= start && c.t - (car[i - 1] as DuelSample).t > 1.5) return unavailable("Unavailable: telemetry gap inside the interval.");
    }
    let brakeArmed = false, throttleArmed = false, brakeHits = 0, throttleHits = 0, previousSample: DuelSample | null = null;
    let brakeCandidate: DuelPoint | null = null, throttleCandidate: DuelPoint | null = null;
    let brake: DuelPoint | null = null, throttle: DuelPoint | null = null, minSpeed: (DuelPoint & { value: number }) | null = null;
    for (let i = 0; i <= 128; i++) {
      const distance = from + (to - from) * i / 128, t = timeAtDist(cum, distance), c = sampleAt(car, t) as DuelSample;
      if ([c.speed, c.brake, c.throttle].some((v) => typeof v !== "number" || !isFinite(v))) return unavailable("Unavailable: missing telemetry channels.");
      // The check above proved all three finite numbers.
      const speed = c.speed as number, brakeV = c.brake as number, throttleV = c.throttle as number;
      if (!minSpeed || speed < minSpeed.value) minSpeed = { distance, t, value: speed };
      if (c === previousSample) continue;
      previousSample = c;
      if (brakeV <= 10) brakeArmed = true;
      brakeHits = brakeArmed && brakeV >= 20 ? brakeHits + 1 : 0;
      if (brakeHits === 1) brakeCandidate = { distance, t };
      if (!brake && brakeHits >= 2) brake = brakeCandidate;
      if (brake && throttleV <= 70) throttleArmed = true;
      throttleHits = throttleArmed && throttleV >= 90 ? throttleHits + 1 : 0;
      if (throttleHits === 1) throttleCandidate = { distance, t };
      if (!throttle && throttleHits >= 2) throttle = throttleCandidate;
    }
    lanes.push({ brake, minSpeed, throttle, start, end });
  }
  const l0 = lanes[0] as DuelLaneResult, l1 = lanes[1] as DuelLaneResult;
  return { available: true, lanes: [l0, l1], deltaBefore: l1.start - l0.start,
    deltaAfter: l1.end - l0.end, change: (l1.end - l0.end) - (l1.start - l0.start) };
}

/* ---------- GPS position ---------- */

export interface XY { x: number; y: number }
function lerpLoc(a: XY, b: XY | undefined, f: number): XY {
  if (!b) return a;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}
export function dateAtT(car: readonly DatedSample[] | null | undefined, t: number): number | null {
  if (!car || !car.length) return null;
  const n = car.length;
  const first = car[0] as DatedSample, last = car[n - 1] as DatedSample;
  if (t <= first.t) return +first.date;
  if (t >= last.t) return +last.date;
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if ((car[mid] as DatedSample).t <= t) lo = mid; else hi = mid;
  }
  const a = car[lo] as DatedSample, b = car[hi] as DatedSample;
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  return +a.date + f * (+b.date - +a.date);
}
// inverse of dateAtT: lap-time for a wall-clock date
export function tAtDate(car: readonly DatedSample[] | null | undefined, date: number): number {
  if (!car || !car.length) return 0;
  const n = car.length;
  const first = car[0] as DatedSample, last = car[n - 1] as DatedSample;
  if (date <= +first.date) return first.t;
  if (date >= +last.date) return last.t;
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (+(car[mid] as DatedSample).date <= date) lo = mid; else hi = mid;
  }
  const a = car[lo] as DatedSample, b = car[hi] as DatedSample;
  const span = +b.date - +a.date;
  const f = span > 0 ? (date - +a.date) / span : 0;
  return a.t + f * (b.t - a.t);
}

export function locAt(view: LocView, tel: LocLane, t: number): XY | null {
  const own = !!(tel.loc && tel.loc.length);
  const loc: readonly LocationSample[] = own ? (tel.loc as readonly LocationSample[]) : (view.primary.loc || []);
  if (!loc.length) return null;
  if (!own) {
    const ownMax = (tel.car && tel.car.length) ? (tel.car[tel.car.length - 1] as DatedSample).t : 0;
    const f = clamp(t / (ownMax || view.tMax || 1), 0, 1) * (loc.length - 1);
    const i = Math.floor(f);
    return lerpLoc(loc[i] as XY, loc[i + 1], f - i);
  }
  const target = dateAtT(tel.car, t);
  if (target === null) return loc[0] as XY;
  const n = loc.length;
  if (target <= +(loc[0] as LocationSample).date) return loc[0] as XY;
  if (target >= +(loc[n - 1] as LocationSample).date) return loc[n - 1] as XY;
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (+(loc[mid] as LocationSample).date <= target) lo = mid; else hi = mid;
  }
  const A = loc[lo] as LocationSample, B = loc[hi] as LocationSample;
  const span = +B.date - +A.date;
  let f = span > 0 ? (target - +A.date) / span : 0;
  // WHERE BETWEEN THE TWO FIXES? The fixes themselves are ground truth — the
  // car really was there, at those instants — so the dot stays anchored to
  // them and never drifts. What is NOT true is that it crossed the ~20m gap at
  // a constant rate: braking from 300 into a hairpin it covers most of that
  // gap in the first third of the interval. So take the fraction from the
  // car's own DISTANCE TRAVELLED (its speed trace integrated, the same series
  // the delta chart runs on) rather than from elapsed time.
  // Every lane already carries .cum (buildTelemetryView computes it for the
  // delta chart); the fallback only covers a lane locAt sees first.
  const cum = tel.cum || (tel.cum = cumDist(tel.car || []));
  if (cum.t.length > 1) {
    const dA = distAtT(cum, tAtDate(tel.car, +A.date));
    const dB = distAtT(cum, tAtDate(tel.car, +B.date));
    if (dB > dA) f = clamp((distAtT(cum, t) - dA) / (dB - dA), 0, 1);
  }
  return lerpLoc(A, B, f);
}

/* ---------- GPS trace sanity ---------- */

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] as number : (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo);
}
const STRAY_MARGIN = 0.35;
export function dropStrays<P extends XY>(loc: P[] | null | undefined): P[] {
  if (!loc || loc.length < 24) return loc || [];   // too few to judge a distribution
  const xs = loc.map(function (p) { return p.x; }).sort(function (a, b) { return a - b; });
  const ys = loc.map(function (p) { return p.y; }).sort(function (a, b) { return a - b; });
  const x0 = quantile(xs, 0.02), x1 = quantile(xs, 0.98);
  const y0 = quantile(ys, 0.02), y1 = quantile(ys, 0.98);
  const mx = ((x1 - x0) || 1) * STRAY_MARGIN, my = ((y1 - y0) || 1) * STRAY_MARGIN;
  const kept = loc.filter(function (p) {
    return p.x >= x0 - mx && p.x <= x1 + mx && p.y >= y0 - my && p.y <= y1 + my;
  });
  return kept.length >= loc.length * 0.9 ? kept : loc;
}
export interface LocBounds { minx: number; miny: number; spanx: number; spany: number }
export function locBounds(loc: readonly XY[] | null | undefined): LocBounds {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let i = 0; i < (loc ? loc.length : 0); i++) {
    const p = (loc as readonly XY[])[i] as XY;
    if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
  }
  if (!isFinite(minx)) { minx = 0; maxx = 1; miny = 0; maxy = 1; }
  return { minx: minx, miny: miny, spanx: (maxx - minx) || 1, spany: (maxy - miny) || 1 };
}
export function gapLimitMs(loc: readonly { date: number }[] | null | undefined): number {
  if (!loc || loc.length < 8) return Infinity;
  const dts: number[] = [];
  for (let i = 1; i < loc.length; i++) {
    const dt = (loc[i] as { date: number }).date - (loc[i - 1] as { date: number }).date;
    if (isFinite(dt) && dt > 0) dts.push(dt);
  }
  if (dts.length < 4) return Infinity;
  dts.sort(function (a, b) { return a - b; });
  return Math.max(quantile(dts, 0.5) * 8, 1500);   // 8x the median cadence, min 1.5 s
}
export function isGap(loc: readonly { date: number }[], i: number, limit: number): boolean {
  if (!isFinite(limit)) return false;
  const dt = (loc[i] as { date: number }).date - (loc[i - 1] as { date: number }).date;
  return isFinite(dt) && dt > limit;
}

/* ---------- labels ---------- */

// Four lanes remain selectable for a useful field overview. Only the first
// two receive full channel traces; lanes three and four are intentionally
// speed-marker comparisons on the primary chart (and remain visible in the
// map/gauge lane board). Naming that distinction in the DOM keeps the picker
// affordance honest without discarding the extra-driver comparison.
export function laneRole(i: number): string {
  return i === 0 ? "PRIMARY TRACE" : i === 1 ? "COMPARISON TRACE" : "SPEED MARKER";
}

export function summaryTime(t: unknown): string {
  if (typeof t !== "number" || !isFinite(t) || t < 0) return "—";
  const cs = Math.round(t * 100), m = Math.floor(cs / 6000), s = (cs - m * 6000) / 100;   // round first: never "1:60.00"
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
}

// A signed delta, "+0.12" / "-0.12": the sign comes from the ROUNDED value,
// so a delta of -0.0003 reads "+0.00", never "-0.00".
export function signed(v: number, digits: number): string {
  const r = +v.toFixed(digits);
  return (r >= 0 ? "+" : "") + r.toFixed(digits);
}

export function summaryValue(v: unknown, suffix: string): string {
  return (typeof v === "number" && isFinite(v)) ? String(Math.round(v)) + suffix : "—";
}

export function dcode(d: { code?: string | null; num?: number | string | null }): string { return d.code || ("#" + d.num); }
export function sessionShort(meta: Pick<Session, "name" | "type"> | null | undefined): string {
  if (!meta) return "";
  const name = String(meta.name || meta.type || "");
  const type = (name + " " + String(meta.type || "")).toLowerCase();
  if (type.indexOf("sprint") !== -1) return type.indexOf("qual") !== -1 ? "SQ" : "SPR";
  if (type.indexOf("qual") !== -1) return "Q";
  if (type.indexOf("race") !== -1) return "R";
  const m = name.match(/(\d+)/);
  if (type.indexOf("practice") !== -1) return "P" + (m ? m[1] : "");
  return name.slice(0, 3).toUpperCase();
}
// OpenF1 DRS codes: 10/12/14 = wing open, everything else closed/eligible.
export function drsOpen(v: unknown): boolean { return v === 10 || v === 12 || v === 14; }

/* ---------- channels ---------- */

/** The channel fields a trace reads off a sample. */
export interface ChanSample {
  speed?: number | null | undefined; throttle?: number | null | undefined; brake?: number | null | undefined;
  gear?: number | null | undefined; rpm?: number | null | undefined; drs?: number | null | undefined;
}
export interface Channel {
  id: string; label: string; color: string; w: number;
  norm?: "speed" | "rpm"; lo?: number; hi?: number; step?: boolean; off?: boolean;
  get(c: ChanSample): number | null | undefined;
  fmt(v: number): string | number;
}

export const CHANNELS: readonly Channel[] = Object.freeze([
  { id: "speed",    label: "SPEED",    color: "#39d0ff", w: 2,   norm: "speed", get: function (c) { return c.speed; },    fmt: function (v) { return Math.round(v) + " km/h"; } },
  { id: "throttle", label: "THR",      color: "#3fb950", w: 1.5, lo: 0, hi: 100, get: function (c) { return c.throttle; }, fmt: function (v) { return Math.round(v) + "%"; } },
  { id: "brake",    label: "BRAKE",    color: "#ff4d4d", w: 1.5, lo: 0, hi: 100, get: function (c) { return c.brake; },    fmt: function (v) { return Math.round(v) + "%"; } },
  { id: "gear",     label: "GEAR",     color: "#f6d200", w: 1.5, lo: 0, hi: 8, step: true, get: function (c) { return c.gear; }, fmt: function (v) { return v ? "G" + v : "N"; } },
  { id: "rpm",      label: "RPM",      color: "#c084fc", w: 1.5, norm: "rpm", get: function (c) { return c.rpm; }, fmt: function (v) { return Math.round(v); } },
  { id: "drs",      label: "DRS",      color: "#00e0c0", w: 3, lo: 0, hi: 1.1, step: true, get: function (c) { return c.drs == null ? null : (drsOpen(c.drs) ? 1 : null); }, fmt: function (v) { return v ? "OPEN" : "—"; } },
] satisfies Channel[]);
/** CHANNELS[0], the speed channel every speed dot normalises through. */
export const SPEED_CHANNEL = CHANNELS[0] as Channel;

export const PADL = 36, PADR = 8, PADY = 6;
export function chartX(view: { tMax: number }, t: number, W: number): number { return PADL + (t / view.tMax) * (W - PADL - PADR); }
export function chanRaw(ch: Channel, c: ChanSample): number | null {
  const v = ch.get(c);
  return (v == null || isNaN(v)) ? null : v;
}
export function chanNorm(ch: Channel, c: ChanSample, view: { speedMax: number; rpmMax: number }): number | null {
  const v = chanRaw(ch, c);
  if (v === null) return null;
  if (ch.norm === "speed") return clamp(v / view.speedMax, 0, 1);
  if (ch.norm === "rpm") return clamp(v / view.rpmMax, 0, 1);
  return clamp((v - (ch.lo as number)) / ((ch.hi as number) - (ch.lo as number)), 0, 1);
}
export function sampleAt<S extends { t: number }>(car: readonly S[] | null | undefined, t: number): S | null {
  if (!car || !car.length) return null;
  let lo = 0, hi = car.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((car[mid] as S).t < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs((car[lo - 1] as S).t - t) < Math.abs((car[lo] as S).t - t)) lo--;
  return car[lo] as S;
}

/* ---------- lane colours (telemetry-model.js:280-298) ---------- */

export interface TelemetryModelDeps { findTeam(apiName: string | null | undefined): { color: Rgb } | null | undefined }
/** A lane (tray entry or fetched lane) or a bare driver: laneColors reads `e.d || e`. */
export type ColorEntry = ColoredDriver & { d?: ColoredDriver | null };

export function create({ findTeam }: TelemetryModelDeps): { driverColor(d: ColoredDriver | null | undefined): Rgb; laneColors(entries: readonly ColorEntry[]): Rgb[] } {
  function driverColor(d: ColoredDriver | null | undefined): Rgb {
    return tabDriverColor<Rgb>(d, findTeam, [0.6, 0.6, 0.6]);
  }

  function laneColors(entries: readonly ColorEntry[]): Rgb[] {
    const seen: Record<string, number> = {};
    return entries.map(function (e) {
      let base = driverColor(e.d || e);
      const key = base.map(function (v) { return Math.round(v * 16); }).join(",");
      const n = seen[key] || 0; seen[key] = n + 1;
      if (n > 0) {
        const f = Math.min(0.66, n * 0.30);   // lighten each repeat of a colour
        base = [base[0] * (1 - f) + f, base[1] * (1 - f) + f, base[2] * (1 - f) + f];
      }
      return base;
    });
  }
  return { driverColor, laneColors };
}
