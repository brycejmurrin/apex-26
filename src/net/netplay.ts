/**
 * The game side of multiplayer: host-authoritative race control, 20 Hz own-car
 * snapshots, 100 ms interpolation of rivals, the host's relay and AI
 * replication, and the start handshake.
 * Port of f1-game js/net/netplay.js:1-1448 (NetPlay) and js/net/spectate.js
 * (NetSpectate), against the typed `NetPlayCtx` (src/contracts/net.ts) instead
 * of the `G` façade.
 *
 * AUTHORITY: each peer fully owns its own car; the host additionally owns the
 * AI (guests draw the host's AI poses) and race control. Your own car is NEVER
 * corrected — no rollback, no reconciliation, no host advantage. UP TO FOUR
 * PLAYERS in a STAR: the host holds one session per guest and RELAYS every
 * rival in one aged snapshot per guest. A packet with an unknown wire id is
 * DROPPED, never guessed at.
 */
import type { NetCar, NetPlayCtx, NetTyre, PitState, PeerQuali, PeerQualiLive, NetStrategyFields } from "../contracts/net";
import type { TrackSample } from "../contracts/track";
import { netLog } from "./log";
import { createSession, type NetSession, type SessionCloseReason, type SessionStats } from "./session";
import { createInterp, decodeSnapshot, encodeAged, encodeSnapshot, type AgedEntry, type Interp, type InterpOut, type InterpTiming, type WireCar } from "./snapshot";
import type { NetEndpoint, WireData } from "./transport";

export const PUBLISH_HZ = 20;
const PUBLISH_MS = 1000 / PUBLISH_HZ;
/** How far in the past rivals are drawn. */
export const INTERP_DELAY_MS = 100;
/** The host's AI poses ride every AI_EVERY-th publish (10 Hz). */
const AI_EVERY = 2;
/** A rival silent this long is driven by the LOCAL AI until its packets return. */
const STALE_MS = 2000;
/** The host relays a human rival's pose only while its newest packet is this fresh. */
const RELAY_FRESH_MS = 500;
const RACE_GRACE_MS = 25000;

// ─── spectator policy (js/net/spectate.js) ──────────────────────────────────

export type NetRole = "host" | "guest" | "spectator";
export type PeerKind = "driver" | "spectator";

export const Spectate = {
  DRIVER: "driver",
  SPECTATOR: "spectator",
  kind(peer: unknown): PeerKind {
    const value =
      typeof peer === "string"
        ? peer
        : typeof peer === "object" && peer !== null
          ? ((peer as { kind?: unknown; role?: unknown }).kind || (peer as { role?: unknown }).role)
          : undefined;
    return value === "spectator" ? "spectator" : "driver";
  },
  isSpectator(peer: unknown): boolean {
    return Spectate.kind(peer) === "spectator";
  },
  canPublish(role: NetRole | null): boolean {
    return role !== "spectator";
  },
} as const;

// ─── events (netplay.js:31-47) ──────────────────────────────────────────────

export const EV = {
  MODEL: "model",
  STRATEGY: "strategy",
  HELLO: "hello",
  SETTINGS: "settings",
  READY: "ready",
  GO: "go",
  START: "start",
  ARMED: "armed",
  QUALI: "quali",
  QLIVE: "qlive",
  LAP: "lap",
  RESULT: "result",
  CAUTION: "caution",
  BYE: "bye",
  LEFT: "left",
  REJOIN: "rejoin",
} as const;
export type EventName = (typeof EV)[keyof typeof EV];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// ─── wire clamps (netplay.js:49-97) ─────────────────────────────────────────

const X_LIMIT = 200;
const SPEED_LIMIT = 200;

/** A wire state as the interpolation buffer returns it. */
export type WireState = Pick<WireCar, "s" | "x" | "head" | "speed" | "gear" | "lap" | "deploying" | "offroad" | "onKerb" | "braking"> & {
  extrapolated?: boolean;
};

export interface ClampedState {
  s: number;
  lap: number;
  head: number;
  x: number;
  speed: number;
  gear: number;
  deploying: boolean;
  offroad: boolean;
  onKerb: boolean;
  braking: boolean;
  extrapolated: boolean;
}

/**
 * CLAMP BEFORE ANYTHING READS IT: every field is peer-supplied, and `s`/`lap`
 * feed c.prog, the number the whole field order sorts on. ONE helper for the
 * posed sample AND the predicted one (netplay.js:49-62).
 */
export function clampWire(st: Partial<WireState>, total: number, lapsTarget: number, out?: Partial<ClampedState>, gears = 8): ClampedState {
  const o = (out || {}) as ClampedState;
  const _s = Number(st.s);
  const _lap = Number(st.lap);
  const _head = +(st.head as number);
  const _x = +(st.x as number);
  const _sp = +(st.speed as number);
  o.s = Number.isFinite(_s) ? Math.min(Math.max(_s, 0), total || _s) : 0;
  o.lap = Number.isFinite(_lap) ? Math.min(Math.max(Math.floor(_lap), 0), (lapsTarget || 0) + 1) : 0;
  // Wrapped, not clamped: a heading IS periodic.
  o.head = Number.isFinite(_head) ? Math.atan2(Math.sin(_head), Math.cos(_head)) : 0;
  o.x = Number.isFinite(_x) ? Math.min(Math.max(_x, -X_LIMIT), X_LIMIT) : 0;
  o.speed = Number.isFinite(_sp) ? Math.min(Math.max(_sp, -SPEED_LIMIT), SPEED_LIMIT) : 0;
  // 4 bits on the wire but the box has GEARS.
  o.gear = Math.min(gears, Math.max(1, (st.gear as number) | 0));
  o.deploying = !!st.deploying;
  o.offroad = !!st.offroad;
  o.onKerb = !!st.onKerb;
  o.braking = !!st.braking;
  o.extrapolated = !!st.extrapolated;
  return o;
}

/**
 * A GUEST MUST NOT BE ABLE TO DECLARE ITSELF THE WINNER: on the host a remote
 * lap only rises by ONE per line crossing, after a mid-lap sighting, and no
 * faster than a lap at the wire's speed ceiling (netplay.js:77-126).
 */
const MID_LO = 0.25;
const MID_HI = 0.75;
export function gateLap(c: NetCar, st: Pick<ClampedState, "s" | "lap">, total: number, now: number): number {
  const prev = Math.max(0, Math.floor(Number(c.lap) || 0));
  let lap = prev;
  if (!(total > 0)) lap = Math.min(st.lap, prev);
  else if (st.lap === prev) lap = prev;
  else if (st.lap < prev) {
    // A fall re-arms the next rise, so it nets zero.
    lap = st.lap;
    c._nMid = true;
    c._nRiseT = null;
  } else if (
    Number.isFinite(c.s) &&
    c.s - st.s > total * 0.5 &&
    (prev === 0 || c._nMid) &&
    !(Number.isFinite(now) && c._nRiseT != null && Number.isFinite(c._nRiseT) && now - c._nRiseT < total / SPEED_LIMIT)
  ) {
    lap = prev + 1;
    c._nMid = false;
    c._nRiseT = now;
  }
  if (total > 0 && st.s > total * MID_LO && st.s < total * MID_HI) c._nMid = true;
  return lap;
}

const FIN_SLACK_S = 5;
const POSE_AGE_MAX_MS = 100;

// ─── qualifying (netplay.js:136-231) ────────────────────────────────────────

export const QUALI_MIN_S = 20;
export const QUALI_MAX_S = 3600;

function lapTimeOk(t: number, total: number): boolean {
  return Number.isFinite(t) && t > (total > 0 ? total / SPEED_LIMIT : 0) && t < QUALI_MAX_S;
}

/** ONE VALIDATION SITE for a peer's qualifying time. NO TIME arrives as t = Infinity. */
export function validQuali(d: unknown): (PeerQuali & Record<string, unknown>) | null {
  if (!isObj(d) || d["driverId"] == null) return null;
  if (d["noTime"] === true) return { ...d, driverId: d["driverId"], t: Infinity, noTime: true };
  const t = Number(d["t"]);
  if (!(Number.isFinite(t) && t > QUALI_MIN_S && t < QUALI_MAX_S)) return null;
  return { ...d, driverId: d["driverId"], t };
}

