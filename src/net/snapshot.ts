/**
 * What goes on the STATE wire, and how a rival is drawn smoothly from packets
 * that arrive late, out of order, or not at all.
 * Port of f1-game js/net/snapshot.js:1-390 (NetSnapshot).
 *
 * 13 B/car: s/x/head/speed/gear/lap, quantised to 1 cm and 1 cm/s. Remote cars
 * draw ~100 ms in the past between two packets; a late packet EXTRAPOLATES
 * ALONG s, which follows the road by construction. AGED (type 2, 15 B/car)
 * carries cars posed at different moments (the host's relay).
 */
import type { CarState } from "../contracts/sim";
import { netLog } from "./log";

export const TYPE_SNAPSHOT = 1;
export const TYPE_AGED = 2;
export const CAR_BYTES = 13;
export const AGED_BYTES = CAR_BYTES + 2;
const SNAP_HEADER = 6; // type u8 + tick u32 + count u8
const MAX_AGE_MS = 65535;

const TAU = Math.PI * 2;
/** createInterp().push refuses a tick further ahead of the arrival clock than this. */
export const MAX_AHEAD_MS = 3000;
const U16 = 65536;

// Flags packed above the gear nibble (snapshot.js:22-23).
const F_DEPLOY = 0x10;
const F_OFFROAD = 0x20;
const F_KERB = 0x40;
const F_BRAKE = 0x80;

// f1-game js/core/mat4.js:5,7-12.
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
function wrapDelta(d: number, period: number): number {
  const half = period * 0.5;
  if (d > half) return d - period;
  if (d < -half) return d + period;
  return d;
}
const i32 = (v: number): number => v | 0;

const encS = (s: number): number => clamp(Math.round(s * 100), 0, 4294967295) >>> 0;
const decS = (v: number): number => v / 100;
const encX = (x: number): number => clamp(Math.round(x * 100), -32768, 32767) | 0;
const decX = (v: number): number => v / 100;
const encV = (v: number): number => clamp(Math.round(v * 100), -32768, 32767) | 0;
const decV = (v: number): number => v / 100;
const encH = (h: number): number => (Math.round((((h % TAU) + TAU) % TAU) / TAU * U16) % U16) & 0xffff;
const decH = (v: number): number => (v / U16) * TAU;

/**
 * The car fields a snapshot carries, typed against `CarState`.
 * `braking` is not on CarState (f1-game sets `c.braking` in updateCar);
 * TODO(coordinator): add `braking` to CarState in a contracts PR, then drop it here.
 */
export type WireCarSource = Partial<Pick<CarState, "s" | "x" | "head" | "speed" | "gear" | "lap" | "deploying" | "offroad">> & {
  readonly onKerb?: boolean | undefined;
  readonly braking?: boolean | undefined;
};

/** One decoded car. Every field the encoder writes, plus the wire id and age. */
export interface WireCar {
  id: number;
  s: number;
  x: number;
  head: number;
  speed: number;
  gear: number;
  deploying: boolean;
  offroad: boolean;
  onKerb: boolean;
  braking: boolean;
  lap: number;
  /** ms older than the packet's header tick (0 for TYPE_SNAPSHOT). */
  age: number;
}

function writeCar(dv: DataView, off: number, id: number, c: WireCarSource): number {
  dv.setUint8(off, id & 0xff);
  dv.setUint32(off + 1, encS(c.s || 0));
  dv.setInt16(off + 5, encX(c.x || 0));
  dv.setUint16(off + 7, encH(c.head || 0));
  dv.setInt16(off + 9, encV(c.speed || 0));
  let gf = clamp(i32(c.gear || 1), 0, 15);
  if (c.deploying) gf |= F_DEPLOY;
  if (c.offroad) gf |= F_OFFROAD;
  if (c.onKerb) gf |= F_KERB;
  if (c.braking) gf |= F_BRAKE;
  dv.setUint8(off + 11, gf);
  dv.setUint8(off + 12, clamp(i32(c.lap || 0), 0, 255));
  return off + CAR_BYTES;
}

