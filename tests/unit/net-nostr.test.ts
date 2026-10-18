/**
 * The room-code exchange over public Nostr relays (src/net/nostr.ts), on a fake
 * WebSocket, and the @trystero-p2p/nostr surface it relies on.
 *
 * Ported from f1-game tests/unit/net-nostr-sockets.test.mjs (every test):
 *   :24-74     boot(): a hand-driven WebSocket, a document with visibility
 *              listeners, a two-relay override and a stub of the two Trystero helpers
 *   :76-90     the REQ carries no `since`
 *   :92-134    a dropped socket is reopened (backoff and foreground); not after stop()
 *   :136-163   JOIN/HOST timeouts and the expired copy (source pins kept)
 *   :165-200   host room survives past JOIN_TIMEOUT; guest still expires
 *   :202-229   a guest that finds the offer late is not expired mid-reply (bug-hunt 8.3)
 *   :231-270   a replayed old offer is ignored; a fresh one is answered
 *
 * and from f1-game tests/unit/net-trystero-api.test.mjs:
 *   :31-47     createEvent/subscribe exported and called: pinned against the REAL
 *              installed @trystero-p2p/nostr module (shapes: `["REQ", id, {kinds,
 *              since, "#x"}]`, `["EVENT", {id, content, created_at, ...}]`), not the
 *              vendored source text
 *   :49-59     refusals read first-hand (source pins, regexes adapted to the TS)
 *   :61-71     version 0.25.4 with the relay backoff (installed package, not vendor/)
 *   :149-157   dynamic import only (the src/ and index.html halves)
 *   :159-251   bad relay override, bounded frames, bounded inbox, finish() timers
 *
 * Not ported, because apex-26 has no vendored tree: Vite resolves and bundles the
 * npm package (package-lock.json pins it), so there is no `.mjs`-on-Pages risk
 * (:73-90), no hand-maintained file list or licence copies (:99-113), no importmap
 * to cover bare specifiers (:115-147), and no tools/manifest.cjs load order
 * (:155-156). `.nojekyll` (:92-97) does not apply: deploy.yml publishes through
 * actions/upload-pages-artifact, which never runs Jekyll.
 *
 * Differences from f1-game: one module instance, not a VM per boot(): WebSocket,
 * document and localStorage are vi.stubGlobal fakes (relay key `a26.nostrRelays`)
 * and setFramingLoader() replaces the dynamic import. Where f1-game waits real
 * seconds (backoff, the 12 s JOIN window, a 2.5 s reply) the timers are vitest
 * fakes advanced by hand, so the 12 s JOIN_TIMEOUT_MS needs no source patch; the
 * WebCrypto work (PBKDF2) still runs on real time, awaited with untilReal().
 * The two exchanges of :165-200 share one fake-socket registry (host first).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { b64ToBytes, bytesToB64 } from "../../src/net/bytes";
import * as NetNostr from "../../src/net/nostr";
import type { HostedRoom, NostrFail, NostrFraming } from "../../src/net/nostr";
import * as NetRendezvous from "../../src/net/rendezvous";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), "utf8");
const SLOW = 30000;

// Captured before any vi.useFakeTimers(): real time for WebCrypto to finish in.
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> => new Promise((r) => realSetTimeout(r, ms));
async function untilReal(pred: () => boolean, what: string, maxMs = 10000): Promise<void> {
  const t0 = performance.now();
  while (!pred()) {
    if (performance.now() - t0 > maxMs) throw new Error("timed out waiting for " + what);
    await sleep(10);
  }
}

const FAKE: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  NetNostr.setFramingLoader(null);
});

class FakeWebSocket {
  static registry: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.registry.push(this);
  }
  send(frame: string): void {
    this.sent.push(frame);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  }
  // test controls
  open(): void {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  /** The browser killed it. */
  drop(): void {
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  }
  deliver(msg: unknown): void {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
}

