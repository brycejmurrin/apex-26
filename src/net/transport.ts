/**
 * The wire under multiplayer, and the seam that keeps the netcode testable.
 * Port of f1-game js/net/transport.js:1-704 (NetTransport).
 *
 * TWO CHANNELS, because the two kinds of traffic want opposite things:
 * "state" (unreliable/unordered: snapshots and inputs; a late packet is
 * worthless) and "event" (reliable/ordered: lobby, start tick, laps, results).
 * `loopback()` wires two endpoints in one process with injectable latency,
 * jitter and loss; `rtc()` is the real RTCPeerConnection. Both deliver only on
 * `pump()`, so latency and loss are reproducible rather than wall-clock.
 *
 * localStorage keys are `a26.`-prefixed (AGENTS.md §Code rules); f1-game reads
 * the same settings from `apex26.turnApi`, `apex26.turn`, `apex26.freeTurn` and
 * `apex26.iceRelayOnly`.
 */
import { bytesToB64 } from "./bytes";
import { netLog, netLogEnabled } from "./log";

export const STATE = "state";
export const EVENT = "event";
export type Channel = typeof STATE | typeof EVENT;
const CHANNELS: readonly Channel[] = [STATE, EVENT];

/** What a DataChannel may carry. */
export type WireData = string | ArrayBuffer | ArrayBufferView | Blob;

export type EndpointStatus = "connecting" | "open" | "closing" | "closed";

/**
 * Why an endpoint closed: `local` (our close()), `peer` (the far end or a
 * channel close), `overflow` (inbox cap, rtc only), or the RTCPeerConnection's
 * terminal state.
 */
export type CloseReason = "local" | "peer" | "overflow" | "failed" | "closed" | "disconnected";

/** `at`: the rtc ARRIVAL stamp (performance.now()); loopback passes undefined. */
export type MessageHandler = (channel: Channel, data: WireData, at: number | undefined) => void;

/**
 * The surface both implementations expose, so the session layer never learns
 * which one it is on (transport.js:67-88).
 */
export interface NetEndpoint {
  readonly name: string;
  readonly status: EndpointStatus;
  onMessage(fn: MessageHandler): this;
  onOpen(fn: () => void): this;
  onClose(fn: (reason: CloseReason) => void): this;
  /** How long a transient "disconnected" may last before the wire closes. Only rtc has one. */
  setDisconnectGrace(ms: number): number;
  send(channel: Channel, data: WireData): boolean;
  /** Deliver everything due; returns the number of messages handed over. */
  pump(now: number): number;
  close(): void;
  stats(): object;
}

export interface LoopbackStats {
  readonly dropped: number;
  readonly delivered: number;
  readonly queued: number;
  readonly wire: number;
}

export interface LoopbackEndpoint extends NetEndpoint {
  stats(): LoopbackStats;
}

export interface CandidateCounts {
  host: number;
  srflx: number;
  relay: number;
  mdns: number;
}

export interface RtcStats {
  readonly queued: number;
  readonly queuedBytes: number;
  readonly connection: RTCPeerConnectionState;
  readonly ice: RTCIceConnectionState;
  readonly gathering: RTCIceGatheringState;
  readonly candidates: CandidateCounts;
  /** Whether THIS PeerConnection was built with a TURN entry (not hasRelay() later). */
  readonly turn: boolean;
  readonly ownTurn: boolean;
}

export interface RtcEndpoint extends NetEndpoint {
  readonly pc: RTCPeerConnection;
  stats(): RtcStats;
}

// ─── shared endpoint plumbing (transport.js:67-88) ──────────────────────────

interface Emitter {
  message(channel: Channel, data: WireData, at: number | undefined): void;
  open(): void;
  close(reason: CloseReason): void;
}

interface EndpointBase {
  status: EndpointStatus;
  readonly emit: Emitter;
  readonly handlers: {
    readonly onMessage: (fn: MessageHandler) => void;
    readonly onOpen: (fn: () => void) => void;
    readonly onClose: (fn: (reason: CloseReason) => void) => void;
  };
}

