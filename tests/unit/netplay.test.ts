/**
 * netplay.test.ts — rejoin, spectating, grid separation and start arming.
 * Ports of three f1-game files, over the typed harness in helpers/net-ctx.ts:
 *
 * - tests/unit/netplay-resilience.test.mjs:1-154 (rejoin over a fresh
 *   loopback :79-116, spectators :118-154).
 * - tests/unit/net-grid-separation.test.mjs:1-114 (pace grid :97-104,
 *   qualifying grid :106-114).
 * - tests/unit/net-start-arming.test.mjs:1-148 (late ARMED :48-67, interp
 *   presentedAt :69-75, the 45 s hold :77-83, clock skew :85-115, #2199
 *   RESULT kept :121-148).
 *
 * SKIPPED / PARTIAL:
 * - netplay-resilience.test.mjs:120-121 asserted js/net/lobby.js has
 *   `const MAX_GUESTS = 3;` — lobby.js is not ported; that one assertion is dropped.
 * - net-start-arming.test.mjs:139-143 ran js/game.js `netOrder()` through
 *   symbolSource + vm; game.js is not ported, so those lines are dropped and the
 *   rest of the #2199 test (lastResult kept, then cleared for a new field) stays.
 * - net-start-arming.test.mjs:77-83 read js/net/netplay.js; it reads
 *   src/net/netplay.ts here (the port keeps the same lines).
 * Session ids are strings (SessionEntry.id); f1-game used 1 and 2.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createNetPlay, Spectate } from "../../src/net/netplay";
import { createSession } from "../../src/net/session";
import { createInterp } from "../../src/net/snapshot";
import { loopback } from "../../src/net/transport";
import { carAt, FakeSession, lapPose, must, startOk, stubCtx, type StubCtx } from "./helpers/net-ctx";

// ─── netplay-resilience.test.mjs ────────────────────────────────────────────

/** netplay-resilience `stubG(n, local)`: three laps, a race clock, monza. */
function resilienceCtx(n = 4, local = 0): StubCtx {
  const G = stubCtx(n, { local, lapsTarget: 3, raceT: 20, trackDef: { id: "monza" } });
  for (const c of G.cars) c.lap = 1;
  return G;
}

test("a dropped driver rejoins the live host over a fresh loopback and resyncs state", () => {
  const hostG = resilienceCtx(3, 0);
  const guestG = resilienceCtx(3, 1);
  const host = createNetPlay(hostG);
  const guest = createNetPlay(guestG);
  const firstWire = loopback({ latencyMs: 0 });
  const firstHost = createSession({ transport: firstWire[0] });
  const firstGuest = createSession({ transport: firstWire[1] });
  startOk(host, {
    role: "host",
    session: firstHost,
    sessions: [{ id: "driver-a", session: firstHost, kind: "driver" }],
    peers: [{ id: "driver-a", kind: "driver" }],
  });
  startOk(guest, { role: "guest", session: firstGuest });
  let t = 1000;
  for (let i = 0; i < 20; i++) {
    t += 25;
    host.tick(t);
    guest.tick(t);
  }
  const wire = must(host.status().remotes[0]).wire;
  const car = carAt(hostG, wire);

  firstGuest.close();
  for (let i = 0; i < 5; i++) {
    t += 25;
    host.tick(t);
    guest.tick(t);
  }
  expect(host.active(), "the host race stays reconnectable when its last driver drops").toBe(true);
  expect(guest.active(), "the dropped side leaves its old session").toBe(false);
  expect(car.human, "AI covers the disconnected car").toBe(false);

  const secondWire = loopback({ latencyMs: 0 });
  const secondHost = createSession({ transport: secondWire[0] });
  const secondGuest = createSession({ transport: secondWire[1] });
  const joined = host.rejoin({ id: "driver-a", session: secondHost });
  expect(joined).toEqual({ ok: true, wire });
  startOk(guest, { role: "guest", session: secondGuest });
  expect(car.human).toBe(true);
  expect(host.owns(car)).toBe(true);
  for (let i = 0; i < 20; i++) {
    t += 25;
    host.tick(t);
    guest.tick(t);
  }
  must(guestG.player).s = 777;
  for (let i = 0; i < 12; i++) {
    t += 25;
    guest.tick(t);
    host.tick(t);
  }
  expect(Math.abs(car.s - 777) < 1, "the returning owner's fresh snapshot replaces fallback AI state: " + car.s).toBe(true);
});