function boot() {
  FakeWebSocket.registry = [];
  const sockets = FakeWebSocket.registry;
  const listeners = new Map<string, () => void>();
  const document = {
    hidden: false,
    addEventListener: (ev: string, fn: () => void) => listeners.set(ev, fn),
    removeEventListener: (ev: string, fn: () => void) => {
      if (listeners.get(ev) === fn) listeners.delete(ev);
    },
  };
  // The two Trystero helpers the exchange calls, with Trystero's own REQ shape
  // (kinds / since / #x), so the test proves what is stripped.
  const mod: NostrFraming = {
    subscribe: (subId, topic) => JSON.stringify(["REQ", subId, { kinds: [22222], since: Math.floor(Date.now() / 1000), "#x": [topic] }]),
    createEvent: async (topic, content) =>
      JSON.stringify(["EVENT", { id: "id" + Math.random().toString(36).slice(2), kind: 22222, content, tags: [["x", topic]] }]),
  };
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("document", document);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k === NetNostr.STORE_RELAYS ? JSON.stringify(["wss://a.test", "wss://b.test"]) : null),
    setItem() {},
    removeItem() {},
  });
  NetNostr.setFramingLoader(() => Promise.resolve(mod));
  // The topics are PBKDF2-stretched (120 000 rounds) before any socket opens.
  const untilSockets = (n: number): Promise<void> => untilReal(() => sockets.length >= n, n + " sockets");
  const fire = (ev: string): void => {
    const fn = listeners.get(ev);
    if (fn) fn();
  };
  const at = (i: number): FakeWebSocket => {
    const s = sockets[i];
    if (!s) throw new Error("no socket " + i);
    return s;
  };
  return { sockets, document, listeners, untilSockets, fire, at };
}

const asRoom = (r: unknown): HostedRoom => {
  const room = r as HostedRoom;
  if (!room.ok || !room.subscribed) throw new Error("expected a hosted room: " + JSON.stringify(r));
  return room;
};
const isEventFrame = (f: string): boolean => f.startsWith('["EVENT"');

test("the REQ carries no `since`: a fast device clock must not filter the host's offer", async () => {
  const h = boot();
  const p = NetNostr.directExchange({ code: "ABCDEF", send: "OFFER", onJoiner: () => {} });
  await h.untilSockets(2);
  expect(h.sockets.length, "one socket per relay").toBe(2);
  h.at(0).open();
  await sleep(20);
  const req = JSON.parse(h.at(0).sent[0] as string) as [string, string, Record<string, unknown>];
  expect(req[0]).toBe("REQ");
  expect(Array.isArray(req[2].kinds) && !!req[2]["#x"], "kinds and the topic tag survive").toBe(true);
  expect(req[2].since, "no device-clock lower bound").toBe(undefined);
  const room = asRoom(await p);
  expect(room.ok).toBe(true);
  room.stop();
}, SLOW);

test("a socket the browser dropped is reopened, and once at return to the foreground", async () => {
  vi.useFakeTimers(FAKE);
  const h = boot();
  const room = asRoom(await NetNostr.directExchange({ code: "ABCDEF", send: "OFFER", onJoiner: () => {} }));
  const a = h.at(0);
  const b = h.at(1);
  a.open();
  b.open();
  await sleep(20);
  // The page is hidden; the browser kills both sockets.
  h.document.hidden = true;
  a.drop();
  b.drop();
  expect(h.sockets.length, "nothing reopens while hidden and before the backoff").toBe(2);
  // Back to the foreground: reopened at once, one per relay, no duplicates.
  h.document.hidden = false;
  h.fire("visibilitychange");
  expect(h.sockets.length, "one new socket per relay").toBe(4);
  expect(h.sockets.slice(2).map((s) => s.url).sort()).toEqual(["wss://a.test", "wss://b.test"]);
  h.fire("visibilitychange");
  expect(h.sockets.length, "a second visibility event opens nothing while those are connecting").toBe(4);
  h.at(2).open();
  expect((JSON.parse(h.at(2).sent[0] as string) as unknown[])[0], "the reopened socket re-subscribes").toBe("REQ");
  // With the page visible, a dropped socket comes back on the backoff alone.
  h.at(2).drop();
  expect(h.sockets.length).toBe(4);
  await vi.advanceTimersByTimeAsync(1100);
  expect(h.sockets.length, "reopened after the first backoff step").toBe(5);
  expect(h.at(4).url).toBe("wss://a.test");
  room.stop();
  await sleep(20);
  expect(h.listeners.size, "stop() removes the visibility listener").toBe(0);
}, SLOW);

