/**
 * The room-code client (src/net/rendezvous.ts), against a REAL relay.
 *
 * Ported from f1-game tests/unit/net-rendezvous.test.mjs (every test):
 *   :42-60     a late success after cancellation never publishes a payload
 *   :65-115    relay(): a throwaway node HTTP server with worker/rendezvous.js's contract
 *   :121-170   the code itself (alphabet, rejection sampling, uniqueness, normalise)
 *   :176-386   against the relay (meet, owner retry, v1/plaintext refused, swap both
 *              ways, replier order, failed reply, waitFor resolve/cancel, not_found,
 *              taken, dead, captive portal, unreachable, nothing configured)
 *   :392-504   the envelope (round trip, wrong code, fresh IV, slot AAD, v2-only
 *              private envelope, one PBKDF2 per code, waitFor transient 429s)
 *   :507-579   the PBKDF2-stretched Nostr topic and the verification code
 *   :582-666   private-token secrecy, fail-closed randomness, old-Worker upgrade,
 *              QR session URL and persistent URL policy
 *   :669-727   POLL_TIMEOUT_MS, expired copy, host poll window (bug-hunt 8.4)
 *
 * And the CLIENT half of f1-game tests/unit/rendezvous-worker.test.mjs (:20-35,
 * :53-67, :130-136, :138-156, :185-204), against a fake fetch: the route, body,
 * owner capability and status/header handling the deployed Worker (protocol 3)
 * relies on. Its Worker internals (Durable Object storage, body byte caps, the
 * rate-bucket LRU, idFromName) are not ported: apex-26 ships no Worker, it uses
 * f1-game's deployed one.
 *
 * Differences from f1-game: ES imports instead of an eval'd IIFE; localStorage is
 * a vi.stubGlobal in-memory Storage (key `a26.rendezvous`); fetch/crypto swaps are
 * vi.stubGlobal / vi.spyOn; f1-game's `Date.now = ...` skew is a vi.spyOn on
 * Date.now (real timers stay real: PBKDF2 and the HTTP server need them). Where
 * f1-game calls seal/open with no slot (AAD = String(undefined || "") = ""), this
 * passes "" explicitly. The "operator" context of :596-602 is the same module
 * keyed by the route instead of a second VM: keyFor() memoises by normalised code,
 * so it is the same computation an independent copy would make.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as NetRendezvous from "../../src/net/rendezvous";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SLOW = 20000; // real timers: PBKDF2 (120 000 rounds) plus 1.2 s polls

class MemoryStorage {
  private readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  NetRendezvous.setSessionUrl(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  NetRendezvous.setSessionUrl(undefined);
});

/** A code that is known non-null (makeCode only returns null without WebCrypto). */
const code = (): string => {
  const c = NetRendezvous.makeCode();
  if (c == null) throw new Error("makeCode returned null");
  return c;
};

const okField = <T extends { ok: boolean }>(r: T): T => r;

test("a successful response arriving after cancellation never publishes a payload", async () => {
  NetRendezvous.setUrl("http://127.0.0.1:9");
  let resolve: ((r: Response) => void) | null = null;
  let started: () => void = () => {};
  const entered = new Promise<void>((r) => {
    started = r;
  });
  vi.stubGlobal("fetch", () => {
    started();
    return new Promise<Response>((r) => {
      resolve = r;
    });
  });
  const token = { cancelled: false };
  const waiting = NetRendezvous.waitFor(code(), "offer", token);
  await entered;
  token.cancelled = true;
  (resolve as ((r: Response) => void) | null)?.(new Response(JSON.stringify({ payload: "stale-offer" }), { status: 200 }));
  const result = await waiting;
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error).toBe("cancelled");
  expect((result as { payload?: unknown }).payload).toBe(undefined);
}, SLOW);

// ---------------------------------------------------------------------------
// A stand-in for worker/rendezvous.js, same contract (f1-game :65-115).
// ---------------------------------------------------------------------------
interface Rec {
  payload: string;
  owner: string | null;
}
interface Room {
  offer?: Rec;
  answer?: Rec;
}
interface Seen {
  path: string | undefined;
  body?: { payload?: unknown; owner?: unknown };
}
interface RelayOpts {
  dead?: boolean;
  hang?: boolean;
  flakyGets?: number;
}
interface Relay {
  url: string;
  rooms: Map<string, Room>;
  requests: Seen[];
  close: () => Promise<void>;
}

