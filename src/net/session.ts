/**
 * The layer between a transport and the game: clock sync, packet routing,
 * typed JSON events and a heartbeat.
 * Port of f1-game js/net/session.js:1-370 (NetSession).
 *
 * Clock sync is NTP-style and keeps the LOWEST-RTT sample, since a slow reply
 * is a queued reply. A PONG is a clock sample only if it echoes an outstanding
 * ping's id AND that ping's own t0. A gap between pumps longer than
 * `stallForgiveMs` is forgiven as OUR stall, except while `document.hidden`.
 */
import { netLog } from "./log";
import { decodeSnapshot, toView } from "./snapshot";
import { EVENT, STATE, type NetEndpoint, type WireData } from "./transport";

export const PING = 3; // 1 and 2 belong to the snapshot types
export const PONG = 4;
const PING_BYTES = 13; // type u8 + id u32 + t0 f64
const PONG_MIN_BYTES = 21; // + t1 f64 (the PING's arrival)
const PONG_BYTES = 29; // + t2 f64 (the PONG's departure)

export interface SessionConfig {
  pingEveryMs: number;
  /** Until the clock lands, ping harder (session.js:11-21). */
  syncPingEveryMs: number;
  timeoutMs: number;
  stallForgiveMs: number;
  /** Lowest RTT over this many samples is the offset (session.js:24-28). */
  clockSamples: number;
  /** A sample older than this stops competing (session.js:29-32). */
  clockMaxAgeMs: number;
  /** Consecutive disagreeing fresh samples that make a clock STEP (session.js:33-35). */
  clockStepRun: number;
}

export const SESSION_DEFAULTS: Readonly<SessionConfig> = {
  pingEveryMs: 500,
  syncPingEveryMs: 100,
  timeoutMs: 6000,
  stallForgiveMs: 400,
  clockSamples: 40,
  clockMaxAgeMs: 10000,
  clockStepRun: 3,
};

export type SessionCloseReason = "transport" | "timeout" | "local";

export interface SessionOptions extends Partial<SessionConfig> {
  readonly transport: NetEndpoint;
}

export type StateHandler = (bytes: WireData, at: number) => void;
export type EventHandler = (data: unknown, type: string) => void;

export interface SessionStats {
  readonly rtt: number;
  readonly offset: number;
  readonly synced: boolean;
  readonly samples: number;
  readonly alive: boolean;
  readonly lastHeard: number | null;
}

export interface NetSession {
  pump(now: number): boolean;
  sendState(bytes: WireData): boolean;
  /** JSON `{t, d}` on the reliable channel; `d` is `null` when omitted. */
  sendEvent(type: string, data?: unknown): boolean;
  onState(fn: StateHandler): this;
  /** `data` is untrusted peer JSON: validate before use. */
  onEvent(type: string, fn: EventHandler): this;
  onClose(fn: (reason: SessionCloseReason) => void): this;
  clearHandlers(): this;
  rtt(): number;
  offset(): number;
  peerToLocal(tPeer: number): number;
  localToPeer(tLocal: number): number;
  /** Half the round trip: how stale a just-arrived snapshot already is. */
  lagMs(): number;
  synced(): boolean;
  alive(): boolean;
  /** The silence that ends this session; forwarded to the transport's disconnect grace. */
  setTimeoutMs(ms: number): number;
  lastHeard(): number | null;
  close(): void;
  stats(): SessionStats;
}

function encodePing(id: number, t0: number): Uint8Array<ArrayBuffer> {
  const dv = new DataView(new ArrayBuffer(PING_BYTES));
  dv.setUint8(0, PING);
  dv.setUint32(1, id >>> 0);
  dv.setFloat64(5, t0);
  return new Uint8Array(dv.buffer);
}