test("after stop() a closing socket is not reopened", async () => {
  vi.useFakeTimers(FAKE);
  const h = boot();
  const room = asRoom(await NetNostr.directExchange({ code: "ABCDEF", send: "OFFER", onJoiner: () => {} }));
  await h.untilSockets(1);
  h.at(0).open();
  room.stop();
  const n = h.sockets.length;
  h.fire("visibilitychange");
  await vi.advanceTimersByTimeAsync(1100);
  expect(h.sockets.length, "nothing reopens once the exchange is over").toBe(n);
}, SLOW);

test("JOIN_TIMEOUT_MS is the ~8–15 s lobby join target, not a two-minute hang", () => {
  expect(NetNostr.JOIN_TIMEOUT_MS, "enough headroom for relay open + a few reposts").toBeGreaterThanOrEqual(8000);
  expect(NetNostr.JOIN_TIMEOUT_MS, "fake/missing codes must not sit on Looking for…").toBeLessThanOrEqual(15000);
});

test("HOST_TIMEOUT_MS is ~120 s so a typed room code still works (#1061 guest stay short)", () => {
  expect(NetNostr.HOST_TIMEOUT_MS, "host must outlast a human carrying the code").toBeGreaterThanOrEqual(60000);
  expect(NetNostr.HOST_TIMEOUT_MS, "not forever — INVITE ANOTHER refreshes").toBeLessThanOrEqual(180000);
  expect(NetNostr.HOST_TIMEOUT_MS, "host and guest deadlines must not share the 12 s JOIN window").toBeGreaterThan(
    NetNostr.JOIN_TIMEOUT_MS * 4,
  );
});

test("Nostr expired copy is actionable (no false 'couple of minutes' claim)", () => {
  const src = read("src/net/nostr.ts");
  expect(src).toMatch(/Nobody answered that code/);
  expect(src).toMatch(/Check the six characters/);
  expect(src).toMatch(/fresh one/);
  expect(src).not.toMatch(/Codes only last a couple of minutes/);
});

test("host expiry uses HOST_TIMEOUT_MS; guest keeps JOIN_TIMEOUT_MS (source)", () => {
  const src = read("src/net/nostr.ts");
  expect(src).toMatch(/const HOST_TIMEOUT_MS = 120000/);
  expect(src).toMatch(/hosting \? HOST_TIMEOUT_MS : JOIN_TIMEOUT_MS/);
  expect(src, "guest clears expiry once the answer is posted").toMatch(/clearExpire\(\)/);
});

test("host room survives past JOIN_TIMEOUT; guest still expires around it (acceptance)", async () => {
  // Live repro 14296/3faf59d9: host code T9Q4VH died at 12 s with JOIN_TIMEOUT
  // shared across roles. Host + guest run in parallel on one fake clock.
  vi.useFakeTimers(FAKE);
  const h = boot();
  let hostFail: NostrFail | null = null;
  const hostP = NetNostr.directExchange({
    code: "T9Q4VH",
    send: "OFFER",
    onJoiner: () => {},
    onFail: (r) => {
      hostFail = r;
    },
  });
  await h.untilSockets(2); // host: sockets 0, 1
  let guestRes: unknown = null;
  const guestP = NetNostr.directExchange({
    code: "ZZZZZZ",
    reply: async () => {
      throw new Error("no offer expected");
    },
  }).then((r) => {
    guestRes = r;
    return r;
  });
  await h.untilSockets(4); // guest: sockets 2, 3
  const hostSock = h.at(0);
  hostSock.open();
  h.at(2).open();
  const hostRoom = asRoom(await hostP);
  expect(hostRoom.ok, "host exchange resolves to a live room handle").toBe(true);

  const joinMs = NetNostr.JOIN_TIMEOUT_MS;
  expect(joinMs, "#1061 guest window intact").toBeLessThanOrEqual(15000);
  await vi.advanceTimersByTimeAsync(joinMs + 3000);
  await untilReal(() => guestRes !== null, "guest to settle");
  const g = guestRes as NostrFail;
  expect(g.ok, "missing-code guest still fails").toBe(false);
  expect(g.error, "…with expired, not a hang").toBe("expired");
  expect(g.message).toMatch(/Check the six characters/);
  await guestP;

  // Same wall time is still well under HOST_TIMEOUT — host must not have fired onFail.
  await vi.advanceTimersByTimeAsync(500);
  expect(hostFail, "host must NOT expire at JOIN_TIMEOUT").toBe(null);
  expect(hostSock.readyState, "host sockets still open past guest expiry").toBe(1);
  hostRoom.stop();
}, SLOW);

