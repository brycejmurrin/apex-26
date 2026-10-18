/**
 * src/xr/three-binding.ts: XR on three's WebGPURenderer.xr (new for apex-26; f1-game
 * drove its own XRWebGLLayer in js/render/three/tlx.js). A fake renderer models the
 * parts of three/src/renderers/common/XRManager.js the binding relies on: setSession
 * captures the animation loop synchronously and calls it from the session rAF after
 * posing the cameras, and the session's end restores that loop on the window clock.
 * The real XrSession + XrBoot drive it.
 */
import { PerspectiveCamera } from "three/webgpu";
import { describe, expect, it } from "vitest";
import type { TrackRenderer } from "../../src/render/renderer";
import { XrBoot } from "../../src/xr/boot";
import { XrSession } from "../../src/xr/session";
import { createThreeXrGfx, type XrRenderHost, type XrThreeRenderer } from "../../src/xr/three-binding";
import type { XrFrameLike, XrReferenceSpaceLike, XrSessionLike, XrSystemLike } from "../../src/xr/types";
import { createFakeSession, deferred, MemStorage, rigidTransform, type FakeSession } from "./xr-harness";

// Compile-time: the render lane's TrackRenderer is a valid XR host as it stands, and
// the browser's WebXR objects satisfy the structural types.
const _hostCheck = (r: TrackRenderer): XrRenderHost => r;
const _sessionCheck = (s: XRSession): XrSessionLike => s;
const _systemCheck = (s: XRSystem): XrSystemLike => s;
void _hostCheck, _sessionCheck, _systemCheck;

type Loop = ((t: number, f?: XrFrameLike) => void) | null;

class FakeThree implements XrThreeRenderer {
  loop: Loop = null;
  context: "window" | "session" = "window";
  setSessionGate: Promise<void> | null = null;
  calls: string[] = [];
  readonly xr = {
    enabled: false,
    isPresenting: false,
    session: null as XrSessionLike | null,
    space: null as XrReferenceSpaceLike | null,
    type: "local-floor",
    foveation: 1,
    captured: null as Loop,
    setSession: async (session: XrSessionLike): Promise<void> => {
      // Synchronous part: capture the user loop (XRManager.js:1216-1218).
      this.xr.captured = this.loop;
      this.xr.session = session;
      this.calls.push("setSession");
      session.addEventListener("end", () => {
        this.xr.isPresenting = false;
        this.loop = this.xr.captured;
        this.context = "window";
      });
      if (this.setSessionGate) await this.setSessionGate;
      this.context = "session";
      this.xr.isPresenting = true;
    },
    setReferenceSpaceType: (t: "local" | "local-floor") => { this.xr.type = t; },
    setReferenceSpace: (s: XrReferenceSpaceLike) => { this.xr.space = s; this.calls.push("space"); },
    getFoveation: () => this.xr.foveation,
    setFoveation: (v: number) => { this.xr.foveation = v; },
  };
  setAnimationLoop(cb: Loop): void {
    this.loop = cb;
    this.calls.push(cb ? "loop" : "loop:null");
  }
  /** One XR frame: three's onAnimationFrame posing then calling the captured loop. */
  xrFrame(frame: XrFrameLike): void {
    if (this.context === "session" && this.xr.captured) this.xr.captured(16, frame);
  }
  windowFrame(): void {
    if (this.context === "window" && this.loop) this.loop(16);
  }
}

const frame: XrFrameLike = {
  getViewerPose: () => ({ transform: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1]) }, views: [] }),
};

function setup(backend: "WebGL2" | "WebGPU" = "WebGL2", opts: { xrgpu?: boolean; prefer?: boolean } = {}) {
  const three = new FakeThree();
  const camera = new PerspectiveCamera();
  const host = { renderer: three as XrThreeRenderer | null, camera, backend };
  const fakes: FakeSession[] = [];
  const session = new XrSession({
    xr: () => ({ isSessionSupported: async () => true, requestSession: async () => { const s = createFakeSession(); fakes.push(s); return s; } }),
    rigidTransform: () => rigidTransform,
    backendPref: () => (opts.prefer ? "webgpu" : "webgl2"),
    hasXrGpuBinding: () => !!opts.xrgpu,
  });
  const fallbacks: string[] = [];
  const gfx = createThreeXrGfx(host, session, {
    preferWebgpu: () => !!opts.prefer,
    hasXrGpuBinding: () => !!opts.xrgpu,
    onFallback: (_a, _b, r) => fallbacks.push(r),
  });
  const boot = new XrBoot({ session, storage: () => new MemStorage(), raf: () => 1, cancelRaf: () => {} });
  let ticks = 0;
  boot.bind({ gfx, tickBody: () => ticks++, windowTick: () => {}, getCamMode: () => 0, setCamMode: () => {} });
  return { three, camera, host, session, gfx, boot, fakes, fallbacks, ticks: () => ticks };
}

