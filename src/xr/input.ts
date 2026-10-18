// XR controllers -> the game's remote input lane. Ported from f1-game
// js/xr/xr-input.js:1-135 (XrInput.mapFrame / inject). Pure mapping + edge latch, so
// tests need no WebXR runtime; ./session.ts feeds the live input sources.
//
// Quest Touch (xr-standard mapping): buttons[0] trigger, [1] squeeze, [3] thumbstick
// press, [4] A/X, [5] B/Y; axes[2]/[3] thumbstick. Right trigger = throttle, left
// trigger = brake, thumbstick X = steer, A/X = recenter, B/Y = pause. With a granted
// DOM overlay and an open menu: stick = navigation, A/X = select, B/Y = back. Squeeze
// never turns the seated gaze.
//
// The arc rule (AGENTS.md): nothing here reads track curvature or the racing line;
// the steer command is the raw stick past a dead zone.
import { stickToSteer } from "./rig";

export const BTN_TRIGGER = 0;
export const BTN_SQUEEZE = 1;
export const BTN_STICK = 3;
export const BTN_PRIMARY = 4; // A (right) / X (left)
export const BTN_SECONDARY = 5; // B (right) / Y (left)
export const AXIS_STICK_X = 2;
export const AXIS_STICK_Y = 3;

/** The parts of a `GamepadButton` read here. */
export interface XrButtonLike {
  value?: number | undefined;
  pressed?: boolean | undefined;
}

/** The parts of an XR `Gamepad` read here. */
export interface XrGamepadLike {
  buttons?: ArrayLike<XrButtonLike | null | undefined> | undefined;
  axes?: ArrayLike<number> | undefined;
}

/** The parts of an `XRInputSource` read here. */
export interface XrInputSourceLike {
  handedness?: string | undefined;
  targetRayMode?: string | undefined;
  gamepad?: XrGamepadLike | null | undefined;
}

/** An `XRInputSourceArray` (indexed + length; it has no Array methods). */
export type XrInputSources = ArrayLike<XrInputSourceLike | null | undefined>;

export type XrNavDirection = "navUp" | "navDown" | "navLeft" | "navRight";
export type XrEventName = "pause" | "navSelect" | "navBack" | XrNavDirection;

/** Edge latch between frames (mutated by mapFrame). */
export interface XrInputLatch {
  primary: boolean;
  secondary: boolean;
  direction?: XrNavDirection | null;
}

export interface MapFrameOptions {
  /** A menu is open: pedals and steer are zeroed. */
  menuOpen?: boolean;
  /** The session granted a DOM overlay: an open menu takes stick/A/B navigation. */
  overlay?: boolean;
  /** false = EXISTING CONTROLS: the XR lane releases driving (events still flow). */
  driving?: boolean;
}

/** `roll` is a -1..1 steer command (the name is f1-game's); null = no usable stick. */
export interface XrSample {
  roll: number | null;
  thr: number;
  brk: number;
  held: number;
}

export interface MappedFrame {
  sample: XrSample;
  driving: boolean;
  events: XrEventName[];
  recenter: boolean;
  latch: XrInputLatch;
}

/** What inject() sends: a stick (`steer`), never a tilt (`roll`). */
export interface XrRemoteSample {
  source: "xr";
  thr: number;
  brk: number;
  held: number;
  steer?: number;
}

/**
 * The game input's remote lane (f1-game js/input/input.js Input.remoteSample /
 * remoteEvent / remoteLost; the same lane the phone pad feeds, src/net/phone-pad.ts
 * PhonePadInput). TODO(lane-shell): src/input implements this; `remoteLost("xr")`
 * must release only a sample whose source is "xr", never a newer phone sample.
 */
export interface XrRemoteInput {
  remoteSample(s: XrRemoteSample): unknown;
  remoteEvent(k: XrEventName): unknown;
  remoteLost?(source: "xr"): unknown;
}

function btn(gp: XrGamepadLike | null | undefined, i: number): number {
  const b = gp && gp.buttons && gp.buttons[i];
  if (!b) return 0;
  if (typeof b.value === "number") return b.value;
  return b.pressed ? 1 : 0;
}

function axis(gp: XrGamepadLike | null | undefined, i: number): number {
  const a = gp && gp.axes;
  return a && a.length > i ? +(a[i] as number) || 0 : 0;
}

function usableStick(src: XrInputSourceLike | null | undefined): boolean {
  return !!(
    src &&
    src.targetRayMode !== "gaze" &&
    src.gamepad &&
    src.gamepad.axes &&
    src.gamepad.axes.length > AXIS_STICK_X &&
    Number.isFinite(src.gamepad.axes[AXIS_STICK_X])
  );
}

