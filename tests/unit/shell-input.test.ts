import { describe, expect, it } from "vitest";
import { Input, type PadLike } from "../../src/input/input";
import { KEY_RAMP_IN, digitalStep, fromShaped, padAxisShape, padPedalLevel, toShaped } from "../../src/input/shaping";

const DT = 1 / 60;
const key = (code: string) => ({ code, repeat: false });

function pad(over: { axes?: number[]; pressed?: Record<number, number> } = {}): PadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const v = over.pressed?.[i] ?? 0;
    return { pressed: v > 0.5, value: v };
  });
  return { connected: true, mapping: "standard", timestamp: 1, axes: over.axes ?? [0, 0, 0, 0], buttons };
}

describe("shaping (input.js)", () => {
  it("toShaped/fromShaped invert each other", () => {
    for (const v of [-1, -0.4, 0, 0.3, 1]) expect(fromShaped(toShaped(v))).toBeCloseTo(v, 12);
  });

  it("a held key reaches full lock in 1/KEY_RAMP_IN s, linear in road-wheel space", () => {
    let v = 0;
    const n = Math.round(1 / KEY_RAMP_IN / DT);
    for (let i = 0; i < 6; i++) v = digitalStep(v, 1, DT);
    expect(toShaped(v)).toBeCloseTo(6 * KEY_RAMP_IN * DT, 9);
    for (let i = 0; i < n; i++) v = digitalStep(v, 1, DT);
    expect(v).toBe(1);
  });

  it("reversing unwinds at the out-rate first", () => {
    const v = digitalStep(1, -1, DT);
    expect(toShaped(v)).toBeCloseTo(1 - 8 * DT, 9);
  });

  it("pad dead zone and pedal dead zone", () => {
    expect(padAxisShape(0.04)).toBe(0);
    expect(padAxisShape(1)).toBe(1);
    expect(padAxisShape(-0.525)).toBeCloseTo(-0.5, 9);
    expect(padPedalLevel(0.1)).toBe(0);
    expect(padPedalLevel(1)).toBe(1);
  });
});

describe("Input", () => {
  it("keyboard throttle/brake are full travel and steer ramps", () => {
    const inp = new Input(() => []);
    inp.key(key("ArrowUp"), true);
    inp.key(key("ArrowRight"), true);
    const a = inp.sample(DT);
    expect(a.throttle).toBe(true);
    expect(a.throttleLevel).toBe(1);
    expect(a.brake).toBe(false);
    expect(a.steer).toBeGreaterThan(0);
    expect(a.steer).toBeLessThan(1);
    for (let i = 0; i < 30; i++) inp.sample(DT);
    expect(inp.sample(DT).steer).toBe(1);
  });

  it("last key wins when both directions are held", () => {
    const inp = new Input(() => []);
    inp.key(key("ArrowLeft"), true);
    inp.key(key("ArrowRight"), true);
    for (let i = 0; i < 60; i++) inp.sample(DT);
    expect(inp.sample(DT).steer).toBe(1);
  });

  it("edges fire for exactly one step and ignore key repeat", () => {
    const inp = new Input(() => []);
    inp.key(key("KeyE"), true);
    inp.key({ code: "KeyE", repeat: true }, true);
    expect(inp.sample(DT).shiftUp).toBe(true);
    expect(inp.sample(DT).shiftUp).toBe(false);
  });

  it("typing in a field does not drive, but its release still clears", () => {
    const inp = new Input(() => []);
    inp.key(key("KeyW"), true);
    inp.key({ code: "KeyW", repeat: false, target: { tagName: "INPUT" } as unknown as EventTarget }, false);
    expect(inp.sample(DT).throttle).toBe(false);
    inp.key({ code: "KeyW", repeat: false, target: { tagName: "INPUT" } as unknown as EventTarget }, true);
    expect(inp.sample(DT).throttle).toBe(false);
  });

  it("gamepad stick, triggers and button edges", () => {
    let p = pad({ axes: [-1, 0, 0, 0], pressed: { 7: 0.56 } });
    const inp = new Input(() => [null, p]);
    inp.poll();
    const a = inp.sample(DT);
    expect(a.steer).toBe(-1);
    expect(a.throttleLevel).toBeCloseTo(0.5, 9);
    p = pad({ pressed: { 5: 1 } });
    inp.poll();
    expect(inp.sample(DT).shiftUp).toBe(true);
    inp.poll();   // still held: no new edge
    expect(inp.sample(DT).shiftUp).toBe(false);
  });

  it("the keyboard wins over the pad", () => {
    const inp = new Input(() => [pad({ axes: [-1, 0, 0, 0] })]);
    inp.poll();
    inp.key(key("KeyD"), true);
    expect(inp.sample(DT).steer).toBeGreaterThan(0);
  });

  it("override drives with edges once", () => {
    const inp = new Input(() => []);
    inp.setOverride({ steer: 0.25, throttle: true, brake: false, throttleLevel: 1, brakeLevel: 0, shiftUp: true, shiftDown: false, aero: false, aeroToggle: false, overtake: false, boost: false });
    expect(inp.sample(DT)).toMatchObject({ steer: 0.25, shiftUp: true });
    expect(inp.sample(DT)).toMatchObject({ steer: 0.25, shiftUp: false });
    inp.setOverride(null);
    expect(inp.sample(DT).throttle).toBe(false);
  });

  it("PlayerInput carries no arc field", () => {
    const out = new Input(() => []).sample(DT) as unknown as Record<string, unknown>;
    for (const k of ["curvature", "kPath", "kCur", "kTurn", "racingLine", "racingLineX", "lineX"]) expect(k in out).toBe(false);
  });
});
