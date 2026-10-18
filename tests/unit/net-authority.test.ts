/**
 * net-authority.test.ts — WHO IS ALLOWED TO DECLARE WHAT, over a fake wire.
 * Port of f1-game tests/unit/net-authority.test.mjs:1-1590.
 *
 * netplay states its authority model as two predicates, ownsRaceControl() and
 * ownsClassification(): `!active || role === "host"`. The SEND sides consult
 * them; these tests pin that the RECEIVE sides do too, because a host holds one
 * session per guest and binds its handlers to every one of them (f1-game
 * :1-30 has the full history).
 *
 * The harness (tests/unit/helpers/net-ctx.ts) drives createNetPlay with a stub
 * NetPlayCtx and a hand-rolled FakeSession (f1-game :93-145, :169-212).
 *
 * Ported, f1-game line ranges:
 *   :150-172 no_slot rollback; :213-399 START/CAUTION/RESULT/LAP/QUALI/QLIVE
 *   authority; :401-451 two-guest host; :741-757 NO TIME marker;
 *   :841-950 round 8 (netStart, NP-6, slotless ARMED, pickRemoteSlot,
 *   strategy epochs); :952-990 host AI retirement on the guest;
 *   :998-1178 finish/retirement/handback/stop reason/BYE/onStop/pose stamp;
 *   :1179-1346 relay, 20 Hz, arrival stamps, AI replication;
 *   :1347-1392 (partial, see below); :1393-1437 epoch gate and silence grace;
 *   :1489-1590 late LEFT, never-speaking rival, AI scrub, hidden tab,
 *   QUALI rival driverId.
 *
 * SKIPPED (code another lane has not ported):
 *   :53-75, :76-91 netOrder() from js/game.js via symbolSource + vm.
 *   :453-740 LOBBY phase (11 tests) drive js/net/lobby.js, not ported.
 *   :759-840 QualiNet (4 tests) drive js/race/quali-net.js.
 *   :992-996 retireCar() source regex on js/game.js (symbolSource).
 *   :1438-1466 and :1467-1488 need js/race/race-control.js (RaceControl).
 * PARTIAL: :1347-1392 ran game.js retireCar() through vm to produce the event;
 * here the net-relevant lines of it (game.js:6440-6449) are inlined.
 * ADAPTED: :899-900 regexes now read src/net/netplay.ts; the comment pin
 * "pickRemoteSlot(null) has always had the any-free-car" became the port's
 * comment "any-free-car arm". Session ids are strings (SessionEntry.id).
 * f1-game asserted `tyreWear === undefined` for untouched cars; NetCar has a
 * numeric default, so those assert the value is unchanged.
 */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import type { NetCar } from "../../src/contracts/net";
import {
  bindQuali,
  createNetPlay,
  EV,
  QUALI_RATE,
  qualiReporters,
  strategyState,
  validQuali,
} from "../../src/net/netplay";
import { decodeSnapshot, encodeAged, TYPE_AGED, TYPE_SNAPSHOT } from "../../src/net/snapshot";
import type { WireData } from "../../src/net/transport";
import {
  carAt,
  FakeSession,
  lapPose,
  must,
  poseCtx,
  started,
  startOk,
  stubCar,
  stubCtx,
  type StubCtx,
} from "./helpers/net-ctx";

