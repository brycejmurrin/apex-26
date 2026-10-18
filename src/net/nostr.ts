/**
 * The room-code rendezvous over PUBLIC NOSTR RELAYS.
 * Port of f1-game js/net/nostr.js:1-537 (NetNostr).
 *
 * SIGNALLING ONLY: it carries the invite/answer STRINGS and the race then runs
 * over our own RTCPeerConnection. Our own WebSockets go straight to the relays,
 * reusing exactly two of Trystero's framing helpers (createEvent/subscribe,
 * from @trystero-p2p/nostr, dynamic import) so the events are well-formed
 * Nostr. Payloads are sealed under the room code (rendezvous.ts seal/open),
 * offers and answers ride SEPARATE topics, and refusals (`["OK", id, false]`,
 * `["CLOSED", subId]`) are read first-hand and reported as `all_rejected`.
 * ROOM CODES ARE BEST-EFFORT; THE INVITE LINK IS NOT.
 *
 * Relay override key renamed `apex26.nostrRelays` → `a26.nostrRelays`.
 */
import { b64ToBytes, bytesToB64 } from "./bytes";
import { netLog } from "./log";
import { open as openSealed, seal, topic as roomTopic, type CancelToken } from "./rendezvous";

/** A guest join of a fake/missing code fails in ~8–15 s (nostr.js:5-12). */
export const JOIN_TIMEOUT_MS = 12000;
export const HOST_TIMEOUT_MS = 120000;
const REPLY_TIMEOUT_MS = 20000; // guest: offer found -> answer published (build + ICE gather)
export const RELAY_CHECK_MS = 6000;
const REPOST_MS = 5000;
const MAX_HANDSHAKE_CHARS = 512 * 1024;
export const MAX_CONTENT_CHARS = Math.ceil((MAX_HANDSHAKE_CHARS + 28) / 3) * 4;
export const MAX_FRAME_CHARS = MAX_CONTENT_CHARS + 8192;
export const MAX_SEEN = 64;
export const MAX_SEEN_CHARS = MAX_CONTENT_CHARS * 2;
export const MAX_HEARD_ACTIVE = 4;
/** A relay replaying an earlier host session's offer must not be answered (nostr.js:22-25). */
const OFFER_CREATED_SLACK_S = 30;

/** The two Trystero helpers this module calls (pinned by tests/unit/net-nostr.test.ts). */
export interface NostrFraming {
  createEvent(topic: string, content: string): Promise<string>;
  subscribe(subId: string, topic: string): string;
}

let modPromise: Promise<NostrFraming> | null = null;
let modOverride: (() => Promise<NostrFraming>) | null = null;

/** Test seam: replace the dynamic import. `null` restores it. */
export function setFramingLoader(loader: (() => Promise<NostrFraming>) | null): void {
  modOverride = loader;
  modPromise = null;
}

/** One import, shared by every caller, and only ever on demand. */
export function load(): Promise<NostrFraming> {
  if (!modPromise) {
    const p: Promise<NostrFraming> = modOverride ? modOverride() : import("@trystero-p2p/nostr");
    modPromise = p.catch((e: unknown) => {
      modPromise = null; // let a later attempt retry
      throw e;
    });
  }
  return modPromise;
}

export const available = (): boolean => typeof WebSocket !== "undefined";

export interface NostrFail {
  readonly ok: false;
  readonly error: string;
  readonly message: string;
  readonly detail?: string;
  readonly advisory?: boolean;
}

export type ExchangeResult = NostrFail | { readonly ok: true; readonly payload: string };

/** What a multi-joiner host gets back at once (`onJoiner` set). */
export interface HostedRoom {
  readonly ok: true;
  readonly subscribed: true;
  readonly startedAt: number;
  readonly deadlineAt: number;
  /** Publish the next invite (or mint one when `next` is null). */
  rotate(next: string | null): Promise<void>;
  stop(): void;
}

function nostrLog<R extends { readonly ok: boolean; readonly error?: string }>(r: R): R {
  if (r.ok) netLog.info("nostr ok");
  else if (r.error === "stopped" || r.error === "cancelled") netLog.info("nostr " + r.error);
  else netLog.warn("nostr fail " + (r.error || "error"));
  return r;
}