/** QLIVE never reaches the classification, so it is bounded rather than refused. */
export function validQualiLive(d: unknown): (PeerQualiLive & Record<string, unknown>) | null {
  if (!isObj(d) || d["driverId"] == null) return null;
  const t = Number(d["t"]);
  const frac = Number(d["frac"]);
  return {
    ...d,
    driverId: d["driverId"],
    t: Number.isFinite(t) && t >= 0 ? Math.min(t, QUALI_MAX_S) : 0,
    frac: Number.isFinite(frac) ? Math.min(Math.max(frac, 0), 1) : 0,
  };
}

/** One row of the host's RESULT: driver id, time, penalty, lap, classified. */
export interface ResultRow {
  readonly d: unknown;
  readonly t?: number | null;
  readonly p?: number | null;
  readonly lap?: number | null;
  readonly classified?: boolean | null;
}

export function validClassification(rows: unknown, cars: readonly Pick<NetCar, "driverId">[]): rows is ResultRow[] {
  if (!Array.isArray(rows) || !Array.isArray(cars) || rows.length !== cars.length) return false;
  const ids = new Set(cars.map((c) => c.driverId));
  if (ids.size !== cars.length) return false;
  const seen = new Set<unknown>();
  for (const e of rows as unknown[]) {
    if (!isObj(e)) return false;
    const t = e["t"];
    const p = e["p"];
    const lap = e["lap"];
    const cl = e["classified"];
    if (
      !ids.has(e["d"] as string | null) ||
      seen.has(e["d"]) ||
      (t != null && (typeof t !== "number" || !Number.isFinite(t) || t < 0)) ||
      (p != null && (typeof p !== "number" || !Number.isFinite(p) || p < 0)) ||
      (lap != null && (!Number.isInteger(lap) || (lap as number) < 0 || (lap as number) > 255)) ||
      (cl != null && typeof cl !== "boolean")
    )
      return false;
    seen.add(e["d"]);
  }
  return true;
}

/** QUALI + QLIVE flood cap per connection, rolling window (f1-game #1414). */
export const QUALI_RATE = 12;
export const EVENT_WINDOW_MS = 1000;
export function rateGate(limit: number, windowMs = EVENT_WINDOW_MS): () => boolean {
  const times: number[] = [];
  return () => {
    const now = performance.now();
    while (times.length && now - (times[0] as number) > windowMs) times.shift();
    if (times.length >= limit) return false;
    times.push(now);
    return true;
  };
}

export interface QualiSink {
  onPeerQuali?(q: PeerQuali): void;
  onPeerQualiLive?(q: PeerQualiLive): void;
}

/** Register the QUALI/QLIVE receivers; `ownsDriver` is the caller's sender binding. */
export function bindQuali(
  s: Pick<NetSession, "onEvent">,
  ownsDriver: (q: PeerQuali | PeerQualiLive) => boolean,
  sink: QualiSink,
  onAccepted?: (type: EventName, q: PeerQuali | PeerQualiLive) => void,
): void {
  s.onEvent(EV.QUALI, (d) => {
    const q = validQuali(d);
    if (q && ownsDriver(q)) {
      if (sink.onPeerQuali) sink.onPeerQuali(q);
      if (onAccepted) onAccepted(EV.QUALI, q);
    }
  });
  s.onEvent(EV.QLIVE, (d) => {
    const q = validQualiLive(d);
    if (q && ownsDriver(q)) {
      if (sink.onPeerQualiLive) sink.onPeerQualiLive(q);
      if (onAccepted) onAccepted(EV.QLIVE, q);
    }
  });
}

/** A driven lap rides the reliable channel; the lap in progress is fire-and-forget. */
export function qualiReporters(broadcast: (type: EventName, data: unknown) => boolean, live: () => boolean) {
  return {
    reportQuali(driverId: unknown, t: number): boolean {
      if (!live() || !(t > 0)) return false;
      if (t === Infinity) return broadcast(EV.QUALI, { driverId, t: null, noTime: true });
      return broadcast(EV.QUALI, { driverId, t: +Number(t).toFixed(3) });
    },
    reportQualiLive(driverId: unknown, t: number, frac: number): boolean {
      if (!live() || !(t >= 0)) return false;
      return broadcast(EV.QLIVE, { driverId, t: +Number(t).toFixed(2), frac: +(Number(frac) || 0).toFixed(3) });
    },
  };
}

// ─── strategy (netplay.js:231-258) ──────────────────────────────────────────

export const STRATEGY_VERSION = 1;
let epochSerial = 0;
const DEFAULT_REVISION = "2026-09-coherence-1";

type StrategyKey = "tyreWear" | keyof NetStrategyFields;
const STRATEGY_FIELDS: ReadonlyArray<readonly [StrategyKey, number, number]> = [
  ["tyreWear", 0, 3],
  ["tyreWearF", 0, 3],
  ["tyreWearR", 0, 3],
  ["tyreTs", 0, 250],
  ["tyreTb", 0, 250],
  ["tyreGrain", 0, 1],
  ["tyreBlister", 0, 1],
  ["tyreLap0", 0, 1000],
  ["tyreStints", 0, 1000],
  ["pitStops", 0, 1000],
  ["pitT", 0, 30],
];

export interface StrategyState {
  version: number;
  physics: string;
  wire: number;
  track: string;
  fields: Partial<Record<StrategyKey, number>>;
  tyre: NetTyre | null;
  tread: number;
  pitState: PitState;
  pitArmed: boolean;
  epoch?: string;
}

export function strategyState(c: NetCar, wire: number, track: string, physics = DEFAULT_REVISION): StrategyState {
  const fields: Partial<Record<StrategyKey, number>> = {};
  for (const [k] of STRATEGY_FIELDS) {
    const v = c[k];
    if (typeof v === "number" && Number.isFinite(v)) fields[k] = v;
  }
  return { version: STRATEGY_VERSION, physics, wire, track, fields, tyre: c.tyre || null, tread: c.tread, pitState: c.pitState || "none", pitArmed: !!c.pitArmed };
}

const PIT_STATES: readonly PitState[] = ["none", "lane", "box", "out"];

export function applyStrategy(c: NetCar | null | undefined, d: unknown, physics = DEFAULT_REVISION): boolean {
  if (!c || !isObj(d) || d["version"] !== STRATEGY_VERSION || d["physics"] !== physics || !isObj(d["fields"])) return false;
  const fields = d["fields"];
  const tyre = d["tyre"];
  if (
    isObj(tyre) &&
    typeof tyre["id"] === "string" &&
    Number.isInteger(tyre["tread"]) &&
    (tyre["tread"] as number) >= 0 &&
    (tyre["tread"] as number) <= 2 &&
    typeof tyre["life"] === "number" &&
    Number.isFinite(tyre["life"]) &&
    tyre["life"] >= 0.3 &&
    tyre["life"] <= 1.2
  ) {
    const off = tyre["off"];
    const colour = tyre["colour"];
    c.tyre = {
      id: tyre["id"].slice(0, 64),
      code: String(tyre["code"] || "?").slice(0, 4),
      life: tyre["life"],
      tread: tyre["tread"] as number,
      off: typeof off === "number" && Number.isFinite(off) ? Math.max(-0.2, Math.min(0.2, off)) : 0,
      colour:
        Array.isArray(colour) && colour.length === 3
          ? (colour.map((v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5)) as [number, number, number])
          : [0.5, 0.5, 0.5],
    };
    c.tread = c.tyre.tread;
  } else if (Number.isInteger(d["tread"]) && (d["tread"] as number) >= 0 && (d["tread"] as number) <= 2) c.tread = d["tread"] as number;
  for (const [k, lo, hi] of STRATEGY_FIELDS) {
    const v = fields[k];
    if (typeof v === "number" && Number.isFinite(v)) c[k] = Math.max(lo, Math.min(hi, v));
  }
  if (PIT_STATES.includes(d["pitState"] as PitState)) c.pitState = d["pitState"] as PitState;
  c.pitArmed = d["pitArmed"] === true;
  return true;
}