function encodePong(id: number, t0: number, t1: number, t2: number): Uint8Array<ArrayBuffer> {
  const dv = new DataView(new ArrayBuffer(PONG_BYTES));
  dv.setUint8(0, PONG);
  dv.setUint32(1, id >>> 0);
  dv.setFloat64(5, t0);
  dv.setFloat64(13, t1);
  dv.setFloat64(21, Number.isFinite(t2) ? t2 : t1);
  return new Uint8Array(dv.buffer);
}

interface ClockSample {
  readonly rtt: number;
  readonly offset: number;
  readonly at: number;
}

/** The last few pings we sent, held while a reply could plausibly arrive (session.js:65-79). */
const SENT_PINGS_MAX = 64;
const MAX_PLAUSIBLE_RTT_MS = 4000;

export function createSession(opts: SessionOptions): NetSession {
  const transport = opts.transport;
  if (!transport) throw new Error("NetSession needs a transport");
  netLog.info("session create");
  const { transport: _t, ...rest } = opts;
  const cfg: SessionConfig = { ...SESSION_DEFAULTS };
  for (const k of Object.keys(rest) as Array<keyof SessionConfig>) {
    const v = rest[k];
    if (v !== undefined) cfg[k] = v;
  }

  const eventHandlers = new Map<string, EventHandler[]>();
  const stateHandlers: StateHandler[] = [];
  const closeHandlers: Array<(reason: SessionCloseReason) => void> = [];

  let pingId = 0;
  let lastPingAt = -Infinity;
  const sentPings: Array<{ id: number; t0: number }> = []; // oldest first
  function takePing(id: number, t0: number): boolean {
    for (let i = 0; i < sentPings.length; i++) {
      const p = sentPings[i] as { id: number; t0: number };
      if (p.id === id && p.t0 === t0) {
        sentPings.splice(i, 1);
        return true;
      }
    }
    return false;
  }
  let lastHeardAt: number | null = null; // null until the first packet ever
  let firstPumpAt: number | null = null; // open-but-silent transports need a deadline too
  let best: ClockSample | null = null; // lowest-RTT sample
  let samples: ClockSample[] = [];
  let alive = true;
  let lastNow = 0;
  // Last game STATE seen before the first PONG, replayed once the offset
  // exists (session.js:91-95).
  let heldState: { data: WireData; now: number } | null = null;

  let stepRun: ClockSample[] = []; // fresh samples that disagree with `best`
  function addSample(rtt: number, offset: number, now: number): void {
    // Both halves are wire-derived; a NaN offset would poison every conversion.
    if (!(rtt >= 0) || rtt > MAX_PLAUSIBLE_RTT_MS) return;
    if (!Number.isFinite(offset)) return;
    const sample: ClockSample = { rtt, offset, at: now };
    // An offset error is bounded by half of each exchange's round trip, so a
    // disagreement past both RTTs (+ slack) cannot be queuing noise.
    if (best && Math.abs(offset - best.offset) > rtt + best.rtt + 50) {
      const first = stepRun[0];
      if (first && Math.abs(offset - first.offset) > rtt + first.rtt + 50) stepRun = [];
      stepRun.push(sample);
      if (stepRun.length >= cfg.clockStepRun) {
        samples = [...stepRun];
        stepRun = [];
      }
    } else stepRun = [];
    if (!samples.includes(sample)) samples.push(sample);
    if (samples.length > cfg.clockSamples) samples.shift();
    if (Number.isFinite(now)) samples = samples.filter((x) => !(now - x.at > cfg.clockMaxAgeMs));
    // Lowest RTT wins: it is the exchange least distorted by queuing.
    best = samples.reduce<ClockSample | null>((a, b) => (a && a.rtt <= b.rtt ? a : b), null);
  }
  const offset = (): number => (best ? best.offset : 0);
  const rtt = (): number => (best ? best.rtt : 0);
  const synced = (): boolean => best != null;

  function deliverState(data: WireData, now: number): void {
    for (const fn of stateHandlers) {
      try {
        fn(data, now);
      } catch {
        /* a consumer bug is not a disconnect */
      }
    }
  }

  function onStateBytes(data: WireData, now: number): boolean {
    const dv = toView(data);
    if (!dv || !dv.byteLength) return false;
    const type = dv.getUint8(0);

    if (type === PING) {
      if (dv.byteLength >= PING_BYTES) {
        // t1 = the PING's arrival stamp, t2 = now as this reply leaves.
        transport.send(STATE, encodePong(dv.getUint32(1), dv.getFloat64(5), now, lastNow));
        return true;
      }
      return false;
    }
    if (type === PONG) {
      // Refuse short frames: a flood of truncated PONGs must not keep a silent
      // peer alive (session.js:122-127).
      if (dv.byteLength < PONG_MIN_BYTES) return false;
      const id = dv.getUint32(1);
      const t0 = dv.getFloat64(5);
      const t1 = dv.getFloat64(13);
      const t2raw = dv.byteLength >= PONG_BYTES ? dv.getFloat64(21) : t1;
      if (!takePing(id, t0)) return false; // not a ping of ours, or already answered
      // NTP's four stamps: the peer's hold (t2 − t1) is not path.
      const hold = Number.isFinite(t2raw) && t2raw >= t1 ? Math.min(t2raw - t1, MAX_PLAUSIBLE_RTT_MS) : 0;
      const t2 = t1 + hold;
      const roundTrip = now - t0 - hold;
      addSample(roundTrip, (t1 - t0 + (t2 - now)) / 2, now);
      if (synced() && heldState) {
        const held = heldState;
        heldState = null;
        deliverState(held.data, held.now);
      }
      return true;
    }
    const valid = !!decodeSnapshot(dv);
    if (!synced()) {
      heldState = { data, now };
      return valid;
    }
    deliverState(data, now);
    return valid;
  }

  function onEventJson(data: WireData): boolean {
    let msg: unknown;
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(toView(data) ?? new Uint8Array(0));
      msg = JSON.parse(text);
    } catch {
      return false; // malformed event: drop, never throw
    }
    if (typeof msg !== "object" || msg === null) return false;
    const { t, d } = msg as { t?: unknown; d?: unknown };
    if (typeof t !== "string") return false;
    const list = eventHandlers.get(t);
    if (!list) return false;
    for (const fn of list) {
      try {
        fn(d, t);
      } catch {
        /* as above */
      }
    }
    return true;
  }

  transport.onMessage((channel, data, at) => {
    // Prefer the transport's ARRIVAL stamp (rtc supplies it; loopback's wire
    // time is a different clock domain).
    const t = at != null ? at : lastNow;
    const valid = channel === STATE ? onStateBytes(data, t) : channel === EVENT ? onEventJson(data) : false;
    if (valid) lastHeardAt = t;
  });

  // `released` latches "the transport is closed" SEPARATELY from `alive`
  // (session.js:217-221).
  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    try {
      transport.close();
    } catch {
      /* already gone */
    }
  }
  function fire(reason: SessionCloseReason): void {
    for (const fn of closeHandlers) {
      try {
        fn(reason);
      } catch {
        /* a listener bug must not stop the rest */
      }
    }
  }
  transport.onClose(() => {
    released = true; // it closed itself — nothing to release
    if (alive) {
      alive = false;
      netLog.info("session close transport");
      fire("transport");
    }
  });

  function pump(now: number): boolean {
    const gap = lastNow ? now - lastNow : 0; // 0 = never pumped, not a stall
    // A STALL is THIS page not running and is forgiven; a HIDDEN tab pumps
    // slowly on purpose, so its silence is real (session.js:240-251).
    const hidden = typeof document !== "undefined" && !!document.hidden;
    if (!hidden && gap > cfg.stallForgiveMs && lastHeardAt != null) lastHeardAt += gap;
    if (!hidden && gap > cfg.stallForgiveMs && firstPumpAt != null) firstPumpAt += gap;
    // Our OWN clock went backwards (a suspend): re-base the stamps taken on it.
    if (gap < 0) {
      lastPingAt = -Infinity;
      if (lastHeardAt != null) lastHeardAt += gap;
      if (firstPumpAt != null) firstPumpAt += gap;
    }
    lastNow = now;
    if (firstPumpAt == null && transport.status !== "connecting") firstPumpAt = now;
    transport.pump(now);

    const pingGap = synced() ? cfg.pingEveryMs : cfg.syncPingEveryMs;
    if (alive && now - lastPingAt >= pingGap) {
      lastPingAt = now;
      const id = ++pingId >>> 0;
      sentPings.push({ id, t0: now });
      while (sentPings.length > SENT_PINGS_MAX || (sentPings.length > 1 && now - (sentPings[0] as { t0: number }).t0 > MAX_PLAUSIBLE_RTT_MS)) {
        sentPings.shift();
      }
      transport.send(STATE, encodePing(id, now));
    }
    // A connecting transport gets its own ICE window. Once open, a silent peer
    // is bounded even if no first protocol frame ever arrives.
    const heardOrOpen = lastHeardAt == null ? firstPumpAt : lastHeardAt;
    if (alive && heardOrOpen != null && now - heardOrOpen > cfg.timeoutMs) {
      alive = false;
      release();
      netLog.info("session close timeout");
      fire("timeout");
    }
    return alive;
  }

  const session: NetSession = {
    pump,
    sendState: (bytes) => transport.send(STATE, bytes),
    sendEvent: (type, data) => transport.send(EVENT, JSON.stringify({ t: type, d: data === undefined ? null : data })),
    onState(fn) {
      stateHandlers.push(fn);
      return this;
    },
    onEvent(type, fn) {
      const list = eventHandlers.get(type);
      if (list) list.push(fn);
      else eventHandlers.set(type, [fn]);
      return this;
    },
    onClose(fn) {
      closeHandlers.push(fn);
      return this;
    },
    clearHandlers() {
      stateHandlers.length = 0;
      closeHandlers.length = 0;
      eventHandlers.clear();
      return this;
    },
    rtt,
    offset,
    peerToLocal: (tPeer) => tPeer - offset(),
    localToPeer: (tLocal) => tLocal + offset(),
    lagMs: () => rtt() / 2,
    synced,
    alive: () => alive,
    setTimeoutMs(ms) {
      if (Number.isFinite(ms) && ms > 0) {
        cfg.timeoutMs = ms;
        transport.setDisconnectGrace(ms);
      }
      return cfg.timeoutMs;
    },
    lastHeard: () => lastHeardAt,
    close() {
      // Release whatever `alive` says, and flip `alive` BEFORE releasing: the
      // transport's close event fires synchronously and would report our own
      // close() as "transport" (session.js:318-326).
      const was = alive;
      alive = false;
      release();
      if (!was) return;
      netLog.info("session close");
      fire("local");
    },
    stats: () => ({ rtt: rtt(), offset: offset(), synced: synced(), samples: samples.length, alive, lastHeard: lastHeardAt }),
  };
  return session;
}

/**
 * Give a BARE transport endpoint the one peer behaviour the near end cannot do
 * without: answering PING with PONG (session.js:340-366). Without it a
 * session against a bare endpoint never syncs and the game gets nothing.
 */
export function autoPong(transport: NetEndpoint | null | undefined): boolean {
  // Duck-check at runtime too: the caller may hand over anything (session.js:354).
  if (!transport || typeof transport.onMessage !== "function" || typeof transport.send !== "function") return false;
  let lastNow = 0;
  if (typeof transport.pump === "function") {
    const pump = transport.pump.bind(transport);
    transport.pump = (now: number): number => {
      lastNow = now;
      return pump(now);
    };
  }
  transport.onMessage((channel, data, at) => {
    if (channel !== STATE) return;
    const dv = toView(data);
    if (!dv || dv.byteLength < PING_BYTES || dv.getUint8(0) !== PING) return;
    transport.send(STATE, encodePong(dv.getUint32(1), dv.getFloat64(5), at != null ? at : lastNow, NaN));
  });
  return true;
}
