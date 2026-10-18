/* Apex 26 — CamFeel: in-race camera feel that must not grow game.js.
   FREE-LOOK (mouse / right-stick yaw+pitch on bolted-on cams, smooth recenter),
   mode-aware LOOK BACK (skip reverse/rear; optional latch), one shared SPEED FOV
   curve scaled per mode, documented shake/buzz scope, and an optional SPEED
   VIGNETTE (CSS tunnel, off by default). CockpitOpts pattern: SETTINGS rows are
   injected, never static shell DOM.

   Ported verbatim from f1-game js/camera/feel.js:1-427 (CamFeel). The IIFE
   singleton becomes `createCamFeel(deps)`; its ambient globals are injected:
     GameStore.store   → deps.store                      feel.js:13, :44-60
     Input.*           → deps.input  TODO(lane-shell): src/input look axes   feel.js:303-313
     DriveChase.apply  → deps.chaseLens TODO(lane-shell): the chase family's lens
                         (js/camera/drive-chase.js, inlined today in src/camera/chase.ts
                         ChaseCam.lens). Without it the chase/far/drift/low/reverse
                         lens delta is 0, as when f1-game loads without drive-chase.js.
     document          → deps.doc (the speed vignette)    feel.js:356-374
     SettingRow        → src/camera/setting-row.ts (initUI → mountCamFeelSettings)
   THE ARC RULE: nothing here reads the track. Free-look and look-back move the
   camera's aim only; they never reach the player's controls. */
import type { Vec3 } from "../contracts/track";
import { clamp } from "../physics/math";
import { DriveBroadcast } from "./drive-broadcast";
import type { LensApply, LensCtx } from "./drive-lens";
import { DriveOnboard } from "./drive-onboard";
import { buildSettingRow, labels, wireSettingRow } from "./setting-row";
import type { CamStore } from "./store";

const DEG = Math.PI / 180;

// ── Scope tables (shake / buzz / free-look) ───────────────────────────────
// TRAUMA SHAKE (js/game.js `shake`): every live race camera. camComfort()
// zeroes the OFFSET only; the trauma still decays so cues stay timed.
//
// SPEED BUZZ: high-frequency vibration on cams bolted to the chassis. Same
// set as free-look + kerb rib shiver (vantage onboardAttitude includes tcam).
// Off under camComfort() and on a wet road (SSR flicker).
//
// KERB RIB SHIVER: spatial, driven off arc `s` in vantage.js onboardAttitude
// for the same bolted set (cockpit/hood/visor/tcam/helmet).
export const BUZZ_MODES: readonly string[] = Object.freeze(["cockpit", "hood", "visor", "tcam", "helmet"]);
export const FREELOOK_MODES = BUZZ_MODES;
// LOOK BACK already faces aft in these — flipping again is a double reverse.
export const LOOKBACK_SKIP: readonly string[] = Object.freeze(["reverse", "rear"]);

export const K_LATCH = "lookBackLatch";       // json lane via store.get/set
export const K_VIGNETTE = "speedVignette";    // "0"/"1" raw-style via json on/off

const YAW_MAX = 75, PITCH_MAX = 35;
const STICK_RATE = 90;                 // deg/s at full deflection
const MOUSE_SENS = 0.08;               // deg per pixel
const RECENTER = 6;                    // λ toward 0 when input released

export interface FovRecipe { readonly base: number; readonly widen: number; readonly scale: number; readonly dep: number }

