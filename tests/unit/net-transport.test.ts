/**
 * The wire, tested with no wire: src/net/transport.ts against fakes.
 *
 * Ported from f1-game tests/unit/net-transport.test.mjs:
 *   :82-86      seededRnd (here the exported one from transport.ts)
 *   :93-174     loopback latency / loss / seeded loss / order / close / throwing handler
 *   :176-401    rtc fake-PC: inbox pressure, data-channel labels (NP-7), overflow,
 *               STATE backpressure, EVENT cap + critical queue
 *   :405-559    ICE configuration (no static relay, credentials URL, defaults,
 *               coturn REST credential, relays last + hasRelay, STUN operators)
 *   :729-878    pcHarness, close releasing the PC, connectionState failure,
 *               disconnect grace timer, race-session grace (#2195), arrival stamps
 *   :880-958    malformed fetched ICE retry, stats().turn stamped at construction
 *   :994-1015   loopback EVENT order under jitter, mid-pump close
 *   :1053-1087  prefetchIce keeps last-good TURN mid-refresh
 *   :1138-1180  remote-close drain, local close discard, BYE during drain
 *
 * Not ported: NetworkAdversary (:34-80) and every NetHandshake test (invite
 * codes, SDP, localBuild, peekCode, waitForIce, acceptAnswer: :563-727,
 * :960-992, :1017-1051, :1089-1136). Those modules are not ported yet.
 *
 * Differences from f1-game: rtc() takes the fake through its `PC` option
 * instead of a swapped globalThis.RTCPeerConnection; localStorage is a
 * vi.stubGlobal in-memory Storage under the `a26.` keys; a "fresh module"
 * is resetIceCacheForTests(); f1-game's hand-rolled setTimeout shims are
 * vitest fake timers; rtc's pump() is given a `now` it ignores.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as NetTransport from "../../src/net/transport";
import {
  EVENT,
  STATE,
  STORE_FREE_TURN,
  STORE_TURN_API,
  STUN,
  hasRelay,
  iceServers,
  loopback,
  prefetchIce,
  resetIceCacheForTests,
  rtc,
  seededRnd,
  type Channel,
  type PeerConnectionCtor,
  type RtcEndpoint,
  type WireData,
} from "../../src/net/transport";
import { createSession } from "../../src/net/session";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function memStorage(map: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(map));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const useStore = (map: Record<string, string> = {}): void => {
  vi.stubGlobal("localStorage", memStorage(map));
};

interface FetchReply {
  json(): Promise<unknown>;
}
const useFetch = (fn: (url: string) => Promise<FetchReply>): void => {
  vi.stubGlobal("fetch", fn);
};

class FakeChannel {
  readyState: RTCDataChannelState;
  bufferedAmount: number;
  bufferedAmountLowThreshold = 0;
  binaryType = "blob";
  closed = 0;
  readonly sent: WireData[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: unknown }) => void;
  onbufferedamountlow?: () => void;
  constructor(
    readonly label: string,
    buffered = 0,
    state: RTCDataChannelState = "open",
  ) {
    this.bufferedAmount = buffered;
    this.readyState = state;
  }
  send(d: WireData): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed++;
  }
}

/** Fire a handler rtc() must have wired; fails the test if it did not. */
function fire<A extends unknown[]>(fn: ((...a: A) => void) | null | undefined, ...args: A): void {
  if (!fn) throw new Error("handler was never wired");
  fn(...args);
}

class FakePC {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  ondatachannel?: (e: { channel: FakeChannel }) => void;
  onconnectionstatechange?: () => void;
  onicecandidate?: (e: unknown) => void;
  closes = 0;
  constructor(readonly cfg: RTCConfiguration) {}
  createDataChannel(label: string): FakeChannel {
    return new FakeChannel(label, 0, "connecting");
  }
  close(): void {
    this.closes++;
  }
}

const asCtor = (C: new (cfg: RTCConfiguration) => FakePC): PeerConnectionCtor => C as unknown as PeerConnectionCtor;
const fakeOf = (ep: RtcEndpoint): FakePC => ep.pc as unknown as FakePC;

