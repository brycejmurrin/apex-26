// Thin facade over the plan and the session for boot and settings. Ported from
// f1-game js/xr/apex-xr.js:1-183 (ApexXR): the cached plan, the capability probe and
// its a26.xrCaps latch (so the next boot can pick synchronously), bootPick() for the
// renderer boot, and noteFallback() for the post-boot ladder. It does NOT own the
// immersive session (./session.ts does).
//
// Storage (all a26.-prefixed):
//   a26.xr          "0" | "1"     VR mode armed (./opts.ts)
//   a26.xrBackend   webgl2 | webgpu
//   a26.xrCaps      "0" | "1"     last immersive-vr detect (sync boot)
//   a26.xrFallback  sessionStorage "webgl2" after a failed WebGPU XR attempt
import type { BackendName } from "../render/backend";
import type { BackendPin } from "../render/policy";
import type { XrOpts } from "./opts";
import { normBackend, normXr, planPin, resolve, type XrCaps, type XrFallback, type XrPlan, type XrPrefs } from "./plan";
import type { XrSession, XrSessionBackend, XrLog } from "./session";
import {
  KEY_XR,
  KEY_XR_BACKEND,
  KEY_XR_CAPS,
  SS_XR_FALLBACK,
  localStore,
  sessionStore,
  sGet,
  sSet,
  type StorageSource,
} from "./store";
import { hasXrGpuBinding, navigatorXr, type XrSystemLike } from "./types";

export const LS_XR = KEY_XR;
export const LS_BACKEND = KEY_XR_BACKEND;
export const LS_CAPS = KEY_XR_CAPS;
export const SS_FALLBACK = SS_XR_FALLBACK;

/** apex-xr.js:285-287 */
export function questUa(ua: string | null | undefined): boolean {
  return /OculusBrowser/i.test(ua || "");
}

export interface ApexXrDeps {
  opts?: XrOpts;
  storage?: StorageSource;
  session?: StorageSource;
  xr?: () => XrSystemLike | null | undefined;
  hasGpu?: () => boolean;
  hasXrGpuBinding?: () => boolean;
  userAgent?: () => string;
  /** Capability result for the settings rows (f1-game XROpts.onCaps). */
  onCaps?: (caps: XrCaps) => void;
  /** The live session, for stats(). */
  xrSession?: XrSession;
  /** Whether the bound renderer can attach now (XrBoot.canAttach). */
  canAttach?: () => boolean;
  /** The backend the renderer bound (TrackRenderer.backend). TODO(lane-render). */
  boundBackend?: () => BackendName | null;
  log?: XrLog;
}

export interface ApexXrStats {
  path: XrPlan["path"];
  xrMode: XrPlan["xrMode"];
  backendPref: XrPlan["backendPref"];
  reasons: string[];
  fallbacks: XrFallback[];
  caps: XrCaps;
  presenting: boolean;
  sessionBackend: XrSessionBackend | null;
  frameCount: number;
}

function browserHasGpu(): boolean {
  try {
    return typeof navigator !== "undefined" && !!(navigator as Navigator & { gpu?: unknown }).gpu;
  } catch {
    return false;
  }
}

function browserUa(): string {
  try {
    return typeof navigator !== "undefined" ? navigator.userAgent : "";
  } catch {
    return "";
  }
}

export class ApexXr {
  private _plan: XrPlan | null = null;
  private _caps: XrCaps | null = null;
  private readonly _fallbacks: XrFallback[] = [];
  private _detecting: Promise<XrCaps> | null = null;
  private readonly ls: StorageSource;
  private readonly ss: StorageSource;

  constructor(private readonly deps: ApexXrDeps = {}) {
    this.ls = deps.storage ?? localStore;
    this.ss = deps.session ?? sessionStore;
  }

  /** apex-xr.js:268-283 */
  readPrefs(): XrPrefs {
    const o = this.deps.opts;
    if (o) return { xr: o.xr() ? "1" : "0", xrBackend: o.xrBackend(), gfxBackend: null };
    return { xr: normXr(sGet(this.ls, LS_XR)), xrBackend: normBackend(sGet(this.ls, LS_BACKEND)), gfxBackend: null };
  }

  private xrSystem(): XrSystemLike | null {
    return (this.deps.xr ?? navigatorXr)() || null;
  }