test("a guest that finds the offer late is not expired while it builds the answer (bug-hunt 8.3)", async () => {
  // JOIN_TIMEOUT_MS is the window to FIND the offer. Here the offer arrives
  // 1 s before it closes and the reply (build + ICE gather) takes 2.5 s, so the
  // reply ends past the window. Before the fix the join timer kept running,
  // won, and heard() returned without ever publishing the answer.
  vi.useFakeTimers(FAKE);
  const h = boot();
  const token = { cancelled: false };
  let res: unknown = null;
  let replyStarted = false;
  let replyDone = false;
  const p = NetNostr.directExchange({
    code: "ABCDEF",
    token,
    reply: async () => {
      replyStarted = true;
      await new Promise((r) => setTimeout(r, 2500));
      replyDone = true;
      return "ANSWER";
    },
  }).then((r) => {
    res = r;
    return r;
  });
  await h.untilSockets(1);
  const w = h.at(0);
  w.open();
  await vi.advanceTimersByTimeAsync(NetNostr.JOIN_TIMEOUT_MS - 1000);
  expect(res, "precondition: still looking 1 s before the find window closes").toBe(null);
  const sealed = await NetRendezvous.seal("ABCDEF", "OFFER", "offer");
  w.deliver(["EVENT", "s1", { content: bytesToB64(sealed), created_at: Math.floor(Date.now() / 1000) }]);
  await untilReal(() => replyStarted, "the reply to start");
  await vi.advanceTimersByTimeAsync(3300); // past the find window AND the reply
  expect(replyDone, "precondition: the reply finished after the find window").toBe(true);
  await untilReal(() => w.sent.some(isEventFrame), "the answer on the wire");
  expect(res, "the exchange was not expired mid-reply").toBe(null);
  expect(w.sent.some(isEventFrame), "the answer reached the wire").toBe(true);
  token.cancelled = true; // tick() finishes it within a second
  await vi.advanceTimersByTimeAsync(1000);
  await p;
}, SLOW);

test("a replayed old offer is ignored; a fresh offer is still answered (created_at floor)", async () => {
  // since is stripped (clock skew). Without a local floor a relay replaying an
  // earlier host session's offer would be answered. hostStartedAt − ~30 s.
  const h = boot();
  let answered = 0;
  const token = { cancelled: false };
  const p = NetNostr.directExchange({
    code: "ABCDEF",
    token,
    reply: async () => {
      answered++;
      return "ANSWER";
    },
  });
  await h.untilSockets(1);
  const w = h.at(0);
  w.open();
  await sleep(20);
  const req = JSON.parse(w.sent[0] as string) as [string, string, Record<string, unknown>];
  expect(req[2].since, "since stays stripped").toBe(undefined);

  const now = Math.floor(Date.now() / 1000);
  const staleSealed = await NetRendezvous.seal("ABCDEF", "OLD-OFFER", "offer");
  w.deliver(["EVENT", "s1", { content: bytesToB64(staleSealed), created_at: now - 3600 }]);
  await sleep(20);
  await sleep(80);
  expect(answered, "stale offer must not be answered").toBe(0);
  expect(w.sent.some(isEventFrame), "no answer on the wire for stale").toBe(false);

  const freshSealed = await NetRendezvous.seal("ABCDEF", "NEW-OFFER", "offer");
  w.deliver(["EVENT", "s1", { content: bytesToB64(freshSealed), created_at: now }]);
  await sleep(20);
  await untilReal(() => w.sent.some(isEventFrame), "the answer on the wire", 2000).catch(() => {});
  expect(answered, "fresh offer is answered").toBe(1);
  expect(w.sent.some(isEventFrame), "answer published for fresh offer").toBe(true);
  token.cancelled = true;
  await p;
}, SLOW);

