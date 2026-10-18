/**
 * PHONE AS CONTROLLER, measured end to end with no phone: src/net/phone-pad.ts
 * (both halves over the loopback transport) and src/net/tilt-roll.ts.
 *
 * Ported from f1-game tests/unit/phone-pad.test.mjs:
 *   :145-211    the wire (samples, events, dash, pairing URL) and TiltRoll
 *   :276-370    edges, stale samples, haptics forwarding and capabilities — against a
 *               recording PhonePadInput instead of the real Input
 *   :446-529    the dash at ~15 Hz and paintHud (session tags, control-mode layout)
 *   :531-545    closing the link
 *   :599-884    pad(): pedals, private relay, the wired page, the lost-lift nets
 *   :915-1013   host(): phases, failures, the re-link on a dropped wire
 *   :1031-1099  pad() SCAN; link()'s .pad-ring
 *   :1105-1183  only the controller.html markup checks that hold for apex-26's page
 *   :1218-1268  cancellation races; closed sessions ignore late packets
 *   :1438-1510  host() over a private relay
 *   :1512-1655  the phone's wake lock, re-dial and host recovery timing
 *   :1677-1830  #2198 expiry and re-dial backoff; keyboard holds; touch steering keys;
 *               the last-touch fallback
 * and all of f1-game tests/unit/phone-input-improvements.test.mjs (:1-198).
 *
 * NOT PORTED (they need f1-game's Input, game.js, platform-session.js,
 * index.html, the manifest or the Android shell — none of which apex-26 has):
 *   phone-pad.test.mjs :217-243 tilt pipeline parity, :245-255 RECALIBRATE,
 *   :257-274 pedals → throttle()/braking(), :372-391 700 ms staleness vs keyboard,
 *   :393-414 silent phone in local tilt mode, :416-444 local gyro reacquire,
 *   :547-555 Input.reset(), :557-576 menu nav seam (padNavKey/padActivate/padEscape),
 *   :1015-1029 sensorless phone vs local steering, :1185-1206 pre-paint theme,
 *   :1208-1216 AndroidManifest permissions, :1270-1299 / :1406-1436 / :1657-1673
 *   PlatformSession, :1303-1404 XR stick / sample bursts / XR cold start / wheel
 *   pedal axes, and the manifest / index.html / game.js / importmap halves of
 *   :1105-1183 and the platform-session regexes of :488-529.
 *   phone-touch-surface.test.mjs: every test (css/, index.html and Input only;
 *   none touches phone-pad).
 *
 * Differences: assertions on f1-game Input state (steer(), throttleLevel(), …)
 * become assertions on what reached the recording input; loopback has no
 * `_emit`, so a test that injects into an inbox wraps the endpoint (tap());
 * globals the page reads (document, window, navigator, timers) are
 * vi.stubGlobal stubs instead of a vm sandbox.
 */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import * as PhonePad from "../../src/net/phone-pad";
import type {
  HudIn, PadDom, PadHud, PadTimers, PadTransport, PairTransport, PhonePadInput, RemoteSample, RingDoc,
} from "../../src/net/phone-pad";
import * as NetScan from "../../src/net/scan";
import * as NetTransport from "../../src/net/transport";
import type { Channel, CloseReason, LoopbackEndpoint, WireData } from "../../src/net/transport";
import * as TiltRoll from "../../src/net/tilt-roll";

const ROOT = new URL("../../", import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, ROOT), "utf8");
const STEP = 1000 / 60;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function settle(n = 6): Promise<void> { for (let i = 0; i < n; i++) await tick(); }

afterEach(() => { vi.unstubAllGlobals(); });

// ─── stand-ins ──────────────────────────────────────────────────────────────

/** What f1-game's Input did for phone-pad, recorded. */
function fakeInput() {
  const rec = {
    samples: [] as RemoteSample[], events: [] as string[], lost: [] as string[],
    haptics: null as ((ms: number) => boolean) | null, hapticChanges: 0, accept: true,
  };
  const input: PhonePadInput = {
    remoteSample: (s) => { rec.samples.push(s); return rec.accept; },
    remoteEvent: (k) => { rec.events.push(k); },
    remoteLost: (s) => { rec.lost.push(s); },
    setRemoteHaptics: (fn) => { if (!!fn !== !!rec.haptics) rec.hapticChanges++; rec.haptics = fn; },
  };
  return { input, rec, last: () => rec.samples.at(-1), vibrate: (ms: number) => { rec.haptics?.(ms); } };
}

/** A loopback endpoint whose inbox and close a test can reach directly (f1-game's `_emit`). */
interface Tapped extends PadTransport {
  emit(channel: Channel, data: WireData): void;
  fail(why: CloseReason): void;
}
function tap(ep: LoopbackEndpoint): Tapped {
  const msg: ((c: Channel, d: WireData, at: number | undefined) => void)[] = [];
  const closes: ((why: CloseReason) => void)[] = [];
  let forced: "closed" | null = null;
  const t: Tapped = {
    get status() { return forced ?? ep.status; },
    onMessage(fn) { msg.push(fn); return ep.onMessage(fn); },
    onOpen(fn) { return ep.onOpen(fn); },
    onClose(fn) { closes.push(fn); return ep.onClose(fn); },
    send: (c, d) => ep.send(c, d),
    pump: (now) => ep.pump(now),
    close: () => ep.close(),
    emit(c, d) { for (const f of msg) f(c, d, undefined); },
    fail(why) { forced = "closed"; for (const f of closes) f(why); },
  };
  return t;
}

// A phone and a desktop joined by the loopback wire: padSession over one end,
// link() over the other, pumped by one hand-stepped clock.
function pair(opts: { latencyMs?: number; phoneHaptics?: boolean } = {}) {
  const desk = fakeInput();
  const clock = { t: 0 };
  const [padEnd, rawHost] = NetTransport.loopback({ latencyMs: opts.latencyMs ?? 5, rnd: NetTransport.seededRnd(7) });
  padEnd.pump(0); rawHost.pump(0);
  const hostEnd = tap(rawHost);
  const phone = { roll: null as number | null, thr: 0, brk: 0, held: 0, buzz: [] as number[], huds: [] as PadHud[] };
  const session = PhonePad.padSession(padEnd, {
    roll: () => phone.roll, thr: () => phone.thr, brk: () => phone.brk, held: () => phone.held,
  }, {
    now: () => clock.t, heartbeat: false, onHud: (h) => phone.huds.push(h),
    ...(opts.phoneHaptics === false ? {} : { vibrate: (ms: number) => { phone.buzz.push(ms); } }),
  });
  let closed = 0;
  const dash: { value: HudIn | null } = { value: null };
  const link = PhonePad.link(hostEnd, { input: desk.input, pump: false, now: () => clock.t, doc: null, hud: () => dash.value, onClose: () => { closed++; } });
  const frame = (sendSample = true): void => {
    clock.t += STEP;
    if (sendSample) session.sample();
    session.pump(); link.pump();
  };
  return { ...desk, clock, phone, session, link, frame, dash, closedCount: () => closed, padEnd, hostEnd };
}

interface FakeStyle { transform: string; width: string; props: Record<string, string>; setProperty(k: string, v: string): void }
const fakeStyle = (): FakeStyle => ({ transform: "", width: "", props: {}, setProperty(k, v) { this.props[k] = v; } });

/** A stand-in for the wheel's LCD: the surface paintHud touches, nothing more. */
function lcd() {
  const mk = () => {
    const n = { textContent: "", style: fakeStyle(), classes: new Set<string>(),
      classList: { toggle: (c: string, on?: boolean) => { if (on) n.classes.add(c); else n.classes.delete(c); } } };
    return n;
  };
  const leds = { children: Array.from({ length: 15 }, mk) };
  return { gear: mk(), speed: mk(), lap: mk(), pos: mk(), ers: mk(), flag: mk(), ot: mk(), aero: mk(), last: mk(), leds, screen: mk(), team: mk(), body: mk() };
}
const litLeds = (el: ReturnType<typeof lcd>): number => el.leds.children.filter((s) => s.classes.has("on")).length;

type Listener = (e: Record<string, unknown>) => void;
/** phone-pad.test.mjs:584-597's fakeEl. */
function fakeEl() {
  const listeners: Record<string, Listener[]> = {};
  const el = {
    children: [] as unknown[], textContent: "", disabled: false, value: "", hidden: false, maxLength: 0, placeholder: "",
    style: fakeStyle(), classes: new Set<string>(), attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { el.attrs[k] = v; },
    addEventListener(t: string, f: Listener) { (listeners[t] ||= []).push(f); },
    dispatch(t: string, ev: Record<string, unknown> = {}) { for (const f of listeners[t] || []) f({ preventDefault() {}, pointerId: 1, ...ev }); },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ top: 100, height: 200, left: 0, width: 100 }),
    classList: {
      add: (c: string) => { el.classes.add(c); }, remove: (c: string) => { el.classes.delete(c); },
      toggle: (c: string, on?: boolean) => { if (on) el.classes.add(c); else el.classes.delete(c); },
      contains: (c: string) => el.classes.has(c),
    },
  };
  return el;
}
type FakeEl = ReturnType<typeof fakeEl>;
const asDom = (d: object): PadDom => d as unknown as PadDom;
const wire = <T extends object>(t: T): PairTransport => t as unknown as PairTransport;

/** Timers pad() can be handed instead of the wall clock (its `timers` seam). phone-pad.test.mjs:84-100. */
function fakeTimers() {
  const q: { id: number; f: () => void; ms: number; every: number }[] = [];
  let id = 0;
  const t = {
    setTimeout: (f: () => void, ms: number) => { q.push({ id: ++id, f, ms, every: 0 }); return id; },
    setInterval: (f: () => void, ms: number) => { q.push({ id: ++id, f, ms, every: ms }); return id; },
    clearTimeout: (i: unknown) => { const k = q.findIndex((e) => e.id === i); if (k >= 0) q.splice(k, 1); },
    clearInterval: (i: unknown) => t.clearTimeout(i),
    advance(ms: number) {
      for (const e of [...q]) {
        e.ms -= ms;
        while (e.ms <= 0 && q.includes(e)) { if (e.every) { e.f(); e.ms += e.every; } else { t.clearTimeout(e.id); e.f(); } }
      }
    },
    pending: () => q.length,
  };
  const timers: PadTimers = t;
  return Object.assign(t, { timers });
}

/** A doc/window stub that records listeners (f1-game swapped globalThis.document/window). */
function stubPage(extra: Record<string, unknown> = {}) {
  const doc: Record<string, Listener[]> = {}, win: Record<string, Listener[]> = {};
  const document = { hidden: false, visibilityState: "visible", addEventListener(t: string, f: Listener) { (doc[t] ||= []).push(f); }, ...extra };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { addEventListener(t: string, f: Listener) { (win[t] ||= []).push(f); } });
  const fire = (l: Record<string, Listener[]>, t: string, e: Record<string, unknown> = {}) => { for (const f of l[t] || []) f(e); };
  return { document, doc: (t: string, e?: Record<string, unknown>) => fire(doc, t, e), win: (t: string, e?: Record<string, unknown>) => fire(win, t, e) };
}

// ─── the wire ───────────────────────────────────────────────────────────────

test("a sample round-trips, and junk / a foreign protocol / an out-of-range pedal never reach the input", () => {
  const s = PhonePad.decodeSample(PhonePad.encodeSample({ seq: 41, roll: -12.346, thr: 0.5, brk: 0, held: 1 }));
  expect(s, "two decimals is the wire's precision").toEqual({ seq: 41, roll: -12.35, thr: 0.5, brk: 0, held: 1 });
  expect(PhonePad.decodeSample(PhonePad.encodeSample({ seq: 1, roll: null, thr: 1, brk: 1, held: 0 }))?.roll,
    "a phone with no sensor sends a null roll").toBe(null);
  for (const bad of ["", "nope", "{}", "[]", JSON.stringify([2, 1, 0, 0, 0, 0]), JSON.stringify([1, 1, 0, 0, 0]), 42, null]) {
    expect(PhonePad.decodeSample(bad), `accepted ${JSON.stringify(bad)}`).toBe(null);
  }
  const clamped = PhonePad.decodeSample(JSON.stringify([1, 3, 720, 7, -3, 0]));
  expect(clamped?.thr).toBe(1); expect(clamped?.brk).toBe(0);
  expect(clamped?.roll, "a roll beyond half a turn is clamped, never NaN").toBe(180);
  expect(PhonePad.decodeSample(JSON.stringify([1, 3, "12", 0, 0, 0]))?.roll, "a string roll is no roll").toBe(null);
  // The exact bytes f1-game sends (bit-compatible wire).
  expect(PhonePad.encodeSample({ seq: 7, roll: 1.005, thr: 0.333, brk: 0, held: 1 })).toBe("[1,7,1,0.33,0,1]");
  expect(PhonePad.encodeSample({ seq: 7, steer: 2, thr: 1 })).toBe("[2,7,null,1,0,0,1]");
});

test("events: only the named edges decode, haptics are bounded, the rest is dropped", () => {
  for (const k of PhonePad.EVENTS) expect(PhonePad.decodeEvent(PhonePad.encodeEvent(k))).toEqual({ t: "ev", k });
  expect(PhonePad.decodeEvent(JSON.stringify({ t: "ev", k: "__proto__" }))).toBe(null);
  expect(PhonePad.decodeEvent(JSON.stringify({ t: "ev", k: "eval" }))).toBe(null);
  expect(PhonePad.decodeEvent(PhonePad.encodeHaptic(5000)), "a buzz is capped at a second").toEqual({ t: "hap", ms: 1000 });
  expect(PhonePad.decodeEvent("[1,2,3]")).toBe(null);
  expect(PhonePad.decodeEvent(JSON.stringify({ t: "state" }))).toBe(null);
  expect(PhonePad.encodeHello("pad", true, true)).toBe('{"t":"hi","side":"pad","p":1,"haptics":true,"steer":true,"ack":true}');
});