function relay(opts: RelayOpts = {}): Promise<Relay> {
  const rooms = new Map<string, Room>(); // opaque room id -> {offer, answer}
  const requests: Seen[] = [];
  const server = http.createServer((req, res) => {
    const seen: Seen = { path: req.url };
    requests.push(seen);
    const send = (status: number, obj: unknown): void => {
      res.writeHead(status, { "content-type": "application/json", "x-apex-rendezvous": "3" });
      res.end(obj == null ? "" : JSON.stringify(obj));
    };
    if (opts.dead) return send(500, { error: "boom" });
    if (opts.hang) return; // never responds — the timeout path

    const m = (req.url || "").match(/^\/v3\/r\/([0-9a-f]{64})\/(offer|answer)$/);
    if (!m) return send(404, { error: "not_found" });
    const id = m[1] as string;
    const slot = m[2] as "offer" | "answer";
    const room: Room = rooms.get(id) || {};

    if (req.method === "GET") {
      // flakyGets: answer the first N polls with a 429 — the transient hiccup
      // waitFor() must ride out rather than abort the poll wait on.
      if (opts.flakyGets !== undefined && opts.flakyGets > 0) {
        opts.flakyGets--;
        return send(429, { error: "rate_limited" });
      }
      const rec = room[slot];
      if (!rec) return send(404, { error: "not_found" });
      return send(200, { payload: rec.payload });
    }
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { payload?: unknown; owner?: unknown };
      seen.body = parsed;
      const payload = parsed.payload;
      const owner = typeof parsed.owner === "string" && parsed.owner ? parsed.owner : null;
      // v2 envelopes only, like worker/rendezvous.js: the operator never holds
      // a plaintext SDP, and a retry is recognised by the owner capability.
      if (typeof payload !== "string" || !payload.startsWith("v2.")) return send(400, { error: "bad_payload" });
      if (slot === "offer" && room.offer) {
        const sameOwner = owner && room.offer.owner && owner === room.offer.owner;
        if (!sameOwner) return send(409, { error: "taken" });
      }
      room[slot] = { payload, owner };
      rooms.set(id, room);
      send(200, { ok: true });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      NetRendezvous.setUrl(url);
      resolve({ url, rooms, requests, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

const payloadOf = (r: NetRendezvous.GetResult): string | undefined => (r.ok ? r.body.payload : undefined);
const errorOf = (r: { ok: boolean; error?: string }): string | undefined => (r.ok ? undefined : r.error);
const offerRec = async (r: Relay, c: string): Promise<Rec> => {
  const rec = r.rooms.get(await NetRendezvous.privateRoomId(c))?.offer;
  if (!rec) throw new Error("no offer stored");
  return rec;
};

// ---------------------------------------------------------------------------
// The code itself
// ---------------------------------------------------------------------------

test("codes avoid the characters people mishear", () => {
  NetRendezvous.setUrl(null);
  // The entire point is that six characters survive being read aloud. 0/O and
  // 1/I/L are where that breaks, so they are not in the alphabet at all.
  for (const bad of ["0", "O", "1", "I", "L"]) {
    expect(NetRendezvous.ALPHABET.includes(bad), `${bad} should not be usable`).toBe(false);
  }
  for (let i = 0; i < 200; i++) {
    const c = code();
    expect(c.length).toBe(NetRendezvous.CODE_LEN);
    expect(NetRendezvous.valid(c), `${c} should be valid`).toBe(true);
  }
});

test("codes are drawn without modulo bias", () => {
  // 256 % 31 = 8, so `byte % 31` made the first eight letters 9/8 as likely
  // as the rest. Rejection sampling redraws any byte at or above 248: feed
  // the generator exactly those bytes first and they must never become a
  // letter, while the in-range bytes that follow map straight through.
  const feed = [255, 254, 250, 248, 0, 31, 62, 247, 1, 2, 3]; // 4 rejects, then 7 draws
  let cursor = 0;
  vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    const a = arr as unknown as Uint8Array;
    for (let i = 0; i < a.length; i++) a[i] = feed[cursor++ % feed.length] as number;
    return arr;
  });
  const c = code();
  const A = NetRendezvous.ALPHABET;
  expect(c, "rejected bytes vanish, the rest map in order").toBe(
    (A[0] as string) + A[0] + A[0] + A[247 % 31] + A[1] + A[2],
  );
});

test("codes are not sequential or repeated", () => {
  // A predictable code is one somebody else can already be sitting on.
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(code());
  expect(seen.size, `expected near-unique codes, got ${seen.size}/500`).toBeGreaterThan(495);
});

test("typing is forgiving about case and spacing, strict about the rest", () => {
  const c = code();
  expect(NetRendezvous.normalise(c.toLowerCase())).toBe(c);
  expect(NetRendezvous.normalise(` ${c.slice(0, 3)}-${c.slice(3)} `)).toBe(c);
  // But a genuinely wrong code stays wrong rather than being coerced into a
  // DIFFERENT valid room, which would silently connect two strangers.
  expect(NetRendezvous.valid("ABC")).toBe(false);
  expect(NetRendezvous.valid("ABCDEFGH")).toBe(false);
  expect(NetRendezvous.valid("")).toBe(false);
});

// ---------------------------------------------------------------------------
// Against the relay
// ---------------------------------------------------------------------------

test("the two halves meet at the same code", async () => {
  const r = await relay();
  try {
    const c = code();
    expect((await NetRendezvous.put(c, "offer", "APEX1.s.OFFER")).ok).toBe(true);
    const stored = await offerRec(r, c);
    expect(stored.payload, "private relay must store a versioned ciphertext envelope").toMatch(/^v2\./);
    expect(stored.payload.includes("APEX1.s.OFFER"), "SDP code must not be visible to the relay").toBe(false);
    expect(stored.owner, "offer carries a stable ownership capability").toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    const got = await NetRendezvous.get(c, "offer");
    expect(got.ok).toBe(true);
    expect(payloadOf(got)).toBe("APEX1.s.OFFER");

    expect((await NetRendezvous.put(c, "answer", "APEX1.s.ANSWER")).ok).toBe(true);
    const back = await NetRendezvous.get(c, "answer");
    expect(payloadOf(back)).toBe("APEX1.s.ANSWER");
  } finally {
    await r.close();
  }
}, SLOW);

test("an encrypted offer retry changes ciphertext but keeps ownership", async () => {
  const r = await relay();
  try {
    const c = code();
    expect((await NetRendezvous.put(c, "offer", "SAME-OFFER")).ok).toBe(true);
    const first = { ...(await offerRec(r, c)) };
    expect((await NetRendezvous.put(c, "offer", "SAME-OFFER")).ok).toBe(true);
    const second = await offerRec(r, c);
    expect(second.owner, "a retry must prove it is the same host").toBe(first.owner);
    expect(second.payload, "AES-GCM must still use a fresh IV").not.toBe(first.payload);
    expect(payloadOf(await NetRendezvous.get(c, "offer"))).toBe("SAME-OFFER");
  } finally {
    await r.close();
  }
}, SLOW);

test("a plaintext (or v1) mailbox record from the relay is refused, never used as an SDP", async () => {
  // The legacy branch let the Worker operator hand back any string as the
  // payload. Gone: a record that is not a v2 envelope reads as corrupt and the
  // lobby falls back to the invite link.
  const r = await relay();
  try {
    const c = code();
    r.rooms.set(await NetRendezvous.privateRoomId(c), { offer: { payload: "LEGACY-OFFER", owner: null } });
    const got = await NetRendezvous.get(c, "offer");
    expect(got.ok).toBe(false);
    expect(errorOf(got)).toBe("corrupt");
    r.rooms.set(await NetRendezvous.privateRoomId(c), {
      offer: { payload: "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", owner: null },
    });
    expect(errorOf(await NetRendezvous.get(c, "offer"))).toBe("corrupt");
  } finally {
    await r.close();
  }
}, SLOW);

test("the private-relay backend still trades both ways", async () => {
  // swap() is what the lobby calls. With a private relay it is a post then a
  // poll; with the public relay network it is a live room. Same shape either
  // way, which is the point of the seam.
  const r = await relay();
  try {
    const c = code();
    setTimeout(() => void NetRendezvous.put(c, "answer", "THEIR-ANSWER"), 250);
    const out = await NetRendezvous.swap({ code: c, mine: "MY-OFFER", slot: "offer", want: "answer", token: { cancelled: false } });
    expect(out.ok).toBe(true);
    expect(out.ok && out.payload).toBe("THEIR-ANSWER");
    // ...and our own half really was left for them.
    expect(payloadOf(await NetRendezvous.get(c, "offer"))).toBe("MY-OFFER");
    const firstOwner = (await offerRec(r, c)).owner;
    const retry = await NetRendezvous.swap({ code: c, mine: "MY-OFFER", slot: "offer", want: "answer", token: { cancelled: false } });
    expect(retry.ok, "the lobby's production swap path can retry its randomized envelope").toBe(true);
    expect((await offerRec(r, c)).owner, "a repeated host attempt must keep the original ownership capability").toBe(firstOwner);
  } finally {
    await r.close();
  }
}, SLOW);

test("a replier waits first, then posts what it produced", async () => {
  // The guest cannot answer until it has seen the invite. Getting this backwards
  // is exactly the bug the first version shipped.
  const r = await relay();
  try {
    const c = code();
    await NetRendezvous.put(c, "offer", "THE-INVITE");
    let saw: string | null = null;
    const out = await NetRendezvous.swap({
      code: c,
      slot: "answer",
      want: "offer",
      token: { cancelled: false },
      reply: async (got) => {
        saw = got;
        return "ANSWER-TO-" + got;
      },
    });
    expect(out.ok).toBe(true);
    expect(saw, "the reply must receive what the host posted").toBe("THE-INVITE");
    expect(out.ok && out.payload).toBe("THE-INVITE");
    expect(payloadOf(await NetRendezvous.get(c, "answer"))).toBe("ANSWER-TO-THE-INVITE");
  } finally {
    await r.close();
  }
}, SLOW);

test("a reply that fails reports it rather than posting nothing", async () => {
  const r = await relay();
  try {
    const c = code();
    await NetRendezvous.put(c, "offer", "THE-INVITE");
    const out = await NetRendezvous.swap({
      code: c,
      slot: "answer",
      want: "offer",
      token: { cancelled: false },
      reply: async () => null,
    });
    expect(out.ok).toBe(false);
    expect(errorOf(out)).toBe("reply_failed");
  } finally {
    await r.close();
  }
}, SLOW);

test("waitFor resolves as soon as the other side posts", async () => {
  const r = await relay();
  try {
    const c = code();
    const token = { cancelled: false };
    const pending = NetRendezvous.waitFor(c, "answer", token);
    setTimeout(() => void NetRendezvous.put(c, "answer", "LATE-ARRIVAL"), 300);
    const got = await pending;
    expect(got.ok).toBe(true);
    expect(got.ok && got.payload).toBe("LATE-ARRIVAL");
  } finally {
    await r.close();
  }
}, SLOW);

test("waitFor stops when it is cancelled, and does not resolve later", async () => {
  // A poll that outlives the screen that started it keeps hitting a server
  // nobody is looking at.
  const r = await relay();
  try {
    const c = code();
    const token = { cancelled: false };
    const pending = NetRendezvous.waitFor(c, "answer", token);
    setTimeout(() => {
      token.cancelled = true;
    }, 200);
    const got = await pending;
    expect(got.ok).toBe(false);
    expect(errorOf(got)).toBe("cancelled");
  } finally {
    await r.close();
  }
}, SLOW);

test("an empty code reports nobody there, not an error", async () => {
  const r = await relay();
  try {
    const res = await NetRendezvous.get(code(), "offer");
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe("not_found");
    expect(!res.ok && res.message).toMatch(/nobody/i);
  } finally {
    await r.close();
  }
}, SLOW);

test("a second host on a live code is refused rather than stealing the guest", async () => {
  const r = await relay();
  try {
    const c = code();
    await NetRendezvous.put(c, "offer", "FIRST-HOST");
    const clash = await NetRendezvous.put(c, "offer", "SECOND-HOST");
    expect(clash.ok).toBe(false);
    expect(errorOf(clash)).toBe("taken");
    // The first host's guest still finds the right room.
    expect(payloadOf(await NetRendezvous.get(c, "offer"))).toBe("FIRST-HOST");
  } finally {
    await r.close();
  }
}, SLOW);

test("a dead relay is reported, never thrown", async () => {
  // This is the failure that matters: the one service in the game is down and
  // the lobby has to say so and fall back, not throw inside a click handler.
  const r = await relay({ dead: true });
  try {
    const res = await NetRendezvous.get(code(), "offer");
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe("relay");
    expect(!res.ok && res.message, "should point at the path that still works").toMatch(/invite link/i);
  } finally {
    await r.close();
  }
}, SLOW);

test("a captive portal answering 200 with HTML is 'relay', not 'offline'", async () => {
  // A hotel network intercepts the request and returns its login page with a
  // 200. That is not the service being unreachable — "offline" spent the
  // poll's transient retries on it — it is this network intercepting traffic.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>Welcome to the hotel Wi-Fi</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  NetRendezvous.setUrl("http://127.0.0.1:" + (server.address() as AddressInfo).port);
  try {
    const res = await NetRendezvous.get(code(), "offer");
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe("relay");
    expect(!res.ok && res.message).toMatch(/intercepting/i);
    expect(!res.ok && res.message, "should point at the path that still works").toMatch(/invite link/i);
  } finally {
    NetRendezvous.setUrl(null);
    await new Promise<void>((r) => server.close(() => r()));
  }
}, SLOW);

test("an unreachable relay is reported, never thrown", async () => {
  const r = await relay();
  await r.close(); // nothing is listening now
  const res = await NetRendezvous.get(code(), "offer");
  expect(res.ok).toBe(false);
  expect(errorOf(res)).toBe("offline");
}, SLOW);

test("room codes are available with nothing configured at all", () => {
  // The point of the public-broker backend: no deploy, no URL, no terminal.
  // configured() is unconditionally true because the fallback always exists;
  // usingPrivateRelay() is the one that says WHICH backend will be used.
  NetRendezvous.setUrl(null);
  expect(NetRendezvous.configured()).toBe(true);
  expect(NetRendezvous.usingPrivateRelay()).toBe(false);
  NetRendezvous.setUrl("https://example.invalid");
  expect(NetRendezvous.usingPrivateRelay(), "a set URL takes precedence").toBe(true);
  NetRendezvous.setUrl(null);
});

// ---------------------------------------------------------------------------
// The encryption that makes a PUBLIC broker safe to meet on
// ---------------------------------------------------------------------------

test("the payload round-trips under the room code", async () => {
  const c = code();
  const secret = "APEX1.s." + "aB3-_x9Zq".repeat(20);
  const sealed = await NetRendezvous.seal(c, secret, "");
  expect(sealed.length, "should carry an IV and a tag").toBeGreaterThan(secret.length);
  expect(await NetRendezvous.open(c, sealed, "")).toBe(secret);
}, SLOW);

test("a wrong code cannot read the payload", async () => {
  // This is the whole security claim: the broker is public, anyone may
  // subscribe, and the code is the only secret. If a near-miss decrypted, the
  // room code would be decoration.
  const a = code();
  let b = code();
  while (b === a) b = code();
  const sealed = await NetRendezvous.seal(a, "APEX1.s.SECRET", "");
  expect(await NetRendezvous.open(b, sealed, "")).toBe(null);
  // Ciphertext tampering fails the GCM tag rather than yielding a mangled SDP.
  const tampered = sealed.slice();
  const last = tampered.length - 1;
  tampered[last] = (tampered[last] as number) ^ 0xff;
  expect(await NetRendezvous.open(a, tampered, "")).toBe(null);
}, SLOW);

test("two seals of the same text differ", async () => {
  // A fresh IV each time. Identical ciphertext on a public broker would leak
  // that two people are exchanging the same invite.
  const c = code();
  const one = await NetRendezvous.seal(c, "same", "");
  const two = await NetRendezvous.seal(c, "same", "");
  expect([...one]).not.toEqual([...two]);
}, SLOW);

test("the envelope is bound to its slot: an offer cannot be replayed as an answer", async () => {
  // v2 carries the slot name as AES-GCM additional data. A relay operator (or
  // anyone who can answer for one) holding a sealed offer must not be able to
  // hand it back through the answer slot and have the host accept it.
  const c = code();
  const sealed = await NetRendezvous.seal(c, "APEX1.s.OFFER", "offer");
  expect(await NetRendezvous.open(c, sealed, "offer")).toBe("APEX1.s.OFFER");
  expect(await NetRendezvous.open(c, sealed, "answer"), "wrong slot fails the tag").toBe(null);
  expect(await NetRendezvous.open(c, sealed, ""), "and so does no slot at all").toBe(null);
  // Fresh salt AND fresh IV per envelope, so the first 28 bytes never repeat.
  const again = await NetRendezvous.seal(c, "APEX1.s.OFFER", "offer");
  expect([...sealed.slice(0, 16)], "random salt").not.toEqual([...again.slice(0, 16)]);
  expect([...sealed.slice(16, 28)], "random iv").not.toEqual([...again.slice(16, 28)]);
  // Too short to hold salt + iv + tag is refused without touching WebCrypto.
  expect(await NetRendezvous.open(c, sealed.slice(0, 40), "offer")).toBe(null);
}, SLOW);

test("the private-relay envelope is v2 only — plaintext from the Worker is refused", async () => {
  // The old openPrivate() returned an unversioned string AS the payload, so a
  // relay operator could substitute any SDP. Both peers run the same build
  // (the handshake's build check refuses anything else), so nobody legitimate
  // can still be sending v1 or plaintext.
  const c = code();
  const env = await NetRendezvous.sealPrivate(c, "offer", "APEX1.s.X");
  expect(env, "versioned, url-safe base64").toMatch(/^v2\.[A-Za-z0-9_-]+$/);
  expect(await NetRendezvous.openPrivate(c, "offer", env)).toBe("APEX1.s.X");
  expect(await NetRendezvous.openPrivate(c, "answer", env), "slot-bound here too").toBe(null);
  expect(await NetRendezvous.openPrivate(c, "offer", "APEX1.s.PLAINTEXT")).toBe(null);
  expect(await NetRendezvous.openPrivate(c, "offer", "v1." + env.slice(3))).toBe(null);
  expect(await NetRendezvous.openPrivate(c, "offer", "v2.")).toBe(null);
  expect(await NetRendezvous.openPrivate(c, "offer", null)).toBe(null);
}, SLOW);

/** Count PBKDF2 derivations while passing every call through to WebCrypto. */
function countPbkdf2(): { readonly n: () => number } {
  const orig = crypto.subtle.deriveBits.bind(crypto.subtle);
  let derives = 0;
  vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(
    (algorithm: AlgorithmIdentifier | EcdhKeyDeriveParams | HkdfParams | Pbkdf2Params, baseKey: CryptoKey, length?: number | null) => {
      if (typeof algorithm === "object" && algorithm.name === "PBKDF2") derives++;
      return orig(algorithm, baseKey, length);
    },
  );
  return { n: () => derives };
}

// ── round 8: the key derives once per code ───────────────────────────────────
test("repeated seals and opens of one code run PBKDF2 exactly once", async () => {
  // 120 000 rounds per derivation, and the callers are hot (repost every 5 s,
  // one per relay onopen, one per inbound frame). The memo keys on the
  // normalised code; the wrong-code test above already proves a DIFFERENT
  // code cannot be served the cached key.
  // The per-envelope HKDF step is a deriveKey too, so count the PBKDF2 —
  // which is now a deriveBits into the memoised HKDF base.
  const derives = countPbkdf2();
  const c = "APEX1.z.MEMOCODE";
  const s1 = await NetRendezvous.seal(c, "one", "");
  const s2 = await NetRendezvous.seal(c, "two", "");
  expect(await NetRendezvous.open(c, s1, "")).toBe("one");
  expect(await NetRendezvous.open(c, s2, "")).toBe("two");
  expect(derives.n(), `PBKDF2 ran ${derives.n()}× for one code`).toBe(1);
  await NetRendezvous.seal("APEX1.z.OTHERCODE", "x", "");
  expect(derives.n(), "a new code derives a new key").toBe(2);
}, SLOW);

test("waitFor() rides out a transient 429 instead of aborting the wait", async () => {
  const r = await relay({ flakyGets: 2 });
  try {
    const c = code();
    expect((await NetRendezvous.put(c, "answer", "APEX1.s.ANSWER")).ok).toBe(true);
    const got = await NetRendezvous.waitFor(c, "answer");
    expect(got.ok, "two rate-limited polls then the payload: " + JSON.stringify(got)).toBe(true);
    expect(got.ok && got.payload).toBe("APEX1.s.ANSWER");
  } finally {
    await r.close();
  }
}, SLOW);

test("waitFor() still gives up on a relay that is refusing every poll", async () => {
  const r = await relay({ flakyGets: 99 });
  try {
    const c = code();
    const got = await NetRendezvous.waitFor(c, "answer");
    expect(got.ok).toBe(false);
    expect(errorOf(got), "the last transient error is what comes back after the streak cap").toBe("rate_limited");
  } finally {
    await r.close();
  }
}, SLOW);

const hex = (bits: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");

// ── the public Nostr topic is derived from the STRETCHED key ─────────────────
test("the Nostr topic costs a PBKDF2 per guessed code, and the verification code is the MITM check", async () => {
  // The `x` tag is plaintext on public relays. A topic that is a cheap hash of
  // the code turns ~30 bits of code into a minutes-long brute force; this
  // proves each topic is HKDF over the 120 000-round PBKDF2 output. The salt
  // below is a CONSTANT, so that cost is paid once for the whole code space
  // (a precomputable table), not once per room — which is why the pairing is
  // authenticated by the verification code asserted at the end, not by the
  // stretch.
  const c = code();
  const offer = await NetRendezvous.topic(c, "offer");
  const answer = await NetRendezvous.topic(c, "answer");
  expect(offer, "80-bit hex topic").toMatch(/^[0-9a-f]{20}$/);
  expect(offer, "offers and answers meet on separate topics").not.toBe(answer);
  expect(await NetRendezvous.topic(c.toLowerCase(), "offer"), "deterministic over the normalised code").toBe(offer);

  // The old derivation must be gone.
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("room|" + c + "|offer")));
  const oldTopic = hex(sha.slice(0, 10));
  expect(offer, "no longer SHA-256(room|code|slot)").not.toBe(oldTopic);

  // Recompute independently: PBKDF2(code) -> HKDF(info=v<PROTOCOL>/topic|slot).
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(c), "PBKDF2", false, ["deriveBits"]);
  const stretched = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode("apex26-rendezvous-v2"), iterations: 120000, hash: "SHA-256" },
    base,
    256,
  );
  const hk = await crypto.subtle.importKey("raw", stretched, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("apex26-rendezvous-v" + NetRendezvous.PROTOCOL + "/topic|offer"),
    },
    hk,
    80,
  );
  expect(offer, "topic = HKDF over the PBKDF2-stretched key").toBe(hex(bits));
  expect(NetRendezvous.PROTOCOL, "protocol bumped with the topic change").toBeGreaterThanOrEqual(3);

  // And a fresh code's topic runs PBKDF2 (the cost an attacker pays per guess).
  const derives = countPbkdf2();
  let other = code();
  while (other === c) other = code();
  await NetRendezvous.topic(other, "offer");
  expect(derives.n(), "one PBKDF2 per new code").toBe(1);
  vi.restoreAllMocks();

  // THE VERIFICATION STEP. Same pair of DTLS fingerprints on both screens ->
  // same 4 letters (order-free, colon/case-free); a middleman's certificate on
  // either leg -> a different code, which the host sees and REMOVEs.
  const host = "AB:".repeat(31) + "01";
  const guest = "cd".repeat(31) + "02";
  const mitm = "EF:".repeat(31) + "03";
  const onHost = await NetRendezvous.verifyCode(host, guest);
  const onGuest = await NetRendezvous.verifyCode(guest.toUpperCase(), host.replace(/:/g, "").toLowerCase());
  expect(NetRendezvous.VERIFY_LEN).toBe(4);
  expect(onHost, "4 letters, room-code alphabet").toMatch(new RegExp("^[" + NetRendezvous.ALPHABET + "]{4}$"));
  expect(onGuest, "both screens show the same code").toBe(onHost);
  expect(await NetRendezvous.verifyCode(host, mitm), "a middleman's leg reads differently").not.toBe(onHost);
  expect(await NetRendezvous.verifyCode(host, null), "no fingerprint, no code").toBe(null);
  expect(onHost, "independent of the room code").not.toBe(c.slice(0, 4));
}, SLOW);

