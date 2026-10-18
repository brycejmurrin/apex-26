/**
 * Room codes: a short code instead of a pasted invite. The BACKUP way in.
 * Port of f1-game js/net/rendezvous.js:1-454 (NetRendezvous).
 *
 * A public Nostr relay network is the default meeting place (./nostr.ts), and
 * the optional Cloudflare Worker (f1-game worker/rendezvous.js, protocol 3) is
 * used when its URL is set. Payloads are sealed with AES-GCM under a key
 * derived from the room code (envelope v2: random salt, slot name as AAD). The
 * room code is a rendezvous, not an authentication: the VERIFICATION CODE
 * (`verifyFor`) shown on both screens is what tells two players they are
 * talking to each other.
 *
 * The crypto domain strings ("apex26-rendezvous-v2", …) are wire protocol and
 * stay verbatim so the f1-game Worker serves apex-26 unchanged; only the
 * localStorage key is renamed (`apex26.rendezvous` → `a26.rendezvous`).
 */
import { b64urlToBytes, bytesToB64url } from "./bytes";
import { netLog } from "./log";
import { exchange as nostrExchange, type ExchangeResult, type HostedRoom, type NostrFail } from "./nostr";
import { fingerprint } from "./sdp";

// No 0/O, no 1/I/L — the characters people mishear and mistype.
export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LEN = 6;
/** 32 unbiased base-31 draws: >158 bits, shared out of band (private Worker only). */
export const PRIVATE_CODE_LEN = 32;
const PRIVATE_PROTOCOL = "3";

export const DEFAULT_URL = "";
export const STORE_KEY = "a26.rendezvous";
let sessionUrl: string | null | undefined; // QR pairing can select a relay for this document only

/**
 * A private relay's URL is a security boundary: HTTPS only (loopback HTTP for
 * development), no credentials, query or fragment (rendezvous.js:15-28).
 */
