/**
 * Default key and pad bindings, from f1-game js/input/bindings.js:50-75
 * (`KEY_ACTIONS`, `e.code` values so WASD sits under the same fingers on any
 * layout) and :201-216 (`PAD_ACTIONS`, W3C "standard" mapping indices).
 * Rebinding (the CONTROLS page) comes with the settings screens.
 */

export type KeyAction =
  | "left" | "right" | "throttle" | "brake"
  | "boost" | "overtake" | "aero" | "shiftUp" | "shiftDown"
  | "camera" | "lookBack" | "recover" | "pause";

export type PadAction = Exclude<KeyAction, "left" | "right">;

/** bindings.js:51-74. `pause` is f1-game's Escape/P handling (input.js onKey). */
export const DEFAULT_KEYS: Readonly<Record<KeyAction, readonly string[]>> = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  throttle: ["ArrowUp", "KeyW"],
  brake: ["ArrowDown", "KeyS"],
  boost: ["Space"],
  overtake: ["KeyX"],
  aero: ["KeyZ"],
  shiftUp: ["KeyE"],
  shiftDown: ["KeyQ", "ShiftLeft"],
  camera: ["KeyC"],
  lookBack: ["KeyB"],
  recover: ["KeyR"],
  pause: ["Escape", "KeyP"],
};

/** bindings.js:201-215. D-pad left/right (14/15) are the digital steer axis, not bindings. */
export const DEFAULT_PAD: Readonly<Record<PadAction, readonly number[]>> = {
  throttle: [7, 0],
  brake: [6, 1],
  boost: [2],
  overtake: [3],
  aero: [12],
  shiftUp: [5],
  shiftDown: [4],
  camera: [8],
  lookBack: [11],
  recover: [10],
  pause: [9],
};

/** Standard-mapping d-pad buttons (input.js:884). */
export const PAD_DPAD_LEFT = 14;
export const PAD_DPAD_RIGHT = 15;

/** Reverse index: `e.code` to action. */
export function keyIndex(keys: Readonly<Record<KeyAction, readonly string[]>> = DEFAULT_KEYS): Map<string, KeyAction> {
  const m = new Map<string, KeyAction>();
  for (const [action, codes] of Object.entries(keys) as Array<[KeyAction, readonly string[]]>) {
    for (const c of codes) m.set(c, action);
  }
  return m;
}