test("a spectator consumes no grid seat, receives field state, and cannot publish inputs", () => {
  expect(Spectate, "the spectator policy module (js/net/spectate.js) is ported").toBeTruthy();
  const G = resilienceCtx(4);
  const net = createNetPlay(G);
  const spectator = new FakeSession();
  startOk(net, {
    role: "host",
    session: spectator,
    sessions: [{ id: "watch-a", session: spectator, kind: "spectator" }],
    peers: [{ id: "watch-a", kind: "spectator" }],
  });

  expect(net.status().remotes.length, "a spectator-only audience occupies no car").toBe(0);
  expect(net.status().spectators).toBe(1);
  const before = G.cars.map((car) => car.human);
  spectator.feed(1000, 2, lapPose(999), 1000);
  net.tick(1000);
  expect(
    G.cars.map((car) => car.human),
    "spectator state has no authority",
  ).toEqual(before);

  for (let t = 1050; t <= 1200; t += 50) net.tick(t);
  expect(
    spectator.states.some((packet) => packet && packet.cars.length),
    "the host fan-out sends race state to the spectator",
  ).toBe(true);

  const SG = resilienceCtx(4, -1);
  const watch = createNetPlay(SG);
  const host = new FakeSession();
  startOk(watch, { role: "spectator", session: host });
  host.feed(2000, 0, lapPose(432), 2000);
  watch.tick(2000);
  expect(carAt(SG, 0).s, "the spectator renders received car state").toBe(432);
  expect(host.states.length, "a spectator never publishes a local snapshot").toBe(0);
  expect(watch.sendEvent("lap", { lap: 2 }), "a spectator cannot publish race inputs/events").toBe(false);
  expect(watch.ownsRaceControl()).toBe(false);
  expect(watch.ownsClassification()).toBe(false);
});

// ─── net-grid-separation.test.mjs ───────────────────────────────────────────

/**
 * net-grid-separation `gridG(n, {preOrdered})`. gridPos runs BACKWARDS (car i
 * at n - i): pickRemoteSlot seats the peers in cars[1] and cars[2], and if
 * those already sat at the two slots after the local car's, separateGrid would
 * correctly do nothing and the pace-grid test would pass against a gutted
 * function.
 */
function gridCtx(n: number, preOrdered: boolean): StubCtx {
  const G = stubCtx(n, { gridPreOrdered: preOrdered });
  G.cars.forEach((c, i) => {
    c.gridPos = n - i;
  });
  return G;
}

/** Start a host holding two guests, so THREE humans share the grid. */
function startWithPeers(G: StubCtx): void {
  const net = createNetPlay(G);
  const sa = new FakeSession();
  const sb = new FakeSession();
  startOk(net, {
    role: "host",
    session: sa,
    sessions: [
      { id: "a", session: sa },
      { id: "b", session: sb },
    ],
    peers: [{ id: "a" }, { id: "b" }],
  });
}

test("a PACE grid is re-laid, because every peer's own car is at P12", () => {
  const G = gridCtx(8, false);
  startWithPeers(G);
  expect(
    G.swaps.length > 0,
    "separateGrid must still lay the humans into consecutive boxes on the pace grid — that is the defect it exists for",
  ).toBe(true);
});

test("a QUALIFYING grid is left exactly as qualifying laid it", () => {
  const G = gridCtx(8, true);
  const before = G.cars.map((c) => c.gridPos);
  startWithPeers(G);
  expect(
    G.swaps,
    "a pre-ordered grid is already peer-identical, and re-anchoring it on the LOCAL car's slot puts the humans " +
      "in different boxes on every machine",
  ).toEqual([]);
  expect(G.cars.map((c) => c.gridPos), "and no car may have moved").toEqual(before);
});

// ─── net-start-arming.test.mjs ──────────────────────────────────────────────

test("a guest whose circuit built first still gets the start named promptly", () => {
  const [ta, tb] = loopback({ latencyMs: 20 });
  const hs = createSession({ transport: ta });
  const gs = createSession({ transport: tb });
  hs.onEvent("hello", () => {}); // the LOBBY's handlers: no ARMED among them
  let t = 0;
  for (let i = 0; i < 20; i++) {
    t += 25;
    hs.pump(t);
    gs.pump(t);
  }
  const Gg = stubCtx(2);
  const ng = createNetPlay(Gg);
  startOk(ng, { role: "guest", session: gs });
  // The host is still inside `await G.startRace()`: its lobby timer keeps pumping.
  for (let i = 0; i < 20; i++) {
    t += 25;
    hs.pump(t);
    ng.tick(t);
  }
  const Gh = stubCtx(2);
  const nh = createNetPlay(Gh);
  Gh.netNow = t;
  nh.start({ role: "host", session: hs, sessions: [{ id: "1", session: hs }], peers: [{ id: "1", profile: null }] });
  const h0 = t;
  nh.hostStart();
  let named: number | null = null;
  for (let i = 0; i < 1400 && named == null; i++) {
    t += 25;
    nh.tick(t);
    ng.tick(t);
    if (Gh.netStart) named = t;
  }
  expect(named != null, "the host named the moment").toBe(true);
  expect(must(named) - h0 < 3000, `named ${must(named) - h0} ms after hostStart — not the 20 s ARM_WAIT backstop`).toBe(true);
});

