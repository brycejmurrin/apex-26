// WebXR boot wiring. Ported from f1-game js/xr/xr-boot.js:1-390 (XrBoot): binds the
// session owner to the live renderer, owns the frame-clock handoff between the
// window loop and the XR session loop, the transient cockpit camera, the comfort
// flag, the ENTER VR backend switch, the cheap "is a headset there" probe, the
// per-eye frame-matrix fill (applyEyes) and the headset-menu pause.
//
// apex-26 differences (see the PR report): the lazy XR bundle is a Vite dynamic
// import the shell makes after `wantXrBundle()`, not f1-game's ScriptLoader; the
// backend switch pins `?gl=1` (src/render/policy.ts) instead of
// apex26.gfxBackend/tlxForceGL; no `window.__apexXr` global (diag() is returned).
import type { XrFrameLike, XrSessionLike, XrSystemLike, XrViewportLayer } from "./types";
import { navigatorXr } from "./types";
import type { Mat4 } from "./mat4";
import { unionViewProjTo, type EyeFrame, type Vec3, type Vec3In, type XrAnchor } from "./rig";
import type { XrAttachInfo, XrFrameClock, XrSession, XrSessionBackend } from "./session";
import { hasXrGpuBinding } from "./types";
import { KEY_XR, KEY_XR_PENDING, KEY_XR_PREV_PIN, localStore, sGet, sRemove, sSet, type StorageSource } from "./store";

/**
 * The renderer side of XR (f1-game's `gfx` = TLX). ./three-binding.ts implements it
 * on three's WebGPURenderer.xr. TODO(lane-render): createThreeXrGfx() needs the
 * renderer's WebGPURenderer, camera and backend (see three-binding.ts XrRenderHost).
 */
export interface XrGfx {
  /** The live renderer can attach an immersive session now. */
  xrCapable(): boolean;
  attachXrSession(session: XrSessionLike, info: XrAttachInfo): Promise<unknown> | unknown;
  detachXrSession?(): void;
  /** The layer whose viewports eyeFrames() reports (XRWebGLLayer). */
  xrLayer?(): XrViewportLayer | null;
  /** The seated anchor changed (three: move the camera rig). */
  setXrAnchor?(anchor: XrAnchor): void;
  /** The XR frame clock, when the renderer owns the session rAF chain (three's XRManager does). */
  readonly clock?: XrFrameClock;
  xrInfo?(): unknown;
  getFoveation?(): number | null;
  setFoveation?(v: number): boolean;
}

export type XrPauseReason = "xr-reset" | "xr-end" | "xr-hidden";

/** What the shell binds (xr-boot.js:193-244). TODO(lane-shell): src/app wires this. */
export interface XrBootApi {
  gfx: XrGfx;
  /** One game frame while presenting, driven by the XR clock. */
  tickBody(time: number, frame: XrFrameLike): void;
  /** The flat game's window-rAF tick; resumed exactly once on EXIT VR. */
  windowTick(time: number): void;
  getCamMode(): number;
  /** opts.persist === false: switch without saving the player's camera pick. */
  setCamMode(idx: number, opts?: { persist?: boolean }): void;
  /** The camera family, to find "cockpit" (f1-game CamModes.CAM_MODES). */
  camModes?: ReadonlyArray<{ readonly id: string }>;
  /** The game's pause path; it decides eligibility (race / countdown, no net). */
  pause?(why: XrPauseReason): void;
}

/** The page URL the backend switch rewrites. */
export interface XrPageNav {
  search(): string;
  /** Load the page with this query string (a reload). */
  load(search: string): void;
  /** Rewrite the address bar without loading (history.replaceState). */
  replace(search: string): void;
}

