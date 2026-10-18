// Structural WebXR types: the parts of navigator.xr, XRSession, XRFrame and
// XRReferenceSpace the XR modules touch. They are structural (not the global
// @types/webxr names) so unit tests drive the modules with plain fakes, and the
// real browser objects satisfy them. Shapes follow the WebXR Device API as f1-game
// js/xr/xr-session.js:92-474 uses it.
import type { Mat4In } from "./mat4";
import type { XrInputSources } from "./input";
import type { RigidInit, XrViewport } from "./rig";

export type XrSessionMode = "immersive-vr";
export type XrVisibility = "visible" | "visible-blurred" | "hidden";

export interface XrEventTargetLike {
  addEventListener(type: string, fn: (ev: { target?: unknown }) => void): void;
  removeEventListener(type: string, fn: (ev: { target?: unknown }) => void): void;
}

export interface XrRigidTransformLike {
  readonly matrix: Mat4In;
}

export interface XrReferenceSpaceLike {
  getOffsetReferenceSpace(t: XrRigidTransformLike): XrReferenceSpaceLike;
  addEventListener?(type: "reset", fn: (ev: { target?: unknown }) => void): void;
  removeEventListener?(type: "reset", fn: (ev: { target?: unknown }) => void): void;
}

export interface XrViewLike {
  readonly transform?: { readonly matrix: Mat4In } | null;
  readonly projectionMatrix: Mat4In;
}

export interface XrViewerPoseLike {
  readonly transform?: { readonly matrix: Mat4In } | null;
  readonly views: ArrayLike<XrViewLike> & { length: number };
}

export interface XrFrameLike {
  getViewerPose(space: XrReferenceSpaceLike): XrViewerPoseLike | null | undefined;
}

/** A layer that hands out per-view viewports (XRWebGLLayer.getViewport). */
export interface XrViewportLayer {
  getViewport(view: XrViewLike): XrViewport | null | undefined;
}

export interface XrSessionInit {
  requiredFeatures: string[];
  optionalFeatures: string[];
  domOverlay?: { root: Element };
}

export type XrFrameCallback = (time: number, frame: XrFrameLike) => void;

export interface XrSessionLike extends XrEventTargetLike {
  readonly visibilityState?: XrVisibility | string | undefined;
  readonly enabledFeatures?: Iterable<string> | ArrayLike<string> | null | undefined;
  readonly inputSources?: XrInputSources | null | undefined;
  readonly domOverlayState?: unknown;
  requestReferenceSpace(type: string): Promise<XrReferenceSpaceLike>;
  requestAnimationFrame(cb: XrFrameCallback): number;
  cancelAnimationFrame(id: number): void;
  end(): Promise<unknown>;
}

export interface XrSystemLike {
  isSessionSupported?(mode: XrSessionMode): Promise<boolean> | boolean;
  requestSession(mode: XrSessionMode, init: XrSessionInit): Promise<XrSessionLike>;
}

/** `new XRRigidTransform(position, orientation)`. */
export type RigidTransformFactory = (init: RigidInit) => XrRigidTransformLike;

/** The page's navigator.xr, or null. */
export function navigatorXr(): XrSystemLike | null {
  try {
    const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { xr?: XrSystemLike });
    return (nav && nav.xr) || null;
  } catch {
    return null;
  }
}

/** The page's XRRigidTransform constructor as a factory, or null outside WebXR. */
export function browserRigidTransform(): RigidTransformFactory | null {
  const C = (globalThis as { XRRigidTransform?: new (p: RigidInit["position"], o: RigidInit["orientation"]) => XrRigidTransformLike })
    .XRRigidTransform;
  return C ? (init) => new C(init.position, init.orientation) : null;
}

/** typeof globalThis.XRGPUBinding !== "undefined" (xr-session.js:66-68). */
export function hasXrGpuBinding(): boolean {
  return typeof (globalThis as { XRGPUBinding?: unknown }).XRGPUBinding !== "undefined";
}
