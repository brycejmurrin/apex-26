// Pure boot-time VR renderer path selection. Ported from f1-game js/xr/xr-plan.js:1-140
// (XRPlan.resolve / normXr / normBackend). No DOM or navigator reads: it decides from
// capability and preference bags only. WebGL2 is the default shippable VR path;
// WebGPU XR is experimental and opt-in. It never writes the 2D renderer pick.
//
// apex-26 has one renderer (three WebGPURenderer) with two backends, where f1-game had
// GLX (WebGL2) and TLX (three). `backendPref` keeps f1-game's values ("webgl2" = the
// WebGL2 path, "three" = TLX on WebGPU) so the table tests port verbatim; `planPin()`
// maps it onto apex-26's `?gl=` pin (src/render/policy.ts BackendPin).
import type { BackendPin } from "../render/policy";

export const PATH_WEBGL2 = "webgl2";
export const PATH_WEBGPU = "webgpu";
export type XrPath = typeof PATH_WEBGL2 | typeof PATH_WEBGPU;
export type XrBackendPref = "webgl2" | "webgpu";

/** xr-plan.js:31 caps: { xr, vr, gpu, xrgpu, layers?, mobileQuest? } */
export interface XrCaps {
  xr?: boolean;
  vr?: boolean;
  gpu?: boolean;
  xrgpu?: boolean;
  layers?: boolean;
  mobileQuest?: boolean;
}

/** xr-plan.js:32 prefs. `xr` accepts the loose spellings normXr() takes. */
export interface XrPrefs {
  xr?: unknown;
  xrBackend?: unknown;
  gfxBackend?: string | null;
}

/** xr-plan.js:33 boot: `xrFallback` "webgl2" forces the WebGL2 path. */
export interface XrBootFlags {
  xrFallback?: string | null;
}

export interface XrPlanInput {
  caps?: XrCaps;
  prefs?: XrPrefs;
  boot?: XrBootFlags;
}

export interface XrFallback {
  from: string;
  to: string;
  reason: string;
}

export interface XrPlan {
  xrMode: "off" | "armed";
  path: XrPath | null;
  backendPref: "webgl2" | "three" | null;
  forceGL: boolean;
  reasons: string[];
  fallbacks: XrFallback[];
}

/** xr-plan.js:20-23 */
export function normXr(v: unknown): "0" | "1" {
  if (v === "1" || v === 1 || v === true || v === "on" || v === "true") return "1";
  return "0";
}

/** xr-plan.js:25-29 */
export function normBackend(v: unknown): XrBackendPref {
  const s = (v == null ? "" : String(v)).toLowerCase();
  if (s === "webgpu") return "webgpu";
  return "webgl2";
}

function emptyResult(reasons: string[]): XrPlan {
  return { xrMode: "off", path: null, backendPref: null, forceGL: false, reasons, fallbacks: [] };
}

function armed(path: XrPath, backendPref: "webgl2" | "three", reasons: string[], fallbacks: XrFallback[]): XrPlan {
  return { xrMode: "armed", path, backendPref, forceGL: false, reasons, fallbacks };
}

/** xr-plan.js:48-136 */
export function resolve(input?: XrPlanInput | null): XrPlan {
  const caps = (input && input.caps) || {};
  const prefs = (input && input.prefs) || {};
  const boot = (input && input.boot) || {};
  const reasons: string[] = [];
  const fallbacks: XrFallback[] = [];

  const xrPref = normXr(prefs.xr);
  const wantBackend = normBackend(prefs.xrBackend);
  const hasXr = !!caps.xr;
  const hasVr = !!caps.vr;
  const hasGpu = !!caps.gpu;
  const hasXrgpu = !!caps.xrgpu;
  const latch = boot.xrFallback != null && String(boot.xrFallback).toLowerCase() === "webgl2";

  if (xrPref !== "1") {
    reasons.push("VR mode off (a26.xr≠1)");
    return emptyResult(reasons);
  }
  if (!hasXr) {
    reasons.push("navigator.xr missing");
    return emptyResult(reasons.concat(["cannot arm without WebXR"]));
  }
  if (!hasVr) {
    reasons.push("immersive-vr not supported");
    return emptyResult(reasons);
  }

  // Armed + VR capable from here.
  if (latch) {
    reasons.push("session latch a26.xrFallback=webgl2");
    fallbacks.push({ from: "webgpu", to: "webgl2", reason: "xrFallback latch" });
    return armed(PATH_WEBGL2, "webgl2", reasons, fallbacks);
  }

  if (wantBackend === "webgpu") {
    if (!hasGpu) {
      reasons.push("navigator.gpu missing");
      fallbacks.push({ from: "webgpu", to: "webgl2", reason: "no navigator.gpu" });
      return armed(PATH_WEBGL2, "webgl2", reasons, fallbacks);
    }
    if (!hasXrgpu) {
      reasons.push("XRGPUBinding missing");
      fallbacks.push({ from: "webgpu", to: "webgl2", reason: "no XRGPUBinding" });
      return armed(PATH_WEBGL2, "webgl2", reasons, fallbacks);
    }
    reasons.push("WebGPU XR experimental path selected");
    if (caps.mobileQuest) reasons.push("Quest UA — WebGPU-in-XR unverified on device");
    return armed(PATH_WEBGPU, "three", reasons, fallbacks);
  }

  reasons.push("WebGL2 VR path (default)");
  return armed(PATH_WEBGL2, "webgl2", reasons, fallbacks);
}

/**
 * apex-26 only: the `?gl=` pin an armed plan asks the renderer boot for (policy.ts
 * BackendPin). null leaves the 2D pick alone (VR off).
 */
export function planPin(plan: XrPlan): BackendPin {
  if (plan.xrMode !== "armed") return null;
  return plan.path === PATH_WEBGPU ? "0" : "1";
}
