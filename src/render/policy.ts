// Renderer boot policy: which backend WebGPURenderer is ALLOWED to try.
// Pure and three-free so it runs under Vitest in Node.
//
// Ported from f1-game `js/render/three/tlx.js` (the `forceWebGL = _glPin === "1" ||
// (_glPin !== "0" && (!_gpuCanvasOk || _autoStayGL || isWebKit))` clause) and
// `docs/ARCHITECTURE.md` §THREE.JS: three's WebGPU backend drew wrongly on an iPhone
// (bodywork missing, then sky only) with ZERO reported GPU or WGSL errors, while its
// WebGL2 backend on the same phone is known-good, so WebKit takes WebGL2 on auto.

/** `?gl=1` pins WebGL2, `?gl=0` pins WebGPU; anything else is auto. */
export type BackendPin = "1" | "0" | null;

export type BootReason =
  | "pin-webgl" // ?gl=1
  | "pin-webgpu" // ?gl=0 (honoured even on WebKit or with no adapter)
  | "webkit" // Safari / every iOS browser: auto takes WebGL2
  | "no-adapter" // navigator.gpu missing or requestAdapter() resolved null
  | "auto" // WebGPU allowed
  | "init-retry" // WebGPU init() threw on auto; retried once on WebGL2
  | "silent-fallback"; // WebGPU was allowed but three bound WebGL2 without throwing

export interface BootInputs {
  pin: BackendPin;
  isWebKit: boolean;
  hasAdapter: boolean;
}

export interface BootDecision {
  forceWebGL: boolean;
  reason: BootReason;
}

export function chooseBackend({ pin, isWebKit, hasAdapter }: BootInputs): BootDecision {
  if (pin === "1") return { forceWebGL: true, reason: "pin-webgl" };
  if (pin === "0") return { forceWebGL: false, reason: "pin-webgpu" };
  if (isWebKit) return { forceWebGL: true, reason: "webkit" };
  // three does NOT throw when the adapter is missing: it quietly binds WebGL2
  // (f1-game tlx.js:260). Deciding here keeps the reason honest.
  if (!hasAdapter) return { forceWebGL: true, reason: "no-adapter" };
  return { forceWebGL: false, reason: "auto" };
}

/** Reads the `gl` query parameter (`?gl=1|0`); other values mean auto. */
export function parsePin(search: string): BackendPin {
  const v = new URLSearchParams(search).get("gl");
  return v === "1" || v === "0" ? v : null;
}

/**
 * f1-game's WebKit test (tlx.js:208), verbatim: Chrome/Firefox/Edge on iOS are WebKit
 * underneath (CriOS/FxiOS/EdgiOS), and a bare `Safari/` token without a Chromium-family
 * token is Safari itself (Chrome's UA also carries `Safari/`).
 */
export function isWebKitUA(ua: string): boolean {
  return /CriOS|FxiOS|EdgiOS/.test(ua) || (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua));
}