function makeBase(): EndpointBase {
  const message: MessageHandler[] = [];
  const open: Array<() => void> = [];
  const close: Array<(reason: CloseReason) => void> = [];
  // A throwing handler must not take down the transport or stop the
  // remaining handlers — a rendering bug upstream would otherwise read as a
  // dropped connection (transport.js:81-86).
  const each = <F extends (...a: never[]) => void>(list: readonly F[], call: (fn: F) => void): void => {
    for (const fn of list) {
      try {
        call(fn);
      } catch {
        /* handler's problem */
      }
    }
  };
  return {
    status: "connecting",
    emit: {
      message: (ch, data, at) => each(message, (fn) => fn(ch, data, at)),
      open: () => each(open, (fn) => fn()),
      close: (reason) => each(close, (fn) => fn(reason)),
    },
    handlers: {
      onMessage: (fn) => void message.push(fn),
      onOpen: (fn) => void open.push(fn),
      onClose: (fn) => void close.push(fn),
    },
  };
}

/**
 * A REPRODUCIBLE `rnd` for loopback's loss/jitter (transport.js:90-99).
 * Math.random makes a lossy link a coin flip the caller cannot re-run.
 */
export function seededRnd(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0x100000000;
  };
}

// ─── loopback (transport.js:101-193) ────────────────────────────────────────

export interface LoopbackOptions {
  readonly latencyMs?: number;
  readonly jitterMs?: number;
  /** Share of STATE packets dropped, 0..1. EVENT is never dropped. */
  readonly loss?: number;
  readonly rnd?: () => number;
}

interface Queued {
  readonly at: number;
  readonly to: LoopSide;
  readonly channel: Channel;
  readonly data: WireData;
  readonly seq: number;
}

interface LoopSide {
  readonly base: EndpointBase;
  epoch: number | null;
  wire: number;
  lastEventAt: number;
  closing: boolean;
}

/**
 * Two endpoints wired together IN ONE PAGE. Each endpoint pumps with ITS OWN
 * clock (two browsers share no clock): its first pump establishes its epoch,
 * and everything queued is scheduled in the neutral wire time that follows
 * from it. Both endpoints must therefore start pumping at the same real
 * moment: pump each one before sending anything (transport.js:113-129).
 */