test("verifyFor reads both fingerprints off a connected peer connection and never rejects", async () => {
  type Pc = Parameters<typeof NetRendezvous.verifyFor>[0];
  const sdp = (fp: string): string => "v=0\r\na=ice-ufrag:abcd\r\na=fingerprint:sha-256 " + fp + "\r\n";
  const fpA = Array.from({ length: 32 }, (_, i) => ((i * 7) & 255).toString(16).padStart(2, "0").toUpperCase()).join(":");
  const fpB = Array.from({ length: 32 }, (_, i) => ((i * 13) & 255).toString(16).padStart(2, "0").toUpperCase()).join(":");
  const host = { localDescription: { sdp: sdp(fpA) }, remoteDescription: { sdp: sdp(fpB) } } as unknown as Pc;
  const guest = { localDescription: { sdp: sdp(fpB) }, remoteDescription: { sdp: sdp(fpA) } } as unknown as Pc;
  const v = await NetRendezvous.verifyFor(host);
  expect(v).toMatch(/^[A-Z2-9]{4}$/);
  expect(await NetRendezvous.verifyFor(guest), "host and guest agree").toBe(v);
  expect(await NetRendezvous.verifyCode(fpA, fpB)).toBe(v);
  expect(await NetRendezvous.verifyFor(undefined), "a loopback transport has no pc").toBe(null);
  expect(await NetRendezvous.verifyFor({ localDescription: null } as unknown as Pc)).toBe(null);
});