// ---------------------------------------------------------------------------
// net-trystero-api.test.mjs: the @trystero-p2p/nostr surface we actually use
// ---------------------------------------------------------------------------

// CODE, not prose: the file's comments record why the room join was removed,
// so the "must not creep back" pins below run against a comment-stripped copy.
const ours = read("src/net/nostr.ts");
const oursCode = ours.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");

test("the direct exchange reaches createEvent and subscribe, and both are exported", async () => {
  // The two framing helpers are the whole of what we take from the package: a
  // signed NIP-01 EVENT frame and a REQ frame. If a bump renames or drops
  // either, or changes the frame shapes nostr.ts parses, this fails here
  // instead of in a lobby that blames the network.
  NetNostr.setFramingLoader(null);
  const mod = await NetNostr.load(); // the real dynamic import nostr.ts runs
  const real = await import("@trystero-p2p/nostr");
  expect(mod.createEvent, "load() resolves the installed package").toBe(real.createEvent);
  expect(typeof real.createEvent, "createEvent must be exported").toBe("function");
  expect(typeof real.subscribe, "subscribe must be exported").toBe("function");

  // subscribe(subId, topic) -> REQ frame text, with the `since` nostr.ts strips.
  const topic = await NetRendezvous.topic("ABCDEF", "offer");
  const req = JSON.parse(mod.subscribe("s123", topic)) as unknown[];
  expect(req.length).toBe(3);
  expect(req[0]).toBe("REQ");
  expect(req[1]).toBe("s123");
  const filter = req[2] as { kinds?: unknown; since?: unknown; "#x"?: unknown };
  expect(Object.keys(filter).sort()).toEqual(["#x", "kinds", "since"]);
  expect(Array.isArray(filter.kinds) && (filter.kinds as unknown[]).every((k) => Number.isInteger(k))).toBe(true);
  expect(typeof filter.since, "the device-clock bound nostr.ts deletes").toBe("number");
  expect(filter["#x"]).toEqual([topic]);

  // createEvent(topic, content) -> EVENT frame text with the id nostr.ts tracks
  // for OK refusals and the content/created_at its inbox reads.
  const content = bytesToB64(await NetRendezvous.seal("ABCDEF", "OFFER", "offer"));
  const frame = await mod.createEvent(topic, content);
  const ev = JSON.parse(frame) as unknown[];
  expect(ev.length).toBe(2);
  expect(ev[0]).toBe("EVENT");
  const body = ev[1] as { id?: unknown; content?: unknown; created_at?: unknown; kind?: unknown; tags?: unknown; pubkey?: unknown; sig?: unknown };
  expect(body.id).toMatch(/^[0-9a-f]{64}$/);
  expect(body.content).toBe(content);
  expect(Number.isInteger(body.created_at)).toBe(true);
  expect(Math.abs((body.created_at as number) - Date.now() / 1000)).toBeLessThan(60);
  expect(body.kind, "the same kind the REQ asks for").toBe((filter.kinds as unknown[])[0]);
  expect(body.tags).toEqual([["x", topic]]);
  expect(body.pubkey).toMatch(/^[0-9a-f]{64}$/);
  expect(body.sig).toMatch(/^[0-9a-f]{128}$/);
  // A relay delivers it as ["EVENT", subId, ev]: the sealed payload opens.
  expect(await NetRendezvous.open("ABCDEF", b64ToBytes(body.content as string), "offer")).toBe("OFFER");

  expect(ours, "we frame our sealed payload with it").toMatch(/mod\.createEvent\(mineTopic,/);
  expect(ours, "and subscribe to the other slot's topic").toMatch(/mod\.subscribe\(subId, theirTopic\)/);
  expect(oursCode, "the full Trystero room is gone; nothing may creep back through the catch").not.toMatch(
    /joinRoom|makeAction|onPeerJoin|getRelaySockets/,
  );
  expect(oursCode, "and so is its opt-in switch").not.toMatch(/nostrTrystero/);
}, SLOW);

test("the direct exchange owns its sockets and reads NIP-01 refusals itself", () => {
  // The legacy branch learned of a refusal only by intercepting console.warn.
  // The direct path opens the WebSockets, so it sees ["OK", id, false, why]
  // and ["CLOSED", subId, why] first-hand — and must never touch console.
  expect(ours).toMatch(/new WebSocket\(url\)/);
  expect(ours, "an OK=false on OUR event id is a refusal").toMatch(
    /m\[0\] === "OK" && typeof m\[1\] === "string" && pubIds\.has\(m\[1\]\) && m\[2\] === false/,
  );
  expect(ours, "a CLOSED for our REQ is a refusal").toMatch(/m\[0\] === "CLOSED" && subId != null && m\[1\] === subId/);
  expect(ours, "surfaced as a typed, advisory outcome").toMatch(/all_rejected/);
  expect(ours, "one fussy relay out of six must not scare a player off").toMatch(/rejectedBy\.size < live\) return/);
  expect(oursCode, "no console.warn interception survives").not.toMatch(/console\.warn\s*=/);
});