test("the snapshot interpolator reports the time it last posed", () => {
  const interp = createInterp({ delayMs: 100 });
  interp.push(1000, { s: 0, x: 0, head: 0, lap: 1, speed: 80 });
  interp.push(1100, { s: 8, x: 0, head: 0, lap: 1, speed: 80 });
  interp.sample(1200, {});
  expect(interp.presentedAt(), "sample(now) poses now - delayMs, and a relay must stamp that time").toBe(1100);
});

test("the host holds the grid 45 s for a guest that cannot arm yet, and says so (a split start was the 20 s alternative)", () => {
  const src = readFileSync(new URL("../../src/net/netplay.ts", import.meta.url), "utf8");
  expect(src).toMatch(/const ARM_WAIT_MS = 45000;/);
  expect(src, "the guest's own backstop still outlasts the host's wait").toMatch(/const HOLD_MAX_MS = ARM_WAIT_MS \+ 10000;/);
  expect(src).toMatch(/G\.announce\("WAITING FOR RIVAL — "/);
});

test("the named moment lands at the SAME instant on a guest whose clock is 5 s off the host's", () => {
  // The guest's clock runs SKEW ahead of the host's: each side pumps with its
  // own time, the sessions measure the offset from PING/PONG, and the instant
  // must agree (START was once converted twice).
  const SKEW = 5000;
  const [ta, tb] = loopback({ latencyMs: 20 });
  const hs = createSession({ transport: ta });
  const gs = createSession({ transport: tb });
  let t = 1000;
  const pump = (): void => {
    t += 25;
    hs.pump(t);
    gs.pump(t + SKEW);
  };
  for (let i = 0; i < 40; i++) pump();
  expect(hs.synced() && gs.synced(), "both clocks synced over the loopback").toBe(true);
  expect(Math.abs(hs.offset() - SKEW) < 30, `host sees the guest ${hs.offset()} ms ahead`).toBe(true);
  const Gh = stubCtx(2);
  const nh = createNetPlay(Gh);
  const Gg = stubCtx(2);
  const ng = createNetPlay(Gg);
  startOk(ng, { role: "guest", session: gs });
  nh.start({ role: "host", session: hs, sessions: [{ id: "1", session: hs }], peers: [{ id: "1", profile: null }] });
  Gh.netNow = t;
  Gg.netNow = t + SKEW;
  nh.hostStart();
  for (let i = 0; i < 200 && !(Gh.netStart && Gg.netStart); i++) {
    pump();
    Gh.netNow = t;
    Gg.netNow = t + SKEW;
    nh.tick(t);
    ng.tick(t + SKEW);
  }
  expect(Gh.netStart && Gg.netStart, "both sides hold a start").toBeTruthy();
  const hStart = must(Gh.netStart);
  const gStart = must(Gg.netStart);
  // The same physical instant: the guest's `at` is the host's `at` plus the skew.
  const err = gStart.at - (hStart.at + SKEW);
  expect(Math.abs(err) < 40, `guest at − (host at + skew) = ${err} ms (was −${SKEW} with the double conversion)`).toBe(true);
  expect(gStart.hold, "one hold for both").toBe(hStart.hold);
});

// #2199: a host that sent RESULT and quit to menu a moment later must not hand
// the guest a different classification. (The netOrder() half is game.js: skipped.)
test("a guest keeps the host's RESULT when the host quits before the guest's results (#2199)", () => {
  const [ta, tb] = loopback({ latencyMs: 20 });
  const hs = createSession({ transport: ta });
  const gs = createSession({ transport: tb });
  let t = 0;
  for (let i = 0; i < 20; i++) {
    t += 25;
    hs.pump(t);
    gs.pump(t);
  }
  const Gh = stubCtx(2);
  const nh = createNetPlay(Gh);
  const Gg = stubCtx(2);
  const ng = createNetPlay(Gg);
  startOk(ng, { role: "guest", session: gs });
  nh.start({ role: "host", session: hs, sessions: [{ id: "1", session: hs }], peers: [{ id: "1", profile: null }] });
  for (let i = 0; i < 4; i++) {
    t += 25;
    nh.tick(t);
    ng.tick(t);
  }
  // The host's photo finish: drv1 ahead, which the guest's own order disagrees with.
  const rows = [
    { d: "drv1", t: 90.001, lap: 3, classified: true, r: 0 },
    { d: "drv0", t: 90.002, lap: 3, classified: true, r: 0 },
  ];
  expect(nh.reportResult(rows)).toBe(true);
  nh.stop("local"); // back to menu at once
  for (let i = 0; i < 10; i++) {
    t += 25;
    gs.pump(t);
    ng.tick(t);
  }
  expect(ng.active(), "the guest's session ended (BYE or close)").toBe(false);
  expect(ng.lastResult(), "…but the host's verdict that arrived first is kept").toEqual(rows);

  // A later race builds a new field: the kept verdict never reaches it.
  Gg.cars = stubCtx(2).cars;
  expect(ng.lastResult(), "no stale verdict for the next race").toBe(null);
});