export interface XrBootDeps {
  session: XrSession;
  storage?: StorageSource;
  raf?: (cb: (t: number) => void) => number;
  cancelRaf?: (id: number) => void;
  nav?: XrPageNav;
  xr?: () => XrSystemLike | null | undefined;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

/** The frame-matrix bag applyEyes overwrites (f1-game game.js `frame`). */
export interface XrFrameMatrices {
  viewProj?: Mat4 | null;
  proj?: Mat4 | null;
  invProj?: Mat4 | null;
  invViewProj?: Mat4 | null;
  view?: Mat4 | null;
  eye?: Vec3 | null;
}

export interface XrDiag {
  presenting: boolean;
  loopByXr: boolean;
  windowPending: boolean;
  canAttach: boolean;
  backend: XrSessionBackend;
  features: string[];
  frameCount: number;
  visible: boolean;
  foveation: number | null;
  draw: unknown;
  layer: boolean;
  savedCam: number;
}

export interface XrEnsureResult {
  ok: boolean;
  reloading?: boolean;
  message?: string;
}

/** xr-boot.js:257 */
export const PROBE_CAP_MS = 1500;

export function browserNav(): XrPageNav {
  return {
    search: () => (typeof location === "undefined" ? "" : location.search),
    load: (search) => {
      location.search = search;
    },
    replace: (search) => {
      const u = new URL(location.href);
      u.search = search;
      history.replaceState(history.state, "", u.href);
    },
  };
}

function withGl(search: string, gl: string | null): string {
  const p = new URLSearchParams(search);
  if (gl === null) p.delete("gl");
  else p.set("gl", gl);
  const s = p.toString();
  return s ? "?" + s : "";
}

/**
 * xr-boot.js:252-272: can an immersive-vr session start here at all? true / false,
 * or null when that cannot be known (no isSessionSupported, a throw, a hang past
 * the cap).
 */
export async function probeVr(
  xr: XrSystemLike | null | undefined,
  timers: Pick<XrBootDeps, "setTimeout" | "clearTimeout"> = {},
): Promise<boolean | null> {
  try {
    if (!xr) return false;
    if (typeof xr.isSessionSupported !== "function") return null;
    const set = timers.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clear = timers.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
    let timer: unknown = null;
    const cap = new Promise<null>((resolve) => {
      timer = set(() => resolve(null), PROBE_CAP_MS);
    });
    try {
      const v = await Promise.race([Promise.resolve(xr.isSessionSupported("immersive-vr")), cap]);
      return v === null ? null : !!v;
    } finally {
      if (timer !== null) clear(timer);
    }
  } catch {
    return null;
  }
}

/**
 * xr-boot.js:274-280: should the shell load the XR chunk? An armed VR mode or a
 * pending auto-enter loads without probing; otherwise only a definite "no headset"
 * skips it (desktop Chrome / Edge expose navigator.xr with no headset anywhere).
 * TODO(lane-shell): `if (await wantXrBundle()) await import("./xr/index")`.
 */
export async function wantXrBundle(
  deps: { storage?: StorageSource; xr?: () => XrSystemLike | null | undefined } & Pick<XrBootDeps, "setTimeout" | "clearTimeout"> = {},
): Promise<boolean> {
  const storage = deps.storage ?? localStore;
  if (sGet(storage, KEY_XR) === "1") return true;
  if (sGet(storage, KEY_XR_PENDING) === "1") return true;
  const xr = (deps.xr ?? navigatorXr)();
  if (!xr) return false;
  return (await probeVr(xr, deps)) !== false;
}

export class XrBoot {
  private _loopByXr = false;
  private _tickBody: XrBootApi["tickBody"] | null = null;
  private _windowRaf: ((t: number) => void) | null = null;
  private _windowRequest: number | null = null;
  private _windowGeneration = 0;
  private _windowPending = false;
  private _cockpitIdx = -1;
  private _savedCam = -1;
  private _bound = false;
  private _api: XrBootApi | null = null;
  private readonly storage: StorageSource;
  readonly session: XrSession;

  constructor(private readonly deps: XrBootDeps) {
    this.session = deps.session;
    this.storage = deps.storage ?? localStore;
  }

  /** Immersive presenting: camera shake / buzz / kerb shiver off (xr-boot.js:29-31). */
  comfort(): boolean {
    return this.session.isPresenting();
  }

  /** Reduce-motion OR immersive presenting (xr-boot.js:33-36). */
  camComfort(motionReduced: boolean): boolean {
    return !!motionReduced || this.comfort();
  }

  /** True while the XR session owns the frame clock: do not schedule window.rAF. */
  loopByXr(): boolean {
    return this._loopByXr;
  }

  /** True after bind(); start the session only after this. */
  isBound(): boolean {
    return this._bound;
  }