describe("three XR binding", () => {
  it("xrCapable: WebGL2 always; WebGPU only with XRGPUBinding and the webgpu preference", () => {
    expect(setup("WebGL2").gfx.xrCapable()).toBe(true);
    expect(setup("WebGPU").gfx.xrCapable()).toBe(false);
    expect(setup("WebGPU", { xrgpu: true }).gfx.xrCapable()).toBe(false);
    expect(setup("WebGPU", { xrgpu: true, prefer: true }).gfx.xrCapable()).toBe(true);
    const h = setup();
    h.host.renderer = null;
    expect(h.gfx.xrCapable()).toBe(false);
  });

  it("attach sets the loop before setSession, parents the camera under the rig, and runs ONE clock", async () => {
    const h = setup();
    expect(await h.session.start()).toBeTruthy();
    expect(h.three.calls.slice(0, 3)).toEqual(["space", "loop", "setSession"]);
    expect(h.three.xr.enabled).toBe(true);
    expect(h.three.xr.type).toBe("local-floor");
    expect(h.camera.parent).toBe(h.gfx.rig);
    expect(h.boot.loopByXr()).toBe(true);
    // The owner did not schedule its own session rAF: three's chain drives it.
    expect((h.fakes[0] as FakeSession).frames.size).toBe(0);
    h.three.xrFrame(frame);
    h.three.xrFrame(frame);
    expect(h.ticks()).toBe(2);
    expect(h.session.frameCount()).toBe(2);
    // The first frame recentered: three now poses against the seated space.
    expect(h.three.xr.space).toBe(h.session.getRefSpace());
    expect(h.three.xr.space).not.toBe((h.fakes[0] as FakeSession).base);
  });

  it("seat() moves the rig to the cockpit anchor (worldFromAnchorTo)", async () => {
    const h = setup();
    await h.session.start();
    h.boot.seat([10, 0.8, 20], [10, 0.8, 21]);
    const m = h.gfx.rig.matrixWorld.elements;
    expect([m[12], m[13], m[14]]).toEqual([10, expect.closeTo(0.8, 6), 20]);
    expect(m[10]).toBeCloseTo(-1, 6); // camera -Z looks down +Z (the car's forward)
    const w = h.camera.matrixWorld.elements;
    expect(w[12]).toBeCloseTo(10 + h.camera.position.x, 5);
  });

  it("end detaches: the camera leaves the rig and the restored loop removes itself on the window clock", async () => {
    const h = setup();
    await h.session.start();
    h.three.xrFrame(frame);
    await h.session.end();
    expect(h.camera.parent).toBeNull();
    expect(h.three.xr.enabled).toBe(false);
    expect(h.boot.loopByXr()).toBe(false);
    expect(h.three.loop).not.toBeNull(); // three put our trampoline back
    h.three.windowFrame();
    expect(h.three.loop).toBeNull();
    expect(h.ticks()).toBe(1);
  });

  it("a WebGPU renderer without the granted webgpu feature refuses and notes the fallback", async () => {
    const h = setup("WebGPU", { xrgpu: true, prefer: true });
    expect(await h.session.start()).toBeNull(); // the fake session grants no webgpu
    expect(h.fallbacks).toEqual(["session.enabledFeatures lacked webgpu"]);
    expect(h.camera.parent).toBeNull();
    expect(String(h.session.lastError())).toMatch(/webgpu XR feature/);
  });

  it("a detach while three is still attaching cannot adopt the old session", async () => {
    const h = setup();
    const gate = deferred<void>();
    h.three.setSessionGate = gate.promise;
    const started = h.session.start();
    await new Promise((r) => setImmediate(r));
    expect(h.three.calls).toContain("setSession");
    await h.session.end();
    gate.resolve();
    expect(await started).toBeNull();
    expect(h.camera.parent).toBeNull();
    h.three.xrFrame(frame);
    expect(h.ticks()).toBe(0);
  });

  it("foveation and info pass through to renderer.xr", () => {
    const h = setup();
    expect(h.boot.setFoveation(0.5)).toBe(true);
    expect(h.gfx.getFoveation?.()).toBe(0.5);
    expect(h.boot.diag()).toMatchObject({ foveation: 0.5, layer: false, draw: { backend: "WebGL2", presenting: false } });
  });
});