test("private room traffic never reveals the high-entropy token or a usable encryption key", async () => {
  const r = await relay();
  try {
    const c = code();
    expect(c.length).toBe(32);
    expect(c.length * Math.log2(NetRendezvous.ALPHABET.length)).toBeGreaterThan(158);
    expect(NetRendezvous.valid(c)).toBe(true);
    expect(NetRendezvous.valid("ABC234"), "old private codes are rejected").toBe(false);
    expect((await NetRendezvous.put(c, "offer", "PRIVATE-SDP")).ok).toBe(true);
    const captured = r.requests[0];
    if (!captured) throw new Error("no request captured");
    expect(captured.path).toMatch(/^\/v3\/r\/[0-9a-f]{64}\/offer$/);
    expect(JSON.stringify(r.requests).includes(c), "neither path nor body carries the token").toBe(false);
    // An operator receives ONLY what the relay sees. The old /r/<code> let it
    // decrypt and sign replacements with these same APIs.
    const route = (captured.path as string).split("/")[3] as string;
    expect(await NetRendezvous.openPrivate(route, "offer", captured.body?.payload)).toBe(null);
    const forged = await NetRendezvous.sealPrivate(route, "offer", "OPERATOR-SDP");
    const rec = r.rooms.get(route)?.offer;
    if (!rec) throw new Error("no offer stored");
    rec.payload = forged;
    expect(errorOf(await NetRendezvous.get(c, "offer"))).toBe("corrupt");
    expect(errorOf(await NetRendezvous.put("ABC234", "offer", "OLD"))).toBe("bad_code");
    expect(errorOf(await NetRendezvous.get("ABC234", "offer"))).toBe("bad_code");
    expect(r.requests.length, "legacy private calls never reach HTTP").toBe(2);
  } finally {
    await r.close();
    NetRendezvous.setUrl(null);
  }
}, SLOW);