function guest(): { ep: RtcEndpoint; pc: FakePC } {
  const ep = rtc({ role: "guest", PC: asCtor(FakePC) });
  if (!ep) throw new Error("rtc() returned null");
  return { ep, pc: fakeOf(ep) };
}

/** The round-8 harness (f1-game :729-757): a guest with both channels open. */
function pcHarness(): { ep: RtcEndpoint; pc: FakePC; state: FakeChannel; event: FakeChannel; pcClosed: () => number } {
  useStore();
  const { ep, pc } = guest();
  const state = new FakeChannel("state");
  const event = new FakeChannel("event");
  fire(pc.ondatachannel, { channel: state });
  fire(pc.ondatachannel, { channel: event });
  fire(state.onopen);
  fire(event.onopen);
  return { ep, pc, state, event, pcClosed: () => pc.closes };
}

const urlsOf = (list: readonly RTCIceServer[]): string[] =>
  list.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

beforeEach(() => {
  resetIceCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetIceCacheForTests();
});

// ---------------------------------------------------------------------------
// Loopback transport
// ---------------------------------------------------------------------------

test("nothing is delivered before its latency has elapsed", () => {
  const [a, b] = loopback({ latencyMs: 50, rnd: seededRnd(1) });
  const got: WireData[] = [];
  b.onMessage((_ch, d) => got.push(d));
  a.pump(0);
  b.pump(0); // establish both epochs
  a.send(STATE, "x");
  b.pump(10);
  expect(got.length, "arrived at 10ms").toBe(0);
  b.pump(49);
  expect(got.length, "arrived at 49ms").toBe(0);
  b.pump(50);
  expect(got.length, "should have arrived at 50ms").toBe(1);
});

test("loss hits the unreliable channel and never the reliable one", () => {
  // 100% loss: the state channel goes silent, the event channel must not.
  const [a, b] = loopback({ latencyMs: 0, loss: 1, rnd: seededRnd(2) });
  let state = 0;
  let event = 0;
  b.onMessage((ch) => {
    if (ch === STATE) state++;
    else event++;
  });
  for (let i = 0; i < 20; i++) {
    a.send(STATE, String(i));
    a.send(EVENT, String(i));
  }
  b.pump(1);
  expect(state, "state channel should have dropped everything").toBe(0);
  expect(event, "event channel must be lossless").toBe(20);
});

test("partial loss is reproducible for a given seed", () => {
  function run(): string {
    const [a, b] = loopback({ latencyMs: 0, loss: 0.4, rnd: seededRnd(99) });
    const got: WireData[] = [];
    b.onMessage((_ch, d) => got.push(d));
    for (let i = 0; i < 100; i++) a.send(STATE, String(i));
    b.pump(1);
    return got.join(",");
  }
  expect(run(), "same seed must drop the same packets").toBe(run());
  const [a, b] = loopback({ latencyMs: 0, loss: 0.4, rnd: seededRnd(99) });
  let n = 0;
  b.onMessage(() => n++);
  for (let i = 0; i < 100; i++) a.send(STATE, String(i));
  b.pump(1);
  expect(n > 40 && n < 80, `~60 of 100 should survive 40% loss, got ${n}`).toBe(true);
});

test("the reliable channel preserves send order", () => {
  const [a, b] = loopback({ latencyMs: 20, rnd: seededRnd(3) });
  const got: WireData[] = [];
  b.onMessage((_ch, d) => got.push(d));
  a.pump(0);
  b.pump(0); // establish both epochs — see loopback()
  for (let i = 0; i < 10; i++) a.send(EVENT, String(i));
  b.pump(100);
  expect(got.join(",")).toBe("0,1,2,3,4,5,6,7,8,9");
});

test("traffic flows both ways and close is seen by both ends", () => {
  const [a, b] = loopback({ latencyMs: 0, rnd: seededRnd(4) });
  let toA = 0;
  a.onMessage(() => toA++);
  b.send(EVENT, "hi");
  a.pump(1);
  expect(toA, "b -> a should deliver").toBe(1);

  const closed: string[] = [];
  a.onClose(() => closed.push("a"));
  b.onClose(() => closed.push("b"));
  a.close();
  expect(closed.sort(), "both ends should be notified").toEqual(["a", "b"]);
  expect(a.send(EVENT, "x"), "send after close must fail").toBe(false);
});