// Per-mode FOV recipe used by vantage.js — one table, one function.
// scale defaults to 1; mild scales restore a curve where FOV was fixed.
export const FOV_BY_MODE: Readonly<Record<string, FovRecipe>> = Object.freeze({
  cockpit:    { base: 64, widen: 14, scale: 1,   dep: 3 },
  hood:       { base: 64, widen: 14, scale: 1,   dep: 3 },
  visor:      { base: 64, widen: 14, scale: 1,   dep: 3 },
  helmet:     { base: 64, widen: 14, scale: 1,   dep: 3 },   // the cockpit's lens; the visor frame is CSS
  overhead:   { base: 46, widen: 0,  scale: 1,   dep: 0 },
  heli:       { base: 36, widen: 8,  scale: 0.5, dep: 2 },
  reverse:    { base: 60, widen: 12, scale: 1,   dep: 0 },
  side:       { base: 44, widen: 6,  scale: 0.5, dep: 0 },
  cinematic:  { base: 50, widen: 10, scale: 1,   dep: 0 },
  low:        { base: 55, widen: 13, scale: 1,   dep: 0 },
  tcam:       { base: 46, widen: 8,  scale: 0.5, dep: 2 },
  rear:       { base: 58, widen: 12, scale: 1,   dep: 2 },
  drift:      { base: 55, widen: 15, scale: 1,   dep: 3 },
  chase:      { base: 57, widen: 6,  scale: 1,   dep: 3 },
  far:        { base: 61, widen: 6,  scale: 1,   dep: 3 },
});

export interface DriveRate { readonly sp: number; readonly yaw: number; readonly brake: number; readonly slip: number }

// How fast the LENS catches the car. The rig owns the pose. These rates
// must not move the eye: a second dolly on top of vantage was the double
// image. One-shot solves (no dt) and Reduce Motion return the fov untouched.
export const DRIVE_RESPONSE: Readonly<Record<string, DriveRate>> = Object.freeze({
  chase:     { sp: 4.2, yaw: 2.2, brake: 9, slip: 3.2 },
  far:       { sp: 1.3, yaw: 1.0, brake: 1.6, slip: 1.0 },
  drift:     { sp: 6.0, yaw: 6.5, brake: 7.5, slip: 12 },
  low:       { sp: 5.5, yaw: 4.0, brake: 9, slip: 4.0 },
  reverse:   { sp: 2.4, yaw: 2.0, brake: 8, slip: 2.0 },
  heli:      { sp: 1.8, yaw: 0.75, brake: 1.2, slip: 1.0 },
  side:      { sp: 6.5, yaw: 3.5, brake: 4, slip: 3 },
  cinematic: { sp: 1.05, yaw: 0.9, brake: 1.0, slip: 0.9 },
  overhead:  { sp: 2.2, yaw: 2.2, brake: 1.4, slip: 2 },
  drone:     { sp: 1.2, yaw: 0.65, brake: 1.0, slip: 0.8 },
  rival:     { sp: 3.2, yaw: 2.4, brake: 6, slip: 2.5 },
  pitwall:   { sp: 2.2, yaw: 2.2, brake: 7, slip: 2 },
  trackside: { sp: 2.0, yaw: 1.6, brake: 2, slip: 2 },
  cockpit:   { sp: 3.5, yaw: 3, brake: 8, slip: 3 },
  hood:      { sp: 4.5, yaw: 4, brake: 9, slip: 4 },
  visor:     { sp: 3.0, yaw: 3, brake: 3, slip: 3 },
  tcam:      { sp: 5.0, yaw: 4, brake: 8, slip: 4 },
  rear:      { sp: 5.5, yaw: 7, brake: 8, slip: 4 },
});

/* TRAUMA SHAKE, frame-rate independent and kept inside the tub. game.js used
   to add a fresh Math.random() offset to the eye/target TARGET every rendered
   frame and then damp it: white noise through damp(λ, dt) has an rms of
   sqrt(a/(2−a)), a = 1−e^(−λ·dt), so a crash shook the chase cam 2.2x harder
   at 30 fps than at 144 — and onboard (λ400 passes everything) it threw the
   eye ±0.45 m, through the survival cell the cockpit rig budgets in
   centimetres (eye 0.46 m from the wheel, near plane 0.3).
   Now the noise is a smooth sum of sines in REAL time (the speed-buzz idea),
   so the same signal reaches the damper at any frame rate: rms after the
   chase λ18 is 0.111/0.105/0.103 at 30/60/144 Hz (was 0.156/0.111/0.072 —
   the 60 Hz feel is kept). Channels stay in [−0.5, 0.5] like the
   Math.random() − 0.5 they replace. Onboard, the eye moves at most
   TUB_EYE_MAX and the trauma becomes AIM rotation instead. */