export function loopback(opts: LoopbackOptions = {}): [LoopbackEndpoint, LoopbackEndpoint] {
  const latency = opts.latencyMs != null ? opts.latencyMs : 50;
  const jitter = opts.jitterMs != null ? opts.jitterMs : 0;
  const loss = opts.loss || 0;
  const rnd = opts.rnd || Math.random;

  let queue: Queued[] = [];
  let seq = 0;
  let dropped = 0;
  let delivered = 0;

  const side = (): LoopSide => ({ base: makeBase(), epoch: null, wire: 0, lastEventAt: 0, closing: false });
  const sa = side();
  const sb = side();

  function wireNow(ep: LoopSide, localNow: number): number {
    if (ep.epoch == null) ep.epoch = localNow;
    ep.wire = localNow - ep.epoch;
    return ep.wire;
  }

  function enqueue(from: LoopSide, to: LoopSide, channel: Channel, data: WireData): void {
    if (channel === STATE) {
      if (loss > 0 && rnd() < loss) {
        dropped++;
        return;
      }
    }
    let at = (from.wire || 0) + latency + (jitter ? (rnd() * 2 - 1) * jitter : 0);
    // EVENT is reliable AND ordered on the real wire (SCTP ordered): jitter
    // must not reorder it here (transport.js:136-139).
    if (channel === EVENT) {
      at = Math.max(at, to.lastEventAt || 0);
      to.lastEventAt = at;
    }
    queue.push({ at, to, channel, data, seq: seq++ });
  }

  function deliverTo(self: LoopSide, localNow: number): number {
    const t = wireNow(self, localNow);
    if (!queue.length) return 0;
    queue.sort((p, q) => p.at - q.at || p.seq - q.seq);
    const held: Queued[] = [];
    let n = 0;
    for (const m of queue) {
      // A handler may close this endpoint mid-walk (BYE → stop): what is left
      // for a closed endpoint is dropped, as the real wire drops it.
      if (m.to.base.status === "closed") continue;
      if (m.to === self && m.at <= t) {
        m.to.base.emit.message(m.channel, m.data, undefined);
        delivered++;
        n++;
      } else held.push(m);
    }
    queue = held;
    // A peer that closed with reliable messages still in flight closes here,
    // once the last of them has been handed over (see close()).
    if (self.closing && !queue.some((m) => m.to === self)) {
      self.closing = false;
      self.base.status = "closed";
      self.base.emit.close("peer");
    }
    return n;
  }

  function build(name: string, self: LoopSide, peer: LoopSide): LoopbackEndpoint {
    const ep: LoopbackEndpoint = {
      name,
      get status() {
        return self.base.status;
      },
      onMessage(fn) {
        self.base.handlers.onMessage(fn);
        return this;
      },
      onOpen(fn) {
        self.base.handlers.onOpen(fn);
        return this;
      },
      onClose(fn) {
        self.base.handlers.onClose(fn);
        return this;
      },
      setDisconnectGrace: (ms) => ms,
      send(channel, data) {
        if (self.base.status !== "open") return false;
        enqueue(self, peer, channel, data);
        return true;
      },
      pump: (localNow) => deliverTo(self, localNow),
      close() {
        if (self.base.status === "closed") return;
        self.base.status = "closed";
        // The reliable channel delivers what was sent before a close (a RESULT
        // then BYE in the same tick, f1-game #2199): the peer receives those
        // and only then its close. Unreliable state and anything for us go.
        queue = queue.filter((m) => m.to === peer && m.channel === EVENT && peer.base.status !== "closed");
        self.base.emit.close("local");
        if (peer.base.status === "closed") return;
        if (queue.length) {
          peer.closing = true;
          return;
        }
        peer.base.status = "closed";
        peer.base.emit.close("peer");
      },
      stats: () => ({ dropped, delivered, queued: queue.length, wire: self.wire || 0 }),
    };
    return ep;
  }

  const a = build("a", sa, sb);
  const b = build("b", sb, sa);
  sa.base.status = sb.base.status = "open";
  sa.base.emit.open();
  sb.base.emit.open();
  netLog.info("loopback create");
  return [a, b];
}

// ─── ICE configuration (transport.js:203-449) ───────────────────────────────

/**
 * More than one STUN server, from different operators, because a single one
 * is a single point of failure for learning your own public address
 * (transport.js:203-212).
 */
export const STUN: readonly string[] = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

/**
 * No TURN credential ships in the client: a browser-visible provider key is
 * reusable by anyone who downloads the game. Operators configure their own
 * short-lived credentials endpoint through `a26.turnApi`; the default is
 * honest STUN-only operation (transport.js:214-241).
 */
const TURN_API = "";

/** How long a credentials endpoint gets before we race without it (transport.js:243-246). */
const FETCH_TIMEOUT_MS = 4000;
/** Refresh vended credentials before a typical 60 min TTL (transport.js:247-250). */
const ICE_CRED_TTL_MS = 55 * 60 * 1000;

export const STORE_TURN_API = "a26.turnApi";
export const STORE_TURN = "a26.turn";
export const STORE_FREE_TURN = "a26.freeTurn";
export const STORE_RELAY_ONLY = "a26.iceRelayOnly";

function readStore(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null; // storage blocked (private mode)
  }
}

let fetchedIce: RTCIceServer[] | null = null;
let fetchedIceAt = 0;
let fetchingIce: Promise<RTCIceServer[] | null> | null = null;

function iceCredFresh(): boolean {
  return !!(fetchedIce && Date.now() - fetchedIceAt < ICE_CRED_TTL_MS);
}

