/**
 * src/xr/input.ts (controller mapping) and src/xr/rig.ts (seated-rig math). Ported
 * from the pure tests of f1-game tests/unit/xr-phase0.test.mjs: stickToSteer,
 * composeEye, recenterOffsetFromPose, mapFrame (pedals, steer, edges, overlay menu
 * navigation, left-stick preference, XRInputSourceArray), inject, and the driving
 * source choice. The session-level tests of that file are in xr-session.test.ts.
 */
import { describe, expect, it } from "vitest";
import { inject, mapFrame, type XrInputSourceLike, type XrRemoteInput, type XrRemoteSample } from "../../src/xr/input";
import { ident, invertTo, mulTo } from "../../src/xr/mat4";
import { composeEye, invertRigidTo, makeEyeFrame, recenterOffsetFromPose, stickToSteer, worldFromAnchorTo } from "../../src/xr/rig";
import { pose } from "./xr-harness";

const near = (a: number, b: number, label = ""): void => {
  expect(Math.abs(a - b) < 1e-5, `${label}: ${a} != ${b}`).toBe(true);
};

describe("xr rig (xr-phase0.test.mjs pure rig)", () => {
  it("stickToSteer dead-zones and signs", () => {
    expect(stickToSteer(0)).toBe(0);
    expect(stickToSteer(0.05)).toBe(0);
    expect(stickToSteer(1)).toBeGreaterThan(0.99);
    expect(stickToSteer(-1)).toBeLessThan(-0.99);
    expect(stickToSteer(0.5)).toBeGreaterThan(0);
    expect(stickToSteer(0.5)).toBeLessThan(1);
    expect(Object.is(stickToSteer(0.5), (0.5 - 0.12) / (1 - 0.12))).toBe(true);
    expect(stickToSteer(NaN)).toBe(0);
    expect(stickToSteer(0.3, 0.4)).toBe(0);
  });

  it("composeEye puts the seated eye at the world anchor with identity HMD", () => {
    const out = makeEyeFrame();
    const id = ident();
    composeEye({ eye: [10, 2, -5], fwd: [0, 0, 1], up: [0, 1, 0] }, id, id, out);
    near(out.eye[0], 10, "eye.x");
    near(out.eye[1], 2, "eye.y");
    near(out.eye[2], -5, "eye.z");
  });

  it("composeEye: identity HMD looks down the anchor's fwd; missing matrices never NaN", () => {
    const out = makeEyeFrame();
    composeEye({ eye: [1, 2, 3], fwd: [0.6, 0, 0.8] }, null, null, out);
    const world = invertRigidTo(ident(), out.view);
    near(-(world[8] as number), 0.6, "gaze x");
    near(-(world[10] as number), 0.8, "gaze z");
    for (const m of [out.view, out.proj, out.viewProj, out.invProj, out.invViewProj]) expect(Array.from(m).every(Number.isFinite)).toBe(true);
    // viewProj = proj * view and invViewProj its inverse.
    const vp = mulTo(ident(), out.proj, out.view);
    Array.from(vp).forEach((v, i) => near(v, out.viewProj[i] as number, `vp[${i}]`));
    const back = mulTo(ident(), out.viewProj, out.invViewProj);
    Array.from(back).forEach((v, i) => near(v, i % 5 === 0 ? 1 : 0, `vp*inv[${i}]`));
  });

  it("invertRigidTo matches the general inverse on a rigid pose", () => {
    const m = pose(3, 1.2, -4, 0.7, 0.2, -0.1);
    const a = invertRigidTo(ident(), m), b = invertTo(ident(), m);
    Array.from(a).forEach((v, i) => near(v, b[i] as number, `inv[${i}]`));
  });

  it("worldFromAnchorTo: columns right, up, -fwd, eye (OpenGL camera basis)", () => {
    const m = worldFromAnchorTo(new Float32Array(16), [5, 1, 2], [0, 0, 2], [0, 3, 0]);
    // + 0 folds -0 to 0: the basis, not the zero signs, is under test.
    expect(Array.from(m, (v) => v + 0)).toEqual([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 5, 1, 2, 1]);
  });

  it("recenter defines the seated origin in the base space, not an inverse pose", () => {
    const p = ident();
    p[12] = 1.5; p[13] = 1.65; p[14] = -2;
    const off = recenterOffsetFromPose(p);
    expect({ ...off.position }).toEqual({ x: 1.5, y: p[13], z: -2 });
    expect({ ...off.orientation }).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const yawed = recenterOffsetFromPose(pose(0, 0, 0, 0.6));
    near(2 * Math.atan2(yawed.orientation.y, yawed.orientation.w), 0.6, "yaw");
  });
});

