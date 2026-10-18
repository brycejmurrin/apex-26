// Renderer boot: apply the policy (./policy.ts, three-free), construct WebGPURenderer,
// retry once on WebGL2. Tests drive createRenderer with a fake factory and env.
import { WebGPURenderer } from "three/webgpu";
import { backendName, type BackendName } from "./backend";
import { chooseBackend, isWebKitUA, parsePin, type BootReason } from "./policy";

export { chooseBackend, isWebKitUA, parsePin } from "./policy";
export type { BackendPin, BootDecision, BootInputs, BootReason } from "./policy";

export interface RendererParams {
  canvas: HTMLCanvasElement;
  antialias: boolean;
  forceWebGL: boolean;
}

/** The subset of WebGPURenderer that boot touches; lets tests pass a fake. */
export interface BootableRenderer {
  backend: unknown;
  init(): Promise<unknown>;
  dispose(): void;
}

export interface BootEnv {
  search: string;
  userAgent: string;
  requestAdapter: (() => Promise<unknown>) | undefined;
}

export interface BootOptions<R extends BootableRenderer> {
  antialias?: boolean;
  env?: BootEnv;
  factory?: (params: RendererParams) => R | Promise<R>;
  onRetry?: (error: unknown) => void;
}

export interface BootResult<R> {
  renderer: R;
  backend: BackendName;
  reason: BootReason;
}

/** The live page's boot inputs; callers override `search` to force a pin. */
export function browserEnv(): BootEnv {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  return {
    search: location.search,
    userAgent: navigator.userAgent,
    requestAdapter: gpu ? () => gpu.requestAdapter() : undefined,
  };
}

function threeFactory(params: RendererParams): WebGPURenderer {
  return new WebGPURenderer(params);
}

async function probeAdapter(requestAdapter: BootEnv["requestAdapter"]): Promise<boolean> {
  if (!requestAdapter) return false;
  try {
    return !!(await requestAdapter());
  } catch {
    return false;
  }
}

export async function createRenderer<R extends BootableRenderer>(
  canvas: HTMLCanvasElement,
  opts: BootOptions<R> & { factory: (params: RendererParams) => R | Promise<R> },
): Promise<BootResult<R>>;
export async function createRenderer(
  canvas: HTMLCanvasElement,
  opts?: Omit<BootOptions<WebGPURenderer>, "factory">,
): Promise<BootResult<WebGPURenderer>>;
export async function createRenderer(
  canvas: HTMLCanvasElement,
  opts: BootOptions<BootableRenderer> = {},
): Promise<BootResult<BootableRenderer>> {
  const env = opts.env ?? browserEnv();
  const factory = opts.factory ?? threeFactory;
  const antialias = opts.antialias ?? true;
  const pin = parsePin(env.search);
  // A pin decides on its own; skip the adapter request.
  const hasAdapter = pin === null ? await probeAdapter(env.requestAdapter) : false;
  const decision = chooseBackend({ pin, isWebKit: isWebKitUA(env.userAgent), hasAdapter });
  let reason: BootReason = decision.reason;

  let renderer = await factory({ canvas, antialias, forceWebGL: decision.forceWebGL });
  try {
    await renderer.init();
  } catch (e) {
    // Only auto retries (f1-game tlx.js:636-650): a pin is a test override and must
    // surface its failure. init() configures the WebGPU context lazily, so #game is
    // still unclaimed and the WebGL2 retry can bind it.
    if (decision.forceWebGL || pin !== null) throw e;
    opts.onRetry?.(e);
    renderer.dispose();
    renderer = await factory({ canvas, antialias, forceWebGL: true });
    await renderer.init();
    reason = "init-retry";
  }

  const backend = backendName(renderer);
  if (!decision.forceWebGL && reason === "auto" && backend === "WebGL2") reason = "silent-fallback";
  return { renderer, backend, reason };
}