test("a throwing message handler cannot take down the transport", () => {
  // A rendering bug upstream must not read as a dropped connection.
  const [a, b] = loopback({ latencyMs: 0, rnd: seededRnd(5) });
  let second = 0;
  b.onMessage(() => {
    throw new Error("handler blew up");
  });
  b.onMessage(() => second++);
  a.send(EVENT, "1");
  b.pump(1);
  expect(second, "the surviving handler should still have run").toBe(1);
  expect(b.status, "the transport should still be open").toBe("open");
});

// ---------------------------------------------------------------------------
// rtc against a fake RTCPeerConnection
// ---------------------------------------------------------------------------

test("RTC inbox pressure drops state snapshots, never reliable events", () => {
  useStore();
  const { ep, pc } = guest();
  const state = new FakeChannel("state");
  const event = new FakeChannel("event");
  fire(pc.ondatachannel, { channel: state });
  fire(pc.ondatachannel, { channel: event });
  fire(state.onopen);
  fire(event.onopen);

  const got: Array<[Channel, WireData]> = [];
  ep.onMessage((kind, data) => got.push([kind, data]));
  for (let i = 0; i < 80; i++) fire(state.onmessage, { data: "s" + i });
  for (let i = 0; i < 80; i++) fire(event.onmessage, { data: "e" + i });
  ep.pump(0);

  const states = got.filter(([kind]) => kind === STATE).map(([, data]) => data);
  const events = got.filter(([kind]) => kind === EVENT).map(([, data]) => data);
  expect(states.length, "only the newest bounded snapshot window survives").toBe(64);
  expect(states[0]).toBe("s16");
  expect(events, "reliable protocol events must remain complete and ordered").toEqual(
    Array.from({ length: 80 }, (_, i) => "e" + i),
  );
});

test("a guest adopts only the expected data-channel labels, once each (NP-7)", () => {
  useStore();
  const { ep, pc } = guest();
  const opens: number[] = [];
  ep.onOpen(() => opens.push(1));
  const state = new FakeChannel("state");
  const state2 = new FakeChannel("state");
  const alien = new FakeChannel("telemetry");
  const event = new FakeChannel("event");
  fire(pc.ondatachannel, { channel: state });
  fire(pc.ondatachannel, { channel: state2 }); // duplicate
  fire(pc.ondatachannel, { channel: alien }); // unknown
  expect(state2.closed, "duplicate label is refused").toBe(1);
  expect(alien.closed, "unknown label is refused").toBe(1);
  fire(state.onopen);
  expect(state2.onopen, "the refused channel was never wired").toBeUndefined();
  expect(opens.length, "one channel open is not an open transport").toBe(0);
  expect(ep.status).toBe("connecting");
  fire(pc.ondatachannel, { channel: event });
  fire(event.onopen);
  expect(opens.length, "open fires once both DISTINCT kinds opened").toBe(1);
  expect(ep.status).toBe("open");
  expect(ep.send(EVENT, "{}"), "the EVENT channel is the real one").toBe(true);
});

test("RTC disconnects instead of dropping reliable events when its inbox overflows", () => {
  useStore();
  const { ep, pc } = guest();
  const state = new FakeChannel("state");
  const event = new FakeChannel("event");
  fire(pc.ondatachannel, { channel: state });
  fire(pc.ondatachannel, { channel: event });
  fire(state.onopen);
  fire(event.onopen);
  const closed: string[] = [];
  ep.onClose((why) => closed.push(why));

  for (let i = 0; i < 257; i++) fire(event.onmessage, { data: "e" + i });

  expect(ep.status).toBe("closed");
  expect(closed, "overflow must be explicit to the session").toEqual(["overflow"]);
  expect(pc.closes).toBe(1);
  expect(ep.stats().queued, "closing releases the retained payloads").toBe(0);
});

