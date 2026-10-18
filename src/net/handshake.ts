/**
 * Getting two browsers connected with NO server of ours: vanilla ICE (gather
 * fully, so one static string suffices) → slimmed SDP → deflate → base64url
 * invite code, pasted (or scanned, or relayed by a room code) between players.
 * Port of f1-game js/net/handshake.js:1-384 (NetHandshake).
 *
 * Embeds THIS TAB's build and REFUSES a mismatched peer: different builds mean
 * different splines, barriers and constants. AN ANSWER NAMES ITS OFFER (`o`,
 * `offerId()`), so an answer to an older invite is refused as `wrong_offer`.
 */
import { b64urlToBytes, bytesToB64url } from "./bytes";
import { netLog } from "./log";
import { identity, packChecked, unpack } from "./sdp";
import type { PeerConnectionCtor } from "./transport";

export const MAGIC = "APEX1"; // format marker + version, kept human-visible
const GATHER_TIMEOUT_MS = 8000; // stop waiting for stragglers
const MAX_CODE_CHARS = 512 * 1024;
const MAX_DECODED_BYTES = 256 * 1024;

/** Build identity. f1-game uses an integer generation; apex-26 also accepts a string hash. */
export type BuildId = number | string;

export type CodeKind = "offer" | "answer";

/** The decoded code. `p` is the sender's profile: untrusted JSON, validated by the lobby. */
export interface CodePayload {
  b: BuildId | null;
  k: CodeKind | string;
  p: unknown;
  s: string;
  o?: string;
}

export interface HsFail {
  readonly ok: false;
  readonly error: string;
  readonly message: string;
  readonly mine?: BuildId | null;
  readonly theirs?: BuildId | null;
}

const CORRUPT: HsFail = { ok: false, error: "corrupt_code", message: "That code is incomplete or corrupted — copy the whole thing." };
const NO_TRANSPORT: HsFail = { ok: false, error: "no_transport", message: "WebRTC is unavailable in this browser." };
const WRONG_OFFER: HsFail = {
  ok: false,
  error: "wrong_offer",
  message: "That answer is for an older invite. Ask your friend to answer the latest one.",
};

function hsLog<R extends { readonly ok: boolean; readonly error?: string; readonly code?: string }>(action: string, res: R): R {
  if (res.ok) {
    const n = res.code != null ? String(res.code).length : 0;
    netLog.info("handshake " + action + " ok" + (n ? " len=" + n : ""));
  } else {
    netLog.warn("handshake " + action + " fail " + (res.error || "error"));
  }
  return res;
}

const enc = (): TextEncoder => new TextEncoder();
const dec = (): TextDecoder => new TextDecoder();

function canCompress(): boolean {
  return typeof CompressionStream !== "undefined" && typeof Response !== "undefined";
}