test("private tokens fail closed without cryptographic randomness", () => {
  vi.stubGlobal("crypto", {});
  vi.stubGlobal("localStorage", { getItem: () => "https://private.test", setItem() {}, removeItem() {} });
  expect(NetRendezvous.makeCode(), "Math.random is never a private-token fallback").toBe(null);
});

test("an old Worker requires an upgrade, never a six-character or plaintext downgrade", async () => {
  NetRendezvous.setUrl("https://old-worker.test");
  const requests: string[] = [];
  try {
    const c = code();
    for (const status of [404, 200, 426]) {
      vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        requests.push(String(url));
        return new Response('{"ok":true}', { status });
      });
      const result = await NetRendezvous.put(c, "offer", "SDP");
      expect(errorOf(result)).toBe("relay_version");
      expect(!result.ok && result.message).toMatch(/Update.*Worker.*invite link/);
    }
    expect(requests.length, "one request per attempt, no legacy retry").toBe(3);
    expect(requests.every((url) => new URL(url).pathname.startsWith("/v3/r/"))).toBe(true);
  } finally {
    NetRendezvous.setUrl(null);
  }
}, SLOW);

test("QR relay configuration is validated and scoped to the controller document", () => {
  NetRendezvous.setUrl("https://saved-worker.test");
  try {
    expect(NetRendezvous.setSessionUrl("https://qr-worker.test/base/")).toBe(true);
    expect(NetRendezvous.baseUrl()).toBe("https://qr-worker.test/base");
    expect(localStorage.getItem(NetRendezvous.STORE_KEY)).toBe("https://saved-worker.test");
    for (const invalid of [
      "http://untrusted.test",
      "javascript:alert(1)",
      "https://user:pw@worker.test",
      "https://worker.test?secret=x",
      "https://worker.test#x",
      "/relative",
    ]) {
      expect(NetRendezvous.setSessionUrl(invalid), invalid).toBe(false);
      expect(NetRendezvous.baseUrl()).toBe("https://qr-worker.test/base");
    }
    expect(NetRendezvous.setSessionUrl("http://127.0.0.1:3456/private")).toBe(true);
    expect(NetRendezvous.setSessionUrl(null)).toBe(true);
    expect(NetRendezvous.usingPrivateRelay(), "public QR can override a saved private preference").toBe(false);
    expect(code().length).toBe(6);
    NetRendezvous.setSessionUrl(undefined);
    expect(NetRendezvous.baseUrl()).toBe("https://saved-worker.test");
  } finally {
    NetRendezvous.setSessionUrl(undefined);
    NetRendezvous.setUrl(null);
  }
});