const buttons = (...v: number[]): Array<{ value: number }> => v.map((value) => ({ value }));

describe("xr input (xr-phase0.test.mjs mapping)", () => {
  it("mapFrame: right trigger thr, left brake, stick steer, stable squeeze gaze, edges", () => {
    const latch = { primary: false, secondary: false };
    const right = { handedness: "right", gamepad: { buttons: buttons(0.8, 1, 0, 0, 0, 0), axes: [0, 0, 0, 0] } };
    const left = { handedness: "left", gamepad: { buttons: buttons(0.6, 0, 0, 0, 0, 0), axes: [0, 0, 0.9, 0] } };
    const sources = [right, left];
    const m = mapFrame(sources, latch);
    expect(m.sample.thr).toBeGreaterThan(0.7);
    expect(m.sample.brk).toBeGreaterThan(0.5);
    expect(m.sample.roll as number).toBeGreaterThan(0.5);
    expect(m.sample.held).toBe(0);
    expect(m.recenter).toBe(false);
    expect(m.events.length).toBe(0);
    // Rising edge on A -> recenter; rising edge on B -> pause.
    right.gamepad.buttons[4] = { value: 1 };
    right.gamepad.buttons[5] = { value: 1 };
    const m2 = mapFrame(sources, latch);
    expect(m2.recenter).toBe(true);
    expect(m2.events).toEqual(["pause"]);
    // Held: no second edge.
    const m3 = mapFrame(sources, latch);
    expect(m3.recenter).toBe(false);
    expect(m3.events.length).toBe(0);
  });

  it("inject feeds remoteSample / remoteEvent with a STICK, never a tilt", () => {
    const samples: XrRemoteSample[] = [], events: string[] = [];
    const input: XrRemoteInput = { remoteSample: (s) => samples.push(s), remoteEvent: (k) => events.push(k) };
    inject(input, { sample: { roll: 0.5, thr: 0.2, brk: 0.1, held: 0 }, events: ["pause"] });
    expect(samples.length).toBe(1);
    expect(samples[0]?.steer).toBe(0.5);
    expect(samples[0] && "roll" in samples[0]).toBe(false);
    expect(samples[0]?.thr).toBe(0.2);
    expect(samples[0]?.source).toBe("xr");
    expect(events).toEqual(["pause"]);
    expect(inject(null, { sample: { roll: 0, thr: 0, brk: 0, held: 0 } })).toBe(false);
  });

  it("accepts a native indexed XRInputSourceArray without Array methods", () => {
    const right = { handedness: "right", gamepad: { buttons: buttons(0.8), axes: [0, 0, 0.6, 0] } };
    const left = { handedness: "left", gamepad: { buttons: buttons(0.3), axes: [0, 0, -0.4, 0] } };
    const sources: { [i: number]: XrInputSourceLike; length: number } = { 0: right, length: 1 };
    let mapped = mapFrame(sources, {});
    near(mapped.sample.thr, 0.8);
    expect(mapped.sample.roll as number).toBeGreaterThan(0);
    sources[1] = left;
    sources.length = 2;
    mapped = mapFrame(sources, {});
    near(mapped.sample.brk, 0.3);
    expect(mapped.sample.roll as number).toBeLessThan(0);
  });

  it("prefers only a usable left stick and otherwise accepts the right controller", () => {
    const right = { handedness: "right", targetRayMode: "tracked-pointer", gamepad: { axes: [0, 0, 0.8, 0], buttons: [] } };
    const expected = mapFrame([right]).sample.roll as number;
    expect(expected).toBeGreaterThan(0.7);
    for (const l of [
      { handedness: "left" },
      { handedness: "left", gamepad: { axes: [], buttons: [] } },
      { handedness: "left", gamepad: { axes: [0, 0, NaN], buttons: [] } },
      { handedness: "left", targetRayMode: "gaze", gamepad: { axes: [0, 0, -0.8], buttons: [] } },
    ]) {
      for (const sources of [[l, right], [right, l]]) expect(mapFrame(sources).sample.roll).toBe(expected);
    }
    const l = { handedness: "left", gamepad: { axes: [0, 0, -0.8], buttons: [] } };
    for (const sources of [[l, right], [right, l]]) expect(mapFrame(sources).sample.roll as number).toBeLessThan(-0.7);
    l.gamepad.axes[2] = 0;
    expect(mapFrame([right, l]).sample.roll).toBe(0);
  });

  it("overlay menu navigation is granted-only, edge-triggered and releases driving", () => {
    const src = [{ handedness: "left", gamepad: { axes: [0, 0, 0.8, 0], buttons: Array.from({ length: 6 }, () => ({ value: 1 })) } }];
    const latch = { primary: false, secondary: false };
    let m = mapFrame(src, latch, { menuOpen: true, overlay: true });
    expect(m.events).toEqual(["navSelect", "navBack", "navRight"]);
    expect(m.recenter).toBe(false);
    expect({ ...m.sample }).toEqual({ roll: 0, thr: 0, brk: 0, held: 0 });
    expect(mapFrame(src, latch, { menuOpen: true, overlay: true }).events.length).toBe(0);
    (src[0] as { gamepad: { axes: number[] } }).gamepad.axes[2] = 0;
    mapFrame(src, latch, { menuOpen: true, overlay: true });
    (src[0] as { gamepad: { axes: number[] } }).gamepad.axes[2] = -0.8;
    expect(mapFrame(src, latch, { menuOpen: true, overlay: true }).events).toEqual(["navLeft"]);
    m = mapFrame(src, null, { menuOpen: true, overlay: false });
    expect(m.events).toEqual(["pause"]);
    expect(m.recenter).toBe(true);
    expect(m.sample.brk).toBe(0);
  });

  it("vertical stick navigation picks up / down by the larger axis", () => {
    const src = [{ handedness: "left", gamepad: { axes: [0, 0, 0.3, -0.9], buttons: [] } }];
    expect(mapFrame(src, {}, { menuOpen: true, overlay: true }).events).toEqual(["navUp"]);
    (src[0] as { gamepad: { axes: number[] } }).gamepad.axes[3] = 0.9;
    expect(mapFrame(src, {}, { menuOpen: true, overlay: true }).events).toEqual(["navDown"]);
  });

  it("driving source choice preserves phone ownership and absent sticks do not claim steering", () => {
    let owner: string | null = "phone", samples = 0;
    let latest: Partial<XrRemoteSample> | null = { thr: 0.7, steer: 0.2 };
    const events: string[] = [];
    const input: XrRemoteInput = {
      remoteSample(s) { samples++; owner = s.source; latest = s; },
      remoteLost(source) { if (!source || source === owner) { owner = null; latest = null; } },
      remoteEvent(e) { events.push(e); },
    };
    const pad = { handedness: "right", targetRayMode: "tracked-pointer", gamepad: { axes: [0, 0, 0.5, 0], buttons: [{ value: 0.8 }, {}, {}, {}, {}, { value: 1 }] } };
    inject(input, mapFrame([pad], {}, { driving: false }));
    expect(owner).toBe("phone");
    expect(latest?.thr).toBe(0.7);
    expect(samples).toBe(0);
    expect(events).toEqual(["pause"]);
    inject(input, mapFrame([]));
    expect(owner).toBe("phone");
    inject(input, mapFrame([pad]));
    expect(owner).toBe("xr");
    expect(latest?.thr).toBe(0.8);
    expect(latest?.steer as number).toBeGreaterThan(0);
    inject(input, mapFrame([]));
    expect(owner).toBeNull();
    const noStick = { handedness: "right", gamepad: { axes: [], buttons: [{ value: 0.5 }] } };
    inject(input, mapFrame([noStick]));
    expect(latest?.thr).toBe(0.5);
    expect(Object.hasOwn(latest ?? {}, "steer")).toBe(false);
    expect(Object.hasOwn(latest ?? {}, "roll")).toBe(false);
  });

  it("buttons read `pressed` when no value is given; gaze sources are ignored", () => {
    const m = mapFrame([
      { handedness: "none", gamepad: { buttons: [{ pressed: true }], axes: [] } },
      { handedness: "right", targetRayMode: "gaze", gamepad: { buttons: [{ value: 0.2 }], axes: [] } },
    ]);
    expect(m.sample.thr).toBe(1);
    expect(m.sample.roll).toBeNull();
    expect(m.driving).toBe(true);
  });
});