function readCar(dv: DataView, off: number): WireCar {
  const gf = dv.getUint8(off + 11);
  return {
    id: dv.getUint8(off),
    s: decS(dv.getUint32(off + 1)),
    x: decX(dv.getInt16(off + 5)),
    head: decH(dv.getUint16(off + 7)),
    speed: decV(dv.getInt16(off + 9)),
    gear: gf & 0x0f,
    deploying: !!(gf & F_DEPLOY),
    offroad: !!(gf & F_OFFROAD),
    onKerb: !!(gf & F_KERB),
    braking: !!(gf & F_BRAKE),
    lap: dv.getUint8(off + 12),
    age: 0,
  };
}

/** Only a true integer 0..255 is a wire id (snapshot.js:68-72). */
function wireId(id: unknown): id is number {
  return Number.isInteger(id) && (id as number) >= 0 && (id as number) <= 255;
}

export interface SnapshotEntry {
  readonly id: number;
  readonly car: WireCarSource;
}

export interface AgedEntry extends SnapshotEntry {
  /** The moment that pose was true, in the sender's clock. */
  readonly at: number;
}

export function encodeSnapshot(tick: number, entries: ReadonlyArray<SnapshotEntry | null | undefined> | null | undefined): Uint8Array<ArrayBuffer> {
  const list: SnapshotEntry[] = [];
  const src = entries || [];
  for (let i = 0; i < src.length && list.length < 255; i++) {
    const e = src[i];
    if (!e || !wireId(e.id)) continue;
    list.push(e);
  }
  const n = list.length;
  const buf = new ArrayBuffer(SNAP_HEADER + n * CAR_BYTES);
  const dv = new DataView(buf);
  dv.setUint8(0, TYPE_SNAPSHOT);
  dv.setUint32(1, tick >>> 0);
  dv.setUint8(5, n);
  let off = SNAP_HEADER;
  for (const e of list) off = writeCar(dv, off, e.id, e.car);
  return new Uint8Array(buf);
}

/** The header tick is the NEWEST `at`; each entry's age is tick − at (snapshot.js:94-120). */
export function encodeAged(entries: ReadonlyArray<AgedEntry | null | undefined> | null | undefined): Uint8Array<ArrayBuffer> {
  const list: AgedEntry[] = [];
  const src = entries || [];
  let tick = -Infinity;
  for (let i = 0; i < src.length && list.length < 255; i++) {
    const e = src[i];
    if (!e || !wireId(e.id) || !Number.isFinite(e.at)) continue;
    list.push(e);
    if (e.at > tick) tick = e.at;
  }
  const n = list.length;
  const buf = new ArrayBuffer(SNAP_HEADER + n * AGED_BYTES);
  const dv = new DataView(buf);
  const t = n ? Math.round(tick) : 0;
  dv.setUint8(0, TYPE_AGED);
  dv.setUint32(1, t >>> 0);
  dv.setUint8(5, n);
  let off = SNAP_HEADER;
  for (const e of list) {
    off = writeCar(dv, off, e.id, e.car);
    dv.setUint16(off, clamp(Math.round(t - e.at), 0, MAX_AGE_MS));
    off += 2;
  }
  return new Uint8Array(buf);
}

// Packets arrive at the publish rate, so a bad peer would flood: log the
// first drop per reason, then every 256th (snapshot.js:122-129).
const dropCounts = new Map<string, number>();
function dropped(reason: string): null {
  const n = (dropCounts.get(reason) || 0) + 1;
  dropCounts.set(reason, n);
  if (n === 1 || n % 256 === 0) netLog.debug("snapshot dropped (" + reason + "), count " + n);
  return null;
}

export interface DecodedSnapshot {
  readonly type: typeof TYPE_SNAPSHOT | typeof TYPE_AGED;
  readonly tick: number;
  readonly cars: WireCar[];
}