test("a congested outbound STATE queue drops the snapshot instead of buffering it", () => {
  // maxRetransmits:0 only drops on the network — the local SCTP queue still
  // buffers, so a backed-up channel must refuse STATE sends (stale beats late).
  useStore();
  const { ep, pc } = guest();
  const state = new FakeChannel("state", 999999);
  const event = new FakeChannel("event", 0);
  fire(pc.ondatachannel, { channel: state });
  fire(pc.ondatachannel, { channel: event });
  fire(state.onopen);
  fire(event.onopen);

  expect(ep.send(STATE, "snap"), "backed-up STATE send must drop").toBe(false);
  expect(state.sent.length).toBe(0);
  expect(
    ep.send(EVENT, JSON.stringify({ t: "lap", d: 1 })),
    "EVENT under its own cap still delivers while STATE is backed up",
  ).toBe(true);
  expect(event.sent.length).toBe(1);

  state.bufferedAmount = 0;
  expect(ep.send(STATE, "snap2"), "a drained queue accepts again").toBe(true);
  expect(state.sent.length).toBe(1);
});

test("EVENT cap: non-critical drops above the outbound buffer; criticals arrive in order", () => {
  useStore();
  const { ep, pc } = guest();
  const state = new FakeChannel("state", 0);
  const event = new FakeChannel("event", 999999);
  fire(pc.ondatachannel, { channel: state });
  fire(pc.ondatachannel, { channel: event });
  fire(state.onopen);
  fire(event.onopen);
  expect(typeof event.onbufferedamountlow, "EVENT channel must listen for bufferedamountlow to drain criticals").toBe(
    "function",
  );
  expect(event.bufferedAmountLowThreshold, "EVENT bufferedAmountLowThreshold must be set above zero").toBeGreaterThan(0);

  // QLIVE (a live preview) and STRATEGY (re-sent every second) are the sheddable ones.
  const lap = JSON.stringify({ t: "qlive", d: { t: 71.2 } });
  const strategy = JSON.stringify({ t: "strategy", d: { epoch: 1 } });
  expect(ep.send(EVENT, lap), "non-critical QLIVE drops above EVENT cap").toBe(false);
  expect(ep.send(EVENT, strategy), "non-critical STRATEGY drops above EVENT cap").toBe(false);
  expect(event.sent.length, "dropped non-criticals must not hit the wire").toBe(0);

  const go = JSON.stringify({ t: "go", d: { track: "monza" } });
  const qgo = JSON.stringify({ t: "qgo", d: null });
  const start = JSON.stringify({ t: "start", d: { at: 1, hold: 0 } });
  const result = JSON.stringify({ t: "result", d: { order: [1] } });
  const bye = JSON.stringify({ t: "bye", d: null });
  expect(ep.send(EVENT, go), "critical GO queues under pressure").toBe(true);
  expect(ep.send(EVENT, qgo), "qualifying's QGO must survive pressure too").toBe(true);
  expect(ep.send(EVENT, start), "critical START queues under pressure").toBe(true);
  expect(ep.send(EVENT, result), "critical RESULT queues under pressure").toBe(true);
  expect(ep.send(EVENT, bye), "critical BYE queues under pressure").toBe(true);
  const quali = JSON.stringify({ t: "quali", d: { driverId: "a", t: 71.2 } });
  const finLap = JSON.stringify({ t: "lap", d: { lap: 3, fin: 49.9 } });
  const settings = JSON.stringify({ t: "settings", d: { laps: 3 } });
  const qabort = JSON.stringify({ t: "qabort", d: null });
  for (const m of [quali, finLap, settings, qabort]) {
    expect(ep.send(EVENT, m), "critical " + String((JSON.parse(m) as { t: string }).t) + " queues").toBe(true);
  }
  expect(event.sent.length, "criticals wait for the buffer to drain").toBe(0);

  // Still backed up: another non-critical must keep dropping (not jump the critical queue).
  expect(ep.send(EVENT, lap), "non-critical stays dropped while criticals are queued").toBe(false);

  event.bufferedAmount = 0;
  fire(event.onbufferedamountlow);
  expect(event.sent, "critical EVENTs must flush in send order once bufferedAmount drains").toEqual([
    go, qgo, start, result, bye, quali, finLap, settings, qabort,
  ]);
  fire(event.onbufferedamountlow);
  expect(event.sent.filter((m) => m === qgo).length, "another drain notification must not send QGO twice").toBe(1);
});