/**
 * OUR OWN RELAY LIST, measured by whether a relay accepts an ephemeral event
 * from an UNKNOWN pubkey, never by reputation (nostr.js:76-115; re-measured
 * there 2026-09-27 with tools/net/nostr-probe.mjs).
 */
export const RELAYS: readonly string[] = [
  "wss://relay.primal.net",
  "wss://nostr.mom",
  "wss://relay.snort.social",
  "wss://nostr-pub.wellorder.net",
  "wss://relay.damus.io",
  "wss://nostr.bitcoiner.social",
  "wss://nostr.oxtr.dev",
];
export const STORE_RELAYS = "a26.nostrRelays";

export function validRelay(u: unknown): u is string {
  if (typeof u !== "string" || !u) return false;
  try {
    const p = new URL(u).protocol;
    return p === "ws:" || p === "wss:";
  } catch {
    return false;
  }
}

/** A STORED OVERRIDE MUST NOT BE ABLE TO BRICK THE FEATURE (nostr.js:117-145). */
export function relayUrls(): readonly string[] {
  try {
    const raw = localStorage.getItem(STORE_RELAYS);
    if (raw) {
      const list: unknown = JSON.parse(raw);
      if (Array.isArray(list)) {
        const good = list.filter(validRelay);
        if (good.length) return good;
      }
    }
  } catch {
    /* fall through to the shipped list */
  }
  return RELAYS;
}

/** Parse only bounded text (nostr.js:147-155). */
export function readRelayFrame(data: unknown): { close: boolean; message: unknown } {
  if (typeof data !== "string" || data.length > MAX_FRAME_CHARS) return { close: true, message: null };
  try {
    return { close: false, message: JSON.parse(data) };
  } catch {
    return { close: false, message: null };
  }
}

/**
 * Verdicts: true = handled (new, duplicate, or stale), "busy" = over the
 * decrypt cap (drop, keep the socket), false = poison (close that relay)
 * (nostr.js:157-196).
 */
export function createBoundedInbox(consume: (content: string) => unknown, minCreatedAt?: number | null) {
  const seen = new Set<string>();
  let seenChars = 0;
  let active = 0;
  let failed = 0;
  const remember = (content: string): void => {
    seen.add(content);
    seenChars += content.length;
    while (seen.size > MAX_SEEN || seenChars > MAX_SEEN_CHARS) {
      const oldest = seen.values().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
      seenChars -= oldest.value.length;
    }
  };
  const accept = (content: unknown, createdAt?: unknown): boolean | "busy" => {
    if (typeof content !== "string" || !content || content.length > MAX_CONTENT_CHARS) return false;
    if (minCreatedAt != null && typeof createdAt === "number" && createdAt < minCreatedAt) return true;
    if (seen.has(content)) return true;
    if (active >= MAX_HEARD_ACTIVE) return "busy";
    remember(content);
    active++;
    Promise.resolve()
      .then(() => consume(content))
      .catch((e: unknown) => {
        // First failure per inbox only.
        if (failed++ === 0) netLog.warn("nostr relay message handler failed:", e instanceof Error ? e.message : e);
      })
      .finally(() => {
        active--;
      });
    return true;
  };
  return { accept, stats: () => ({ seen: seen.size, seenChars, active }) };
}

export interface ExchangeOptions {
  readonly code: string;
  /** Host: the invite to publish (or null to mint one). */
  readonly send?: string | null;
  /** Guest: build the answer from the offer. Present means "we are the guest". */
  readonly reply?: (offer: string) => Promise<string | null> | string | null;
  readonly token?: CancelToken;
  readonly onTick?: () => void;
  readonly mintOffer?: (prev: null) => Promise<string | null> | string | null;
  /** Host, multi-joiner: called per answer; the exchange resolves at once with a HostedRoom. */
  readonly onJoiner?: (from: null, answer: string) => unknown;
  /** Failures after the promise settled, and the `all_rejected` advisory. */
  readonly onFail?: (r: NostrFail) => void;
}

