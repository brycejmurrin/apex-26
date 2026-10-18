/**
 * net-room.test.ts — the VS FRIEND room without its DOM (src/net/room.ts).
 * Ports the behaviour of f1-game tests/unit/net-lobby-lifecycle.test.mjs,
 * net-roster.test.mjs (:104-128, :605-621) and lobby-answer-flight.test.mjs
 * that maps onto room.ts, driving REAL rooms (one host, 1–3 guests) over
 * loopback transports instead of f1-game's fake sessions.
 *
 * loopback() has no RTCPeerConnection, so the handshake is mocked: an invite
 * code names the host's loopback pair, the guest's acceptInvite binds its
 * transport to the far end, and the host's acceptAnswer OPENS the pair (both
 * ends read "connecting" until then, as a real RTCPeerConnection does). The
 * real peekCode stays, so a malformed code is still refused before a transport.
 * prefetchIce is stubbed to resolve (or to a deferred, for the generation tests).
 *
 * Not ported here (they need what room.ts leaves to other lanes, or the DOM):
 * friend qualifying (quali gate, QualiNet, qgo, BACK from the sheet), seat
 * clashes and rank (MY TEAM / LEGENDS moves, yield rules), garage CHANGE CAR,
 * seed/round/weather/dirty-air settings validation (deps.applySettings owns
 * it), restoring the guest's own rules, startRace outcomes, wake lock,
 * clipboard, scanner, How to Play, URL invites (hashchange/consume), the
 * room-code paths that need a Nostr relay (codeHost/codeJoin reopen, rotate,
 * expiry copy, onFail), the verification code (needs DTLS fingerprints on a
 * real pc), source-shape assertions (answerInFlight lock, regexes on lobby.js),
 * NetPlay race-phase LEFT/LAP/ARMED (net-roster.test.mjs, NetPlay's lane),
 * f1-game's per-peer roster COALESCING (room.ts drops past the rate instead)
 * and the "needs to update or reload" copy for a revisionless READY.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as HandshakeModule from "../../src/net/handshake";
import type * as TransportModule from "../../src/net/transport";
import {
  EVENT,
  loopback,
  type Channel,
  type CloseReason,
  type EndpointStatus,
  type LoopbackEndpoint,
  type MessageHandler,
  type WireData,
} from "../../src/net/transport";
import { EV } from "../../src/net/netplay";
import { createRoom, MAX_GUESTS, PEER_ONE, type Room, type RoomDeps, type RoomHandoff, type RoomState, type RoomTransport } from "../../src/net/room";

// ─── the mocked handshake and ICE prefetch ──────────────────────────────────

interface FakeHs {
  createInvite(t: unknown, profile: unknown): Promise<HandshakeModule.InviteResult>;
  acceptInvite(t: unknown, code: unknown, profile: unknown): Promise<HandshakeModule.AcceptInviteResult>;
  acceptAnswer(t: unknown, code: unknown): Promise<HandshakeModule.AcceptAnswerResult>;
  ice(): Promise<null>;
}

const hs = vi.hoisted(() => ({ impl: null as FakeHs | null }));
const use = (): FakeHs => {
  if (!hs.impl) throw new Error("fake handshake not installed");
  return hs.impl;
};

vi.mock("../../src/net/handshake", async (importOriginal) => {
  const real = await importOriginal<typeof HandshakeModule>();
  return {
    ...real,
    createInvite: (t: unknown, p: unknown) => use().createInvite(t, p),
    acceptInvite: (t: unknown, c: unknown, p: unknown) => use().acceptInvite(t, c, p),
    acceptAnswer: (t: unknown, c: unknown) => use().acceptAnswer(t, c),
  };
});
vi.mock("../../src/net/transport", async (importOriginal) => {
  const real = await importOriginal<typeof TransportModule>();
  return { ...real, prefetchIce: () => use().ice() };
});

// ─── a loopback end the handshake binds and opens ───────────────────────────

interface Sent {
  readonly t: string;
  readonly d: unknown;
}
type Gate = { open: boolean };

/** One side of a connection: "connecting" until the mocked handshake opens its pair. */
class Link implements RoomTransport {
  readonly name: string;
  inner: LoopbackEndpoint | null = null;
  gate: Gate = { open: false };
  /** Host side only: the far end handed to the guest that answers this invite. */
  spare: LoopbackEndpoint | null = null;
  readonly sent: Sent[] = [];
  private closed = false;
  private readonly msgFns: MessageHandler[] = [];
  private readonly closeFns: Array<(r: CloseReason) => void> = [];