afterEach(() => {
  vi.unstubAllGlobals();
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

test("no_slot rolls back the car role and disposes the unadopted session", () => {
  const G = stubCtx(2);
  // No local car means start must fail, but slot selection will temporarily
  // claim one of these cars before it discovers that the local side is absent.
  for (const car of G.cars) {
    car.local = false;
    car.human = false;
    car.isPlayer = false;
  }
  G.player = null;
  const net = createNetPlay(G);
  const s = new FakeSession();

  const out = net.start({ role: "guest", session: s });

  expect(out).toEqual({
    ok: false,
    error: "no_slot",
    message: "Could not find a grid slot for both drivers.",
  });
  expect(net.active()).toBe(false);
  expect(s.closed, "a rejected session must not keep its transport alive").toBe(1);
  expect(s.handlerCount(), "a rejected session must not retain NetPlay handlers").toBe(0);
  expect(
    G.cars.some((car) => car.human || car.local),
    "a partially claimed grid car must return to AI ownership",
  ).toBe(false);
});

test("the harness itself works — a GUEST obeys the host's START", () => {
  // ANTI-VACUITY: every test below asserts that something does NOT happen.
  const { G, s } = started("guest");
  s.deliver("start", { at: 12345, hold: 1.0 });
  expect(G.netStart, "a guest must obey a START from the host").toBeTruthy();
  expect(must(G.netStart).at).toBe(12345);
  expect(must(G.netStart).hold).toBe(1.0);
});

test("a guest keeps racing after the host leaves and is told that rivals are now AI", () => {
  const { G, net, s } = started("guest");
  const rival = carAt(G, 1);
  expect(rival.human, "the connected host owns the rival before disconnect").toBe(true);

  s.disconnect("transport");

  expect(net.active(), "the network session ends").toBe(false);
  expect(rival.human, "the host's car returns to local AI").toBe(false);
  expect(
    G.announcements.some((m) => /HOST LEFT — RIVALS NOW AI/.test(m)),
    `the continuing race needs an honest visible announcement: ${G.announcements.join(" | ")}`,
  ).toBe(true);
});

test("a HOST ignores a START arriving from a guest", () => {
  const { G, s } = started("host");
  s.deliver("start", { at: 999, hold: 5 });
  expect(G.netStart, "a guest must not be able to set the host's netStart").toBe(null);
});

test("a HOST ignores a CAUTION arriving from a guest", () => {
  const { G, s } = started("host");
  s.deliver("caution", { kind: "sc", lap: 3 });
  expect(G.caughtCautions, "a guest must not apply a caution on the host").toEqual([]);
});

test("a GUEST obeys a CAUTION from the host", () => {
  const { G, s } = started("guest");
  s.deliver("caution", { kind: "sc", lap: 3 });
  expect(G.caughtCautions, "the host's caution is authoritative").toEqual([{ kind: "sc", lap: 3 }]);
});

test("a HOST ignores a RESULT arriving from a guest", () => {
  const { net, s } = started("host");
  s.deliver("result", { rows: [{ pos: 1, name: "not yours" }] });
  expect(net.peerResult(), "the host owns classification; a guest's RESULT is not it").toBe(null);
});

test("a GUEST obeys a RESULT from the host", () => {
  const { net, s } = started("guest");
  const rows = [
    { d: "drv1", t: 10, p: 0 },
    { d: "drv0", t: 11, p: 0 },
  ];
  s.deliver("result", rows);
  expect(net.peerResult()).toEqual(rows);
});

test("a malformed host RESULT does not end the guest's classification wait", () => {
  const { net, s } = started("guest");
  for (const rows of [
    [{ d: "drv0" }, { d: "drv0" }],
    [{ d: "drv0", classified: "false" }, { d: "drv1" }],
    [{ d: "drv0" }, { d: "drv1", lap: -1 }],
  ]) {
    s.deliver("result", rows);
    expect(net.peerResult()).toBe(null);
  }
  expect(net.awaitingResult(1000)).toBe(true);
});

test("the per-peer events a host DOES own are still accepted from a guest", () => {
  const { net, s } = started("host");
  // Product LAP is {lap, time, best, code}; sendersOwnDriver matches code OR driverId.
  s.deliver("lap", { lap: 2, time: 91.2, code: "D1" });
  expect(net.peerLaps().length, "a guest still reports its own laps to the host").toBe(1);
});

// ---- QUALI / QLIVE: the driverId is bound to the sender ---------------------

test("a HOST accepts a QUALI naming the sender's own driver", () => {
  const { G, s } = started("host");
  s.deliver("quali", { driverId: "drv1", t: 61.25 });
  expect(G.caughtQuali).toEqual([{ driverId: "drv1", t: 61.25 }]);
});

test("a HOST drops a QUALI naming another driver", () => {
  const { G, s } = started("host");
  s.deliver("quali", { driverId: "drv0", t: 1.0 });
  s.deliver("quali", { driverId: "somebody-else", t: 59.0 });
  expect(G.caughtQuali, "a guest may post a qualifying time for ITS OWN driver only").toEqual([]);
});

test("a HOST drops a QUALI naming no driver at all", () => {
  const { G, s } = started("host");
  s.deliver("quali", { t: 59.0 });
  expect(G.caughtQuali).toEqual([]);
});

test("a GUEST accepts the host's QUALI for any driver", () => {
  const { G, s } = started("guest");
  s.deliver("quali", { driverId: "anyone-at-all", t: 60.5 });
  expect(G.caughtQuali).toEqual([{ driverId: "anyone-at-all", t: 60.5 }]);
});

test("lobby relay hook sees only sender-bound, normalized qualifying events", () => {
  const s = new FakeSession();
  const accepted: Array<{ type: string; driverId: unknown; t: number }> = [];
  const sink = { onPeerQuali() {}, onPeerQualiLive() {} };
  bindQuali(s, (d) => d.driverId === "bravo:1", sink, (type, d) => accepted.push({ type, driverId: d.driverId, t: d.t }));
  s.deliver("quali", { driverId: "alpha:0", t: 71 });
  s.deliver("quali", { driverId: "bravo:1", t: "71" });
  s.deliver("quali", { driverId: "bravo:1", t: 9000 });
  s.deliver("qlive", { driverId: "bravo:1", t: 10.5, frac: 0.3 });
  expect(accepted).toEqual([
    { type: "quali", driverId: "bravo:1", t: 71 },
    { type: "qlive", driverId: "bravo:1", t: 10.5 },
  ]);
});

test("a QUALI whose t is a numeric string arrives as a NUMBER; junk and implausible laps never arrive", () => {
  const { G, s } = started("guest"); // guest: no sender binding to get in the way
  s.deliver("quali", { driverId: "x", t: "70.125" });
  expect(G.caughtQuali).toEqual([{ driverId: "x", t: 70.125 }]);
  expect(typeof must(G.caughtQuali[0]).t).toBe("number");
  for (const t of [true, "abc", NaN, Infinity, -5, 0, 5, 20, 3600, 1e9, null, undefined, {}, []]) {
    s.deliver("quali", { driverId: "x", t });
  }
  expect(G.caughtQuali.length, "nothing outside (20 s, 1 h) or non-numeric reaches the game").toBe(1);
  expect(validQuali({ driverId: "d", t: "61" })).toEqual({ driverId: "d", t: 61 });
  expect(validQuali({ t: 61 }), "no driverId, no claim").toBe(null);
  expect(validQuali("61")).toBe(null);
  // QLIVE is bounded rather than refused — it is a clock, not a grid input.
  s.deliver("qlive", { driverId: "x", t: "12.5", frac: "2" });
  expect(G.caughtQLive.at(-1)).toEqual({ driverId: "x", t: 12.5, frac: 1 });
  s.deliver("qlive", { driverId: "x", t: NaN, frac: -1 });
  expect(G.caughtQLive.at(-1)).toEqual({ driverId: "x", t: 0, frac: 0 });
});

test("QLIVE is bound to the sender on the host the same way", () => {
  const { G, s } = started("host");
  s.deliver("qlive", { driverId: "drv1", t: 12.4, frac: 0.2 });
  s.deliver("qlive", { driverId: "drv0", t: 1.0, frac: 0.9 });
  expect(G.caughtQLive).toEqual([{ driverId: "drv1", t: 12.4, frac: 0.2 }]);
});

test("IN-RACE phase: the host caps one connection's QUALI+QLIVE at the lobby's shared rate (bug-hunt 2)", () => {
  const { G, s } = started("host");
  expect(typeof QUALI_RATE, "one shared constant with the lobby").toBe("number");
  for (let i = 0; i < 3; i++) s.deliver("qlive", { driverId: "drv1", t: 5 + i, frac: 0.1 });
  expect(G.caughtQLive.length, "a real client's rate passes untouched").toBe(3);
  for (let i = 0; i < 200; i++) s.deliver("qlive", { driverId: "drv1", t: 9, frac: 0.2 });
  expect(G.caughtQLive.length, "a flood stops at the cap (got " + G.caughtQLive.length + ")").toBe(QUALI_RATE);
  for (let i = 0; i < 50; i++) s.deliver("quali", { driverId: "drv1", t: 80 });
  expect(G.caughtQuali.length, "QUALI shares the window with QLIVE").toBe(0);
});

// ---- the star does not launder a guest's declaration ------------------------

function twoGuestHost(): { G: StubCtx; sa: FakeSession; sb: FakeSession } {
  const G = stubCtx(3);
  const net = createNetPlay(G);
  const sa = new FakeSession();
  const sb = new FakeSession();
  startOk(net, {
    role: "host",
    session: sa, // the lobby hands over both forms — sessions is the map, session the first entry
    sessions: [
      { id: "a", session: sa },
      { id: "b", session: sb },
    ],
    peers: [{ id: "a" }, { id: "b" }],
  });
  return { G, sa, sb };
}

test("a guest's CAUTION neither applies on a two-guest host nor reaches the other guest", () => {
  const { G, sa, sb } = twoGuestHost();
  const sentBefore = sb.sent.length;
  sa.deliver("caution", { kind: "sc", lap: 2 });
  expect(G.caughtCautions, "guest A's caution must not apply on the host").toEqual([]);
  const relayed = sb.sent.slice(sentBefore).filter((m) => m.t === "caution");
  expect(relayed, "guest A's caution must not be relayed to guest B").toEqual([]);
});

test("on a two-guest host, each guest's QUALI is accepted for its own seat only", () => {
  const { G, sa, sb } = twoGuestHost();
  sa.deliver("quali", { driverId: "drv2", t: 58.0 }); // A speaking for B: dropped
  sa.deliver("quali", { driverId: "drv1", t: 61.0 }); // A speaking for itself: accepted
  sb.deliver("quali", { driverId: "drv2", t: 60.75 }); // B speaking for itself: accepted
  expect(G.caughtQuali).toEqual([
    { driverId: "drv1", t: 61.0 },
    { driverId: "drv2", t: 60.75 },
  ]);
});

// ── netplay hardening: NO TIME ──────────────────────────────────────────────

test("NO TIME crosses as a marker, never as the synthetic back-of-grid time", () => {
  const sent: Array<{ type: string; d: unknown }> = [];
  const rep = qualiReporters(
    (type, d) => {
      sent.push(JSON.parse(JSON.stringify({ type, d })) as { type: string; d: unknown });
      return true;
    },
    () => true,
  );
  expect(rep.reportQuali("bravo:1", Infinity)).toBe(true);
  expect(sent[0]).toEqual({ type: EV.QUALI, d: { driverId: "bravo:1", t: null, noTime: true } });
  const q = must(validQuali(must(sent[0]).d));
  expect(q.t, "received as quali-model's own NO TIME value").toBe(Infinity);
  expect(q.noTime).toBe(true);
  // Without the marker an Infinity/null t is still junk.
  expect(validQuali({ driverId: "x", t: null })).toBe(null);
  // End to end on a host: the guest's NO TIME lands as Infinity for its seat.
  const { G, s } = started("host");
  s.deliver("quali", { driverId: "drv1", t: null, noTime: true });
  expect(G.caughtQuali).toEqual([{ driverId: "drv1", t: Infinity, noTime: true }]);
});

// ── round 8: session-scoped state and the arming population ─────────────────

test("stop() clears the armed start — a quit mid-countdown must not leak into the next race", () => {
  const { G, net, s } = started("guest");
  s.deliver("start", { at: 12345, hold: 1.0 });
  expect(G.netStart, "precondition: the guest armed the start").toBeTruthy();
  net.stop("local");
  expect(G.netStart, "stop() must clear the armed start with the session").toBe(null);
});

test("a duplicate START after lights-out does not re-arm a past instant (NP-6)", () => {
  const { G, s } = started("guest");
  s.deliver("start", { at: 12345, hold: 1.0 });
  expect(G.netStart, "precondition: armed").toBeTruthy();
  s.deliver("start", { at: 12345, hold: 1.0 });
  expect(G.netStart, "a duplicate before lights-out is harmless").toBeTruthy();
  G.netStart = null; // game.js: the countdown consumed it at lights-out
  s.deliver("start", { at: 12345, hold: 1.0 });
  expect(G.netStart, "consumed means consumed").toBe(null);
});

test("a peer WITHOUT a grid slot cannot arm the start", () => {
  // stubCtx(2) has exactly one free car, so peer 2 goes slotless.
  const G = stubCtx(2);
  const net = createNetPlay(G);
  const seated = new FakeSession();
  const slotless = new FakeSession();
  startOk(net, {
    role: "host",
    session: seated, // satisfies the no_transport gate; `sessions` wins below
    sessions: [
      { id: "1", session: seated },
      { id: "2", session: slotless },
    ],
    peers: [
      { id: "1", profile: null },
      { id: "2", profile: null },
    ],
  });
  expect(net.hostStart(), "no one armed yet — the host waits").toBe(true);
  expect(G.netStart, "precondition: the moment is not yet named").toBe(null);

  slotless.deliver("armed", {});
  expect(G.netStart, "a slotless peer's ARMED must not name the moment while the seated peer builds").toBe(null);
  expect(
    seated.sent.filter((m) => m.t === "start"),
    "no START goes out on the slotless peer's word",
  ).toEqual([]);

  seated.deliver("armed", {});
  expect(G.netStart, "the SEATED peer's ARMED names the moment").toBeTruthy();
  expect(seated.sent.filter((m) => m.t === "start").length).toBe(1);
});

test("pickRemoteSlot keeps any-fallback only when profile is null", () => {
  const src = readFileSync(new URL("../../src/net/netplay.ts", import.meta.url), "utf8");
  expect(src).toMatch(/lastSlotFallback = "profile-miss"/);
  expect(src).toMatch(/any-free-car arm/);

  const tagged = (n: number): StubCtx => {
    const G = stubCtx(n);
    const ids = ["mclaren", "ferrari", "redbull"];
    for (let i = 1; i < G.cars.length; i++) {
      const c = carAt(G, i);
      c.team = { id: must(ids[(i - 1) % ids.length]), tier: 0 };
      c.seat = 0;
    }
    return G;
  };

  const Gany = tagged(4);
  const netAny = createNetPlay(Gany);
  const ok = netAny.start({ role: "host", session: new FakeSession() });
  expect(ok.ok, `null profile must still seat any free car: ${ok.ok ? "" : ok.error}`).toBe(true);
  expect(netAny.status().slotFallback).toBe("any");

  const Gmiss = tagged(4);
  const netMiss = createNetPlay(Gmiss);
  const miss = netMiss.start({
    role: "host",
    session: new FakeSession(),
    peerProfile: { team: "haas", driver: 0 },
  });
  expect(miss.ok).toBe(false);
  expect(miss.ok ? null : miss.error).toBe("no_slot");
  expect(netMiss.status().slotFallback).toBe("profile-miss");
});

test("strategy events require this race epoch and the sender's own car", () => {
  const G = stubCtx(3, { trackDef: { id: "monza" } });
  const net = createNetPlay(G);
  const a = new FakeSession();
  const b = new FakeSession();
  net.start({
    role: "host",
    session: a,
    sessions: [
      { id: "a", session: a },
      { id: "b", session: b },
    ],
  });
  const model = a.firstSent(EV.MODEL);
  a.deliver(EV.MODEL, { ...model, epoch: "peer-a" });
  b.deliver(EV.MODEL, { ...model, epoch: "peer-b" });
  const data = { ...strategyState(stubCar(9, false, { tyreWear: 0.7, pitState: "box" }), 1, "monza"), epoch: model["epoch"] };
  const otherBefore = carAt(G, 2).tyreWear;
  const hostBefore = must(G.player).tyreWear;
  a.deliver(EV.STRATEGY, data);
  expect(carAt(G, 1).tyreWear).toBe(0.7);
  expect(rec(must(b.sent.filter((e) => e.t === EV.STRATEGY).at(-1)).d)["epoch"]).toBe("peer-b");
  a.deliver(EV.STRATEGY, { ...data, wire: 2 });
  expect(carAt(G, 2).tyreWear, "a guest cannot change another guest's tyres").toBe(otherBefore);
  a.deliver(EV.STRATEGY, { ...data, wire: 0 });
  expect(must(G.player).tyreWear, "a guest cannot change the host's tyres").toBe(hostBefore);
  a.deliver(EV.STRATEGY, { ...data, epoch: "old-race", fields: { tyreWear: 0.1 } });
  expect(carAt(G, 1).tyreWear, "same-track stale events are ignored").toBe(0.7);
  net.stop();
});

// ---- the HOST's AI retires on the guest too ------------------------------

function guestWithHostAi() {
  const G = stubCtx(3); // 0 = us, 1 = the host's human, 2 = the host's AI
  G.retireCar = (c, why) => {
    c.retired = true;
    c.dnf = why;
    G.retired.push(c.code);
  };
  const net = createNetPlay(G);
  const s = new FakeSession();
  startOk(net, { role: "guest", session: s });
  return { G, net, s, ai: carAt(G, 2) };
}

test("a GUEST parks the host's AI when the host reports its retirement", () => {
  const { G, net, s, ai } = guestWithHostAi();
  expect(net.owns(ai), "precondition: the host's AI is posed from the wire").toBe(true);
  const epoch = s.firstSent(EV.MODEL)["epoch"];
  s.deliver("lap", { lap: 4, time: null, best: null, code: ai.code, driverId: ai.driverId, retired: "engine", invalid: true, epoch });
  expect(ai.retired, "retired on the guest as on the host").toBe(true);
  expect(ai.dnf).toBe("engine");
  expect(G.retired, "through retireCar: parked and announced once").toEqual([ai.code]);
  s.deliver("lap", { lap: 4, time: null, best: null, code: ai.code, driverId: ai.driverId, retired: "engine", invalid: true });
  expect(G.retired, "a repeat changes nothing").toEqual([ai.code]);
  s.disconnect("transport");
  expect(ai.retired, "after the host leaves the car stays out (updateCar never drives a retirement)").toBe(true);
});

test("a HOST ignores a guest's claim that one of the host's AI retired", () => {
  const G = stubCtx(3);
  G.retireCar = () => {
    throw new Error("a guest cannot retire the host's AI");
  };
  const net = createNetPlay(G);
  const s = new FakeSession();
  startOk(net, { role: "host", session: s });
  const ai = must(G.cars.find((c) => !c.human));
  s.deliver("lap", { lap: 4, time: null, best: null, code: ai.code, driverId: ai.driverId, retired: "engine", invalid: true });
  expect(!!ai.retired).toBe(false);
});

// ---- a finish is the OWNER's crossing, a retirement the owner's word -------

test("a lapped rival's finish (fin at a lap below the target) finishes it on the other peer", () => {
  const { G, s } = started("host");
  G.lapsTarget = 3;
  G.raceT = 100;
  const player = must(G.player);
  player.finished = true;
  player.lap = 4; // the host has already raised the flag
  const rival = carAt(G, 1);
  rival.lap = 2; // its pose: on lap 2, flagged out at this crossing
  s.deliver("lap", { lap: 2, time: null, best: null, code: "D1", fin: 99.5, invalid: true });
  expect(rival.finished, "the owner's crossing lap is the finishing crossing").toBe(true);
  expect(rival.finishT).toBe(99.5);
  expect(rival._nFin).toBe(null);
});

test("a fin ahead of the pose waits for the pose to reach THAT lap, not the target", () => {
  const { G, s } = started("host");
  G.lapsTarget = 3;
  G.raceT = 100;
  const player = must(G.player);
  player.finished = true;
  player.lap = 4;
  const rival = carAt(G, 1);
  rival.lap = 1; // the pose trails the crossing by the interp delay
  s.deliver("lap", { lap: 2, time: null, best: null, code: "D1", fin: 99.5, invalid: true });
  expect(!!rival.finished, "not yet: the drawn car has not crossed").toBe(false);
  expect(rival._nFin).toBe(99.5);
  expect(rival._nFinLap, "…and it is lap 2 it waits for, not lapsTarget + 1").toBe(2);
});

test("a full-distance finish still needs the pose past the target, as before", () => {
  const { G, s } = started("host");
  G.lapsTarget = 3;
  G.raceT = 200;
  const rival = carAt(G, 1);
  rival.lap = 3;
  s.deliver("lap", { lap: 4, time: 90, best: 90, code: "D1", fin: 199.8 });
  expect(!!rival.finished).toBe(false);
  expect(rival._nFinLap).toBe(4);
  rival.lap = 4;
  s.deliver("lap", { lap: 4, time: null, best: null, code: "D1", fin: 199.8, invalid: true });
  expect(rival.finished).toBe(true);
});

test("a rival's retirement arrives on the LAP event and parks it as retired, once", () => {
  const { G, s } = started("host");
  G.lapsTarget = 3;
  G.raceT = 50;
  const rival = carAt(G, 1);
  s.deliver("lap", { lap: 1, time: null, best: null, code: "D1", retired: "engine", invalid: true });
  expect(rival.retired).toBe(true);
  expect(rival.dnf).toBe("engine");
  s.deliver("lap", { lap: 1, time: null, best: null, code: "D1", fin: 49.9, invalid: true });
  expect(!!rival.finished, "a retired car does not also finish").toBe(false);
  const other = started("host");
  other.G.lapsTarget = 3;
  other.s.deliver("lap", { lap: 1, code: "D1", retired: 12, invalid: true });
  expect(!!carAt(other.G, 1).retired, "a retirement is a reason string, nothing else").toBe(false);
});

test("a rival handed back to the AI does not time the rest of its lap as a whole one", () => {
  const { G, s } = started("guest");
  const rival = carAt(G, 1);
  rival.lapTime = 0;
  rival._secT0 = 0;
  s.disconnect("transport");
  expect(rival.incidentInvalidLap, "the lap in progress is untimed").toBe(true);
  expect(rival.lapTime).toBe(0);
  expect(rival._secT0).toBe(null);
});

test("a stale disconnect reason does not outlive the race: stop() on an inactive session forgets it", () => {
  const { net, s } = started("guest");
  s.disconnect("transport");
  expect(net.status().reason, "during THIS race the pause menu may say so").toBe("transport");
  expect(net.stop("local"), "nothing to stop…").toBe(false);
  expect(net.status().reason, "…but the next solo race must not read 'Disconnected'").toBe(null);
});

test("a mid-race BYE keeps lastReason and does not fire onStop (race continues offline)", () => {
  for (const role of ["guest", "host"] as const) {
    const G = stubCtx();
    const net = createNetPlay(G);
    const s = new FakeSession();
    let onStopCalls = 0;
    startOk(net, {
      role,
      session: s,
      onStop: () => {
        onStopCalls++;
      },
    });
    s.deliver("bye", {});
    expect(net.active(), `${role}: network session ends`).toBe(false);
    expect(net.status().reason, `${role}: the clean leave reason must survive stop()→close()`).toBe("bye");
    expect(onStopCalls, `${role}: onStop is local-quit only; a peer BYE keeps racing with AI`).toBe(0);
    expect(carAt(G, 1).human, `${role}: the rival returns to AI`).toBe(false);
  }
  // Host with another guest still racing: close() reports "local", but the
  // leave was clean — reason must stay "bye" while active remains true.
  const G = stubCtx(3);
  const net = createNetPlay(G);
  const sA = new FakeSession();
  const sB = new FakeSession();
  let onStopCalls = 0;
  startOk(net, {
    role: "host",
    session: sA,
    onStop: () => {
      onStopCalls++;
    },
    sessions: [
      { id: "a", session: sA },
      { id: "b", session: sB },
    ],
  });
  sA.deliver("bye", {});
  expect(net.active(), "one of two guests leaving does not end the race").toBe(true);
  expect(net.status().reason).toBe("bye");
  expect(onStopCalls).toBe(0);
  expect(sB.sent.some((m) => m.t === "left")).toBe(true);
});

test('a guest BYE tells the other guests why:"bye", not the close() artefact "local"', () => {
  const G = stubCtx(3);
  const net = createNetPlay(G);
  const sA = new FakeSession();
  const sB = new FakeSession();
  startOk(net, {
    role: "host",
    session: sA,
    sessions: [
      { id: "a", session: sA },
      { id: "b", session: sB },
    ],
  });
  sA.deliver("bye", {});
  const left = sB.sent.filter((m) => m.t === "left");
  expect(left.length, "the remaining guest is told once").toBe(1);
  expect(rec(must(left[0]).d)["why"]).toBe("bye");
  expect(net.status().reason).toBe("bye");
});

test('dropping one incompatible guest tells the others why:"incompatible_physics", not "local"', () => {
  const G = stubCtx(3);
  const net = createNetPlay(G);
  const sA = new FakeSession();
  const sB = new FakeSession();
  startOk(net, {
    role: "host",
    session: sA,
    sessions: [
      { id: "a", session: sA },
      { id: "b", session: sB },
    ],
  });
  sA.deliver("model", { physics: "not-this-build", strategy: -1 });
  expect(net.active(), "one incompatible guest does not end the race").toBe(true);
  const left = sB.sent.filter((m) => m.t === "left");
  expect(left.length).toBe(1);
  expect(rec(must(left[0]).d)["why"]).toBe("incompatible_physics");
});

test("a local stop fires onStop once and keeps reason local through socket teardown", () => {
  const G = stubCtx();
  const net = createNetPlay(G);
  const s = new FakeSession();
  let onStopCalls = 0;
  startOk(net, {
    role: "guest",
    session: s,
    onStop: () => {
      onStopCalls++;
    },
  });
  expect(net.stop("local")).toBe(true);
  expect(onStopCalls, "restoreOwnRules runs once for a deliberate local quit").toBe(1);
  expect(net.status().reason, "close()'s onClose(local) must not clear the stop reason").toBe("local");
});

// ---- the own-car snapshot is stamped when its POSE is, not when the frame is ----

test("the published snapshot carries the pose time the game loop hands in", () => {
  const G = stubCtx();
  const net = createNetPlay(G);
  const s = new FakeSession();
  const ticks: number[] = [];
  s.sendState = (bytes: WireData) => {
    const d = decodeSnapshot(bytes);
    if (d) ticks.push(d.tick);
    return true;
  };
  startOk(net, { role: "guest", session: s });
  net.tick(10000, 9978); // pose 22 ms old: last frame's physics
  expect(ticks, "stamped with the pose time").toEqual([9978]);
  net.tick(20000); // a test pumping by hand: the pose is `now`
  expect(ticks.slice(1)).toEqual([20000]);
  net.tick(30000, 30050); // from the future: not a clock we trust
  net.tick(40000, 39000); // a second old: a stall, not last frame
  expect(ticks.slice(2), "out-of-bounds pose times fall back to the frame").toEqual([30000, 40000]);
});

// ---- L8-e netcode polish: arrival stamps, a fixed 20 Hz, one relay datagram per guest ----

const agedOf = (s: FakeSession) => s.states.filter((p) => p && p.type === TYPE_AGED);

function threeGuestHost(G: StubCtx) {
  const net = createNetPlay(G);
  const ss = { a: new FakeSession(), b: new FakeSession(), c: new FakeSession() };
  startOk(net, {
    role: "host",
    session: ss.a,
    sessions: Object.entries(ss).map(([id, session]) => ({ id, session })),
    peers: [{ id: "a" }, { id: "b" }, { id: "c" }],
  });
  return { net, ss };
}

test("the host relays every other guest's car in ONE aged datagram per guest, each with its own stamp", () => {
  const G = poseCtx(4);
  const { net, ss } = threeGuestHost(G);
  // a → cars[1], b → cars[2], c → cars[3] (pickRemoteSlot walks the grid in order).
  let t = 10_000;
  for (let k = 0; k < 12; k++, t += 50) {
    for (const s of Object.values(ss)) s.states.length = 0;
    ss.a.feed(t - 30, 1, lapPose(100 + k), t - 10);
    ss.b.feed(t - 70, 2, lapPose(200 + k), t - 10);
    ss.c.feed(t - 50, 3, lapPose(300 + k), t - 10);
    G.netNow = t;
    net.tick(t);
  }
  for (const [name, own] of [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ] as const) {
    const got = ss[name].states;
    const relays = agedOf(ss[name]);
    expect(relays.length, `guest ${name}: one relay datagram per publish, not one per car`).toBe(1);
    expect(
      must(relays[0]).cars.map((c) => c.id).sort(),
      `guest ${name}: every OTHER guest, never its own car`,
    ).toEqual([1, 2, 3].filter((i) => i !== own));
    expect(got.length, `guest ${name}: the host's own car + ONE relay (was 1 + 2)`).toBe(2);
  }
  net.stop();
});

test("the host stops relaying a rival that has gone quiet instead of stamping its frozen pose fresh (NP-5)", () => {
  const G = poseCtx(4);
  const { net, ss } = threeGuestHost(G);
  const relayedIds = (s: FakeSession) => agedOf(s).flatMap((p) => must(p).cars.map((c) => c.id));
  let t = 10_000;
  for (let k = 0; k < 12; k++, t += 50) {
    ss.a.feed(t - 30, 1, lapPose(100 + k), t - 10);
    ss.b.feed(t - 70, 2, lapPose(200 + k), t - 10);
    ss.c.feed(t - 50, 3, lapPose(300 + k), t - 10);
    G.netNow = t;
    net.tick(t);
  }
  // c goes silent; a and b keep talking. Its frozen pose must not ride
  // the relay, even after fallback AI crosses and claims the target lap.
  const last = t;
  for (let k = 0; k < 64; k++, t += 50) {
    ss.a.feed(t - 30, 1, lapPose(120 + k), t - 10);
    ss.b.feed(t - 70, 2, lapPose(220 + k), t - 10);
    for (const s of Object.values(ss)) s.states.length = 0;
    G.netNow = t;
    net.tick(t);
    if (t - last >= 700) {
      if (t - last > 2100) {
        carAt(G, 3).lap = G.lapsTarget + 1;
        carAt(G, 3).s = 5;
      }
      expect(relayedIds(ss.a), "a hears b, never the silent c").toEqual([2]);
      expect(relayedIds(ss.b), "b hears a, never the silent c").toEqual([1]);
    }
  }
  net.stop();
});

test("a guest poses each entry of an aged relay at ITS OWN stamp (tick − age)", () => {
  const G = poseCtx(3);
  const net = createNetPlay(G);
  const s = new FakeSession();
  // A guest seats the host and the relayed second guest (the lobby's roster).
  startOk(net, { role: "guest", session: s, peers: [{ id: "peer" }, { id: "g2" }] });
  // The host relays cars 1 and 2 posed 0 and 40 ms before the header tick;
  // the packet lands at 5010. Each entry's lag is arrival − ITS OWN stamp.
  s.feedBytes(
    encodeAged([
      { id: 1, car: lapPose(100), at: 5000 },
      { id: 2, car: lapPose(200), at: 4960 },
    ]),
    5010,
  );
  const lag = Object.fromEntries(net.status().remotes.map((r) => [r.wire, Math.round(r.timing.lagMs)]));
  expect(lag).toEqual({ 1: 10, 2: 50 });
  net.stop();
});

test("the publish rate is a fixed 20 Hz at 30, 60 and 144 fps", () => {
  for (const fps of [30, 60, 144]) {
    const G = poseCtx(2);
    const net = createNetPlay(G);
    const s = new FakeSession();
    startOk(net, { role: "guest", session: s });
    const frame = 1000 / fps;
    for (let t = 10_000; t < 20_000; t += frame) {
      G.netNow = t;
      net.tick(t);
    }
    const own = s.states.filter((p) => p && p.type === TYPE_SNAPSHOT).length;
    expect(Math.abs(own - 200) <= 2, `${fps} fps published ${own} in 10 s, want 200 (20 Hz)`).toBe(true);
    net.stop();
  }
});

test("a rival's lag is measured from the transport's ARRIVAL stamp, not the frame that drained it", () => {
  const run = (stamp: boolean) => {
    const G = poseCtx(2);
    const net = createNetPlay(G);
    const s = new FakeSession();
    startOk(net, { role: "guest", session: s });
    // Every packet ARRIVES 40 ms after its tick and is drained by a frame 30 ms later.
    for (let k = 0; k < 80; k++) {
      const tick = 10_000 + k * 50;
      G.netNow = tick + 70;
      s.feed(tick, 1, lapPose(100 + k), stamp ? tick + 40 : undefined);
    }
    const timing = must(net.status().remotes[0]).timing;
    net.stop();
    return timing;
  };
  const arrived = run(true);
  const drained = run(false);
  expect(Math.abs(arrived.lagMs - 40) < 3, "lag read from the arrival stamp: " + arrived.lagMs).toBe(true);
  expect(Math.abs(drained.lagMs - 70) < 3, "no stamp: the frame time, as before: " + drained.lagMs).toBe(true);
});

// ---- L8-f: AI replication + the race silence grace ----

test("the host publishes its AI field at 10 Hz in each guest's aged packet, never that guest's own car", () => {
  const G = poseCtx(5); // cars[0] host, [1] guest a, [2..4] AI
  const net = createNetPlay(G);
  const a = new FakeSession();
  startOk(net, { role: "host", session: a });
  let t = 10_000;
  a.feed(t - 20, 1, lapPose(50), t - 10);
  for (let k = 0; k < 20; k++, t += 50) {
    G.netNow = t;
    net.tick(t);
  } // 20 publishes = 1 s
  const aged = agedOf(a);
  expect(aged.length, "AI rides every other publish: 10 Hz").toBe(10);
  for (const p of aged) {
    expect(
      must(p).cars.map((c) => c.id).sort(),
      "the AI only — not the host (own packet), not guest a's own car",
    ).toEqual([2, 3, 4]);
  }
  expect(a.states.filter((p) => p && p.type === TYPE_SNAPSHOT).length, "the host's own car still at 20 Hz").toBe(20);
  net.stop();
});

test("a guest seats the host's AI as host-owned remotes and poses them from the packet", () => {
  const G = poseCtx(4); // cars[0] guest (local), [1] host, [2..3] AI
  const net = createNetPlay(G);
  const s = new FakeSession();
  startOk(net, { role: "guest", session: s });
  const ai = carAt(G, 2);
  expect(net.status().hostAi, "both AI cars are the host's").toBe(2);
  expect(net.owns(ai), "updateCar skips it: this screen never simulates the host's AI").toBe(true);
  expect(ai.human, "its role stays AI").toBe(false);
  for (let k = 0; k < 10; k++) {
    const tick = 10_000 + k * 100;
    s.feedBytes(
      encodeAged([
        { id: 2, car: lapPose(400 + k * 5), at: tick },
        { id: 3, car: lapPose(900), at: tick },
      ]),
      tick + 30,
    );
    G.netNow = tick + 30;
    net.tick(tick + 30);
  }
  expect(ai.s > 400 && ai.s < 450, "posed from the host's packets: s=" + ai.s).toBe(true);
  expect(net.owns(carAt(G, 1)), "the host's own car is a human rival as before").toBe(true);
  // Without replication (hostAi: false) the guest simulates its own AI, as before.
  const G2 = poseCtx(4);
  const net2 = createNetPlay(G2);
  startOk(net2, { role: "guest", session: new FakeSession(), hostAi: false });
  expect(net2.owns(carAt(G2, 2))).toBe(false);
  net.stop();
  net2.stop();
});

/**
 * The net-relevant lines of f1-game js/game.js:6440-6449 `retireCar(c, reason)`:
 * the host owns its AI's word, and reports it on the reliable channel. f1-game
 * ran the real function through vm; game.js is not ported yet.
 * TODO(lane-race): call the ported retireCar here.
 */
function retireCarStandIn(c: NetCar, reason: string, net: ReturnType<typeof createNetPlay>): void {
  c.retired = true;
  c.dnf = reason || "mechanical";
  c.dnfAt = null;
  if ((c.local || (!c.human && net.ownsRaceControl())) && net.active()) {
    net.reportLap({ lap: c.lap, time: null, best: null, code: c.code, driverId: c.driverId, retired: c.dnf, invalid: true });
  }
}

test("the host's actual AI retirement reaches a guest, including one that binds after it happened", () => {
  const monza = { id: "monza" };
  const host = poseCtx(3, { trackDef: monza });
  const guest = poseCtx(3, { trackDef: monza, local: 1 });
  const hn = createNetPlay(host);
  const gn = createNetPlay(guest);
  const hs = new FakeSession();
  const gs = new FakeSession();
  hn.start({ role: "host", session: hs });
  gn.start({ role: "guest", session: gs });
  const hm = hs.firstSent("model");
  const gm = gs.firstSent("model");
  hs.deliver("model", gm);
  gs.deliver("model", hm);
  retireCarStandIn(carAt(host, 2), "engine", hn);
  const event = hs.sent.filter((e) => e.t === "lap" && rec(e.d)["driverId"] === "drv2").at(-1);
  expect(event, "the host sends an AI retirement immediately").toBeTruthy();
  const ev = must(event);
  expect(rec(ev.d)["epoch"], "state belongs to the receiver's race").toBe(gm["epoch"]);
  gs.deliver(ev.t, ev.d);
  expect(carAt(guest, 2).retired).toBe(true);
  expect(carAt(guest, 2).dnf).toBe("engine");
  expect(
    guest.cars.filter((c) => !c.retired).includes(carAt(guest, 2)),
    "the game's ranked/collision filter excludes it",
  ).toBe(false);
  expect(gn.owns(carAt(guest, 2)), "the parked car is still posed by its host").toBe(true);
  gs.feed(10000, 2, lapPose(1200), 10000);
  gn.tick(10000);
  expect(carAt(guest, 2).retired, "an older unreliable pose cannot resurrect terminal state").toBe(true);
  // A new receiver epoch simulates late binding/rejoining after the DNF event.
  const late = poseCtx(3, { trackDef: monza });
  const ln = createNetPlay(late);
  const ls = new FakeSession();
  ln.start({ role: "guest", session: ls });
  hs.deliver("model", ls.firstSent("model"));
  hs.sent.length = 0;
  hn.tick(10000);
  const repeated = hs.sent.find((e) => e.t === "lap" && rec(e.d)["driverId"] === "drv2");
  expect(repeated, "the existing reliable sync repeats terminal AI state").toBeTruthy();
  ls.deliver(must(repeated).t, must(repeated).d);
  expect(carAt(late, 2).retired).toBe(true);
  // ONCE per arriving receiver, not once a second for the rest of the race.
  hs.sent.length = 0;
  hn.tick(11500);
  hn.tick(13000);
  expect(hs.sent.some((e) => e.t === EV.STRATEGY), "the 1 s strategy block ran on both ticks").toBe(true);
  expect(
    hs.sent.filter((e) => e.t === "lap" && rec(e.d)["driverId"] === "drv2").length,
    "the terminal state is not re-broadcast",
  ).toBe(0);
  hs.deliver("model", ls.firstSent("model")); // another receiver binds: now it is owed again
  hs.sent.length = 0;
  hn.tick(14500);
  expect(hs.sent.filter((e) => e.t === "lap" && rec(e.d)["driverId"] === "drv2").length).toBe(1);
  hn.stop();
  gn.stop();
  ln.stop();
});

test("AI retirements require the host and the current receiver epoch", () => {
  const G = poseCtx(3);
  const net = createNetPlay(G);
  const s = new FakeSession();
  net.start({ role: "guest", session: s });
  const epoch = s.firstSent("model")["epoch"];
  const retirement = { driverId: "drv2", code: "D2", lap: 1, retired: "engine", invalid: true };
  for (const d of [retirement, { ...retirement, epoch: "previous-race" }]) {
    s.deliver("lap", d);
    expect(!!carAt(G, 2).retired).toBe(false);
  }
  s.deliver("lap", { ...retirement, epoch });
  expect(carAt(G, 2).retired).toBe(true);
  net.stop();
  const host = poseCtx(3);
  const hn = createNetPlay(host);
  const hs = new FakeSession();
  hn.start({ role: "host", session: hs });
  hs.deliver("lap", { ...retirement, epoch: hs.firstSent("model")["epoch"] });
  expect(!!carAt(host, 2).retired, "a guest cannot retire host AI").toBe(false);
  expect(!!carAt(host, 1).retired, "nor can the spoof retire another car by accident").toBe(false);
  hn.stop();
});

test("silence grace: a rival quiet > 2 s is the local AI's, back on the wire when it speaks; the race session waits 25 s", () => {
  const G = poseCtx(3);
  const net = createNetPlay(G);
  const s = new FakeSession();
  let timeout: number | null = null;
  s.setTimeoutMs = (ms: number) => {
    timeout = ms;
    return ms;
  };
  startOk(net, { role: "host", session: s });
  expect(timeout, "the race session's silence grace (the lobby keeps 6 s)").toBe(25_000);
  const rival = carAt(G, 1);
  let t = 10_000;
  s.feed(t, 1, lapPose(100), t + 10);
  G.netNow = t + 20;
  net.tick(t + 20);
  expect(net.owns(rival)).toBe(true);
  expect(rival.human).toBe(true);
  t += 2_100;
  G.netNow = t;
  net.tick(t); // 2.1 s of nothing
  expect(net.owns(rival), "silent: the local AI drives it, it is not parked on the line").toBe(false);
  expect(rival.human).toBe(false);
  expect(rival.dnfAt, "no stale AI reliability plan may retire it meanwhile").toBe(null);
  expect(net.status().stale).toEqual([1]);
  s.feed(t + 100, 1, lapPose(300), t + 110); // it speaks again
  t += 150;
  G.netNow = t;
  net.tick(t);
  expect(net.owns(rival), "back on the wire").toBe(true);
  expect(rival.human).toBe(true);
  expect(net.status().stale).toEqual([]);
  net.stop();
});

// ---- a rival that left while a guest was still BUILDING (sibling register 8.1) ----

test("the host tells a guest that arms late about a rival that left before it was built", () => {
  const host = poseCtx(3);
  const hn = createNetPlay(host);
  const ss = { a: new FakeSession(), b: new FakeSession() };
  startOk(hn, {
    role: "host",
    session: ss.a,
    sessions: Object.values(ss).map((session, i) => ({ id: String(i + 1), session })),
    peers: [{ id: "1" }, { id: "2" }],
  });
  const lefts = (sess: FakeSession) => sess.sent.filter((e) => e.t === EV.LEFT);
  ss.b.disconnect("transport"); // guest b leaves while guest a is still building
  expect(lefts(ss.a).length, "the live broadcast, which a still-building guest cannot read").toBe(1);
  ss.a.deliver(EV.ARMED, {}); // a's circuit is built; its handlers are bound
  expect(lefts(ss.a).length, "…so ARMED earns the LEFT again").toBe(2);
  expect(must(lefts(ss.a)[1]).d).toEqual({ wire: 2, why: "transport" });
  ss.a.deliver(EV.ARMED, {}); // ARMED is re-sent each second until START lands
  expect(lefts(ss.a).length, "…once per arriving guest, not on every repeat").toBe(2);
  // The guest that was building: seated b as a human rival; the resent LEFT frees it.
  const guest = poseCtx(3);
  const gn = createNetPlay(guest);
  const gs = new FakeSession();
  startOk(gn, { role: "guest", session: gs, peers: [{ id: "1" }, { id: "2" }] });
  expect(carAt(guest, 2).human, "precondition: seated as a human rival").toBe(true);
  gs.deliver(EV.LEFT, must(lefts(ss.a)[1]).d);
  expect(carAt(guest, 2).human, "the leaver is the local AI's").toBe(false);
  hn.stop();
  gn.stop();
});

test("a human rival that never speaks is the local AI's after the start's own backstop, not never", () => {
  const G = poseCtx(3);
  const net = createNetPlay(G);
  const s = new FakeSession();
  startOk(net, { role: "guest", session: s, peers: [{ id: "1" }, { id: "2" }] });
  const rival = carAt(G, 2);
  let t = 10_000;
  G.netNow = t;
  net.tick(t);
  t += 54_000;
  G.netNow = t;
  net.tick(t);
  expect(rival.human, "a rival still building stays parked where it is, as before").toBe(true);
  t += 2_000;
  G.netNow = t;
  net.tick(t);
  expect(rival.human, "past HOLD_MAX_MS of silence it is handed to the local AI").toBe(false);
  expect(net.owns(rival)).toBe(false);
  expect(net.status().stale.includes(2)).toBe(true);
  s.feed(t + 100, 2, lapPose(300), t + 110); // a packet still brings it back
  t += 150;
  G.netNow = t;
  net.tick(t);
  expect(net.owns(rival)).toBe(true);
  net.stop();
});

test("a session ending hands the HOST's AI cars back scrubbed too, not only the human rivals", () => {
  const G = poseCtx(4); // cars[0] guest, [1] host, [2..3] the host's AI
  const net = createNetPlay(G);
  startOk(net, { role: "guest", session: new FakeSession() });
  expect(net.status().hostAi, "two cars are the host's AI").toBe(2);
  for (const c of G.cars.slice(1)) {
    c.lapTime = 0;
    c._secT0 = 0;
    c.incidentInvalidLap = false;
    c.dnfAt = 5;
    c.dnfWhy = "x";
    c._nOk = true;
  }
  net.stop("timeout");
  for (const c of G.cars.slice(1)) {
    expect(c.incidentInvalidLap, c.code + ": the lap in progress is untimed").toBe(true);
    expect(c.lapTime, c.code).toBe(0);
    expect(c._secT0, c.code).toBe(null);
    expect(c.dnfAt, c.code).toBe(null);
    expect(c._nOk, c.code).toBe(false);
  }
});

test("a hidden tab keeps pumping the session but publishes no pose; it resumes on return", () => {
  const G = stubCtx();
  const net = createNetPlay(G);
  const s = new FakeSession();
  let pumps = 0;
  s.pump = () => {
    pumps++;
    return true;
  };
  startOk(net, { role: "guest", session: s });
  vi.stubGlobal("document", { hidden: true });
  net.tick(10000);
  net.tick(10500);
  net.tick(11000);
  expect(pumps, "pings still pumped: the session stays alive").toBe(3);
  expect(s.states.length, "no own-car entry while hidden").toBe(0);
  vi.stubGlobal("document", { hidden: false });
  net.tick(11500);
  expect(s.states.length, "publishing resumes the moment the tab is back").toBe(1);
  expect(must(s.states[0]).cars.length).toBe(1);
});

test("QUALI and QLIVE reject a rival driverId even with the sender's code", () => {
  const { G, s } = started("host");
  const code = carAt(G, 1).code;
  s.deliver("quali", { driverId: "drv0", code, t: 61 });
  s.deliver("qlive", { driverId: "drv0", code, t: 62 });
  expect(G.caughtQuali).toEqual([]);
  expect(G.caughtQLive).toEqual([]);
  s.deliver("quali", { driverId: "drv1", code, t: 63 });
  expect(G.caughtQuali.length).toBe(1);
});