test("the installed version is 0.25.4 and carries the relay backoff this bump was for", () => {
  // 0.25.4's nostr adapter retires a relay that refuses terminally, backs off
  // one that rate-limits, and closes a client whose reconnects are exhausted
  // (core utils client.close/isClosed). We do not run its room, but the pin is
  // the version package.json and package-lock.json resolve.
  const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
  expect(pkg.dependencies?.["@trystero-p2p/nostr"], "an exact pin, not a range").toBe("0.25.4");
  const installed = JSON.parse(read("node_modules/@trystero-p2p/nostr/package.json")) as { version: string };
  expect(installed.version).toBe("0.25.4");
  const nostrDist = read("node_modules/@trystero-p2p/nostr/dist/index.mjs");
  expect(nostrDist, "0.25.4 relay retirement").toMatch(/retireRelay/);
  expect(nostrDist, "0.25.4 rate-limit backoff").toMatch(/backoffRelay/);
  expect(read("node_modules/@trystero-p2p/core/dist/utils.mjs"), "0.25.4 exhausted-reconnect close").toMatch(/client\.isClosed = true/);
});

test("Trystero is dynamic-imported, never in the boot path", () => {
  // ~170 KB with its schnorr dependency, for a feature most sessions never
  // touch. It must not be a <script> tag and must not be a static import.
  expect(read("index.html"), "must not be a boot script").not.toMatch(/<script[^>]+trystero/i);
  expect(ours, "reached by dynamic import").toMatch(/import\("@trystero-p2p\/nostr"\)/);
  const statics: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.[cm]?[jt]sx?$/.test(e.name) && /^\s*import\s[^(]*?["']@trystero-p2p\//m.test(fs.readFileSync(full, "utf8")))
        statics.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, "src"));
  expect(statics, "no static import anywhere in src/").toEqual([]);
});

test("a bad relay override is dropped, never handed to WebSocket", () => {
  // `new WebSocket(url)` on a malformed entry throws SyntaxError, which a catch
  // reported as "could not reach the room service", pointing at the network
  // when the fault was one localStorage value. It happened from a copy-pasted
  // debugging line: '["wss://…","wss://…"]' is valid JSON and an invalid URL.
  // Driven through the REAL relayUrls(), not asserted against the source text.
  const withStore = (value: unknown, fn: () => readonly string[]): readonly string[] => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(value) });
    try {
      return fn();
    } finally {
      vi.unstubAllGlobals();
    }
  };

  expect(withStore(["wss://…", "wss://…"], () => NetNostr.relayUrls()), "the ellipsis placeholders that caused this fall back").toEqual(
    NetNostr.RELAYS,
  );
  expect(withStore(["nope", "", null, 42], () => NetNostr.relayUrls()), "junk falls back rather than leaving no relays at all").toEqual(
    NetNostr.RELAYS,
  );
  expect(withStore(["https://nos.lol"], () => NetNostr.relayUrls()), "http is not a socket").toEqual(NetNostr.RELAYS);
  expect(
    withStore(["wss://nos.lol", "wss://…", "wss://nostr.mom"], () => NetNostr.relayUrls()),
    "one bad entry is dropped without poisoning the good ones",
  ).toEqual(["wss://nos.lol", "wss://nostr.mom"]);
  expect(
    withStore(["wss://relay.example", "ws://127.0.0.1:7448"], () => NetNostr.relayUrls()),
    "and a real override still wins — ws:// matters, it is the local fixture",
  ).toEqual(["wss://relay.example", "ws://127.0.0.1:7448"]);
});