function validRelayUrl(raw: unknown): string | null {
  try {
    const u = new URL(String(raw));
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.username || u.password || u.search || u.hash || !(u.protocol === "https:" || (u.protocol === "http:" && loopback))) return null;
    return u.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const POLL_MS = 1200;
/** A guest join of a missing code fails in ~8–15 s (rendezvous.js:31-33). */
export const POLL_TIMEOUT_MS = 12000;
/** The host of a private room waits for a friend who must be sent the code first. */
export const HOST_POLL_TIMEOUT_MS = 120000;
const FETCH_TIMEOUT_MS = 8000;

export function baseUrl(): string | null {
  if (sessionUrl !== undefined) return sessionUrl;
  let raw = DEFAULT_URL;
  try {
    raw = (localStorage.getItem(STORE_KEY) || "").trim() || DEFAULT_URL;
  } catch {
    /* storage blocked (private mode): use the default */
  }
  if (!raw) return null;
  return validRelayUrl(raw);
}

/** Shown even when unconfigured: a feature that hides itself is never discovered. */
export const configured = (): boolean => true;
export const usingPrivateRelay = (): boolean => !!baseUrl();

export function setUrl(url: string | null | undefined): boolean {
  if (url) {
    const normalized = validRelayUrl(url);
    if (!normalized) return false;
    try {
      localStorage.setItem(STORE_KEY, normalized);
      return configured();
    } catch {
      return false;
    }
  }
  try {
    localStorage.removeItem(STORE_KEY);
    return configured();
  } catch {
    return false;
  }
}

/** For this document only. `null` selects public signalling; `undefined` restores the saved preference. */
export function setSessionUrl(url: string | null | undefined): boolean {
  if (url == null) {
    sessionUrl = url === undefined ? undefined : null;
    return true;
  }
  const normalized = validRelayUrl(url);
  if (!normalized) return false;
  sessionUrl = normalized;
  return true;
}

// REJECTION SAMPLING, not `byte % 31` (rendezvous.js:77-81).
const RAND_LIMIT = 256 - (256 % ALPHABET.length); // 248 for 31 letters
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function makeCode(): string | null {
  const privateRelay = usingPrivateRelay();
  // The private path never falls back to Math.random.
  if (privateRelay && (typeof crypto === "undefined" || !crypto.getRandomValues)) return null;
  const length = privateRelay ? PRIVATE_CODE_LEN : CODE_LEN;
  let out = "";
  while (out.length < length) {
    const n = randomBytes(length * 2);
    for (let i = 0; i < n.length && out.length < length; i++) {
      const b = n[i] as number;
      if (b < RAND_LIMIT) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

/** One representative per confusable family, so valid() answers consistently. */
export function normalise(code: unknown): string {
  return String(code || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

const validLength = (code: unknown, length: number): boolean => {
  const c = normalise(code);
  return c.length === length && [...c].every((ch) => ALPHABET.indexOf(ch) >= 0);
};
export const valid = (code: unknown): boolean => validLength(code, usingPrivateRelay() ? PRIVATE_CODE_LEN : CODE_LEN);

export interface RvFail {
  readonly ok: false;
  readonly error: string;
  readonly message: string;
}
const ERR = (error: string, message: string): RvFail => ({ ok: false, error, message });
const privateCodeError = (): RvFail =>
  ERR("bad_code", "Private rooms need a new 32-character token. Ask the host to share a new token, or use the invite link.");
const protocolError = (): RvFail =>
  ERR("relay_version", "Update the private room Worker and reload both players, or use the invite link. This relay uses an incompatible protocol.");
const NO_URL = (): RvFail => ERR("not_configured", "That relay is no longer configured.");

const enc = (): TextEncoder => new TextEncoder();
const dec = (): TextDecoder => new TextDecoder();

type CallResult = RvFail | { readonly ok: true; readonly body: unknown };

/** Every network call funnels through here: a typed result, never an exception or a hang (rendezvous.js:120-155). */
async function call(path: string, opts: RequestInit): Promise<CallResult> {
  const base = baseUrl();
  if (!base) return NO_URL();
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => {
    if (ctrl) ctrl.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const init: RequestInit = { cache: "no-store", ...opts };
    if (ctrl) init.signal = ctrl.signal;
    const res = await fetch(base + path, init);
    const protocol = res.headers ? res.headers.get("x-apex-rendezvous") : null;
    if (res.status === 426 || (res.status === 404 && protocol !== PRIVATE_PROTOCOL)) return protocolError();
    if (res.status === 404) return ERR("not_found", "Nobody is waiting on that code.");
    if (res.status === 409) return ERR("taken", "That code is already in use — make a new one.");
    if (res.status === 429) return ERR("rate_limited", "The room service is busy. Wait a minute or use the invite link.");
    if (!res.ok) return ERR("relay", "The room service is not answering. Use the invite link instead.");
    const text = await res.text();
    let body: unknown = null;
    // A captive portal answers 200 with HTML: that is interception, not "offline".
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      return ERR("relay", "The room service answered with something unexpected — this network may be intercepting it. Use the invite link instead.");
    }
    if (protocol !== PRIVATE_PROTOCOL) return protocolError();
    return { ok: true, body };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return ERR(aborted ? "timeout" : "offline", aborted ? "The room service timed out." : "Could not reach the room service.");
  } finally {
    clearTimeout(timer);
  }
}

// ─── keys and envelopes (rendezvous.js:157-322) ─────────────────────────────

const PBKDF2_SALT = enc().encode("apex26-rendezvous-v2");
const HKDF_INFO = enc().encode("apex26-rendezvous-v2/envelope");
const SALT_LEN = 16;
const IV_LEN = 12;
const MIN_ENVELOPE = SALT_LEN + IV_LEN + 16;

// One-entry memo: PBKDF2 runs ONCE per code (rendezvous.js:173-181).
let keyCode: string | null = null;
let keyP: Promise<CryptoKey> | null = null;
function keyFor(code: string): Promise<CryptoKey> {
  const norm = normalise(code);
  if (keyP && keyCode === norm) return keyP;
  keyCode = norm;
  const p = (async () => {
    const base = await crypto.subtle.importKey("raw", enc().encode(norm), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: PBKDF2_SALT, iterations: 120000, hash: "SHA-256" }, base, 256);
    return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey", "deriveBits"]);
  })();
  keyP = p;
  // A failed derive must not stick.
  p.catch(() => {
    if (keyP === p) {
      keyP = null;
      keyCode = null;
    }
  });
  return p;
}

async function envelopeKey(code: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO },
    await keyFor(code),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const toHex = (bits: ArrayBuffer): string => [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * THE PUBLIC TOPIC comes from the STRETCHED key, never from the code; PROTOCOL
 * rides in the info string so another protocol meets elsewhere (rendezvous.js:191-210).
 */
export const PROTOCOL = 3;
const TOPIC_BYTES = 10;
export async function topic(code: string, slot: string): Promise<string> {
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc().encode("apex26-rendezvous-v" + PROTOCOL + "/topic|" + String(slot || "")) },
    await keyFor(code),
    TOPIC_BYTES * 8,
  );
  return toHex(bits);
}

/** The private Worker's opaque routing id: never the token itself (rendezvous.js:212-221). */
export async function privateRoomId(code: string): Promise<string> {
  if (!validLength(code, PRIVATE_CODE_LEN)) throw new Error("private token required");
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc().encode("apex26-rendezvous-private-v3/room") },
    await keyFor(code),
    256,
  );
  return toHex(bits);
}

const aad = (slot: string): Uint8Array<ArrayBuffer> => enc().encode(String(slot || ""));

/**
 * THE VERIFICATION CODE: 4 letters over BOTH ends' DTLS fingerprints, sorted,
 * so a middleman holding a different certificate on each leg shows two
 * different codes (rendezvous.js:225-247).
 */
export const VERIFY_LEN = 4;
export async function verifyCode(fpA: string | null | undefined, fpB: string | null | undefined): Promise<string | null> {
  const norm = (f: string | null | undefined): string => String(f || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  const a = norm(fpA);
  const b = norm(fpB);
  if (!a || !b) return null;
  const pair = a < b ? a + "|" + b : b + "|" + a;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc().encode("apex26-verify-v1|" + pair)));
  let out = "";
  for (let i = 0; i < d.length && out.length < VERIFY_LEN; i++) {
    const v = d[i] as number;
    if (v < RAND_LIMIT) out += ALPHABET[v % ALPHABET.length]; // unbiased, as makeCode()
  }
  return out.length === VERIFY_LEN ? out : null;
}