// ─── NetPlay (netplay.js:259-1440) ──────────────────────────────────────────

/** A peer as the lobby hands it over (profile from HELLO). */
export interface NetPeer {
  readonly id?: string;
  readonly profile?: NetProfileRef | null;
  readonly mods?: unknown;
  readonly kind?: string;
  readonly role?: string;
}

/** The parts of a lobby profile the slot picker reads. */
export interface NetProfileRef {
  readonly team?: string;
  readonly driver?: number;
}

export interface SessionEntry {
  readonly id?: string;
  readonly session: NetSession;
  readonly kind?: string;
}

export interface StartOptions {
  readonly role?: NetRole;
  readonly transport?: NetEndpoint;
  readonly session?: NetSession;
  readonly sessions?: readonly SessionEntry[];
  readonly peers?: readonly NetPeer[];
  readonly peerProfile?: NetProfileRef | null;
  readonly peerMods?: unknown;
  /** Fixed delay; omitted = adaptive delay from INTERP_DELAY_MS. */
  readonly interpDelayMs?: number;
  /** Guest: draw the host's AI (default true). */
  readonly hostAi?: boolean;
  /** The lobby's "this race is over" hook, for LOCAL stops only. */
  readonly onStop?: () => void;
}

export type NetFail = { readonly ok: false; readonly error: string; readonly message?: string };
export type StartResult = NetFail | { readonly ok: true; readonly role: NetRole; readonly localId: number; readonly remoteId: number | undefined; readonly remoteIds: number[] };

export type InterpCar = WireCar & Record<string, unknown>;

interface Remote {
  car: NetCar;
  profile: NetProfileRef | null;
  heardAt: number | null;
  everHeard: boolean;
  stale: boolean;
  hostAi: boolean;
  interp: Interp<InterpCar>;
  smpSt?: Partial<InterpOut<InterpCar>>;
  smpPred?: Partial<InterpOut<InterpCar>>;
  smpClamp?: Partial<ClampedState>;
}

export interface NetPlayStatus {
  readonly active: boolean;
  readonly role: NetRole | null;
  readonly reason: string | null;
  readonly localId: number;
  readonly remoteId: number;
  readonly remotes: ReadonlyArray<{ id: number; wire: number; driverId: string | null; buffered: number; timing: InterpTiming }>;
  readonly slotFallback: string | null;
  readonly hostAi: number;
  readonly spectators: number;
  readonly stale: number[];
  readonly net: SessionStats | null;
  readonly buffered: number;
  readonly events: number;
  readonly peerLaps: number;
  readonly peerResult: boolean;
  readonly startPending: boolean;
}

export interface LapReport {
  readonly lap?: number;
  readonly time?: number | null;
  readonly best?: number | null;
  readonly code?: string;
  readonly driverId?: string | null;
  readonly fin?: number;
  readonly invalid?: boolean;
  readonly retired?: string;
  readonly [k: string]: unknown;
}

export interface NetPlay {
  start(opts?: StartOptions): StartResult;
  rejoin(opts: { id: string; session: NetSession }): NetFail | { ok: true; wire: number };
  stop(reason?: string | null): boolean;
  tick(now: number, poseAt?: number): void;
  ownsRaceControl(): boolean;
  ownsClassification(): boolean;
  hostStart(): boolean;
  reportLap(data: LapReport): boolean;
  reportResult(data: unknown): boolean;
  reportCaution(data: unknown): boolean;
  awaitingResult(now?: number): boolean;
  reportQuali(driverId: unknown, t: number): boolean;
  reportQualiLive(driverId: unknown, t: number, frac: number): boolean;
  awaitingStart(): boolean;
  peerLaps(): unknown[];
  peerResult(): ResultRow[] | null;
  lastResult(): ResultRow[] | null;
  /** updateCar consults this: a car posed from the network must not also be simulated. */
  owns(c: NetCar | null | undefined): boolean;
  rivalDriverIds(): string[];
  active(): boolean;
  role(): NetRole | null;
  predict(c: NetCar | null | undefined, now?: number): ClampedState | null;
  sendEvent(type: string, data?: unknown): boolean;
  onEvent(type: string, fn: (d: unknown, t: string) => void): boolean | NetSession;
  status(): NetPlayStatus;
  readonly EV: typeof EV;
}

const PEER_ONE = "peer";
const SETTLE_MS = 600;
/** A guest in ANOTHER APP when START is pressed cannot arm (netplay.js:430-436). */
const ARM_WAIT_MS = 45000;
const ARM_SAY_AFTER_MS = 4000;
const ARM_SAY_EVERY_MS = 6000;
/** NOBODY WAITS ON THE GRID FOR EVER (netplay.js:439-445). */
const HOLD_MAX_MS = ARM_WAIT_MS + 10000;
const ARMED_RESEND_MS = 1000;
const RESULT_WAIT_MS = 3000;
const PEER_LAPS_CAP = 64;

