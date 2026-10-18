/**
 * Keyboard + gamepad into `PlayerInput`. Port of the keyboard and gamepad
 * halves of f1-game js/input/input.js (tilt, touch, on-screen buttons and the
 * phone pad follow with the touch/tilt task).
 *
 * - Steering priority (input.js:1724-1746 `steerNow`): keyboard while a key is
 *   held or still returning to centre, then a deflected pad (stick, else the
 *   ramped d-pad), else 0.
 * - Keys: last key wins when both directions are held (input.js:554-559).
 * - Pedals (input.js:1771-1795): a key is full travel; a trigger reports its
 *   travel past `PAD_PEDAL_DZ`.
 * - Edge controls (shift, boost, overtake, aero, camera, recover) latch on the
 *   press and are consumed once (input.js:1797-1837), so each is true for
 *   exactly one physics step, as `PlayerInput` requires.
 * - Pad buttons are read once per display frame (`poll`), rising edges against
 *   the previous snapshot (input.js:1426-1428).
 *
 * Deviation: the keyboard and d-pad ramps advance on the physics step's dt
 * (`sample(dt)`, game.js:5567 `Input.steer(dt)`); f1-game ramps the d-pad on
 * the wall clock in `poll`. Stepping both on the sim clock keeps them
 * deterministic.
 *
 * THE ARC MUST NOT REACH THE DRIVER: nothing here reads the track.
 */
import type { PlayerInput } from "../contracts/sim";
import { DEFAULT_PAD, PAD_DPAD_LEFT, PAD_DPAD_RIGHT, keyIndex, type KeyAction, type PadAction } from "./bindings";
import { digitalStep, padAxisShape, padPedalLevel } from "./shaping";

/** The subset of the W3C `Gamepad` this reads; structural so tests can fake it. */
export interface PadLike {
  readonly connected: boolean;
  readonly mapping: string;
  readonly timestamp: number;
  readonly axes: readonly number[];
  readonly buttons: ReadonlyArray<{ readonly pressed: boolean; readonly value: number }>;
}

export type PadSource = () => ReadonlyArray<PadLike | null>;

type Edge = "boost" | "overtake" | "aero" | "shiftUp" | "shiftDown" | "camera" | "recover" | "pause";
const EDGES: readonly Edge[] = ["boost", "overtake", "aero", "shiftUp", "shiftDown", "camera", "recover", "pause"];

function defaultPads(): ReadonlyArray<PadLike | null> {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return [];
  try { return navigator.getGamepads(); } catch { return []; }
}

export class Input {
  private readonly keys = keyIndex();
  private keyLeft = false;
  private keyRight = false;
  private keyThrottle = false;
  private keyBrake = false;
  private keyLookBack = false;
  private keySeq = 0;
  private keyLeftSeq = 0;
  private keyRightSeq = 0;
  private keySteerVal = 0;

  private padConnected = false;
  private padStick = 0;
  private padDpadTarget = 0;
  private padDpadVal = 0;
  private padDpadSeq = 0;
  private padDpadLeftSeq = 0;
  private padDpadRightSeq = 0;
  private padDpadLeftHeld = false;
  private padDpadRightHeld = false;
  private padThrottleVal = 0;
  private padBrakeVal = 0;
  private padLookBack = false;
  private padPrev: boolean[] = [];

  private readonly edges = new Set<Edge>();
  /** Debug/test override: when set, `sample` returns it (edges once). */
  private override: PlayerInput | null = null;
  private listening: EventTarget | null = null;

  constructor(private readonly pads: PadSource = defaultPads) {}

  // ─── keyboard ────────────────────────────────────────────────────────────

  private readonly onKeyDown = (e: Event): void => { this.key(e as KeyboardEvent, true); };
  private readonly onKeyUp = (e: Event): void => { this.key(e as KeyboardEvent, false); };
  private readonly onBlur = (): void => { this.releaseKeys(); };

  attach(target: EventTarget = window): void {
    if (this.listening) return;
    this.listening = target;
    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
    target.addEventListener("blur", this.onBlur);
  }

  detach(): void {
    const t = this.listening;
    if (!t) return;
    t.removeEventListener("keydown", this.onKeyDown);
    t.removeEventListener("keyup", this.onKeyUp);
    t.removeEventListener("blur", this.onBlur);
    this.listening = null;
  }

  /** Apply one key event. Typing in a field never drives (input.js:931-956); releases always clear. */
  key(e: Pick<KeyboardEvent, "code" | "repeat"> & Partial<Pick<KeyboardEvent, "target" | "preventDefault">>, down: boolean): void {
    const action = this.keys.get(e.code);
    if (!action) return;
    if (down && isTextEntry(e.target)) return;
    if (down && e.preventDefault) e.preventDefault();
    this.setKey(action, down, !!e.repeat);
  }

  private setKey(action: KeyAction, down: boolean, repeat: boolean): void {
    switch (action) {
      case "left":
        if (down && !this.keyLeft) this.keyLeftSeq = ++this.keySeq;
        this.keyLeft = down; return;
      case "right":
        if (down && !this.keyRight) this.keyRightSeq = ++this.keySeq;
        this.keyRight = down; return;
      case "throttle": this.keyThrottle = down; return;
      case "brake": this.keyBrake = down; return;
      case "lookBack": this.keyLookBack = down; return;
      default:
        if (down && !repeat) this.edges.add(action);
    }
  }

  /** Drop every held key (window blur, a menu opening). */
  releaseKeys(): void {
    this.keyLeft = this.keyRight = this.keyThrottle = this.keyBrake = this.keyLookBack = false;
  }