test("direct relay frames are rejected before unbounded parsing or decoding", () => {
  const huge = "x".repeat(NetNostr.MAX_FRAME_CHARS + 1);
  const frame = NetNostr.readRelayFrame(huge);
  expect(frame.close).toBe(true);
  expect(frame.message).toBe(null);
  expect(
    NetNostr.readRelayFrame({ toString: () => '["EVENT"]' }).close,
    "Nostr JSON is text; arbitrary objects must not be coerced before measuring",
  ).toBe(true);
  expect(NetNostr.readRelayFrame('["EVENT","s",{"content":"ok"}]').message).toEqual(["EVENT", "s", { content: "ok" }]);
});

const immediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("direct relay dedupe and decrypt work stay hard bounded", async () => {
  const releases: Array<() => void> = [];
  const inbox = NetNostr.createBoundedInbox(() => new Promise<void>((resolve) => releases.push(resolve)));

  for (let i = 0; i < NetNostr.MAX_HEARD_ACTIVE; i++) expect(inbox.accept("msg-" + i)).toBe(true);
  expect(inbox.accept("msg-0"), "a duplicate consumes no second decrypt slot").toBe(true);
  expect(inbox.accept("overflow"), "beyond the concurrency cap the message drops but the relay socket survives").toBe("busy");
  expect(inbox.stats().active).toBe(NetNostr.MAX_HEARD_ACTIVE);
  expect(inbox.accept("x".repeat(NetNostr.MAX_CONTENT_CHARS + 1))).toBe(false);

  await immediate();
  for (const release of releases) release();
  await immediate();
  expect(inbox.stats().active).toBe(0);

  // Let each task settle before admitting the next, exercising the FIFO bound
  // rather than the concurrency rejection above.
  const quick = NetNostr.createBoundedInbox(async () => {});
  for (let i = 0; i < NetNostr.MAX_SEEN + 20; i++) {
    expect(quick.accept("unique-" + i)).toBe(true);
    await immediate();
  }
  expect(quick.stats().seen).toBeLessThanOrEqual(NetNostr.MAX_SEEN);
  expect(quick.stats().seenChars).toBeLessThanOrEqual(NetNostr.MAX_SEEN_CHARS);
  expect(quick.stats().active).toBe(0);

  for (let i = 0; i < 4; i++) {
    expect(quick.accept(String(i) + "z".repeat(NetNostr.MAX_CONTENT_CHARS - 1))).toBe(true);
    await immediate();
  }
  expect(quick.stats().seenChars, "a handful of individually legal near-limit frames must not multiply retention").toBeLessThanOrEqual(
    NetNostr.MAX_SEEN_CHARS,
  );
});

test("finish() reclaims every timer the exchange armed, the reply re-publish included", () => {
  // nostr.ts promises that finish() leaves nothing scheduled (an orphaned timer
  // retains the whole closure). The reply's re-publish interval was a local in
  // heard() that finish() could not see; the invariant is the file's, so it is
  // pinned here.
  const at = oursCode.indexOf("const finish = (r");
  expect(at, "finish() is where this test looks").toBeGreaterThanOrEqual(0);
  const fin = oursCode.slice(at);
  const body = fin.slice(0, fin.indexOf("};"));
  for (const t of ["tick", "repost", "again"]) expect(body, `finish() does not clear ${t}`).toMatch(new RegExp(`clearInterval\\(${t}\\)`));
  expect(oursCode, "`again` must live where finish() can reach it").not.toMatch(/const again = setInterval/);
});
