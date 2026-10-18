// The renderer side of XR on three's WebGPURenderer.xr (XRManager). New for apex-26:
// f1-game drove its own XRWebGLLayer and per-eye GL passes (js/render/three/tlx.js
// attachXrSession / presentXR; docs/notes/XR-PHASE0-ARCHITECTURE.md "Session / eyes");
// apex-26 renders through three, so three's XRManager owns the layer, the per-eye
// ArrayCamera and the union cull frustum (its setProjectionFromUnion is what
// f1-game's XrRig.unionViewProjTo reimplemented).
//
// What this file maps onto three:
//  - attachXrSession -> renderer.setAnimationLoop(trampoline) then
//    renderer.xr.setSession(session). three captures the animation loop when the
//    session starts and calls it from ITS session rAF after updating the eye
//    cameras, so the session owner (./session.ts) runs on that one chain through
//    `clock` instead of a second session.requestAnimationFrame (two waiters on one
//    session interfere under IWER, XR-PHASE0-ARCHITECTURE.md).
//  - the seated rig -> the camera is parented under `rig` while presenting; three
//    composes each eye as rig.matrixWorld * viewPose (XRManager updateCamera), and
//    rig's matrix is worldFromAnchorTo(anchor) (./rig.ts), f1-game's composeEye basis.
//  - recenter -> renderer.xr.setReferenceSpace(owner.getRefSpace()).
//
// The flat game must keep its own window rAF loop through XrBoot.afterTick() and
// must NOT use renderer.setAnimationLoop: attaching replaces that loop.
import { Object3D, type Camera } from "three/webgpu";
import type { BackendName } from "../render/backend";
import type { XrGfx } from "./boot";
import { worldFromAnchorTo, type XrAnchor } from "./rig";
import type { XrAttachInfo, XrFrameClock, XrSession } from "./session";
import { hasXrGpuBinding, type XrFrameCallback, type XrFrameLike, type XrReferenceSpaceLike, type XrSessionLike } from "./types";

/** The parts of three's XRManager used here (three/src/renderers/common/XRManager.js). */
export interface XrManagerLike {
  enabled: boolean;
  readonly isPresenting: boolean;
  setSession(session: XrSessionLike): Promise<void>;
  setReferenceSpaceType(type: "local" | "local-floor"): void;
  setReferenceSpace(space: XrReferenceSpaceLike): void;
  getFoveation(): number | undefined;
  setFoveation(foveation: number): void;
}

/** The parts of WebGPURenderer used here. */
export interface XrThreeRenderer {
  readonly xr: XrManagerLike;
  setAnimationLoop(callback: ((time: number, frame?: XrFrameLike) => void) | null): Promise<void> | void;
}

/**
 * What the render lane hands XR: src/render/renderer.ts TrackRenderer has these
 * three members. TODO(lane-render): while `renderer.xr.isPresenting`,
 * TrackRenderer.renderFrame() must render `scene` with `camera` directly
 * (renderer.render) instead of the post pipeline (f1-game forced post off in
 * presentXR), and resize() must be a no-op (the XR layer owns the drawing buffer).
 */
export interface XrRenderHost {
  readonly renderer: XrThreeRenderer | null;
  readonly camera: Camera;
  readonly backend: BackendName | null;
}

export interface ThreeXrGfxDeps {
  /** a26.xrBackend is "webgpu" (XrOpts.xrBackend). */
  preferWebgpu?: () => boolean;
  hasXrGpuBinding?: () => boolean;
  /** A WebGPU renderer met a session without the `webgpu` feature (ApexXr.noteFallback). */
  onFallback?: (from: string, to: string, reason: string) => void;
}

export interface ThreeXrGfx extends XrGfx {
  /** The camera's parent while presenting: its matrix is the seated anchor. */
  readonly rig: Object3D;
  readonly clock: XrFrameClock;
}

/**
 * The XrGfx for XrBoot.bind({ gfx }) on a three renderer host.
 * TODO(lane-shell): `createThreeXrGfx(trackRenderer, xrSession, { preferWebgpu: () => opts.xrBackend() === "webgpu", onFallback: (a, b, r) => apexXr.noteFallback(a, b, r) })`.
 */