async function deflateBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DECODED_BYTES) {
      await reader.cancel();
      throw new Error("inflate cap exceeded");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
const deflate = (text: string): Promise<Uint8Array<ArrayBuffer>> => deflateBytes(enc().encode(text));
const inflate = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => dec().decode(await inflateBytes(bytes));

/**
 * PRESERVE THE SDP VERBATIM: normalise line endings to CRLF and guarantee the
 * terminator, nothing else (handshake.js:52-68).
 */
export function normaliseSdp(sdp: string | null | undefined): string {
  const lines = String(sdp || "").split(/\r\n|\n|\r/).filter((l) => l.length);
  return lines.length ? lines.join("\r\n") + "\r\n" : "";
}

export interface CodecOptions {
  /** Validates the packed SDP rebuild; injectable for tests. */
  readonly PC?: PeerConnectionCtor;
}

export async function encodeCode(payload: CodePayload, opts: CodecOptions = {}): Promise<string> {
  if (canCompress()) {
    try {
      const packed = payload.s ? await packChecked(payload.s, opts.PC) : null;
      if (packed) {
        const { s: _s, ...tail } = payload;
        const rest = enc().encode(JSON.stringify(tail));
        const joined = new Uint8Array(2 + packed.length + rest.length);
        joined[0] = packed.length >> 8;
        joined[1] = packed.length & 0xff;
        joined.set(packed, 2);
        joined.set(rest, 2 + packed.length);
        return MAGIC + ".s." + bytesToB64url(await deflateBytes(joined));
      }
    } catch {
      /* any trouble at all: fall through to the whole-text path */
    }
    try {
      return MAGIC + ".z." + bytesToB64url(await deflate(JSON.stringify(payload)));
    } catch {
      /* fall through to plain */
    }
  }
  return MAGIC + ".p." + bytesToB64url(enc().encode(JSON.stringify(payload)));
}

/**
 * Whitespace AND the invisible characters mail and chat clients slip into a
 * long unbroken string (zero-width space/joiners, word joiner, soft hyphen,
 * BOM) (handshake.js:105-109).
 */
export const INVISIBLE = /[\s​-‍⁠﻿­]+/g;

export type PeekResult = HsFail | { readonly ok: true; readonly mode: "s" | "z" | "p"; readonly body: string };

/**
 * The FORMAT half of decodeCode, synchronous and connection-free: is this text
 * shaped like one of our codes at all? (handshake.js:98-122)
 */
export function peekCode(code: unknown): PeekResult {
  const input = String(code || "");
  if (input.length > MAX_CODE_CHARS) return CORRUPT;
  const trimmed = input.trim().replace(INVISIBLE, "");
  if (trimmed.length > MAX_CODE_CHARS) return CORRUPT;
  const parts = trimmed.split(".");
  if (parts.length !== 3 || parts[0] !== MAGIC) {
    return { ok: false, error: "bad_code", message: "That does not look like an Apex invite code." };
  }
  const mode = parts[1];
  const body = parts[2] as string;
  if (mode !== "s" && mode !== "z" && mode !== "p") return CORRUPT;
  return { ok: true, mode, body };
}

export type DecodeResult = HsFail | { readonly ok: true; readonly payload: CodePayload };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Types the decoded object's handshake fields and KEEPS every other field, as
 * f1-game hands the parsed object on verbatim (handshake.js:127,133): a newer
 * peer's extra fields must survive the decode.
 */
function asPayload(raw: Record<string, unknown>): CodePayload {
  const b = raw["b"];
  const out: CodePayload = {
    ...raw,
    b: typeof b === "number" || typeof b === "string" ? b : null,
    k: typeof raw["k"] === "string" ? raw["k"] : "",
    p: raw["p"] ?? null,
    s: typeof raw["s"] === "string" ? raw["s"] : "",
  };
  const o = raw["o"];
  if (o != null) out.o = String(o);
  return out;
}

export async function decodeCode(code: unknown): Promise<DecodeResult> {
  const peek = peekCode(code);
  if (!peek.ok) return peek;
  const { mode, body } = peek;
  try {
    const bytes = b64urlToBytes(body);
    if (mode === "s") {
      const raw = await inflateBytes(bytes);
      const n = ((raw[0] ?? 0) << 8) | (raw[1] ?? 0);
      const sdp = unpack(raw.slice(2, 2 + n));
      if (!sdp) return CORRUPT;
      const payload: unknown = JSON.parse(dec().decode(raw.slice(2 + n)));
      if (!isObject(payload) || typeof payload["k"] !== "string") return CORRUPT;
      payload["s"] = sdp;
      return { ok: true, payload: asPayload(payload) };
    }
    if (mode === "p" && bytes.byteLength > MAX_DECODED_BYTES) return CORRUPT;
    const json = mode === "z" ? await inflate(bytes) : dec().decode(bytes);
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== "object" || payload === null) return CORRUPT;
    return { ok: true, payload: asPayload(payload as Record<string, unknown>) };
  } catch {
    return CORRUPT; // decode, inflate and parse all mean the same to a player
  }
}

/** The slice of RTCPeerConnection waitForIce listens on (a fake in tests). */
export type IceGatherTarget = Pick<RTCPeerConnection, "iceGatheringState" | "addEventListener" | "removeEventListener">;

/** Resolves true on complete gathering, false on timeout (handshake.js:153-178). */
export function waitForIce(pc: IceGatherTarget, timeoutMs?: number): Promise<boolean> {
  if (pc.iceGatheringState === "complete") return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (): void => {
      if (pc.iceGatheringState === "complete") finish(true);
    };
    // null candidate = end of gathering (spec). Honour it even when the
    // gathering-state event is late or missed.
    const onCand = (e: Event): void => {
      if (!(e as RTCPeerConnectionIceEvent).candidate) finish(true);
    };
    function finish(complete: boolean): void {
      if (done) return;
      done = true;
      pc.removeEventListener("icegatheringstatechange", onChange);
      pc.removeEventListener("icecandidate", onCand);
      if (timer != null) clearTimeout(timer);
      resolve(complete);
    }
    pc.addEventListener("icegatheringstatechange", onChange);
    pc.addEventListener("icecandidate", onCand);
    // Re-check AFTER listen: completion in the gap above must not hang.
    if (pc.iceGatheringState === "complete") {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs || GATHER_TIMEOUT_MS);
  });
}

// ─── build identity (handshake.js:180-226) ──────────────────────────────────

/** f1-game reads `<meta name="apex-build">`; apex-26 stamps `a26-build`. */
export const BUILD_META = "a26-build";