export function createNetPlay(G: NetPlayCtx): NetPlay {
  const physics = (): string => G.physicsRevision ?? DEFAULT_REVISION;
  const gears = (): number => G.gears ?? 8;
  const total = (): number => (G.track && G.track.length) || 0;
  const finishLap = (lap: unknown): number => {
    const n = Number(lap);
    const top = (G.lapsTarget || 0) + 1;
    return Number.isFinite(n) && n >= 1 ? Math.min(top, Math.floor(n)) : top;
  };

  const sessions = new Map<string, NetSession>();
  const peerEpochs = new Map<string, string>();
  const sessionKinds = new Map<string, PeerKind>();
  const peerInfo = new Map<string, NetPeer>();
  const departedPeers = new Map<string, { wire: number; car: NetCar; profile: NetProfileRef | null; mods: unknown }>();
  let epoch: string | null = null;

  function broadcastStrategy(data: StrategyState): void {
    for (const [id, s] of sessions) {
      const to = peerEpochs.get(id);
      if (to) {
        try {
          s.sendEvent(EV.STRATEGY, { ...data, epoch: to });
        } catch {
          /* peer closed */
        }
      }
    }
  }
  const sessionList = (): NetSession[] => [...sessions.values()];
  const pumpBuf: NetSession[] = [];
  let session: NetSession | null = null;
  function broadcast(type: string, data: unknown): boolean {
    let ok = false;
    for (const s of sessionList()) {
      try {
        ok = s.sendEvent(type, data) || ok;
      } catch {
        /* a dead session must not stop the rest */
      }
    }
    return ok;
  }
  const peerCar = new Map<string, number>(); // peerId -> wireId
  const remoteFor = (id: string): number | null => peerCar.get(id) ?? null;
  let role: NetRole | null = null;
  let active = false;
  let localCar: NetCar | null = null;
  let raceOpts: StartOptions | null = null;
  const remotes = new Map<number, Remote>();
  const remoteList = (): Remote[] => [...remotes.values()];
  /** GUEST ONLY: wireId -> remote for an AI car the HOST simulates. */
  const aiRemotes = new Map<number, Remote>();
  let publishN = 0;
  let aiReplicated = false;

  function makeRemote(car: NetCar, opts: StartOptions, extra: Partial<Remote>): Remote {
    return {
      car,
      profile: null,
      heardAt: null,
      everHeard: false,
      stale: false,
      hostAi: false,
      interp: createInterp<InterpCar>({
        total: total(),
        delayMs: opts.interpDelayMs != null ? opts.interpDelayMs : INTERP_DELAY_MS,
        adaptive: opts.interpDelayMs == null,
      }),
      ...extra,
    };
  }

  /** ONE scrub for every car that returns to the local AI (netplay.js:304-313). */
  function scrubForHandBack(car: NetCar): void {
    car._nOk = false;
    car.dnfAt = null;
    car.dnfWhy = null;
    car.incidentInvalidLap = true;
    car.lapTime = 0;
    car._secT0 = null;
  }
  function goLocal(r: Remote): void {
    r.stale = true;
    if (!r.hostAi) {
      r.car._nOwnerLap = r.car.lap;
      r.car._nOwnerS = r.car.s;
      r.car._nFallback = true;
    }
    if (!r.hostAi) G.setCarRole(r.car, false, false);
    r.car.netInput = null;
    scrubForHandBack(r.car);
  }
  function goWire(r: Remote): void {
    r.stale = false;
    if (!r.hostAi) {
      r.car.lap = r.car._nOwnerLap;
      r.car.s = r.car._nOwnerS;
      r.car._nFallback = false;
    }
    if (!r.hostAi) G.setCarRole(r.car, true, false);
  }

  let lastPublish = -Infinity;
  let lastStrategy = -Infinity;
  let lastPhaseA: number | undefined | null = null;
  let lastPhaseB: PitState | undefined | null = null;
  let lastPhaseC: boolean | undefined | null = null;
  let lastReason: string | null = null;
  let onStop: (() => void) | null = null;
  function runOnStop(reason: string | null | undefined): void {
    if (reason != null && reason !== "local") return;
    const f = onStop;
    onStop = null;
    if (f) {
      try {
        f();
      } catch (e) {
        netLog.warn("play onStop threw: " + (e instanceof Error ? e.message : String(e)));
      }
    }
  }
  let lastSlotFallback: string | null = null;
  /** A DEBUG CHANNEL, not gameplay (netplay.js:349-356). */
  let peerLaps: LapReport[] = [];
  let peerResult: ResultRow[] | null = null;
  let resultCars: NetCar[] | null = null;
  const eventLog: Array<{ type: string; data: unknown; from: string }> = [];

  const smp: TrackSample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 8 };

  function pickRemoteSlot(profile: NetProfileRef | null | undefined): NetCar | null {
    const cars = G.cars || [];
    const claimed = new Set(remoteList().map((r) => r.car));
    const free = (c: NetCar): boolean => !!c && !c.local && !claimed.has(c);
    lastSlotFallback = null;
    if (profile) {
      const exact = cars.find((c) => free(c) && c.team && c.team.id === profile.team && c.seat === profile.driver);
      if (exact) return exact;
      const sameTeam = cars.find((c) => free(c) && c.team && c.team.id === profile.team);
      if (sameTeam) {
        lastSlotFallback = "team";
        return sameTeam;
      }
      // A named profile that matches nobody must not steal a wrong-team car.
      lastSlotFallback = "profile-miss";
      return null;
    }
    lastSlotFallback = "any";
    return cars.find(free) || null;
  }

  /**
   * Every peer sorts the humans by wireId and lays that order into consecutive
   * boxes from the local player's slot, so all screens agree with no message
   * (netplay.js:376-433). A qualifying grid is already right: skip.
   */
  function separateGrid(): void {
    const cars = G.cars || [];
    const at = (pos: number): NetCar | undefined => cars.find((c) => c.gridPos === pos);
    const move = (car: NetCar, pos: number): void => {
      const held = at(pos);
      if (held && held !== car) G.swapGridSlots(car, held);
    };
    const humans = [localCar, ...remoteList().map((r) => r.car)].filter((c): c is NetCar => !!c).sort((a, b) => G.wireId(a) - G.wireId(b));
    if (humans.length < 2 || !localCar) return;
    if (G.gridPreOrdered) return;
    let first = localCar.gridPos;
    const last = cars.length; // gridPos is 1-based
    if (first + humans.length - 1 > last) first = Math.max(1, last - humans.length + 1);
    humans.forEach((c, i) => move(c, first + i));
  }

  const clamped: Partial<ClampedState> = {};
  /** A below-target finish is a lapped car taking an ALREADY raised flag. */
  function finishAllowed(lap: number): boolean {
    return lap > 1 && (role !== "host" || lap > G.lapsTarget || G.cars.some((c) => c.finished && !c.retired));
  }

  function poseRemote(c: NetCar, raw: Partial<WireState>): void {
    const st = clampWire(raw, total(), G.lapsTarget, clamped, gears());
    // HOST: a guest's lap is EARNED, not declared.
    if (role === "host") st.lap = gateLap(c, st, total(), G.raceT);
    c.s = st.s;
    c.x = st.x;
    c.xVis = st.x;
    c.head = st.head;
    c.speed = st.speed;
    c.gear = st.gear || 1;
    c.lap = st.lap || 0;
    c.deploying = !!st.deploying;
    c.offroad = !!st.offroad;
    c.onKerb = !!st.onKerb;
    c.braking = !!st.braking;

    const w = G.worldFromTrack(c.s, c.x);
    c.px = w.x;
    c.pz = w.z;

    const T = total();
    // LOCAL convention: prog = (lap-1)*total + s (netplay.js:458-465).
    c.prog = (c.lap - 1) * T + c.s;
    // A short finish may arrive before the winner's delayed pose. Hold it
    // briefly, never past a later real flag (netplay.js:466-484).
    if (c._nFinLap != null && c._nFinLap <= G.lapsTarget && c._nFin != null && Number.isFinite(c._nFin) && Math.abs(c._nFin - G.raceT) > FIN_SLACK_S) {
      c._nFin = null;
      c._nFinLap = null;
    }
    const finLap = c._nFin != null && Number.isFinite(c._nFin) && c._nFinLap != null ? c._nFinLap : G.lapsTarget + 1;
    if (!c.finished && !c.retired && G.lapsTarget > 0 && c.lap >= finLap && !st.extrapolated && finishAllowed(finLap)) {
      const pf = c._nFin;
      c.finished = true;
      c.finishT = pf != null && Number.isFinite(pf) && Math.abs(pf - G.raceT) <= FIN_SLACK_S ? pf : G.raceT;
      c._nFin = null;
      c._nFinLap = null;
      if (role === "host" && finLap <= G.lapsTarget && pf != null && Number.isFinite(pf)) {
        broadcast(EV.LAP, { lap: finLap, code: c.code, driverId: c.driverId, fin: c.finishT, invalid: true });
      }
    }

    if (G.track) {
      G.track.sample(c.s, smp);
      let psi = Math.atan2(smp.t[0], smp.t[2]) - c.head;
      while (psi > Math.PI) psi -= Math.PI * 2;
      while (psi < -Math.PI) psi += Math.PI * 2;
      c.yawVis = psi;
    }

    c.rPrevPx = c.px;
    c.rPrevPz = c.pz;
    c.rPrevS = c.s;
    c.rPrevX = c.x;
    c.rPrevHead = c.head;
    c.rPrevYawVis = c.yawVis;
    c._prevS = c.s;
  }

  function onState(bytes: WireData, from: NetSession | null, fromId: string | null, arrivedAt: number | undefined): void {
    if (!active || (!remotes.size && !aiRemotes.size)) return;
    const pkt = decodeSnapshot(bytes);
    if (!pkt || !pkt.cars.length) return;
    const clock = from || session;
    if (!clock) return;
    const t = clock.peerToLocal(pkt.tick);
    // AUTHORITY: the host checks the id on the wire against the id it filed for
    // the connection the packet arrived on (netplay.js:520-541).
    let ownOnly: number | null = null;
    if (role === "host" && fromId != null) {
      if (sessionKinds.get(fromId) === "spectator") return;
      ownOnly = remoteFor(fromId);
      if (ownOnly == null) return;
    }
    // ARRIVAL, not frame time.
    const arrival = arrivedAt != null && Number.isFinite(arrivedAt) ? arrivedAt : G.netNow;
    for (const entry of pkt.cars) {
      if (ownOnly != null && entry.id !== ownOnly) continue;
      const r = remotes.get(entry.id) || aiRemotes.get(entry.id);
      if (r && r.interp.push(t - (entry.age || 0), entry as InterpCar, arrival ?? undefined)) {
        r.heardAt = arrival != null && Number.isFinite(arrival) ? arrival : G.netNow != null ? G.netNow : r.heardAt;
        r.everHeard = true;
      }
    }
  }

  const closeWhy = new Map<string, string>();
  const leftWires = new Map<number, string>();
  const armedPeers = new Set<string>();

  function bindSession(id: string, s: NetSession): void {
    const qualiGate = rateGate(QUALI_RATE);
    function sendersOwnDriver(d: Record<string, unknown> | PeerQuali | PeerQualiLive, legacyLap = false): boolean {
      if (sessionKinds.get(id) === "spectator") return false;
      if (role !== "host") return true;
      const wid = remoteFor(id);
      const r = wid != null ? remotes.get(wid) : null;
      const dd = d as Record<string, unknown>;
      return !!(
        r &&
        r.car &&
        ((dd["driverId"] != null && dd["driverId"] === r.car.driverId) || (legacyLap && dd["driverId"] == null && dd["code"] != null && dd["code"] === r.car.code))
      );
    }
    s.clearHandlers();
    s.onState((bytes, at) => onState(bytes, s, id, at));
    s.onClose((closeReason: SessionCloseReason) => {
      let why: string = closeReason;
      // We close a BYE/incompatible peer ourselves: keep the real reason.
      const pinned = closeWhy.get(id);
      if (pinned != null) {
        why = pinned;
        closeWhy.delete(id);
      }
      sessions.delete(id);
      const carFor = remoteFor(id);
      const remote = carFor != null ? remotes.get(carFor) : null;
      const kind = sessionKinds.get(id);
      const info = peerInfo.get(id);
      armedPeers.delete(id);
      peerCar.delete(id);
      peerEpochs.delete(id);
      sessionKinds.delete(id);
      peerInfo.delete(id);
      // stop() closes remaining sockets after active=false: do not re-enter it.
      if (!active) {
        session = sessionList()[0] || null;
        return;
      }
      lastReason = why;
      // A PEER WITH NO GRID SLOT MUST NOT END THE RACE FOR EVERYONE.
      if (role === "host") {
        if (carFor != null) {
          if (kind !== "spectator" && remote) {
            departedPeers.set(id, { wire: carFor, car: remote.car, profile: (info && info.profile) || null, mods: info && info.mods });
          }
          handBackToAI(why, carFor);
        }
        // Star, not mesh: say so to the other guests, or the slot stays frozen.
        if (carFor != null) {
          leftWires.set(carFor, why || "peer_closed");
          broadcast(EV.LEFT, { wire: carFor, why: why || "peer_closed" });
        }
        if (armDeadline && allArmed()) nameTheMoment();
      } else stop(why || "peer_closed");
      session = sessionList()[0] || null;
    });
    for (const name of Object.values(EV)) {
      s.onEvent(name, (d) => {
        eventLog.push({ type: name, data: d, from: id });
        if (eventLog.length > 32) eventLog.shift();
        // A spectator may negotiate compatibility, never own a car or result.
        if (role === "host" && sessionKinds.get(id) === "spectator" && name !== EV.MODEL) return;
        const o = isObj(d) ? d : null;
        if (name === EV.MODEL) {
          if (!o || o["physics"] !== physics() || o["strategy"] !== STRATEGY_VERSION) {
            // ONE INCOMPATIBLE PEER IS ONE RIVAL, NOT THE SESSION.
            if (role === "host" && sessions.size > 1) {
              if (G.announce) G.announce("A RIVAL IS ON A DIFFERENT GAME VERSION — DROPPED", 4, "info");
              closeWhy.set(id, "incompatible_physics");
              try {
                s.close();
              } catch {
                /* already gone; onClose still runs */
              }
              closeWhy.delete(id);
            } else {
              if (G.announce) G.announce("GAME VERSIONS DIFFER — RELOAD BOTH GAMES", 4, "info");
              stop("incompatible_physics");
            }
            return;
          }
          const pe = o["epoch"];
          if (typeof pe === "string" && pe.length <= 64) {
            peerEpochs.set(id, pe);
            lastStrategy = -Infinity;
            if (!o["ack"]) s.sendEvent(EV.MODEL, { physics: physics(), strategy: STRATEGY_VERSION, epoch, ack: true });
          }
        }
        // Each receiver names a fresh race epoch.
        if (name === EV.STRATEGY && o && o["epoch"] === epoch && G.track && G.track.def && o["track"] === G.track.def.id) {
          const wire = o["wire"] as number;
          const r = remotes.get(wire);
          const authorized = role === "guest" || remoteFor(id) === wire;
          if (r && authorized && applyStrategy(r.car, o, physics()) && role === "host") broadcastStrategy(strategyState(r.car, wire, String(o["track"]), physics()));
        }
        if (name === EV.BYE) {
          lastReason = "bye";
          // A clean leave is one rival, not the session.
          if (role === "host" && sessions.size > 1) {
            closeWhy.set(id, "bye");
            try {
              s.close();
            } catch {
              /* already gone */
            }
            closeWhy.delete(id);
            lastReason = "bye";
          } else stop("bye");
        }
        // CLAMP THE WIRE VALUE; ONE START per race (netplay.js:694-106).
        if (name === EV.START && o && o["at"] != null && !ownsRaceControl() && !(startSeen && !G.netStart)) {
          const h = Number(o["hold"]);
          armStart(o["at"], Number.isFinite(h) ? Math.min(2, Math.max(0, h)) : 0.5);
        }
        if (name === EV.ARMED && role === "host") {
          // Only a peer that actually HOLDS a car may arm the start.
          if (!peerCar.has(id)) return;
          if (!armedPeers.has(id)) {
            for (const [wire, why] of leftWires) {
              try {
                s.sendEvent(EV.LEFT, { wire, why });
              } catch {
                /* a dead session is its own close */
              }
            }
          }
          armedPeers.add(id);
          if (armDeadline && allArmed()) nameTheMoment();
          // LATE ARMED: tell the kept moment again.
          else if (named) {
            try {
              s.sendEvent(EV.START, { at: named.at, hold: named.hold });
            } catch {
              /* a dead session must not stop naming it for the rest */
            }
          }
        }
        if (name === EV.LAP && o && sendersOwnDriver(o, true)) {
          peerLaps.push(o as LapReport);
          if (peerLaps.length > PEER_LAPS_CAP) peerLaps.splice(0, peerLaps.length - PEER_LAPS_CAP);
          const fin = Number(o["fin"]);
          const wid = remoteFor(id);
          const fr =
            role === "host"
              ? wid != null
                ? remotes.get(wid)
                : undefined
              : remoteList().find((x) => x.car.code === o["code"]) ||
                (o["epoch"] === epoch && typeof o["driverId"] === "string" ? [...aiRemotes.values()].find((x) => x.car.driverId === o["driverId"]) : undefined);
          const T = total();
          const lt = Number(o["time"]);
          const best = Number(o["best"]);
          const ltOk = !o["invalid"] && lapTimeOk(lt, T);
          const bestOk = lapTimeOk(best, T);
          const finLap = finishLap(o["lap"]);
          const finOk = finLap > 1 && Number.isFinite(fin) && fin > 0 && Math.abs(fin - (G.raceT || 0)) <= FIN_SLACK_S;
          if (fr && ltOk) fr.car.lastLap = lt;
          if (fr && bestOk && !(fr.car.best <= best)) fr.car.best = best;
          if (fr && finOk && !fr.car.retired) {
            // Only a car whose POSE is past its finishing crossing may finish.
            if ((fr.car._nFallback ? fr.car._nOwnerLap : fr.car.lap) >= finLap && finishAllowed(finLap)) {
              fr.car.finished = true;
              fr.car.finishT = fin;
              fr.car._nFin = null;
              fr.car._nFinLap = null;
            } else {
              fr.car._nFin = fin;
              fr.car._nFinLap = finLap;
            }
          }
          // A RETIREMENT is the owner's word too.
          const rv = o["retired"];
          const ret = typeof rv === "string" && rv ? rv.slice(0, 32) : null;
          if (fr && ret && !fr.car.finished && !fr.car.retired) {
            if (fr.hostAi && G.retireCar) G.retireCar(fr.car, ret);
            fr.car.retired = true;
            fr.car.dnf = ret;
            fr.car.dnfAt = null;
            fr.car._nFin = null;
            fr.car._nFinLap = null;
          }
          // STAR RELAY: the host's checked copy, to everyone but the sender.
          if (role === "host" && fr) {
            const ownerLap = Number(o["lap"]);
            const lapOut = Number.isFinite(ownerLap) ? Math.floor(ownerLap) : fr.car.lap;
            const out = {
              lap: lapOut,
              time: ltOk ? lt : null,
              best: bestOk ? best : null,
              code: fr.car.code,
              driverId: fr.car.driverId,
              fin: finOk && finishAllowed(finLap) ? fin : undefined,
              invalid: !!o["invalid"],
              retired: ret || undefined,
            };
            for (const [sid, os] of sessions) {
              if (sid !== id) {
                try {
                  os.sendEvent(EV.LAP, out);
                } catch {
                  /* peer closed */
                }
              }
            }
          }
        }
        if (name === EV.RESULT && !ownsClassification() && validClassification(d, G.cars)) peerResult = d;
        // Only the host speaks for the roster.
        const wire = o ? o["wire"] : undefined;
        if (name === EV.LEFT && role === "guest" && typeof wire === "number" && Number.isFinite(wire) && remotes.has(wire)) {
          if (aiReplicated) {
            // The HOST's AI drives that car now: pose it from the wire.
            const r = remotes.get(wire) as Remote;
            G.setCarRole(r.car, false, false);
            r.car._nHuman = false;
            r.car._nFallback = false;
            remotes.delete(wire);
            r.hostAi = true;
            r.stale = false;
            aiRemotes.set(wire, r);
            if (G.announce) G.announce("RIVAL DISCONNECTED", 2);
          } else handBackToAI(typeof o?.["why"] === "string" ? (o["why"] as string) : "peer_closed", wire);
        }
        if (name === EV.REJOIN && role === "guest" && typeof wire === "number" && Number.isFinite(wire) && aiRemotes.has(wire)) {
          const r = aiRemotes.get(wire) as Remote;
          aiRemotes.delete(wire);
          r.hostAi = false;
          r.stale = false;
          r.car._nHuman = true;
          r.car._nFallback = false;
          G.setCarRole(r.car, true, false);
          remotes.set(wire, r);
        }
        if (name === EV.CAUTION && o && !ownsRaceControl() && G.applyCaution) G.applyCaution(o);
      });
    }
    bindQuali(s, (d) => (role !== "host" || qualiGate()) && sendersOwnDriver(d), G);
  }

  function handBackToAI(reason: string | null, id?: number): void {
    if (id == null) {
      // Whole session over: the local AI resumes every car from its last pose.
      for (const r of aiRemotes.values()) scrubForHandBack(r.car);
      aiRemotes.clear();
    }
    const gone = id == null ? remoteList() : [remotes.get(id)].filter((r): r is Remote => !!r);
    for (const r of gone) {
      r.car._nHuman = false;
      r.car._nFallback = false;
      G.setCarRole(r.car, false, false);
      r.car.netInput = null;
      scrubForHandBack(r.car);
      remotes.delete(G.wireId(r.car));
    }
    if (reason && gone.length && G.announce) {
      G.announce(role === "guest" && id == null ? "HOST LEFT — RIVALS NOW AI" : "RIVAL DISCONNECTED", 2);
    }
  }

  function start(opts: StartOptions = {}): StartResult {
    // start() ADOPTS the supplied sessions; a live race cannot be replaced.
    if (active) {
      netLog.warn("play start fail already_active");
      return { ok: false, error: "already_active", message: "A network race is already active." };
    }
    peerLaps = [];
    peerResult = null;
    resultCars = G.cars;
    resultWaitFrom = null;
    if (!opts.transport && !opts.session && !opts.sessions) {
      netLog.warn("play start fail no_transport");
      return { ok: false, error: "no_transport", message: "No connection to race over." };
    }
    if (!G.track) {
      netLog.warn("play start fail no_track");
      return { ok: false, error: "no_track", message: "Load a track before starting a session." };
    }

    role = opts.role === "host" ? "host" : opts.role === "spectator" ? "spectator" : "guest";
    raceOpts = opts;
    onStop = typeof opts.onStop === "function" ? opts.onStop : null;
    const peerProfile = opts.peerProfile || null;
    sessions.clear();
    peerEpochs.clear();
    sessionKinds.clear();
    peerInfo.clear();
    departedPeers.clear();
    epoch = Date.now().toString(36) + "-" + ++epochSerial;
    const incoming: readonly SessionEntry[] =
      opts.sessions ||
      (opts.session ? [{ id: PEER_ONE, session: opts.session }] : null) ||
      [{ id: PEER_ONE, session: createSession({ transport: opts.transport as NetEndpoint }) }];
    localCar = role === "spectator" ? null : (G.cars || []).find((c) => c.local) || G.player || null;
    remotes.clear();
    // An empty or profile-less join must still fall through to the
    // any-free-car arm (netplay.js:288-303).
    const joining: NetPeer[] = (
      opts.peers && opts.peers.length
        ? [...opts.peers]
        : opts.sessions && opts.sessions.length
          ? opts.sessions.map((e) => ({ profile: null, mods: null, kind: Spectate.kind(e), id: e.id != null ? e.id : PEER_ONE }))
          : [{ profile: peerProfile, mods: opts.peerMods, id: PEER_ONE }]
    ).filter((peer) => !Spectate.isSpectator(peer));
    const hasSpectator = incoming.some((entry) => {
      const id = entry.id != null ? entry.id : PEER_ONE;
      return Spectate.isSpectator((opts.peers || []).find((peer) => peer.id === id) || entry);
    });
    peerCar.clear();
    for (const j of role === "spectator" ? [] : joining) {
      const car = pickRemoteSlot(j.profile);
      if (!car) continue;
      peerCar.set(j.id != null ? j.id : PEER_ONE, G.wireId(car));
      G.setCarRole(car, true, false);
      car._nHuman = true;
      car._nFallback = false;
      car._nFin = null;
      car._nFinLap = null;
      car._nMid = false;
      car._nRiseT = null;
      car.mods = j.mods || car.mods || null;
      remotes.set(G.wireId(car), makeRemote(car, opts, { profile: j.profile || null }));
    }
    if ((role !== "spectator" && (!localCar || (!remotes.size && !(role === "host" && hasSpectator)))) || (role === "spectator" && !(G.cars || []).length)) {
      // A failed adoption must not leave handlers or sockets alive.
      handBackToAI(null);
      peerCar.clear();
      const closed = new Set<NetSession>();
      for (const entry of incoming) {
        const s = entry.session;
        if (!s || closed.has(s)) continue;
        closed.add(s);
        try {
          s.clearHandlers();
        } catch {
          /* a failed adoption must still be discarded */
        }
        try {
          s.close();
        } catch {
          /* already gone */
        }
      }
      localCar = null;
      session = null;
      netLog.warn("play start fail no_slot");
      return { ok: false, error: "no_slot", message: "Could not find a grid slot for both drivers." };
    }

    for (const entry of incoming) {
      const id = entry.id != null ? entry.id : PEER_ONE;
      const s = entry.session;
      sessions.set(id, s);
      const info: NetPeer = (opts.peers || []).find((p) => p.id === id) || entry;
      sessionKinds.set(id, Spectate.kind(info));
      peerInfo.set(id, info);
      bindSession(id, s);
      // The race's silence grace; the lobby's 6 s stays the lobby's.
      s.setTimeoutMs(RACE_GRACE_MS);
    }
    session = sessionList()[0] || null;
    if (role !== "spectator") separateGrid();

    // AI REPLICATION, guest side: every car that is neither ours nor a human
    // rival's is the HOST's to simulate.
    aiRemotes.clear();
    aiReplicated = (role === "guest" || role === "spectator") && opts.hostAi !== false;
    if (aiReplicated) {
      for (const c of G.cars || []) {
        const wid = G.wireId(c);
        if (c === localCar || wid < 0 || remotes.has(wid) || (role !== "spectator" && c.human)) continue;
        aiRemotes.set(wid, makeRemote(c, opts, { hostAi: true }));
      }
    }
    publishN = 0;

    lastPublish = -Infinity;
    lastStrategy = -Infinity;
    lastPhaseA = lastPhaseB = lastPhaseC = null;
    lastReason = null;
    armedPeers.clear();
    leftWires.clear();
    armDeadline = 0;
    armedSentAt = -Infinity;
    startSeen = false;
    named = null;
    holdUntil = 0;
    G.netNow = null;
    active = true;
    broadcast(EV.MODEL, { physics: physics(), strategy: STRATEGY_VERSION, epoch });
    if (role === "guest") {
      try {
        broadcast(EV.ARMED, {});
      } catch {
        /* a dead session must not stop start() */
      }
    }
    netLog.info("play start " + role + " n=" + remotes.size);
    const ids = remoteList().map((r) => G.cars.indexOf(r.car));
    return { ok: true, role, localId: localCar ? G.cars.indexOf(localCar) : -1, remoteId: ids[0], remoteIds: ids };
  }

  /** Adopt a replacement connection for a driver this host already seated (netplay.js:394-421). */
  function rejoin(opts: { id: string; session: NetSession }): NetFail | { ok: true; wire: number } {
    if (!active || role !== "host") return { ok: false, error: "not_host" };
    const id = opts.id;
    const s = opts.session;
    const gone = departedPeers.get(id);
    if (!gone || !s || sessions.has(id)) return { ok: false, error: "unknown_peer" };
    const wire = gone.wire;
    const car = gone.car;
    const info: NetPeer = { id, profile: gone.profile || null, mods: gone.mods || null, kind: "driver" };
    peerCar.set(id, wire);
    peerInfo.set(id, info);
    sessionKinds.set(id, "driver");
    sessions.set(id, s);
    G.setCarRole(car, true, false);
    car._nHuman = true;
    car._nFallback = false;
    remotes.set(wire, makeRemote(car, raceOpts || {}, { profile: gone.profile || null }));
    bindSession(id, s);
    s.setTimeoutMs(RACE_GRACE_MS);
    try {
      s.sendEvent(EV.MODEL, { physics: physics(), strategy: STRATEGY_VERSION, epoch });
    } catch {
      /* replacement already closed */
    }
    leftWires.delete(wire);
    departedPeers.delete(id);
    broadcast(EV.REJOIN, { wire });
    session = sessionList()[0] || null;
    lastReason = null;
    lastStrategy = -Infinity;
    return { ok: true, wire };
  }

  // ONE clock for the whole countdown (netplay.js:424-429).
  const nowMs = (): number => (G.netNow != null ? G.netNow : performance.now());
  let armSince = 0;
  let armSaidAt = 0;
  let holdUntil = 0; // both roles: when we count down alone
  let armDeadline = 0; // host: when to stop waiting for ARMED
  let armedSentAt = -Infinity; // guest: when ARMED last went out
  /** Guest: a START has been ACCEPTED this race (netplay.js:450-459). */
  let startSeen = false;
  let named: { at: number; hold: number } | null = null;
  const allArmed = (): boolean => armedPeers.size >= remotes.size;

  /** CLAMP THE WIRE MOMENT TOO: a moment we cannot count down to is ignored (netplay.js:466-483). */
  function armStart(atPeerMs: unknown, hold: number): void {
    const peerAt = Number(atPeerMs);
    if (!Number.isFinite(peerAt)) return;
    const at = session ? session.peerToLocal(peerAt) : peerAt;
    if (!Number.isFinite(at) || Math.abs(at - nowMs()) > HOLD_MAX_MS) return;
    G.netStart = { at, hold, now: nowMs };
    startSeen = true;
  }

  /** The moment cannot be named until BOTH sides can act on it (netplay.js:485-502). */
  function hostStart(): boolean {
    if (role !== "host" || !session) return false;
    if (!allArmed()) {
      armSince = nowMs();
      armSaidAt = 0;
      armDeadline = armSince + ARM_WAIT_MS;
      return true;
    }
    return nameTheMoment();
  }

  function nameTheMoment(): boolean {
    if (role !== "host" || !session) return false;
    armDeadline = 0;
    const hold = 0.2 + Math.random() * 1.8;
    // `at` goes out in THE HOST'S OWN CLOCK; the guest converts ONCE.
    const at = nowMs() + (G.COUNTDOWN_S + hold) * 1000 + SETTLE_MS;
    for (const s of sessionList()) {
      try {
        s.sendEvent(EV.START, { at, hold });
      } catch {
        /* a dead session must not stop naming it for the rest */
      }
    }
    named = { at, hold };
    G.netStart = { at, hold, now: nowMs };
    return true;
  }

  const { reportQuali, reportQualiLive } = qualiReporters(broadcast, () => sessions.size > 0 && Spectate.canPublish(role));

  function reportLap(data: LapReport): boolean {
    if (!Spectate.canPublish(role)) return false;
    // AI retirements bind to each receiver's race epoch.
    if (role === "host" && data && data.retired) {
      let sent = false;
      for (const [id, s] of sessions) {
        const to = peerEpochs.get(id);
        try {
          sent = s.sendEvent(EV.LAP, { ...data, epoch: to }) || sent;
        } catch {
          /* peer closed */
        }
      }
      return sent;
    }
    return sessions.size ? broadcast(EV.LAP, data) : false;
  }
  const reportCaution = (data: unknown): boolean => (sessions.size && role === "host" ? broadcast(EV.CAUTION, data) : false);
  const reportResult = (data: unknown): boolean => (sessions.size && Spectate.canPublish(role) ? broadcast(EV.RESULT, data) : false);

  /** The GUEST holds the flag briefly for the host's classification (netplay.js:1152-1166). */
  let resultWaitFrom: number | null = null;
  function awaitingResult(now?: number): boolean {
    if (!active || role !== "guest" || peerResult) return false;
    const t = now != null ? now : G.netNow || 0;
    if (resultWaitFrom == null) resultWaitFrom = t;
    return t - resultWaitFrom < RESULT_WAIT_MS;
  }

  function stop(reason?: string | null): boolean {
    if (!active) {
      lastReason = null;
      runOnStop(reason);
      return false;
    }
    active = false;
    lastReason = reason || "local";
    netLog.info("play stop " + lastReason);
    // A local stop announces itself before the sockets go.
    if (reason == null || reason === "local") broadcast(EV.BYE, {});
    handBackToAI(reason && reason !== "local" ? reason : null);
    for (const s of sessionList()) {
      try {
        s.close();
      } catch {
        /* already gone */
      }
    }
    sessions.clear();
    peerEpochs.clear();
    sessionKinds.clear();
    peerInfo.clear();
    departedPeers.clear();
    peerCar.clear();
    session = null;
    armDeadline = 0;
    named = null;
    holdUntil = 0;
    G.netNow = null;
    // A quit mid-lights must not leave a past-dated netStart behind.
    G.netStart = null;
    armedPeers.clear();
    leftWires.clear();
    startSeen = false;
    runOnStop(reason);
    return true;
  }

  const pubOwn: { id: number; car: NetCar | null } = { id: -1, car: null };
  const relay: AgedEntry[] = [];
  const poseMaps = [remotes, aiRemotes];

  /**
   * `poseAt` (optional): when the local car's pose is, on the same clock as
   * `now` — the game loop publishes last frame's physics (netplay.js:1205-1208).
   */
  function tick(now: number, poseAt?: number): void {
    if (!active || !sessions.size) return;
    G.netNow = now;
    if (!holdUntil) holdUntil = now + HOLD_MAX_MS;
    // pump() can deliver the close that ends a session: iterate a SNAPSHOT.
    pumpBuf.length = 0;
    for (const s of sessions.values()) pumpBuf.push(s);
    for (const s of pumpBuf) s.pump(now);
    if (!active || !sessions.size) return;
    session = sessions.values().next().value ?? null;

    if (armDeadline && now >= armDeadline) nameTheMoment();
    else if (armDeadline && now - armSince >= ARM_SAY_AFTER_MS && now - armSaidAt >= ARM_SAY_EVERY_MS && G.announce) {
      armSaidAt = now;
      G.announce("WAITING FOR RIVAL — " + Math.ceil((armDeadline - now) / 1000) + " s", 2, "info");
    }
    // A guest's first ARMED can land in the host's LOBBY session: say it again.
    if (role === "guest" && !G.netStart && !startSeen && now - armedSentAt >= ARMED_RESEND_MS) {
      armedSentAt = now;
      try {
        broadcast(EV.ARMED, {});
      } catch {
        /* a dead session must not stop the tick */
      }
    }

    let anyAlive = false;
    for (const s of sessions.values()) {
      if (s.alive()) {
        anyAlive = true;
        break;
      }
    }
    if (!anyAlive) return;

    const T = total();
    // Pose remotes FIRST: the host relay encodes r.car (netplay.js:1278-1281).
    for (const map of poseMaps) {
      for (const r of map.values()) {
        // SILENCE: past STALE_MS the local AI drives the car.
        if (r.heardAt == null) r.heardAt = now;
        const quiet = now - r.heardAt > (r.hostAi || r.everHeard ? STALE_MS : HOLD_MAX_MS);
        if (quiet !== r.stale) {
          if (quiet) goLocal(r);
          else goWire(r);
        }
        if (r.stale) continue;
        const st = r.interp.sample(now, r.smpSt || (r.smpSt = {}));
        if (st) poseRemote(r.car, st);
        const raw = r.interp.predict(now, r.smpPred || (r.smpPred = {}));
        const c = r.car;
        if (raw) {
          const pred = clampWire(raw, T, G.lapsTarget, r.smpClamp || (r.smpClamp = {}), gears());
          if (role === "host" && pred.lap > (c.lap || 0) + 1) pred.lap = (c.lap || 0) + 1; // gateLap's bound
          c._nOk = true;
          c._nProg = (pred.lap - 1) * T + pred.s;
          c._nX = pred.x;
          c._nSpd = pred.speed;
        } else {
          c._nOk = false;
        }
      }
    }

    // Three compared scalars, not a joined key (netplay.js:1319-1322).
    const phaseA = localCar ? localCar.tyreStints : undefined;
    const phaseB = localCar ? localCar.pitState : undefined;
    const phaseC = localCar ? localCar.pitArmed : undefined;
    const phaseChanged = phaseA !== lastPhaseA || phaseB !== lastPhaseB || phaseC !== lastPhaseC;
    if (localCar && G.track && G.track.def && (now - lastStrategy >= 1000 || phaseChanged)) {
      const peerArrived = lastStrategy === -Infinity;
      lastStrategy = now;
      lastPhaseA = phaseA;
      lastPhaseB = phaseB;
      lastPhaseC = phaseC;
      broadcastStrategy(strategyState(localCar, G.wireId(localCar), G.track.def.id, physics()));
      // Resend the host's terminal AI state once per arriving peer.
      if (role === "host" && peerArrived) {
        for (const c of G.cars || []) {
          if (!c.local && !c.human && c.retired) reportLap({ lap: c.lap, code: c.code, driverId: c.driverId, retired: c.dnf || "mechanical", invalid: true });
        }
      }
    }
    // A HIDDEN TAB PUBLISHES NOTHING: its pose is frozen at speed.
    const hidden = typeof document !== "undefined" && !!document && document.hidden === true;
    if (localCar && Spectate.canPublish(role) && !hidden && now - lastPublish >= PUBLISH_MS) {
      // A FIXED 20 Hz: advance by the period; after a long stall restart the phase.
      lastPublish = now - lastPublish > 2 * PUBLISH_MS ? now : lastPublish + PUBLISH_MS;
      pubOwn.id = G.wireId(localCar);
      pubOwn.car = localCar;
      const at = poseAt != null && Number.isFinite(poseAt) && poseAt <= now && now - poseAt <= POSE_AGE_MAX_MS ? poseAt : now;
      const bytes = encodeSnapshot(Math.round(at), [{ id: pubOwn.id, car: localCar }]);
      for (const s of sessions.values()) {
        try {
          s.sendState(bytes);
        } catch {
          /* a dead session must not stop the others' publish */
        }
      }
      // THE RELAY: ONE DATAGRAM PER GUEST, every other player's car in it, and
      // every AI_EVERY-th publish the host's AI field (netplay.js:1349-1381).
      const withAi = role === "host" && ++publishN % AI_EVERY === 0;
      if (role === "host" && (sessions.size > 1 || withAi)) {
        relay.length = 0;
        if (sessions.size > 1) {
          for (const r of remotes.values()) {
            const id = G.wireId(r.car);
            const pAt = r.interp.presentedAt();
            if (r.stale || id < 0 || !Number.isFinite(pAt)) continue;
            if (r.heardAt != null && now - r.heardAt > RELAY_FRESH_MS) continue;
            relay.push({ id, car: r.car, at: pAt });
          }
        }
        if (withAi) {
          for (const c of G.cars || []) {
            if (c === localCar) continue;
            const id = G.wireId(c);
            const r = id >= 0 ? remotes.get(id) : null;
            if (id < 0 || r) continue; // human owner poses are relayed above
            relay.push({ id, car: c, at });
          }
        }
        if (relay.length) {
          for (const [sid, s] of sessions) {
            const own = remoteFor(sid);
            const forGuest = relay.filter((e) => e.id !== own); // never back to its own driver
            if (!forGuest.length) continue;
            try {
              s.sendState(encodeAged(forGuest));
            } catch {
              /* as above */
            }
          }
        }
      }
    }
  }

  /** Both true when racing solo: no session must behave exactly as before. */
  function ownsRaceControl(): boolean {
    return !active || role === "host";
  }
  function ownsClassification(): boolean {
    return !active || role === "host";
  }

  return {
    start,
    rejoin,
    stop,
    tick,
    ownsRaceControl,
    ownsClassification,
    hostStart,
    reportLap,
    reportResult,
    reportCaution,
    awaitingResult,
    reportQuali,
    reportQualiLive,
    awaitingStart: () => active && !G.netStart && (role === "guest" || armDeadline > 0) && (!holdUntil || nowMs() < holdUntil),
    peerLaps: () => peerLaps.slice(),
    peerResult: () => peerResult,
    // The host's RESULT after its session ended, for the field it classifies (f1-game #2199).
    lastResult: () => (!active && role === "guest" && lastReason !== "local" && G.cars === resultCars ? peerResult : null),
    owns: (c) => {
      if (!active || c == null) return false;
      const id = G.wireId(c);
      const r = remotes.get(id) || aiRemotes.get(id);
      return !!r && r.car === c && !r.stale; // a silent rival is the local AI's until it speaks
    },
    rivalDriverIds: () => remoteList().map((r) => r.car.driverId).filter((x): x is string => x != null),
    active: () => active,
    role: () => role,
    predict: (c, now) => {
      if (!active) return null;
      const r = c == null ? remoteList()[0] : remotes.get(G.wireId(c));
      const raw = r ? r.interp.predict(now == null ? nowMs() : now) : null;
      return raw ? clampWire(raw, total(), G.lapsTarget, undefined, gears()) : null;
    },
    sendEvent: (type, data) => (sessions.size && Spectate.canPublish(role) ? broadcast(type, data) : false),
    onEvent: (type, fn) => (session ? session.onEvent(type, fn) : false),
    status: () => ({
      active,
      role,
      reason: lastReason,
      localId: localCar ? G.cars.indexOf(localCar) : -1,
      remoteId: remoteList().length ? G.cars.indexOf((remoteList()[0] as Remote).car) : -1,
      remotes: remoteList().map((r) => ({ id: G.cars.indexOf(r.car), wire: G.wireId(r.car), driverId: r.car.driverId, buffered: r.interp.size(), timing: r.interp.timing() })),
      slotFallback: lastSlotFallback,
      hostAi: aiRemotes.size,
      spectators: [...sessionKinds.values()].filter((k) => k === "spectator").length,
      stale: [...remotes.values(), ...aiRemotes.values()].filter((r) => r.stale).map((r) => G.wireId(r.car)),
      net: session ? session.stats() : null,
      buffered: remoteList().length ? (remoteList()[0] as Remote).interp.size() : 0,
      events: eventLog.length,
      peerLaps: peerLaps.length,
      peerResult: !!peerResult,
      startPending: !!G.netStart,
    }),
    EV,
  };
}
