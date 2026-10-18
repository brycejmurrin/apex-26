/**
 * PhonePad — PHONE AS CONTROLLER: a phone on the sofa steers the game on the
 * screen by tilting, over the multiplayer wire, and shows a steering-wheel
 * dash fed live from the race.
 * Port of f1-game js/input/phone-pad.js:1-1178 (PhonePad); the protocol is
 * f1-game docs/MULTIPLAYER.md §"Phone as controller".
 *
 * WHY NOT BLUETOOTH. A web page can only ever be the CENTRAL end of Web
 * Bluetooth: no phone browser can advertise, act as a GATT peripheral or
 * present itself as an HID gamepad. The pairing a static site CAN do is the
 * one VS FRIEND ships: a WebRTC DataChannel signalled through a room code on
 * the public Nostr relays (src/net/rendezvous.ts → src/net/nostr.ts).
 *
 * THE TWO HALVES share this file so the wire format has one home:
 *   host(ui, deps) — the DESKTOP side: mints a room, paints the QR for
 *                    controller.html#pad=CODE, accepts the phone's answer and
 *                    feeds every sample to `deps.input.remoteSample()`. It
 *                    streams the dash back.
 *   pad(dom, opts) — the PHONE side (controller.html, src/net/controller-page.ts):
 *                    joins the room, streams rollDeg() plus the pedals on the
 *                    unreliable channel, sends button EDGES on the reliable
 *                    one, paints the wheel's LCD and vibrates on a haptic.
 * link()/padSession() are the transport-level halves with the signalling left
 * out, so tests/unit/net-phone-pad.test.ts drives both over loopback().
 *
 * WIRE (bit-compatible with f1-game, PROTO 1):
 *   STATE phone→desktop  [1, seq, rollDeg|null, thr, brk, heldBits]
 *                        or, after a {steer:true} hello, [2, seq, null, thr, brk, held, steer]
 *   STATE desktop→phone  ["H", gear, kmh, rpmFrac, lap, laps, pos, cars, ers,
 *                         flagBits, caution, lastLapMs, state, teamHex] at ~15 Hz
 *                        and ["A", seq] acknowledgements (≤ one per HEARTBEAT_MS)
 *   EVENT                {t:"ev", k} / {t:"hap", ms} / {t:"hi", side, p, haptics, steer?, ack?}
 *
 * apex-26 differences (AGENTS.md §Code rules): ES module exports instead of
 * the frozen IIFE global; f1-game's global `Input` becomes the explicit
 * `PhonePadInput` passed as `link(…, { input })` / `host(ui, { input })`;
 * `Log.info("input", …)` becomes `netLog`; the NetTransport / NetHandshake /
 * NetRendezvous / NetScan globals are the src/net/ module imports (still
 * overridable through `deps`).
 */
import { netLog } from "./log";
import * as NetHandshake from "./handshake";
import type { HasPc } from "./handshake";
import * as NetRendezvous from "./rendezvous";
import type { HostRoomOptions, SwapOptions } from "./rendezvous";
import * as NetScan from "./scan";
import type { Scanner, ScanStartResult, ScanVideo } from "./scan";
import * as NetTransport from "./transport";
import { EVENT, STATE } from "./transport";
import type { CloseReason, NetEndpoint, RtcOptions } from "./transport";
import { rollDeg, screenAngle } from "./tilt-roll";

// ─── constants (phone-pad.js:35-63) ─────────────────────────────────────────

export const PROTO = 1;
/** A sample at least this often, moving or not. */
export const HEARTBEAT_MS = 100;
/** And at most ~66 Hz, the sensor's own rate. */
export const MIN_SAMPLE_GAP_MS = 15;
/** The dash refreshes ~15 Hz, like the game's own HUD tick. */
export const HUD_MS = 66;
/**
 * The desktop's freshness gate for a phone source: it heartbeats every 100 ms,
 * so six misses is gone. f1-game js/input/input.js:185 (the input lane's
 * constant, kept here beside the heartbeat it is measured against).
 */
export const REMOTE_STALE_MS = 700;
export const HELD = Object.freeze({ lookBack: 1 });
/** The edges the phone may send; each is a name `PhonePadInput.remoteEvent` knows. */
export const EVENTS = Object.freeze([
  "shiftUp", "shiftDown", "overtake", "boost", "aero",
  "camera", "recover", "radio", "calib", "pause",
  // The menu pad (desktop: input.js REMOTE_EDGES → the gamepad's nav seam).
  "navUp", "navDown", "navLeft", "navRight", "navSelect", "navBack",
] as const);
export type PadEventName = (typeof EVENTS)[number];
export type NavDir = "navUp" | "navDown" | "navLeft" | "navRight";
// A held direction repeats like a keyboard's (OS-style delay, then rate).
const NAV_REPEAT: Readonly<Partial<Record<PadEventName, 1>>> = Object.freeze({ navUp: 1, navDown: 1, navLeft: 1, navRight: 1 });
export const REPEAT_DELAY_MS = 380, REPEAT_RATE_MS = 110;
// Pedal ease, px of thumb slide: f1-game js/input/hold-buttons.js's PEDAL_* numbers.
const PEDAL_DEAD_PX = 12, PEDAL_TRAVEL_PX = 90, PEDAL_MIN = 0.12;
/** Dash flag bits (desktop → phone). */
export const DASH = Object.freeze({
  boost: 1, otArmed: 2, otActive: 4, xArmed: 8, xOpen: 16,
  retired: 32, timeTrial: 64, paused: 128, redline: 256,
  // The desktop's CONTROL MODES: what the wheel should not offer.
  gearsAuto: 512, throttleAuto: 1024, aeroAuto: 2048, aeroNone: 4096,
  // The SESSION, so the LCD does not paint a race position where there is none.
  quali: 8192, practice: 16384,
});

/** Number(v) as f1-game's `+v` (a cast, not a conversion change). */
const plus = (v: unknown): number => +(v as number);
/** ToInt32, as f1-game's `v | 0`. */
const i32 = (v: unknown): number => (v as number) | 0;
const round2 = (v: unknown): number => Math.round((plus(v) || 0) * 100) / 100;
const num = (v: unknown, lo: number, hi: number): number =>
  (typeof v === "number" && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : 0;
const isArr = (v: unknown): v is readonly unknown[] => Array.isArray(v);
const isEventName = (k: unknown): k is PadEventName => (EVENTS as readonly unknown[]).includes(k);
const TEAM_HEX = /^#[0-9a-f]{6}$/i;
const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ─── wire (phone-pad.js:65-132) ─────────────────────────────────────────────

/** What encodeSample reads; every field may be missing (it encodes as 0 / null). */
export interface SampleIn {
  readonly seq?: number;
  readonly roll?: number | null;
  readonly thr?: number;
  readonly brk?: number;
  readonly held?: number;
  readonly steer?: number | null;
}
/** A decoded, clamped sample. `steer` only on the v2 (touch strip) form. */
export interface PadSample {
  readonly steer?: number;
  readonly seq: number;
  readonly roll: number | null;
  readonly thr: number;
  readonly brk: number;
  readonly held: number;
}

/** STATE phone → desktop: [1, seq, roll|null, thr, brk, held], or v2 with a touch steer. phone-pad.js:69-73. */
export function encodeSample(s: SampleIn): string {
  const roll = (typeof s.roll === "number" && isFinite(s.roll)) ? round2(s.roll) : null;
  const touch = typeof s.steer === "number" && isFinite(s.steer);
  return JSON.stringify(touch
    ? [2, i32(s.seq), null, round2(s.thr), round2(s.brk), i32(s.held), num(s.steer, -1, 1)]
    : [PROTO, i32(s.seq), roll, round2(s.thr), round2(s.brk), i32(s.held)]);
}

/** phone-pad.js:74-84. */
export function decodeSample(text: unknown): PadSample | null {
  let a: unknown;
  try { a = JSON.parse(typeof text === "string" ? text : ""); } catch { return null; }
  if (!isArr(a) || !((a.length === 6 && a[0] === PROTO) ||
    (a.length === 7 && a[0] === 2 && typeof a[6] === "number" && isFinite(a[6])))) return null;
  return {
    ...(a[0] === 2 ? { steer: num(a[6], -1, 1) } : {}),
    seq: i32(a[1]),
    roll: (typeof a[2] === "number" && isFinite(a[2])) ? num(a[2], -180, 180) : null,
    thr: num(a[3], 0, 1), brk: num(a[4], 0, 1), held: i32(a[5]),
  };
}

/** The dash fields the desktop's sampler returns; anything missing encodes as 0 / "". */
export interface HudIn {
  readonly gear?: number;
  readonly kmh?: number;
  readonly rpm?: number;
  readonly lap?: number;
  readonly laps?: number;
  readonly pos?: number;
  readonly cars?: number;
  readonly ers?: number;
  readonly flags?: number;
  readonly caution?: number;
  readonly lastLapMs?: number;
  readonly state?: string;
  readonly team?: string;
}
/** A decoded, clamped dash packet. */
export interface PadHud {
  readonly gear: number;
  readonly kmh: number;
  readonly rpm: number;
  readonly lap: number;
  readonly laps: number;
  readonly pos: number;
  readonly cars: number;
  readonly ers: number;
  readonly flags: number;
  readonly caution: number;
  readonly lastLapMs: number;
  readonly state: string;
  readonly team: string;
}

/**
 * STATE desktop → phone: ["H", gear, kmh, rpmFrac, lap, laps, pos, cars, ers,
 * flags, caution, lastLapMs, state, teamHex]. Tagged "H" so decodeSample
 * refuses it and vice versa. phone-pad.js:85-93.
 */
export function encodeHud(h: HudIn | null | undefined): string | null {
  if (!h) return null;
  return JSON.stringify(["H", i32(h.gear), Math.round(plus(h.kmh) || 0), round2(h.rpm), i32(h.lap), i32(h.laps),
    i32(h.pos), i32(h.cars), round2(h.ers), i32(h.flags), i32(h.caution), Math.round(plus(h.lastLapMs) || 0),
    String(h.state || "").slice(0, 8), TEAM_HEX.test(h.team || "") ? h.team : ""]);
}

/** phone-pad.js:94-105. */
export function decodeHud(text: unknown): PadHud | null {
  let a: unknown;
  try { a = JSON.parse(typeof text === "string" ? text : ""); } catch { return null; }
  if (!isArr(a) || a.length !== 14 || a[0] !== "H") return null;
  return {
    gear: i32(num(a[1], -1, 9)), kmh: i32(num(a[2], 0, 999)), rpm: num(a[3], 0, 1),
    lap: i32(num(a[4], 0, 999)), laps: i32(num(a[5], 0, 999)), pos: i32(num(a[6], 0, 99)), cars: i32(num(a[7], 0, 99)),
    ers: num(a[8], 0, 1), flags: i32(num(a[9], 0, 65535)), caution: i32(num(a[10], 0, 4)),
    lastLapMs: i32(num(a[11], 0, 3.6e6)), state: String(a[12] || "").slice(0, 8),
    team: TEAM_HEX.test(String(a[13] || "")) ? String(a[13]) : "",
  };
}

export interface PadHello {
  readonly t: "hi";
  readonly side: string;
  readonly p: number;
  readonly haptics: boolean;
  readonly steer?: true;
  readonly ack?: true;
}
export type PadEvent =
  | { readonly t: "ev"; readonly k: PadEventName }
  | { readonly t: "hap"; readonly ms: number }
  | PadHello;

// EVENT channel: {t:"ev", k} phone→desktop; {t:"hap", ms} desktop→phone;
// {t:"hi", side, haptics, steer?, ack?} advertises additive capabilities.
// Accepted sample acknowledgements use STATE ["A", seq]; older peers ignore them.
/** phone-pad.js:109. */
export function encodeEvent(k: PadEventName): string { return JSON.stringify({ t: "ev", k }); }
/** phone-pad.js:110. */
export function encodeHaptic(ms: number): string { return JSON.stringify({ t: "hap", ms: Math.max(0, Math.min(1000, ms | 0)) }); }
/** phone-pad.js:111. */
export function encodeHello(side: "pad" | "host", haptics?: boolean, extended?: boolean): string {
  return JSON.stringify({ t: "hi", side, p: PROTO, haptics: haptics === true, ...(extended ? { steer: true, ack: true } : {}) });
}
/** phone-pad.js:112-120. */
export function decodeEvent(text: unknown): PadEvent | null {
  let parsed: unknown;
  try { parsed = JSON.parse(typeof text === "string" ? text : ""); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.t === "ev") return isEventName(o.k) ? { t: "ev", k: o.k } : null;
  if (o.t === "hap") return { t: "hap", ms: Math.max(0, Math.min(1000, i32(o.ms))) };
  if (o.t === "hi") {
    return { t: "hi", side: String(o.side || ""), p: i32(o.p), haptics: o.haptics === true,
      ...(o.steer === true ? { steer: true } : {}), ...(o.ack === true ? { ack: true } : {}) };
  }
  return null;
}

/** A TeamDef colour (three 0..1 floats) as the CSS hex the phone's LCD tints with. phone-pad.js:121-126. */
export function teamHex(c: unknown): string {
  if (!isArr(c) || c.length < 3) return "";
  const h = (v: unknown): string => Math.round(num(v, 0, 1) * 255).toString(16).padStart(2, "0");
  return "#" + h(c[0]) + h(c[1]) + h(c[2]);
}

/** mm:ss.mmm for the LAST lap readout; "" for no lap yet. phone-pad.js:127-132. */
export function fmtLap(ms: number): string {
  if (!(ms > 0)) return "";
  const m = Math.floor(ms / 60000), s = (ms - m * 60000) / 1000;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(3);
}

// ─── pairing URL (phone-pad.js:134-168) ─────────────────────────────────────

/** A private relay endpoint fit for the QR: https (or http on localhost), no credentials, query or fragment. */
export function relayUrl(value: unknown): string | null {
  try {
    const u = new URL(value as string), local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.username || u.password || u.search || u.hash || !(u.protocol === "https:" || (u.protocol === "http:" && local))) return null;
    return u.href.replace(/\/+$/, "");
  } catch { return null; }
}