test("the dash round-trips, is refused by the sample decoder, and clamps every field", () => {
  const h = { gear: 6, kmh: 287.6, rpm: 0.912, lap: 3, laps: 12, pos: 4, cars: 20, ers: 0.55, flags: PhonePad.DASH.otArmed | PhonePad.DASH.redline,
    caution: 1, lastLapMs: 91234, state: "race", team: "#00b4ab" };
  const back = PhonePad.decodeHud(PhonePad.encodeHud(h));
  expect(back).toEqual({ gear: 6, kmh: 288, rpm: 0.91, lap: 3, laps: 12, pos: 4, cars: 20, ers: 0.55,
    flags: PhonePad.DASH.otArmed | PhonePad.DASH.redline, caution: 1, lastLapMs: 91234, state: "race", team: "#00b4ab" });
  expect(PhonePad.decodeSample(PhonePad.encodeHud(h)), "a dash is not a sample").toBe(null);
  expect(PhonePad.decodeHud(PhonePad.encodeSample({ seq: 1, roll: 0, thr: 0, brk: 0, held: 0 })), "a sample is not a dash").toBe(null);
  expect(PhonePad.encodeHud(null), "nothing to show sends nothing").toBe(null);
  const wild = PhonePad.decodeHud(JSON.stringify(["H", 40, 5000, 7, -3, 9999, 200, 0, 2, -1, 9, 1e9, "x".repeat(40), "javascript:alert(1)"]));
  expect(wild, "every field is clamped and the team colour must be a hex").toEqual({ gear: 9, kmh: 999, rpm: 1, lap: 0, laps: 999, pos: 99, cars: 0, ers: 1,
    flags: 0, caution: 4, lastLapMs: 3600000, state: "xxxxxxxx", team: "" });
  expect(PhonePad.teamHex([0.0, 0.706, 0.671]), "a TeamDef colour becomes the CSS hex").toBe("#00b4ab");
  expect(PhonePad.teamHex(null)).toBe("");
  expect(PhonePad.fmtLap(91234)).toBe("1:31.234"); expect(PhonePad.fmtLap(0)).toBe("");
});

test("the pairing URL lands on controller.html beside the game with the code in the FRAGMENT", () => {
  expect(PhonePad.padUrl("ABC234", "https://brycejmurrin.github.io/apex-26/index.html"))
    .toBe("https://brycejmurrin.github.io/apex-26/controller.html#pad=ABC234");
  expect(PhonePad.padUrl("ABC234", "https://brycejmurrin.github.io/apex-26/"), "a directory URL gets the same page")
    .toBe("https://brycejmurrin.github.io/apex-26/controller.html#pad=ABC234");
  expect(PhonePad.codeFromUrl("https://x.test/apex-26/controller.html#pad=ABC234")).toBe("ABC234");
  expect(PhonePad.codeFromUrl("https://x.test/apex-26/controller.html?x=1#other=1&pad=ABC234")).toBe("ABC234");
  expect(PhonePad.codeFromUrl("https://x.test/apex-26/controller.html")).toBe(null);
  expect(PhonePad.pairingFromUrl("https://x.test/c.html#pad=ABC234&relay=" + encodeURIComponent("https://relay.test/a/")))
    .toEqual({ code: "ABC234", relay: "https://relay.test/a", invalid: false });
});

// ─── the roll math, shared by both ends ─────────────────────────────────────

test("TiltRoll: the roll the phone sends is the roll the game would have read itself", () => {
  expect(Math.abs((TiltRoll.rollDeg(0, 20, 0) as number) - 20)).toBeLessThan(1e-9);
  expect(Math.abs((TiltRoll.rollDeg(0, -20, 0) as number) + 20)).toBeLessThan(1e-9);
  expect(Math.abs((TiltRoll.rollDeg(20, 0, 90) as number) - 20)).toBeLessThan(1e-9);
  expect(Math.abs((TiltRoll.rollDeg(20, 0, 270) as number) + 20), "the other landscape flips the sign").toBeLessThan(1e-9);
  expect(Math.abs((TiltRoll.rollDeg(0, 20, 180) as number) + 20), "upside-down portrait flips it too").toBeLessThan(1e-9);
  expect(TiltRoll.rollDeg(null, null, 0), "no angles at all (no sensor) is null, not 0").toBe(null);
  expect(TiltRoll.rollDeg(0, 0, 0)).toBe(0);
  expect(Math.abs(TiltRoll.rollDeg(45, 0, 0) as number), "pitch alone is not roll").toBeLessThan(1e-9);
  expect(TiltRoll.rollDeg(0, 20, -270), "a negative angle wraps").toBe(TiltRoll.rollDeg(0, 20, 90));
  expect(TiltRoll.screenAngle(), "node reports no screen: 0").toBe(0);
});

// ─── the desktop half against a recording input ─────────────────────────────

test("a tilted phone's roll and pedals reach remoteSample, tagged as the phone, every frame", () => {
  const { phone, frame, link, rec, last } = pair();
  phone.roll = 30; phone.thr = 0.8; phone.held = PhonePad.HELD.lookBack;
  for (let i = 0; i < 60; i++) frame();
  expect(link.stats().samples).toBeGreaterThanOrEqual(55);
  expect(last()).toMatchObject({ source: "phone", roll: 30, thr: 0.8, brk: 0, held: 1 });
  phone.roll = null; phone.thr = 0; phone.brk = 0.35; frame();
  expect(last()).toMatchObject({ roll: null, thr: 0, brk: 0.35 });
  expect(rec.samples.every((s, i, a) => i === 0 || s.seq > (a[i - 1] as RemoteSample).seq), "seq rises").toBe(true);
});

test("a button edge crosses on the reliable channel exactly once", () => {
  const { session, frame, link, rec } = pair();
  frame();
  expect(session.event("shiftUp")).toBe(true);
  frame(false);
  expect(rec.events).toEqual(["shiftUp"]);
  expect(session.event("notAnAction"), "an unknown name is refused at the sender").toBe(false);
  session.event("pause"); frame(false);
  session.event("overtake"); session.event("boost"); frame(false);
  expect(rec.events).toEqual(["shiftUp", "pause", "overtake", "boost"]);
  expect(link.stats().events).toBe(4);
  expect(link.stats().junk).toBe(0);
});

test("an OLDER sample arriving after a newer one is dropped, never applied", () => {
  const { phone, frame, link, hostEnd, rec } = pair();
  phone.roll = 30;
  for (let i = 0; i < 60; i++) frame();
  const n = rec.samples.length;
  hostEnd.emit(NetTransport.STATE, PhonePad.encodeSample({ seq: 0, roll: -30, thr: 0, brk: 0, held: 0 }));
  frame(false);
  expect(rec.samples.length, "the stale left-roll must not reach the input").toBe(n);
  expect(link.stats().stale).toBe(1);
  hostEnd.emit(NetTransport.STATE, "garbage");
  frame(false);
  expect(link.stats().junk, "junk is counted and ignored").toBe(1);
});

test("the desktop's vibrate() is forwarded to the phone while it is linked", () => {
  const { phone, frame, vibrate, rec } = pair();
  phone.roll = 5;
  frame();
  expect(rec.haptics, "capability arrives before a steering sample").not.toBe(null);
  expect(rec.hapticChanges).toBe(1);
  vibrate(40);
  frame(false); frame(false);
  expect(phone.buzz, "the kerb reaches the phone in the player's hand").toEqual([40]);
});

test("a phone without a vibrator does not advertise haptics", () => {
  const { frame, rec } = pair({ phoneHaptics: false });
  frame();
  expect(rec.samples.length).toBeGreaterThan(0);
  expect(rec.haptics).toBe(null);
});

test("missing, malformed, or wrong-protocol phone capabilities cannot enable haptics", () => {
  const { hostEnd, rec } = pair({ phoneHaptics: false });
  for (const hi of [
    { t: "hi", side: "pad", p: 1 },
    { t: "hi", side: "pad", p: 1, haptics: "true" },
    { t: "hi", side: "pad", p: 999, haptics: true },
    { t: "hi", side: "host", p: 1, haptics: true },
  ]) {
    hostEnd.emit(NetTransport.EVENT, JSON.stringify(hi));
    expect(rec.haptics).toBe(null);
  }
});

test("phone capabilities arriving before both RTC channels open survive the host open callback", () => {
  const { input, rec } = fakeInput();
  const cb: { message?: (c: Channel, d: WireData) => void; open?: () => void; close?: () => void } = {};
  const transport = { status: "connecting", onMessage: (f: (c: Channel, d: WireData) => void) => { cb.message = f; }, onOpen: (f: () => void) => { cb.open = f; },
    onClose: (f: () => void) => { cb.close = f; }, send: () => true, pump() { return 0; }, close() { cb.close?.(); } };
  const link = PhonePad.link(wire(transport), { input, pump: false, doc: null });
  expect(rec.haptics).toBe(null);
  cb.message?.(NetTransport.EVENT, JSON.stringify({ t: "hi", side: "pad", p: 1, haptics: true }));
  expect(rec.haptics, "reliable EVENT channel can deliver before STATE opens").not.toBe(null);
  transport.status = "open"; cb.open?.();
  expect(rec.haptics, "opening the second channel must not erase the hello").not.toBe(null);
  link.close();
  expect(rec.haptics).toBe(null);
});

test("the dash reaches the phone ~15 Hz on the unreliable channel and paints the wheel's LCD", () => {
  const { phone, frame, dash, link } = pair();
  frame();
  expect(phone.huds.length, "a sampler returning null sends nothing").toBe(0);
  dash.value = { gear: 5, kmh: 241, rpm: 0.8, lap: 2, laps: 10, pos: 3, cars: 20, ers: 0.4,
    flags: PhonePad.DASH.otArmed | PhonePad.DASH.xOpen, caution: 0, lastLapMs: 88123, state: "race", team: "#dc0000" };
  for (let i = 0; i < 60; i++) frame();
  expect(phone.huds.length).toBeGreaterThanOrEqual(12);
  expect(phone.huds.length).toBeLessThanOrEqual(17);
  const sent = link.stats().huds;
  expect(sent >= phone.huds.length && sent - phone.huds.length <= 1, `sent ${sent}, received ${phone.huds.length}`).toBe(true);
  const el = lcd();
  const h0 = phone.huds[0] as PadHud;
  PhonePad.paintHud(el, phone.huds.at(-1));
  expect(el.gear.textContent).toBe("5");
  expect(el.speed.textContent).toBe("241");
  expect(el.lap.textContent).toBe("LAP 2/10");
  expect(el.pos.textContent).toBe("P3/20");
  expect(el.last.textContent).toBe("LAST 1:28.123");
  expect(el.ot.textContent).toBe("OT READY");
  expect(el.aero.textContent).toBe("STRAIGHT MODE");
  expect(el.flag.textContent).toBe("");
  expect(el.ers.style.width).toBe("40%");
  expect(litLeds(el), "80% revs lights 12 of 15 LEDs").toBe(12);
  expect(el.screen.classes.has("ot-ready") && el.screen.classes.has("x-open") && !el.screen.classes.has("idle")).toBe(true);
  expect(el.team.style.props["--team"], "the LCD tints with the team").toBe("#dc0000");
  PhonePad.paintHud(el, { ...h0, gear: 0, kmh: 0, rpm: 0.2, state: "menu", flags: 0 });
  expect(el.gear.textContent).toBe("N"); expect(el.speed.textContent).toBe("---"); expect(el.flag.textContent).toBe("MENU");
  expect(litLeds(el), "no rev lights out of the race").toBe(0);
  expect(el.screen.classes.has("idle")).toBe(true);
  expect(el.body.classes.has("menu"), "out of a race the page shows the MENU PAD").toBe(true);
  PhonePad.paintHud(el, { ...h0, state: "race", flags: PhonePad.DASH.paused });
  expect(el.body.classes.has("menu") && el.flag.textContent === "PAUSED", "paused inside a race: the pad").toBe(true);
  PhonePad.paintHud(el, { ...h0, state: "race", flags: 0 });
  expect(el.body.classes.has("menu"), "racing again: the wheel").toBe(false);
  PhonePad.paintHud(el, { ...h0, state: "race", caution: 3 });
  expect(el.flag.textContent).toBe("SAFETY CAR"); expect(el.screen.classes.has("caution")).toBe(true);
  PhonePad.paintHud(el, { ...h0, state: "count", flags: PhonePad.DASH.timeTrial });
  expect(el.flag.textContent).toBe("LIGHTS"); expect(el.lap.textContent).toBe("TT"); expect(el.pos.textContent).toBe("");
  PhonePad.paintHud(el, { ...h0, flags: PhonePad.DASH.retired });
  expect(el.pos.textContent).toBe("DNF");
});

const BASE_HUD: PadHud = { gear: 3, kmh: 100, rpm: 0.5, lap: 1, laps: 1, pos: 1, cars: 1, ers: 0.5, flags: 0, caution: 0, lastLapMs: 0, state: "race", team: "" };

test("the LCD says Q / PRAC where the race HUD does, not a race position (R2-08)", () => {
  const D = PhonePad.DASH, el = lcd();
  PhonePad.paintHud(el, BASE_HUD);
  expect(el.pos.textContent, "a race still reads its position").toBe("P1/1");
  PhonePad.paintHud(el, { ...BASE_HUD, flags: D.quali });
  expect(el.pos.textContent).toBe("Q");
  PhonePad.paintHud(el, { ...BASE_HUD, pos: 7, cars: 20, flags: D.practice });
  expect(el.pos.textContent).toBe("PRAC");
  PhonePad.paintHud(el, { ...BASE_HUD, flags: D.quali | D.retired });
  expect(el.pos.textContent, "a retirement outranks the session tag").toBe("DNF");
  expect(PhonePad.decodeHud(PhonePad.encodeHud({ ...BASE_HUD, flags: D.quali | D.practice }))?.flags).toBe(D.quali | D.practice);
});