// ---------------------------------------------------------------------------
// ICE configuration
// ---------------------------------------------------------------------------

test("no HARDCODED-PASSWORD relay ships, and a credentials URL becomes iceServers", async () => {
  expect((NetTransport as Record<string, unknown>)["OPEN_RELAY"], "the dead static relay must be gone").toBeUndefined();

  const turnServer = { urls: ["turn:relay.example:443?transport=tcp"], username: "u", credential: "c" };
  useStore({ [STORE_TURN_API]: "https://app.example/api/turn?apiKey=x" });
  useFetch(async () => ({ json: async () => ({ iceServers: [turnServer] }) }));
  await prefetchIce();
  const list = iceServers({});
  expect(list.some((s2) => s2.username === "u"), "fetched credentials must be merged").toBe(true);
  const urls = urlsOf(list);
  expect(urls.some((u) => u.startsWith("turn:")), "the merged entry is a relay").toBe(true);
  expect(urls.some((u) => u.startsWith("stun:")), "STUN still present").toBe(true);
});

test("NO relay ships by default, because both free ones were measured dead", () => {
  const urls = urlsOf(iceServers({}));
  expect(urls.some((u) => /^turns?:/.test(u)), "no measured-dead TURN entry is baked into the synchronous list").toBe(
    false,
  );
  expect(urls.some((u) => /^stun:/.test(u)), "STUN is unaffected").toBe(true);
  expect(hasRelay(), "before prefetchIce() resolves there is genuinely no relay, and hasRelay() must say so").toBe(false);
});

test("no credential endpoint ships by default, and yours overrides it", async () => {
  const seen: string[] = [];
  const turnServer = { urls: ["turn:relay.metered.example:443"], username: "u", credential: "c" };
  useFetch(async (u) => {
    seen.push(u);
    return { json: async () => ({ iceServers: [turnServer] }) };
  });
  // No a26.turnApi configured: no credential endpoint is fetched.
  useStore();
  await prefetchIce();
  expect(seen.length, "the default path stays STUN-only").toBe(0);
  expect(hasRelay(), "no relay exists without an explicit endpoint").toBe(false);

  // A player (or a fork) who sets their own endpoint opts in explicitly.
  resetIceCacheForTests();
  seen.length = 0;
  useStore({ [STORE_TURN_API]: "https://mine.example/creds" });
  await prefetchIce();
  expect(seen, "a configured URL wins outright — never a silent fallback to ours").toEqual([
    "https://mine.example/creds",
  ]);
});

test("the coturn REST credential is derived, not hardcoded, and expires", async () => {
  const before = Math.floor(Date.now() / 1000);
  useStore({ [STORE_FREE_TURN]: "true" });
  await prefetchIce();
  const relays = iceServers({}).filter((s) => /openrelay/.test(String(Array.isArray(s.urls) ? s.urls[0] : s.urls)));
  vi.unstubAllGlobals();
  const after = Math.floor(Date.now() / 1000);
  expect(relays.length, "opting in must produce a derived relay entry").toBeGreaterThan(0);

  const first = relays[0];
  if (!first) throw new Error("no derived relay");
  const username = String(first.username);
  const expiry = Number(username);
  expect(Number.isInteger(expiry), "the username IS the expiry, as an integer").toBe(true);
  expect(
    expiry >= before + 86400 && expiry <= after + 86400,
    "the expiry must be a day out — a credential valid forever is a password",
  ).toBe(true);

  const want = createHmac("sha1", "openrelayprojectsecret").update(username).digest("base64");
  expect(first.credential, "credential = base64(HMAC-SHA1(secret, username))").toBe(want);

  for (const r of relays) expect(r.credential).toBe(first.credential);
  expect(
    relays.some((r) => /:443\?transport=tcp/.test(String(r.urls))),
    "443/TCP must be offered — it is what survives a corporate firewall",
  ).toBe(true);
});