test("persistent relay configuration uses the same secure URL policy", () => {
  NetRendezvous.setUrl("https://saved-worker.test/base/");
  try {
    expect(NetRendezvous.baseUrl()).toBe("https://saved-worker.test/base");
    for (const invalid of [
      "http://untrusted.test",
      "javascript:alert(1)",
      "https://user:pw@worker.test",
      "https://worker.test?secret=x",
      "https://worker.test#x",
      "/relative",
    ]) {
      expect(NetRendezvous.setUrl(invalid), invalid).toBe(false);
      expect(NetRendezvous.baseUrl(), "invalid input must not replace the saved relay").toBe("https://saved-worker.test/base");
    }
    expect(NetRendezvous.setUrl("http://127.0.0.1:3456/private/")).toBe(true);
    expect(NetRendezvous.baseUrl()).toBe("http://127.0.0.1:3456/private");
  } finally {
    NetRendezvous.setUrl(null);
  }
});

// ── room-code join honesty: fail a missing code in ~8–15 s, not 120 s ────────
test("POLL_TIMEOUT_MS is the ~8–15 s lobby join target, not a two-minute hang", () => {
  expect(NetRendezvous.POLL_TIMEOUT_MS, "enough headroom for a few polls + fetch").toBeGreaterThanOrEqual(8000);
  expect(NetRendezvous.POLL_TIMEOUT_MS, "fake/missing codes must not sit on Looking for…").toBeLessThanOrEqual(15000);
});