function isIceEntry(e: unknown): e is RTCIceServer {
  return typeof e === "object" && e !== null && !!(e as { urls?: unknown }).urls;
}

/**
 * Fetch the operator's TURN credentials (and derive the opt-in free relay).
 * Must be AWAITED BEFORE a connection is built: iceServers are fixed at
 * RTCPeerConnection construction (transport.js:258-306). Never rejects.
 */
export function prefetchIce(): Promise<null> {
  const jobs: Array<Promise<unknown>> = [derivedRelays()];
  let url = readStore(STORE_TURN_API);
  if (!url) url = TURN_API;
  // Re-fetch when the previous answer is past ICE_CRED_TTL_MS (or never
  // landed). Keep last-good fetchedIce while the refresh runs.
  if (url && !iceCredFresh() && !fetchingIce) {
    // BOUNDED: an endpoint that never answers must not become an unbounded
    // wait, because the lobby awaits this before building a connection.
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const bail = setTimeout(() => {
      try {
        ctl?.abort();
      } catch {
        /* already settled */
      }
    }, FETCH_TIMEOUT_MS);
    fetchingIce = fetch(url, ctl ? { signal: ctl.signal } : undefined)
      .then((r) => r.json() as Promise<unknown>)
      .then((body) => {
        const obj = body as { iceServers?: unknown; ice_servers?: unknown } | null;
        const raw = Array.isArray(body) ? body : (obj && (obj.iceServers || obj.ice_servers)) || null;
        // PER-ENTRY validation: this list is third-party and spread straight
        // into `new PC(cfg)`; one entry without `urls` throws there.
        const list = Array.isArray(raw) ? raw.filter(isIceEntry) : null;
        if (list && list.length) {
          fetchedIce = list;
          fetchedIceAt = Date.now();
        }
        return fetchedIce;
      })
      .catch((err: unknown) => {
        netLog.warn("TURN credential fetch failed, gathering STUN-only:", err instanceof Error ? err.message : err);
        return fetchedIce;
      })
      .finally(() => {
        clearTimeout(bail);
        fetchingIce = null;
      });
  }
  if (fetchingIce) jobs.push(fetchingIce);
  // Failure-silent by design: no relay is a NORMAL state.
  return Promise.all(jobs).then(
    () => null,
    () => null,
  );
}

/**
 * THE FREE RELAYS, both OFF by default because both were measured dead
 * (transport.js:308-351). Opt in with localStorage `a26.freeTurn = "true"`.
 * Open Relay's static-auth host uses the coturn REST scheme: the CLIENT
 * derives username = <unix expiry>, credential = base64(HMAC-SHA1(secret, username)).
 */
const OPEN_RELAY_SECRET = "openrelayprojectsecret";
const OPEN_RELAY_HOSTS: readonly string[] = [
  "turn:staticauth.openrelay.metered.ca:80",
  "turn:staticauth.openrelay.metered.ca:443",
  "turn:staticauth.openrelay.metered.ca:443?transport=tcp",
];
const FREE_TURN: readonly RTCIceServer[] = [{ urls: "turn:freestun.net:3478", username: "free", credential: "free" }];

function freeTurnOn(): boolean {
  return readStore(STORE_FREE_TURN) === "true";
}

/** The derived username encodes its own 24 h expiry (transport.js:358-361). */
const DERIVED_TTL_MS = 23 * 60 * 60 * 1000;
let derived: RTCIceServer[] | null = null;
let derivedAt = 0;
let deriving: Promise<RTCIceServer[] | null> | null = null;
let derivedWarned = false;

function derivedFresh(): boolean {
  return !!(derived && Date.now() - derivedAt < DERIVED_TTL_MS);
}