/** From a CONNECTED RTCPeerConnection; never rejects, null without descriptions. */
export async function verifyFor(pc: Pick<RTCPeerConnection, "localDescription" | "remoteDescription"> | null | undefined): Promise<string | null> {
  try {
    const fp = (d: RTCSessionDescription | null | undefined): string | null => (d && d.sdp ? fingerprint(d.sdp) : null);
    return await verifyCode(fp(pc && pc.localDescription), fp(pc && pc.remoteDescription));
  } catch {
    return null;
  }
}

export async function seal(code: string, text: string, slot: string): Promise<Uint8Array<ArrayBuffer>> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(slot) }, await envelopeKey(code, salt), enc().encode(text));
  const out = new Uint8Array(SALT_LEN + IV_LEN + ct.byteLength);
  out.set(salt);
  out.set(iv, SALT_LEN);
  out.set(new Uint8Array(ct), SALT_LEN + IV_LEN);
  return out;
}

export async function open(code: string, bytes: Uint8Array<ArrayBuffer> | null | undefined, slot: string): Promise<string | null> {
  if (!bytes || bytes.length < MIN_ENVELOPE) return null;
  try {
    const salt = bytes.slice(0, SALT_LEN);
    const iv = bytes.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(slot) }, await envelopeKey(code, salt), bytes.slice(SALT_LEN + IV_LEN));
    return dec().decode(pt);
  } catch {
    return null;
  }
}

export const ENVELOPE_TAG = "v2.";
export async function sealPrivate(code: string, slot: string, payload: string): Promise<string> {
  return ENVELOPE_TAG + bytesToB64url(await seal(code, payload, slot));
}