  /** apex-xr.js:289-299 */
  private syncCapsFromCache(): XrCaps {
    return {
      xr: !!this.xrSystem(),
      vr: sGet(this.ls, LS_CAPS) === "1",
      gpu: (this.deps.hasGpu ?? browserHasGpu)(),
      xrgpu: (this.deps.hasXrGpuBinding ?? hasXrGpuBinding)(),
      layers: false,
      mobileQuest: questUa((this.deps.userAgent ?? browserUa)()),
    };
  }

  /** apex-xr.js:301-330: async capability probe; writes a26.xrCaps for the next boot. */
  async detect(): Promise<XrCaps> {
    if (this._detecting) return this._detecting;
    this._detecting = (async () => {
      const caps = this.syncCapsFromCache();
      const xr = this.xrSystem();
      let vr = false;
      if (xr && xr.isSessionSupported) {
        try {
          vr = !!(await xr.isSessionSupported("immersive-vr"));
        } catch {
          vr = false;
        }
      }
      caps.vr = vr;
      sSet(this.ls, LS_CAPS, vr ? "1" : "0");
      this._caps = caps;
      this._plan = null; // re-resolve
      try {
        this.deps.onCaps?.(caps);
      } catch {
        /* UI optional */
      }
      return caps;
    })();
    try {
      return await this._detecting;
    } finally {
      this._detecting = null;
    }
  }

  caps(): XrCaps {
    if (this._caps) return this._caps;
    this._caps = this.syncCapsFromCache();
    return this._caps;
  }

  /** apex-xr.js:338-344 */
  plan(force?: boolean): XrPlan {
    if (this._plan && !force) return this._plan;
    const resolved = resolve({ caps: this.caps(), prefs: this.readPrefs(), boot: { xrFallback: sGet(this.ss, SS_FALLBACK) } });
    this._plan = resolved;
    return resolved;
  }

  /** apex-xr.js:346-351: the sync boot override; null leaves the 2D pick alone. */
  bootPick(): XrPlan["backendPref"] {
    const p = this.plan(true);
    if (p.xrMode !== "armed") return null;
    return p.backendPref || null;
  }

  /**
   * apex-26: bootPick() as the renderer's `?gl=` pin. TODO(lane-shell): before
   * createTrackRenderer(), pass `forceWebGL: apexXr.bootPin() === "1"`.
   */
  bootPin(): BackendPin {
    return planPin(this.plan(true));
  }

  path(): XrPlan["path"] {
    return this.plan().path;
  }

  fallbacks(): XrFallback[] {
    return (this._fallbacks.length ? this._fallbacks : this.plan().fallbacks).slice();
  }

  /** apex-xr.js:361-368 */
  noteFallback(from: unknown, to: unknown, reason: unknown): XrFallback {
    const entry: XrFallback = { from: String(from || ""), to: String(to || ""), reason: String(reason || "") };
    this._fallbacks.push(entry);
    try {
      this.deps.log?.("warn", entry.from + "→" + entry.to + ": " + entry.reason);
    } catch {
      /* */
    }
    if (entry.to === "webgl2") sSet(this.ss, SS_FALLBACK, "webgl2");
    this._plan = null;
    return entry;
  }

  /** apex-xr.js:370-384 */
  stats(): ApexXrStats {
    const p = this.plan();
    const s = this.deps.xrSession ?? null;
    return {
      path: p.path,
      xrMode: p.xrMode,
      backendPref: p.backendPref,
      reasons: p.reasons.slice(),
      fallbacks: this.fallbacks(),
      caps: this.caps(),
      presenting: !!(s && s.isPresenting()),
      sessionBackend: s ? s.backend() : null,
      frameCount: s ? s.frameCount() : 0,
    };
  }

  invalidate(): void {
    this._plan = null;
  }

  /**
   * apex-xr.js:390-404: true when the live renderer matches the armed plan (or VR is
   * off). f1-game read TLX's sessionStorage apex26.gfxBound; here the renderer's
   * bound backend is passed in.
   */
  rendererMatchesPlan(): boolean {
    const p = this.plan();
    if (p.xrMode !== "armed") return true;
    try {
      if (this.deps.canAttach?.()) return true;
    } catch {
      /* */
    }
    const bound = this.deps.boundBackend?.() ?? null;
    if (p.path === "webgl2") return bound === "WebGL2";
    return bound === "WebGPU";
  }
}