/** f1-game's `Date.now = () => realNow() + skew`. */
function skewClock(): { set: (ms: number) => void } {
  const realNow = Date.now.bind(Date);
  let skew = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  return {
    set: (ms) => {
      skew = ms;
    },
  };
}

test("waitFor expired copy is actionable (no false 'couple of minutes' claim)", async () => {
  // Advance wall time past POLL_TIMEOUT without sleeping the full window: each
  // poll still hits a real 404 from the stand-in, but Date.now jumps so the
  // next loop iteration sees expiry.
  const r = await relay();
  try {
    const clock = skewClock();
    const c = code();
    // First poll at t=0 (not_found), then claim we are past the timeout.
    const got = await NetRendezvous.waitFor(c, "offer", undefined, () => {
      clock.set(NetRendezvous.POLL_TIMEOUT_MS + 1);
    });
    expect(got.ok).toBe(false);
    expect(errorOf(got)).toBe("expired");
    const message = got.ok ? "" : got.message;
    expect(message).toMatch(/double-check it/i);
    expect(message).toMatch(/fresh one/i);
    expect(message).not.toMatch(/couple of minutes/i);
    expect(message).not.toMatch(/six characters/i);
  } finally {
    vi.restoreAllMocks();
    await r.close();
  }
}, SLOW);

test("a private-relay HOST keeps polling past the guest's 12 s; guests keep 12 s (bug-hunt 8.4)", async () => {
  expect(NetRendezvous.HOST_POLL_TIMEOUT_MS, "a host is waiting for a friend who must be sent the code").toBeGreaterThanOrEqual(60000);
  expect(fs.readFileSync(path.join(ROOT, "src/net/rendezvous.ts"), "utf8"), "swap's host branch passes the host window").toMatch(
    /waitFor\(code, want, token, onTick, HOST_POLL_TIMEOUT_MS\)/,
  );
  const r = await relay();
  try {
    const clock = skewClock();
    const c = code();
    // Guest (no timeout argument): expired once past POLL_TIMEOUT_MS.
    const guest = await NetRendezvous.waitFor(c, "offer", undefined, () => {
      clock.set(NetRendezvous.POLL_TIMEOUT_MS + 1);
    });
    expect(errorOf(guest)).toBe("expired");
    // Host: the same skew is not an expiry; only HOST_POLL_TIMEOUT_MS is.
    clock.set(0);
    let ticks = 0;
    const host = await NetRendezvous.waitFor(
      c,
      "offer",
      undefined,
      () => {
        ticks++;
        clock.set(ticks === 1 ? NetRendezvous.POLL_TIMEOUT_MS + 1 : NetRendezvous.HOST_POLL_TIMEOUT_MS + 1);
      },
      NetRendezvous.HOST_POLL_TIMEOUT_MS,
    );
    expect(ticks, "the host was still polling after the guest's window").toBeGreaterThanOrEqual(2);
    expect(errorOf(host)).toBe("expired");
  } finally {
    vi.restoreAllMocks();
    await r.close();
  }
}, SLOW);