export function fnv1a(str: string): number {
  // f1-game js/core/hash32.js:5-13.
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * THE BUILD THIS TAB IS RUNNING, not the build the server has: the shell's
 * stamped meta, else the content-hashed entry script URL (Vite names every
 * production chunk by its content, and the entry names its imports, so its
 * URL changes whenever any shipped code does). apex-26 addition: f1-game had
 * no hashed bundles.
 */
export function metaBuild(): BuildId | null {
  try {
    if (typeof document === "undefined" || !document.querySelector) return null;
    const m = document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META}"]`);
    const raw = m && m.content != null ? String(m.content).trim() : "";
    if (raw) {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && String(n) === raw ? n : raw;
    }
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    if (entry && entry.src) return "e" + fnv1a(new URL(entry.src, location.href).pathname).toString(16);
    return null;
  } catch {
    return null;
  }
}

let buildCache: BuildId | null = null;
let buildOverride: BuildId | null = null;

/** Test and embed seam: pin the build identity this tab reports. `null` restores detection. */
export function setLocalBuild(build: BuildId | null): void {
  buildOverride = build;
  buildCache = null;
}

export async function localBuild(): Promise<BuildId | null> {
  if (buildOverride != null) return buildOverride;
  if (buildCache != null) return buildCache;
  const meta = metaBuild();
  if (meta != null) {
    buildCache = meta;
    return meta;
  }
  try {
    const r = await fetch("version.json?_=" + Date.now(), { cache: "no-store" });
    const v: unknown = await r.json();
    const b = isObject(v) ? v["build"] : null;
    buildCache = typeof b === "number" || typeof b === "string" ? b : null;
  } catch (e) {
    // UNKNOWN, not 0, and deliberately NOT memoised: a later attempt may succeed.
    netLog.warn("version.json unreadable (" + (e instanceof Error ? e.message : String(e)) + ") — build identity unknown, refusing to pair");
    return null;
  }
  return buildCache;
}

export type BuildCheck = { readonly ok: true } | HsFail;

/** Peers must agree on the build (handshake.js:228-251). */
export function checkBuild(mine: BuildId | null | undefined, theirs: BuildId | null | undefined): BuildCheck {
  if (mine == null || theirs == null) {
    return {
      ok: false,
      error: "build_unknown",
      message: "Could not confirm you are both on the same version. Check your connection and try again.",
      mine: mine == null ? null : mine,
      theirs: theirs == null ? null : theirs,
    };
  }
  if (mine === theirs) return { ok: true };
  const newer = typeof mine === "number" && typeof theirs === "number" ? theirs > mine : null;
  return {
    ok: false,
    error: "build_mismatch",
    message:
      newer === true
        ? "Your friend is on a newer version. Reload the page to update (an installed app: close it fully and reopen), then try again."
        : newer === false
          ? "Your friend is on an older version. Ask them to reload the page and send a new invite, then try again."
          : "You and your friend are on different versions. Both reload the page, then send a new invite.",
    mine,
    theirs,
  };
}

// ─── the exchange (handshake.js:253-350) ────────────────────────────────────

export interface HandshakeOptions extends CodecOptions {
  readonly gatherTimeoutMs?: number;
}

/** What the handshake needs of a transport: its RTCPeerConnection. */
export interface HasPc {
  readonly pc?: RTCPeerConnection | null;
}

async function makeCode(pc: RTCPeerConnection, kind: CodeKind, profile: unknown, opts: HandshakeOptions, offer?: string | null): Promise<string> {
  await waitForIce(pc, opts.gatherTimeoutMs);
  const payload: CodePayload = {
    b: await localBuild(),
    k: kind,
    p: profile || null, // f1-game handshake.js:244: `||`, not `??`
    s: normaliseSdp(pc.localDescription ? pc.localDescription.sdp : ""),
  };
  if (offer) payload.o = offer;
  return encodeCode(payload, opts);
}

/**
 * WHICH OFFER AN ANSWER ANSWERS: a 32-bit hash of the offer's ICE ufrag + DTLS
 * fingerprint, both fresh per RTCPeerConnection (handshake.js:270-283).
 */
export function offerId(sdp: string | null | undefined): string | null {
  const id = identity(sdp);
  if (!id) return null;
  return fnv1a(id.ufrag + "|" + id.fp).toString(16).padStart(8, "0");
}

export type InviteResult = HsFail | { readonly ok: true; readonly code: string; readonly url: string | null };
export type AcceptInviteResult = HsFail | { readonly ok: true; readonly code: string; readonly peer: unknown };
export type AcceptAnswerResult = HsFail | { readonly ok: true; readonly peer: unknown };