export type BytesLike = DataView | ArrayBuffer | ArrayBufferView | null | undefined;

export function toView(bytes: unknown): DataView | null {
  if (!bytes) return null;
  if (bytes instanceof DataView) return bytes;
  if (bytes instanceof ArrayBuffer) return new DataView(bytes);
  if (ArrayBuffer.isView(bytes)) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return null;
}

export function decodeSnapshot(bytes: unknown): DecodedSnapshot | null {
  const dv = toView(bytes);
  if (!dv || dv.byteLength < SNAP_HEADER) return dropped("short or non-binary");
  const type = dv.getUint8(0);
  if (type !== TYPE_SNAPSHOT && type !== TYPE_AGED) return dropped("type " + type);
  const aged = type === TYPE_AGED;
  const n = dv.getUint8(5);
  const per = aged ? AGED_BYTES : CAR_BYTES;
  if (dv.byteLength < SNAP_HEADER + n * per) return dropped("truncated car list");
  const cars: WireCar[] = [];
  let off = SNAP_HEADER;
  for (let i = 0; i < n; i++) {
    const car = readCar(dv, off);
    car.age = aged ? dv.getUint16(off + CAR_BYTES) : 0;
    cars.push(car);
    off += per;
  }
  return { type, tick: dv.getUint32(1), cars };
}

// Both take the SHORT way round, or a car crossing the line sprints backwards
// down the whole lap (snapshot.js:162-171).
function lerpWrapped(a: number, b: number, u: number, period: number): number {
  const d = wrapDelta(b - a, period);
  const v = a + d * u;
  return ((v % period) + period) % period;
}

// Adaptive-delay bounds (snapshot.js:173-177).
const MAX_DELAY_MS = 400;
const MAX_LAG_MS = 400;
const LAG_MARGIN_MS = 20;
// uint32 ms ticks wrap at ~49.7 d of performance.now(): rebase a wire tick to
// the epoch nearest a local reference (snapshot.js:178-192).
const TICK_MOD = 0x100000000;
function tickRaw(t: number): number {
  return ((t % TICK_MOD) + TICK_MOD) % TICK_MOD;
}
function tickNear(t: number, reference: number | null): number {
  const raw = tickRaw(t);
  if (reference == null || !Number.isFinite(reference)) return raw;
  return raw + Math.round((reference - raw) / TICK_MOD) * TICK_MOD;
}

/** The interpolated state: `s` and `head` wrap, `x`/`speed` blend, the rest steps. */
export interface InterpState {
  s: number;
  x: number;
  head: number;
  speed: number;
  lap?: number | undefined;
  braking?: boolean | undefined;
  [field: string]: unknown;
}

export type InterpSample<S extends InterpState> = S & { t: number };
export type InterpOut<S extends InterpState> = S & { t: number; extrapolated: boolean };

export interface InterpOptions {
  /** Track length, for wrap-aware s. */
  readonly total?: number;
  readonly delayMs?: number;
  readonly maxExtrapMs?: number;
  readonly keep?: number;
  readonly adaptive?: boolean;
  readonly maxAheadMs?: number;
}

export interface InterpTiming {
  readonly delayMs: number;
  readonly jitterMs: number;
  readonly lagMs: number;
  readonly adaptive: boolean;
}

export interface Interp<S extends InterpState> {
  push(t: number, st: S, arrivalMs?: number): boolean;
  /** The DRAWN pose, delayMs in the past. `out` is a caller-owned scratch object. */
  sample(nowMs: number, out?: Partial<InterpOut<S>>): InterpOut<S> | null;
  /** Where the rival actually IS: contact must be resolved against this, not sample(). */
  predict(nowMs: number, out?: Partial<InterpOut<S>>): InterpOut<S> | null;
  size(): number;
  newest(): InterpSample<S> | null;
  oldest(): InterpSample<S> | null;
  timing(): InterpTiming;
  /** The time the last sample() posed: what a relay must stamp that pose with. */
  presentedAt(): number;
  clear(): void;
}