export function createThreeXrGfx(host: XrRenderHost, owner: XrSession, deps: ThreeXrGfxDeps = {}): ThreeXrGfx {
  const rig = new Object3D();
  rig.name = "xr-rig";
  rig.matrixAutoUpdate = false;
  const anchorMatrix = new Float32Array(16);
  let attached: XrSessionLike | null = null;
  let token = 0;
  let pending: XrFrameCallback | null = null;
  let pendingId = 0;
  let nextId = 0;
  let space: XrReferenceSpaceLike | null = null;

  const clock: XrFrameClock = {
    request: (_s, cb) => {
      pending = cb;
      pendingId = ++nextId;
      return pendingId;
    },
    cancel: (_s, id) => {
      if (id === pendingId) pending = null;
    },
  };

  const syncSpace = (): void => {
    const r = host.renderer;
    const s = owner.getRefSpace();
    if (r && s && s !== space) {
      space = s;
      r.xr.setReferenceSpace(s);
    }
  };

  // three calls this from its XR session rAF after posing the eye cameras; after
  // the session ends three restores it onto the window clock, where it removes itself.
  const trampoline = (time: number, frame?: XrFrameLike): void => {
    const r = host.renderer;
    if (!r) return;
    if (!r.xr.isPresenting || !attached) {
      if (!attached) void r.setAnimationLoop(null);
      return;
    }
    if (!frame) return;
    syncSpace();
    const cb = pending;
    pending = null;
    if (cb) cb(time, frame);
  };

  const canWebgpu = (): boolean => (deps.hasXrGpuBinding ?? hasXrGpuBinding)() && !!deps.preferWebgpu?.();

  return {
    rig,
    clock,
    xrCapable: () => {
      if (!host.renderer) return false;
      if (host.backend === "WebGL2") return true;
      return host.backend === "WebGPU" && canWebgpu();
    },
    async attachXrSession(session: XrSessionLike, info: XrAttachInfo): Promise<unknown> {
      const r = host.renderer;
      if (!r) throw new Error("renderer not initialised");
      if (host.backend === "WebGPU" && info.backend !== "webgpu") {
        deps.onFallback?.("webgpu", "webgl2", "session.enabledFeatures lacked webgpu");
        throw new Error("WebGPU renderer needs the webgpu XR feature; reload on WebGL2");
      }
      const mine = ++token;
      attached = session;
      space = null;
      pending = null;
      const cam = host.camera;
      if (cam.parent !== rig) rig.add(cam);
      r.xr.enabled = true;
      // three requests its own base space in setSession; ask for the one the owner got.
      r.xr.setReferenceSpaceType(info.referenceSpaceType);
      const s = owner.getRefSpace();
      if (s) {
        space = s;
        r.xr.setReferenceSpace(s);
      }
      // Set the loop first: setSession captures it synchronously (renderer initialised).
      await r.setAnimationLoop(trampoline);
      if (mine !== token) return null;
      await r.xr.setSession(session);
      if (mine !== token) return null; // detached while three attached
      return session;
    },
    detachXrSession: () => {
      token++;
      attached = null;
      pending = null;
      space = null;
      const r = host.renderer;
      if (r) r.xr.enabled = false;
      const cam = host.camera;
      if (cam.parent === rig) rig.remove(cam);
    },
    setXrAnchor: (anchor: XrAnchor) => {
      worldFromAnchorTo(anchorMatrix, anchor.eye, anchor.fwd, anchor.up || [0, 1, 0]);
      rig.matrix.fromArray(anchorMatrix);
      rig.updateMatrixWorld(true);
    },
    xrLayer: () => null,
    xrInfo: () => ({ backend: host.backend, presenting: !!host.renderer?.xr.isPresenting }),
    getFoveation: () => host.renderer?.xr.getFoveation() ?? null,
    setFoveation: (v: number) => {
      const r = host.renderer;
      if (!r) return false;
      r.xr.setFoveation(v);
      return true;
    },
  };
}
