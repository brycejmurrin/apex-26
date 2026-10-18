/**
 * src/xr/session.ts (XrSession) with src/xr/boot.ts (XrBoot) over fake WebXR. Ported
 * from the browser-independent session tests of f1-game tests/unit/xr-phase0.test.mjs
 * (the `xrHarness` block, :396-1055): the seated origin, recenter, window/XR clock
 * handoff, start dedupe and cancellation, stale reference/attach completions,
 * failures, input polling, the borrowed eye list, DOM overlay and origin reset.
 *
 * Skipped from xr-phase0.test.mjs:
 *  - the four "XR waiter ..." tests: they test f1-game's Playwright helper
 *    tests/helpers/iwer-install.mjs (waitXrFrames), not js/xr.
 *  - "vendor ships XRButton / VRButton / WebGLXRFallback and pinned IWER": f1-game's
 *    vendored three and IWER files; apex-26 takes three from npm and has no IWER yet.
 *  - "TLX late XR compatible/renderState completion ...": executes f1-game's
 *    js/render/three/tlx.js attach code; apex-26's renderer side is three's XRManager
 *    (ownership after a late attach is covered in xr-three-binding.test.ts).
 *  - "pinned IWER offset adapter restores standard rigid-transform ...": needs the
 *    vendored IWER runtime (a real-headset emulator).
 *  - "CamModes.setCamMode({persist:false}) skips store.write": f1-game
 *    js/camera/mode-switch.js (the shell lane's camera family).
 *  - "immersive cockpit blocks keyboard and latched look-back ...": f1-game
 *    js/camera/vantage.js (the shell lane's camera).
 *  - "mountUi on a flat session does not fetch LAZY_XR" and "XrBoot.ensureXr: a retry
 *    after a failed load ...": f1-game's ScriptLoader / ApexRoster lazy bundle. In
 *    apex-26 the shell dynamic-imports src/xr; wantXrBundle() is in xr-boot.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ident } from "../../src/xr/mat4";
import { invertRigidTo, type EyeFrame } from "../../src/xr/rig";
import { featureGranted, listEnabledFeatures, sessionInit, XrSession } from "../../src/xr/session";
import type { XrRemoteInput } from "../../src/xr/input";
import type { XrFrameLike } from "../../src/xr/types";
import { createFakeSession, deferred, pose, rigidTransform, xrHarness, type FakeSession, type FakeSpace } from "./xr-harness";

const near = (a: number, b: number, label = ""): void => {
  expect(Math.abs(a - b) < 1e-5, `${label}: ${a} != ${b}`).toBe(true);
};
const midpoint = (eyes: EyeFrame[]): number[] => (eyes[0] as EyeFrame).eye.map((v, i) => (v + ((eyes[1] as EyeFrame).eye[i] as number)) / 2);
const viewerMatrix = (frame: XrFrameLike, space: unknown): ArrayLike<number> => {
  const p = frame.getViewerPose(space as FakeSpace);
  if (!p || !p.transform) throw new Error("no pose");
  return p.transform.matrix;
};
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("xr session init (xr-phase0.test.mjs)", () => {
  it("sessionInit lists webgpu only when preferred; featureGranted reads enabledFeatures", () => {
    expect(sessionInit(false, null).optionalFeatures.includes("webgpu")).toBe(false);
    expect(sessionInit(true, null).optionalFeatures.includes("webgpu")).toBe(true);
    expect(featureGranted({ enabledFeatures: ["local-floor"] }, "webgpu")).toBe(false);
    expect(featureGranted({ enabledFeatures: ["local-floor", "webgpu"] }, "webgpu")).toBe(true);
    expect(featureGranted({ enabledFeatures: new Set(["webgpu"]) }, "webgpu")).toBe(true);
    expect(featureGranted({ enabledFeatures: { 0: "webgpu", length: 1 } }, "webgpu")).toBe(true);
    expect(featureGranted(null, "webgpu")).toBe(false);
    expect(listEnabledFeatures({ enabledFeatures: new Set(["a", "b"]) })).toEqual(["a", "b"]);
  });

  it("asks for DOM overlay only when a document root exists", () => {
    let root: Element | null = null;
    const s = new XrSession({ overlayRoot: () => root });
    expect(s.sessionInit(false).domOverlay).toBeUndefined();
    root = { tagName: "BODY" } as unknown as Element;
    const init = s.sessionInit(false);
    expect(init.domOverlay?.root).toBe(root);
    expect(init.optionalFeatures.includes("dom-overlay")).toBe(true);
  });
});

describe("xr session lifecycle (xr-phase0.test.mjs xrHarness)", () => {
  it("seated origin removes floor height and yaw, preserving stereo, pitch/roll and head movement", async () => {
    for (const useLocal of [false, true]) {
      const h = xrHarness({
        reference: (type, base) => (type === "local-floor" && useLocal ? Promise.reject(new Error("floor unavailable")) : Promise.resolve(base)),
      });
      const xr = h.session;
      const height = useLocal ? 0 : 1.65;
      h.physical(pose(3, height, -2, 0.7, 0.2, 0.1));
      xr.setAnchor([10, 0.82, 20], [0, 0, 1], [0, 1, 0]);
      await xr.start();
      h.fire();
      const eyes = xr.eyeFrames(null, h.frame()) as EyeFrame[];
      midpoint(eyes).forEach((v, i) => near(v, [10, 0.82, 20][i] as number, "seated midpoint"));
      near(Math.hypot(...(eyes[0] as EyeFrame).eye.map((v, i) => v - ((eyes[1] as EyeFrame).eye[i] as number))), 0.064, "IPD");
      // Centering cancels yaw only: the remaining pose is physical pitch and roll.
      const seated = Array.from(viewerMatrix(h.frame(), xr.getRefSpace()));
      const expected = pose(0, 0, 0, 0, 0.2, 0.1);
      seated.forEach((v, i) => near(v, expected[i] as number, `pose[${i}]`));
      const before = Array.from((eyes[0] as EyeFrame).view);
      expect(xr.recenter(h.frame())).toBe(true);
      expect(xr.recenter(h.frame())).toBe(true);
      Array.from(((xr.eyeFrames(null, h.frame()) as EyeFrame[])[0] as EyeFrame).view).forEach((v, i) => near(v, before[i] as number, "repeat recenter"));
      h.physical(pose(3.1, height + 0.2, -2.3, 0.9, 0.2, 0.1));
      const moved = midpoint(xr.eyeFrames(null, h.frame()) as EyeFrame[]);
      near(moved[1] as number, 1.02, "physical vertical movement retained");
      near(Math.hypot((moved[0] as number) - 10, (moved[2] as number) - 20), Math.hypot(0.1, 0.3), "physical lean retained");
      const turned = viewerMatrix(h.frame(), xr.getRefSpace());
      expect(Math.abs((turned[8] as number) - (seated[8] as number))).toBeGreaterThan(0.1);
      await xr.end();
    }
  });

  it("identity gaze remains car-forward across repeated recenter; unavailable pose waits for calibration", async () => {
    const h = xrHarness(), xr = h.session;
    xr.setAnchor([0, 0.82, 0], [0, 0, 1]);
    h.tracking(false);
    await xr.start();
    h.fire();
    expect(xr.eyeFrames(null, h.frame())).toBeNull();
    h.tracking(true);
    h.fire();
    for (let i = 0; i < 3; i++) {
      expect(xr.recenter(h.frame())).toBe(true);
      const eye = (xr.eyeFrames(null, h.frame()) as EyeFrame[])[0] as EyeFrame;
      const world = invertRigidTo(ident(), eye.view);
      near(-(world[10] as number), 1, "world gaze +Z");
      near(eye.eye[1], 0.82, "seat height");
    }
    expect(xr.getFrame()).toBeNull();
    await xr.end();
  });

  it("transition cancels the queued window tick and rejects stale callbacks across exit and re-entry", async () => {
    const h = xrHarness(), xr = h.session, boot = h.boot;
    boot.afterTick(h.tick);
    const staleWindow = h.windowHistory[0] as (t: number) => void;
    await xr.start();
    const first = h.sessions[0] as FakeSession;
    expect(h.windowCancelled.length).toBe(1);
    staleWindow(0);
    expect(h.stats().windowTicks).toBe(0);
    expect(boot.diag().windowPending).toBe(false);
    h.fire();
    expect(h.stats().xrTicks).toBe(1);
    expect(h.stats().cam).toBe(1); // forced to cockpit
    const staleXr = first.history.at(-1) as (t: number, f: XrFrameLike) => void;
    await xr.end();
    expect(first.frames.size).toBe(0);
    expect(first.cancelled.length).toBe(1);
    expect(h.windowQueue.size).toBe(1);
    expect(h.stats().cam).toBe(0);
    staleWindow(1);
    staleXr(1, h.frame());
    expect(h.stats().windowTicks).toBe(0);
    expect(h.stats().xrTicks).toBe(1);
    expect(boot.diag().windowPending).toBe(true);
    await xr.start();
    staleXr(2, h.frame());
    expect(h.stats().xrTicks).toBe(1);
    expect((h.sessions[1] as FakeSession).frames.size).toBe(1);
    await xr.end();
    const [id, fn] = h.windowQueue.entries().next().value as [number, (t: number) => void];
    h.windowQueue.delete(id);
    fn(3);
    expect(h.stats().windowTicks).toBe(1);
    expect(h.windowQueue.size).toBe(1);
  });

  it("end during frame processing neither reschedules XR nor duplicates the window clock", async () => {
    const h = xrHarness({ onFrame: (hh) => void hh.session.end() });
    await h.session.start();
    h.fire();
    expect((h.sessions[0] as FakeSession).frames.size).toBe(0);
    expect(h.session.isPresenting()).toBe(false);
    expect(h.windowQueue.size).toBe(1);
    expect(h.boot.loopByXr()).toBe(false);
  });

  it("start is deduped and cancellation while requestSession is pending closes the late session", async () => {
    const pending = deferred<FakeSession>();
    let create: (() => FakeSession) | null = null;
    const h = xrHarness({ request: (factory) => { create = factory; return pending.promise; } });
    await h.session.probe();
    const a = h.session.start(), b = h.session.start();
    expect(a).toBe(b);
    expect(h.stats().requestCount).toBe(1);
    await h.session.end();
    pending.resolve((create as unknown as () => FakeSession)());
    expect(await a).toBeNull();
    expect(h.stats().attachments).toBe(0);
    expect(h.session.getSession()).toBeNull();
    expect((h.sessions[0] as FakeSession).frames.size).toBe(0);
  });

  it("ended during pending reference or renderer attachment cannot resume presentation", async () => {
    for (const phase of ["reference", "attach"] as const) {
      const pending = deferred<FakeSpace>(), entered = deferred<FakeSpace | undefined>();
      const h = xrHarness(
        phase === "reference"
          ? { reference: (_type, base) => { entered.resolve(base); return pending.promise; } }
          : { attach: () => { entered.resolve(undefined); return pending.promise; } },
      );
      const started = h.session.start();
      const base = await entered.promise;
      await (h.sessions[0] as FakeSession).end(); // browser-initiated end
      pending.resolve(base as FakeSpace);
      expect(await started).toBeNull();
      expect(h.boot.loopByXr()).toBe(false);
      expect(h.session.getRefSpace()).toBeNull();
      expect((h.sessions[0] as FakeSession).frames.size).toBe(0);
      expect(h.stats().cam).toBe(0);
      expect(h.windowQueue.size).toBe(1);
      if (phase === "attach") expect(h.stats().detachments).toBe(2);
    }
  });

  for (const phase of ["reference", "attach"] as const)
    for (const outcome of ["resolve", "reject"] as const)
      for (const presenting of [false, true]) {
        it(`immediate retry survives stale ${phase} ${outcome} while replacement ${presenting ? "presents" : "starts"}`, async () => {
          const pending = deferred<FakeSpace>(), entered = deferred<FakeSpace | undefined>(), replacementAttach = deferred<void>();
          let references = 0, attachments = 0;
          const h = xrHarness({
            reference: (_type, base) => {
              if (phase === "reference" && references++ === 0) { entered.resolve(base); return pending.promise; }
              return Promise.resolve(base);
            },
            attach: () => {
              if (phase === "attach" && attachments++ === 0) { entered.resolve(undefined); return pending.promise; }
              return replacementAttach.promise;
            },
          });
          const xr = h.session, old = xr.start();
          const base = await entered.promise;
          await xr.end();
          const replacement = xr.start();
          expect(replacement).not.toBe(old);
          await flush();
          expect(h.stats().requestCount).toBe(2);
          const newer = h.sessions[1] as FakeSession, detachments = h.stats().detachments;
          if (presenting) { replacementAttach.resolve(); expect(await replacement).toBe(newer); }
          if (outcome === "reject") pending.reject(new Error("old startup failed"));
          else pending.resolve(base as FakeSpace);
          expect(await old).toBeNull();
          if (!presenting) expect(xr.start()).toBe(replacement);
          expect(xr.getSession()).toBe(newer);
          expect(h.stats().detachments).toBe(detachments);
          expect(xr.lastError()).toBeNull();
          replacementAttach.resolve();
          expect(await replacement).toBe(newer);
          expect(xr.isPresenting()).toBe(true);
          expect(newer.frames.size).toBe(1);
          h.fire(newer);
          expect(xr.frameCount()).toBe(1);
          await xr.end();
        });
      }

  it("reference, attachment and frame-request failures release ownership and keep one window loop", async () => {
    for (const options of [
      { reference: () => Promise.reject(new Error("no reference")) },
      { attach: () => Promise.reject(new Error("no layer")) },
      { rafFails: true },
    ]) {
      const h = xrHarness(options);
      h.boot.afterTick(h.tick);
      expect(await h.session.start()).toBeNull();
      expect(h.session.isPresenting()).toBe(false);
      expect(h.session.getSession()).toBeNull();
      expect(h.session.getRefSpace()).toBeNull();
      expect(h.boot.loopByXr()).toBe(false);
      expect(h.windowQueue.size).toBe(1);
      expect(h.stats().detachments).toBe(1);
      expect(h.stats().cam).toBe(0);
      expect(h.session.lastError()).toBeTruthy();
    }
  });

  it("an unbound session refuses to start with a bind error", async () => {
    const s = new XrSession({ xr: () => ({ isSessionSupported: async () => true, requestSession: () => Promise.reject(new Error("x")) }) });
    const errors: string[] = [];
    s.on((ev, d) => { if (ev === "error") errors.push(String(d.phase)); });
    expect(await s.start()).toBeNull();
    expect(errors).toEqual(["bind"]);
    const none = new XrSession({ xr: () => null });
    expect(await none.probe()).toBe(false);
    expect(await none.start()).toBeNull();
  });

  it("a failed WebGPU request falls back to WebGL2; a missing XRGPUBinding keeps WebGL2", async () => {
    const inits: string[][] = [];
    let fail = true;
    const xr = new XrSession({
      backendPref: () => "webgpu",
      hasXrGpuBinding: () => false,
      rigidTransform: () => rigidTransform,
      xr: () => ({
        isSessionSupported: async () => true,
        requestSession: async (_m, init) => {
          inits.push(init.optionalFeatures);
          if (fail) {
            fail = false;
            throw new Error("webgpu unsupported");
          }
          return createFakeSession();
        },
      }),
    });
    const infos: unknown[] = [];
    xr.bind({ attachSession: (_s, info) => { infos.push(info); } });
    expect(await xr.start()).toBeTruthy();
    expect(inits[0]?.includes("webgpu")).toBe(true);
    expect(inits[1]?.includes("webgpu")).toBe(false);
    expect(xr.backend()).toBe("webgl2");
    expect(infos).toEqual([{ backend: "webgl2", preferWebgpu: false, referenceSpaceType: "local-floor" }]);
    await xr.end();
    // Granted webgpu + XRGPUBinding: the session backend is webgpu.
    const gpu = new XrSession({
      backendPref: () => "webgpu",
      hasXrGpuBinding: () => true,
      xr: () => ({
        isSessionSupported: async () => true,
        requestSession: async () => Object.assign(createFakeSession(), { enabledFeatures: ["local-floor", "webgpu"] }),
      }),
    });
    gpu.bind({ attachSession: () => {} });
    expect(await gpu.start()).toBeTruthy();
    expect(gpu.backend()).toBe("webgpu");
    expect(gpu.enabledFeatures()).toEqual(["local-floor", "webgpu"]);
    await gpu.end();
  });

  it("input polling accepts a native indexed XRInputSourceArray and keeps one XR clock", async () => {
    const h = xrHarness();
    let samples = 0;
    h.input.current = { remoteSample() { samples++; }, remoteEvent() {} };
    const right = { handedness: "right", gamepad: { buttons: [{ value: 0.8 }], axes: [0, 0, 0.6, 0] } };
    const left = { handedness: "left", gamepad: { buttons: [{ value: 0.3 }], axes: [0, 0, -0.4, 0] } };
    await h.session.start();
    (h.sessions[0] as FakeSession).inputSources = { 0: right, 1: left, length: 2 };
    h.fire();
    expect(samples).toBe(1);
    expect(h.stats().xrTicks).toBe(1);
    expect((h.sessions[0] as FakeSession).frames.size).toBe(1);
    await h.session.end();
  });

  it("input injection failure releases controls and keeps rendering on one XR clock", async () => {
    const h = xrHarness();
    let lost = 0;
    h.input.current = { remoteSample() { throw new Error("input consumer failed"); }, remoteEvent() {}, remoteLost() { lost++; } };
    await h.session.start();
    h.fire();
    h.fire();
    expect(lost).toBe(2);
    expect(h.stats().xrTicks).toBe(2);
    expect((h.sessions[0] as FakeSession).frames.size).toBe(1);
    expect(h.session.getFrame()).toBeNull();
    expect(h.boot.loopByXr()).toBe(true);
    await h.session.end();
  });

  it("public recenter queues outside a frame, survives tracking loss, and applies on the next valid frame", async () => {
    const h = xrHarness(), xr = h.session;
    expect(xr.recenter()).toBe(false);
    await xr.start();
    h.fire();
    h.physical(pose(0.4, 1.85, -0.3, 0.7));
    expect(xr.getFrame()).toBeNull();
    const before = xr.getRefSpace();
    expect(xr.recenter()).toBe(true);
    expect(xr.getRefSpace()).toBe(before);
    h.tracking(false);
    h.fire();
    expect(xr.getRefSpace()).toBe(before);
    h.tracking(true);
    h.fire();
    const centered = viewerMatrix(h.frame(), xr.getRefSpace());
    near(centered[12] as number, 0);
    near(centered[13] as number, 0);
    near(centered[14] as number, 0);
    near(centered[8] as number, 0);
    near(centered[10] as number, 1);
    h.physical(pose(0.4, 1.95, -0.3, 0.7));
    h.fire();
    near(viewerMatrix(h.frame(), xr.getRefSpace())[13] as number, 0.1, "request consumed once");
    expect(xr.recenter()).toBe(true);
    await xr.end();
    h.physical(pose(0, 1.65, 0));
    await xr.start();
    h.fire();
    h.physical(pose(0, 1.85, 0));
    h.fire();
    near(viewerMatrix(h.frame(), xr.getRefSpace())[13] as number, 0.2, "pending request cleared at end");
    await xr.end();
  });

  it("A/X on a controller recenters from the live frame", async () => {
    const h = xrHarness(), xr = h.session;
    const recenters: number[] = [];
    xr.on((ev, _d) => { if (ev === "recenter") recenters.push(1); });
    await xr.start();
    h.fire();
    expect(recenters.length).toBe(1);
    (h.sessions[0] as FakeSession).inputSources = [{ handedness: "right", gamepad: { buttons: [{ value: 0 }, {}, {}, {}, { value: 1 }], axes: [] } }];
    h.input.current = { remoteSample() {}, remoteEvent() {} };
    h.physical(pose(1, 1.7, 1, 0.4));
    h.fire();
    // The edge queues a recenter (no frame inside pollInput); the next frame applies it.
    h.fire();
    expect(recenters.length).toBe(2);
    near(viewerMatrix(h.frame(), xr.getRefSpace())[12] as number, 0, "recentered x");
    await xr.end();
  });

  it("the eye list is borrowed and shrinks exactly for a mono frame", async () => {
    const h = xrHarness(), xr = h.session;
    await xr.start();
    h.fire();
    const eyes = xr.eyeFrames(null, h.frame()) as EyeFrame[];
    const left = eyes[0];
    const stereoFrame = h.frame();
    const mono: XrFrameLike = {
      getViewerPose(space) {
        const p = stereoFrame.getViewerPose(space);
        if (!p) return p;
        return { ...p, views: [p.views[0] as (typeof p.views)[0]] };
      },
    };
    expect(xr.eyeFrames(null, mono)).toBe(eyes);
    expect(eyes.length).toBe(1);
    expect(eyes[0]).toBe(left);
    expect(xr.eyeFrames(null, h.frame())).toBe(eyes);
    expect(eyes.length).toBe(2);
    expect(xr.eyeFrames({ getViewport: () => ({ x: 0, y: 0, width: 5, height: 6 }) }, h.frame())?.[1]?.viewport).toEqual({ x: 0, y: 0, width: 5, height: 6 });
    h.tracking(false);
    expect(xr.eyeFrames(null, h.frame())).toBeNull();
    await xr.end();
    expect(eyes.length).toBe(0);
  });

  it("nonidentity runtime reset waits for explicit recenter and cleans its base listener", async () => {
    const h = xrHarness(), xr = h.session;
    const lost: number[] = [];
    h.input.current = { remoteLost: () => lost.push(1), remoteSample() {}, remoteEvent() {} };
    await xr.start();
    h.fire();
    const base = (h.sessions[0] as FakeSession).base;
    const reset = pose(3, 0.4, -2, 0.8, 0.2, -0.1);
    base.origin = reset;
    const lostBeforeReset = lost.length;
    base.fireReset({ matrix: reset });
    expect(lost.length).toBe(lostBeforeReset + 1);
    expect(xr.eyeFrames(null, h.frame())).toBeNull();
    h.fire();
    expect(xr.eyeFrames(null, h.frame())).toBeNull();
    h.tracking(false);
    expect(xr.recenter()).toBe(true);
    h.fire();
    expect(xr.eyeFrames(null, h.frame())).toBeNull();
    h.tracking(true);
    h.fire();
    expect((xr.eyeFrames(null, h.frame()) as EyeFrame[]).length).toBe(2);
    const lostBeforeEnd = lost.length;
    await xr.end();
    expect(lost.length).toBe(lostBeforeEnd + 1);
    expect(base.events.has("reset")).toBe(false);
    base.fireReset();
    expect(lost.length).toBe(lostBeforeEnd + 1);
  });

  it("live session obeys the existing-controls choice and teardown preserves a newer phone sample", async () => {
    const h = xrHarness();
    let owner: string | null = "phone", samples = 0;
    h.inputMode.current = "existing";
    const input: XrRemoteInput = {
      remoteSample(s) { owner = s.source; samples++; },
      remoteLost(source) { if (source === owner) owner = null; },
      remoteEvent() {},
    };
    h.input.current = input;
    await h.session.start();
    (h.sessions[0] as FakeSession).inputSources = [{ handedness: "right", gamepad: { axes: [0, 0, 0.5, 0], buttons: [{ value: 0.5 }] } }];
    h.fire();
    expect(owner).toBe("phone");
    expect(samples).toBe(0);
    h.inputMode.current = "controllers";
    h.fire();
    expect(owner).toBe("xr");
    expect(samples).toBe(1);
    owner = "phone";
    await h.session.end();
    expect(owner).toBe("phone");
  });

  it("a hidden or blurred session stops driving but still delivers frames", async () => {
    const h = xrHarness();
    const seen: string[] = [];
    h.input.current = { remoteSample() { seen.push("sample"); }, remoteEvent() {}, remoteLost() { seen.push("lost"); } };
    await h.session.start();
    const s = h.sessions[0] as FakeSession;
    s.inputSources = [{ handedness: "right", gamepad: { axes: [], buttons: [{ value: 1 }] } }];
    s.visibilityState = "visible-blurred";
    s.fire("visibilitychange");
    expect(h.session.isVisible()).toBe(true);
    h.fire();
    expect(seen).toEqual(["lost", "lost"]); // the boot listener, then the frame
    s.visibilityState = "hidden";
    s.fire("visibilitychange");
    expect(h.session.isVisible()).toBe(false);
    await h.session.end();
  });
});