  // ─── gamepad ─────────────────────────────────────────────────────────────

  /** Read the gamepad once per display frame (input.js:1760 `poll`). */
  poll(): void {
    const pad = pickPad(this.pads());
    if (!pad) {
      this.padConnected = false;
      this.padStick = 0; this.padDpadTarget = 0; this.padDpadVal = 0;
      this.padThrottleVal = this.padBrakeVal = 0; this.padLookBack = false;
      this.padDpadLeftHeld = this.padDpadRightHeld = false;
      this.padPrev.length = 0;
      return;
    }
    // A pad that just (re)connected: seed the snapshot so a held button is not an edge.
    if (!this.padConnected) this.padPrev = pad.buttons.map((b) => b.pressed);
    this.padConnected = true;
    const std = pad.mapping === "standard";
    this.padStick = padAxisShape(pad.axes[0] ?? 0);
    const left = std && !!pad.buttons[PAD_DPAD_LEFT]?.pressed;
    const right = std && !!pad.buttons[PAD_DPAD_RIGHT]?.pressed;
    if (left && !this.padDpadLeftHeld) this.padDpadLeftSeq = ++this.padDpadSeq;
    if (right && !this.padDpadRightHeld) this.padDpadRightSeq = ++this.padDpadSeq;
    this.padDpadLeftHeld = left; this.padDpadRightHeld = right;
    this.padDpadTarget = left && right ? (this.padDpadRightSeq > this.padDpadLeftSeq ? 1 : -1)
      : (right ? 1 : 0) - (left ? 1 : 0);
    this.padThrottleVal = padPedalLevel(padActVal(pad, "throttle"));
    this.padBrakeVal = padPedalLevel(padActVal(pad, "brake"));
    this.padLookBack = padActDown(pad, "lookBack");
    for (const e of EDGES) if (padActEdge(pad, e, this.padPrev)) this.edges.add(e);
    this.padPrev = pad.buttons.map((b) => b.pressed);
  }

  // ─── outputs ─────────────────────────────────────────────────────────────

  /** One physics step of `PlayerInput`. Advances the digital ramps by `dt` and consumes edges. */
  sample(dt: number): PlayerInput {
    const o = this.override;
    if (o) {
      const out = { ...o };
      this.override = { ...o, shiftUp: false, shiftDown: false, aeroToggle: false, overtake: false, boost: false };
      return out;
    }
    return {
      steer: this.steer(dt),
      throttle: this.throttleLevel() > 0,
      brake: this.brakeLevel() > 0,
      throttleLevel: this.throttleLevel(),
      brakeLevel: this.brakeLevel(),
      shiftUp: this.consume("shiftUp"),
      shiftDown: this.consume("shiftDown"),
      aero: false,
      aeroToggle: this.consume("aero"),
      overtake: this.consume("overtake"),
      boost: this.consume("boost"),
    };
  }

  private steer(dt: number): number {
    const target = this.keyLeft && this.keyRight ? (this.keyRightSeq > this.keyLeftSeq ? 1 : -1)
      : (this.keyRight ? 1 : 0) - (this.keyLeft ? 1 : 0);
    this.keySteerVal = digitalStep(this.keySteerVal, target, dt);
    this.padDpadVal = this.padConnected ? digitalStep(this.padDpadVal, this.padDpadTarget, dt) : 0;
    if (this.keyLeft || this.keyRight || Math.abs(this.keySteerVal) > 0.001) return this.keySteerVal;
    if (this.padConnected) {
      if (Math.abs(this.padStick) > 0.001) return this.padStick;
      if (Math.abs(this.padDpadVal) > 0.001) return this.padDpadVal;
    }
    return 0;
  }

  throttleLevel(): number { return this.keyThrottle ? 1 : this.padThrottleVal; }
  brakeLevel(): number { return this.keyBrake ? 1 : this.padBrakeVal; }
  lookingBack(): boolean { return this.keyLookBack || this.padLookBack; }

  /** True once per press of an app-level edge (camera, recover, pause). */
  consume(e: Edge): boolean {
    return this.edges.delete(e);
  }

  /** Drop pending edges (pause menu open; input.js:2341 `clearEdges`). */
  clearEdges(): void { this.edges.clear(); }

  /** Debug API: drive with a fixed input until `null` is set. Edge fields fire on the next step only. */
  setOverride(input: PlayerInput | null): void { this.override = input ? { ...input } : null; }
  get overridden(): boolean { return this.override !== null; }
}

/** The pad being used: the most recently updated connected one (input.js:1343). */
export function pickPad(pads: ReadonlyArray<PadLike | null>): PadLike | null {
  let best: PadLike | null = null;
  for (const p of pads) if (p && p.connected && (!best || p.timestamp > best.timestamp)) best = p;
  return best;
}

function padActVal(pad: PadLike, id: PadAction): number {
  let v = 0;
  for (const b of DEFAULT_PAD[id]) v = Math.max(v, Math.min(1, Math.max(0, pad.buttons[b]?.value ?? 0)));
  return v;
}

function padActDown(pad: PadLike, id: PadAction): boolean {
  return DEFAULT_PAD[id].some((b) => !!pad.buttons[b]?.pressed);
}

function padActEdge(pad: PadLike, id: PadAction, prev: readonly boolean[]): boolean {
  return DEFAULT_PAD[id].some((b) => !!pad.buttons[b]?.pressed && !prev[b]);
}

function isTextEntry(t: EventTarget | null | undefined): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || !!el.isContentEditable;
}