const SHAKE_W: readonly (readonly [number, number, number, number])[] = Object.freeze([[37.1, 0.0, 53.3, 1.9], [41.7, 2.3, 59.9, 0.7], [33.4, 4.1, 47.2, 3.3], [44.9, 5.2, 61.3, 0.4]]);
export const TUB_EYE_MAX = 0.03;              // m the onboard eye may shake, per axis
const ONBOARD_AIM_DEG = 6;             // aim jitter, degrees per metre of shake amount

export function isBuzzMode(mode: string): boolean { return BUZZ_MODES.indexOf(mode) >= 0; }
export function isFreeLookMode(mode: string): boolean { return FREELOOK_MODES.indexOf(mode) >= 0; }
export function looksAftAlready(mode: string): boolean { return LOOKBACK_SKIP.indexOf(mode) >= 0; }

/* Shared speed FOV: FOV = base + widen * spN * scale + depBoost.
   Modes that used to ignore speed (tcam / side / heli) pass scale < 1 so they
   share the curve without jumping to chase-like widen. */
export function speedFov(base: number, widen: number, spN: number, scale?: number | null, depBoost?: number): number {
  const s = scale == null ? 1 : scale;
  const n = clamp(spN, 0, 1);
  return base + widen * n * s + (depBoost || 0);
}

// `sp` is the FOV speed blend (0..1). vantage.js passes CamTune-scaled
// `spFov` so COMFORT › SPEED FOV still lands; look-ahead keeps full spN.
export function modeFov(mode: string, sp: number, deploy: unknown): number {
  const r = FOV_BY_MODE[mode] || FOV_BY_MODE["chase"]!;
  return speedFov(r.base, r.widen, sp, r.scale, (deploy ? 1 : 0) * r.dep);
}

export function applyAim(eye: Vec3, tgt: Vec3, yawDeg: number, pitchDeg: number): void {
  if (!yawDeg && !pitchDeg) return;
  let dx = tgt[0] - eye[0], dy = tgt[1] - eye[1], dz = tgt[2] - eye[2];
  if (yawDeg) {
    const c = Math.cos(yawDeg * DEG), s = Math.sin(yawDeg * DEG);
    const nx = dx * c - dz * s, nz = dz * c + dx * s;
    dx = nx; dz = nz;
  }
  if (pitchDeg) {
    const L = Math.hypot(dx, dz), len = Math.hypot(L, dy) || 1;
    const el = clamp(Math.atan2(dy, L) + pitchDeg * DEG, -1.45, 1.45);
    const nl = Math.cos(el) * len;
    dy = Math.sin(el) * len;
    if (L > 1e-6) { const k = nl / L; dx *= k; dz *= k; }
    else { dx = 0; dz = nl; }
  }
  tgt[0] = eye[0] + dx; tgt[1] = eye[1] + dy; tgt[2] = eye[2] + dz;
}