// ---------------------------------------------------------------------------
// The client half of f1-game tests/unit/rendezvous-worker.test.mjs: what the
// deployed Worker (protocol 3) is sent, and how the client reads its answers.
// ---------------------------------------------------------------------------

interface Captured {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake fetch answering like worker/rendezvous.js's json() helper (x-apex-rendezvous: 3). */
function fakeWorker(answer: (req: Captured) => { status: number; body?: unknown; protocol?: string | null; headers?: Record<string, string> }): Captured[] {
  const seen: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const req: Captured = {
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(req);
    const a = answer(req);
    const headers: Record<string, string> = { "content-type": "application/json", ...(a.headers ?? {}) };
    if (a.protocol !== null) headers["x-apex-rendezvous"] = a.protocol ?? "3";
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status, headers });
  });
  return seen;
}

test("Worker client: POSTs a bounded v2 envelope to /v3/r/<64-hex>/<slot>, owner only on the offer", async () => {
  // rendezvous-worker.test.mjs:20-35, :53-67, :185-198 — the route regex, the
  // v2-only payload, and the optional owner capability the Worker validates.
  NetRendezvous.setUrl("https://relay.test");
  const stored = new Map<string, unknown>();
  const seen = fakeWorker((req) => {
    if (req.method === "POST") {
      stored.set(new URL(req.url).pathname, (req.body as { payload: unknown }).payload);
      return { status: 200, body: { ok: true } };
    }
    const p = stored.get(new URL(req.url).pathname);
    return p === undefined ? { status: 404, body: { error: "not_found" } } : { status: 200, body: { payload: p } };
  });
  try {
    const c = code();
    expect(okField(await NetRendezvous.put(c, "offer", "APEX1.s.OFFER")).ok).toBe(true);
    expect(okField(await NetRendezvous.put(c, "answer", "APEX1.s.ANSWER")).ok).toBe(true);
    const [offer, answer] = seen;
    if (!offer || !answer) throw new Error("expected two requests");
    for (const [req, slot] of [
      [offer, "offer"],
      [answer, "answer"],
    ] as const) {
      expect(req.method).toBe("POST");
      expect(req.headers["content-type"]).toBe("application/json");
      expect(new URL(req.url).pathname).toMatch(new RegExp(`^/v3/r/[0-9a-f]{64}/${slot}$`));
      const body = req.body as { payload: string; owner?: string };
      expect(body.payload).toMatch(/^v2\.[A-Za-z0-9_-]+$/);
      expect(new TextEncoder().encode(body.payload).byteLength, "under the Worker's MAX_SEALED_PAYLOAD").toBeLessThanOrEqual(12288);
    }
    expect((offer.body as { owner?: unknown }).owner, "Worker's owner pattern").toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect("owner" in (answer.body as object), "an owner capability is optional, and the answer sends none").toBe(false);
    expect(new URL(offer.url).pathname.split("/")[3]).toBe(await NetRendezvous.privateRoomId(c));
    expect(payloadOf(await NetRendezvous.get(c, "offer"))).toBe("APEX1.s.OFFER");
    expect(seen[2]?.method).toBe("GET");
  } finally {
    NetRendezvous.setUrl(null);
  }
}, SLOW);

test("Worker client: reads 404+protocol as not_found, and 426 / header-less 404 as an old Worker", async () => {
  // rendezvous-worker.test.mjs:130-136 and :185-204: legacy routes are a 426;
  // a new empty room is a 404 that carries x-apex-rendezvous: 3, which is what
  // tells it apart from an old Worker's 404.
  NetRendezvous.setUrl("https://relay.test");
  try {
    const c = code();
    fakeWorker(() => ({ status: 404, body: { error: "not_found" } }));
    expect(errorOf(await NetRendezvous.get(c, "answer")), "new empty room").toBe("not_found");
    fakeWorker(() => ({ status: 404, body: { error: "not_found" }, protocol: null }));
    expect(errorOf(await NetRendezvous.get(c, "answer")), "an old Worker's 404").toBe("relay_version");
    fakeWorker(() => ({ status: 426, body: { error: "upgrade_required" } }));
    expect(errorOf(await NetRendezvous.put(c, "offer", "SDP")), "upgrade required").toBe("relay_version");
    fakeWorker(() => ({ status: 200, body: { ok: true }, protocol: "2" }));
    expect(errorOf(await NetRendezvous.put(c, "offer", "SDP")), "another protocol's 200").toBe("relay_version");
  } finally {
    NetRendezvous.setUrl(null);
  }
}, SLOW);

test("Worker client: 409 owner clash, 429 rate limit and 413 size cap each read as a typed refusal", async () => {
  // rendezvous-worker.test.mjs:53-67 (409 for a different owner), :138-156 (429
  // with retry-after), :69-128 (413 body caps): never a throw.
  NetRendezvous.setUrl("https://relay.test");
  try {
    const c = code();
    fakeWorker(() => ({ status: 409, body: { error: "taken" } }));
    expect(errorOf(await NetRendezvous.put(c, "offer", "SDP"))).toBe("taken");
    fakeWorker(() => ({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "60" } }));
    expect(errorOf(await NetRendezvous.put(c, "offer", "SDP"))).toBe("rate_limited");
    fakeWorker(() => ({ status: 413, body: { error: "too_big" } }));
    const big = await NetRendezvous.put(c, "offer", "SDP");
    expect(errorOf(big)).toBe("relay");
    expect(!big.ok && big.message).toMatch(/invite link/i);
  } finally {
    NetRendezvous.setUrl(null);
  }
}, SLOW);