test("the control modes reach the wheel's layout: no paddles on AUTO gears, no GAS zone on AUTO throttle, AERO greyed on AUTO or no zones", () => {
  const D = PhonePad.DASH, el = lcd();
  const base = { ...BASE_HUD, laps: 5, pos: 2, cars: 20 };
  PhonePad.paintHud(el, base);
  expect([...el.body.classes].sort(), "everything manual: no layout class").toEqual([]);
  expect(el.aero.textContent).toBe("AERO");
  PhonePad.paintHud(el, { ...base, flags: D.gearsAuto | D.throttleAuto });
  expect([...el.body.classes].sort()).toEqual(["gears-auto", "throttle-auto"]);
  PhonePad.paintHud(el, { ...base, flags: D.aeroAuto | D.xOpen });
  expect([...el.body.classes].sort(), "a mode change clears the classes it no longer needs").toEqual(["aero-auto"]);
  expect(el.aero.textContent).toBe("AUTO STRAIGHT");
  PhonePad.paintHud(el, { ...base, flags: D.aeroAuto });
  expect(el.aero.textContent).toBe("AERO AUTO");
  PhonePad.paintHud(el, { ...base, flags: D.aeroNone | D.xArmed });
  expect([...el.body.classes].sort()).toEqual(["aero-none"]);
  expect(el.aero.textContent, "a circuit with no zones says so whatever the arming").toBe("NO ZONES");
  expect(PhonePad.decodeHud(PhonePad.encodeHud({ ...base, flags: D.gearsAuto | D.throttleAuto | D.aeroAuto | D.aeroNone }))?.flags)
    .toBe(D.gearsAuto | D.throttleAuto | D.aeroAuto | D.aeroNone);
  const page = read("controller.html");
  for (const rule of ["body.gears-auto .shift", "body.gears-auto .tap { display: flex; }", "body.throttle-auto #gas", "body.aero-auto #b-aero, body.aero-none #b-aero"]) {
    expect(page.includes(rule), `controller.html styles ${rule}`).toBe(true);
  }
});

test("closing the link drops the source at once and unhooks the haptics", () => {
  const { phone, frame, link, session, closedCount, rec, vibrate } = pair();
  phone.thr = 1; phone.roll = 20;
  for (let i = 0; i < 30; i++) frame();
  session.close();
  frame(false);
  expect(closedCount(), "the desktop learned the phone left").toBe(1);
  expect(rec.lost, "the input drops the phone's pedals").toEqual(["phone"]);
  expect(rec.haptics).toBe(null);
  expect(link.stats().open).toBe(false);
  vibrate(30);
  expect(phone.buzz.length, "no haptic is forwarded to a phone that is gone").toBe(0);
});

// ─── the phone page's wiring: pad() over a mini DOM ─────────────────────────

test("pad(): GAS and BRAKE keep the strongest contact and clear travel on release or blur", () => {
  const page = stubPage();
  const dom = { gas: fakeEl(), brake: fakeEl() };
  const ctl = PhonePad.pad(asDom(dom));
  try {
    for (const [name, stateKey] of [["gas", "thr"], ["brake", "brk"]] as const) {
      const pedal = dom[name];
      const contact = (t: string, pointerId: number, clientY = 200) => pedal.dispatch(t, { pointerId, clientY });
      const value = (expected: number, reason: string) => {
        expect(ctl.state()[stateKey], name + ": " + reason).toBe(expected);
        expect(pedal.style.props["--travel"], name + ": fill matches transmitted travel").toBe(expected.toFixed(2));
      };
      contact("pointerdown", 11);
      contact("pointerdown", 12);
      contact("pointermove", 12, 98);
      value(1, "an eased second finger cannot override the full first finger");
      contact("pointerup", 12);
      value(1, "releasing the eased finger preserves full travel");
      contact("pointerdown", 12);
      contact("pointermove", 11, 98);
      value(1, "the later full finger also wins over an eased first finger");
      page.doc("pointerup", { pointerId: 12 });
      value(0.12, "document release restores the surviving eased contact");
      contact("pointercancel", 11);
      value(0, "last cancellation clears the pedal");
      expect(pedal.classes.has("on")).toBe(false);
      contact("pointerdown", 21);
      contact("pointerdown", 22);
      page.win("blur");
      value(0, "blur clears both contacts and the fill");
      contact("pointermove", 21, 200);
      value(0, "a stale pointer cannot reactivate after blur");
      contact("pointerdown", 23);
      contact("pointermove", 23, 98);
      value(0.12, "a new single contact retains analog travel");
      page.doc("touchend", { touches: [] });
      value(0, "the all-fingers-up fallback clears travel");
    }
  } finally { ctl.cancel(); }
});

test("the phone controller accepts a full private relay token and explains an incomplete one", async () => {
  const dom = { codeIn: fakeEl(), status: fakeEl() };
  dom.codeIn.maxLength = 8;
  const page = PhonePad.pad(asDom(dom), { deps: { privateRelay: () => true, normalise: (c) => String(c), valid: () => false } });
  expect(dom.codeIn.maxLength).toBe(32);
  expect(dom.codeIn.placeholder).toBe("PRIVATE ROOM TOKEN");
  expect((await page.connect("ABC123")) as { error?: string }).toMatchObject({ error: "bad_code" });
  expect(dom.status.textContent).toMatch(/full 32-character token/);
});

test("a fresh phone learns the private Worker only on CONNECT, with its token confined to the fragment", async () => {
  const secret = "ABCDEFGH23456789ABCDEFGH23456789";
  const endpoint = "https://relay.test/custom/base";
  const url = PhonePad.padUrl(secret, "https://game.test/index.html", endpoint);
  const parsed = new URL(url);
  expect(parsed.search).toBe(""); expect(parsed.pathname).toBe("/controller.html");
  expect(parsed.hash).toBe("#pad=" + secret + "&relay=" + encodeURIComponent(endpoint));
  let selected: string | null = null;
  const calls: (string | null)[] = [], swaps: { code: string; endpoint: string | null }[] = [];
  const dom = { codeIn: fakeEl(), status: fakeEl() };
  const ctl = PhonePad.pad(asDom(dom), { href: url, deps: {
    privateRelay: () => !!selected,
    setSessionUrl(value) { calls.push(value); selected = value; return true; },
    normalise: (c) => String(c), valid: (c) => !!selected && c.length === 32,
    prefetchIce: async () => null, rtc: () => wire({ close() {} }),
    swap: async (o) => { swaps.push({ code: o.code, endpoint: selected }); return { ok: false, error: "expired" }; },
  } });
  expect(dom.codeIn.value).toBe(secret); expect(dom.codeIn.maxLength).toBe(32);
  expect(calls, "opening a QR URL must not change relay configuration").toEqual([]);
  await ctl.connect(dom.codeIn.value);
  expect(calls).toEqual([endpoint]);
  expect(swaps).toEqual([{ code: secret, endpoint }]);
});

test("public QR clears a previous private document override, while invalid relay metadata makes no network request", async () => {
  for (const relay of [null, "http://remote.test", "https://u:p@relay.test", "https://relay.test/?secret=x", "https://relay.test/#x", "%E0%A4%A"]) {
    let selected: string | null = "https://previous.test", changes = 0, network = 0;
    const href = "https://game.test/controller.html#pad=ABC234" + (relay === null ? "" : "&relay=" + encodeURIComponent(relay));
    const ctl = PhonePad.pad(asDom({ codeIn: fakeEl(), status: fakeEl() }), { href, deps: {
      privateRelay: () => !!selected, setSessionUrl(value) { selected = value; changes++; return true; },
      normalise: (c) => String(c), valid: (c) => !selected && c.length === 6,
      prefetchIce: async () => { network++; }, rtc: () => null,
    } });
    expect(changes).toBe(0);
    const result = await ctl.connect("ABC234") as { error?: string };
    expect(changes).toBe(relay === null ? 1 : 0);
    expect(network).toBe(relay === null ? 1 : 0);
    expect(result.error).toBe(relay === null ? "no_transport" : "bad_relay");
  }
  expect(() => PhonePad.padUrl("ABC234", "https://game.test/", "http://remote.test")).toThrow(/Invalid private pairing/);
});

function wiredDom() {
  const buttons: Record<string, FakeEl | FakeEl[]> = Object.fromEntries(PhonePad.EVENTS.map((k) => [k, fakeEl()]));
  buttons.overtake = [fakeEl(), fakeEl()]; // OT lives on the grip AND the face
  return { body: fakeEl(), status: fakeEl(), codeIn: fakeEl(), connect: fakeEl(), gas: fakeEl(), brake: fakeEl(), lookBack: fakeEl(),
    center: fakeEl(), rim: fakeEl(), buttons, hud: lcd(), stick: fakeEl(), nub: fakeEl(),
    arrows: { navUp: fakeEl(), navDown: fakeEl(), navLeft: fakeEl(), navRight: fakeEl() } };
}
const btn = (dom: ReturnType<typeof wiredDom>, k: string): FakeEl => dom.buttons[k] as FakeEl;

test("pad(): the page's pedals, paddles and LCD are wired through to the wire and back", async () => {
  const desk = fakeInput();
  const [padEnd, hostEnd] = NetTransport.loopback({ latencyMs: 2, rnd: NetTransport.seededRnd(3) });
  padEnd.pump(0); hostEnd.pump(0);
  const clock = { t: 0 };
  const dash = { value: { gear: 7, kmh: 301, rpm: 0.95, lap: 9, laps: 9, pos: 1, cars: 20, ers: 0.1, flags: PhonePad.DASH.redline, caution: 0, lastLapMs: 0, state: "race", team: "#0b0e10" } };
  const link = PhonePad.link(hostEnd, { input: desk.input, pump: false, doc: null, now: () => clock.t, hud: () => dash.value });
  const dom = wiredDom();
  const seen: string[] = [];
  const timers = fakeTimers();
  const ctl = PhonePad.pad(asDom(dom), { now: () => clock.t, timers: timers.timers, deps: {
    rtc: () => padEnd, prefetchIce: async () => null, normalise: (c) => String(c).toUpperCase(), valid: (c) => c.length === 6,
    swap: async (o) => { seen.push("swap:" + o.code); const ans = await o.reply?.("OFFER"); return ans ? { ok: true } : { ok: false, error: "reply_failed" }; },
    acceptInvite: async (_t, invite) => { seen.push("accept:" + invite); return { ok: true, code: "ANSWER" }; },
  } });
  expect(dom.status.textContent, "the page asks for a code when the URL carries none").toMatch(/room code/i);
  const bad = await ctl.connect("nope") as { error?: string };
  expect(bad.error).toBe("bad_code"); expect(dom.status.classes.has("bad")).toBe(true);
  expect(await ctl.connect("abc234")).toEqual({ ok: true });
  expect(seen, "the code is normalised, the offer answered").toEqual(["swap:ABC234", "accept:OFFER"]);
  expect(ctl.state().linked && dom.body.classes.has("linked"), "the wheel shows once the channel is open").toBe(true);
  const frame = () => { clock.t += STEP; ctl.pump(); link.pump(); };
  const thr = () => desk.last()?.thr ?? 0;
  // GAS: STAMP THEN EASE (R3-PHONE-2): a touch anywhere is full travel, a slide up eases it.
  dom.gas.dispatch("pointerdown", { clientY: 100 + 200 * 0.1 });
  for (let i = 0; i < 3; i++) frame();
  expect(thr(), "a stamp near the top edge is full travel, not 0.3").toBe(1);
  expect(dom.gas.style.props["--travel"], "the fill shows the travel it sends").toBe("1.00");
  dom.gas.dispatch("pointermove", { clientY: 100 + 200 * 0.1 - 45 }); // slid 45 px up
  for (let i = 0; i < 3; i++) frame();
  const eased = 1 - (45 - 12) / 90;
  expect(Math.abs(thr() - eased)).toBeLessThan(0.02);
  expect(dom.gas.style.props["--travel"]).toBe(eased.toFixed(2));
  dom.gas.dispatch("pointermove", { clientY: 100 + 200 * 0.1 + 60 }); // back down past the landing point: full again
  for (let i = 0; i < 3; i++) frame();
  expect(thr()).toBe(1);
  dom.gas.dispatch("pointermove", { clientY: -500 }); // dragged far off the top: the floor, not a release
  for (let i = 0; i < 3; i++) frame();
  expect(Math.abs(thr() - 0.12)).toBeLessThan(0.02);
  expect(dom.gas.classes.has("on")).toBe(true);
  dom.gas.dispatch("pointerup", {});
  for (let i = 0; i < 3; i++) frame();
  expect(thr()).toBe(0); expect(dom.gas.classes.has("on")).toBe(false);
  // The paddle: an edge on the DOWN, once.
  btn(dom, "shiftUp").dispatch("pointerdown", {});
  for (let i = 0; i < 3; i++) frame();
  expect(desk.rec.events).toEqual(["shiftUp"]);
  dom.center.dispatch("pointerdown", {});
  for (let i = 0; i < 3; i++) frame();
  expect(desk.rec.events.at(-1), "CENTRE TILT is the calib edge").toBe("calib");
  (dom.buttons.overtake as FakeEl[])[1]?.dispatch("pointerdown", {});
  for (let i = 0; i < 3; i++) frame();
  expect(desk.rec.events.at(-1), "the second OT button (the grip's) fires the same edge").toBe("overtake");
  // MENU PAD: a held direction repeats at 380 ms, then every 110 ms; the release stops it.
  const e0 = link.stats().events;
  btn(dom, "navDown").dispatch("pointerdown", {});
  for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "one edge on the down").toBe(e0 + 1);
  timers.advance(379); for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "nothing before the delay").toBe(e0 + 1);
  timers.advance(1); timers.advance(220); for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "then two repeats in 220 ms").toBe(e0 + 3);
  btn(dom, "navDown").dispatch("pointerup", {});
  timers.advance(1000); for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "released: no more").toBe(e0 + 3); expect(timers.pending(), "and no timer left behind").toBe(0);
  btn(dom, "navSelect").dispatch("pointerdown", {}); btn(dom, "navSelect").dispatch("pointerup", {});
  for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "SELECT is one edge").toBe(e0 + 4); expect(timers.pending(), "and never repeats").toBe(0);
  // THE MENU STICK (fakeEl's box: centre 50,200, radius 50).
  const s0 = link.stats().events;
  dom.stick.dispatch("pointerdown", { clientX: 50, clientY: 205 });
  for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "a thumb in the middle fires nothing").toBe(s0);
  dom.stick.dispatch("pointermove", { clientX: 50, clientY: 110 });
  for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "dragged up: one navUp").toBe(s0 + 1);
  expect(dom.arrows.navUp.classes.has("on") && dom.stick.classes.has("on"), "the up arrow lights").toBe(true);
  expect(dom.nub.style.transform, "the nub follows, clamped to 55 % of the radius").toMatch(/^translate\(0\.0px,-27\.5px\)$/);
  dom.stick.dispatch("pointermove", { clientX: 60, clientY: 150 }); // still mostly up: no flicker
  dom.stick.dispatch("pointermove", { clientX: 95, clientY: 195 });
  for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "turned right: one navRight, and no second navUp").toBe(s0 + 2);
  expect(dom.arrows.navRight.classes.has("on") && !dom.arrows.navUp.classes.has("on")).toBe(true);
  timers.advance(380); timers.advance(110); for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "held right repeats like a key").toBe(s0 + 3);
  dom.stick.dispatch("pointerup", {});
  timers.advance(1000); for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "released: nothing more").toBe(s0 + 3);
  expect(timers.pending(), "and no timer left behind").toBe(0);
  expect(dom.nub.style.transform, "the nub springs home").toBe("");
  expect(!dom.arrows.navRight.classes.has("on") && !dom.stick.classes.has("on")).toBe(true);
  dom.stick.dispatch("pointerdown", { clientX: 5, clientY: 200 });
  for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "a tap on the left edge is navLeft at once").toBe(s0 + 4);
  expect(desk.rec.events.slice(-5)).toEqual(["navSelect", "navUp", "navRight", "navRight", "navLeft"]);
  dom.stick.dispatch("pointerup", {});
  // Tilt: setRoll() stands in for the sensor; the rim turns, the desktop gets the roll.
  ctl.setRoll(30);
  for (let i = 0; i < 60; i++) { frame(); ctl.setRoll(30); }
  expect(dom.rim.style.transform, "the rim leans at 0.6 of the roll").toBe("rotate(18.0deg)");
  ctl.setRoll(80); expect(dom.rim.style.transform, "and never past 25°").toBe("rotate(25.0deg)");
  ctl.setRoll(30); frame();
  expect(desk.last()?.roll, "the phone's 30° reaches the input").toBe(30);
  // The dash came back and painted the LCD: gear 7, redline, one LED short of all fifteen.
  expect(dom.hud.gear.textContent).toBe("7");
  expect(dom.hud.speed.textContent).toBe("301");
  expect(dom.hud.lap.textContent).toBe("LAP 9/9");
  expect(dom.hud.pos.textContent).toBe("P1/20");
  expect(dom.hud.screen.classes.has("redline")).toBe(true);
  expect(litLeds(dom.hud)).toBe(14);
  expect(dom.hud.team.style.props["--team"]).toBe("#0b0e10");
  expect(ctl.state().stats?.huds, "dash packets counted on the phone").toBeGreaterThan(5);
  // The desktop drops the link: the wheel goes back to the pairing screen.
  link.close();
  frame();
  expect(ctl.state().linked).toBe(false); expect(dom.body.classes.has("linked")).toBe(false);
  expect(dom.status.textContent).toMatch(/Disconnected/);
  expect(dom.connect.disabled, "CONNECT is offered again").toBe(false);
});