test("opting in adds relays LAST, and hasRelay() then says so", () => {
  useStore({ [STORE_FREE_TURN]: "true" });
  expect(hasRelay()).toBe(true);
  const urls = urlsOf(iceServers({}));
  expect(urls.some((u) => /^turns?:/.test(u)), "a TURN entry appears").toBe(true);
  expect(urls.some((u) => /^stun:/.test(u)), "STUN is never displaced by it").toBe(true);
  const freeAt = urls.findIndex((u) => /freestun|openrelay/.test(u));
  expect(freeAt > 0, "the free relays are appended, never prepended").toBe(true);
});

test("more STUN servers than one, from different operators", () => {
  expect(STUN.length >= 2, "one STUN server is not a plan").toBe(true);
  const hosts = STUN.map((u) => u.split(":")[1] ?? "");
  expect(
    new Set(hosts.map((h) => h.split(".").slice(-2).join("."))).size >= 2,
    "STUN servers must not all be the same operator",
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Round 8: teardown really tears down
// ---------------------------------------------------------------------------

test("a peer channel close releases the RTCPeerConnection, exactly once", () => {
  const h = pcHarness();
  const reasons: string[] = [];
  h.ep.onClose((r) => reasons.push(r));
  fire(h.state.onclose);
  expect(h.ep.status).toBe("closed");
  expect(h.pcClosed(), "pc.close() must run on a peer-initiated close").toBe(1);
  expect(reasons).toEqual(["peer"]);
  h.ep.close(); // a later local close must not double-release
  fire(h.event.onclose); // nor the second channel's close event
  expect(h.pcClosed(), "shutdown must stay idempotent").toBe(1);
  expect(reasons, "close fires once").toEqual(["peer"]);
});

test("a connectionState failure releases the RTCPeerConnection too", () => {
  const h = pcHarness();
  const reasons: string[] = [];
  h.ep.onClose((r) => reasons.push(r));
  h.pc.connectionState = "failed";
  fire(h.pc.onconnectionstatechange);
  expect(h.pcClosed(), "pc.close() must run on a connection failure").toBe(1);
  expect(reasons).toEqual(["failed"]);
});

test("a close inside the disconnect grace window reclaims its timer", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = pcHarness();
  h.pc.connectionState = "disconnected";
  fire(h.pc.onconnectionstatechange);
  expect(vi.getTimerCount(), "the disconnect grace timer was not armed").toBe(1);
  h.ep.close();
  expect(vi.getTimerCount(), "shutdown left the grace timer running").toBe(0);
});

// f1-game #2195: the race's 25 s silence grace never reached the wire.
test("a race session's timeout sets the rtc disconnect grace: 6 s stays open, 26 s closes", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const run = (holdMs: number, raceGrace: number): { status: string; closed: number } => {
    const h = pcHarness();
    try {
      if (raceGrace) {
        const s = createSession({ transport: h.ep });
        s.setTimeoutMs(raceGrace);
      }
      h.pc.connectionState = "disconnected";
      fire(h.pc.onconnectionstatechange);
      vi.advanceTimersByTime(holdMs);
      return { status: h.ep.status, closed: h.pcClosed() };
    } finally {
      vi.clearAllTimers();
    }
  };
  expect(run(6000, 25000).status, "a 6 s blip closed a race wire").toBe("open");
  const long = run(26000, 25000);
  expect(long.status, "a 26 s outage must still close").toBe("closed");
  expect(long.closed).toBe(1);
  expect(run(6000, 0).status, "the lobby keeps its 5 s grace").toBe("closed");
});

test("rtc stamps message ARRIVAL and hands it to onMessage; loopback stays unstamped", () => {
  const h = pcHarness();
  const stamps: Array<number | undefined> = [];
  h.ep.onMessage((_ch, _data, at) => stamps.push(at));
  const before = performance.now();
  fire(h.state.onmessage, { data: "x" });
  const after = performance.now();
  h.ep.pump(0);
  expect(stamps.length).toBe(1);
  const at = stamps[0] ?? Number.NaN;
  expect(at >= before && at <= after, `arrival stamp ${at} outside [${before}, ${after}]`).toBe(true);

  const [a, b] = loopback({ latencyMs: 0, rnd: seededRnd(7) });
  const atArgs: Array<number | undefined> = [];
  b.onMessage((_ch, _d, t) => atArgs.push(t));
  a.pump(0);
  b.pump(0);
  a.send(STATE, "y");
  b.pump(1);
  expect(atArgs, "loopback must not invent an arrival clock").toEqual([undefined]);
});

test("a fetched ICE entry that makes the constructor throw is dropped and rtc() retries STUN-only", async () => {
  const seen: RTCIceServer[][] = [];
  class ThrowingPC extends FakePC {
    constructor(cfg: RTCConfiguration) {
      const list = cfg.iceServers ?? [];
      seen.push(list);
      for (const e of list) {
        const urls = Array.isArray(e.urls) ? e.urls : [e.urls];
        if (urls.some((u) => !/^(stun|turns?):/.test(u))) throw new TypeError("bad ICE url");
      }
      super(cfg);
    }
  }
  useStore({ [STORE_TURN_API]: "https://relay.example/creds" });
  useFetch(async () => ({ json: async () => ({ iceServers: [{ urls: "garbage" }] }) }));
  await prefetchIce();
  expect(iceServers({}).some((e) => e.urls === "garbage"), "the bad entry was cached").toBe(true);
  const ep = rtc({ role: "host", PC: asCtor(ThrowingPC) });
  expect(ep && ep.pc, "the second construction must succeed").toBeTruthy();
  expect(seen.length, "one throw, one retry").toBe(2);
  expect(
    (seen[1] ?? []).every((e) => (Array.isArray(e.urls) ? e.urls : [e.urls]).every((u) => /^stun:/.test(u))),
    "the retry gathers with STUN only",
  ).toBe(true);
  expect(
    iceServers({}).some((e) => e.urls === "garbage"),
    "the fetched list is forgotten, so the next prefetch is a fresh answer",
  ).toBe(false);
  expect(ep?.stats().turn, "STUN-only retry stamps turn:false").toBe(false);
});

test("stats().turn follows the PC's iceServers, not a later hasRelay() flip", async () => {
  useStore({ [STORE_TURN_API]: "https://relay.example/creds" });
  expect(hasRelay(), "control: no relay yet").toBe(false);
  const ep = rtc({ role: "host", PC: asCtor(FakePC) });
  if (!ep) throw new Error("rtc() returned null");
  expect(ep.stats().turn, "STUN-only PC reports turn:false").toBe(false);

  const turnServer = { urls: ["turn:relay.example:443"], username: "u", credential: "c" };
  useFetch(async () => ({ json: async () => ({ iceServers: [turnServer] }) }));
  await prefetchIce();
  expect(hasRelay(), "module list now has TURN").toBe(true);
  expect(ep.stats().turn, "the already-built PC must not claim a relay it never gathered with").toBe(false);

  const withTurn = rtc({ role: "host", PC: asCtor(FakePC) });
  expect(withTurn?.stats().turn, "a PC built after prefetch stamps turn:true").toBe(true);
  expect(hasRelay()).toBe(true);
});

// ---------------------------------------------------------------------------
// Ordering and mid-pump close
// ---------------------------------------------------------------------------

test("loopback jitter never reorders the EVENT channel: it is reliable AND ordered on the real wire", () => {
  let s = 7;
  const rnd = (): number => (s = (s * 16807) % 2147483647) / 2147483647;
  const [a, b] = loopback({ latencyMs: 40, jitterMs: 30, rnd });
  const got: WireData[] = [];
  b.onMessage((ch, data) => {
    if (ch === EVENT) got.push(data);
  });
  a.pump(0);
  b.pump(0);
  for (let i = 0; i < 40; i++) a.send(EVENT, String(i));
  for (let t = 1; t < 400; t += 5) b.pump(t);
  expect(got, "events arrive in send order under jitter").toEqual(Array.from({ length: 40 }, (_, i) => String(i)));
});

test("a handler that closes the endpoint mid-pump stops the rest of that batch", () => {
  const [a, b] = loopback({ latencyMs: 0, rnd: () => 0.5 });
  let seen = 0;
  b.onMessage(() => {
    seen++;
    b.close();
  });
  a.pump(0);
  b.pump(0);
  for (let i = 0; i < 5; i++) a.send(EVENT, String(i));
  b.pump(1);
  expect(seen, "nothing after the close is delivered").toBe(1);
  expect(b.status).toBe("closed");
});

// ---------------------------------------------------------------------------
// prefetchIce: keep last-good TURN while a TTL refresh is in flight
// ---------------------------------------------------------------------------

test("prefetchIce retains last-good TURN while a TTL refresh is in flight", async () => {
  const turn1 = { urls: ["turn:relay.example:443"], username: "u1", credential: "c1" };
  const turn2 = { urls: ["turn:relay.example:443"], username: "u2", credential: "c2" };
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let fetchN = 0;
  let resolveSecond: ((r: FetchReply) => void) | null = null;
  useStore({ [STORE_TURN_API]: "https://relay.example/creds" });
  useFetch(() => {
    fetchN++;
    if (fetchN === 1) return Promise.resolve({ json: async () => ({ iceServers: [turn1] }) });
    return new Promise<FetchReply>((r) => {
      resolveSecond = r;
    });
  });
  await prefetchIce();
  expect(iceServers({}).some((e) => e.username === "u1"), "first fetch lands").toBe(true);
  now += 56 * 60 * 1000; // past ICE_CRED_TTL_MS (55 min)
  const refresh = prefetchIce();
  expect(fetchN, "TTL expiry starts a refresh").toBe(2);
  expect(
    iceServers({}).some((e) => e.username === "u1"),
    "mid-refresh must still offer last-good TURN, not STUN-only",
  ).toBe(true);
  expect(hasRelay(), "hasRelay stays true while refresh hangs").toBe(true);
  const resolve = resolveSecond as ((r: FetchReply) => void) | null;
  if (!resolve) throw new Error("second fetch never started");
  resolve({ json: async () => ({ iceServers: [turn2] }) });
  await refresh;
  expect(iceServers({}).some((e) => e.username === "u2"), "replacement lands").toBe(true);
});

// ---------------------------------------------------------------------------
// Remote close drains; local close discards
// ---------------------------------------------------------------------------

test("remote close drains accepted messages before terminal close on the next pump", () => {
  const h = pcHarness();
  const got: string[] = [];
  h.ep.onMessage((_ch, data) => got.push(String(data)));
  h.ep.onClose(() => got.push("close"));
  fire(h.event.onmessage, { data: "result" });
  fire(h.event.onmessage, { data: "bye" });
  fire(h.event.onclose);
  expect(h.pcClosed(), "wire resources release immediately").toBe(1);
  expect(got).toEqual([]);
  fire(h.state.onopen);
  fire(h.event.onopen);
  expect(h.ep.status, "late opens cannot resurrect the wire").toBe("closing");
  expect(h.ep.send(EVENT, "late")).toBe(false);
  h.ep.pump(0);
  expect(got).toEqual(["result", "bye", "close"]);
  h.ep.pump(0);
  expect(got.length).toBe(3);
});

test("intentional local close discards accepted undelivered messages", () => {
  const h = pcHarness();
  let messages = 0;
  h.ep.onMessage(() => messages++);
  fire(h.event.onmessage, { data: "result" });
  h.ep.close();
  h.ep.pump(0);
  expect(messages).toBe(0);
});

test("BYE handling during remote-close drain can locally discard trailing mail", () => {
  const h = pcHarness();
  const got: string[] = [];
  h.ep.onMessage((_ch, data) => {
    got.push(String(data));
    if (data === "bye") h.ep.close();
  });
  h.ep.onClose(() => got.push("close"));
  for (const data of ["result", "bye", "model"]) fire(h.event.onmessage, { data });
  fire(h.event.onclose);
  h.ep.pump(0);
  expect(got).toEqual(["result", "bye", "close"]);
});