/**
 * The URL the QR carries: controller.html beside the page, the code in the
 * FRAGMENT (it never reaches a server log), a private relay beside it.
 */
export function padUrl(code: string | null, base?: string | null, relay?: string | null): string {
  let root = base;
  if (!root) {
    try { root = location.origin + location.pathname; } catch { root = ""; }
  }
  root = String(root).replace(/[^/]*$/, ""); // …/index.html → …/
  const endpoint = relay ? relayUrl(relay) : null;
  if (relay && !endpoint) throw new Error("Invalid private pairing relay URL");
  return root + "controller.html#pad=" + encodeURIComponent(String(code)) + (endpoint ? "&relay=" + encodeURIComponent(endpoint) : "");
}

/** The room code in `href` (default: this document's fragment), or null. */
export function codeFromUrl(href?: unknown): string | null {
  try {
    const h = (href != null ? String(href) : location.hash) || "";
    const m = h.match(/[#&]pad=([^&\s]+)/);
    return m && m[1] !== undefined ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

export interface Pairing {
  readonly code: string;
  /** The private relay the QR named, validated; null for public signalling. */
  readonly relay: string | null;
  /** A `relay=` was present but is not a usable endpoint. */
  readonly invalid: boolean;
}

/** The code plus the relay URL beside it in the fragment. */
export function pairingFromUrl(href?: unknown): Pairing | null {
  const code = codeFromUrl(href);
  if (!code) return null;
  try {
    const text = href != null ? String(href) : location.hash;
    const m = text.slice(text.indexOf("#")).match(/(?:^#|&)relay=([^&]*)/);
    const relay = m && m[1] !== undefined ? relayUrl(decodeURIComponent(m[1])) : null;
    return { code, relay, invalid: !!m && !relay };
  } catch { return { code, relay: null, invalid: true }; }
}

// ─── desktop: the focus ring the phone moves (phone-pad.js:170-211) ─────────
// The D-pad reaches the menus as SYNTHETIC arrow keys, and whether the browser
// DRAWS the focus it moves is its own heuristic (no :focus-visible after a
// scripted focus on Safari, no :focus while the window is not focused — the
// sofa case). So the phone's focus wears .pad-ring from the first phone nav
// until a real pointer or key on the desktop takes over.

export interface RingEvent {
  readonly target?: unknown;
  readonly isTrusted?: boolean;
}
/** The slice of Document the ring touches; a real Document satisfies it. */
export interface RingDoc {
  readonly body?: unknown;
  readonly documentElement?: unknown;
  readonly activeElement?: unknown;
  addEventListener(type: string, fn: (e: RingEvent) => void, capture: boolean): void;
  removeEventListener(type: string, fn: (e: RingEvent) => void, capture: boolean): void;
}
interface RingNode {
  readonly classList: { add(c: string): void; remove(c: string): void };
}
interface Ring {
  arm(): void;
  sync(): void;
  stop(): void;
}

function ringer(doc: RingDoc | null): Ring | null {
  if (!doc || typeof doc.addEventListener !== "function") return null;
  let el: RingNode | null = null, phone = false;
  const set = (n: unknown): void => {
    if (el === n) return;
    if (el && el.classList) el.classList.remove("pad-ring");
    el = n && n !== doc.body && n !== doc.documentElement && (n as Partial<RingNode>).classList ? n as RingNode : null;
    if (el) el.classList.add("pad-ring");
  };
  const onIn = (e: RingEvent): void => { if (phone) set(e.target); };
  const onOut = (e: RingEvent): void => {
    if (e.target !== el) return;
    setTimeout(() => { if (el && doc.activeElement !== el) set(null); }, 0);
  };
  const local = (e: RingEvent): void => { if (e.isTrusted === false) return; phone = false; set(null); };
  doc.addEventListener("focusin", onIn, true);
  doc.addEventListener("focusout", onOut, true);
  doc.addEventListener("pointerdown", local, true);
  doc.addEventListener("keydown", local, true);
  return {
    arm() { phone = true; },
    sync() { if (phone) set(doc.activeElement); },
    stop() {
      set(null);
      doc.removeEventListener("focusin", onIn, true);
      doc.removeEventListener("focusout", onOut, true);
      doc.removeEventListener("pointerdown", local, true);
      doc.removeEventListener("keydown", local, true);
    },
  };
}

// ─── desktop: the transport-level half (phone-pad.js:213-304) ───────────────

/** The slice of a NetEndpoint both halves use. */
export type PadTransport = Pick<NetEndpoint, "status" | "onMessage" | "onOpen" | "onClose" | "send" | "pump" | "close">;
/** What the pairing flows hand to the handshake: a transport plus (for rtc) its RTCPeerConnection. */
export type PairTransport = PadTransport & HasPc;

/** A sample as the desktop's input receives it: tagged with its source. */
export interface RemoteSample extends PadSample {
  readonly source: "phone";
}

/**
 * What the desktop half needs of the game's input. In f1-game this is the
 * global `Input` (js/input/input.js:349-432), reached at phone-pad.js:219,
 * 231, 243, 252, 258, 267-268; here it is passed in explicitly.
 *
 * TODO(lane-shell): the input lane implements this and wires it into
 * `link(…, { input })` / `host(ui, { input })`:
 *  - remoteSample(s): write `s.roll` (degrees, null = no sensor) into the SAME
 *    tilt pipeline the local sensor feeds (raw + One-Euro smoothed, so every
 *    TILT slider and RECALIBRATE act on the phone), take `s.thr`/`s.brk`
 *    (0..1 pedal travel) and `s.held` (HELD bits; lookBack = 1), treat a
 *    `s.steer` (-1..1) as a direct stick command with no tilt filter, stamp
 *    the source fresh, and let it fall out of steer() after REMOTE_STALE_MS of
 *    silence. Return false to refuse the sample (no ACK is sent for it).
 *  - remoteEvent(k): one EDGE per call: shiftUp/shiftDown/overtake/boost/aero/
 *    camera/recover/radio as the pad's pressed flags, calib → recalibrate,
 *    pause → the game's pause callback, and the menu pad navUp/navDown/
 *    navLeft/navRight → padNavKey(dir), navSelect → padActivate(),
 *    navBack → padEscape() (f1-game input.js REMOTE_EDGES:388-410).
 *  - remoteLost(source): pedals, held bits and the remote roll off at once.
 *  - setRemoteHaptics(fn | null): while set, the game's vibrate(ms) forwards
 *    to fn(ms) (after its own strength scaling); null = no phone motor.
 */
export interface PhonePadInput {
  remoteSample(s: RemoteSample): boolean | void;
  remoteEvent(k: PadEventName): unknown;
  remoteLost(source: "phone"): unknown;
  setRemoteHaptics(fn: ((ms: number) => boolean) | null): void;
}

export interface LinkOptions {
  readonly input: PhonePadInput;
  /** Test seam: the clock every pump passes to the transport. */
  readonly now?: (() => number) | null;
  /** false: no rAF of its own; the caller pumps. */
  readonly pump?: boolean;
  /** The dash sampler (null = nothing to show). */
  readonly hud?: (() => HudIn | null | undefined) | null;
  /** The document whose focus the phone moves (default: the global one). */
  readonly doc?: RingDoc | null;
  readonly onOpen?: () => void;
  readonly onClose?: (why?: CloseReason) => void;
}
export interface LinkStats {
  readonly samples: number;
  readonly events: number;
  readonly stale: number;
  readonly junk: number;
  readonly huds: number;
  readonly lastSeq: number;
  readonly open: boolean;
}
export interface PadLink {
  pump(): number;
  close(): void;
  stats(): LinkStats;
}

/** Wires an OPEN (or opening) transport to the desktop's input and streams the dash back. */
export function link(transport: PadTransport, opts: LinkOptions): PadLink {
  const input = opts.input;
  const T = { STATE, EVENT } as const;
  // A clock on every pump: rtc ignores it, loopback schedules by it.
  const now = opts.now || clock;
  let lastSeq = -1, ackAt = -1e9, peerAck = false, helloPending = false;
  let samples = 0, events = 0, stale = 0, junk = 0, huds = 0;
  let closed = false;
  let raf = 0;
  let hudAt = -1e9;
  const ring = ringer(opts.doc !== undefined ? opts.doc : (typeof document !== "undefined" ? document as unknown as RingDoc : null));
  input.setRemoteHaptics(null); // clear the previous peer before any hello can arrive

  transport.onMessage((channel, data) => {
    if (closed) return;
    if (channel === T.STATE) {
      const s = decodeSample(data);
      if (!s) { junk++; return; }
      // Unordered channel: an older sample after a newer one is thrown away,
      // never applied — it would steer the car back where the phone was.
      if (s.seq <= lastSeq && lastSeq - s.seq < 30000) { stale++; return; }
      lastSeq = s.seq;
      samples++;
      const accepted = input.remoteSample({ source: "phone", ...s });
      if (accepted !== false && peerAck && now() - ackAt >= HEARTBEAT_MS) { ackAt = now(); transport.send(T.STATE, JSON.stringify(["A", s.seq])); }
      return;
    }
    const ev = decodeEvent(data);
    if (!ev) { junk++; return; }
    if (ev.t === "hi" && ev.side === "pad" && ev.p === PROTO) {
      peerAck = !!ev.ack;
      helloPending = !transport.send(T.EVENT, encodeHello("host", false, true));
      input.setRemoteHaptics(ev.haptics ? (ms) => transport.send(T.EVENT, encodeHaptic(ms)) : null);
    }
    if (ev.t === "ev") {
      events++;
      const nav = ev.k.startsWith("nav") && ring;
      if (nav) ring.arm();
      input.remoteEvent(ev.k);
      if (nav) ring.sync();
    }
  });
  const onClose = (why?: CloseReason): void => {
    if (closed) return;
    closed = true;
    if (ring) ring.stop();
    if (raf) { try { cancelAnimationFrame(raf); } catch { /* no rAF here */ } raf = 0; }
    input.remoteLost("phone");
    input.setRemoteHaptics(null);
    if (opts.onClose) { try { opts.onClose(why); } catch { /* caller's problem */ } }
  };
  transport.onClose(onClose);

  const armed = (): void => {
    if (closed) return;
    helloPending = !transport.send(T.EVENT, encodeHello("host", false, true));
    if (opts.onOpen) { try { opts.onOpen(); } catch { /* caller's problem */ } }
  };
  if (transport.status === "open") armed(); else transport.onOpen(armed);

  // The dash: sampled and sent from the same pump, ~15 Hz, unreliable — a
  // dropped frame is replaced 66 ms later, so nothing is worth a retransmit.
  function sendHud(t: number): void {
    if (!opts.hud || transport.status !== "open" || t - hudAt < HUD_MS) return;
    hudAt = t;
    let h: HudIn | null | undefined = null;
    try { h = opts.hud(); } catch { h = null; }
    const text = encodeHud(h);
    if (text && transport.send(T.STATE, text)) huds++;
  }
  // Samples land in the transport's inbox and reach the input only on pump():
  // once a frame, ahead of the game loop's own poll. An rAF of its own does
  // the pumping; a test pumps by hand with pump: false.
  const pump = (): number => {
    const t = now();
    const n = transport.pump(t);
    if (helloPending) helloPending = !transport.send(T.EVENT, encodeHello("host", false, true));
    sendHud(t);
    return n;
  };
  if (opts.pump !== false && typeof requestAnimationFrame === "function") {
    const tick = (): void => { if (closed) return; pump(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
  }
  return {
    pump,
    close() { try { transport.close(); } catch { /* already closed */ } onClose(); },
    stats: () => ({ samples, events, stale, junk, huds, lastSeq, open: !closed && transport.status === "open" }),
  };
}

// ─── desktop: the whole pairing flow, with signalling (phone-pad.js:306-476) ─

/** A failed step of the pairing, as the handshake / rendezvous report one. */
export interface PadFail {
  readonly ok: false;
  readonly error?: string;
  readonly message?: string;
  readonly advisory?: boolean;
}
export type InviteLike = { readonly ok: true; readonly code: string } | PadFail;
export type AnswerLike = { readonly ok: true } | PadFail;
export type SwapLike = { readonly ok: true; readonly payload?: string } | PadFail;
/** What hostRoom resolves to: a subscription (stop, its timing) or a failure. */
export interface HostRoomLike {
  readonly ok: boolean;
  readonly error?: string;
  readonly message?: string;
  readonly startedAt?: number;
  readonly deadlineAt?: number;
  stop?(): void;
}

export type HostPhase = "idle" | "preparing" | "waiting" | "connecting" | "linked" | "lost" | "cancelled" | "failed";
export interface HostRecovery {
  readonly phase: HostPhase;
  readonly reconnecting: boolean;
  readonly publicRelay: boolean;
  readonly startedAt: number | null;
  readonly deadlineAt: number | null;
}

/** The page's side of the desktop flow (f1-game js/ui/platform-session.js implements it). */
export interface HostUi {
  say?(text: string, bad: boolean): void;
  /** null hides the QR. */
  qr?(url: string | null, code: string | null): void;
  linked?(): void;
  lost?(): void;
  /** A linked phone dropped and the room is open again for it. */
  relinking?(): void;
  /** A first pairing failed; the page restores its button. */
  failed?(): void;
  recovery?(r: HostRecovery): void;
  /** The dash sampler handed to link(). */
  readonly hud?: (() => HudIn | null | undefined) | null;
}

export interface HostDeps {
  /** The desktop's input (f1-game: the global `Input`). Required. */
  readonly input: PhonePadInput;
  rtc(o: RtcOptions): PairTransport | null;
  prefetchIce(): Promise<unknown>;
  createInvite(t: PairTransport, profile: { pad: number }): Promise<InviteLike>;
  acceptAnswer(t: PairTransport, code: string): Promise<AnswerLike>;
  hostRoom(o: HostRoomOptions): Promise<HostRoomLike | null | undefined>;
  usingPrivateRelay(): boolean;
  relayUrl(): string | null;
  swap(o: SwapOptions): Promise<SwapLike>;
  makeCode(): string | null;
}

export interface HostState {
  readonly phase: HostPhase;
  readonly code: string | null;
  readonly recovery: HostRecovery;
  readonly stats: LinkStats | null;
}
export interface HostController {
  cancel(): void;
  state(): HostState;
}

/** The desktop pairing flow: mint, QR, wait, link, re-link on a dropped wire. phone-pad.js:311-476. */
export function host(ui: HostUi | null | undefined, depsIn: Partial<HostDeps> & { readonly input: PhonePadInput }): HostController {
  const u: HostUi = ui || {};
  const deps: HostDeps = {
    rtc: (o) => NetTransport.rtc(o),
    prefetchIce: () => NetTransport.prefetchIce(),
    createInvite: (t, p) => NetHandshake.createInvite(t, p),
    acceptAnswer: (t, c) => NetHandshake.acceptAnswer(t, c),
    hostRoom: (o) => NetRendezvous.hostRoom(o),
    usingPrivateRelay: () => NetRendezvous.usingPrivateRelay(),
    relayUrl: () => NetRendezvous.baseUrl(),
    swap: (o) => NetRendezvous.swap(o),
    makeCode: () => NetRendezvous.makeCode(),
    ...depsIn,
  };
  const say = (t: string, bad?: boolean): void => { if (u.say) { try { u.say(t, !!bad); } catch { /* ui's problem */ } } };
  const qr = (url: string | null, code: string | null): void => { if (u.qr) { try { u.qr(url, code); } catch { /* ui's problem */ } } };
  let phase: HostPhase = "idle";
  let transport: PairTransport | null = null, room: HostRoomLike | null = null, active: PadLink | null = null;
  let token = { cancelled: false };
  let code: string | null = null;
  // RE-LINK (R3-PHONE-3): a linked phone whose WIRE died (any close but the
  // phone's own "peer" goodbye) gets the SAME code hosted again for the room's
  // own lifetime, and the phone dials it again by itself. A private relay's
  // one mailbox is not reusable.
  let relink = false, roomTiming: { startedAt: number; deadlineAt: number } | null = null;
  const recoveryState = (): HostRecovery => ({
    phase, reconnecting: relink && ["preparing", "waiting", "connecting"].includes(phase), publicRelay: !deps.usingPrivateRelay(),
    startedAt: roomTiming ? roomTiming.startedAt : null, deadlineAt: roomTiming ? roomTiming.deadlineAt : null,
  });
  function recoveryChanged(): void { if (u.recovery) { try { u.recovery(recoveryState()); } catch { /* ui's problem */ } } }
  // A failed pairing takes its dead QR down and releases the pending transport (#2198).
  function failed(msg: string): void {
    phase = "failed"; roomTiming = null; recoveryChanged(); say(msg, true);
    dropRoom();
    if (!active && transport) { try { transport.close(); } catch { /* never opened */ } }
    transport = null;
    qr(null, null);
    if (relink) { relink = false; netLog.info("phone pad re-link gave up"); if (u.lost) { try { u.lost(); } catch { /* ui's problem */ } } }
    else if (u.failed) { try { u.failed(); } catch { /* ui's problem */ } }
  }

  function dropRoom(): void {
    token.cancelled = true;
    if (room && room.stop) { try { room.stop(); } catch { /* already stopped */ } }
    room = null; roomTiming = null; recoveryChanged();
  }
  function cancel(): void {
    if (phase === "cancelled") return;
    phase = "cancelled";
    dropRoom();
    if (active) { active.close(); active = null; }
    else if (transport) { try { transport.close(); } catch { /* already closed */ } }
    transport = null;
    qr(null, null);
    netLog.info("phone pad cancelled");
  }

  // `phase` is re-read after every await: cancel() may land in between.
  const stillIs = (p: HostPhase): boolean => phase === p;
  const open = async (): Promise<void> => {
    try {
      phase = "preparing";
      token = { cancelled: false };
      say(relink ? "Phone link lost — waiting for it to reconnect…" : "Preparing… (this can take a few seconds)");
      await deps.prefetchIce();
      if (!stillIs("preparing")) return;
      const t = transport = deps.rtc({ role: "host", name: "pad" });
      if (!t) { failed("WebRTC is unavailable in this browser."); return; }
      const invite = await deps.createInvite(t, { pad: PROTO });
      if (!stillIs("preparing")) return;
      if (!invite.ok) { failed(invite.message || "Could not prepare the pairing."); return; }
      if (!relink) code = deps.makeCode();
      const url = padUrl(code, null, deps.usingPrivateRelay() ? deps.relayUrl() : null);
      phase = "waiting";
      qr(url, code);
      say("Scan the code with your phone's camera, or open the link and type the room code.");
      let accepted = false;
      const onTick = (): void => {
        recoveryChanged();
        if (stillIs("waiting")) say(relink ? "Phone link lost — reconnecting. Use MAKE NEW CODE if needed." : "Waiting for your phone… (room code " + code + ")");
      };
      const onFail = (r: PadFail | null | undefined): void => {
        if (!r || r.error === "cancelled" || r.error === "stopped" || !["waiting", "connecting"].includes(phase)) return;
        if (r.advisory) { say(r.message as string, true); return; }
        // nostr's expiry copy is VS FRIEND's ("Check the six characters…").
        failed(r.error === "expired" ? "The code expired — press STEER THIS GAME WITH A PHONE for a new one."
          : r.message || "The room service went away — try again.");
      };
      const onJoiner = async (_who: null, answer: string): Promise<void> => {
        if (accepted || !stillIs("waiting")) return;
        accepted = true;
        phase = "connecting";
        say("Phone found — connecting…");
        const acc = await deps.acceptAnswer(t, answer);
        if (!stillIs("connecting")) return;
        if (!acc.ok) {
          const msg = acc.message || "That answer could not be read.";
          if (deps.usingPrivateRelay()) failed(msg);
          else { accepted = false; phase = "waiting"; say(msg, true); }
          return;
        }
        active = link(t, {
          input: deps.input,
          hud: u.hud || null,
          onOpen: () => {
            phase = "linked"; relink = false;
            dropRoom();
            qr(null, null);
            say("Phone connected — tilt to steer. RECALIBRATE TILT levels it.");
            netLog.info("phone pad linked");
            if (u.linked) { try { u.linked(); } catch { /* ui's problem */ } }
          },
          onClose: (why) => {
            if (stillIs("cancelled")) return;
            const wasLinked = stillIs("linked");
            // A link that died before it opened (ICE failed) still holds the
            // room's relay sockets; nothing will use them now.
            dropRoom();
            if (wasLinked && why !== "peer" && !deps.usingPrivateRelay()) {
              relink = true; active = null; transport = null;
              netLog.info("phone pad dropped (" + why + ") — hosting again");
              if (u.relinking) { try { u.relinking(); } catch { /* ui's problem */ } }
              void open();
              return;
            }
            phase = "lost";
            say("Phone disconnected — press STEER THIS GAME WITH A PHONE for a new code.", true);
            netLog.info("phone pad lost");
            if (u.lost) { try { u.lost(); } catch { /* ui's problem */ } }
          },
        });
      };
      const roomOptions: HostRoomOptions = {
        code: code as string, mine: invite.code, token, onTick, onFail,
        mintOffer: async () => null, // one phone; a second scan gets nothing
        onJoiner,
      };
      // A private relay has one offer/answer mailbox, exactly what one phone
      // needs. hostRoom is the public relay's multi-guest subscription only.
      if (deps.usingPrivateRelay()) {
        const got = await deps.swap({ code: code as string, mine: invite.code, slot: "offer", want: "answer", token, onTick });
        if (!stillIs("waiting")) return;
        if (got.ok) await onJoiner(null, got.payload as string);
        if (stillIs("waiting")) {
          if (!got.ok) onFail(got);
          else failed("Could not connect that phone — try a new code.");
        }
        return;
      }
      const sub = await deps.hostRoom(roomOptions);
      if (!["waiting", "connecting"].includes(phase)) {
        if (sub && sub.stop) { try { sub.stop(); } catch { /* already stopped */ } }
        return;
      }
      if (!sub || !sub.ok) {
        if (stillIs("waiting")) failed((sub && sub.message) || "Could not open a room — check the connection.");
        return;
      }
      room = sub;
      roomTiming = Number.isFinite(sub.startedAt) && Number.isFinite(sub.deadlineAt) && (sub.deadlineAt as number) >= (sub.startedAt as number)
        ? { startedAt: sub.startedAt as number, deadlineAt: sub.deadlineAt as number } : null;
      recoveryChanged();
    } catch (e) {
      netLog.warn("phone pad host failed: " + ((e instanceof Error && e.message) || String(e)));
      if (!stillIs("cancelled")) {
        dropRoom();
        if (transport) { try { transport.close(); } catch { /* failed startup */ } transport = null; }
        failed("Pairing failed — try again.");
      }
    }
  };
  void open();

  return { cancel, state: () => ({ phase, code, recovery: recoveryState(), stats: active ? active.stats() : null }) };
}

// ─── phone: the transport-level half (phone-pad.js:478-576) ─────────────────

/** The sensor and button state the page keeps; padSession reads it on every send. */
export interface PadSource {
  roll(): number | null;
  thr(): number;
  brk(): number;
  held(): number;
  /** The touch strip's command (-1..1), or null while tilt steers. */
  steer?(): number | null;
}
export type PadHealthState = "unavailable" | "reconnecting" | "waiting" | "degraded" | "good";
export interface PadHealth {
  readonly state: PadHealthState;
  /** Sender-clock age of the newest acknowledged sample; null before the first ACK. */
  readonly ageMs: number | null;
  /** The game advertised touch-strip steering (v2 samples). */
  readonly touchSupported: boolean;
}
export interface PadSessionOptions {
  readonly now?: (() => number) | null;
  /** false: no 100 ms heartbeat interval (tests pump by hand). */
  readonly heartbeat?: boolean;
  readonly vibrate?: (ms: number) => void;
  readonly onHud?: (h: PadHud) => void;
  readonly onOpen?: () => void;
  readonly onClose?: (why?: CloseReason) => void;
  readonly onHealth?: (h: PadHealth) => void;
  readonly onCapabilities?: (c: { readonly touchSupported: boolean }) => void;
}
export interface PadSessionStats {
  readonly sent: number;
  readonly haptics: number;
  readonly huds: number;
  readonly seq: number;
  readonly queued: number;
  readonly expired: number;
  readonly rejected: number;
  readonly health: PadHealth;
  readonly open: boolean;
}
export interface PadSession {
  /** A pedal or button CHANGE is sent at once (force); the sensor stream keeps the 15 ms gap. */
  sample(force?: boolean): boolean;
  event(k: string): boolean;
  pump(): number;
  health(): PadHealth;
  close(): void;
  stats(): PadSessionStats;
}

function unrefTimer(t: unknown): void {
  const u = t as { unref?: unknown } | null;
  if (u && typeof u.unref === "function") (u as { unref(): void }).unref();
}

/** Streams samples and edges over an open transport. phone-pad.js:484-576. */
export function padSession(transport: PadTransport, src: PadSource, opts: PadSessionOptions = {}): PadSession {
  const T = { STATE, EVENT } as const;
  const now = opts.now || clock;
  let seq = 0, lastSent = -1e9, sent = 0, haptics = 0, huds = 0, closed = false;
  let beat: ReturnType<typeof setInterval> | 0 = 0, helloPending = false, peerSteer = false, peerAck = false, ackAt = -1, openedAt = now();
  const pending: { k: PadEventName; at: number }[] = [], sentTimes = new Map<number, number>();
  const EDGE_MAX_AGE_MS = 1200, NAV_MAX_AGE_MS = 250, EDGE_CAP = 24;
  let expired = 0, rejected = 0, healthState: PadHealthState = "unavailable";
  const canVibrate = (): boolean => typeof opts.vibrate === "function" ||
    (typeof navigator !== "undefined" && typeof navigator.vibrate === "function" && navigator.maxTouchPoints > 0);
  function flush(): void {
    if (closed || transport.status !== "open") return;
    if (helloPending) helloPending = !transport.send(T.EVENT, encodeHello("pad", canVibrate(), true));
    while (pending.length) {
      const edge = pending[0] as { k: PadEventName; at: number };
      if (now() - edge.at > (NAV_REPEAT[edge.k] ? NAV_MAX_AGE_MS : EDGE_MAX_AGE_MS)) { pending.shift(); expired++; continue; }
      if (!transport.send(T.EVENT, encodeEvent(edge.k))) break;
      pending.shift();
    }
  }
  // Sender-clock age of a sample the desktop acknowledged accepting. HUD
  // receipt alone says nothing about whether the upstream input arrived.
  function health(): PadHealth {
    const age = ackAt < 0 ? now() - openedAt : now() - ackAt;
    healthState = !peerAck ? "unavailable" : age > 1500 ? "reconnecting" : ackAt < 0 ? "waiting" : age > 400 ? "degraded"
      : age < 250 ? "good" : healthState === "good" ? "good" : "degraded";
    return { state: healthState, ageMs: ackAt < 0 ? null : Math.max(0, age), touchSupported: peerSteer };
  }
  const vibrate = opts.vibrate || ((ms: number): void => {
    try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(ms); } catch { /* advisory */ }
  });

  function send(force: boolean): boolean {
    if (closed || transport.status !== "open") return false;
    const t = now();
    if (!force && t - lastSent < MIN_SAMPLE_GAP_MS) return false;
    lastSent = t;
    const ok = transport.send(T.STATE, encodeSample({
      seq: seq++, roll: src.roll(), thr: src.thr(), brk: src.brk(), held: src.held(),
      ...(peerSteer && src.steer && src.steer() != null ? { steer: src.steer() } : {}),
    }));
    if (ok) {
      sent++; sentTimes.set(seq - 1, t);
      while (sentTimes.size > 128) { const first = sentTimes.keys().next(); if (first.done) break; sentTimes.delete(first.value); }
    }
    return ok;
  }
  function event(k: string): boolean {
    if (closed || !isEventName(k) || transport.status !== "open") return false;
    flush();
    if (NAV_REPEAT[k] && pending.some((e) => e.k === k)) return true;
    if (pending.length >= EDGE_CAP) { rejected++; return false; }
    pending.push({ k, at: now() }); flush();
    return true;
  }
  transport.onMessage((channel, data) => {
    if (closed) return;
    if (channel === T.STATE) {
      let ack: unknown;
      try { ack = JSON.parse(data as string); } catch { ack = null; }
      if (peerAck && isArr(ack) && ack[0] === "A" && Number.isInteger(ack[1]) && sentTimes.has(ack[1] as number)) {
        const at = ack[1] as number;
        ackAt = sentTimes.get(at) as number;
        for (const key of sentTimes.keys()) if (key <= at) sentTimes.delete(key);
      }
      const h = decodeHud(data);
      if (h && opts.onHud) { huds++; try { opts.onHud(h); } catch { /* page's problem */ } }
      return;
    }
    const ev = decodeEvent(data);
    if (ev && ev.t === "hi" && ev.side === "host" && ev.p === PROTO) {
      peerSteer = !!ev.steer; peerAck = !!ev.ack;
      if (opts.onCapabilities) opts.onCapabilities({ touchSupported: peerSteer });
    }
    if (ev && ev.t === "hap" && ev.ms > 0) { haptics++; vibrate(ev.ms); }
  });
  const close = (why?: CloseReason): void => {
    if (closed) return;
    closed = true; pending.length = 0; sentTimes.clear();
    if (beat) { clearInterval(beat); beat = 0; }
    if (opts.onClose) { try { opts.onClose(why); } catch { /* page's problem */ } }
  };
  transport.onClose(close);
  const armed = (): void => {
    if (closed) return;
    openedAt = now();
    helloPending = true; flush();
    if (opts.heartbeat !== false) {
      beat = setInterval(() => { flush(); send(true); if (opts.onHealth) opts.onHealth(health()); }, HEARTBEAT_MS);
      unrefTimer(beat); // node harness: never the thing keeping the process alive
    }
    if (opts.onOpen) { try { opts.onOpen(); } catch { /* page's problem */ } }
  };
  if (transport.status === "open") armed(); else transport.onOpen(armed);
  return {
    sample: (force) => send(!!force),
    event,
    pump: () => { const n = transport.pump(now()); flush(); if (opts.onHealth) opts.onHealth(health()); return n; },
    health,
    close() { try { transport.close(); } catch { /* already closed */ } close("local"); },
    stats: () => ({ sent, haptics, huds, seq, queued: pending.length, expired, rejected, health: health(), open: !closed && transport.status === "open" }),
  };
}

// ─── phone: the wheel's LCD (phone-pad.js:578-624) ──────────────────────────

interface TextNode { textContent: string | null }
interface ToggleNode { readonly classList: { toggle(c: string, on?: boolean): unknown } }
/**
 * The LCD elements controller.html hands over. Structural, so real elements
 * and a test's stand-ins both fit. `body` takes the LAYOUT classes
 * (gears-auto / throttle-auto / aero-auto / aero-none / menu).
 */
export interface HudEls {
  readonly gear?: TextNode | null;
  readonly speed?: TextNode | null;
  readonly lap?: TextNode | null;
  readonly pos?: TextNode | null;
  readonly last?: TextNode | null;
  readonly ot?: TextNode | null;
  readonly aero?: TextNode | null;
  readonly flag?: TextNode | null;
  readonly mtitle?: TextNode | null;
  readonly ers?: { readonly style: { width: string } } | null;
  readonly leds?: { readonly children: ArrayLike<ToggleNode> } | null;
  readonly screen?: ToggleNode | null;
  readonly team?: { readonly style: { setProperty(k: string, v: string): void } } | null;
  readonly body?: ToggleNode | null;
}
type HudTextKey = "gear" | "speed" | "lap" | "pos" | "last" | "ot" | "aero" | "flag" | "mtitle";

const CAUTION = ["", "YELLOW", "VSC", "SAFETY CAR", "RED FLAG"];
/** Paints one dash packet into the wheel's LCD. Pure DOM writes. phone-pad.js:586-624. */
export function paintHud(el: HudEls | null | undefined, h: PadHud | null | undefined): void {
  if (!el || !h) return;
  const text = (n: HudTextKey, v: string): void => { const node = el[n]; if (node && node.textContent !== v) node.textContent = v; };
  const inRace = h.state === "race" || h.state === "count";
  text("gear", h.gear === 0 ? "N" : h.gear < 0 ? "R" : String(h.gear));
  text("speed", inRace ? String(h.kmh) : "---");
  text("lap", h.flags & DASH.timeTrial ? "TT" : h.laps ? "LAP " + Math.min(Math.max(h.lap, 1), h.laps) + "/" + h.laps : "");
  text("pos", h.flags & DASH.retired ? "DNF" : h.flags & DASH.timeTrial ? "" : h.flags & DASH.quali ? "Q"
    : h.flags & DASH.practice ? "PRAC" : h.pos ? "P" + h.pos + "/" + h.cars : "");
  text("last", h.lastLapMs ? "LAST " + fmtLap(h.lastLapMs) : "");
  text("ot", h.flags & DASH.otActive ? "OVERTAKE" : h.flags & DASH.otArmed ? "OT READY" : "OT");
  text("aero", h.flags & DASH.aeroNone ? "NO ZONES" : h.flags & DASH.aeroAuto ? (h.flags & DASH.xOpen ? "AUTO STRAIGHT" : "AERO AUTO")
    : h.flags & DASH.xOpen ? "STRAIGHT MODE" : h.flags & DASH.xArmed ? "AERO ARMED" : "AERO");
  text("flag", h.state === "count" ? "LIGHTS" : h.flags & DASH.paused ? "PAUSED" : !inRace ? "MENU" : CAUTION[h.caution] || "");
  text("mtitle", h.flags & DASH.paused ? "PAUSED" : "MENU"); // the pad screen's title (controller.html #mp-title)
  if (el.ers && el.ers.style) el.ers.style.width = (h.ers * 100).toFixed(0) + "%";
  if (el.leds && el.leds.children) {
    const n = el.leds.children.length, lit = Math.round(h.rpm * n);
    for (let i = 0; i < n; i++) el.leds.children[i]?.classList.toggle("on", inRace && i < lit);
  }
  if (el.screen && el.screen.classList) {
    el.screen.classList.toggle("redline", !!(h.flags & DASH.redline));
    el.screen.classList.toggle("boost", !!(h.flags & DASH.boost));
    el.screen.classList.toggle("ot-on", !!(h.flags & DASH.otActive));
    el.screen.classList.toggle("ot-ready", !!(h.flags & DASH.otArmed) && !(h.flags & DASH.otActive));
    el.screen.classList.toggle("x-open", !!(h.flags & DASH.xOpen));
    el.screen.classList.toggle("caution", inRace && h.caution > 0);
    el.screen.classList.toggle("idle", !inRace);
  }
  if (el.team && el.team.style && h.team) el.team.style.setProperty("--team", h.team);
  if (el.body && el.body.classList) {
    el.body.classList.toggle("gears-auto", !!(h.flags & DASH.gearsAuto));
    el.body.classList.toggle("throttle-auto", !!(h.flags & DASH.throttleAuto));
    el.body.classList.toggle("aero-auto", !!(h.flags & DASH.aeroAuto));
    el.body.classList.toggle("aero-none", !!(h.flags & DASH.aeroNone));
    // THE MENU PAD: out of a race, or paused inside one, the page swaps the
    // wheel for a D-pad, SELECT and BACK (controller.html #menupad).
    el.body.classList.toggle("menu", !inRace || !!(h.flags & DASH.paused));
  }
}

// ─── phone: the whole page (phone-pad.js:626-1168) ──────────────────────────

type ButtonSlot = HTMLElement | (HTMLElement | null)[] | null;
/**
 * Every element controller.html hands over; this module never looks an id up.
 * Missing elements are skipped, as in f1-game.
 */
export interface PadDom {
  readonly body?: HTMLElement | null;
  readonly status?: HTMLElement | null;
  readonly codeIn?: HTMLInputElement | null;
  readonly connect?: HTMLButtonElement | null;
  readonly gas?: HTMLElement | null;
  readonly brake?: HTMLElement | null;
  readonly lookBack?: HTMLElement | null;
  readonly center?: HTMLElement | null;
  readonly rim?: HTMLElement | null;
  /** The touch steering strip (role=slider). */
  readonly steer?: HTMLElement | null;
  readonly steeringMode?: HTMLSelectElement | null;
  readonly health?: HTMLElement | null;
  readonly healthAge?: HTMLElement | null;
  /** An action may have more than one button (OT on the grip AND on the face). */
  readonly buttons?: Partial<Record<PadEventName, ButtonSlot>> | null;
  readonly hud?: HudEls | null;
  /** The menu stick: the disc, its nub and the four painted arrows. */
  readonly stick?: HTMLElement | null;
  readonly nub?: HTMLElement | null;
  readonly arrows?: Partial<Record<NavDir, HTMLElement | null>> | null;
  /** The in-page QR reader. */
  readonly scan?: HTMLElement | null;
  readonly scanBox?: HTMLElement | null;
  readonly video?: HTMLVideoElement | null;
}

/** The timers the menu repeat runs on (a test hands fakes in). */
export interface PadTimers {
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  setInterval(f: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
}

/** The QR reader module (src/net/scan.ts by default). */
export interface ScanModule {
  supported(): boolean;
  create(): Scanner;
}

export type AcceptLike = { readonly ok: true; readonly code: string } | PadFail;
export interface PadDeps {
  rtc(o: RtcOptions): PairTransport | null;
  prefetchIce(): Promise<unknown>;
  acceptInvite(t: PairTransport, code: string, profile: { pad: number }): Promise<AcceptLike>;
  swap(o: SwapOptions): Promise<SwapLike>;
  normalise(c: unknown): string;
  valid(c: string): boolean;
  privateRelay(): boolean;
  /** For THIS document only (rendezvous.setSessionUrl): null = public signalling. */
  setSessionUrl(url: string | null): boolean;
  scan?(): ScanModule;
}

export interface PadOptions {
  /** The page URL whose fragment carries #pad=CODE[&relay=URL] (default: location). */
  readonly href?: string | null;
  /** Test seam: the stepped clock, so both wire ends agree. */
  readonly now?: (() => number) | null;
  readonly timers?: PadTimers;
  readonly deps?: Partial<PadDeps>;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
}

export type ConnectResult = { readonly ok: true } | PadFail;
export type SteeringMode = "tilt" | "touch";
export interface PadState {
  readonly linked: boolean;
  readonly roll: number | null;
  readonly thr: number;
  readonly brk: number;
  readonly held: number;
  readonly steer: number;
  readonly steeringMode: SteeringMode;
  readonly sensorOn: boolean;
  readonly hud: PadHud | null;
  readonly stats: PadSessionStats | null;
}
export interface PadController {
  connect(code: unknown): Promise<ConnectResult>;
  cancel(): void;
  scan(): Promise<ScanStartResult | ConnectResult>;
  setSteeringMode(mode: string): boolean;
  /** Paint a dash without a link (controller.html?demo). */
  paintHud(h: PadHud): void;
  /** The demo turns the rim with a real phone's tilt, unlinked. */
  armSensor(): Promise<boolean>;
  /** Stands in for the sensor. */
  setRoll(r: number | null): void;
  /** The frame tick, for a harness with no rAF. */
  pump(): number;
  state(): PadState;
}

type PointerKey = number | string | null;
interface PointerLike { readonly pointerId: PointerKey }
interface Repeater { start(): void; stop(): void }
interface DeviceOrientationWithPermission { requestPermission?: () => Promise<string> }

/** The phone page: pairing, sensor, wheel controls, menu pad, LCD, scan. phone-pad.js:633-1168. */
export function pad(dom: PadDom, opts: PadOptions = {}): PadController {
  const deps: PadDeps = {
    rtc: (o) => NetTransport.rtc(o),
    prefetchIce: () => NetTransport.prefetchIce(),
    acceptInvite: (t, c, p) => NetHandshake.acceptInvite(t, c, p),
    swap: (o) => NetRendezvous.swap(o),
    normalise: (c) => NetRendezvous.normalise(c),
    valid: (c) => NetRendezvous.valid(c),
    privateRelay: () => NetRendezvous.usingPrivateRelay(),
    setSessionUrl: (url) => NetRendezvous.setSessionUrl(url),
    ...opts.deps,
  };
  let pairing = pairingFromUrl(opts.href);
  function paintCodeInput(): void {
    if (!dom.codeIn) return;
    const privateCode = pairing ? !!pairing.relay : deps.privateRelay();
    dom.codeIn.maxLength = privateCode ? 32 : 8;
    dom.codeIn.placeholder = privateCode ? "PRIVATE ROOM TOKEN" : "ABC123";
  }
  paintCodeInput();
  const say = (t: string, bad?: boolean): void => {
    if (!dom.status) return;
    dom.status.textContent = t;
    dom.status.classList.toggle("bad", !!bad);
  };
  // Sensor state — what padSession reads on every send.
  let roll: number | null = null, thr = 0, brk = 0, held = 0, steer = 0, steeringMode: SteeringMode = "tilt";
  let session: PadSession | null = null;
  let sensorOn = false;
  let lastHud: PadHud | null = null;
  const src: PadSource = { roll: () => roll, thr: () => thr, brk: () => brk, held: () => held, steer: () => steeringMode === "touch" ? steer : null };

  // The rim turns with the phone, geared down and clamped: 0.6 of the roll, ±25°.
  function paintRoll(): void {
    if (!dom.rim || !dom.rim.style) return;
    const r = roll == null ? 0 : Math.max(-25, Math.min(25, roll * 0.6));
    dom.rim.style.transform = "rotate(" + r.toFixed(1) + "deg)";
  }
  function onOrient(e: DeviceOrientationEvent): void {
    if (steeringMode !== "tilt") return;
    const r = rollDeg(e.beta, e.gamma, screenAngle());
    if (r === null) return;
    roll = r;
    sensorOn = true;
    paintRoll();
    if (session) session.sample();
  }
  // iOS needs the permission prompt INSIDE the tap; everywhere else the
  // listener alone is enough. Resolves whether data can be expected.
  async function requestSensor(): Promise<boolean> {
    if (typeof DeviceOrientationEvent === "undefined") return false;
    try {
      const DOE = DeviceOrientationEvent as unknown as DeviceOrientationWithPermission;
      if (typeof DOE.requestPermission === "function") {
        const r = await DOE.requestPermission();
        if (r !== "granted") return false;
      }
    } catch { return false; }
    window.addEventListener("deviceorientation", onOrient);
    return true;
  }
  // A held control: pointer down = on, up/cancel = off. Pedals carry a travel
  // (0..1): STAMP THEN EASE, the game's own touch pedals' gesture — a touch
  // anywhere is full travel, sliding the thumb UP from where it landed eases
  // it off (R3-PHONE-2).
  const releases: ((pointersOnly: boolean) => void)[] = [], pointerReleases: ((e: PointerLike) => void)[] = [];
  const releaseAll = (pointersOnly?: unknown): void => { for (const r of releases) r(pointersOnly === true); };
  function hold(el: HTMLElement | null | undefined, on: (v: number) => void, off: () => void, travel?: boolean): void {
    if (!el) return;
    const ids = new Set<PointerKey>();
    const anchors = new Map<PointerKey, number>(); // pointerId -> clientY at touch-down
    const levels = new Map<PointerKey, number>();  // each contact keeps its own pedal travel
    const level = (v: number): void => { if (el.style && el.style.setProperty) el.style.setProperty("--travel", v.toFixed(2)); on(v); };
    const paintLevel = (): void => { let strongest = 0; for (const v of levels.values()) strongest = Math.max(strongest, v); level(strongest); };
    releases.push((pointersOnly) => {
      // A last-finger-up fallback says nothing about keys still held.
      if (pointersOnly) { for (const id of Array.from(ids)) if (typeof id !== "string") up({ pointerId: id }); return; }
      if (!ids.size) return;
      ids.clear(); anchors.clear(); levels.clear(); el.classList.remove("on"); if (travel) paintLevel(); else off();
    });
    const down = (e: PointerEvent): void => {
      ids.add(e.pointerId);
      try { el.setPointerCapture(e.pointerId); } catch { /* not a pointer target */ }
      el.classList.add("on");
      if (travel) { anchors.set(e.pointerId, e.clientY); levels.set(e.pointerId, 1); paintLevel(); } else on(1);
      e.preventDefault();
    };
    const move = (e: PointerEvent): void => {
      if (travel && anchors.has(e.pointerId)) { levels.set(e.pointerId, travelOf(anchors.get(e.pointerId) as number, e.clientY)); paintLevel(); }
    };
    const up = (e: PointerLike): void => {
      anchors.delete(e.pointerId);
      levels.delete(e.pointerId);
      if (!ids.delete(e.pointerId)) return;
      if (!ids.size) el.classList.remove("on");
      if (travel) paintLevel(); else if (!ids.size) off();
    };
    // Keyboard holds share the contact set, so releasing a key cannot cancel
    // a thumb that is still down (or vice versa).
    const keyId = (key: string): string | null => key === " " || key === "Enter" ? "key:" + key : null;
    el.addEventListener("keydown", (e) => {
      const id = keyId(e.key);
      if (!id || (el === dom.gas && dom.body && dom.body.classList.contains("throttle-auto"))) return;
      e.preventDefault();
      if (ids.has(id)) return;
      ids.add(id); el.classList.add("on");
      if (travel) { levels.set(id, 1); paintLevel(); } else on(1);
    });
    el.addEventListener("keyup", (e) => {
      const id = keyId(e.key);
      if (!id) return;
      e.preventDefault(); up({ pointerId: id });
    });
    el.addEventListener("blur", () => {
      for (const id of Array.from(ids)) if (typeof id === "string") up({ pointerId: id });
    });
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    pointerReleases.push(up);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    // WebKit keeps ONE capture slot: pressing LOOK while GAS is held steals
    // GAS's capture. Only a control that is gone counts as released.
    el.addEventListener("lostpointercapture", (e) => { if (!el.isConnected || !el.getClientRects().length) up(e); });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  if (typeof document !== "undefined") {
    // The last finger up clears pointer holds, including a lost lift.
    // Backgrounding or a window blur clears keyboard holds as well.
    const allUp = (e: TouchEvent): void => { if (!e.touches || !e.touches.length) releaseAll(true); };
    const releasePointer = (e: PointerEvent): void => { for (const up of pointerReleases) up(e); };
    document.addEventListener("pointerup", releasePointer, true);
    document.addEventListener("pointercancel", releasePointer, true);
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("pointerup", releasePointer, true);
      window.addEventListener("pointercancel", releasePointer, true);
      window.addEventListener("blur", releaseAll);
    }
    document.addEventListener("touchend", allUp, true);
    document.addEventListener("touchcancel", allUp, true);
    document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAll(); });
  }
  // 12 px of slop, then 90 px of travel to the light end, never quite zero.
  // Moving DOWN past the landing point stays full.
  function travelOf(anchorY: number, y: number): number {
    const upPx = Math.max(0, anchorY - y - PEDAL_DEAD_PX);
    return Math.max(PEDAL_MIN, Math.min(1, 1 - upPx / PEDAL_TRAVEL_PX));
  }
  const push = (): void => {
    if (dom.steer && dom.steer.setAttribute) dom.steer.setAttribute("aria-valuenow", String(steer));
    if (session) session.sample(true);
  };
  function setSteeringMode(mode: string): boolean {
    if (mode !== "tilt" && mode !== "touch") return false;
    if (mode === "touch" && (!session || !session.health().touchSupported)) {
      say("Touch steering needs an updated game. Reload the game and reconnect.", true);
      return false;
    }
    steeringMode = mode; steer = 0; push();
    if (dom.steeringMode) dom.steeringMode.value = mode;
    if (dom.steer) dom.steer.hidden = mode !== "touch";
    return true;
  }
  const modeSel = dom.steeringMode;
  if (modeSel) modeSel.addEventListener("change", () => { if (!setSteeringMode(modeSel.value)) modeSel.value = steeringMode; });
  const strip = dom.steer;
  if (strip) {
    let steeringPointer: number | null = null, anchorX = 0;
    const steeringKeys = new Set<string>();
    const lastKeySteer = (): number => { const last = Array.from(steeringKeys).pop(); return last ? (last === "ArrowLeft" ? -1 : 1) : 0; };
    const release = (e?: PointerLike): void => {
      if (e && e.pointerId !== steeringPointer) return;
      steeringPointer = null;
      if (!e) steeringKeys.clear();
      steer = steeringKeys.size ? (Array.from(steeringKeys).pop() === "ArrowLeft" ? -1 : 1) : 0;
      push();
    };
    releases.push((pointersOnly) => release(pointersOnly ? { pointerId: steeringPointer } : undefined));
    pointerReleases.push(release);
    strip.addEventListener("pointerdown", (e) => {
      if (steeringMode !== "touch" || steeringPointer !== null) return;
      steeringPointer = e.pointerId; anchorX = e.clientX; steer = 0;
      try { strip.setPointerCapture(e.pointerId); } catch { /* document release fanout still centers steering when capture is refused */ }
      e.preventDefault(); push();
    });
    strip.addEventListener("pointermove", (e) => {
      if (steeringPointer !== e.pointerId) return;
      steer = num((e.clientX - anchorX) / Math.max(40, strip.getBoundingClientRect().width * 0.4), -1, 1);
      push();
    });
    strip.addEventListener("pointerup", release); strip.addEventListener("pointercancel", release);
    strip.addEventListener("keydown", (e) => {
      if (steeringMode !== "touch" || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      if (steeringKeys.has(e.key)) return;
      steeringKeys.add(e.key); steer = e.key === "ArrowLeft" ? -1 : 1; push();
    });
    strip.addEventListener("keyup", (e) => {
      if (!steeringKeys.delete(e.key)) return;
      e.preventDefault();
      steer = lastKeySteer(); push();
    });
    strip.addEventListener("blur", () => release());
  }
  hold(dom.gas, (v) => { thr = v; push(); }, () => { thr = 0; push(); }, true);
  hold(dom.brake, (v) => { brk = v; push(); }, () => { brk = 0; push(); }, true);
  hold(dom.lookBack, () => { held |= HELD.lookBack; push(); }, () => { held &= ~HELD.lookBack; push(); });
  // Edges fire on the DOWN, not the click. A held menu direction repeats.
  // Wrapped, not the bare functions: a browser's timers throw "Illegal
  // invocation" unless `this` is the window.
  const timers: PadTimers = opts.timers || {
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]),
    setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t as Parameters<typeof clearInterval>[0]),
  };
  // A tick under the thumb on every press, where the phone can (Android).
  const buzz = (): void => {
    try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(8); } catch { /* advisory */ }
  };
  // Fire k now, then keep firing at a keyboard's cadence until stop().
  function repeater(k: PadEventName): Repeater {
    let rep: unknown = null;
    const stop = (): void => { if (rep) { timers.clearTimeout(rep); timers.clearInterval(rep); rep = null; } };
    const start = (): void => {
      stop();
      rep = timers.setTimeout(() => {
        rep = timers.setInterval(() => { if (session) session.event(k); else stop(); }, REPEAT_RATE_MS);
        unrefTimer(rep);
      }, REPEAT_DELAY_MS);
      unrefTimer(rep);
    };
    return { start, stop };
  }
  function edge(el: HTMLElement | null | undefined, k: PadEventName, repeat?: boolean): void {
    if (!el) return;
    const r = repeater(k), stop = r.stop;
    const fire = (): void => { buzz(); if (session) session.event(k); };
    el.addEventListener("click", (e) => { if (!e.detail) { e.preventDefault(); fire(); } });
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.classList.add("on");
      fire();
      if (repeat) r.start();
    });
    const up = (): void => { el.classList.remove("on"); stop(); };
    releases.push(up); // a lost lift must not repeat a menu step forever (the nets above)
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", up);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  for (const k of EVENTS) {
    const b = dom.buttons && dom.buttons[k];
    for (const el of (Array.isArray(b) ? b : [b])) edge(el, k, !!NAV_REPEAT[k]);
  }
  edge(dom.center, "calib");

  // THE MENU STICK: one disc that is both the D-pad and a thumbstick. The
  // dead zone is the middle 28 %, and a direction must beat the other axis
  // by a fifth to take over, so a diagonal thumb does not flicker.
  function menuStick(base: HTMLElement | null | undefined, nub: HTMLElement | null | undefined, arrows: PadDom["arrows"]): void {
    if (!base) return;
    let id: number | null = null, dir: NavDir | null = null, cx = 0, cy = 0, rad = 1;
    const reps: Partial<Record<NavDir, Repeater>> = {};
    const lit = (k: NavDir, on: boolean): void => { const a = arrows && arrows[k]; if (a && a.classList) a.classList.toggle("on", on); };
    const aim = (k: NavDir | null): void => {
      if (k === dir) return;
      if (dir) { lit(dir, false); reps[dir]?.stop(); }
      dir = k;
      if (!k) return;
      lit(k, true);
      buzz();
      if (session) session.event(k);
      (reps[k] ||= repeater(k)).start();
    };
    const place = (e: { readonly clientX: number; readonly clientY: number }): void => {
      const dx = e.clientX - cx, dy = e.clientY - cy, d = Math.hypot(dx, dy);
      const m = d ? Math.min(d, rad * 0.55) / d : 0;
      if (nub && nub.style) nub.style.transform = "translate(" + (dx * m).toFixed(1) + "px," + (dy * m).toFixed(1) + "px)";
      if (d < rad * 0.28) { aim(null); return; }
      const ax = Math.abs(dx), ay = Math.abs(dy);
      const horiz = dir === "navLeft" || dir === "navRight" ? ax * 1.2 >= ay : ax > ay * 1.2;
      aim(horiz ? (dx < 0 ? "navLeft" : "navRight") : (dy < 0 ? "navUp" : "navDown"));
    };
    base.addEventListener("pointerdown", (e) => {
      if (id !== null) return;
      id = e.pointerId;
      try { base.setPointerCapture(e.pointerId); } catch { /* not a pointer target */ }
      const b = base.getBoundingClientRect();
      cx = b.left + b.width / 2; cy = b.top + b.height / 2; rad = Math.max(1, b.width / 2);
      base.classList.add("on");
      place(e);
      e.preventDefault();
    });
    base.addEventListener("pointermove", (e) => { if (e.pointerId === id) place(e); });
    const up = (e: PointerLike): void => {
      if (e.pointerId !== id) return;
      id = null;
      aim(null);
      base.classList.remove("on");
      if (nub && nub.style) nub.style.transform = "";
    };
    // In the release nets too: a lost lift otherwise repeats forever and `id`
    // stays set, so the stick refuses every later press.
    releases.push(() => { if (id !== null) up({ pointerId: id }); });
    base.addEventListener("pointerup", up);
    base.addEventListener("pointercancel", up);
    base.addEventListener("lostpointercapture", up);
    base.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  menuStick(dom.stick, dom.nub, dom.arrows);

  let wake: WakeLockSentinel | null = null, wakeRequest: object | null = null, wakeGeneration = 0;
  let connecting = false, attempt: { cancelled: boolean; transport: PairTransport | null } | null = null;
  function releaseWake(lock: WakeLockSentinel | null): void {
    if (!lock) return;
    try { const p = lock.release(); if (p && p.catch) p.catch(() => {}); } catch { /* already released */ }
  }
  function dropWake(): void {
    wakeGeneration++; wakeRequest = null;
    const lock = wake; wake = null;
    releaseWake(lock);
  }
  async function keepAwake(): Promise<void> {
    if ((!connecting && !session) || wake || wakeRequest) return;
    const generation = wakeGeneration, request = {};
    wakeRequest = request;
    try {
      if (typeof navigator !== "undefined" && navigator.wakeLock) {
        const lock = await navigator.wakeLock.request("screen");
        if (generation !== wakeGeneration || (!connecting && !session)) { releaseWake(lock); return; }
        wake = lock;
        lock.addEventListener("release", () => { if (wake === lock) wake = null; });
      }
    } catch { /* not granted: the page dims like any other */ }
    finally { if (wakeRequest === request) wakeRequest = null; }
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && session) void keepAwake(); });
  }

  // RE-DIAL (R3-PHONE-3): a link whose wire died (anything but the game's own
  // "peer" goodbye) dials the same code once more as soon as the page is in
  // front of the player; a failed re-dial retries on this backoff, inside the
  // game's 120 s re-host window, then gives up (#2198).
  let redial: string | null = null;
  const REDIAL_BACKOFF_MS = [5000, 15000, 30000];
  let redialTries = 0, redialTimer: ReturnType<typeof setTimeout> | null = null, redialing = false;
  function stopRedial(): void { redial = null; redialTries = 0; if (redialTimer) { clearTimeout(redialTimer); redialTimer = null; } }
  function redialNow(): void {
    if (!redial || connecting || session || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    const c = redial; redial = null;
    redialing = true;
    void connect(c);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", redialNow);
  function cancel(): void {
    stopScan();
    stopRedial();
    const old = attempt; attempt = null;
    if (old) old.cancelled = true;
    connecting = false;
    const active = session;
    steeringMode = "tilt"; if (dom.steeringMode) dom.steeringMode.value = "tilt"; if (dom.steer) dom.steer.hidden = true;
    if (active) { steer = 0; thr = brk = held = 0; active.sample(true); }
    session = null;
    if (active) active.close();
    else if (old && old.transport) { try { old.transport.close(); } catch { /* already closed */ } }
    dropWake(); releaseAll();
    if (dom.body) dom.body.classList.remove("linked");
    if (dom.connect) dom.connect.disabled = false;
  }
  if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("pagehide", cancel);
  async function connect(codeArg: unknown): Promise<ConnectResult> {
    let codeIn = codeArg;
    const isRedial = redialing; redialing = false;
    if (connecting || session) return { ok: false, error: "busy" };
    stopScan();
    if (!isRedial) stopRedial(); // a CONNECT tap replaces any pending retry
    const incoming = pairingFromUrl(codeIn);
    if (incoming) { pairing = incoming; codeIn = incoming.code; if (dom.codeIn) dom.codeIn.value = incoming.code; paintCodeInput(); }
    if (pairing && (pairing.invalid || !deps.setSessionUrl(pairing.relay))) {
      say("That pairing link has an invalid relay address. Scan a new code from the game.", true);
      return { ok: false, error: "bad_relay" };
    }
    const code = deps.normalise(codeIn);
    if (!deps.valid(code)) {
      say(deps.privateRelay() ? "That is not a private room token — copy the full 32-character token." : "That is not a room code — six letters and numbers.", true);
      return { ok: false, error: "bad_code" };
    }
    connecting = true;
    const owner: { cancelled: boolean; transport: PairTransport | null } = attempt = { cancelled: false, transport: null };
    if (dom.connect) dom.connect.disabled = true;
    // The sensor prompt rides the CONNECT tap: iOS shows it only inside a gesture.
    const sensor = sensorOn || await requestSensor();
    if (attempt !== owner) return { ok: false, error: "cancelled" };
    if (!sensor) say("No motion sensor — choose TOUCH STRIP under STEERING after connecting to an updated game.", true);
    else say("Looking for the game…");
    void keepAwake();
    try {
      await deps.prefetchIce();
      if (attempt !== owner) return { ok: false, error: "cancelled" };
      const transport = owner.transport = deps.rtc({ role: "guest", name: "pad" });
      if (!transport) { say("WebRTC is unavailable in this browser.", true); return { ok: false, error: "no_transport" }; }
      let answered: AcceptLike | null = null;
      const done = await deps.swap({
        code, slot: "answer", want: "offer", token: owner,
        onTick: () => { if (attempt === owner && !session) say("Looking for the game… (room code " + code + ")"); },
        reply: async (invite) => {
          if (attempt !== owner) return null;
          say("Found it — connecting…");
          const res = await deps.acceptInvite(transport, invite, { pad: PROTO });
          if (attempt !== owner) return null;
          answered = res;
          return res.ok ? res.code : null;
        },
      });
      if (attempt !== owner) return { ok: false, error: "cancelled" };
      if (!done.ok) {
        const ans = answered as AcceptLike | null;
        const why: PadFail = (done.error === "reply_failed" && ans && !ans.ok) ? ans : done;
        // The handshake's own words are for two friends racing; here the
        // other end is the game on the big screen.
        say(why.error === "build_mismatch" ? "The game and this page are on different versions — reload both and try again."
          : why.error === "expired" ? "The game is not offering that code any more — choose MAKE NEW CODE in its phone-controller settings."
          : why.message || "Could not reach the game. Make a new code there and try again.", true);
        try { transport.close(); } catch { /* never opened */ }
        if (isRedial && why.error !== "build_mismatch") {
          if (redialTries < REDIAL_BACKOFF_MS.length) {
            const wait = REDIAL_BACKOFF_MS[redialTries++] as number;
            say("Link lost — reconnecting… (try " + redialTries + " of " + REDIAL_BACKOFF_MS.length + ")", true);
            redialTimer = setTimeout(() => { redialTimer = null; redial = code; redialNow(); }, wait);
          } else {
            redialTries = 0;
            say("Could not reconnect to the game — press STEER THIS GAME WITH A PHONE there, then CONNECT.", true);
          }
        }
        return why;
      }
      say("Connecting…");
      const active = padSession(transport, src, {
        now: opts.now || null, // test seam: the harness's stepped clock, so both wire ends agree
        onHud: (h) => { lastHud = h; paintHud(dom.hud, h); },
        onOpen: () => {
          say(sensorOn || sensor ? "Connected — tilt to steer." : "Connected — pedals and buttons only.");
          if (dom.body) dom.body.classList.add("linked");
          if (opts.onOpen) opts.onOpen();
        },
        onHealth: (h) => {
          const text = h.state === "unavailable" ? "INPUT AGE UNAVAILABLE · UPDATE GAME" : h.state === "waiting" ? "WAITING FOR INPUT ACK"
            : h.state === "reconnecting" ? "INPUT NOT ACKNOWLEDGED" : "INPUT " + h.state.toUpperCase();
          if (dom.health && dom.health.textContent !== text) dom.health.textContent = text;
          if (dom.healthAge) {
            const age = h.ageMs == null ? "" : Math.round(h.ageMs / 100) * 100 + " ms since acknowledged sample";
            if (dom.healthAge.textContent !== age) dom.healthAge.textContent = age;
          }
        },
        onClose: (why) => {
          if (attempt !== owner) return;
          steer = 0; steeringMode = "tilt";
          if (dom.steeringMode) dom.steeringMode.value = "tilt";
          if (dom.health) dom.health.textContent = "INPUT DISCONNECTED";
          if (dom.steer) dom.steer.hidden = true;
          attempt = null; owner.cancelled = true; connecting = false;
          session = null;
          dropWake(); releaseAll();
          if (dom.body) dom.body.classList.remove("linked");
          if (dom.connect) dom.connect.disabled = false;
          // WHICH END DIED: "peer" is the game's own goodbye; any other reason
          // is this end's wire. A private relay's one mailbox is not hosted
          // again, so no re-dial there.
          const wire = !!why && why !== "peer", again = wire && !deps.privateRelay();
          say(!wire ? "Disconnected — the game closed the link. Pair again from its Settings."
            : "Link lost — this phone slept, took a call or lost signal. " + (again ? "Reconnecting…" : "Pair again from the game's Settings."), true);
          if (opts.onClose) opts.onClose();
          if (again) { redial = code; redialNow(); }
        },
      });
      if (attempt !== owner) { active.close(); return { ok: false, error: "cancelled" }; }
      session = active;
      redialTries = 0; // a link is up: a later drop gets the full backoff again
      const tick = (): void => { if (session !== active) return; active.pump(); requestAnimationFrame(tick); };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(tick);
      return { ok: true };
    } finally {
      if (attempt === owner) {
        connecting = false;
        if (!session) { attempt = null; owner.cancelled = true; dropWake(); }
        if (dom.connect && !session) dom.connect.disabled = false;
      }
    }
  }
  if (dom.connect) dom.connect.addEventListener("click", () => { void connect(dom.codeIn ? dom.codeIn.value : ""); });

  // SCAN THE GAME'S QR, IN THE PAGE: the camera app would open a NEW tab, so
  // the page reads the QR itself with the lobby's reader. The sensor prompt
  // rides the SCAN tap (the code arrives later, outside any gesture).
  const Scan: ScanModule = deps.scan ? deps.scan() : NetScan;
  let scanner: Scanner | null = null, scanGeneration = 0, scanPending = false;
  const showScan = (on: boolean): void => {
    if (dom.scanBox) dom.scanBox.hidden = !on;
    if (dom.scan) dom.scan.textContent = on ? "CANCEL SCAN" : "SCAN QR CODE";
  };
  function stopScan(): void { scanGeneration++; scanPending = false; if (scanner) scanner.stop(); showScan(false); }
  async function scan(): Promise<ScanStartResult | ConnectResult> {
    if (scanPending || (scanner && scanner.active())) { stopScan(); say("Type the room code the game shows, then CONNECT."); return { ok: false, error: "cancelled" }; }
    if (connecting || session) return { ok: false, error: "busy" };
    const generation = ++scanGeneration;
    scanPending = true;
    const current = (): boolean => generation === scanGeneration && !connecting && !session &&
      !(typeof document !== "undefined" && document.hidden);
    await requestSensor();
    if (!current()) { if (generation === scanGeneration) scanPending = false; return { ok: false, error: "cancelled" }; }
    const sc = scanner = scanner || Scan.create();
    showScan(true);
    say("Point the camera at the QR code on the game's screen.");
    const r = await sc.start(dom.video as ScanVideo, (text) => {
      if (!current()) return;
      showScan(false);
      pairing = pairingFromUrl(text);
      paintCodeInput();
      const code = pairing ? pairing.code : String(text || "").trim();
      if (dom.codeIn) dom.codeIn.value = code;
      void connect(code);
    });
    if (generation !== scanGeneration) return { ok: false, error: "cancelled" };
    scanPending = false;
    if (!r.ok) {
      showScan(false);
      if (r.error !== "cancelled") say(String(r.message || "The camera did not start.").replace(/paste/g, "type"), true);
    }
    return r;
  }
  if (dom.scan) {
    if (!Scan || !Scan.supported()) dom.scan.hidden = true;
    else dom.scan.addEventListener("click", () => { void scan(); });
  }
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", () => { if (document.hidden) stopScan(); });
  }
  const fromUrl = pairing && pairing.code;
  if (fromUrl && dom.codeIn) dom.codeIn.value = fromUrl;
  say(fromUrl ? "Tap CONNECT to pair with the game." : Scan && Scan.supported() ? "Scan the game's QR code, or type its room code and CONNECT." : "Type the room code the game shows, then CONNECT.");

  return {
    connect,
    cancel,
    scan,
    setSteeringMode,
    paintHud: (h) => { lastHud = h; paintHud(dom.hud, h); },
    armSensor: requestSensor,
    setRoll: (r) => { roll = r; paintRoll(); if (session) session.sample(); },
    pump: () => (session ? session.pump() : 0),
    state: () => ({ linked: !!session, roll, thr, brk, held, steer, steeringMode, sensorOn, hud: lastHud, stats: session ? session.stats() : null }),
  };
}
