/**
 * net-session.test.ts — clock sync, routing and liveness, over a fake wire.
 * Port of f1-game tests/unit/net-session.test.mjs:1-661 (harness and helpers
 * :35-68, session-to-session tests :70-362, bare far end :364-438, ping
 * cadence :440-494, PONG validation :496-557, liveness and close :559-661).
 *
 * Two sessions are wired to each other through the loopback transport, with
 * the two peers given DELIBERATELY DIFFERENT clocks. That is the realistic
 * case — two browsers share no clock at all — and it is the case that silently
 * ruins interpolation if the offset estimate is wrong.
 *
 * f1-game loaded the IIFEs with eval (:19-33); here they are ES modules.
 * f1-game's harness also poked loopback internals (`tb._epoch`, a writable
 * `status`); apex-26's loopback hides both, so the harness wraps the endpoint
 * instead (see `skewable` and the "connecting" test). Wire behaviour is the same.
 */
import { afterEach, expect, test, vi } from "vitest";
import { autoPong, createSession, PING, PONG, type NetSession } from "../../src/net/session";
import { toView } from "../../src/net/snapshot";
import {
  EVENT,
  loopback,
  seededRnd,
  STATE,
  type Channel,
  type EndpointStatus,
  type LoopbackEndpoint,
  type MessageHandler,
  type NetEndpoint,
  type WireData,
} from "../../src/net/transport";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The bytes a state handler was given, as a fresh copy (f1-game's `bytes.buffer || bytes`). */
function bytesOf(d: WireData): Uint8Array {
  const dv = toView(d);
  if (!dv) throw new Error("state payload is not binary");
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice();
}

/**
 * f1-game's setSkew shifted `tb._epoch` (:63-65). Shifting the epoch by `d`
 * is the same as pumping the loopback with `localNow - d`, so wrap B's
 * endpoint and subtract the accumulated shift on the way in.
 */
function skewable(ep: LoopbackEndpoint): { ep: LoopbackEndpoint; shift(d: number): void } {
  let epochShift = 0;
  const wrapped = Object.create(ep) as LoopbackEndpoint;
  wrapped.pump = (localNow: number): number => ep.pump(localNow - epochShift);
  return {
    ep: wrapped,
    shift(d) {
      epochShift += d;
    },
  };
}

interface PairOptions {
  latency?: number;
  skew?: number;
  jitter?: number;
  loss?: number;
  seed?: number;
}

interface Pair {
  a: NetSession;
  b: NetSession;
  advance(ms: number, step?: number): number;
  setSkew(v: number): void;
  now(): number;
}

// Two peers whose clocks disagree by `skew` ms, on a link with `latency` ms
// each way. Driving both from one virtual clock keeps every assertion exact.
function pair({ latency = 50, skew = 0, jitter = 0, loss = 0, seed = 1 }: PairOptions = {}): Pair {
  let skewNow = skew; // mutable: setSkew() steps B's clock mid-run (an OS suspend)
  const [ta, tbRaw] = loopback({ latencyMs: latency, jitterMs: jitter, loss, rnd: seededRnd(seed) });
  const tb = skewable(tbRaw);
  const a = createSession({ transport: ta, pingEveryMs: 100 });
  const b = createSession({ transport: tb.ep, pingEveryMs: 100 });
  let t = 0;
  return {
    a,
    b,
    // A single virtual clock; B simply reads `skew` higher than A. The step is
    // 1 ms deliberately: a coarser pump quantises each leg of the round trip.
    advance(ms, step = 1) {
      for (let i = 0; i < ms; i += step) {
        t += step;
        a.pump(t);
        b.pump(t + skewNow);
      }
      return t;
    },
    // The wire does not care that B's local clock stepped: shift B's loopback
    // epoch with it so wire time (what the link models) stays continuous.
    setSkew(v) {
      tb.shift(v - skewNow);
      skewNow = v;
    },
    now: () => t,
  };
}

/** A hand-built transport for the tests that need no wire (f1-game :206-209, :449-453). */
function fakeTransport(over: {
  onMessage?: (fn: MessageHandler) => void;
  send?: (channel: Channel, data: WireData) => boolean;
  close?: () => void;
  status?: EndpointStatus;
}): NetEndpoint {
  const ep: NetEndpoint = {
    name: "fake",
    status: over.status ?? "open",
    onMessage(fn) {
      over.onMessage?.(fn);
      return this;
    },
    onOpen() {
      return this;
    },
    onClose() {
      return this;
    },
    setDisconnectGrace: (ms) => ms,
    send: (channel, data) => (over.send ? over.send(channel, data) : true),
    pump: () => 0,
    close: () => over.close?.(),
    stats: () => ({}),
  };
  return ep;
}

test("clock offset is recovered across peers with unrelated clocks", () => {
  // B's clock reads 10 s ahead of A's. A must learn that, or every snapshot B
  // sends lands 10 s in A's future and the rival never draws at all.
  const p = pair({ latency: 50, skew: 10000 });
  p.advance(1500);

  expect(p.a.synced(), "A should have a clock sample").toBe(true);
  expect(p.b.synced(), "B should have a clock sample").toBe(true);
  expect(Math.abs(p.a.offset() - 10000), `A's offset should be ~+10000, got ${p.a.offset()}`).toBeLessThan(5);
  expect(Math.abs(p.b.offset() + 10000), `B's offset should be ~-10000, got ${p.b.offset()}`).toBeLessThan(5);
});

test("a clock STEP on one peer is followed in seconds, not after the whole sample window (NP-3)", () => {
  // B's monotonic clock loses 3 s (suspend with the RTC link surviving). A
  // count-window lowest-RTT pick kept the stale offset for ~19.65 s.
  const p = pair({ latency: 50, skew: 5000 });
  p.advance(3000);
  expect(Math.abs(p.a.offset() - 5000), `precondition: synced at +5000, got ${p.a.offset()}`).toBeLessThan(5);
  p.setSkew(2000);
  let followedAt = -1;
  const t0 = p.now();
  for (let i = 0; i < 20000 && followedAt < 0; i += 50) {
    p.advance(50);
    if (Math.abs(p.a.offset() - 2000) < 20) followedAt = p.now() - t0;
  }
  expect(followedAt >= 0 && followedAt <= 2000, `offset must follow the step within 2 s, took ${followedAt} ms`).toBe(true);
  expect(Math.abs(p.b.offset() + 2000), `B follows too, got ${p.b.offset()}`).toBeLessThan(20);
});

test("jitter spikes are NOT mistaken for a clock step", () => {
  const p = pair({ latency: 50, jitter: 40, skew: 3000, seed: 7 });
  p.advance(8000);
  expect(Math.abs(p.a.offset() - 3000), `offset holds under jitter, got ${p.a.offset()}`).toBeLessThan(25);
});

test("round-trip time is measured, and the one-way lag is half of it", () => {
  const p = pair({ latency: 50 });
  p.advance(1500);
  expect(Math.abs(p.a.rtt() - 100), `100 ms round trip expected, got ${p.a.rtt()}`).toBeLessThan(5);
  expect(Math.abs(p.a.lagMs() - 50), `50 ms one-way expected, got ${p.a.lagMs()}`).toBeLessThan(3);
});

test("a peer timestamp converts onto our timeline and back", () => {
  const p = pair({ latency: 40, skew: -7500 });
  p.advance(1500);
  const theirs = 1234567;
  const ours = p.a.peerToLocal(theirs);
  expect(Math.abs(p.a.localToPeer(ours) - theirs), "conversion must round-trip").toBeLessThan(0.001);
  expect(Math.abs(ours - (theirs + 7500)), "their clock is 7.5 s behind ours").toBeLessThan(5);
});

test("jitter does not drag the offset estimate around", () => {
  // The lowest-RTT sample is kept rather than the mean, because a slow reply
  // is a queued reply and queuing is pure error in the offset.
  const p = pair({ latency: 50, jitter: 40, skew: 3000, seed: 7 });
  p.advance(4000);
  expect(Math.abs(p.a.offset() - 3000), `offset should hold near 3000 despite jitter, got ${p.a.offset()}`).toBeLessThan(25);
});

test("state packets are delivered to the game; ping/pong never are", () => {
  // Clock traffic shares the unreliable channel with snapshots, so the router
  // has to keep them apart.
  const p = pair({ latency: 20 });
  const got: Uint8Array[] = [];
  p.b.onState((bytes) => got.push(bytesOf(bytes)));
  // Sync first: unreliable STATE is held until synced().
  p.advance(1000);
  expect(p.b.synced(), "clock must sync before game state is accepted").toBe(true);
  p.a.sendState(new Uint8Array([1, 2, 3, 4])); // type 1 = snapshot
  p.advance(200);

  expect(got.length, `exactly one game packet expected, got ${got.length}`).toBe(1);
  expect(Array.from(got[0] ?? [])).toEqual([1, 2, 3, 4]);
});

test("a pre-sync snapshot is held and delivered once the clock lands", () => {
  const p = pair({ latency: 20 });
  const got: Uint8Array[] = [];
  p.b.onState((bytes) => got.push(bytesOf(bytes)));
  expect(p.b.synced()).toBe(false);
  p.a.sendState(new Uint8Array([1, 2, 3, 4]));
  // Snapshot one-way is 20 ms; the answering PONG needs the ping's 20+20.
  p.advance(30);
  expect(got.length, "unreliable STATE is held until the first PONG").toBe(0);
  p.advance(1000);
  expect(p.b.synced(), "clock must sync").toBe(true);
  expect(got.length, "the held snapshot is flushed on PONG").toBe(1);
  expect(Array.from(got[0] ?? [])).toEqual([1, 2, 3, 4]);
});

test("events are typed, and only their own handler sees them", () => {
  const p = pair({ latency: 10 });
  const laps: unknown[] = [];
  const settings: unknown[] = [];
  p.b.onEvent("lap", (d) => laps.push(d));
  p.b.onEvent("settings", (d) => settings.push(d));

  p.a.sendEvent("lap", { driver: 4, time: 81.23 });
  p.a.sendEvent("settings", { track: "monza", laps: 5 });
  p.a.sendEvent("unhandled", { ignored: true });
  p.advance(200);

  expect(laps).toEqual([{ driver: 4, time: 81.23 }]);
  expect(settings).toEqual([{ track: "monza", laps: 5 }]);
});

test("events survive a lossy link because they ride the reliable channel", () => {
  // Lap times and race settings cannot be dropped. 60% loss on the state
  // channel must not touch them.
  const p = pair({ latency: 30, loss: 0.6, seed: 11 });
  const got: unknown[] = [];
  p.b.onEvent("x", (d) => got.push(d));
  for (let i = 0; i < 25; i++) p.a.sendEvent("x", i);
  p.advance(500);
  expect(got.length, "every event must arrive").toBe(25);
  expect(got).toEqual(Array.from({ length: 25 }, (_, i) => i));
});

test("a malformed event is dropped rather than thrown", () => {
  const [ta, tb] = loopback({ latencyMs: 0, rnd: seededRnd(3) });
  const b = createSession({ transport: tb });
  let fired = 0;
  b.onEvent("x", () => fired++);
  ta.send("event", "{ not json");
  ta.send("event", JSON.stringify({ no: "type field" }));
  expect(() => b.pump(10)).not.toThrow(); // must not throw
  expect(fired).toBe(0);
  expect(b.alive(), "a bad event is not a disconnect").toBe(true);
});

test("an open transport that never receives a valid packet times out", () => {
  let inbound: MessageHandler | undefined;
  let closed = 0;
  const transport = fakeTransport({
    onMessage(fn) {
      inbound = fn;
    },
    close() {
      closed++;
    },
  });
  const s = createSession({ transport, timeoutMs: 500 });
  const reasons: string[] = [];
  s.onClose((reason) => reasons.push(reason));
  s.pump(100);
  if (!inbound) throw new Error("session did not subscribe to messages");
  inbound(EVENT, JSON.stringify({ t: "unknown", d: {} }), 300);
  inbound(EVENT, "{", 400);
  for (let t = 401; t <= 701; t += 100) s.pump(t);
  expect(s.alive()).toBe(false);
  expect(reasons).toEqual(["timeout"]);
  expect(closed).toBe(1);
  expect(s.lastHeard(), "unhandled or malformed frames are not game liveness").toBeNull();
});

test("silence is detected, and reported once", () => {
  const p = pair({ latency: 20 });
  const closes: string[] = [];
  p.a.onClose((why) => closes.push(why));
  p.advance(600);
  expect(p.a.alive(), "still talking").toBe(true);

  // Pull the wire: A keeps pumping but nothing arrives.
  p.b.close();
  const t = p.now();
  for (let i = 0; i < 400; i++) p.a.pump(t + i * 10);

  expect(p.a.alive(), "A should have noticed the silence").toBe(false);
  expect(closes.length, "close should fire").toBeGreaterThanOrEqual(1);
  expect(closes.filter((c) => c === "timeout").length, "timeout must fire at most once").toBeLessThanOrEqual(1);
});

test("a stall in OUR loop is not silence from THEM", () => {
  // A blocked main thread (circuit build on a phone, a backgrounded tab, a GC
  // pause) must not read as RIVAL DISCONNECTED. A gap in our own pumping says
  // nothing about the other end.
  const p = pair({ latency: 20 });
  const closes: string[] = [];
  p.a.onClose((why) => closes.push(why));
  p.advance(600);
  expect(p.a.alive(), "talking before the stall").toBe(true);

  // Both peers freeze for 10 s — far past timeoutMs — then resume together.
  const t = p.now();
  const after = t + 10000;
  p.a.pump(after);
  p.b.pump(after);
  expect(p.a.alive(), "a shared stall must not read as a disconnect").toBe(true);
  expect(closes).toEqual([]);

  // ...and the connection carries on working.
  for (let i = 1; i < 400; i++) {
    p.a.pump(after + i);
    p.b.pump(after + i);
  }
  expect(p.a.alive(), "still alive after the stall").toBe(true);

  // The forgiveness must NOT make a real disconnect undetectable.
  p.b.close();
  for (let i = 400; i < 1500; i++) p.a.pump(after + i * 10);
  expect(p.a.alive(), "a genuine silence must still be caught").toBe(false);
});

test("a connecting transport gets its ICE window before the first-packet deadline", () => {
  // Do not start the first-packet deadline until the data channel is open.
  // f1-game assigned `ta.status = "connecting"`; apex-26's status is a getter,
  // so the override lives on a wrapper (and, as with a real connecting
  // endpoint, send is refused).
  const [taRaw] = loopback({ latencyMs: 0, rnd: seededRnd(5) });
  const ta = Object.create(taRaw) as LoopbackEndpoint;
  Object.defineProperty(ta, "status", { value: "connecting" });
  ta.send = () => false;
  const a = createSession({ transport: ta, timeoutMs: 500 });
  let closed = false;
  a.onClose(() => {
    closed = true;
  });
  for (let i = 0; i < 500; i++) a.pump(i * 10); // 5 s, peer never replies
  expect(closed, "a connection still establishing ICE is not a silent open channel").toBe(false);
  expect(a.alive()).toBe(true);
});

test("a throwing state handler does not kill the session", () => {
  const p = pair({ latency: 10 });
  let second = 0;
  p.b.onState(() => {
    throw new Error("consumer bug");
  });
  p.b.onState(() => second++);
  p.advance(200); // sync before STATE is accepted
  expect(p.b.synced()).toBe(true);
  p.a.sendState(new Uint8Array([1, 0, 0, 0, 0, 0]));
  p.advance(200);
  expect(second, "the other handler should still run").toBe(1);
  expect(p.b.alive(), "a consumer bug is not a disconnect").toBe(true);
});

test("a session that times out CLOSES ITS TRANSPORT, not just its bookkeeping", () => {
  // The timeout branch once flipped `alive` and fired close handlers without
  // touching the transport, and close() then early-returned on `!alive`: a
  // vanished peer leaked its RTCPeerConnection for the life of the tab.
  // The spy wraps ONE side of a real loopback pair: the peer has to talk
  // first, or the death clock never starts and the test asserts nothing.
  const [ta, tb] = loopback({ latencyMs: 0, rnd: seededRnd(11) });
  let closedTimes = 0;
  const spy = Object.create(ta) as LoopbackEndpoint;
  spy.close = () => {
    closedTimes++;
    ta.close();
  };
  const a = createSession({ transport: spy, pingEveryMs: 100, timeoutMs: 500 });
  const b = createSession({ transport: tb, pingEveryMs: 100 });
  const whys: string[] = [];
  a.onClose((w) => whys.push(w));

  // Talk normally, so A has actually heard from B and the death clock starts.
  for (let t = 0; t < 600; t++) {
    a.pump(t);
    b.pump(t);
  }
  expect(a.alive(), "the pair must be healthy before the wire is pulled").toBe(true);
  expect(closedTimes, "nothing closes a healthy transport").toBe(0);

  // Pull the wire: B stops pumping entirely and A hears nothing more.
  for (let t = 600; t < 3000; t++) a.pump(t);

  expect(a.alive(), "A must have noticed the silence").toBe(false);
  expect(whys, "the close reason must still be `timeout`").toEqual(["timeout"]);
  expect(closedTimes, "the transport must be closed exactly once on timeout").toBe(1);
  // The `!alive` early return in close() must not let a later close() double-close.
  a.close();
  expect(closedTimes, "close() after a timeout must not close the transport again").toBe(1);
});

// ── round 8: release is latched separately from alive ────────────────────────
test("after the transport closes itself, session.close() neither throws nor re-closes", () => {
  // The transport's close event marks it RELEASED. A later session.close()
  // must be a clean no-op.
  const [ta, tb] = loopback({ latencyMs: 0, rnd: seededRnd(21) });
  let closedTimes = 0;
  const spy = Object.create(ta) as LoopbackEndpoint;
  spy.close = () => {
    closedTimes++;
    ta.close();
  };
  const a = createSession({ transport: spy, pingEveryMs: 100 });
  const whys: string[] = [];
  a.onClose((w) => whys.push(w));
  a.pump(0);
  tb.pump(0);
  tb.close(); // peer side pulls the plug
  a.pump(1); // deliver the close
  expect(a.alive()).toBe(false);
  expect(whys).toEqual(["transport"]);
  expect(() => a.close()).not.toThrow(); // must not re-close or re-fire
  expect(closedTimes, "the transport closed itself; nothing to release").toBe(0);
  expect(whys, "close handlers fire once").toEqual(["transport"]);
});

// Every test above wires two sessions together, so a PING is always answered.
// A session against a BARE endpoint (what __apex.netLoopback builds) never
// syncs: every snapshot lands in heldState while the session reports alive.
function bareFarEnd({ latency = 0 }: { latency?: number } = {}): { near: LoopbackEndpoint; far: LoopbackEndpoint; T0: number } {
  const [ta, tb] = loopback({ latencyMs: latency, rnd: seededRnd(31) });
  const T0 = 1000;
  ta.pump(T0);
  tb.pump(T0); // both epochs, as netLoopback does
  return { near: ta, far: tb, T0 };
}
// A REAL-LENGTH snapshot, not a 4-byte stub: PING_BYTES is 13, so a short stub
// is rejected by the length check alone and the type check never proves itself.
const snapshotBytes = (): Uint8Array => {
  const u = new Uint8Array(24);
  u[0] = 1;
  u[1] = 2;
  u[2] = 3;
  u[3] = 4;
  return u;
};

test("a session talking to a BARE endpoint never syncs, and the game gets nothing", () => {
  const { near, far, T0 } = bareFarEnd();
  const session = createSession({ transport: near });
  const got: WireData[] = [];
  session.onState((bytes) => got.push(bytes));
  session.pump(T0); // sends the first PING
  far.pump(T0); // the far end receives it and ignores it
  far.send(STATE, snapshotBytes());
  session.pump(T0 + 10);

  expect(session.synced(), "nothing can answer the PING, so no clock sample exists").toBe(false);
  expect(got.length, "the snapshot is held, not delivered").toBe(0);
  // The trap that makes this silent: none of the obvious health signals move.
  expect(session.alive(), "the session still reports itself alive").toBe(true);
  expect(session.lastHeard(), "and still reports hearing the peer").toBe(T0 + 10);
});

test("autoPong makes a bare endpoint stand in for a peer, and state flows", () => {
  const { near, far, T0 } = bareFarEnd();
  expect(autoPong(far), "autoPong attaches to a transport endpoint").toBe(true);
  const session = createSession({ transport: near });
  const got: WireData[] = [];
  session.onState((bytes) => got.push(bytes));
  session.pump(T0); // PING out at t0
  far.pump(T0); // PONG queued, stamped with the far clock
  far.send(STATE, snapshotBytes());
  session.pump(T0 + 10); // PONG then snapshot, in send order

  expect(session.synced(), "one round trip is enough").toBe(true);
  expect(session.rtt(), "the round trip is the two pumps' separation").toBe(10);
  expect(got.length, "the snapshot reaches the game on the same pump").toBe(1);
  expect(Array.from(bytesOf(got[0] ?? "")).slice(0, 4), "the bytes the game receives are the bytes the peer sent").toEqual([1, 2, 3, 4]);
});

test("autoPong answers only PINGs, and refuses a transport it cannot use", () => {
  const { near, far, T0 } = bareFarEnd();
  autoPong(far);
  const session = createSession({ transport: near });
  const seen: WireData[] = [];
  session.onState((bytes) => seen.push(bytes));
  session.pump(T0);
  far.pump(T0);
  // A snapshot arriving at the far end must not be answered as if it were a
  // ping — a PONG built from snapshot bytes poisons offset for the session.
  near.send(STATE, snapshotBytes());
  far.pump(T0 + 5);
  session.pump(T0 + 10);
  expect(session.stats().samples, "exactly one clock sample: the PING's, not the snapshot's").toBe(1);
  expect(autoPong(null)).toBe(false);
  expect(autoPong({} as unknown as NetEndpoint), "a thing with no onMessage/send is not a transport").toBe(false);
});

// The handshake rides the SAME unreliable channel as the snapshots, so on a
// lossy link the rival does not appear until a round trip survives. Pinging
// every 100 ms UNTIL the first sample lands fixes the odds.
test("an unsynced session pings harder than a synced one", () => {
  const sent: Array<{ channel: Channel; at: number | undefined }> = [];
  const fake = fakeTransport({
    send(channel, data) {
      sent.push({ channel, at: typeof data === "string" ? data.length : toView(data)?.byteLength });
      return true;
    },
  });
  const s = createSession({ transport: fake });
  // Nothing answers, so synced() stays false and the fast cadence holds.
  for (let t = 0; t <= 1000; t += 25) s.pump(t);
  expect(s.synced()).toBe(false);
  const unsyncedPings = sent.length;
  expect(unsyncedPings, `expected ~10 pings in 1 s at the 100 ms sync cadence, got ${unsyncedPings}`).toBeGreaterThanOrEqual(9);
  // The steady-state cadence is the slower one: the SAME second at 500 ms
  // would send about two.
  const slow = createSession({ transport: fake, syncPingEveryMs: 500 });
  const before = sent.length;
  for (let t = 0; t <= 1000; t += 25) slow.pump(t);
  const slowPings = sent.length - before;
  expect(
    slowPings <= 3 && slowPings < unsyncedPings,
    `500 ms cadence should send ~2-3 pings in a second, got ${slowPings} against ${unsyncedPings}`,
  ).toBe(true);
});

test("the fast cadence stops once the clock has landed", () => {
  // A real loopback pair with an answering far end, and a counter on the near
  // end's send so the cadence is measured on the wire.
  const [ta, tb] = loopback({ latencyMs: 0, rnd: seededRnd(41) });
  autoPong(tb);
  let pings = 0;
  const send = ta.send.bind(ta);
  ta.send = (channel, data) => {
    if (channel === STATE && toView(data)?.byteLength === 13) pings++;
    return send(channel, data);
  };
  const s = createSession({ transport: ta, pingEveryMs: 500, syncPingEveryMs: 100 });
  let t = 0;
  const step = (): void => {
    t += 25;
    s.pump(t);
    tb.pump(t);
  };
  while (t < 300) step();
  expect(s.synced(), "a clean link syncs inside 300 ms even at the slow cadence").toBe(true);
  const afterSync = pings;
  while (t < 1300) step(); // one more second, now synced
  const steady = pings - afterSync;
  expect(steady >= 1 && steady <= 3, `a synced session pings ~2x per second at 500 ms, sent ${steady}`).toBe(true);
});

// ── the PONG must answer a ping WE sent ──────────────────────────────────────
// Only a PONG naming an outstanding ping with that ping's own t0 is a sample,
// and each is a sample once.
test("a PONG for a ping we never sent, or with a forged t0, is not a clock sample", () => {
  const { near, far, T0 } = bareFarEnd();
  const session = createSession({ transport: near });
  const pong = (id: number, t0: number, t1: number): Uint8Array => {
    const dv = new DataView(new ArrayBuffer(21));
    dv.setUint8(0, PONG);
    dv.setUint32(1, id >>> 0);
    dv.setFloat64(5, t0);
    dv.setFloat64(13, t1);
    return new Uint8Array(dv.buffer);
  };
  session.pump(T0); // PING id 1 at t0 = T0
  far.pump(T0);
  far.send(STATE, pong(99, T0, T0 + 5)); // unknown id
  far.send(STATE, pong(1, T0 - 100000, T0 + 5)); // our id, somebody else's t0
  session.pump(T0 + 10);
  expect(session.synced(), "neither forged PONG may seed the clock").toBe(false);
  far.send(STATE, pong(1, T0, T0 + 5)); // the genuine echo
  far.send(STATE, pong(1, T0, T0 + 5)); // ...replayed
  session.pump(T0 + 20);
  expect(session.synced(), "the genuine echo syncs").toBe(true);
  expect(session.stats().samples, "and a replay of it is not a second sample").toBe(1);
});

// ── round 9: the PONG's hold is not path, and a local close() is "local" ─────
test("a reply held by the peer for a frame does not bias the clock offset", () => {
  // The PONG used to carry only t1; the peer's hold was counted as path and
  // split evenly — an offset error of half the hold. NTP's four stamps remove it.
  const { near, far, T0 } = bareFarEnd();
  const session = createSession({ transport: near });
  const pong = (id: number, t0: number, t1: number, t2: number): Uint8Array => {
    const dv = new DataView(new ArrayBuffer(29));
    dv.setUint8(0, PONG);
    dv.setUint32(1, id >>> 0);
    dv.setFloat64(5, t0);
    dv.setFloat64(13, t1);
    dv.setFloat64(21, t2);
    return new Uint8Array(dv.buffer);
  };
  session.pump(T0); // PING id 1 at t0 = T0
  far.pump(T0);
  // Peer clock = ours (true offset 0). The PING arrived at T0+50 (50 ms one
  // way), the peer held it 100 ms, the PONG lands at T0+200.
  far.send(STATE, pong(1, T0, T0 + 50, T0 + 150));
  session.pump(T0 + 200);
  expect(session.synced()).toBe(true);
  expect(session.rtt(), "the hold leaves the round trip").toBe(100);
  expect(session.offset(), "and the offset is the truth, not −50").toBe(0);
});

test("a PONG without t2 (21 bytes) is still a sample, read as if unheld", () => {
  const { near, far, T0 } = bareFarEnd();
  const session = createSession({ transport: near });
  const dv = new DataView(new ArrayBuffer(21));
  session.pump(T0);
  far.pump(T0);
  dv.setUint8(0, PONG);
  dv.setUint32(1, 1);
  dv.setFloat64(5, T0);
  dv.setFloat64(13, T0 + 50);
  far.send(STATE, new Uint8Array(dv.buffer));
  session.pump(T0 + 100);
  expect(session.synced()).toBe(true);
  expect(session.offset()).toBe(0);
});

// Truncated type=4 must not refresh lastHeardAt after sync — otherwise a silent
// (or hostile) peer keeps the 6 s timeout from firing.
test("a truncated PONG after sync does not keep the session alive past timeout", () => {
  const [ta, tb] = loopback({ latencyMs: 0, rnd: seededRnd(77) });
  const realSend = tb.send.bind(tb);
  let answerPings = true;
  tb.onMessage((ch, data) => {
    if (!answerPings || ch !== STATE) return;
    const dv = toView(data);
    if (!dv || dv.byteLength < 13 || dv.getUint8(0) !== PING) return;
    const out = new DataView(new ArrayBuffer(29));
    out.setUint8(0, PONG);
    out.setUint32(1, dv.getUint32(1));
    out.setFloat64(5, dv.getFloat64(5));
    out.setFloat64(13, 0);
    out.setFloat64(21, 0);
    realSend(STATE, new Uint8Array(out.buffer));
  });
  const near = createSession({ transport: ta, timeoutMs: 600, pingEveryMs: 500, syncPingEveryMs: 100 });
  let t = 0;
  while (t < 400) {
    t += 25;
    near.pump(t);
    tb.pump(t);
  }
  expect(near.synced(), "pair must sync before the truncated flood").toBe(true);
  answerPings = false;
  const heardAtSync = near.lastHeard();
  for (; t <= 1400; t += 50) {
    realSend(STATE, new Uint8Array([PONG]));
    near.pump(t);
    tb.pump(t);
  }
  expect(near.alive(), "truncated PONGs must not defeat the silence timeout").toBe(false);
  const heard = near.lastHeard();
  expect(heard === heardAtSync || (heard != null && heard < 400), "lastHeard must not track the truncated flood").toBe(true);
});

test("session.close() reports 'local' to its own handlers and 'transport' to the peer's", () => {
  // release() closes the transport, whose close event fires synchronously; if
  // `alive` were still true our own close() would be reported as "transport".
  const [ta, tb] = loopback({ latencyMs: 0, rnd: seededRnd(21) });
  const a = createSession({ transport: ta });
  const b = createSession({ transport: tb });
  const whysA: string[] = [];
  const whysB: string[] = [];
  a.onClose((w) => whysA.push(w));
  b.onClose((w) => whysB.push(w));
  a.pump(0);
  b.pump(0);
  a.close();
  b.pump(1);
  expect(whysA).toEqual(["local"]);
  expect(whysB).toEqual(["transport"]);
  a.close();
  expect(whysA, "a second close() fires nothing").toEqual(["local"]);
});

// L8-e: a HIDDEN tab pumps on purpose at the platform's slow cadence. Every
// such pump read as a stall and was forgiven, so a peer who had quit was never
// timed out while hidden. Hidden, silence is real silence.
test("a hidden tab still times out a gone peer; a visible stall is still forgiven", () => {
  vi.stubGlobal("document", { hidden: true });
  const p = pair({ latency: 20 });
  p.advance(600);
  expect(p.a.alive()).toBe(true);
  p.b.close();
  const t = p.now();
  for (let i = 1; i <= 8; i++) p.a.pump(t + i * 1000); // eight hidden 1 Hz pumps
  expect(p.a.alive(), "hidden: a silent peer is gone after ~timeoutMs, not after the tab returns").toBe(false);

  // A hidden tab whose peer is ALIVE keeps the link: arrivals still count.
  const q = pair({ latency: 20 });
  q.advance(600);
  const u = q.now();
  for (let i = 1; i <= 12; i++) {
    q.b.pump(u + i * 1000);
    q.a.pump(u + i * 1000);
  }
  expect(q.a.alive(), "hidden 1 Hz pumping with a live peer is not a timeout").toBe(true);

  vi.stubGlobal("document", { hidden: false });
  const v = pair({ latency: 20 });
  v.advance(600);
  const w = v.now() + 10000;
  v.a.pump(w);
  v.b.pump(w);
  expect(v.a.alive(), "visible: a 10 s local stall is still forgiven").toBe(true);
});

// L8-f: a race raises the silence that ends a session (NetPlay's 25 s grace);
// the lobby keeps the 6 s default.
test("setTimeoutMs raises the silence that ends the session", () => {
  const p = pair({ latency: 20 });
  p.advance(600);
  expect(p.a.setTimeoutMs(25_000)).toBe(25_000);
  expect(p.a.setTimeoutMs(-1), "nonsense is ignored").toBe(25_000);
  const t = p.now(); // B stops pumping: silent, its transport still open
  for (let i = 1; i <= 200; i++) p.a.pump(t + i * 100); // 20 s of silence
  expect(p.a.alive(), "inside the grace").toBe(true);
  for (let i = 201; i <= 300; i++) p.a.pump(t + i * 100); // 30 s
  expect(p.a.alive(), "past it").toBe(false);
});
