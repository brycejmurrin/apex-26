// The WebXR immersive-vr session owner. Ported from f1-game js/xr/xr-session.js:1-485
// (XrSession): capability probe, session start / end / visibility, the XR frame loop
// (window.rAF is unreliable inside an immersive session), seated reference-space
// recenter, controller polling, and the per-eye view list.
//
// Everything outside the session is injected (XrSessionDeps): navigator.xr, the
// XRRigidTransform constructor, the DOM-overlay root, the input lane and the menu
// state, so tests drive it with fakes. The renderer binding (XrSessionBindings) is
// bound by ./boot.ts; on three it is ./three-binding.ts, which also supplies the
// frame clock so three's XRManager and this owner share ONE session rAF chain.
//
// WebGL2 is the default VR path. WebGPU XR is opt-in (a26.xrBackend=webgpu). Quest
// Browser can expose `XRGPUBinding` where WebGPU-in-XR is unsupported (three.js
// #33497), so the decision is the requested `webgpu` feature as granted in
// `session.enabledFeatures`, with WebGL2 as the fallback.
import { inject, mapFrame, type XrInputLatch, type XrRemoteInput } from "./input";
import { ident, type Mat4 } from "./mat4";
import type { XrInputMode } from "./opts";
import type { XrBackendPref } from "./plan";
import { composeEye, invertRigidTo, makeEyeFrame, recenterOffsetFromPose, type EyeFrame, type RigidInit, type Vec3, type Vec3In } from "./rig";
import {
  browserRigidTransform,
  hasXrGpuBinding,
  navigatorXr,
  type RigidTransformFactory,
  type XrFrameCallback,
  type XrFrameLike,
  type XrReferenceSpaceLike,
  type XrSessionInit,
  type XrSessionLike,
  type XrSystemLike,
  type XrViewportLayer,
} from "./types";

export const MODE = "immersive-vr";

export type XrSessionBackend = "webgl2" | "webgpu";

export interface XrAttachInfo {
  backend: XrSessionBackend;
  preferWebgpu: boolean;
  /** The base space the owner obtained ("local-floor", else "local"); apex-26 addition. */
  referenceSpaceType: "local-floor" | "local";
}

/** Schedules XR frames on a session; the default is session.requestAnimationFrame. */
export interface XrFrameClock {
  request(session: XrSessionLike, cb: XrFrameCallback): number;
  cancel(session: XrSessionLike, id: number): void;
}

/** The renderer side (f1-game XrBoot.bind's object, xr-boot.js:200-232). */
export interface XrSessionBindings {
  /** Hand the session to the renderer. Rejecting ends the session (phase "attachSession"). */
  attachSession(session: XrSessionLike, info: XrAttachInfo): Promise<unknown> | unknown;
  detachSession?(): void;
  onStart?(info: { backend: XrSessionBackend }): void;
  onEnd?(): void;
  onFrame?(time: number, frame: XrFrameLike): void;
  /** Replaces session.requestAnimationFrame (three's XRManager owns that chain). */
  clock?: XrFrameClock;
}

export interface XrSessionEvents {
  capability: { supported: boolean; reason?: string; error?: string };
  error: { error: unknown; phase?: string };
  start: { backend: XrSessionBackend; features: string[] };
  recenter: RigidInit;
  end: Record<string, never>;
  reset: { recenterRequired: true };
  visibility: { visible: boolean; state: string };
}
export type XrSessionEvent = { [K in keyof XrSessionEvents]: [ev: K, detail: XrSessionEvents[K]] }[keyof XrSessionEvents];
export type XrSessionListener = (...args: XrSessionEvent) => void;

export type XrLog = (level: "info" | "warn", msg: string) => void;

export interface XrSessionDeps {
  /** navigator.xr. */
  xr?: () => XrSystemLike | null | undefined;
  /** a26.xrBackend (XrOpts.xrBackend). Default "webgl2". */
  backendPref?: () => XrBackendPref;
  /** new XRRigidTransform(...). */
  rigidTransform?: () => RigidTransformFactory | null;
  /** The DOM-overlay root (document.body); null = no overlay requested. */
  overlayRoot?: () => Element | null | undefined;
  /** typeof XRGPUBinding !== "undefined". */
  hasXrGpuBinding?: () => boolean;
  /** The game's remote input lane. TODO(lane-shell): src/input. */
  input?: () => XrRemoteInput | null | undefined;
  /** VR DRIVING (XrOpts.xrInput), read every frame. Default "controllers". */
  inputMode?: () => XrInputMode;
  /** A navigable menu is open (f1-game UiLayers.navOpen). TODO(lane-shell). */
  menuOpen?: () => boolean;
  log?: XrLog;
}