  /** xr-boot.js:51-58 */
  canAttach(): boolean {
    const gfx = this._api?.gfx;
    if (!gfx || typeof gfx.attachXrSession !== "function") return false;
    if (typeof gfx.xrCapable === "function") {
      try {
        return !!gfx.xrCapable();
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * xr-boot.js:60-84: if the live renderer cannot attach, reload once pinned to
   * WebGL2 (`?gl=1`) with an auto-enter request. The pin is for THAT boot only: the
   * previous `gl` value is stashed and restorePinnedBackend() puts it back.
   */
  ensureXrBackend(): XrEnsureResult {
    if (this.canAttach()) return { ok: true };
    const nav = this.deps.nav ?? browserNav();
    let search: string;
    try {
      search = nav.search();
      if (sGet(this.storage, KEY_XR_PREV_PIN) === null) {
        // A second click must not stash the pin itself.
        const prev = new URLSearchParams(search).get("gl");
        if (!sSet(this.storage, KEY_XR_PREV_PIN, JSON.stringify({ gl: prev }))) throw new Error("storage blocked");
      }
      if (!sSet(this.storage, KEY_XR_PENDING, "1")) throw new Error("storage blocked");
    } catch {
      return { ok: false, message: "VR needs WebGL2 (allow site storage)" };
    }
    try {
      nav.load(withGl(search, "1"));
    } catch {
      /* */
    }
    return { ok: false, reloading: true };
  }

  /** xr-boot.js:86-103: after the renderer booted on the pin, put the player's `gl` back. */
  restorePinnedBackend(): boolean {
    const raw = sGet(this.storage, KEY_XR_PREV_PIN);
    if (raw === null) return false;
    let prev: unknown = null;
    try {
      prev = JSON.parse(raw);
    } catch {
      /* corrupt stash: drop it */
    }
    if (prev && typeof prev === "object") {
      const gl = (prev as { gl?: unknown }).gl;
      try {
        const nav = this.deps.nav ?? browserNav();
        nav.replace(withGl(nav.search(), typeof gl === "string" ? gl : null));
      } catch {
        /* no history (tests) */
      }
    }
    sRemove(this.storage, KEY_XR_PREV_PIN);
    return true;
  }

  /** xr-boot.js:105-111 */
  consumePendingEnter(): boolean {
    if (sGet(this.storage, KEY_XR_PENDING) !== "1") return false;
    return sRemove(this.storage, KEY_XR_PENDING);
  }

  /** xr-boot.js:113-120 */
  findCockpit(): number {
    if (this._cockpitIdx >= 0) return this._cockpitIdx;
    const modes = this._api?.camModes;
    this._cockpitIdx = modes ? modes.findIndex((c) => c.id === "cockpit") : -1;
    return this._cockpitIdx;
  }

  /** Switch camera without writing the camera pref (the VR override is ephemeral). */
  setCamMode(idx: number): void {
    this._api?.setCamMode(idx, { persist: false });
  }

  /** xr-boot.js:127-132 */
  saveAndForceCockpit(): void {
    const ci = this.findCockpit();
    if (ci < 0 || !this._api) return;
    this._savedCam = this._api.getCamMode();
    if (this._savedCam !== ci) this.setCamMode(ci);
  }

  /** xr-boot.js:134-138 */
  restoreSavedCam(): void {
    if (this._savedCam < 0) return;
    try {
      this.setCamMode(this._savedCam);
    } catch {
      /* */
    }
    this._savedCam = -1;
  }

  /** xr-boot.js:140-158: exactly one window.rAF for the game tick, deduped. */
  chainWindowRaf(tickFn?: ((t: number) => void) | null): boolean {
    if (this._loopByXr) return false;
    if (this._windowPending) return false;
    const fn = tickFn || this._windowRaf;
    if (typeof fn !== "function") return false;
    const raf = this.deps.raf ?? ((cb: (t: number) => void) => requestAnimationFrame(cb));
    this._windowPending = true;
    const generation = this._windowGeneration;
    this._windowRequest = raf((t) => {
      if (this._loopByXr || generation !== this._windowGeneration) return;
      this._windowRequest = null;
      this._windowPending = false;
      fn(t);
    });
    return true;
  }

  /** Call at the end of the flat tick: chains window.rAF unless XR owns the clock. */
  afterTick(tickFn?: ((t: number) => void) | null): boolean {
    return this.chainWindowRaf(tickFn);
  }

  /** xr-boot.js:193-250 */
  bind(api: XrBootApi): void {
    if (this._bound) return;
    this._api = api;
    this._tickBody = api.tickBody;
    this._windowRaf = api.windowTick;
    const gfx = api.gfx;
    this.session.bind({
      attachSession: async (session, info) => {
        if (!this.canAttach()) throw new Error("Active renderer cannot attach XR (need WebGL2, or WebGPU with XRGPUBinding)");
        if (info.backend === "webgpu" && !hasXrGpuBinding()) {
          throw new Error("WebGPU XR unavailable; session should have fallen back");
        }
        return gfx.attachXrSession(session, info);
      },
      detachSession: () => {
        gfx.detachXrSession?.();
      },
      onStart: () => {
        this._loopByXr = true;
        // Cancellation saves work; the generation also rejects a callback already
        // dispatched (or suspended by the browser until after XR ends).
        this._windowGeneration++;
        if (this._windowRequest !== null) {
          const cancel = this.deps.cancelRaf ?? ((id: number) => cancelAnimationFrame(id));
          cancel(this._windowRequest);
        }
        this._windowRequest = null;
        this._windowPending = false;
        this.saveAndForceCockpit();
      },
      onEnd: () => {
        this._loopByXr = false;
        this.restoreSavedCam();
        this.chainWindowRaf(this._windowRaf);
      },
      onFrame: (time, frame) => {
        if (this._loopByXr && this._tickBody) this._tickBody(time, frame);
      },
      ...(gfx.clock ? { clock: gfx.clock } : {}),
    });
    // The headset's system menu (visible-blurred / hidden) or taking it off (end)
    // leaves the DOCUMENT visible, so the page's visibilitychange pause never fires;
    // blurred, the runtime stops delivering input and the car would run on its last
    // sample (f1-game R3-STATES-2). Drop the sample and take the pause path.
    this.session.on((ev, d) => {
      if (!(ev === "reset" || ev === "end" || (ev === "visibility" && d.state !== "visible"))) return;
      if (ev === "visibility") this.session.releaseInput();
      const pause = this._api?.pause;
      if (pause) {
        try {
          pause(ev === "reset" ? "xr-reset" : ev === "end" ? "xr-end" : "xr-hidden");
        } catch {
          /* */
        }
      }
    });
    this._bound = true;
  }

  /**
   * xr-boot.js:282-304 minus the lazy load: restore the pinned backend, then
   * auto-enter once if a backend-switch reload asked for it. `mountButton` mounts
   * the ENTER VR button (./ui.ts XrUi.mount).
   */
  async mountUi(mountButton?: () => void): Promise<boolean> {
    this.restorePinnedBackend();
    mountButton?.();
    if (!this.consumePendingEnter()) return false;
    try {
      const ok = await this.session.probe();
      if (!ok || !this.canAttach()) return false;
      return !!(await this.session.start());
    } catch {
      return false; // auto-enter is best-effort
    }
  }

  /** Publish the seated anchor from the cockpit camera (eye, target, up). */
  seat(camEye: Vec3In, camTgt: Vec3In, camUp?: Vec3In | null): void {
    const fwd = this._forward;
    for (let i = 0; i < 3; i++) fwd[i] = (camTgt[i] as number) - (camEye[i] as number);
    this.session.setAnchor(camEye, fwd, camUp || this._up);
    this._api?.gfx.setXrAnchor?.(this.session.getAnchor());
  }

  private readonly _cullVP = new Float32Array(16);
  private readonly _cullEyes: EyeFrame[] = [];
  private readonly _forward: Vec3 = [0, 0, 1];
  private readonly _up: Vec3 = [0, 1, 0];

  /**
   * xr-boot.js:306-343: after the cockpit camera is known, publish the seated anchor
   * and, when presenting, overwrite `frame` with the left eye (viewProj: the union
   * cull frustum of every drawn eye). Returns the eye list, or null when not in XR.
   * three's XRManager path needs only seat(); this is for per-eye consumers.
   */
  applyEyes(frame: XrFrameMatrices | null, camEye: Vec3In, camTgt: Vec3In, camUp?: Vec3In | null): EyeFrame[] | null {
    if (!this.comfort()) return null;
    this.seat(camEye, camTgt, camUp);
    const gfx = this._api?.gfx;
    const layer = gfx && typeof gfx.xrLayer === "function" ? gfx.xrLayer() : null;
    const eyes = this.session.eyeFrames(layer);
    if (!eyes || !eyes.length) return null;
    const e0 = eyes[0] as EyeFrame;
    if (frame) {
      // frame.viewProj is only the CULL frustum here; each eye renders with its own
      // matrices. One eye's planes miss the other's outer wedge (R3-RENDER-3).
      let drawn = 0;
      for (let i = 0; i < eyes.length; i++) {
        const e = eyes[i] as EyeFrame;
        const vp = e.viewport;
        if (!vp || (vp.width > 0 && vp.height > 0)) this._cullEyes[drawn++] = e;
      }
      this._cullEyes.length = drawn;
      if (drawn > 1 && unionViewProjTo(this._cullVP, this._cullEyes)) frame.viewProj = this._cullVP;
      else frame.viewProj = e0.viewProj;
      frame.proj = e0.proj;
      frame.invProj = e0.invProj;
      frame.invViewProj = e0.invViewProj;
      frame.view = e0.view;
      frame.eye = e0.eye;
    }
    return eyes;
  }

  /** xr-boot.js:353-373 */
  diag(): XrDiag {
    const gfx = this._api?.gfx;
    const s = this.session;
    return {
      presenting: this.comfort(),
      loopByXr: this._loopByXr,
      windowPending: this._windowPending,
      canAttach: this.canAttach(),
      backend: s.backend(),
      features: s.enabledFeatures(),
      frameCount: s.frameCount(),
      visible: s.isVisible(),
      foveation: gfx?.getFoveation ? gfx.getFoveation() : null,
      draw: gfx?.xrInfo ? gfx.xrInfo() : null,
      layer: !!(gfx && typeof gfx.xrLayer === "function" && gfx.xrLayer()),
      savedCam: this._savedCam,
    };
  }

  /** xr-boot.js:375-379 */
  setFoveation(v: number): boolean {
    const gfx = this._api?.gfx;
    return gfx?.setFoveation ? gfx.setFoveation(v) : false;
  }
}