function derivedRelays(): Promise<RTCIceServer[] | null> {
  if (!freeTurnOn()) return Promise.resolve(null);
  if (derivedFresh()) return Promise.resolve(derived);
  if (deriving) return deriving;
  const sub = typeof crypto !== "undefined" && crypto.subtle ? crypto.subtle : null;
  if (!sub) return Promise.resolve(null); // no WebCrypto: freestun only
  const username = String(Math.floor(Date.now() / 1000) + 86400);
  const enc = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
  deriving = sub
    .importKey("raw", enc(OPEN_RELAY_SECRET), { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
    .then((key) => sub.sign("HMAC", key, enc(username)))
    .then((sig) => {
      const credential = bytesToB64(new Uint8Array(sig));
      derived = OPEN_RELAY_HOSTS.map((urls) => ({ urls, username, credential }));
      derivedAt = Date.now();
      return derived;
    })
    .catch((e: unknown) => {
      // Once per page: every join retries the derivation, and the cause does not change.
      if (!derivedWarned) {
        derivedWarned = true;
        netLog.warn("free-TURN credential derivation failed, relay-less ICE:", e instanceof Error ? e.message : e);
      }
      return null;
    })
    .then((r) => {
      deriving = null;
      return r;
    });
  return deriving;
}

/** RELAY ONLY, for testing the path NAT'd and mobile players depend on (transport.js:394-407). */
function relayOnly(): boolean {
  return readStore(STORE_RELAY_ONLY) === "true";
}

/** Your own relay: localStorage `a26.turn = {"urls":…,"username":…,"credential":…}` (transport.js:409-419). */
function turnFromStore(): RTCIceServer | null {
  try {
    const raw = readStore(STORE_TURN);
    if (!raw) return null;
    const cfg: unknown = JSON.parse(raw);
    return isIceEntry(cfg) ? cfg : null;
  } catch {
    return null;
  }
}

export interface IceOptions {
  /** An explicit list wins over every stored or fetched source. */
  readonly iceServers?: RTCIceServer[];
}

/**
 * Every ICE source merged, ordered by INTENT: STUN, yours, your operator's,
 * then whatever is free (transport.js:421-442). `stunOnly` leaves every
 * fetched/derived relay out (the rtc() retry path).
 */
export function iceServers(opts: IceOptions = {}, stunOnly = false): RTCIceServer[] {
  if (opts.iceServers) return opts.iceServers;
  const list: RTCIceServer[] = [{ urls: [...STUN] }];
  if (stunOnly) return list;
  const mine = turnFromStore();
  if (mine) list.push(mine);
  if (fetchedIce) list.push(...fetchedIce);
  if (freeTurnOn()) {
    if (derivedFresh() && derived) list.push(...derived);
    list.push(...FREE_TURN);
  }
  return list;
}

function listHasTurn(list: readonly RTCIceServer[]): boolean {
  return list.some((e) => {
    const urls = Array.isArray(e.urls) ? e.urls : [e.urls];
    return urls.some((u) => /^turns?:/i.test(String(u || "")));
  });
}

export function hasRelay(): boolean {
  return listHasTurn(iceServers({}));
}

/** Test seam: forget fetched and derived ICE. Not in f1-game (its tests re-eval the file). */
export function resetIceCacheForTests(): void {
  fetchedIce = null;
  fetchedIceAt = 0;
  fetchingIce = null;
  derived = null;
  derivedAt = 0;
  deriving = null;
  derivedWarned = false;
}

// ─── rtc (transport.js:451-752) ─────────────────────────────────────────────

export type PeerConnectionCtor = new (cfg: RTCConfiguration) => RTCPeerConnection;

export interface RtcOptions extends IceOptions {
  readonly name?: string;
  /** The host creates both channels; the guest adopts them as they arrive. */
  readonly role?: "host" | "guest";
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  /** Injectable for tests; defaults to the global RTCPeerConnection. */
  readonly PC?: PeerConnectionCtor;
}

const STATE_INBOX_CAP = 64;
/** Outbound SCTP queue bytes before STATE sends drop. */
const STATE_BUFFER_CAP = 16384;
/** EVENT's outbound cap sits ABOVE STATE: non-critical spam is shed first (transport.js:498-501). */
const EVENT_BUFFER_CAP = 65536;
const EVENT_INBOX_CAP = 256;
const INBOX_BYTE_CAP = 1024 * 1024;

/**
 * Event types whose loss breaks race flow: queued in order when the buffer is
 * full rather than dropped (transport.js:504-514). STRATEGY/QLIVE, re-sent
 * every second or a live preview, may be dropped.
 */
const EVENT_CRITICAL: ReadonlySet<string> = new Set([
  "go", "qgo", "start", "result", "bye",
  "armed", "left", "caution", "model",
  "quali", "qabort", "lap", "settings", "hello", "ready",
]);

function globalPC(): PeerConnectionCtor | null {
  return typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : null;
}

function messageBytes(data: unknown): number {
  if (typeof data === "string") return data.length * 2; // conservative JS heap cost
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return INBOX_BYTE_CAP + 1; // unknown payload shape: fail closed
}

function peekEventType(data: WireData): string {
  if (typeof data !== "string") return "";
  try {
    const o: unknown = JSON.parse(data);
    const t = typeof o === "object" && o !== null ? (o as { t?: unknown }).t : undefined;
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

interface Inbound {
  readonly channel: Channel;
  readonly data: WireData;
  readonly bytes: number;
  readonly at: number;
}

/** A real RTCPeerConnection endpoint, or null when this browser has no WebRTC. */
export function rtc(opts: RtcOptions = {}): RtcEndpoint | null {
  const PC = opts.PC ?? globalPC();
  if (!PC) return null; // caller falls back / reports

  const base = makeBase();
  // iceServers are fixed at construction; stats().turn must describe THIS PC.
  let usedIce: RTCIceServer[] = [];
  const build = (stunOnly: boolean): RTCPeerConnection => {
    usedIce = iceServers(opts, stunOnly);
    const cfg: RTCConfiguration = { iceServers: usedIce };
    const policy = opts.iceTransportPolicy || (relayOnly() ? "relay" : null);
    if (policy) cfg.iceTransportPolicy = policy;
    return new PC(cfg);
  };
  let pc: RTCPeerConnection;
  try {
    pc = build(false);
  } catch (e) {
    // A MALFORMED ICE ENTRY IS NOT "NO WEBRTC": forget the fetched list and
    // try once more with STUN alone (transport.js:471-489).
    netLog.warn("rtc create fail (" + (e instanceof Error ? e.message : String(e)) + ") — dropping fetched ICE, retrying STUN-only");
    fetchedIce = null;
    fetchedIceAt = 0;
    try {
      pc = build(true);
    } catch {
      netLog.warn("rtc create fail");
      return null;
    }
  }
  const hadTurn = listHasTurn(usedIce);
  netLog.info("rtc create");

  const chans: Partial<Record<Channel, RTCDataChannel>> = {};
  let inbox: Inbound[] = [];
  let queuedState = 0;
  let queuedEvents = 0;
  let queuedBytes = 0;
  let openCount = 0;
  const opened: Partial<Record<Channel, true>> = {};
  const eventOut: WireData[] = []; // critical EVENT payloads waiting for bufferedAmount to drain

  let discTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalReason: CloseReason | null = null;

  function shutdown(reason: CloseReason): void {
    if (base.status === "closed" || (base.status === "closing" && reason !== "local")) return;
    // A remote close drains what was already accepted before reporting it.
    const drain = reason !== "local" && reason !== "overflow" && inbox.length > 0;
    terminalReason = drain ? reason : null;
    base.status = drain ? "closing" : "closed";
    if (discTimer) {
      clearTimeout(discTimer);
      discTimer = null;
    }
    if (!drain) inbox.length = 0;
    eventOut.length = 0;
    if (!drain) queuedState = queuedEvents = queuedBytes = 0;
    for (const k of CHANNELS) {
      try {
        chans[k]?.close();
      } catch {
        /* already closing */
      }
    }
    try {
      pc.close();
    } catch {
      /* already closing */
    }
    if (!drain) base.emit.close(reason);
  }

  const sendRaw = (ch: RTCDataChannel, data: WireData): void => {
    // The DOM overloads take each payload kind separately.
    if (typeof data === "string") ch.send(data);
    else if (data instanceof ArrayBuffer) ch.send(data);
    else if (ArrayBuffer.isView(data)) ch.send(data as ArrayBufferView<ArrayBuffer>);
    else ch.send(data);
  };

  function flushEventOut(): void {
    const ch = chans[EVENT];
    if (!ch || ch.readyState !== "open") return;
    while (eventOut.length && ch.bufferedAmount <= EVENT_BUFFER_CAP) {
      const data = eventOut.shift() as WireData;
      try {
        sendRaw(ch, data);
      } catch {
        eventOut.unshift(data);
        break;
      }
    }
  }

  // WHAT KIND of candidates we found: no srflx means STUN never answered;
  // srflx but no connection means symmetric NAT, which only TURN fixes
  // (transport.js:564-580).
  const found: CandidateCounts = { host: 0, srflx: 0, relay: 0, mdns: 0 };
  pc.onicecandidate = (e) => {
    const line = e.candidate && e.candidate.candidate;
    if (!line) return; // null candidate = end of gathering
    const m = /\btyp (\w+)/.exec(line);
    const t = m ? m[1] : null;
    if (t === "host" || t === "srflx" || t === "relay") found[t]++;
    if (t === "host" && /\.local\b/i.test(line)) found.mdns++;
  };

  function adopt(ch: RTCDataChannel, kind: Channel): void {
    chans[kind] = ch;
    ch.binaryType = "arraybuffer";
    if (kind === EVENT) {
      // Drain queued critical EVENTs once the SCTP send buffer falls.
      try {
        ch.bufferedAmountLowThreshold = EVENT_BUFFER_CAP >> 1;
      } catch {
        /* optional */
      }
      ch.onbufferedamountlow = () => flushEventOut();
    }
    ch.onopen = () => {
      if (base.status === "closed" || base.status === "closing") return;
      if (opened[kind]) return; // counted by DISTINCT kind, never by number of opens
      opened[kind] = true;
      if (++openCount === CHANNELS.length) {
        base.status = "open";
        netLog.info("rtc open");
        base.emit.open();
      }
    };
    // Route through shutdown(): it is the ONLY caller of pc.close(), so a
    // peer-initiated disconnect never leaks a live RTCPeerConnection.
    ch.onclose = () => shutdown("peer");
    ch.onmessage = (e: MessageEvent<unknown>) => {
      if (base.status === "closed" || base.status === "closing") return;
      const bytes = messageBytes(e.data);
      if (queuedBytes + bytes > INBOX_BYTE_CAP || (kind === EVENT && queuedEvents + 1 > EVENT_INBOX_CAP)) {
        netLog.warn("rtc inbox overflow");
        shutdown("overflow");
        return;
      }
      // `at` stamps ARRIVAL, not pump time: the clock-sync PONG math reads it.
      inbox.push({ channel: kind, data: e.data as WireData, bytes, at: performance.now() });
      queuedBytes += bytes;
      if (kind === STATE) queuedState++;
      else queuedEvents++;
      while (queuedState > STATE_INBOX_CAP) {
        const i = inbox.findIndex((m) => m.channel === STATE);
        if (i < 0) break; // defensive: queuedState and inbox should agree
        const removed = inbox.splice(i, 1)[0];
        if (removed) queuedBytes -= removed.bytes;
        queuedState--;
      }
    };
  }

  if (opts.role === "host") {
    adopt(pc.createDataChannel(STATE, { ordered: false, maxRetransmits: 0 }), STATE);
    adopt(pc.createDataChannel(EVENT, { ordered: true }), EVENT);
  } else {
    pc.ondatachannel = (e) => {
      // Only the two labels the host creates, each once (f1-game NP-7).
      const label = e.channel.label;
      if ((label !== STATE && label !== EVENT) || chans[label]) {
        netLog.warn("ignoring data channel " + String(label).slice(0, 32));
        try {
          e.channel.close();
        } catch {
          /* already closing */
        }
        return;
      }
      adopt(e.channel, label);
    };
  }

  // "disconnected" is TRANSIENT in Chrome (a Wi-Fi roam, a phone that slept);
  // only "failed"/"closed" are final. The lobby keeps 5 s; a race session
  // raises it through setTimeoutMs (transport.js:652-682, f1-game #2195).
  let disconnectGraceMs = 5000;
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (netLogEnabled("debug")) netLog.debug("pc state -> " + s);
    if (s !== "disconnected" && discTimer) {
      clearTimeout(discTimer);
      discTimer = null;
    }
    if (base.status === "closed" || base.status === "closing") return;
    if (s === "failed" || s === "closed") {
      netLog.info("connection closed (" + s + ")");
      shutdown(s);
    } else if (s === "disconnected" && !discTimer) {
      discTimer = setTimeout(() => {
        discTimer = null;
        if (base.status !== "closed" && pc.connectionState === "disconnected") {
          netLog.info("connection closed (disconnected " + disconnectGraceMs + " ms)");
          shutdown("disconnected");
        }
      }, disconnectGraceMs);
    }
  };

  const ep: RtcEndpoint = {
    name: opts.name || "rtc",
    pc,
    get status() {
      return base.status;
    },
    onMessage(fn) {
      base.handlers.onMessage(fn);
      return this;
    },
    onOpen(fn) {
      base.handlers.onOpen(fn);
      return this;
    },
    onClose(fn) {
      base.handlers.onClose(fn);
      return this;
    },
    setDisconnectGrace(ms) {
      if (Number.isFinite(ms) && ms > 0) disconnectGraceMs = ms;
      return disconnectGraceMs;
    },
    send(channel, data) {
      if (base.status === "closed" || base.status === "closing") return false;
      const ch = chans[channel];
      if (!ch || ch.readyState !== "open") return false;
      // maxRetransmits:0 drops on the NETWORK, but the local SCTP queue still
      // buffers: refusing the send keeps stale snapshots from queueing
      // (transport.js:689-694).
      if (channel === STATE && ch.bufferedAmount > STATE_BUFFER_CAP) return false;
      if (channel === EVENT) {
        // Drain queued criticals first so order stays FIFO across backpressure.
        if (eventOut.length && ch.bufferedAmount <= EVENT_BUFFER_CAP) flushEventOut();
        const backed = eventOut.length > 0 || ch.bufferedAmount > EVENT_BUFFER_CAP;
        if (backed) {
          if (!EVENT_CRITICAL.has(peekEventType(data))) return false; // drop non-critical under pressure
          eventOut.push(data); // critical: keep order, deliver on drain
          return true;
        }
      }
      try {
        sendRaw(ch, data);
        return true;
      } catch {
        return false;
      }
    },
    pump() {
      const count = inbox.length;
      if (!count) return 0;
      // DETACH, THEN EMIT: a handler may empty this very array mid-walk
      // (BYE → stop → shutdown) (transport.js:712-718).
      const batch = inbox;
      inbox = [];
      queuedState = queuedEvents = queuedBytes = 0;
      for (const m of batch) {
        // A handler shut us down: the rest is a closed connection's mail.
        if (base.status === "closed") break;
        base.emit.message(m.channel, m.data, m.at);
      }
      if (terminalReason && base.status === "closing") {
        const reason = terminalReason;
        terminalReason = null;
        base.status = "closed";
        base.emit.close(reason);
      }
      return count;
    },
    close: () => shutdown("local"),
    stats: () => ({
      queued: inbox.length,
      queuedBytes,
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      gathering: pc.iceGatheringState,
      candidates: { ...found },
      turn: hadTurn,
      ownTurn: !!turnFromStore(),
    }),
  };
  return ep;
}

export function supported(): boolean {
  return globalPC() !== null;
}