export function dampToward(cur: number, target: number, lambda: number, dt: number): number {
  if (dt <= 0) return cur;
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

export function shakeNoise(ch: number, tSec: number): number {
  const w = SHAKE_W[ch];
  if (!w) return NaN;   // f1-game reads w[0] of undefined and throws; no caller passes ch > 3
  return 0.5 * (0.6 * Math.sin(tSec * w[0] + w[1]) + 0.4 * Math.sin(tSec * w[2] + w[3]));
}
export function shake(eye: Vec3, tgt: Vec3, amt: number, tSec: number, onboard: boolean): void {
  if (!(amt > 0)) return;
  const n0 = shakeNoise(0, tSec), n1 = shakeNoise(1, tSec), n2 = shakeNoise(2, tSec), n3 = shakeNoise(3, tSec);
  if (onboard) {
    eye[0] += clamp(n0 * amt * 0.1, -TUB_EYE_MAX, TUB_EYE_MAX);
    eye[1] += clamp(n1 * amt * 0.07, -TUB_EYE_MAX, TUB_EYE_MAX);
    applyAim(eye, tgt, n2 * amt * ONBOARD_AIM_DEG, n3 * amt * ONBOARD_AIM_DEG * 0.6);
    return;
  }
  eye[0] += n0 * amt; eye[1] += n1 * amt * 0.7;
  tgt[0] += n2 * amt * 0.6; tgt[1] += n3 * amt * 0.6;
}

/** The per-frame look inputs (f1-game `Input.lookStick` & co, js/input/input.js). */
export interface LookInput {
  lookStick?(): { readonly x: number; readonly y: number };
  consumeLookMouse?(): { readonly dx: number; readonly dy: number };
  lookingBack?(): boolean;
  lookMouseHeld?(): boolean;
}

export interface CamFeelDeps {
  readonly store?: CamStore | null;
  readonly input?: LookInput | null;
  /** DriveChase.apply (js/camera/drive-chase.js:13). TODO(lane-shell). */
  readonly chaseLens?: LensApply | null;
  /** Where the vignette paints; null = no DOM. Default: the global document when there is one. */
  readonly doc?: Document | null;
}

/** `tick()` options (feel.js:226-227). */
export interface FeelTickOpts {
  mode?: string | null;
  dt?: number;
  comfort?: boolean;
  racing?: boolean;
  lookHeld?: boolean;
  mouseHeld?: boolean;
  stickX?: number;
  stickY?: number;
  mouseDx?: number;
  mouseDy?: number;
  spN?: number;
}

/** The `extra` bag vantage.js hands `drive` (feel.js:201-222). */
export interface DriveExtra {
  readonly dt?: number;
  readonly snap?: boolean;
  readonly reduceMotion?: boolean;
  readonly att?: { readonly yawRateCur?: number; readonly baPitch?: number } | null;
  readonly slipLat?: number;
}

export type CamFeel = ReturnType<typeof createCamFeel>;

export function createCamFeel(deps: CamFeelDeps = {}) {
  const store = deps.store ?? null;
  const input = deps.input ?? null;
  const chaseLens = deps.chaseLens ?? null;
  const doc: Document | null = deps.doc !== undefined ? deps.doc : (typeof document !== "undefined" ? document : null);

  let latchOn = false;
  let vignetteOn = false;
  let latchHeld = false;                 // latched look-back state
  let prevLookDown = false;              // edge detect for latch toggle
  let lookBackOn = false;                // this frame's look-back, as tick() resolved it
  let aimSnap = false;                   // look-back flipped: the aim is a cut, not a pan

  // Free-look offsets in degrees (additive on top of CamTune yaw/pitch).
  let lookYaw = 0, lookPitch = 0;

  let _vigEl: HTMLDivElement | null = null;

  function readBool(key: string, def: boolean): boolean {
    if (!store) return def;
    const v = store.get(key, null);
    if (v === null || v === undefined) return def;
    if (v === true || v === "1" || v === "on") return true;
    if (v === false || v === "0" || v === "off") return false;
    return def;
  }
  function loadSettings(): void {
    latchOn = readBool(K_LATCH, false);
    vignetteOn = readBool(K_VIGNETTE, false);
  }
  loadSettings();

  function lookBackLatch(): boolean { return latchOn; }
  function setLookBackLatch(on: unknown): boolean {
    latchOn = !!on;
    if (store) store.set(K_LATCH, latchOn);
    if (!latchOn) latchHeld = false;
    return latchOn;
  }
  function speedVignette(): boolean { return vignetteOn; }
  function setSpeedVignette(on: unknown): boolean {
    vignetteOn = !!on;
    if (store) store.set(K_VIGNETTE, vignetteOn);
    if (!vignetteOn) paintVignette(0);
    return vignetteOn;
  }

  function shouldLookBack(mode: string, held: unknown): boolean {
    if (looksAftAlready(mode)) return false;
    if (latchOn) return latchHeld;
    return !!held;
  }

  function applyFreeLook(eye: Vec3, tgt: Vec3): void {
    if (lookYaw || lookPitch) applyAim(eye, tgt, lookYaw, lookPitch);
  }

  // Live framing offsets (corner side, drift swing, chase yaw). A one-shot
  // solve (dt 0, the unit tests and snapCam) returns `target` unchanged so
  // shipped framing stays exact. A racing frame eases toward it, so a bend
  // that flips side pans instead of teleporting the eye across the circuit.
  const _fol = new Map<string, number>();
  // A second camera solving the same vantage branches (the TV director) runs
  // under its own key prefix so the two never damp one state toward two cars.
  let _ns = "";
  function scoped<T>(prefix: string, fn: () => T): T {
    const prev = _ns;
    _ns = prev + prefix;
    try { return fn(); } finally { _ns = prev; }
  }
  // The key as the current scope sees it: state kept beside a follow (vantage's
  // bend-hang maps) must use it, or the two cameras share it after all.
  function scopeKey(key: string): string { return _ns + key; }
  function follow(key: string, target: number, lambda: number, dt: number): number {
    if (_ns) key = _ns + key;
    if (!(dt > 0)) { _fol.set(key, target); return target; }
    const cur = _fol.get(key);
    const next = cur == null || cur !== cur ? target : dampToward(cur, target, lambda, dt);
    _fol.set(key, next);
    return next;
  }
  function resetFollow(key?: string | null): void {
    if (key) _fol.delete(_ns + key);
    else _fol.clear();
  }

  /** The lens FOV in degrees for `mode` (feel.js:201-222). Never moves eye or tgt. */
  function drive(mode: string, eye: Vec3, tgt: Vec3, fov: number, extra: DriveExtra | null | undefined, spN: number): number {
    if (!extra || extra.reduceMotion) return fov;
    // A snap (no dt) reseeds the follow keys below, so the next live frame
    // eases from the snapped value instead of popping from a stale one.
    const dt = extra.dt !== undefined && extra.dt > 0 ? extra.dt : 0;
    if (!dt && !extra.snap) return fov;
    const att = extra.att || {};
    const rate = DRIVE_RESPONSE[mode] || { sp: 3, yaw: 3, brake: 5, slip: 3 };
    let delta: number | null = null;
    const ctx: LensCtx = {
      sp: follow("sp:" + mode, clamp(spN || 0, 0, 1), rate.sp, dt),
      yaw: follow("yaw:" + mode, clamp((att.yawRateCur || 0) / 1.1, -1, 1), rate.yaw, dt),
      brake: follow("brk:" + mode, clamp((att.baPitch || 0) / 0.025, 0, 1), rate.brake, dt),
      slip: follow("slp:" + mode, clamp((extra.slipLat || 0) / 6, -1, 1), rate.slip, dt),
    };
    if (chaseLens) delta = chaseLens(mode, eye, tgt, ctx);
    if (delta == null) delta = DriveBroadcast.apply(mode, eye, tgt, ctx);
    if (delta == null) delta = DriveOnboard.apply(mode, eye, tgt, ctx);
    return delta == null ? fov : fov + delta;
  }

  /* opts: { mode, dt, comfort, racing, lookHeld, stickX, stickY, mouseDx, mouseDy, spN }
     Call once per rendered race frame from game.js BEFORE vantage so look-back
     and free-look offsets are current for that solve. */
  function tick(o?: FeelTickOpts | null): void {
    const opts = o || {};
    const mode = opts.mode || "chase";
    const dt = opts.dt || 0;
    const comfort = !!opts.comfort;
    const racing = !!opts.racing;
    const held = !!opts.lookHeld;

    // LOOK BACK latch: rising edge toggles; leaving a skip mode clears.
    if (looksAftAlready(mode)) {
      latchHeld = false;
      prevLookDown = held;
    } else if (latchOn && racing) {
      if (held && !prevLookDown) latchHeld = !latchHeld;
      prevLookDown = held;
    } else {
      prevLookDown = held;
      if (!latchOn) latchHeld = false;
    }

    // LOOK BACK IS A CUT FOR THE AIM. vantage.js mirrors the target about the
    // eye; damping that POINT from ahead to behind drags it along a line through
    // the eye — the view pitched to the floor (−65° chase, −89° at 144 Hz) and
    // the yaw flipped in one frame. game.js snaps the target on this edge
    // (consumeAimSnap) and mirrors the roll; the eye is untouched either way.
    const lb = shouldLookBack(mode, held);
    if (lb !== lookBackOn) { lookBackOn = lb; aimSnap = true; }

    // FREE-LOOK — onboard only, never under camComfort / menus / non-race.
    if (!racing || comfort || !isFreeLookMode(mode)) {
      lookYaw = dampToward(lookYaw, 0, RECENTER * 1.5, dt);
      lookPitch = dampToward(lookPitch, 0, RECENTER * 1.5, dt);
    } else {
      const sx = clamp(opts.stickX || 0, -1, 1);
      const sy = clamp(opts.stickY || 0, -1, 1);
      const mx = opts.mouseDx || 0, my = opts.mouseDy || 0;
      // RMB HELD is a glance being held, moving or not: deltas alone counted a
      // still mouse as released and recentred at λ6 mid-apex.
      const active = Math.abs(sx) > 0.02 || Math.abs(sy) > 0.02 || mx || my || !!opts.mouseHeld;
      if (active) {
        lookYaw = clamp(lookYaw + sx * STICK_RATE * dt + mx * MOUSE_SENS, -YAW_MAX, YAW_MAX);
        lookPitch = clamp(lookPitch - sy * STICK_RATE * dt - my * MOUSE_SENS, -PITCH_MAX, PITCH_MAX);
      } else {
        lookYaw = dampToward(lookYaw, 0, RECENTER, dt);
        lookPitch = dampToward(lookPitch, 0, RECENTER, dt);
      }
    }

    // SPEED VIGNETTE — tunnel darkening with speed; off by default / comfort.
    if (!vignetteOn || comfort || !racing) paintVignette(0);
    else {
      const n = clamp(opts.spN || 0, 0, 1);
      paintVignette(n * n * 0.55);
    }
  }

  // Thin game.js entry: pull look axes from Input, then tick(). One pooled opts
  // bag (tick() reads it and keeps nothing): a fresh literal ran every frame.
  const _NO_STICK = Object.freeze({ x: 0, y: 0 }), _NO_MOUSE = Object.freeze({ dx: 0, dy: 0 });
  const _raceOpts: FeelTickOpts = { mode: null, dt: 0, comfort: false, racing: false, lookHeld: false, mouseHeld: false,
    stickX: 0, stickY: 0, mouseDx: 0, mouseDy: 0, spN: 0 };
  function tickRace(mode: string, dt: number, comfort: boolean, racing: boolean, spN: number): void {
    const ls = input && input.lookStick ? input.lookStick() : _NO_STICK;
    const lm = input && input.consumeLookMouse ? input.consumeLookMouse() : _NO_MOUSE;
    const o = _raceOpts;
    o.mode = mode; o.dt = dt; o.comfort = comfort; o.racing = racing;
    o.lookHeld = !!(input && input.lookingBack && input.lookingBack());
    o.mouseHeld = !!(input && input.lookMouseHeld && input.lookMouseHeld());
    o.stickX = ls.x; o.stickY = ls.y; o.mouseDx = lm.dx; o.mouseDy = lm.dy; o.spN = spN;
    tick(o);
  }
  function lookingBackNow(): boolean { return lookBackOn; }
  function consumeAimSnap(): boolean { const v = aimSnap; aimSnap = false; return v; }

  function paintVignette(amt: number): void {
    if (!doc) return;
    if (!(amt > 0.01)) {
      if (_vigEl) _vigEl.style.opacity = "0";
      return;
    }
    if (!_vigEl) {
      _vigEl = doc.createElement("div");
      _vigEl.id = "speed-vignette";
      _vigEl.setAttribute("aria-hidden", "true");
      // Radial tunnel — no new CSS class token (cssClasses ratchet is saturated).
      _vigEl.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:4;" +
        "opacity:0;transition:opacity .12s linear;" +
        "background:radial-gradient(ellipse at center," +
        "rgba(0,0,0,0) 42%,rgba(0,0,0,.55) 100%)";
      (doc.getElementById("overlay") || doc.body).appendChild(_vigEl);
    }
    _vigEl.style.opacity = String(clamp(amt, 0, 0.7));
  }

  function freeLookState(): { yaw: number; pitch: number } {
    return { yaw: lookYaw, pitch: lookPitch };
  }
  function resetFreeLook(): void { lookYaw = 0; lookPitch = 0; }
  function resetLatch(): void { latchHeld = false; prevLookDown = false; lookBackOn = false; aimSnap = false; }
  /** Remove the vignette element (the f1-game singleton never tears down). */
  function dispose(): void { if (_vigEl) { _vigEl.remove(); _vigEl = null; } }

  return Object.freeze({
    BUZZ_MODES, FREELOOK_MODES, LOOKBACK_SKIP, FOV_BY_MODE,
    K_LATCH, K_VIGNETTE,
    speedFov, modeFov,
    isBuzzMode, isFreeLookMode, looksAftAlready,
    shouldLookBack, lookBackLatch, setLookBackLatch,
    speedVignette, setSpeedVignette,
    applyFreeLook, applyAim, tick, tickRace, freeLookState, resetFreeLook, resetLatch,
    lookingBackNow, consumeAimSnap, shake, shakeNoise, TUB_EYE_MAX,
    follow, resetFollow, drive,
    loadSettings, scoped, scopeKey, dispose,
  });
}

/**
 * SETTINGS › DISPLAY › CAMERA FEEL (feel.js:376-418 `initUI`): the LOOK BACK
 * LATCH and SPEED VIGNETTE rows in a fold. f1-game finds its host by id
 * (#pm-panel-display); here the caller hands `host`. Placement inside `host`
 * keeps f1-game's: after #pm-cockpit, else before #pm-visual-tuners, else last.
 */
export function mountCamFeelSettings(host: HTMLElement, feel: CamFeel): { unmount(): void } {
  const doc = host.ownerDocument;
  if (doc.getElementById("pm-looklatch")) return { unmount() { /* already mounted elsewhere */ } };
  const fold = doc.createElement("details");
  fold.id = "pm-camfeel";
  fold.className = "pm-renderer-sub";
  const sum = doc.createElement("summary");
  sum.className = "adv-more-btn";
  sum.id = "pm-camfeel-sum";
  sum.textContent = "CAMERA FEEL";
  const body = doc.createElement("div");
  body.id = "pm-camfeel-body";
  body.setAttribute("role", "group");
  body.setAttribute("aria-label", "Camera feel");
  fold.appendChild(sum);
  fold.appendChild(body);
  // Sit with COCKPIT, ahead of ADVANCED VISUALS when that fold exists.
  const tools = doc.getElementById("pm-visual-tuners");
  const cock = doc.getElementById("pm-cockpit");
  if (cock && cock.parentNode === host) host.insertBefore(fold, cock.nextSibling);
  else if (tools && tools.parentNode === host) host.insertBefore(fold, tools);
  else host.appendChild(fold);

  const help = (text: string): void => {
    const p = doc.createElement("p");
    p.className = "adv-help";
    p.textContent = text;
    body.appendChild(p);
  };
  const row = (id: string, label: string, title: string, read: () => string, write: (v: string) => void): void => {
    const r = buildSettingRow(doc, id, label, labels(["off", "on"]));
    r.row.title = title;
    wireSettingRow(r.row, { read, write });
    body.appendChild(r.row);
    help(title);
  };
  row("pm-looklatch", "LOOK BACK LATCH",
    "OFF = hold B / the pad button to glance behind. ON = press once to latch the rear view, press again to release. Never flips reverse or rear cams.",
    () => (feel.lookBackLatch() ? "on" : "off"),
    (v) => feel.setLookBackLatch(v === "on"));
  row("pm-speedvig", "SPEED VIGNETTE",
    "Soft tunnel darkening that grows with speed (motion comfort). Off by default; also forced off when Reduce Motion is on.",
    () => (feel.speedVignette() ? "on" : "off"),
    (v) => feel.setSpeedVignette(v === "on"));
  return { unmount() { fold.remove(); } };
}