/** Extrapolation cannot shed more than this share of the car's speed (snapshot.js:271-276). */
const EXTRAP_SLOW_MAX = 0.35;

export function createInterp<S extends InterpState>(opts: InterpOptions = {}): Interp<S> {
  const total = opts.total || 1;
  let delayMs = opts.delayMs != null ? opts.delayMs : 100;
  const baseDelay = delayMs;
  let jitter = 0;
  let lag = 0;
  let interval = 0;
  let lastArrival: number | null = null;
  let lastTick: number | null = null;
  let presentedAt = -Infinity;
  const maxExtrapMs = opts.maxExtrapMs != null ? opts.maxExtrapMs : 250;
  const keep = opts.keep || 32;
  let samples: Array<InterpSample<S>> = []; // ascending by t
  // A tick this far AHEAD of the local clock at arrival is a bad or hostile
  // peer, not latency (snapshot.js:198-205).
  const maxAheadMs = opts.maxAheadMs != null ? opts.maxAheadMs : MAX_AHEAD_MS;

  function push(t: number, st: S, arrivalMs?: number): boolean {
    if (!Number.isFinite(t)) return false;
    const arrival = arrivalMs != null && Number.isFinite(arrivalMs) ? arrivalMs : null;
    const last = samples[samples.length - 1];
    const reference = arrival != null ? arrival : last ? last.t : null;
    t = tickNear(t, reference);
    if (arrival != null && t - arrival > maxAheadMs) {
      dropped("tick ahead of clock");
      return false;
    }
    if (opts.adaptive && arrival != null && (lastTick == null || t > lastTick)) {
      // LAG IS LATENCY, NOT ONLY JITTER: follow the observed lag up at once and
      // down slowly, and cover the publish interval too (snapshot.js:216-227).
      const lagNow = Math.max(0, Math.min(MAX_LAG_MS, arrival - t));
      lag = lagNow > lag ? lagNow : lag + (lagNow - lag) * 0.02;
      if (lastArrival != null && lastTick != null) {
        const deviation = Math.min(200, Math.abs(arrival - lastArrival - (t - lastTick)));
        jitter += (deviation - jitter) * 0.1;
        interval += (Math.min(200, Math.max(0, t - lastTick)) - interval) * 0.1;
        const target = Math.min(MAX_DELAY_MS, Math.max(baseDelay, lag + interval + LAG_MARGIN_MS) + jitter * 2);
        delayMs += (target - delayMs) * 0.08;
      }
      lastArrival = arrival;
      lastTick = t;
    }
    const rec = Object.assign({ t }, st) as InterpSample<S>;
    // Fast path: the normal case is strictly newer than everything held.
    if (!last || t > last.t) {
      samples.push(rec);
    } else {
      let i = samples.length - 1;
      while (i >= 0 && (samples[i] as InterpSample<S>).t > t) i--;
      if (i >= 0 && (samples[i] as InterpSample<S>).t === t) return false; // duplicate — ignore
      samples.splice(i + 1, 0, rec);
    }
    while (samples.length > keep) samples.shift();
    return true;
  }

  function splitS(raw: number): { s: number; laps: number } {
    const laps = Math.floor(raw / total);
    return { s: raw - laps * total, laps };
  }

  // `decelMs2` is the OBSERVED rate from the last two packets, 0 when not
  // braking (snapshot.js:278-284).
  function advance(st: InterpSample<S>, dtMs: number, out: Partial<InterpOut<S>> | undefined, decelMs2: number): InterpOut<S> {
    const dt = dtMs / 1000;
    let v = st.speed;
    let ds: number;
    const a = decelMs2 > 0 && v > 0 ? decelMs2 : 0;
    if (a > 0) {
      // Never predict past the stop, and never past the cap above.
      const te = Math.min(dt, v / a, (EXTRAP_SLOW_MAX * v) / a);
      ds = v * te - 0.5 * a * te * te + Math.max(0, v - a * te) * (dt - te);
      v = Math.max(0, v - a * te);
    } else {
      ds = v * dt;
    }
    const w = splitS(st.s + ds);
    // Spread the source rather than re-listing its fields; only s moves, x is
    // deliberately not extrapolated (snapshot.js:310-316).
    const o = Object.assign(out || {}, st) as InterpOut<S>;
    o.s = w.s;
    // Speed follows s: they are one claim about the same car.
    o.speed = v;
    o.lap = Number.isFinite(st.lap) ? (st.lap as number) + w.laps : st.lap;
    o.extrapolated = true;
    return o;
  }

  function blend(a: InterpSample<S>, b: InterpSample<S>, u: number, out: Partial<InterpOut<S>> | undefined): InterpOut<S> {
    const o = Object.assign(out || {}, u < 0.5 ? a : b) as InterpOut<S>;
    o.x = a.x + (b.x - a.x) * u;
    o.head = lerpWrapped(a.head, b.head, u, TAU);
    o.speed = a.speed + (b.speed - a.speed) * u;
    o.extrapolated = false;
    const d = wrapDelta(b.s - a.s, total);
    const w = splitS(a.s + d * u);
    o.s = w.s;
    if (Number.isFinite(a.lap)) o.lap = (a.lap as number) + w.laps;
    return o;
  }

  function at(target: number, out?: Partial<InterpOut<S>>): InterpOut<S> | null {
    const newest = samples[samples.length - 1];
    const oldest = samples[0];
    if (!newest || !oldest) return null;
    target = tickNear(target, newest.t);
    if (target >= newest.t) {
      // Observed deceleration, only while the wire says the brakes are on.
      let decel = 0;
      const prev = samples[samples.length - 2];
      if (newest.braking && prev) {
        const dts = (newest.t - prev.t) / 1000;
        if (dts > 0.001 && Number.isFinite(prev.speed) && Number.isFinite(newest.speed)) {
          const d = (prev.speed - newest.speed) / dts;
          if (d > 0) decel = d;
        }
      }
      return advance(newest, Math.min(target - newest.t, maxExtrapMs), out, decel);
    }
    if (target <= oldest.t) {
      const o = Object.assign(out || {}, oldest) as InterpOut<S>;
      o.extrapolated = false;
      return o;
    }
    for (let i = samples.length - 1; i > 0; i--) {
      const a = samples[i - 1] as InterpSample<S>;
      const b = samples[i] as InterpSample<S>;
      if (target >= a.t && target <= b.t) {
        const span = b.t - a.t;
        return blend(a, b, span > 0 ? (target - a.t) / span : 0, out);
      }
    }
    const o = Object.assign(out || {}, newest) as InterpOut<S>;
    o.extrapolated = false;
    return o;
  }

  function sample(nowMs: number, out?: Partial<InterpOut<S>>): InterpOut<S> | null {
    const target = nowMs - delayMs;
    // Increasing the buffer during a burst may hold a pose, never rewind it.
    presentedAt = opts.adaptive ? Math.max(presentedAt, target) : target;
    return at(presentedAt, out);
  }

  return {
    push,
    sample,
    predict: (nowMs, out) => at(nowMs, out),
    size: () => samples.length,
    newest: () => samples[samples.length - 1] ?? null,
    oldest: () => samples[0] ?? null,
    timing: () => ({ delayMs, jitterMs: jitter, lagMs: lag, adaptive: !!opts.adaptive }),
    presentedAt: () => presentedAt,
    clear: () => {
      samples = [];
      delayMs = baseDelay;
      jitter = 0;
      lag = 0;
      interval = 0;
      lastArrival = null;
      lastTick = null;
      presentedAt = -Infinity;
    },
  };
}