  constructor(name: string) {
    this.name = name;
  }
  bind(inner: LoopbackEndpoint, gate: Gate): void {
    this.inner = inner;
    this.gate = gate;
    inner.onMessage((c, d, a) => {
      for (const fn of this.msgFns) fn(c, d, a);
    });
    inner.onClose((r) => this.shut(r));
  }
  private shut(r: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closeFns) fn(r);
  }
  get status(): EndpointStatus {
    if (this.closed) return "closed";
    if (!this.inner || !this.gate.open) return "connecting";
    return this.inner.status;
  }
  onMessage(fn: MessageHandler): this {
    this.msgFns.push(fn);
    return this;
  }
  onOpen(_fn: () => void): this {
    return this;
  }
  onClose(fn: (reason: CloseReason) => void): this {
    this.closeFns.push(fn);
    return this;
  }
  setDisconnectGrace(ms: number): number {
    return ms;
  }
  send(channel: Channel, data: WireData): boolean {
    if (this.status !== "open" || !this.inner) return false;
    if (channel === EVENT && typeof data === "string") this.sent.push(JSON.parse(data) as Sent);
    return this.inner.send(channel, data);
  }
  /** A raw event on the wire, bypassing the room (a peer's own, possibly hostile, message). */
  raw(t: string, d: unknown): boolean {
    return this.send(EVENT, JSON.stringify({ t, d }));
  }
  pump(now: number): number {
    return this.inner ? this.inner.pump(now) : 0;
  }
  close(): void {
    if (this.closed) return;
    if (this.inner) this.inner.close();
    this.shut("local");
  }
  stats(): object {
    return {};
  }
}

let seq = 0;
const invites = new Map<string, { host: Link; profile: unknown }>();
const answers = new Map<string, { host: Link; profile: unknown }>();
const fail = (error: string): { ok: false; error: string; message: string } => ({ ok: false, error, message: error });

function deferred(): { promise: Promise<null>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<null>((r) => {
    resolve = () => r(null);
  });
  return { promise, resolve };
}

let iceGate: Promise<null> | null = null;
let throwInvite = false;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  // One clock for the room's pump, its rate gates and the loopback wire.
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  seq = 0;
  invites.clear();
  answers.clear();
  iceGate = null;
  throwInvite = false;
  hs.impl = {
    ice: () => iceGate ?? Promise.resolve(null),
    async createInvite(t, profile) {
      if (throwInvite) throw new Error("InvalidStateError: closed");
      if (!(t instanceof Link)) return fail("no_transport");
      const code = "APEX1.s.invite" + ++seq;
      invites.set(code, { host: t, profile });
      return { ok: true, code, url: null };
    },
    async acceptInvite(t, code, profile) {
      const inv = invites.get(String(code));
      if (!inv || !inv.host.spare) return fail("corrupt_code");
      if (!(t instanceof Link)) return fail("no_transport");
      t.bind(inv.host.spare, inv.host.gate);
      const ans = "APEX1.s.answer" + ++seq;
      answers.set(ans, { host: inv.host, profile });
      return { ok: true, code: ans, peer: inv.profile };
    },
    async acceptAnswer(t, code) {
      const a = answers.get(String(code));
      if (!a) return fail("corrupt_code");
      if (a.host !== t) return fail("wrong_offer");
      if (a.host.gate.open) return fail("already_answered");
      a.host.gate.open = true;
      return { ok: true, peer: a.profile };
    },
  };
});