/** xr-session.js:70-80: true when session.enabledFeatures grants `name` (FrozenArray or Set). */
export function featureGranted(session: { enabledFeatures?: unknown } | null | undefined, name: string): boolean {
  const f = session && (session.enabledFeatures as { has?: unknown; includes?: unknown; length?: number } | null | undefined);
  if (!f) return false;
  if (typeof f.has === "function") return !!(f as { has(n: string): boolean }).has(name);
  if (typeof f.includes === "function") return (f as { includes(n: string): boolean }).includes(name);
  try {
    const a = f as ArrayLike<unknown>;
    for (let i = 0; i < a.length; i++) if (a[i] === name) return true;
  } catch {
    /* not indexable */
  }
  return false;
}

/** xr-session.js:82-90 */
export function listEnabledFeatures(session: { enabledFeatures?: unknown } | null | undefined): string[] {
  const f = session && session.enabledFeatures;
  if (!f) return [];
  try {
    return Array.from(f as Iterable<string> | ArrayLike<string>);
  } catch {
    const out: string[] = [];
    try {
      const a = f as ArrayLike<string>;
      for (let i = 0; i < a.length; i++) out.push(a[i] as string);
    } catch {
      /* */
    }
    return out;
  }
}

/** xr-session.js:136-146: optional features; `webgpu` only when preferred, DOM overlay only with a root. */
export function sessionInit(preferWebgpu: boolean, overlayRoot: Element | null | undefined): XrSessionInit {
  const optional = ["local-floor", "bounded-floor", "layers"];
  if (overlayRoot) optional.push("dom-overlay");
  if (preferWebgpu) optional.push("webgpu");
  return {
    ...(overlayRoot ? { domOverlay: { root: overlayRoot } } : {}),
    requiredFeatures: [],
    optionalFeatures: optional,
  };
}

const sessionClock: XrFrameClock = {
  request: (s, cb) => s.requestAnimationFrame(cb),
  cancel: (s, id) => s.cancelAnimationFrame(id),
};