/**
 * Meet in a room named by the code and trade one string for another. The host
 * posts and waits; the guest passes `reply`. Never throws (nostr.js:198-505).
 */
export async function exchange(opts: ExchangeOptions): Promise<ExchangeResult | HostedRoom> {
  const { code, send, reply, token, onTick, mintOffer, onJoiner, onFail } = opts;
  netLog.info("nostr start");
  if (!available()) return nostrLog({ ok: false, error: "unsupported", message: "This browser cannot reach the room service." });
  let mod: NostrFraming;
  try {
    mod = await load();
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)) || "unknown";
    return nostrLog({
      ok: false,
      error: "no_module",
      detail: why,
      message: "Could not load the room service (" + why.slice(0, 90) + "). Use the invite link or QR instead.",
    });
  }

  const hosting = !reply;
  // The slot name is also the envelope's AAD, so an offer replayed onto the
  // answer topic fails to open.
  const mineSlot = hosting ? "offer" : "answer";
  const theirSlot = hosting ? "answer" : "offer";
  let mineTopic: string;
  let theirTopic: string;
  try {
    mineTopic = await roomTopic(code, mineSlot);
    theirTopic = await roomTopic(code, theirSlot);
  } catch {
    return nostrLog({ ok: false, error: "crypto", message: "This browser could not protect the room code. Use the invite link instead." });
  }

  const sockets: WebSocket[] = [];
  const socketUrl = new Map<WebSocket, string>();
  let current: string | null = send || null;
  const rejectedBy = new Set<string>();
  // Every event id WE signed (bounded): each publish signs a NEW id.
  const pubIds = new Set<string>();
  let subId: string | null = null;
  let advisedRejected = false;

  return new Promise((resolve) => {
    let done = false;
    let settled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const later = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    };
    let unlisten: (() => void) | null = null;
    let again: ReturnType<typeof setInterval> | null = null;
    let expireTimer: ReturnType<typeof setTimeout> | null = null;
    let answering = false;
    const shut = (): void => {
      for (const w of sockets) {
        try {
          w.close();
        } catch {
          /* already closing */
        }
      }
      sockets.length = 0;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };
    const clearExpire = (): void => {
      if (expireTimer == null) return;
      clearTimeout(expireTimer);
      const i = timers.indexOf(expireTimer);
      if (i >= 0) timers.splice(i, 1);
      expireTimer = null;
    };
    const finish = (r: ExchangeResult): void => {
      if (done) return;
      done = true;
      clearInterval(tick);
      clearInterval(repost);
      if (again) clearInterval(again);
      for (const id of timers) clearTimeout(id);
      timers.length = 0;
      expireTimer = null;
      shut();
      nostrLog(r);
      if (!settled) {
        settled = true;
        resolve(r);
        return;
      }
      if (onFail && !r.ok) {
        try {
          onFail(r);
        } catch {
          /* a caller bug must not re-throw into finish() */
        }
      }
    };

    const publish = async (text: string | null): Promise<void> => {
      if (!text) return;
      let frame: string;
      try {
        const sealed = await seal(code, text, mineSlot);
        frame = await mod.createEvent(mineTopic, bytesToB64(sealed));
        try {
          const parsed: unknown = JSON.parse(frame);
          const ev = Array.isArray(parsed) ? (parsed[1] as { id?: unknown } | undefined) : undefined;
          if (ev && typeof ev.id === "string") {
            pubIds.add(ev.id);
            if (pubIds.size > 64) {
              const first = pubIds.values().next();
              if (!first.done) pubIds.delete(first.value);
            }
          }
        } catch {
          /* non-fatal — OK tracking just won't fire */
        }
      } catch {
        return;
      }
      for (const w of sockets) {
        if (w.readyState === 1) {
          try {
            w.send(frame);
          } catch {
            /* socket died between the readyState check and send */
          }
        }
      }
    };

    const expire = (): void =>
      finish({
        ok: false,
        error: "expired",
        message:
          "Nobody answered that code. Check the six characters, or ask your friend for a fresh one — if it keeps happening, both reload the game and try a new code.",
      });

    const heard = async (b64: string): Promise<void> => {
      let text: string | null = null;
      try {
        text = await openSealed(code, b64ToBytes(b64), theirSlot);
      } catch {
        text = null;
      }
      if (!text || done) return; // not ours, or too late

      if (hosting) {
        // An answer. Hand it over; the room stays open for more joiners.
        if (onJoiner) {
          const answer = text;
          Promise.resolve()
            .then(() => onJoiner(null, answer))
            .catch((e: unknown) => netLog.warn("nostr joiner answer handler failed:", e instanceof Error ? e.message : e));
          return;
        }
        finish({ ok: true, payload: text });
        return;
      }
      // An offer, and we are the replying side. The JOIN window was for
      // FINDING it; the reply gets its own deadline (nostr.js:302-309).
      if (answering || !reply) return;
      answering = true;
      clearExpire();
      const replyTimer = later(expire, REPLY_TIMEOUT_MS);
      let out: string | null = null;
      try {
        out = await reply(text);
      } catch {
        out = null;
      }
      if (done) return;
      if (!out) {
        answering = false;
        finish({ ok: false, error: "reply_failed", message: "Could not answer that invite." });
        return;
      }
      await publish(out);
      // Answer is on the wire: no deadline may kill the re-post window.
      clearExpire();
      clearTimeout(replyTimer);
      // Publish it a few more times before leaving: cheap insurance.
      let n = 0;
      const answer = out;
      const offer = text;
      again = setInterval(() => {
        if (done || ++n > 3) {
          if (again) clearInterval(again);
          return;
        }
        void publish(answer);
      }, 1200);
      later(() => {
        if (again) clearInterval(again);
        finish({ ok: true, payload: offer });
      }, 5200);
    };

    const hostStartedAt = Math.floor(Date.now() / 1000);
    const inbox = createBoundedInbox(heard, hostStartedAt - OFFER_CREATED_SLACK_S);

    // Guest: once answering, stop the looking tick (nostr.js:350-353).
    const tick = setInterval(() => {
      if (token && token.cancelled) finish({ ok: false, error: "cancelled", message: "" });
      else if (onTick && !answering) {
        try {
          onTick();
        } catch {
          /* a caller bug must not stop the exchange */
        }
      }
    }, 1000);

    const repost = setInterval(() => {
      if (!done && current) void publish(current);
    }, REPOST_MS);

    const startedAt = Date.now();
    const deadlineAt = startedAt + (hosting ? HOST_TIMEOUT_MS : JOIN_TIMEOUT_MS);
    expireTimer = later(expire, hosting ? HOST_TIMEOUT_MS : JOIN_TIMEOUT_MS);

    const maybeAdviseRejected = (): void => {
      if (done || advisedRejected || !onFail) return;
      const live = sockets.filter((w) => w.readyState === 1).length;
      if (!live || rejectedBy.size < live) return;
      advisedRejected = true;
      try {
        onFail({
          ok: false,
          error: "all_rejected",
          advisory: true,
          message: "Every room relay is refusing this code. It may still connect — if it does not, use the invite link or QR, which need no third party.",
        });
      } catch {
        /* a caller bug must not re-enter this advisory path */
      }
    };

    let opened = 0;
    // ONE SOCKET PER RELAY, REOPENED WHEN IT DIES: a phone host switching apps
    // loses its WebSockets (nostr.js:369-376).
    const RECONNECT_MS = [1000, 2000, 4000, 8000, 15000];
    const connect = (url: string, attempt: number): void => {
      if (done) return;
      let w: WebSocket;
      try {
        w = new WebSocket(url);
      } catch {
        return;
      }
      sockets.push(w);
      socketUrl.set(w, url);
      w.onopen = () => {
        opened++;
        if (!subId) subId = "s" + Math.floor(Date.now() % 1e6);
        try {
          // Strip Trystero's `since: now()`: it is THIS device's clock, and a
          // fast phone never heard a correct host (nostr.js:383-388).
          const req = JSON.parse(mod.subscribe(subId, theirTopic)) as unknown[];
          const filter = req[2] as { since?: unknown } | undefined;
          if (filter) delete filter.since;
          w.send(JSON.stringify(req));
        } catch {
          /* socket died between open and send */
        }
        if (current) void publish(current);
      };
      w.onclose = () => {
        const i = sockets.indexOf(w);
        if (i >= 0) sockets.splice(i, 1);
        socketUrl.delete(w);
        if (done) return;
        const n = Math.min(attempt, RECONNECT_MS.length - 1);
        later(() => {
          if (!done && !sockets.some((s) => socketUrl.get(s) === url)) connect(url, attempt + 1);
        }, RECONNECT_MS[n] as number);
      };
      w.onmessage = (ev: MessageEvent<unknown>) => {
        const frame = readRelayFrame(ev.data);
        if (frame.close) {
          try {
            w.close();
          } catch {
            /* already closing */
          }
          return;
        }
        const m = frame.message;
        if (!Array.isArray(m)) return;
        if (m[0] === "OK" || m[0] === "CLOSED") {
          const who = socketUrl.get(w) || String(opened);
          // OK=false on OUR event is a refusal (only "duplicate:" is benign);
          // CLOSED for our REQ means we will never hear the other side here.
          const refused =
            (m[0] === "OK" && typeof m[1] === "string" && pubIds.has(m[1]) && m[2] === false && !/^duplicate:/i.test(String(m[3] || ""))) ||
            (m[0] === "CLOSED" && subId != null && m[1] === subId);
          if (refused) {
            rejectedBy.add(who);
            maybeAdviseRejected();
          }
          return;
        }
        const ev2 = m[2] as { content?: unknown; created_at?: unknown } | undefined;
        if (m[0] === "EVENT" && ev2 && typeof ev2.content === "string" && inbox.accept(ev2.content, ev2.created_at) === false) {
          try {
            w.close();
          } catch {
            /* already closing */
          }
        }
      };
      w.onerror = () => {};
    };
    for (const url of relayUrls()) connect(url, 0);
    const onVisible = (): void => {
      if (done || typeof document === "undefined" || document.hidden) return;
      for (const url of relayUrls()) if (!sockets.some((s) => socketUrl.get(s) === url)) connect(url, 0);
    };
    if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", onVisible);
    unlisten = () => {
      try {
        if (typeof document !== "undefined" && document.removeEventListener) document.removeEventListener("visibilitychange", onVisible);
      } catch {
        /* no document */
      }
    };

    later(maybeAdviseRejected, RELAY_CHECK_MS);

    // Nothing to publish yet? Mint it now rather than waiting for an arrival.
    if (!current && mintOffer) {
      Promise.resolve(mintOffer(null))
        .then((o) => {
          if (!done && o) {
            current = o;
            void publish(o);
          }
        })
        .catch((e: unknown) => netLog.warn("nostr offer mint failed, room has nothing to publish:", e instanceof Error ? e.message : e));
    }

    later(() => {
      if (done) return;
      if (!sockets.some((w) => w.readyState === 1)) {
        finish({
          ok: false,
          error: "no_relay",
          message: "Could not reach any room service — this network may be blocking it. Use the invite link or QR instead.",
        });
      }
    }, RELAY_CHECK_MS);

    if (onJoiner && !settled) {
      settled = true;
      nostrLog({ ok: true });
      resolve({
        ok: true,
        subscribed: true,
        startedAt,
        deadlineAt,
        rotate: (next) => {
          current = next || null;
          if (!current && mintOffer) {
            return Promise.resolve(mintOffer(null))
              .then((o) => {
                if (!done && o) {
                  current = o;
                  return publish(o);
                }
                return undefined;
              })
              .catch((e: unknown) => netLog.warn("nostr offer re-mint on rotate failed:", e instanceof Error ? e.message : e));
          }
          return publish(current);
        },
        stop: () => finish({ ok: false, error: "stopped", message: "" }),
      });
    }
  });
}

/** f1-game's name for the same function (nostr.js:507-513). */
export const directExchange = exchange;