test("pad(): a lost lift on the menu stick or a held arrow is caught by the all-fingers-up / hidden nets (hunt3 7-F5)", async () => {
  const desk = fakeInput();
  const [padEnd, hostEnd] = NetTransport.loopback({ latencyMs: 2, rnd: NetTransport.seededRnd(3) });
  padEnd.pump(0); hostEnd.pump(0);
  const clock = { t: 0 };
  const link = PhonePad.link(hostEnd, { input: desk.input, pump: false, doc: null, now: () => clock.t, hud: () => null });
  const page = stubPage();
  const dom = wiredDom();
  const timers = fakeTimers();
  const ctl = PhonePad.pad(asDom(dom), { now: () => clock.t, timers: timers.timers, deps: {
    rtc: () => padEnd, prefetchIce: async () => null, normalise: (c) => String(c).toUpperCase(), valid: (c) => c.length === 6,
    swap: async (o) => { const ans = await o.reply?.("OFFER"); return ans ? { ok: true } : { ok: false, error: "reply_failed" }; },
    acceptInvite: async () => ({ ok: true, code: "ANSWER" }),
  } });
  expect(await ctl.connect("abc234")).toEqual({ ok: true });
  const frame = () => { clock.t += STEP; ctl.pump(); link.pump(); };
  dom.stick.dispatch("pointerdown", { clientX: 95, clientY: 200 });
  for (let i = 0; i < 3; i++) frame();
  const s0 = link.stats().events;
  page.doc("touchend", { touches: [] });
  timers.advance(1000); for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "no repeat after every finger is up").toBe(s0);
  expect(timers.pending(), "and no timer left behind").toBe(0);
  expect(!dom.stick.classes.has("on") && !dom.arrows.navRight.classes.has("on"), "the stick and its arrow go dark").toBe(true);
  dom.stick.dispatch("pointerdown", { pointerId: 2, clientX: 5, clientY: 200 });
  for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "the stick takes the next press (its pointer slot was freed)").toBe(s0 + 1);
  dom.stick.dispatch("pointerup", { pointerId: 2 });
  btn(dom, "navDown").dispatch("pointerdown", {});
  for (let i = 0; i < 3; i++) frame();
  const a0 = link.stats().events;
  page.document.hidden = true;
  page.doc("visibilitychange", {});
  timers.advance(1000); for (let i = 0; i < 3; i++) frame();
  expect(link.stats().events, "a hidden page stops the arrow's repeat").toBe(a0);
  expect(timers.pending()).toBe(0);
  expect(btn(dom, "navDown").classes.has("on")).toBe(false);
  link.close(); frame();
});

// ─── the desktop's pairing flow: host() with the signalling stood in for ─────

function hostHarness(over: Partial<PhonePad.HostDeps> = {}) {
  const desk = fakeInput();
  const clock = { t: 0 };
  const [padEnd, hostEnd] = NetTransport.loopback({ latencyMs: 1, rnd: NetTransport.seededRnd(5) });
  padEnd.pump(0); hostEnd.pump(0);
  const ui = {
    said: [] as string[], qrs: [] as { url: string | null; code: string | null }[], linkedN: 0, lostN: 0, relinkN: 0, failedN: 0,
    recoveries: [] as PhonePad.HostRecovery[],
    say: (t: string, bad: boolean) => { ui.said.push((bad ? "!" : "") + t); }, qr: (url: string | null, code: string | null) => { ui.qrs.push({ url, code }); },
    linked: () => { ui.linkedN++; }, lost: () => { ui.lostN++; }, relinking: () => { ui.relinkN++; }, failed: () => { ui.failedN++; },
    recovery: (r: PhonePad.HostRecovery) => { ui.recoveries.push(r); }, hud: () => null,
  };
  const room = {
    stopped: 0, stop() { room.stopped++; },
    onJoiner: null as ((who: null, answer: string) => unknown) | null,
    onFail: null as ((r: { ok: false; error: string; message: string }) => void) | null,
    onTick: null as (() => void) | null,
    token: null as { cancelled: boolean } | null,
  };
  const deps: Partial<PhonePad.HostDeps> & { input: PhonePadInput } = {
    input: desk.input,
    rtc: () => hostEnd, prefetchIce: async () => null, makeCode: () => "ABC234", relayUrl: () => "https://relay.test/base",
    usingPrivateRelay: () => false,
    createInvite: async () => ({ ok: true, code: "OFFER" }),
    acceptAnswer: async () => ({ ok: true }),
    hostRoom: async (o) => {
      room.onJoiner = o.onJoiner ?? null; room.onFail = o.onFail ?? null; room.onTick = o.onTick ?? null; room.token = o.token ?? null;
      return { ok: true, stop: room.stop };
    },
    ...over,
  };
  const ctl = PhonePad.host(ui, deps);
  return { ...desk, clock, ui, room, ctl, padEnd, hostEnd };
}

test("host(): prepares, mints a code, paints the QR, waits, links on the phone's answer, then closes the room", async () => {
  const h = hostHarness();
  await settle();
  expect(h.ctl.state().phase).toBe("waiting");
  expect(h.ctl.state().code).toBe("ABC234");
  expect(h.ui.qrs, "the QR carries controller.html#pad=CODE").toEqual([{ url: PhonePad.padUrl("ABC234"), code: "ABC234" }]);
  expect(h.ui.said.at(-1)).toMatch(/Scan the code/);
  expect(h.room.onJoiner, "the room is hosted").toBeTruthy();
  await h.room.onJoiner?.(null, "ANSWER");
  await settle();
  expect(h.ctl.state().phase, "the loopback end is already open, so the link opens at once").toBe("linked");
  expect(h.ui.linkedN).toBe(1);
  expect(h.room.stopped, "the room closes once the phone is on").toBe(1);
  expect(h.room.token?.cancelled).toBe(true);
  expect(h.ui.qrs.at(-1), "the QR is taken down").toEqual({ url: null, code: null });
  expect(h.ui.said.at(-1)).toMatch(/connected/i);
  await h.room.onJoiner?.(null, "ANSWER-2"); await settle();
  expect(h.ui.linkedN, "a second answer is ignored").toBe(1);
  h.padEnd.close(); await settle();
  expect(h.ctl.state().phase).toBe("lost");
  expect(h.ui.lostN).toBe(1);
  expect(h.ui.said.at(-1)).toMatch(/^!Phone disconnected/);
  expect(h.rec.lost, "the input drops the phone").toEqual(["phone"]);
  h.ctl.cancel(); // idempotent after lost
  expect(h.ctl.state().phase).toBe("cancelled");
});

test("host(): an unreadable answer goes back to waiting; a room that will not open fails; cancel while waiting tears down", async () => {
  const bad = hostHarness({ acceptAnswer: async () => ({ ok: false, error: "corrupt_code", message: "That code is incomplete." }) });
  await settle();
  await bad.room.onJoiner?.(null, "JUNK"); await settle();
  expect(bad.ctl.state().phase, "back to waiting for a readable answer").toBe("waiting");
  expect(bad.ui.said.at(-1)).toMatch(/^!That code is incomplete/);
  bad.ctl.cancel();
  expect(bad.room.stopped).toBe(1); expect(bad.hostEnd.status).toBe("closed");

  const noRoom = hostHarness({ hostRoom: async () => ({ ok: false, error: "no_relay", message: "Could not reach any room service." }) });
  await settle();
  expect(noRoom.ctl.state().phase).toBe("failed");
  expect(noRoom.ui.said.at(-1)).toMatch(/^!Could not reach any room service/);

  const noRtc = hostHarness({ rtc: () => null });
  await settle();
  expect(noRtc.ctl.state().phase).toBe("failed");
  expect(noRtc.ui.said.at(-1)).toMatch(/WebRTC is unavailable/);

  const lostEarly = hostHarness();
  await settle();
  await lostEarly.room.onJoiner?.(null, "ANSWER");
  lostEarly.padEnd.close(); await settle();
  expect(lostEarly.ctl.state().phase).toBe("lost");
  expect(lostEarly.room.stopped, "a lost link drops the room's relay sockets").toBe(1);
});

test("host(): a linked phone whose WIRE dies is hosted again on the SAME code; the phone's own goodbye is final (R3-PHONE-3)", async () => {
  const pairs: [LoopbackEndpoint, Tapped][] = [];
  let minted = 0;
  const rtc = () => {
    const [a, b] = NetTransport.loopback({ latencyMs: 1, rnd: NetTransport.seededRnd(9 + pairs.length) });
    a.pump(0); b.pump(0);
    const p: [LoopbackEndpoint, Tapped] = [a, tap(b)];
    pairs.push(p); return p[1];
  };
  // ICE failing (a locked phone, a call): a close that is NOT the phone's "peer" goodbye.
  const drop = (p: [LoopbackEndpoint, Tapped] | undefined, why: CloseReason) => { p?.[1].fail(why); };
  const h = hostHarness({ rtc, makeCode: () => { minted++; return "ABC234"; } });
  await settle();
  await h.room.onJoiner?.(null, "ANSWER"); await settle();
  expect(h.ctl.state().phase).toBe("linked");
  drop(pairs[0], "failed"); await settle();
  expect(h.rec.lost, "the dead phone stops steering at once").toEqual(["phone"]);
  expect(h.ctl.state().phase, "the room is open again, not lost").toBe("waiting");
  expect(h.ctl.state().code).toBe("ABC234"); expect(minted, "the SAME code: no new QR to scan").toBe(1);
  expect(pairs.length, "on a fresh transport").toBe(2);
  expect(h.ui.relinkN).toBe(1); expect(h.ui.lostN, "the page is not told to re-pair").toBe(0);
  await h.room.onJoiner?.(null, "ANSWER-2"); await settle();
  expect(h.ctl.state().phase).toBe("linked"); expect(h.ui.linkedN, "the same phone is back on").toBe(2);
  pairs[1]?.[0].close(); await settle();
  expect(h.ctl.state().phase, "the phone's own goodbye is final").toBe("lost"); expect(h.ui.lostN).toBe(1);
  expect(h.ui.said.at(-1)).toMatch(/^!Phone disconnected/);
  expect(pairs.length, "no room hosted again after a goodbye").toBe(2);

  pairs.length = 0;
  const g = hostHarness({ rtc });
  await settle(); await g.room.onJoiner?.(null, "ANSWER"); await settle();
  drop(pairs[0], "disconnected"); await settle();
  expect(g.ctl.state().phase).toBe("waiting");
  g.room.onFail?.({ ok: false, error: "timeout", message: "Nobody joined." });
  expect(g.ctl.state().phase).toBe("failed"); expect(g.ui.lostN, "the page restores its camera and button").toBe(1);
  expect(g.ui.said.at(-1)).toMatch(/^!Nobody joined/);
  g.ctl.cancel();
  expect(pairs[1]?.[1].status, "cancel closes the re-link's transport too").toBe("closed");
});