/** v2 only: unversioned plaintext from the Worker would let its operator substitute an SDP. */
export async function openPrivate(code: string, slot: string, payload: unknown): Promise<string | null> {
  if (typeof payload !== "string" || !payload.startsWith(ENVELOPE_TAG)) return null;
  try {
    return await open(code, b64urlToBytes(payload.slice(ENVELOPE_TAG.length)), slot);
  } catch {
    return null;
  }
}

function ownerCapability(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return bytesToB64url(bytes);
}

// ─── the private Worker backend (rendezvous.js:324-357) ─────────────────────

export type Slot = "offer" | "answer";

async function httpPut(code: string, slot: Slot, payload: string, owner: string | null): Promise<CallResult> {
  if (!validLength(code, PRIVATE_CODE_LEN)) return privateCodeError();
  try {
    const sealed = await sealPrivate(code, slot, payload);
    return call(`/v3/r/${await privateRoomId(code)}/${slot}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: sealed, ...(owner ? { owner } : {}) }),
    });
  } catch {
    return ERR("crypto", "This browser could not protect the room code. Use the invite link instead.");
  }
}

export type GetResult = RvFail | { readonly ok: true; readonly body: { readonly payload: string } };

export async function get(code: string, slot: Slot): Promise<GetResult> {
  if (!validLength(code, PRIVATE_CODE_LEN)) return privateCodeError();
  let room: string;
  try {
    room = await privateRoomId(code);
  } catch {
    return ERR("crypto", "This browser could not protect the room token. Use the invite link instead.");
  }
  const got = await call(`/v3/r/${room}/${slot}`, { method: "GET" });
  if (!got.ok) return got;
  const raw = typeof got.body === "object" && got.body !== null ? (got.body as { payload?: unknown }).payload : undefined;
  const payload = raw != null ? await openPrivate(code, slot, raw) : null;
  if (!payload) return ERR("corrupt", "The room service returned an unreadable code. Use the invite link instead.");
  return { ok: true, body: { payload } };
}

/** Lets a caller abandon a pending exchange. */
export interface CancelToken {
  cancelled: boolean;
}

export interface HostRoomOptions {
  readonly code: string;
  readonly mine?: string | null;
  readonly mintOffer?: (prev: null) => Promise<string | null> | string | null;
  readonly onJoiner?: (from: null, answer: string) => unknown;
  readonly token?: CancelToken;
  readonly onTick?: () => void;
  readonly onFail?: (r: NostrFail) => void;
}

export type HostRoomResult = RvFail | NostrFail | HostedRoom | ExchangeResult;

/** Host a public room code for several joiners, one answer at a time (rendezvous.js:365-378). */
export function hostRoom(o: HostRoomOptions): Promise<HostRoomResult> {
  if (usingPrivateRelay()) {
    netLog.warn("room host fail not_supported");
    return Promise.resolve(ERR("not_supported", "Room codes on a private relay take one guest. Use the invite link for the others."));
  }
  netLog.info("room host");
  return nostrExchange({
    code: o.code,
    send: o.mine ?? null,
    ...(o.mintOffer ? { mintOffer: o.mintOffer } : {}),
    ...(o.onJoiner ? { onJoiner: o.onJoiner } : {}),
    ...(o.token ? { token: o.token } : {}),
    ...(o.onTick ? { onTick: o.onTick } : {}),
    ...(o.onFail ? { onFail: o.onFail } : {}),
  });
}

const offerOwners = new Map<string, { payload: string; owner: string }>();
function ownerFor(code: string, payload: string): string {
  const key = normalise(code);
  const prior = offerOwners.get(key);
  const owner = prior && prior.payload === payload ? prior.owner : ownerCapability();
  offerOwners.set(key, { payload, owner });
  if (offerOwners.size > 128) {
    const first = offerOwners.keys().next();
    if (!first.done) offerOwners.delete(first.value);
  }
  return owner;
}

export async function put(code: string, slot: Slot, payload: string): Promise<CallResult> {
  let owner: string | null = null;
  try {
    if (slot === "offer") owner = ownerFor(code, payload);
  } catch {
    return ERR("crypto", "This browser could not protect the room code. Use the invite link instead.");
  }
  return httpPut(code, slot, payload, owner);
}

function rvLog<R extends { readonly ok: boolean; readonly error?: string }>(action: string, res: R): R {
  if (res.ok) netLog.info(action + " ok");
  else if (res.error === "cancelled") netLog.info(action + " cancelled");
  else netLog.warn(action + " fail " + (res.error || "error"));
  return res;
}

export interface SwapOptions {
  readonly code: string;
  /** Host: the invite to publish. */
  readonly mine?: string | null;
  /** Guest: build the answer from the offer it found. */
  readonly reply?: (offer: string) => Promise<string | null> | string | null;
  /** The slot WE write. */
  readonly slot: Slot;
  /** The slot we wait for. */
  readonly want: Slot;
  readonly token?: CancelToken;
  readonly onTick?: (secs?: number) => void;
}

export type SwapResult = RvFail | NostrFail | { readonly ok: true; readonly payload: string };

/**
 * Publish a blob, then wait for the other one: the rendezvous is a courier,
 * never a participant (rendezvous.js:395-418).
 */
export async function swap(o: SwapOptions): Promise<SwapResult> {
  const { code, mine, reply, slot, want, token, onTick } = o;
  if (!usingPrivateRelay()) {
    const r = await nostrExchange({
      code,
      send: mine ?? null,
      ...(reply ? { reply } : {}),
      ...(token ? { token } : {}),
      ...(onTick ? { onTick: () => onTick() } : {}),
    });
    return "subscribed" in r ? ERR("relay", "Unexpected room state.") : r;
  }
  if (reply) {
    const got = await waitFor(code, want, token, onTick);
    if (!got.ok) return rvLog("swap", got);
    let out: string | null = null;
    try {
      out = await reply(got.payload);
    } catch {
      out = null;
    }
    if (!out) return rvLog("swap", ERR("reply_failed", "Could not answer that invite."));
    const posted = await httpPut(code, slot, out, null);
    return rvLog("swap", posted.ok ? { ok: true, payload: got.payload } : posted);
  }
  // Stable across a repeated host attempt with the same code+offer.
  let owner: string | null = null;
  try {
    owner = slot === "offer" && mine ? ownerFor(code, mine) : null;
  } catch {
    return rvLog("swap", ERR("crypto", "This browser could not protect the room code. Use the invite link instead."));
  }
  const posted = await httpPut(code, slot, mine ?? "", owner);
  if (!posted.ok) return rvLog("swap", posted);
  const got = await waitFor(code, want, token, onTick, HOST_POLL_TIMEOUT_MS);
  return rvLog("swap", got.ok ? { ok: true, payload: got.payload } : got);
}

// A poll gives up on WAIT_TRANSIENT_MAX transient errors in a row, not one.
const TRANSIENT: ReadonlySet<string> = new Set(["rate_limited", "relay", "timeout", "offline"]);
const WAIT_TRANSIENT_MAX = 5;

export async function waitFor(
  code: string,
  slot: Slot,
  token?: CancelToken,
  onTick?: (secs: number) => void,
  timeoutMs?: number,
): Promise<RvFail | { readonly ok: true; readonly payload: string }> {
  const limit = timeoutMs != null && timeoutMs > 0 ? timeoutMs : POLL_TIMEOUT_MS;
  const started = Date.now();
  let transient = 0;
  for (;;) {
    if (token && token.cancelled) return ERR("cancelled", "");
    const res = await get(code, slot);
    if (token && token.cancelled) return ERR("cancelled", "");
    if (res.ok && res.body.payload) return { ok: true, payload: res.body.payload };
    if (!res.ok && res.error !== "not_found") {
      if (!TRANSIENT.has(res.error) || ++transient >= WAIT_TRANSIENT_MAX) return res;
    } else transient = 0;
    if (Date.now() - started > limit) {
      return ERR("expired", "Nobody answered that code. Double-check it, or ask your friend for a fresh one.");
    }
    if (onTick) {
      try {
        onTick(Math.round((Date.now() - started) / 1000));
      } catch {
        /* a caller bug must not stop the poll */
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