/**
 * xr-input.js:29-97: map one XRFrame's input sources into a remote sample + edge
 * events. `prev` is the previous latch (mutated and returned as `latch`).
 */
export function mapFrame(
  sources: XrInputSources | null | undefined,
  prev?: XrInputLatch | Partial<XrInputLatch> | null,
  options?: MapFrameOptions | null,
): MappedFrame {
  const menuOpen = !!(options && options.menuOpen);
  const menuNav = menuOpen && !!(options && options.overlay);
  let thr = 0, brk = 0, stickX = 0, stickY = 0;
  const held = 0;
  let primaryDown = false, secondaryDown = false;
  const list: XrInputSources = sources || [];
  let hasLeft = false, hasStick = false, hasGamepad = false;
  for (let i = 0; i < list.length; i++) {
    const src = list[i];
    if (usableStick(src) && src && src.handedness === "left") hasLeft = true;
  }
  for (let i = 0; i < list.length; i++) {
    const src = list[i];
    if (!src || src.targetRayMode === "gaze") continue;
    const gp = src.gamepad;
    if (!gp) continue;
    hasGamepad = true;
    const hand = src.handedness; // "left" | "right" | "none"
    const t = btn(gp, BTN_TRIGGER);
    if (hand === "right") thr = Math.max(thr, t);
    else if (hand === "left") brk = Math.max(brk, t);
    else {
      // Ambiguous / none: the trigger is throttle.
      thr = Math.max(thr, t);
    }
    const sx = axis(gp, AXIS_STICK_X);
    // Prefer the left stick for steer when both are present; else any.
    if (usableStick(src)) {
      hasStick = true;
      if (hand === "left" || (!hasLeft && hand !== "right" && !stickX) || (hand === "right" && !hasLeft)) {
        stickX = sx;
        stickY = axis(gp, AXIS_STICK_Y);
      }
    }
    if (btn(gp, BTN_PRIMARY) > 0.5) primaryDown = true;
    if (btn(gp, BTN_SECONDARY) > 0.5) secondaryDown = true;
    // Squeeze never turns the seated XR anchor; look behind physically.
  }
  const latch: XrInputLatch = (prev as XrInputLatch | null | undefined) || { primary: false, secondary: false };
  const events: XrEventName[] = [];
  let recenter = false;
  if (primaryDown && !latch.primary) {
    if (menuNav) events.push("navSelect");
    else recenter = true;
  }
  if (secondaryDown && !latch.secondary) events.push(menuNav ? "navBack" : "pause");
  const direction: XrNavDirection | null =
    menuNav && Math.max(Math.abs(stickX), Math.abs(stickY)) > 0.55
      ? Math.abs(stickY) >= Math.abs(stickX)
        ? stickY < 0 ? "navUp" : "navDown"
        : stickX < 0 ? "navLeft" : "navRight"
      : null;
  if (direction && direction !== latch.direction) events.push(direction);
  latch.direction = direction;
  if (menuOpen) {
    thr = 0;
    brk = 0;
    stickX = 0;
  }

  latch.primary = primaryDown;
  latch.secondary = secondaryDown;

  const steer = stickToSteer(stickX);
  return {
    sample: { roll: hasStick ? steer : null, thr, brk, held },
    driving: hasGamepad && !(options && options.driving === false),
    events,
    recenter,
    latch,
  };
}

/** The parts of a mapFrame result inject() reads. */
export interface InjectFrame {
  sample: XrSample;
  driving?: boolean;
  events?: readonly XrEventName[];
}

/**
 * xr-input.js:99-117: apply a mapFrame result to the remote lane. The stick goes in
 * as `steer`, an analog command, never through the tilt pipeline.
 */
export function inject(input: XrRemoteInput | null | undefined, mapped: InjectFrame | null | undefined): boolean {
  if (!input || !mapped) return false;
  const s = mapped.sample;
  if (mapped.driving === false) {
    // A disconnect or EXISTING CONTROLS releases only our lane; a phone may have
    // supplied a newer sample since our last frame, so never clear it.
    if (input.remoteLost) input.remoteLost("xr");
  } else {
    const sample: XrRemoteSample = { source: "xr", thr: s.thr, brk: s.brk, held: s.held | 0 };
    if (typeof s.roll === "number") sample.steer = s.roll;
    input.remoteSample(sample);
  }
  const ev = mapped.events || [];
  for (let i = 0; i < ev.length; i++) input.remoteEvent(ev[i] as XrEventName);
  return true;
}