test("pad(): SCAN reads the game's QR in the page, fills the code and connects; a refused camera says so", async () => {
  const [padEnd] = NetTransport.loopback({ latencyMs: 1, rnd: NetTransport.seededRnd(9) });
  let onCode: ((text: string) => void) | null = null, started = 0;
  let cam: { ok: true } | { ok: false; error: "denied"; message: string } = { ok: true };
  const Scan = { supported: () => true, create: () => ({
    start: async (_video: unknown, cb: (text: string) => void) => { started++; onCode = cb; return cam; },
    stop: () => { onCode = null; }, active: () => !!onCode, decoder: () => null }) };
  const swaps: string[] = [];
  const dom = { body: fakeEl(), status: fakeEl(), codeIn: fakeEl(), connect: fakeEl(), scan: fakeEl(), scanBox: fakeEl(), video: fakeEl(), buttons: {}, hud: lcd() };
  dom.scanBox.hidden = true;
  const ctl = PhonePad.pad(asDom(dom), { deps: { scan: () => Scan, rtc: () => padEnd, prefetchIce: async () => null,
    normalise: (c) => String(c).toUpperCase(), valid: (c) => c.length === 6,
    swap: async (o) => { swaps.push(o.code); return { ok: false, error: "expired" }; }, acceptInvite: async () => ({ ok: false }) } });
  expect(dom.status.textContent, "the prompt offers the camera first").toMatch(/Scan the game's QR code/);
  const r = await ctl.scan();
  expect(r.ok && started === 1 && !dom.scanBox.hidden, "the camera view opens").toBe(true);
  expect(dom.scan.textContent).toBe("CANCEL SCAN");
  const deliver = onCode as ((text: string) => void) | null; onCode = null; // NetScan stops itself before it hands the code over
  deliver?.("https://example.test/apex-26/controller.html#pad=xyz789");
  await settle();
  expect(dom.codeIn.value, "the code is lifted from the game's pairing URL").toBe("xyz789");
  expect(swaps, "and CONNECT runs on it without another tap").toEqual(["XYZ789"]);
  expect(dom.scanBox.hidden && dom.scan.textContent === "SCAN QR CODE", "the camera view closes").toBe(true);
  cam = { ok: false, error: "denied", message: "Camera access was refused. Allow it, or paste the code instead." };
  const r2 = await ctl.scan() as { error?: string };
  expect(r2.error).toBe("denied");
  expect(dom.status.textContent, "the page's own words: there is no paste box here").toMatch(/or type the code instead/);
  expect(dom.status.classes.has("bad") && dom.scanBox.hidden).toBe(true);
  const dom2 = { body: fakeEl(), status: fakeEl(), codeIn: fakeEl(), connect: fakeEl(), scan: fakeEl(), buttons: {}, hud: lcd() };
  PhonePad.pad(asDom(dom2), { deps: { scan: () => ({ supported: () => false, create: () => NetScan.create() }) } });
  expect(dom2.scan.hidden, "a browser with no camera API never shows the button").toBe(true);
});

test("link(): the phone's focus wears .pad-ring (a browser may not draw it), until a real key or pointer takes over", () => {
  const [padEnd, hostEnd] = NetTransport.loopback({ latencyMs: 1, rnd: NetTransport.seededRnd(4) });
  padEnd.pump(0); hostEnd.pump(0);
  const L: Record<string, ((e: object) => void)[]> = {};
  const mk = (id: string) => { const n = { id, classes: new Set<string>(), classList: { add: (c: string) => { n.classes.add(c); }, remove: (c: string) => { n.classes.delete(c); } } }; return n; };
  const a = mk("a"), b = mk("b");
  const doc = { body: mk("body"), documentElement: mk("html"), activeElement: null as unknown,
    addEventListener: (t: string, f: (e: object) => void) => { (L[t] ||= []).push(f); },
    removeEventListener: (t: string, f: (e: object) => void) => { L[t] = (L[t] || []).filter((g) => g !== f); } };
  const fire = (t: string, ev: object) => { for (const f of L[t] || []) f(ev); };
  // The desktop's input stands in: a nav moves focus the way the menus would.
  const { input } = fakeInput();
  input.remoteEvent = (k) => { if (k === "navDown") { doc.activeElement = doc.activeElement === a ? b : a; fire("focusin", { target: doc.activeElement }); } return true; };
  const clock = { t: 0 };
  const link = PhonePad.link(hostEnd, { input, pump: false, now: () => clock.t, doc: doc as unknown as RingDoc });
  const sess = PhonePad.padSession(padEnd, { roll: () => null, thr: () => 0, brk: () => 0, held: () => 0 }, { now: () => clock.t, heartbeat: false });
  const step = () => { for (let i = 0; i < 4; i++) { clock.t += STEP; sess.pump(); link.pump(); } };
  step();
  doc.activeElement = b; fire("focusin", { target: b });
  expect(b.classes.has("pad-ring"), "no ring before the phone navigates").toBe(false);
  sess.event("navDown"); step();
  expect(a.classes.has("pad-ring") && !b.classes.has("pad-ring"), "the phone's focus is ringed").toBe(true);
  sess.event("navDown"); step();
  expect(b.classes.has("pad-ring") && !a.classes.has("pad-ring"), "and the ring moves with it").toBe(true);
  fire("keydown", { isTrusted: false });
  expect(b.classes.has("pad-ring"), "the pad's own synthetic keys do not count as the desktop's").toBe(true);
  fire("pointerdown", { isTrusted: true });
  expect(b.classes.has("pad-ring"), "a real click on the desktop takes over").toBe(false);
  sess.event("navDown"); step();
  expect(a.classes.has("pad-ring")).toBe(true);
  link.close();
  expect(!a.classes.has("pad-ring") && !(L.focusin || []).length, "closing the link clears the ring and its listeners").toBe(true);
});

// ─── the page itself (the apex-26 half of phone-pad.test.mjs:1105-1183) ─────

test("controller.html is landscape-only, zoom-proof, and declares every element controller-page.ts hands to pad()", () => {
  const page = read("controller.html"), script = read("src/net/controller-page.ts");
  expect(page).toMatch(/<script type="module" src="\/src\/net\/controller-page\.ts"><\/script>/);
  expect(page, "no import map: Vite bundles the entry").not.toMatch(/importmap/);
  expect(page).toMatch(/#keys button \{ padding: 0; min-height: clamp\(48px, 14vh, 80px\); font-weight: 800; font-size: clamp\(12px, 3\.2vh, 18px\);/);
  expect(page).toMatch(/#screen \{ flex: 1 1 0; min-height: 0;/);
  expect(page).toMatch(/#menupad \{ position: absolute; inset: 0; display: none;/);
  expect(page).toMatch(/body\.linked\.menu #menupad \{ display: grid; \}/);
  expect(page).toMatch(/body\.menu #ctl \{ display: none; \}/);
  expect(page, "every wheel and pad element refuses browser gestures").toMatch(/#ctl, #ctl \*, #menupad, #menupad \* \{ touch-action: none; \}/);
  expect(page).toMatch(/<div id="rotate" role="status">[\s\S]*TURN THE PHONE SIDEWAYS/);
  expect(page, "portrait shows the card once linked").toMatch(/@media \(orientation: portrait\) \{ body\.linked #rotate \{ display: flex; \} \}/);
  for (const ev of ["gesturestart", "gesturechange", "gestureend", "dblclick", "touchend"]) {
    expect(script, `the ${ev} canceller`).toMatch(new RegExp(`document\\.addEventListener\\("${ev}"`));
  }
  expect(script, "native controls keep every tap").toMatch(/closest\("button,input"\)\) \{ lastT = 0; return; \}/);
  expect(script, "fullscreen then lock, on the CONNECT tap").toMatch(/requestFullscreen\(\{ navigationUI: "hide" \}\)[\s\S]*?lock\("landscape"\)/);
  expect(script).toMatch(/pause: \[\$\("b-pause"\), \$\("b-pause-menu"\)\]/);
  expect(script).toMatch(/navSelect: \$\("b-navSelect"\), navBack: \$\("b-navBack"\)/);
  expect(script).toMatch(/mtitle: \$\("mp-title"\)/);
  expect(script).toMatch(/demo=auto/); expect(script).toMatch(/demo=menu/);
  expect(read("src/net/phone-pad.ts"), "the module never looks an id up").not.toMatch(/getElementById|querySelector\(/);
  const ids = [...script.matchAll(/\$(?:<\w+>)?\("([\w-]+)"\)/g)].map((m) => m[1] as string);
  expect(ids.length).toBeGreaterThan(40);
  for (const id of ids) expect(page.includes(`id="${id}"`), `controller.html declares #${id}`).toBe(true);
  expect((page.match(/<div id="leds"[^>]*>((?:<span><\/span>)+)/) || [])[1]?.length, "fifteen rev LEDs").toBe(15 * "<span></span>".length);
  for (const id of ["gas", "brake"]) expect(page, "pedal can receive keyboard focus").toMatch(new RegExp('<div id="' + id + '"[^>]+tabindex="0"'));
  expect(read("vite.config.ts"), "a second Vite entry").toMatch(/controller: (resolve\(__dirname, )?"controller\.html"/);
});

// ─── cancellation races ─────────────────────────────────────────────────────

test("host cancellation wins over a late answer, successful or rejected", async () => {
  for (const ok of [true, false]) {
    let resolve: (v: PhonePad.AnswerLike) => void = () => {};
    const h = hostHarness({ acceptAnswer: () => new Promise((r) => { resolve = r; }) });
    await settle();
    const answer = h.room.onJoiner?.(null, "ANSWER");
    h.ctl.cancel();
    resolve(ok ? { ok } : { ok }); await answer; await settle();
    expect(h.ctl.state().phase).toBe("cancelled");
    expect(h.ctl.state().stats, "a cancelled attempt cannot create a new input link").toBe(null);
    expect(h.ui.linkedN).toBe(0);
  }
});

test("host closes a room that arrives after cancellation and ignores its late failure", async () => {
  let resolve: (v: PhonePad.HostRoomLike) => void = () => {};
  let callbacks: { onFail?: (r: { ok: false; error: string; message: string }) => void } = {};
  let stopped = 0;
  const h = hostHarness({ hostRoom: (o) => { callbacks = o; return new Promise((r) => { resolve = r; }); } });
  await settle(); h.ctl.cancel();
  resolve({ ok: true, stop() { stopped++; } }); await settle();
  expect(stopped, "the late room handle must not leak relay subscriptions").toBe(1);
  const said = h.ui.said.length;
  callbacks.onFail?.({ ok: false, error: "offline", message: "Old attempt failed" });
  expect(h.ctl.state().phase).toBe("cancelled");
  expect(h.ui.said.length).toBe(said);
});

test("closed phone sessions ignore late packets and open callbacks", () => {
  for (const side of ["host", "pad"]) {
    const cb: { message?: (c: Channel, d: WireData) => void; open?: () => void; close?: () => void } = {};
    const calls: string[] = [];
    const transport = wire({ status: "connecting", onMessage: (f: (c: Channel, d: WireData) => void) => { cb.message = f; }, onClose: (f: () => void) => { cb.close = f; },
      onOpen: (f: () => void) => { cb.open = f; }, send() { calls.push("send"); return true; }, pump() { return 0; }, close() { cb.close?.(); } });
    const input: PhonePadInput = { remoteSample() { calls.push("sample"); }, remoteEvent() { calls.push("event"); }, remoteLost() {},
      setRemoteHaptics(h) { if (h) calls.push("haptics"); } };
    const session = side === "host" ? PhonePad.link(transport, { input, pump: false, doc: null, onOpen() { calls.push("open"); } })
      : PhonePad.padSession(transport, { roll: () => 0, thr: () => 0, brk: () => 0, held: () => 0 },
        { heartbeat: false, onOpen() { calls.push("open"); }, onHud() { calls.push("hud"); }, vibrate() { calls.push("buzz"); } });
    session.close(); cb.open?.();
    cb.message?.(NetTransport.STATE, side === "host" ? PhonePad.encodeSample({ seq: 1, roll: 10, thr: 1, brk: 0, held: 0 }) : PhonePad.encodeHud({ state: "race" }) as string);
    cb.message?.(NetTransport.EVENT, PhonePad.encodeHaptic(50));
    expect(calls, side).toEqual([]);
  }
});

test("a phone connecting before hostRoom returns still closes the late room without losing the link", async () => {
  let resolve: (v: PhonePad.HostRoomLike) => void = () => {};
  let callbacks: { onJoiner?: (who: null, a: string) => unknown } = {};
  let stopped = 0;
  const h = hostHarness({ hostRoom: (o) => { callbacks = o; return new Promise((r) => { resolve = r; }); } });
  await settle(); await callbacks.onJoiner?.(null, "ANSWER");
  expect(h.ctl.state().phase).toBe("linked");
  resolve({ ok: true, stop() { stopped++; } }); await settle();
  expect(stopped).toBe(1); expect(h.ctl.state().phase).toBe("linked");
  expect(h.ui.linkedN).toBe(1); h.ctl.cancel();
});

// ─── host() over a private relay ────────────────────────────────────────────

test("host(): private relay swaps one offer/answer and the linked phone can drive", async () => {
  let request: Parameters<PhonePad.HostDeps["swap"]>[0] | null = null;
  let accepted: { transport: unknown; answer: string } | null = null, publicRooms = 0;
  const h = hostHarness({ usingPrivateRelay: () => true,
    makeCode: () => "ABCDEFGH23456789ABCDEFGH23456789",
    hostRoom: async () => { publicRooms++; return { ok: false, error: "not_supported" }; },
    swap: async (o) => { request = o; o.onTick?.(); return { ok: true, payload: "PRIVATE ANSWER" }; },
    acceptAnswer: async (transport, answer) => { accepted = { transport, answer }; return { ok: true }; },
  });
  await settle();
  const req = request as Parameters<PhonePad.HostDeps["swap"]>[0] | null;
  const acc = accepted as { transport: unknown; answer: string } | null;
  expect(publicRooms, "the private mailbox never uses the public multi-guest API").toBe(0);
  expect(req?.code).toBe("ABCDEFGH23456789ABCDEFGH23456789"); expect(req?.mine).toBe("OFFER");
  expect(h.ui.qrs[0]?.url).toBe(PhonePad.padUrl(req?.code ?? null, null, "https://relay.test/base"));
  expect(req?.slot).toBe("offer"); expect(req?.want).toBe("answer");
  expect(acc?.transport).toBe(h.hostEnd); expect(acc?.answer).toBe("PRIVATE ANSWER");
  expect(h.ctl.state().phase).toBe("linked"); expect(h.ui.linkedN).toBe(1);
  expect(req?.token?.cancelled, "linking stops the rendezvous").toBe(true);
  h.padEnd.send(NetTransport.STATE, PhonePad.encodeSample({ seq: 0, thr: 0.8, brk: 0, roll: 0, held: 0 }));
  h.hostEnd.pump(100);
  expect(h.last()?.thr, "the accepted answer installs the input link").toBe(0.8);
  h.ctl.cancel(); expect(h.hostEnd.status).toBe("closed"); expect(h.rec.lost).toEqual(["phone"]);
});

test("host(): cancelling a private exchange ignores a late answer and closes the transport", async () => {
  let resolve: (v: PhonePad.SwapLike) => void = () => {};
  let token: { cancelled: boolean } | undefined, accepted = 0;
  const h = hostHarness({ usingPrivateRelay: () => true,
    swap: (o) => { token = o.token; return new Promise((r) => { resolve = r; }); },
    acceptAnswer: async () => { accepted++; return { ok: true }; },
  });
  await settle(); h.ctl.cancel();
  expect(token?.cancelled).toBe(true); expect(h.hostEnd.status).toBe("closed");
  resolve({ ok: true, payload: "LATE ANSWER" }); await settle();
  expect(accepted).toBe(0); expect(h.ui.linkedN).toBe(0); expect(h.ctl.state().phase).toBe("cancelled");
});

test("host(): expired private pairing clears the QR and frees a fresh attempt", async () => {
  let finish: (v: PhonePad.SwapLike) => void = () => {};
  let token: { cancelled: boolean } | undefined;
  const deps: Partial<PhonePad.HostDeps> = { usingPrivateRelay: () => true,
    swap: (o) => { token = o.token; return new Promise((r) => { finish = r; }); } };
  const h = hostHarness(deps);
  await settle();
  expect(h.ctl.state().phase).toBe("waiting");
  expect(h.ui.qrs.at(-1)?.url).toBeTruthy();
  finish({ ok: false, error: "expired", message: "Room expired" });
  await settle();
  expect(h.ctl.state().phase).toBe("failed");
  expect(h.hostEnd.status).toBe("closed");
  expect(token?.cancelled).toBe(true);
  expect(h.ui.qrs.at(-1)?.url, "the expired QR is removed").toBe(null);
  expect(h.ui.failedN, "the platform restores its pairing button exactly once").toBe(1);
  expect(h.ui.said.at(-1)).toMatch(/code expired.*STEER THIS GAME WITH A PHONE/);
  h.ctl.cancel();
  const fresh = hostHarness(deps);
  await settle();
  expect(fresh.ctl.state().phase).toBe("waiting");
  expect(fresh.ui.qrs.at(-1)?.url, "a fresh attempt publishes a new live QR").toBeTruthy();
  expect(token?.cancelled).toBe(false);
  fresh.ctl.cancel(); finish({ ok: false, error: "cancelled" }); await settle();
});

test("host(): private exchange and unreadable-answer failures release their transport", async () => {
  for (const badAnswer of [false, true]) {
    const h = hostHarness({ usingPrivateRelay: () => true,
      swap: async () => badAnswer ? { ok: true, payload: "BAD ANSWER" } : { ok: false, message: "Relay offline" },
      acceptAnswer: async () => ({ ok: false, message: "Unreadable answer" }),
    });
    await settle();
    expect(h.ctl.state().phase).toBe("failed"); expect(h.hostEnd.status).toBe("closed");
    expect(h.ui.said.at(-1)).toMatch(badAnswer ? /Unreadable answer/ : /Relay offline/);
    expect(h.ui.linkedN).toBe(0); h.ctl.cancel();
  }
});

test("host recovery timing comes only from actual public subscription and clears on cancel", async () => {
  let roomOptions: { onTick?: () => void; onFail?: (r: { ok: false; error: string; message: string }) => void } = {};
  const h = hostHarness({ hostRoom: async (o) => { roomOptions = o; return { ok: true, startedAt: 1234, deadlineAt: 7777, stop() {} }; } });
  await settle();
  expect(h.ctl.state().recovery).toEqual({ phase: "waiting", reconnecting: false, publicRelay: true, startedAt: 1234, deadlineAt: 7777 });
  roomOptions.onTick?.(); expect(h.ui.recoveries.at(-1)?.deadlineAt).toBe(7777);
  roomOptions.onFail?.({ ok: false, error: "expired", message: "expired" });
  expect(h.ctl.state().recovery.deadlineAt).toBe(null); expect(h.ctl.state().recovery.reconnecting).toBe(false);
  h.ctl.cancel(); expect(h.ctl.state().recovery.deadlineAt).toBe(null); expect(h.ui.recoveries.at(-1)?.phase).toBe("cancelled");
  const legacy = hostHarness(); await settle();
  expect(legacy.ctl.state().recovery.deadlineAt, "missing transport timing never invents a countdown").toBe(null); legacy.ctl.cancel();
  const privateHost = hostHarness({ usingPrivateRelay: () => true, swap: async () => ({ ok: false, error: "expired" }) });
  await settle(); expect(privateHost.ctl.state().recovery.publicRelay).toBe(false); expect(privateHost.ctl.state().recovery.deadlineAt).toBe(null);
  privateHost.ctl.cancel();
});

test("host(): an expired pairing room takes the QR down, says so for a phone, and frees the button (#2198)", async () => {
  const h = hostHarness();
  await settle();
  expect(h.ctl.state().phase).toBe("waiting");
  h.room.onFail?.({ ok: false, error: "expired", message: "Nobody answered that code. Check the six characters…" });
  expect(h.ctl.state().phase).toBe("failed");
  expect(h.ui.qrs.at(-1), "the dead QR is taken down").toEqual({ url: null, code: null });
  expect(h.ui.said.at(-1)).toMatch(/^!The code expired — press STEER THIS GAME WITH A PHONE for a new one/);
  expect(h.ui.failedN, "the page resets its button").toBe(1);
  expect(h.ui.lostN, "a first pairing that expired is not a lost phone").toBe(0);
  expect(h.hostEnd.status, "the pending pairing transport is released").toBe("closed");
  h.ctl.cancel();
});

// ─── the phone's wake lock and re-dial (phone-pad.test.mjs:1512-1731) ───────

interface FakeLock { releases: number; addEventListener(t: string, fn: () => void): void; release(): Promise<void>; signal(): void }
interface FakeWire { status: string; fail(why: string): void; close(): void }

function wakePad(over: Partial<PhonePad.PadDeps> = {}) {
  const events: Record<string, (() => void)[]> = {}, requests: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const transports: FakeWire[] = [], timeouts: { fn: () => void; ms: number; cleared: boolean; ran?: boolean }[] = [];
  const on = (t: string, fn: () => void) => { (events[t] ||= []).push(fn); };
  vi.stubGlobal("setInterval", () => 1);
  vi.stubGlobal("clearInterval", () => {});
  // Recorded, never run: a test fires one by hand (the re-dial backoff).
  vi.stubGlobal("setTimeout", (fn: () => void, ms: number) => { timeouts.push({ fn, ms, cleared: false }); return timeouts.length; });
  vi.stubGlobal("clearTimeout", (id: number) => { const t = timeouts[id - 1]; if (t) t.cleared = true; });
  vi.stubGlobal("navigator", { wakeLock: { request: () => new Promise((resolve, reject) => { requests.push({ resolve, reject }); }) } });
  const doc = { visibilityState: "visible", addEventListener: on };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { addEventListener: on });
  const dom = { connect: fakeEl(), body: fakeEl(), status: fakeEl() };
  const ctl = PhonePad.pad(asDom(dom), { deps: {
    privateRelay: () => false, normalise: (c) => String(c), valid: () => true, prefetchIce: async () => {},
    rtc: () => {
      let close: (() => void) | null = null;
      const t = { status: "open", send: () => true, pump() { return 0; }, onMessage() {}, onClose(f: () => void) { close = f; },
        close() { t.status = "closed"; close?.(); }, fail() { t.close(); } };
      transports.push(t); return wire(t);
    }, swap: async () => ({ ok: true }), ...over,
  } });
  const lock = (): FakeLock => {
    let onRelease: (() => void) | null = null;
    return { releases: 0, addEventListener(_t, fn) { onRelease = fn; },
      release() { this.releases++; return Promise.resolve(); }, signal() { onRelease?.(); } };
  };
  return { ctl, dom, requests, transports, timeouts, lock, doc, fire: (t: string) => { for (const fn of events[t] || []) fn(); } };
}
/** A wire whose close names its reason (phone-pad.test.mjs:1595-1601). */
function failingRtc(wires: FakeWire[]) {
  return () => {
    let onClose: ((why: string) => void) | null = null;
    const t: FakeWire & Record<string, unknown> = { status: "open", send: () => true, pump() { return 0; }, onMessage() {}, onOpen() {},
      onClose(f: (why: string) => void) { onClose = f; },
      close() { t.fail("local"); }, fail(why: string) { if (t.status === "closed") return; t.status = "closed"; onClose?.(why); } };
    wires.push(t); return wire(t);
  };
}

test("phone wake lock is released on pairing failure, including acquisition arriving after failure", async () => {
  for (const late of [false, true]) {
    let finish: (v: PhonePad.SwapLike) => void = () => {};
    const h = wakePad({ swap: () => new Promise((r) => { finish = r; }) });
    const connecting = h.ctl.connect("ABC234"); await settle();
    const lock = h.lock();
    if (!late) { h.requests[0]?.resolve(lock); await settle(); }
    finish({ ok: false, error: "expired" });
    expect(((await connecting) as { error?: string }).error).toBe("expired");
    if (late) { h.requests[0]?.resolve(lock); await settle(); }
    expect(lock.releases).toBe(1);
    expect(h.dom.connect.disabled).toBe(false);
    vi.unstubAllGlobals();
  }
});

test("phone disconnect releases its lock; stale release events cannot clear a reconnect's lock", async () => {
  const h = wakePad();
  await h.ctl.connect("ABC234");
  const first = h.lock(); h.requests[0]?.resolve(first); await settle();
  h.transports[0]?.close(); expect(first.releases).toBe(1);
  await h.ctl.connect("ABC234");
  const second = h.lock(); h.requests[1]?.resolve(second); await settle();
  first.signal(); h.fire("visibilitychange"); await settle();
  expect(h.requests.length, "old sentinel event cannot cause a duplicate current acquisition").toBe(2);
  h.ctl.cancel(); expect(second.releases).toBe(1);
  expect(h.ctl.state().linked).toBe(false);
});

test("page exit cancels pending pairing; its late lock and answer cannot affect a fresh connection", async () => {
  let finish: (v: PhonePad.SwapLike) => void = () => {};
  let swaps = 0;
  const h = wakePad({ swap: () => ++swaps === 1 ? new Promise((r) => { finish = r; }) : Promise.resolve({ ok: true }) });
  const first = h.ctl.connect("ABC234"); await settle();
  h.fire("pagehide");
  expect(h.transports[0]?.status).toBe("closed");
  await h.ctl.connect("ABC234");
  const current = h.lock(); h.requests[1]?.resolve(current); await settle();
  const stale = h.lock(); h.requests[0]?.resolve(stale); finish({ ok: true });
  expect(((await first) as { error?: string }).error).toBe("cancelled"); await settle();
  expect(stale.releases).toBe(1); expect(current.releases).toBe(0);
  expect(h.ctl.state().linked).toBe(true);
  h.ctl.cancel(); expect(current.releases).toBe(1);
});

test("the phone names which end died and re-dials the same code after its own wire drops (R3-PHONE-3)", async () => {
  const wires: FakeWire[] = [], swaps: string[] = [];
  const h = wakePad({ rtc: failingRtc(wires), swap: async (o) => { swaps.push(o.code); return { ok: true }; } });
  await h.ctl.connect("ABC234");
  expect(h.ctl.state().linked).toBe(true);
  wires[0]?.fail("failed"); await settle();
  expect(swaps, "the same code, no rescan").toEqual(["ABC234", "ABC234"]);
  expect(h.ctl.state().linked, "back on the game").toBe(true);
  h.doc.visibilityState = "hidden";
  wires[1]?.fail("disconnected"); await settle();
  expect(h.dom.status.textContent).toMatch(/^Link lost — this phone slept, took a call or lost signal\. Reconnecting…$/);
  expect(swaps.length, "no dial while hidden").toBe(2); expect(h.ctl.state().linked).toBe(false);
  h.doc.visibilityState = "visible"; h.fire("visibilitychange"); await settle();
  expect(swaps.length).toBe(3); expect(h.ctl.state().linked).toBe(true);
  wires[2]?.fail("peer"); await settle();
  expect(h.dom.status.textContent).toMatch(/the game closed the link/);
  h.fire("visibilitychange"); await settle();
  expect(swaps.length).toBe(3); expect(h.ctl.state().linked).toBe(false);
  h.ctl.cancel();
});

test("a refused wake lock does not block pairing or reacquisition on visibility return", async () => {
  const h = wakePad();
  await h.ctl.connect("ABC234"); h.requests[0]?.reject(new Error("denied")); await settle();
  expect(h.ctl.state().linked).toBe(true);
  h.fire("visibilitychange"); await settle();
  const lock = h.lock(); h.requests[1]?.resolve(lock); await settle();
  h.ctl.cancel(); expect(lock.releases).toBe(1);
});

test("a transport closing during controller session setup cannot strand its wake lock or reconnect", async () => {
  const h = wakePad({ rtc: () => wire({ status: "closed", onMessage() {}, onClose(f: () => void) { f(); }, onOpen() {}, close() {} }) });
  expect(((await h.ctl.connect("ABC234")) as { error?: string }).error).toBe("cancelled");
  const lock = h.lock(); h.requests[0]?.resolve(lock); await settle();
  expect(lock.releases).toBe(1); expect(h.ctl.state().linked).toBe(false);
  expect(h.dom.connect.disabled).toBe(false);
  expect(((await h.ctl.connect("ABC234")) as { error?: string }).error, "a second attempt is not stuck busy").toBe("cancelled");
});

test("phone: a failed re-dial is retried on a backoff, and links with no CONNECT tap (#2198)", async () => {
  const wires: FakeWire[] = [], swaps: string[] = [];
  let answer: PhonePad.SwapLike[] = [{ ok: true }, { ok: false, error: "expired" }, { ok: true }];
  const h = wakePad({ rtc: failingRtc(wires), swap: async (o) => { swaps.push(o.code); return answer.shift() || { ok: false, error: "expired" }; } });
  await h.ctl.connect("ABC234");
  expect(h.ctl.state().linked).toBe(true);
  wires[0]?.fail("failed"); await settle();
  expect(swaps.length, "the wire drop re-dials at once").toBe(2);
  expect(h.ctl.state().linked, "…and that re-dial found the code not hosted yet").toBe(false);
  const armed = h.timeouts.filter((t) => !t.cleared && t.ms >= 1000);
  expect(armed.length, "the failed re-dial is re-armed on a backoff").toBe(1);
  expect(h.dom.status.textContent).toMatch(/reconnecting/i);
  const first = armed[0] as (typeof armed)[number];
  first.ran = true; first.fn(); await settle();
  expect(swaps.length).toBe(3); expect(h.ctl.state().linked, "linked again with no CONNECT tap").toBe(true);
  answer = [];
  wires.at(-1)?.fail("failed"); await settle();
  for (let i = 0; i < 3; i++) {
    const next = h.timeouts.filter((t) => !t.cleared && t.ms >= 1000 && !t.ran);
    expect(next.length, "retry " + (i + 1) + " is armed").toBe(1);
    const n = next[0] as (typeof next)[number];
    n.ran = true; n.fn(); await settle();
  }
  expect(h.timeouts.filter((t) => !t.cleared && t.ms >= 1000 && !t.ran).length, "capped at three retries").toBe(0);
  expect(h.dom.status.textContent).toMatch(/CONNECT|new one|new code/i);
  const total = h.timeouts.filter((t) => t.ms >= 1000).reduce((n, t) => n + t.ms, 0);
  expect(total, "the retries fit inside the game's 120 s re-host window").toBeLessThanOrEqual(90000);
  h.ctl.cancel();
});

// ─── keyboard holds and touch steering ──────────────────────────────────────

test("phone hold controls accept Space and Enter without cancelling another held contact", () => {
  const dom = { gas: fakeEl(), brake: fakeEl(), lookBack: fakeEl(), body: fakeEl() };
  const ctl = PhonePad.pad(asDom(dom));
  try {
    for (const [control, stateKey] of [[dom.gas, "thr"], [dom.brake, "brk"], [dom.lookBack, "held"]] as const) {
      control.dispatch("keydown", { key: " " });
      expect(ctl.state()[stateKey]).toBe(1);
      control.dispatch("keydown", { key: "Enter" });
      control.dispatch("keyup", { key: " " });
      expect(ctl.state()[stateKey], "the other key is still down").toBe(1);
      control.dispatch("pointerdown", { pointerId: 11, clientY: 200 });
      control.dispatch("keyup", { key: "Enter" });
      expect(ctl.state()[stateKey], "the finger is still down").toBe(1);
      control.dispatch("pointerup", { pointerId: 11 });
      expect(ctl.state()[stateKey]).toBe(0);
      control.dispatch("keydown", { key: " " });
      control.dispatch("blur");
      expect(ctl.state()[stateKey], "focus loss releases the keyboard hold").toBe(0);
      control.dispatch("keyup", { key: " " });
      expect(ctl.state()[stateKey]).toBe(0);
    }
    dom.body.classes.add("throttle-auto");
    dom.gas.dispatch("keydown", { key: " " });
    expect(ctl.state().thr, "automatic throttle retains its pointer-disabled behavior for keyboard").toBe(0);
  } finally { ctl.cancel(); }
});

function openTransport() {
  const box: { receive: (c: Channel, d: string) => void; closed: ((why: CloseReason) => void) | null } = { receive: () => {}, closed: null };
  const t = { status: "open", onMessage(f: (c: Channel, d: string) => void) { box.receive = f; }, onOpen() {},
    onClose(f: (why: CloseReason) => void) { box.closed = f; }, send() { return true; }, pump() { return 0; },
    close() { t.status = "closed"; box.closed?.("local"); } };
  return { box, transport: wire(t) };
}

test("phone touch steering restores the remaining held arrow and ignores old-key repeats", async () => {
  const { box, transport } = openTransport();
  const dom = { steer: fakeEl() };
  const ctl = PhonePad.pad(asDom(dom), { deps: {
    rtc: () => transport, prefetchIce: async () => null, normalise: (c) => String(c), valid: () => true,
    privateRelay: () => false, swap: async () => ({ ok: true }),
  } });
  try {
    await ctl.connect("ABC234");
    box.receive("event", PhonePad.encodeHello("host", false, true));
    expect(ctl.setSteeringMode("touch")).toBe(true);
    const key = (type: string, name: string, repeat = false) => dom.steer.dispatch(type, { key: name, repeat });
    for (const [first, last, sign] of [["ArrowLeft", "ArrowRight", -1], ["ArrowRight", "ArrowLeft", 1]] as const) {
      key("keydown", first); key("keydown", last);
      expect(ctl.state().steer).toBe(-sign);
      key("keydown", first, true);
      expect(ctl.state().steer, "a repeat is not a new physical press").toBe(-sign);
      key("keyup", last);
      expect(ctl.state().steer, "the earlier key remains held").toBe(sign);
      key("keyup", first);
      expect(ctl.state().steer).toBe(0);
    }
    key("keydown", "ArrowLeft"); key("keydown", "ArrowRight");
    dom.steer.dispatch("blur");
    expect(ctl.state().steer).toBe(0);
    key("keyup", "ArrowRight");
    expect(ctl.state().steer, "an old lift after blur cannot restore a cleared key").toBe(0);
  } finally { ctl.cancel(); }
});

test("last-touch fallback releases fingers while preserving keyboard pedals and steering", async () => {
  const page = stubPage();
  const { box, transport } = openTransport();
  const dom = { gas: fakeEl(), brake: fakeEl(), lookBack: fakeEl(), steer: fakeEl() };
  const ctl = PhonePad.pad(asDom(dom), { deps: { rtc: () => transport, prefetchIce: async () => null, normalise: (c) => String(c), valid: () => true, privateRelay: () => false, swap: async () => ({ ok: true }) } });
  try {
    await ctl.connect("ABC234");
    box.receive("event", PhonePad.encodeHello("host", false, true));
    ctl.setSteeringMode("touch");
    dom.gas.dispatch("keydown", { key: " " });
    dom.brake.dispatch("keydown", { key: "Enter" });
    dom.steer.dispatch("keydown", { key: "ArrowLeft" });
    for (const type of ["touchend", "touchcancel"]) {
      dom.lookBack.dispatch("pointerdown", { pointerId: 12 });
      expect(ctl.state().held).toBe(1);
      page.doc(type, { touches: [] });
      expect(ctl.state().held, "lost pointer lift is still recovered").toBe(0);
      expect(ctl.state().thr, type + " preserves held GAS key").toBe(1);
      expect(ctl.state().brk, type + " preserves held BRAKE key").toBe(1);
      expect(ctl.state().steer, type + " preserves held steering key").toBe(-1);
    }
    page.document.hidden = true;
    page.doc("visibilitychange", {});
    for (const field of ["thr", "brk", "held", "steer"] as const) expect(ctl.state()[field], "backgrounding clears " + field).toBe(0);
  } finally { ctl.cancel(); }
});

// ─── phone-input-improvements.test.mjs (all of it) ──────────────────────────

/** An EventTarget-backed element (phone-input-improvements.test.mjs:8-16). */
function element() {
  const e = Object.assign(new EventTarget(), {
    textContent: "", value: "", style: { setProperty() {} }, hidden: false, isConnected: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, children: [], srcObject: null as unknown,
    setAttribute(k: string, v: string) { (e as unknown as Record<string, unknown>)[k] = v; }, getAttribute: () => null, removeAttribute: () => {},
    getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {},
  });
  return e;
}
type Elem = ReturnType<typeof element>;
function emit(el: EventTarget, type: string, fields: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(fields)) Object.defineProperty(e, k, { value: v });
  el.dispatchEvent(e);
  return e;
}
/** phone-input-improvements.test.mjs:20-31: the page globals, with recorded intervals. */
function boot() {
  const clock = { t: 100 }, intervals = new Map<number, () => void>();
  let timer = 0;
  const document = Object.assign(element(), { visibilityState: "visible" });
  const window = element();
  const navigator: Record<string, unknown> = {};
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("navigator", navigator);
  vi.stubGlobal("setTimeout", () => ++timer);
  vi.stubGlobal("clearTimeout", () => {});
  vi.stubGlobal("setInterval", (f: () => void) => { intervals.set(++timer, f); return timer; });
  vi.stubGlobal("clearInterval", (id: number) => { intervals.delete(id); });
  return { clock, document, window, navigator, beat: () => { for (const fn of intervals.values()) fn(); } };
}
function memWire() {
  const cb: { message?: (c: Channel, d: string) => void; close?: (why: CloseReason) => void } = {};
  const sent: { c: string; data: string }[] = [];
  const w = { status: "open", blocked: false, sent,
    onMessage(f: (c: Channel, d: string) => void) { cb.message = f; }, onOpen() {}, onClose(f: (why: CloseReason) => void) { cb.close = f; },
    send(c: string, data: string) { if (w.blocked) return false; sent.push({ c, data }); return true; }, pump() { return 0; },
    close() { w.status = "closed"; cb.close?.("local"); },
    receive(c: Channel, data: string) { cb.message?.(c, data); } };
  return w;
}
const flatSrc = { roll: () => 0, thr: () => 0, brk: () => 0, held: () => 0 };
async function page(h: ReturnType<typeof boot>) {
  const w = memWire();
  const dom = { gas: element(), brake: element(), lookBack: element(), steer: element(), steeringMode: element(), health: element(), healthAge: element(),
    buttons: { pause: element(), navSelect: element(), shiftUp: element() } };
  const ctl = PhonePad.pad(asDom(dom), { now: () => h.clock.t, deps: { rtc: () => wire(w), prefetchIce: async () => null, normalise: (c) => String(c), valid: () => true, privateRelay: () => false,
    acceptInvite: async () => ({ ok: true, code: "ANSWER" }), swap: async (o) => { await o.reply?.("OFFER"); return { ok: true }; } } });
  await ctl.connect("ABC234");
  const actions = () => w.sent.filter((m) => m.c === "event").map((m) => PhonePad.decodeEvent(m.data)).filter((e) => e?.t === "ev").map((e) => (e as { k: string }).k);
  return { w, dom, ctl, actions };
}
const lastState = (w: ReturnType<typeof memWire>): string => w.sent.filter((m) => m.c === "state").at(-1)?.data ?? "";

test("actual RTC backpressure preserves phone edge FIFO and retries hello without double delivery", () => {
  const h = boot();
  class FakePC { connectionState = "new"; ondatachannel: ((e: { channel: unknown }) => void) | null = null; close() {} }
  const w = NetTransport.rtc({ role: "guest", PC: FakePC as unknown as NetTransport.PeerConnectionCtor });
  if (!w) throw new Error("rtc() refused the fake PC");
  type Chan = { label: string; readyState: string; bufferedAmount: number; sent: string[]; send(d: string): void; close(): void;
    onopen?: () => void; onbufferedamountlow?: () => void };
  const channels: Record<string, Chan> = {};
  for (const label of ["state", "event"]) {
    const ch: Chan = channels[label] = { label, readyState: "open", bufferedAmount: 0, sent: [], send(data) { this.sent.push(data); }, close() {} };
    (w.pc as unknown as FakePC).ondatachannel?.({ channel: ch }); ch.onopen?.();
  }
  const ev = channels.event as Chan;
  ev.bufferedAmount = 999999;
  const s = PhonePad.padSession(w, flatSrc, { now: () => h.clock.t, heartbeat: false });
  s.event("pause"); s.event("shiftUp");
  expect(s.stats().queued).toBe(2); expect(ev.sent.length).toBe(0);
  ev.bufferedAmount = 0; ev.onbufferedamountlow?.(); s.pump(); s.pump();
  const got = ev.sent.map((x) => PhonePad.decodeEvent(x));
  expect(got.map((x) => x?.t === "ev" ? x.k : x?.t)).toEqual(["hi", "pause", "shiftUp"]);
  expect(s.stats().queued).toBe(0); s.close();
});

test("queue expires old actions and coalesces nav repeats; long stall never floods", () => {
  const h = boot(), w = memWire(); w.blocked = true;
  const s = PhonePad.padSession(wire(w), flatSrc, { now: () => h.clock.t, heartbeat: false });
  for (let i = 0; i < 100; i++) s.event("navDown");
  s.event("pause"); expect(s.stats().queued).toBe(2);
  h.clock.t += 300; w.blocked = false; s.pump();
  expect(w.sent.map((m) => PhonePad.decodeEvent(m.data)).filter((e) => e?.t === "ev").map((e) => (e as { k: string }).k)).toEqual(["pause"]);
  w.blocked = true; for (let i = 0; i < 40; i++) s.event("shiftUp");
  expect(s.stats().queued).toBe(24); expect(s.stats().rejected).toBe(16);
  h.clock.t += 1300; w.blocked = false; s.pump(); expect(s.stats().queued).toBe(0); expect(s.stats().expired).toBe(25); s.close();
});

test("retargeted lift releases only its pointer while another finger remains; capture alone does not release", async () => {
  const h = boot(), { ctl, dom } = await page(h);
  emit(dom.gas, "pointerdown", { pointerId: 1, clientY: 100 }); emit(dom.lookBack, "pointerdown", { pointerId: 2 });
  emit(dom.gas, "lostpointercapture", { pointerId: 1 }); expect(ctl.state().thr).toBe(1);
  emit(h.document, "pointerup", { pointerId: 1 }); emit(h.document, "touchend", { touches: [{}] });
  expect(ctl.state().thr).toBe(0); expect(ctl.state().held).toBe(1);
  emit(h.document, "pointercancel", { pointerId: 2 }); expect(ctl.state().held).toBe(0);
  emit(dom.gas, "pointerdown", { pointerId: 3, clientY: 100 }); emit(dom.gas, "pointerdown", { pointerId: 4, clientY: 100 });
  emit(h.document, "pointerup", { pointerId: 3 }); expect(ctl.state().thr).toBe(1);
  emit(h.document, "pointerup", { pointerId: 4 }); expect(ctl.state().thr).toBe(0); ctl.cancel();
});

test("semantic activation fires once; pointer-generated click does not double-fire", async () => {
  const h = boot(), p = await page(h);
  emit(p.dom.buttons.pause, "click", { detail: 0 }); emit(p.dom.buttons.navSelect, "click", { detail: 0 });
  emit(p.dom.buttons.shiftUp, "pointerdown", { pointerId: 1 }); emit(p.dom.buttons.shiftUp, "pointerup", { pointerId: 1 }); emit(p.dom.buttons.shiftUp, "click", { detail: 1 });
  expect(p.actions()).toEqual(["pause", "navSelect", "shiftUp"]); p.ctl.cancel();
});

test("old peer keeps v1 samples; touch requires explicit advertised capability, then centers on release", async () => {
  const h = boot(), { ctl, dom, w } = await page(h);
  w.receive("event", PhonePad.encodeHello("host"));
  expect(ctl.setSteeringMode("touch")).toBe(false);
  emit(dom.gas, "pointerdown", { pointerId: 1, clientY: 100 });
  expect((JSON.parse(lastState(w)) as unknown[])[0]).toBe(1);
  w.receive("event", PhonePad.encodeHello("host", false, true)); expect(ctl.setSteeringMode("touch")).toBe(true);
  emit(dom.steer, "pointerdown", { pointerId: 2, clientX: 50 }); emit(dom.steer, "pointermove", { pointerId: 2, clientX: 110 });
  let sample = PhonePad.decodeSample(lastState(w)); expect(sample?.steer).toBe(0.75); expect(sample?.roll).toBe(null);
  emit(h.document, "pointerup", { pointerId: 2 }); sample = PhonePad.decodeSample(lastState(w)); expect(sample?.steer).toBe(0);
  emit(dom.steer, "keydown", { key: "ArrowLeft" }); expect(ctl.state().steer).toBe(-1);
  emit(dom.steer, "keyup", { key: "ArrowLeft" }); expect(ctl.state().steer).toBe(0);
  ctl.cancel(); expect(ctl.state().steer).toBe(0); expect(ctl.state().thr).toBe(0);
});

test("input health requires an ACK for an actual sent sequence; HUD traffic cannot fake freshness", () => {
  const h = boot(), w = memWire();
  const s = PhonePad.padSession(wire(w), flatSrc, { now: () => h.clock.t, heartbeat: false });
  s.sample(true); w.receive("state", PhonePad.encodeHud({ gear: 4 }) as string); expect(s.health().state).toBe("unavailable");
  w.receive("event", PhonePad.encodeHello("host", false, true)); expect(s.health().state).toBe("waiting");
  w.receive("state", '["A",999]'); expect(s.health().state).toBe("waiting");
  w.receive("state", '["A",0]'); expect(s.health().state).toBe("good");
  h.clock.t += 450; w.receive("state", PhonePad.encodeHud({ gear: 5 }) as string); expect(s.health().state).toBe("degraded");
  h.clock.t += 1200; expect(s.health().state).toBe("reconnecting");
  s.sample(true); w.receive("state", '["A",1]'); expect(s.health().state).toBe("good"); s.close();
});

test("desktop ACKs only accepted fresh samples and tags phone ownership", () => {
  const h = boot(), w = memWire(), samples: RemoteSample[] = [], lost: string[] = [];
  const input: PhonePadInput = { remoteSample(s) { samples.push(s); return s.thr !== 1; }, remoteLost(s) { lost.push(s); }, remoteEvent() {}, setRemoteHaptics() {} };
  const link = PhonePad.link(wire(w), { input, doc: null, now: () => h.clock.t, pump: false });
  w.receive("event", PhonePad.encodeHello("pad", false, true)); w.sent.length = 0;
  w.receive("state", PhonePad.encodeSample({ seq: 0, thr: 1 })); expect(w.sent.length).toBe(0);
  w.receive("state", PhonePad.encodeSample({ seq: 1, thr: 0 })); expect(JSON.parse(w.sent[0]?.data ?? "null")).toEqual(["A", 1]);
  w.receive("state", PhonePad.encodeSample({ seq: 0 })); expect(w.sent.length).toBe(1); expect(samples[1]?.source).toBe("phone");
  link.close(); expect(lost).toEqual(["phone"]);
});

test("new phone and actual desktop link negotiate touch/ACK over the real loopback transport", () => {
  const h = boot(), [padEnd, hostEnd] = NetTransport.loopback({ latencyMs: 1 }); padEnd.pump(h.clock.t); hostEnd.pump(h.clock.t);
  const accepted: RemoteSample[] = [];
  const link = PhonePad.link(hostEnd, { pump: false, doc: null, now: () => h.clock.t,
    input: { setRemoteHaptics() {}, remoteLost() {}, remoteEvent() {}, remoteSample(s) { accepted.push(s); return true; } } });
  const s = PhonePad.padSession(padEnd, { ...flatSrc, steer: () => -0.5 }, { now: () => h.clock.t, heartbeat: false });
  for (let i = 0; i < 3; i++) { h.clock.t += 2; link.pump(); s.pump(); }
  expect(s.health().touchSupported).toBe(true); s.sample(true);
  for (let i = 0; i < 3; i++) { h.clock.t += 2; link.pump(); s.pump(); }
  expect(accepted[0]?.steer).toBe(-0.5); expect(accepted[0]?.source).toBe("phone"); expect(s.health().state).toBe("good"); s.close(); link.close();
});

test("window release, backgrounding and disconnect center touch steering without clearing another pointer early", async () => {
  const h = boot(), { ctl, dom, w } = await page(h);
  w.receive("event", PhonePad.encodeHello("host", false, true)); ctl.setSteeringMode("touch");
  emit(dom.steer, "pointerdown", { pointerId: 1, clientX: 50 }); emit(dom.steer, "pointermove", { pointerId: 1, clientX: 130 });
  emit(h.window, "pointerup", { pointerId: 2 }); expect(ctl.state().steer).toBe(1);
  emit(h.window, "pointerup", { pointerId: 1 }); expect(ctl.state().steer).toBe(0);
  emit(dom.steer, "keydown", { key: "ArrowRight" }); emit(dom.gas, "pointerdown", { pointerId: 3, clientY: 100 });
  Object.assign(h.document, { hidden: true }); emit(h.document, "visibilitychange"); expect(ctl.state().steer).toBe(0); expect(ctl.state().thr).toBe(0);
  emit(dom.steer, "keydown", { key: "ArrowRight" }); ctl.cancel(); expect(ctl.state().steer).toBe(0); expect(dom.steer.hidden).toBe(true);
});

/** The real scanner (src/net/scan.ts) with its platform seams handed in. */
function realScan(env: NetScan.ScanEnv) {
  return () => ({ supported: () => NetScan.supported(env), create: () => NetScan.create(env) });
}

test("actual scanner stops on manual connect/cancel and invalidates pending sensor/media work", async () => {
  for (const mode of ["manual", "qr", "cancel", "pending-media", "pending-sensor", "hidden-sensor", "hidden-media"]) {
    const h = boot();
    let stops = 0, codes: { rawValue: string }[] = [];
    let grant: ((v: string) => void) | null = null, media: ((s: NetScan.ScanStream) => void) | null = null;
    const stream: NetScan.ScanStream = { getTracks: () => [{ stop() { stops++; } }] };
    const getUserMedia = (): Promise<NetScan.ScanStream> => mode.includes("media") ? new Promise((r) => { media = r; }) : Promise.resolve(stream);
    class Detector { static async getSupportedFormats() { return ["qr_code"]; } async detect() { return codes; } }
    if (mode.includes("sensor")) vi.stubGlobal("DeviceOrientationEvent", { requestPermission: () => new Promise((r) => { grant = r; }) });
    const dom = { body: element(), status: element(), scan: element(), scanBox: element(), video: element(), buttons: {} };
    Object.assign(dom.video, { play: async () => {}, readyState: 4, videoWidth: 640, videoHeight: 480, muted: false });
    const ctl = PhonePad.pad(asDom(dom), { deps: { scan: realScan({ getUserMedia, BarcodeDetector: Detector }), rtc: () => wire(memWire()), prefetchIce: async () => null,
      normalise: (s) => String(s).toUpperCase(), valid: (s) => s.length === 6, swap: async () => ({ ok: true }) } });
    const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
    const pending = ctl.scan(); await flush();
    if (mode.includes("sensor") || mode.includes("media")) {
      if (mode.startsWith("hidden")) { Object.assign(h.document, { hidden: true }); h.document.dispatchEvent(new Event("visibilitychange")); }
      else ctl.cancel();
      (grant as ((v: string) => void) | null)?.("granted");
      (media as ((s: NetScan.ScanStream) => void) | null)?.(stream);
      const result = await pending; expect(result.ok, mode).toBe(false);
      expect(dom.video.srcObject || null, mode).toBe(null);
      expect(stops, mode).toBe(mode.includes("media") ? 1 : 0);
    } else {
      expect((await pending).ok).toBe(true);
      if (mode === "manual") await ctl.connect("ABC234");
      else if (mode === "qr") { codes = [{ rawValue: "ABC234" }]; h.beat(); await flush(); }
      else ctl.cancel();
      expect(stops, mode).toBe(1); expect(dom.video.srcObject, mode).toBe(null);
      expect(dom.scanBox.hidden, mode).toBe(true);
      if (mode !== "cancel") expect(ctl.state().linked, mode).toBe(true);
    }
    ctl.cancel();
    vi.unstubAllGlobals();
  }
});

test("an old cancelled camera start cannot hide or stop the newer scan panel", async () => {
  boot();
  const requests: ((s: NetScan.ScanStream) => void)[] = [];
  let oldStops = 0, newStops = 0;
  const getUserMedia = (): Promise<NetScan.ScanStream> => new Promise((r) => { requests.push(r); });
  class Detector { static async getSupportedFormats() { return ["qr_code"]; } async detect() { return []; } }
  const dom: { status: Elem; scan: Elem; scanBox: Elem; video: Elem; buttons: object } = { status: element(), scan: element(), scanBox: element(), video: element(), buttons: {} };
  Object.assign(dom.video, { play: async () => {}, muted: false });
  const ctl = PhonePad.pad(asDom(dom), { deps: { scan: realScan({ getUserMedia, BarcodeDetector: Detector }) } });
  const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  const old = ctl.scan(); await flush(); expect(requests.length).toBe(1);
  expect(((await ctl.scan()) as { error?: string }).error).toBe("cancelled");
  const fresh = ctl.scan(); await flush(); expect(requests.length).toBe(2);
  const newStream: NetScan.ScanStream = { getTracks: () => [{ stop() { newStops++; } }] };
  requests[1]?.(newStream); expect((await fresh).ok).toBe(true);
  requests[0]?.({ getTracks: () => [{ stop() { oldStops++; } }] }); expect((await old).ok).toBe(false);
  expect(dom.video.srcObject).toBe(newStream); expect(dom.scanBox.hidden).toBe(false);
  expect(dom.scan.textContent).toBe("CANCEL SCAN"); expect(oldStops).toBe(1); expect(newStops).toBe(0);
  ctl.cancel(); expect(newStops).toBe(1);
});