function browserOverlayRoot(): Element | null {
  return typeof document !== "undefined" ? document.body : null;
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class XrSession {
  readonly MODE = MODE;
  private _supported = false;
  private _probed = false;
  private _session: XrSessionLike | null = null;
  private _startPromise: Promise<XrSessionLike | null> | null = null;
  private _generation = 0;
  private _xrRequest: number | null = null;
  private _clock: XrFrameClock = sessionClock;
  private _centered = false;
  private _recenterPending = false;
  private _refSpace: XrReferenceSpaceLike | null = null;
  private _baseRefSpace: XrReferenceSpaceLike | null = null;
  private _xrFrame: XrFrameLike | null = null;
  private _xrTime = 0;
  private _xrFrameCount = 0;
  private _running = false;
  private _visible = true;
  private _backend: XrSessionBackend = "webgl2";
  private _enabledFeatures: string[] = [];
  private _bindings: XrSessionBindings | null = null;
  private _inputLatch: XrInputLatch = { primary: false, secondary: false };
  private readonly _anchor: { eye: Vec3; fwd: Vec3; up: Vec3 } = { eye: [0, 1.2, 0], fwd: [0, 0, 1], up: [0, 1, 0] };
  private readonly _eyeFrames: EyeFrame[] = []; // borrowed until the next eyeFrames call
  private _resetPending = false; // explicit recenter required after origin loss
  private _eyeBags: EyeFrame[] | null = null;
  private _viewScratch: Mat4[] = [];
  private _lastError: unknown = null;
  private _listeners: XrSessionListener[] = [];
  private readonly deps: XrSessionDeps;

  constructor(deps: XrSessionDeps = {}) {
    this.deps = deps;
  }

  private log(level: "info" | "warn", msg: string): void {
    try {
      this.deps.log?.(level, msg);
    } catch {
      /* logging is optional */
    }
  }

  private emit(...args: XrSessionEvent): void {
    for (const fn of this._listeners.slice()) {
      try {
        fn(...args);
      } catch {
        /* UI must not break the session */
      }
    }
  }

  /** Subscribe; returns the unsubscribe. */
  on(fn: XrSessionListener): () => void {
    if (typeof fn === "function") this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter((f) => f !== fn);
    };
  }

  /** a26.xrBackend, lower-cased (xr-session.js:60-64). */
  xrBackendPref(): XrBackendPref {
    try {
      return this.deps.backendPref ? this.deps.backendPref() : "webgl2";
    } catch {
      return "webgl2";
    }
  }

  webgpuXrAvailable(): boolean {
    return (this.deps.hasXrGpuBinding ?? hasXrGpuBinding)();
  }

  private xrSystem(): XrSystemLike | null {
    return (this.deps.xr ?? navigatorXr)() || null;
  }

  /** The DOM-overlay session init (pure; see sessionInit()). */
  sessionInit(preferWebgpu: boolean): XrSessionInit {
    return sessionInit(preferWebgpu, (this.deps.overlayRoot ?? browserOverlayRoot)());
  }

  /** xr-session.js:92-109 */
  async probe(): Promise<boolean> {
    this._probed = true;
    this._supported = false;
    const xr = this.xrSystem();
    if (!xr || !xr.isSessionSupported) {
      this.emit("capability", { supported: false, reason: "no-navigator-xr" });
      return false;
    }
    try {
      this._supported = !!(await xr.isSessionSupported(MODE));
    } catch (e) {
      this._lastError = e;
      this._supported = false;
      this.emit("capability", { supported: false, reason: "isSessionSupported-threw", error: errMessage(e) });
      return false;
    }
    this.emit("capability", { supported: this._supported });
    return this._supported;
  }

  isSupported(): boolean { return this._supported; }
  isProbed(): boolean { return this._probed; }
  isPresenting(): boolean { return !!this._session && this._running; }
  isVisible(): boolean { return this._visible; }
  lastError(): unknown { return this._lastError; }
  backend(): XrSessionBackend { return this._backend; }
  enabledFeatures(): string[] { return this._enabledFeatures.slice(); }
  frameCount(): number { return this._xrFrameCount; }
  /** The XRFrame of the running callback; null outside it (poses expire). */
  getFrame(): XrFrameLike | null { return this._xrFrame; }
  getTime(): number { return this._xrTime; }
  getSession(): XrSessionLike | null { return this._session; }
  /** The seated (recentered) reference space. */
  getRefSpace(): XrReferenceSpaceLike | null { return this._refSpace; }

  bind(api: XrSessionBindings | null): void {
    this._bindings = api || null;
  }

  /** The seated cockpit anchor (world eye, look direction, up). */
  setAnchor(eye?: Vec3In | null, fwd?: Vec3In | null, up?: Vec3In | null): void {
    const a = this._anchor;
    if (eye) { a.eye[0] = eye[0] as number; a.eye[1] = eye[1] as number; a.eye[2] = eye[2] as number; }
    if (fwd) { a.fwd[0] = fwd[0] as number; a.fwd[1] = fwd[1] as number; a.fwd[2] = fwd[2] as number; }
    if (up) { a.up[0] = up[0] as number; a.up[1] = up[1] as number; a.up[2] = up[2] as number; }
  }

  getAnchor(): { readonly eye: Vec3; readonly fwd: Vec3; readonly up: Vec3 } {
    return this._anchor;
  }

  /** Drop the XR input lane's sample (best effort). */
  releaseInput(): void {
    try {
      this.deps.input?.()?.remoteLost?.("xr");
    } catch {
      /* input teardown is best-effort */
    }
  }

  /** xr-session.js:148-157: deduped; a second call while starting returns the same promise. */
  start(): Promise<XrSessionLike | null> {
    if (this._startPromise) return this._startPromise;
    if (this._session) return Promise.resolve(this._session);
    const generation = ++this._generation;
    const pending: Promise<XrSessionLike | null> = this.startSession(generation).finally(() => {
      if (this._startPromise === pending) this._startPromise = null;
    });
    this._startPromise = pending;
    return pending;
  }

  private live(session: XrSessionLike, generation: number): boolean {
    return this._session === session && generation === this._generation;
  }

  /** xr-session.js:159-318 */
  private async startSession(generation: number): Promise<XrSessionLike | null> {
    if (!this._probed) await this.probe();
    if (generation !== this._generation) return null;
    if (!this._supported) {
      this._lastError = new Error("immersive-vr not supported");
      this.emit("error", { error: this._lastError });
      return null;
    }
    // Without a renderer binding there is no base layer, so runtimes deliver zero frames.
    if (!this._bindings || typeof this._bindings.attachSession !== "function") {
      this._lastError = new Error("XR not bound to a renderer (XrBoot.bind pending)");
      this.emit("error", { error: this._lastError, phase: "bind" });
      return null;
    }
    const xr = this.xrSystem();
    if (!xr) {
      this._lastError = new Error("navigator.xr missing");
      this.emit("error", { error: this._lastError, phase: "requestSession" });
      return null;
    }
    // Opt-in preference only: do NOT gate on typeof XRGPUBinding. Request the
    // feature, then trust session.enabledFeatures. A granted WebGPU XR session uses
    // clip depth [0,1]; three's XRManager handles that on its WebGPU backend.
    let preferGpu = this.xrBackendPref() === "webgpu";
    let session: XrSessionLike;
    try {
      session = await xr.requestSession(MODE, this.sessionInit(preferGpu));
    } catch (e) {
      if (generation !== this._generation) return null;
      if (preferGpu) {
        this.log("info", "WebGPU XR session request failed; falling back to WebGL2: " + errMessage(e));
        try {
          session = await xr.requestSession(MODE, this.sessionInit(false));
          preferGpu = false;
        } catch (e2) {
          if (generation !== this._generation) return null;
          this._lastError = e2;
          this.emit("error", { error: e2, phase: "requestSession-fallback" });
          return null;
        }
      } else {
        this._lastError = e;
        this.emit("error", { error: e, phase: "requestSession" });
        return null;
      }
    }

    if (generation !== this._generation) {
      try {
        await session.end();
      } catch {
        /* cancelled while requesting */
      }
      return null;
    }
    this._lastError = null;
    this._enabledFeatures = listEnabledFeatures(session);
    const gotWebgpu = preferGpu && featureGranted(session, "webgpu") && this.webgpuXrAvailable();
    this._backend = gotWebgpu ? "webgpu" : "webgl2";
    if (preferGpu && this._backend !== "webgpu") {
      this.log("info", "webgpu feature not in enabledFeatures (or XRGPUBinding missing); WebGL2 XR path");
    }

    this._session = session;
    this._running = false;
    this._centered = false;
    this._recenterPending = false;
    this._xrFrameCount = 0;
    this._visible = session.visibilityState !== "hidden";
    this._inputLatch = { primary: false, secondary: false };

    session.addEventListener("end", this.onSessionEnd);
    session.addEventListener("visibilitychange", this.onVisibility);

    let referenceSpaceType: XrAttachInfo["referenceSpaceType"] = "local-floor";
    try {
      const base = await session.requestReferenceSpace("local-floor");
      if (!this.live(session, generation)) return null;
      this._baseRefSpace = base;
    } catch {
      if (!this.live(session, generation)) return null;
      try {
        const base = await session.requestReferenceSpace("local");
        if (!this.live(session, generation)) return null;
        this._baseRefSpace = base;
        referenceSpaceType = "local";
      } catch (e) {
        if (!this.live(session, generation)) return null;
        this._lastError = e;
        await this.end();
        this.emit("error", { error: e, phase: "referenceSpace" });
        return null;
      }
    }
    const baseSpace = this._baseRefSpace as XrReferenceSpaceLike;
    this._refSpace = baseSpace;
    this._resetPending = false;
    if (baseSpace.addEventListener) baseSpace.addEventListener("reset", this.onReferenceReset);

    // Hand the session to the renderer (three.xr.setSession via ./three-binding.ts).
    const b = this._bindings;
    try {
      await b.attachSession(session, { backend: this._backend, preferWebgpu: preferGpu, referenceSpaceType });
      if (!this.live(session, generation)) {
        // An async renderer attachment can finish after the end event.
        if (!this._session && typeof b.detachSession === "function") b.detachSession();
        return null;
      }
    } catch (e) {
      if (!this.live(session, generation)) return null;
      this._lastError = e;
      await this.end();
      this.emit("error", { error: e, phase: "attachSession" });
      return null;
    }
    if (!this.live(session, generation)) return null;
    this._running = true;
    this._clock = b.clock ?? sessionClock;
    const clock = this._clock;
    if (typeof b.onStart === "function") {
      try {
        b.onStart({ backend: this._backend });
      } catch {
        /* */
      }
    }

    // XR frame loop: replaces window.rAF while presenting.
    const onXRFrame: XrFrameCallback = (time, frame) => {
      if (!this.live(session, generation) || !this._running) return;
      this._xrRequest = null;
      this._xrTime = time;
      this._xrFrame = frame;
      this._xrFrameCount++;
      if ((!this._centered && !this._resetPending) || this._recenterPending) this.recenter(frame);
      try {
        this.pollInput();
      } catch (e) {
        // A controller / injected-input failure must not strand the XR clock or leave
        // its last throttle sample latched while the headset keeps moving.
        this.releaseInput();
        this.log("warn", "pollInput " + errMessage(e));
      }
      if (this._session === session && this._running && typeof b.onFrame === "function") {
        try {
          b.onFrame(time, frame);
        } catch (e) {
          this.log("warn", "onFrame " + errMessage(e));
        }
      }
      this._xrFrame = null; // WebXR poses are valid only within this callback.
      scheduleFrame();
    };
    const scheduleFrame = (): boolean => {
      if (!this.live(session, generation) || !this._running) return false;
      try {
        this._xrRequest = clock.request(session, onXRFrame);
        return true;
      } catch (e) {
        this._lastError = e;
        void this.end();
        this.emit("error", { error: e, phase: "requestAnimationFrame" });
        return false;
      }
    };
    if (!scheduleFrame()) return null;
    this.emit("start", { backend: this._backend, features: this._enabledFeatures.slice() });
    this.log("info", "immersive-vr started backend=" + this._backend);
    return session;
  }

  /** xr-session.js:320-333 */
  private pollInput(): void {
    const s = this._session;
    if (!s) return;
    let menuOpen = false;
    try {
      menuOpen = !!this.deps.menuOpen?.();
    } catch {
      menuOpen = false;
    }
    const mapped = mapFrame(s.inputSources, this._inputLatch, {
      driving: (this.deps.inputMode ? this.deps.inputMode() : "controllers") !== "existing",
      menuOpen,
      overlay: !!s.domOverlayState && !this._resetPending,
    });
    this._inputLatch = mapped.latch;
    if (mapped.recenter) this.recenter();
    const input = this.deps.input?.() ?? null;
    if (this._resetPending || s.visibilityState !== "visible") mapped.driving = false;
    if (input) inject(input, mapped);
  }

  /**
   * xr-session.js:335-360: make the head's current position and yaw the seated
   * origin. Outside an XR callback the request is queued for the next tracked frame.
   */
  recenter(frameOpt?: XrFrameLike | null): boolean {
    if (!this._session || !this._baseRefSpace) return false;
    const xrFrame = frameOpt || this._xrFrame;
    if (!xrFrame) {
      // Never query an expired frame; retry until the next valid tracked pose.
      this._recenterPending = true;
      return true;
    }
    let pose;
    try {
      pose = xrFrame.getViewerPose(this._baseRefSpace);
    } catch {
      return false;
    }
    if (!pose || !pose.transform || !pose.transform.matrix) return false;
    const off = recenterOffsetFromPose(pose.transform.matrix);
    try {
      const make = (this.deps.rigidTransform ?? browserRigidTransform)();
      if (!make) throw new Error("XRRigidTransform missing");
      this._refSpace = this._baseRefSpace.getOffsetReferenceSpace(make(off));
      this._centered = true;
      this._recenterPending = false;
      this._resetPending = false;
      this.emit("recenter", off);
      return true;
    } catch (e) {
      this._lastError = e;
      return false;
    }
  }

  /**
   * xr-session.js:362-409: per-eye frame bags from the XRFrame + seated anchor, or
   * null when the pose is unavailable. The list and its bags are borrowed scratch,
   * valid for synchronous rendering only. Pass the XRFrame when calling outside the
   * session callback.
   */
  eyeFrames(layer?: XrViewportLayer | null, frameOpt?: XrFrameLike | null): EyeFrame[] | null {
    const xrFrame = frameOpt || this._xrFrame;
    if (!xrFrame || !this._refSpace || this._resetPending) return null;
    if (!this._centered && !this.recenter(xrFrame)) return null;
    let pose;
    try {
      pose = xrFrame.getViewerPose(this._refSpace as XrReferenceSpaceLike);
    } catch {
      return null;
    }
    if (!pose || !pose.views || !pose.views.length) return null;
    const views = pose.views;
    if (!this._eyeBags || this._eyeBags.length < views.length) {
      this._eyeBags = [];
      this._viewScratch = [];
      for (let i = 0; i < views.length; i++) {
        this._eyeBags.push(makeEyeFrame());
        this._viewScratch.push(ident());
      }
    }
    const out = this._eyeFrames;
    out.length = views.length;
    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      const bag = this._eyeBags[i] as EyeFrame;
      if (!v) continue;
      // view matrix = inverse of the viewer's transform.matrix
      const poseMat = v.transform && v.transform.matrix;
      let viewMat: Mat4 | null = null;
      if (poseMat) {
        viewMat = this._viewScratch[i] as Mat4;
        invertRigidTo(viewMat, poseMat);
      }
      composeEye(this._anchor, viewMat, v.projectionMatrix, bag);
      if (layer && typeof layer.getViewport === "function") {
        try {
          bag.viewport = layer.getViewport(v) ?? null;
        } catch {
          bag.viewport = null;
        }
      } else {
        bag.viewport = null;
      }
      out[i] = bag;
    }
    return out;
  }

  /** xr-session.js:411-418: also cancels a pending requestSession / reference / attach. */
  async end(): Promise<void> {
    ++this._generation;
    this._startPromise = null; // a cancelled request must not absorb the next ENTER tap
    const s = this._session;
    if (!s) return;
    this.onSessionEnd({ target: s });
    try {
      await s.end();
    } catch {
      /* already ending */
    }
  }

  /** xr-session.js:420-458 */
  private readonly onSessionEnd = (event?: { target?: unknown }): void => {
    const s = this._session;
    if (!s || (event && event.target && event.target !== s)) return;
    ++this._generation;
    this._startPromise = null;
    if (this._xrRequest !== null) {
      try {
        this._clock.cancel(s, this._xrRequest);
      } catch {
        /* already ended */
      }
      this._xrRequest = null;
    }
    try { s.removeEventListener("end", this.onSessionEnd); } catch { /* */ }
    try { s.removeEventListener("visibilitychange", this.onVisibility); } catch { /* */ }
    const base = this._baseRefSpace;
    if (base && base.removeEventListener) {
      try { base.removeEventListener("reset", this.onReferenceReset); } catch { /* ended space */ }
    }
    this._resetPending = false;
    this._eyeFrames.length = 0;
    this._session = null;
    this._refSpace = null;
    this._baseRefSpace = null;
    this._xrFrame = null;
    this._centered = false;
    this._recenterPending = false;
    this._enabledFeatures = [];
    this._running = false;
    this.releaseInput();
    const b = this._bindings;
    if (b && typeof b.detachSession === "function") {
      try { b.detachSession(); } catch { /* */ }
    }
    if (b && typeof b.onEnd === "function") {
      try { b.onEnd(); } catch { /* */ }
    }
    this.emit("end", {});
    this.log("info", "immersive-vr ended");
  };

  /** xr-session.js:460-468: pause and require a deliberate A/X recenter, never a guessed transform. */
  private readonly onReferenceReset = (event?: { target?: unknown }): void => {
    if (!this._session || (event && event.target && event.target !== this._baseRefSpace)) return;
    this._resetPending = true;
    this._recenterPending = false;
    this.releaseInput();
    this.emit("reset", { recenterRequired: true });
  };

  /** xr-session.js:470-474 */
  private readonly onVisibility = (): void => {
    const s = this._session;
    if (!s) return;
    this._visible = s.visibilityState !== "hidden";
    this.emit("visibility", { visible: this._visible, state: String(s.visibilityState) });
  };
}