/** host: createInvite() → code, give it away, then acceptAnswer(theirCode). */
export async function createInvite(transport: HasPc | null | undefined, profile: unknown, opts: HandshakeOptions = {}): Promise<InviteResult> {
  const pc = transport && transport.pc;
  if (!pc) return hsLog("invite", NO_TRANSPORT);
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const code = await makeCode(pc, "offer", profile, opts);
    return hsLog("invite", { ok: true, code, url: inviteUrl(code) });
  } catch (e) {
    netLog.warn("handshake invite fail");
    throw e;
  }
}

async function setRemote(pc: RTCPeerConnection, type: RTCSdpType, sdp: unknown): Promise<boolean> {
  if (typeof sdp !== "string" || !sdp) return false;
  try {
    await pc.setRemoteDescription({ type, sdp });
    return true;
  } catch {
    return false;
  }
}

/** guest: acceptInvite(theirCode) → code, send it back, done. */
export async function acceptInvite(
  transport: HasPc | null | undefined,
  code: unknown,
  profile: unknown,
  opts: HandshakeOptions = {},
): Promise<AcceptInviteResult> {
  const parsed = await decodeCode(code);
  if (!parsed.ok) return hsLog("accept", parsed);
  if (parsed.payload.k !== "offer") {
    return hsLog("accept", { ok: false, error: "wrong_code_kind", message: "That is an answer code, not an invite code." });
  }
  const build = checkBuild(await localBuild(), parsed.payload.b);
  if (!build.ok) return hsLog("accept", build);
  const pc = transport && transport.pc;
  if (!pc) return hsLog("accept", NO_TRANSPORT);

  const took = await setRemote(pc, "offer", parsed.payload.s);
  if (!took) return hsLog("accept", CORRUPT);
  await pc.setLocalDescription(await pc.createAnswer());
  const out = await makeCode(pc, "answer", profile, opts, offerId(parsed.payload.s));
  return hsLog("accept", { ok: true, code: out, peer: parsed.payload.p || null });
}

export async function acceptAnswer(transport: HasPc | null | undefined, code: unknown): Promise<AcceptAnswerResult> {
  const parsed = await decodeCode(code); // code first — see acceptInvite
  if (!parsed.ok) return hsLog("answer", parsed);
  if (parsed.payload.k !== "answer") {
    return hsLog("answer", { ok: false, error: "wrong_code_kind", message: "That is an invite code, not an answer code." });
  }
  const build = checkBuild(await localBuild(), parsed.payload.b);
  if (!build.ok) return hsLog("answer", build);
  const pc = transport && transport.pc;
  if (!pc) return hsLog("answer", NO_TRANSPORT);
  // Offer identity BEFORE the state check: an answer to a different offer is
  // wrong whatever this one's state.
  const wants = parsed.payload.o;
  if (wants != null) {
    const mine = offerId(pc.localDescription && pc.localDescription.sdp);
    if (mine && String(wants) !== mine) return hsLog("answer", WRONG_OFFER);
  }
  if (pc.signalingState !== "have-local-offer") {
    return hsLog("answer", { ok: false, error: "already_answered", message: "That answer was already used, or arrived too late." });
  }
  const took = await setRemote(pc, "answer", parsed.payload.s);
  if (!took) return hsLog("answer", CORRUPT);
  return hsLog("answer", { ok: true, peer: parsed.payload.p || null });
}

// ─── invite links (handshake.js:352-375) ────────────────────────────────────

/** The code rides in the FRAGMENT so it never reaches a server, not even a log. */
export function inviteUrl(code: string, base?: string): string | null {
  try {
    return (base ?? location.origin + location.pathname) + "#vs=" + code;
  } catch {
    return null;
  }
}

export function inviteFromUrl(href?: string | null): string | null {
  try {
    const h = (href != null ? String(href) : location.hash) || "";
    // A link ends at whitespace; a code ends in a base64url character, never
    // the "." or ")" a sentence puts after it.
    const m = h.match(/[#&]vs=([^&\s]+)/);
    return m ? (m[1] as string).replace(/[^A-Za-z0-9_-]+$/, "") : null;
  } catch {
    return null;
  }
}

/** Remove only the consumed signalling secret; keep query and other fragment state. */
export function withoutInviteUrl(href?: string | null): string | null {
  try {
    const url = new URL(href != null ? String(href) : location.href);
    const kept = String(url.hash || "")
      .replace(/^#/, "")
      .split("&")
      .filter((part) => part && !/^vs=/.test(part));
    url.hash = kept.join("&");
    return url.href;
  } catch {
    return null;
  }
}

export function consumeInviteUrl(): boolean {
  try {
    if (!inviteFromUrl() || typeof history === "undefined" || !history.replaceState) return false;
    const next = withoutInviteUrl();
    if (!next) return false;
    history.replaceState(history.state, "", next);
    return true;
  } catch {
    return false;
  }
}