afterEach(() => {
  for (const p of players) p.room.cancel();
  players.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── players ────────────────────────────────────────────────────────────────

interface Player {
  readonly name: string;
  readonly room: Room;
  readonly links: Link[];
  readonly roles: string[];
  readonly goes: RoomHandoff[];
  readonly said: Array<[string, boolean]>;
  profile: Record<string, unknown>;
  settings: unknown;
  st(): RoomState;
  peer(id: string): Record<string, unknown> | null | undefined;
  last(): Link;
}

const players: Player[] = [];

function player(name: string, extra: Partial<RoomDeps> = {}): Player {
  const links: Link[] = [];
  const roles: string[] = [];
  const goes: RoomHandoff[] = [];
  const said: Array<[string, boolean]> = [];
  const p: Player = {
    name,
    links,
    roles,
    goes,
    said,
    profile: { name, team: "alpha" },
    settings: { laps: 3 },
    room: null as unknown as Room,
    st: () => p.room.state(),
    peer: (id) => p.room.state().peers.find((x) => x.id === id)?.profile,
    last: () => {
      const l = links[links.length - 1];
      if (!l) throw new Error(name + " has no transport");
      return l;
    },
  };
  const deps: RoomDeps = {
    profile: () => p.profile,
    settings: () => p.settings,
    onGo: (h) => goes.push(h),
    say: (m, e) => said.push([m, e]),
    makeTransport: (o) => {
      roles.push(o.role ?? "?");
      const l = new Link(name + ":" + o.role);
      if (o.role === "host") {
        const [a, b] = loopback({ latencyMs: 5 });
        l.bind(a, { open: false });
        l.spare = b;
      }
      links.push(l);
      return l;
    },
    ...extra,
  };
  (p as { room: Room }).room = createRoom(deps);
  players.push(p);
  return p;
}

/** Let the 25 ms pump, the 250 ms open poll and the 5 ms wire all run. */
const settle = async (ms = 600): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

/** The host invites, the guest answers, the host accepts: the manual (paste) path. */
async function connect(host: Player, guest: Player): Promise<{ hostLink: Link; guestLink: Link }> {
  const inv = await host.room.host();
  expect(inv.ok).toBe(true);
  const hostLink = host.last();
  const j = await guest.room.join(inv.code as string);
  expect(j.ok).toBe(true);
  const guestLink = guest.last();
  expect((await host.room.acceptAnswer(j.answer as string)).ok).toBe(true);
  await settle();
  return { hostLink, guestLink };
}

async function roomOf(n: number): Promise<{ host: Player; guests: Player[]; links: Array<{ hostLink: Link; guestLink: Link }> }> {
  const host = player("H");
  const guests: Player[] = [];
  const links: Array<{ hostLink: Link; guestLink: Link }> = [];
  for (let i = 1; i <= n; i++) {
    const g = player("G" + i);
    guests.push(g);
    links.push(await connect(host, g));
  }
  return { host, guests, links };
}

const ofType = (l: Link, t: string): Sent[] => l.sent.filter((m) => m.t === t);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// ─── connect ────────────────────────────────────────────────────────────────

test("host + guest connect and both reach the room", async () => {
  const host = player("H");
  const guest = player("G");
  const inv = await host.room.host();
  expect(inv.ok).toBe(true);
  expect(host.st().step).toBe("hosting");
  expect(host.st().invite?.code).toBe(inv.code);
  const j = await guest.room.join(inv.code as string);
  expect(j.ok).toBe(true);
  expect(guest.st().step).toBe("joining");
  expect(guest.st().answer).toBe(j.answer);
  expect(guest.peer(PEER_ONE), "the invite carried the host's profile").toEqual({ name: "H", team: "alpha" });
  expect((await host.room.acceptAnswer(j.answer as string)).ok).toBe(true);
  await settle();
  expect(host.st().step).toBe("room");
  expect(guest.st().step).toBe("room");
  expect(host.st().role).toBe("host");
  expect(guest.st().role).toBe("guest");
  expect(host.st().invite, "the invite is spent once a guest lands").toBeNull();
  expect(guest.st().answer).toBeNull();
  expect(host.st().peers.map((p) => p.id)).toEqual(["g1"]);
  expect(guest.st().peers.map((p) => p.id)).toEqual([PEER_ONE]);
  expect(host.roles).toEqual(["host"]);
  expect(guest.roles).toEqual(["guest"]);
});

test("a second answer to a used invite is refused and does not open another connection", async () => {
  // lobby-answer-flight.test.mjs:15-24, through the handshake's own refusal.
  const host = player("H");
  const guest = player("G");
  const inv = await host.room.host();
  const j = await guest.room.join(inv.code as string);
  expect((await host.room.acceptAnswer(j.answer as string)).ok).toBe(true);
  await settle();
  const again = await host.room.acceptAnswer(j.answer as string);
  expect(again.ok).toBe(false);
  expect(host.st().peers.length).toBe(1);
});

// ─── HELLO and the relay ────────────────────────────────────────────────────

test("HELLO profiles are filed per connection: a guest's `from` is ignored on the host", async () => {
  const { host, guests, links } = await roomOf(1);
  const g1 = guests[0] as Player;
  const { guestLink } = links[0] as { hostLink: Link; guestLink: Link };
  expect(host.peer("g1")).toEqual({ name: "G1", team: "alpha" });
  expect(g1.peer(PEER_ONE)).toEqual({ name: "H", team: "alpha" });
  await settle(1100); // a fresh HELLO window
  guestLink.raw(EV.HELLO, { from: "g9", rank: 1, name: "G1", team: "beta" });
  await settle(400);
  expect(host.peer("g1"), "filed under the connection; from and rank stripped").toEqual({ name: "G1", team: "beta" });
  expect(host.st().peers.some((p) => p.id === "g9"), "a guest cannot speak for another seat").toBe(false);
});

test("a guest trusts `from` only on a relay from the host", async () => {
  const { guests, links } = await roomOf(1);
  const g1 = guests[0] as Player;
  const { hostLink } = links[0] as { hostLink: Link; guestLink: Link };
  await settle(1100);
  hostLink.raw(EV.HELLO, { from: "g2", name: "G2", team: "beta" });
  hostLink.raw(EV.HELLO, { name: "H", team: "gamma" });
  await settle(400);
  expect(g1.peer("g2")).toEqual({ name: "G2", team: "beta" });
  expect(g1.peer(PEER_ONE), "no `from` is the host itself").toEqual({ name: "H", team: "gamma" });
});

test("a profile the caller refuses is never filed", async () => {
  const host = player("H", { validProfile: (p) => p["team"] !== "evil" });
  const g = player("G");
  const { guestLink } = await connect(host, g);
  await settle(1100);
  guestLink.raw(EV.HELLO, { name: "G", team: "evil" });
  guestLink.raw(EV.HELLO, ["not", "an", "object"]);
  await settle(400);
  expect(host.peer("g1")).toEqual({ name: "G", team: "alpha" });
});

test("a 3-guest room learns every profile through the host relay", async () => {
  const { host, guests } = await roomOf(3);
  await settle(1000);
  expect(host.st().peers.map((p) => p.id).sort()).toEqual(["g1", "g2", "g3"]);
  for (const [i, g] of guests.entries()) {
    const me = "g" + (i + 1);
    const seen = g.st().peers.map((p) => p.id).sort();
    expect(seen, g.name + " sees the host and the other two guests").toEqual(["g1", "g2", "g3", PEER_ONE].filter((id) => id !== me).sort());
    expect(g.peer(PEER_ONE)).toEqual({ name: "H", team: "alpha" });
    for (const [k, other] of guests.entries()) {
      if (k === i) continue;
      expect(g.peer("g" + (k + 1)), g.name + " learnt " + other.name).toEqual({ name: other.name, team: "alpha" });
    }
  }
});

test("HELLO is rate-limited per connection: more than five a second is dropped", async () => {
  const { host, links } = await roomOf(1);
  const { guestLink } = links[0] as { hostLink: Link; guestLink: Link };
  await settle(1100);
  for (let n = 0; n < 8; n++) guestLink.raw(EV.HELLO, { name: "G1", label: n });
  await settle(400);
  expect(host.peer("g1")?.["label"], "the sixth onwards inside one second is dropped").toBe(4);
  await settle(1000);
  guestLink.raw(EV.HELLO, { name: "G1", label: 99 });
  await settle(400);
  expect(host.peer("g1")?.["label"], "a new second takes HELLO again").toBe(99);
});

test("READY is rate-limited per connection like HELLO", async () => {
  const { host, links } = await roomOf(1);
  const { guestLink } = links[0] as { hostLink: Link; guestLink: Link };
  await settle(1100);
  const rev = (ofType(guestLink, EV.READY)[0]?.d as { revision?: unknown } | undefined)?.revision ?? 1;
  for (let n = 0; n < 5; n++) guestLink.raw(EV.READY, { ready: false, revision: rev });
  guestLink.raw(EV.READY, { ready: true, revision: rev });
  await settle(400);
  expect(host.st().peers[0]?.ready, "the sixth READY in a second is dropped").toBe(false);
});

// ─── READY and settings revisions ───────────────────────────────────────────

test("the host publishes settings with a revision; READY counts only for the current one", async () => {
  const { host, guests, links } = await roomOf(1);
  const g1 = guests[0] as Player;
  const { hostLink, guestLink } = links[0] as { hostLink: Link; guestLink: Link };
  const first = ofType(hostLink, EV.SETTINGS);
  expect(first.length).toBe(1);
  expect(first[0]?.d).toEqual({ revision: 1, settings: { laps: 3 } });
  expect(g1.st().settings).toEqual({ laps: 3 });

  g1.room.setReady(true);
  host.room.setReady(true);
  await settle(400);
  expect(host.st().peers[0]?.ready).toBe(true);
  expect(host.st().canStart).toBe(true);
  expect(g1.st().peers.find((p) => p.id === PEER_ONE)?.ready, "the guest sees the host READY").toBe(true);

  host.settings = { laps: 7 };
  host.room.publishSettings();
  expect(host.st().selfReady, "the host confirms the new rules again too").toBe(false);
  expect(host.st().peers[0]?.ready).toBe(false);
  expect(host.st().canStart).toBe(false);
  await settle(400);
  expect(ofType(hostLink, EV.SETTINGS).at(-1)?.d).toEqual({ revision: 2, settings: { laps: 7 } });
  expect(g1.st().settings).toEqual({ laps: 7 });
  expect(g1.st().selfReady, "new rules reset the guest's READY").toBe(false);

  await settle(1100);
  guestLink.raw(EV.READY, { ready: true, revision: 1 });
  host.room.setReady(true);
  await settle(400);
  expect(host.st().peers[0]?.ready, "a READY for the old rules does not count").toBe(false);
  expect(host.room.start().ok).toBe(false);

  g1.room.setReady(true);
  await settle(400);
  expect(ofType(guestLink, EV.READY).at(-1)?.d).toEqual({ ready: true, revision: 2 });
  expect(host.st().peers[0]?.ready).toBe(true);
  expect(host.st().canStart).toBe(true);
});

test("canStart only when everyone is ready, and there has to be somebody", async () => {
  const solo = player("S");
  await solo.room.host();
  solo.room.setReady(true);
  expect(solo.st().canStart, "nobody has joined").toBe(false);
  expect(solo.room.start()).toMatchObject({ ok: false });

  const { host, guests } = await roomOf(2);
  const [g1, g2] = guests as [Player, Player];
  expect(host.st().canStart).toBe(false);
  host.room.setReady(true);
  g1.room.setReady(true);
  await settle(400);
  expect(host.st().canStart, "g2 is still choosing").toBe(false);
  expect(host.room.start()).toMatchObject({ ok: false, error: "not_ready" });
  g2.room.setReady(true);
  await settle(400);
  expect(host.st().canStart).toBe(true);
  host.room.setReady(false);
  expect(host.st().canStart, "the host has to be READY too").toBe(false);
  expect(g1.room.start(), "only the host starts").toMatchObject({ ok: false, error: "not_host" });
});

test("a READY relayed through the host reaches the other guests", async () => {
  // net-lobby-lifecycle.test.mjs:948-957 (BUGS.md B3): guests learn each other's READY only via the host.
  const { guests } = await roomOf(2);
  const [g1, g2] = guests as [Player, Player];
  g1.room.setReady(true);
  await settle(300);
  expect(g2.st().peers.find((p) => p.id === "g1")?.ready).toBe(true);
  g1.room.setReady(false);
  await settle(300);
  expect(g2.st().peers.find((p) => p.id === "g1")?.ready).toBe(false);
});

test("a late joiner does not reset the room's READY, and is caught up on it", async () => {
  // net-lobby-lifecycle.test.mjs:938-946 (READY resets only for a FRESH room)
  // and :1033-1068 (host catch-ups READY to a late joiner).
  const host = player("H");
  const g1 = player("G1");
  const g2 = player("G2");
  await connect(host, g1);
  g1.room.setReady(true);
  host.room.setReady(true);
  await settle(400);
  expect(host.st().canStart).toBe(true);
  const { hostLink } = await connect(host, g2);
  expect(host.st().selfReady, "the host stays READY").toBe(true);
  expect(host.st().peers.find((p) => p.id === "g1")?.ready, "g1 stays READY").toBe(true);
  expect(host.st().canStart, "but g2 has not confirmed yet").toBe(false);
  const readies = ofType(hostLink, EV.READY).filter((m) => isRec(m.d) && m.d["ready"] === true);
  expect(readies.some((m) => isRec(m.d) && m.d["from"] == null), "the host's own READY").toBe(true);
  expect(readies.some((m) => isRec(m.d) && m.d["from"] === "g1"), "g1's READY").toBe(true);
  expect(g2.st().peers.find((p) => p.id === PEER_ONE)?.ready).toBe(true);
  expect(g2.st().peers.find((p) => p.id === "g1")?.ready).toBe(true);
  g2.room.setReady(true);
  await settle(400);
  expect(host.st().canStart).toBe(true);
});

test("the last guest leaving clears READY before a replacement connects", async () => {
  // net-lobby-lifecycle.test.mjs:987-1031.
  const host = player("H");
  const g1 = player("G1");
  await connect(host, g1);
  g1.room.setReady(true);
  host.room.setReady(true);
  await settle(400);
  g1.room.cancel();
  await settle(400);
  expect(host.st().step).toBe("pick");
  expect(host.st().selfReady, "an empty room clears local readiness at once").toBe(false);
  expect(host.st().peers).toEqual([]);
  expect(host.said.at(-1)).toEqual(["Your friend left the room.", true]);
  const g2 = player("G2");
  const { hostLink } = await connect(host, g2);
  const stale = ofType(hostLink, EV.READY).filter((m) => isRec(m.d) && m.d["ready"] === true);
  expect(stale, "the replacement does not inherit the departed room's READY").toEqual([]);
  expect(host.st().canStart).toBe(false);
});

test("a guest refuses GO for stale or refused settings, and until it is READY", async () => {
  // net-lobby-lifecycle.test.mjs:2392-2445.
  let accept = true;
  const host = player("H");
  const g = player("G", { applySettings: () => accept });
  const { hostLink } = await connect(host, g);
  hostLink.raw(EV.GO, { revision: 1 });
  await settle(400);
  expect(g.goes.length, "not READY yet").toBe(0);
  expect(g.said.at(-1)?.[1]).toBe(true);
  g.room.setReady(true);
  hostLink.raw(EV.GO, { revision: 0 });
  await settle(400);
  expect(g.goes.length, "a stale start revision is refused").toBe(0);
  accept = false;
  hostLink.raw(EV.SETTINGS, { revision: 2, settings: { laps: 0 } });
  await settle(400);
  expect(g.st().selfReady).toBe(false);
  g.room.setReady(true);
  hostLink.raw(EV.GO, { revision: 2 });
  await settle(400);
  expect(g.goes.length, "refused settings block GO even when READY").toBe(0);
  accept = true;
  hostLink.raw(EV.SETTINGS, { revision: 3, settings: { laps: 7 } });
  await settle(400);
  g.room.setReady(true);
  hostLink.raw(EV.GO, { revision: 3 });
  await settle(400);
  expect(g.goes.length).toBe(1);
  expect(g.goes[0]?.settings).toEqual({ laps: 7 });
});

// ─── start ──────────────────────────────────────────────────────────────────

test("start() hands every session to the host's onGo and GO reaches each guest's", async () => {
  const { host, guests } = await roomOf(3);
  host.room.setReady(true);
  for (const g of guests) g.room.setReady(true);
  await settle(300);
  expect(host.st().canStart).toBe(true);
  expect(host.room.start()).toEqual({ ok: true });
  expect(host.st().step).toBe("racing");
  expect(host.goes.length).toBe(1);
  const h = host.goes[0] as RoomHandoff;
  expect(h.role).toBe("host");
  expect(h.sessions.map((s) => s.id).sort()).toEqual(["g1", "g2", "g3"]);
  expect([...h.transports.keys()].sort()).toEqual(["g1", "g2", "g3"]);
  expect(h.peers.map((p) => p.id).sort()).toEqual(["g1", "g2", "g3"]);
  expect(h.settings).toEqual({ laps: 3 });
  await settle(300);
  for (const g of guests) {
    expect(g.goes.length, g.name + " got GO").toBe(1);
    const gh = g.goes[0] as RoomHandoff;
    expect(gh.role).toBe("guest");
    expect(gh.sessions.map((s) => s.id)).toEqual([PEER_ONE]);
    expect(gh.peers.length, "the host and two other guests").toBe(3);
    expect(g.st().step).toBe("racing");
  }
  // The sessions survive the hand-off: the race owns them now.
  for (const s of h.sessions) expect(s.session.alive()).toBe(true);
});

// ─── capacity ───────────────────────────────────────────────────────────────

test("MAX_GUESTS: the room is full at 3 guests", async () => {
  expect(MAX_GUESTS).toBe(3);
  const { host } = await roomOf(2);
  expect(host.st().full).toBe(false);
  const g3 = player("G3");
  await connect(host, g3);
  expect(host.st().full).toBe(true);
  const more = await host.room.inviteAnother();
  expect(more).toMatchObject({ ok: false, error: "full" });
  expect(host.roles.length, "no fourth transport").toBe(3);
});

// ─── leaving and eviction ───────────────────────────────────────────────────

test("removeGuest sends LEFT {evicted}; the guest goes back to pick and the host keeps the room", async () => {
  // net-lobby-lifecycle.test.mjs:1408-1490, net-roster.test.mjs:611-621.
  const host = player("H");
  const g = player("G");
  const { hostLink, guestLink } = await connect(host, g);
  host.room.removeGuest("nobody"); // unknown: a no-op
  expect(ofType(hostLink, EV.LEFT)).toEqual([]);
  g.room.removeGuest(PEER_ONE); // a guest cannot remove anybody
  expect(ofType(guestLink, EV.LEFT)).toEqual([]);
  host.room.removeGuest("g1");
  host.room.removeGuest("g1"); // a second tap while waiting is a no-op
  expect(ofType(hostLink, EV.LEFT).map((m) => m.d)).toEqual([{ evicted: true }]);
  await settle(400);
  expect(g.st().step).toBe("pick");
  expect(g.st().status).toMatch(/removed you from the room/i);
  expect(g.st().error).toBe(true);
  expect(guestLink.status, "the guest closed its own end").toBe("closed");
  expect(host.st().peers).toEqual([]);
  expect(host.st().step, "evicting the last guest keeps the host in the waiting room").toBe("room");
  expect(host.st().status).toMatch(/removed/i);
  expect((await host.room.inviteAnother()).ok, "the seat is free to invite again").toBe(true);
});

test("a silent evicted guest is closed by the host after the grace window", async () => {
  const host = player("H");
  const g = player("G");
  const { hostLink } = await connect(host, g);
  // The guest's room never reads LEFT: stop it pumping by handing nothing over.
  vi.spyOn(g.last(), "pump").mockReturnValue(0);
  host.room.removeGuest("g1");
  await settle(1000);
  expect(hostLink.status, "LEFT goes out first; the close waits").toBe("open");
  await settle(700);
  expect(hostLink.status).toBe("closed");
  expect(host.st().peers).toEqual([]);
});

test("a guest leaving tells the other guests (LEFT {from})", async () => {
  // net-roster.test.mjs:104-128 (lobby phase) and net-lobby-lifecycle.test.mjs:668-680.
  const { host, guests, links } = await roomOf(3);
  const [g1, g2, g3] = guests as [Player, Player, Player];
  await settle(500);
  expect(g1.peer("g2")).toBeTruthy();
  g2.room.cancel();
  await settle(300);
  expect(host.st().peers.map((p) => p.id).sort()).toEqual(["g1", "g3"]);
  expect(host.st().step).toBe("room");
  expect(host.st().status).toMatch(/A player left/);
  for (const i of [0, 2]) {
    const l = (links[i] as { hostLink: Link }).hostLink;
    expect(ofType(l, EV.LEFT).map((m) => m.d)).toEqual([{ from: "g2" }]);
  }
  for (const g of [g1, g3]) {
    expect(g.st().peers.some((p) => p.id === "g2"), g.name + " dropped g2").toBe(false);
    expect(g.st().step).toBe("room");
  }
  expect(host.st().full).toBe(false);
});

test("the host leaving sends every guest back to pick and forgets every relayed guest", async () => {
  // net-lobby-lifecycle.test.mjs:1233-1263.
  const { host, guests } = await roomOf(2);
  const [g1] = guests as [Player, Player];
  expect(g1.peer("g2")).toBeTruthy();
  host.room.cancel();
  await settle(300);
  for (const g of guests) {
    expect(g.st().step).toBe("pick");
    expect(g.st().peers, g.name + ": no profile survives the room").toEqual([]);
    expect(g.st().status).toMatch(/host left the room/i);
    expect(g.st().selfReady).toBe(false);
  }
});

test("a guest's LEFT is ignored by the host: only the host speaks for the roster", async () => {
  // net-roster.test.mjs:167-176, lobby phase.
  const { host, links } = await roomOf(2);
  (links[0] as { guestLink: Link }).guestLink.raw(EV.LEFT, { from: "g2" });
  (links[0] as { guestLink: Link }).guestLink.raw(EV.LEFT, { evicted: true });
  await settle(400);
  expect(host.st().peers.map((p) => p.id).sort()).toEqual(["g1", "g2"]);
  expect(host.st().step).toBe("room");
});

// ─── cancel and failures ────────────────────────────────────────────────────

test("cancel() closes everything", async () => {
  const { host, guests, links } = await roomOf(2);
  const spare = await host.room.inviteAnother();
  expect(spare.ok).toBe(true);
  const pending = host.last();
  host.room.cancel();
  const st = host.st();
  expect(st.step).toBe("pick");
  expect(st.role).toBeNull();
  expect(st.peers).toEqual([]);
  expect(st.invite).toBeNull();
  expect(st.selfReady).toBe(false);
  for (const l of links) expect(l.hostLink.status).toBe("closed");
  expect(pending.status, "the invite in flight too").toBe("closed");
  await settle(300);
  for (const g of guests) expect(g.st().step).toBe("pick");
  // No timer keeps running behind a cancelled room (readyIce's 2.5 s race timers run out on their own).
  await settle(2500);
  expect(vi.getTimerCount()).toBe(0);
});

test("cancel clears READY before a replacement peer is caught up", async () => {
  // net-lobby-lifecycle.test.mjs:959-985.
  const host = player("H");
  await connect(host, player("G1"));
  host.room.setReady(true);
  host.room.cancel();
  expect(host.st().selfReady).toBe(false);
  const { hostLink } = await connect(host, player("G2"));
  expect(ofType(hostLink, EV.READY).filter((m) => isRec(m.d) && m.d["ready"] === true)).toEqual([]);
  expect(host.st().peers.map((p) => p.id), "guest ids restart for a fresh room").toEqual(["g1"]);
});

test("a newer operation prevents a late host continuation", async () => {
  // net-lobby-lifecycle.test.mjs:275-286.
  const other = player("O");
  const inv = await other.room.host();
  const h = player("H");
  const ice = deferred();
  iceGate = ice.promise;
  const hosting = h.room.host();
  const joining = h.room.join(inv.code as string);
  ice.resolve();
  expect(await hosting).toMatchObject({ ok: false, error: "cancelled" });
  expect((await joining).ok).toBe(true);
  expect(h.roles, "the stale host must not create a transport").toEqual(["guest"]);
});

test("cancel then a new attempt prevents the prior generation from attaching", async () => {
  // net-lobby-lifecycle.test.mjs:288-303.
  const other = player("O");
  const inv = await other.room.host();
  const h = player("H");
  const ice = deferred();
  iceGate = ice.promise;
  const stale = h.room.host();
  h.room.cancel();
  const current = h.room.join(inv.code as string);
  ice.resolve();
  expect(await stale).toMatchObject({ ok: false, error: "cancelled" });
  expect((await current).ok).toBe(true);
  expect(h.roles).toEqual(["guest"]);
});

test("a malformed code is refused before any transport", async () => {
  // net-lobby-lifecycle.test.mjs:1189-1203.
  const g = player("G");
  const a = await g.room.join("not-a-real-code");
  expect(a).toMatchObject({ ok: false, error: "bad_code", message: expect.stringMatching(/apex invite code/i) });
  expect(g.roles).toEqual([]);
  const b = await g.room.acceptAnswer("not-a-real-code");
  expect(b).toMatchObject({ ok: false, error: "no_invite" });
  expect(g.st().error).toBe(true);
});

test("createInvite throwing becomes a typed result", async () => {
  // net-lobby-lifecycle.test.mjs:1362-1373.
  const h = player("H");
  throwInvite = true;
  const res = await h.room.host();
  expect(res).toMatchObject({ ok: false, error: "invite_failed" });
  expect(h.st().status).toMatch(/Could not make an invite/);
});

test("a connection that never opens fails after 60 s with the diagnosis, and closes silently", async () => {
  // net-lobby-lifecycle.test.mjs:1348-1360: the never-connected close must not overwrite the diagnosis.
  const host = player("H");
  const g = player("G");
  const inv = await host.room.host();
  expect((await g.room.join(inv.code as string)).ok).toBe(true);
  await settle(59_000);
  expect(g.st().step).toBe("joining");
  await settle(2_000);
  expect(g.st().step).toBe("pick");
  expect(g.st().error).toBe(true);
  expect(g.st().status).toMatch(/Could not connect after 6\ds/);
  expect(g.said.some(([m]) => /left the room/.test(m)), "no peer-leave copy for a peer that never joined").toBe(false);
  expect(g.last().status).toBe("closed");
});

test("a host whose second invite fails keeps its first guest", async () => {
  const host = player("H");
  await connect(host, player("G1"));
  const inv = await host.room.inviteAnother();
  const g2 = player("G2");
  const j = await g2.room.join(inv.code as string);
  host.last().close(); // the second connection dies before it opens
  await host.room.acceptAnswer(j.answer as string);
  await settle(300);
  expect(host.st().step).toBe("room");
  expect(host.st().peers.map((p) => p.id)).toEqual(["g1"]);
  expect(host.st().error).toBe(true);
});

test("codeJoin refuses a malformed room code before any network", async () => {
  const g = player("G");
  const res = await g.room.codeJoin("ab");
  expect(res).toMatchObject({ ok: false, error: "bad_code" });
  expect(g.roles).toEqual([]);
});
