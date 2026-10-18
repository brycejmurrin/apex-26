/**
 * Shared fakes for the XR tests: a WebXR session / reference space / frame model
 * ported from f1-game tests/unit/xr-phase0.test.mjs:396-494 (`xrHarness`), a
 * Map-backed Storage, and the frustum math of f1-game js/render/shared/frustum.js:12-39
 * (`extractPlanes`, `aabbInFrustum`) the cull-union test checks against.
 */
import { XrBoot, type XrBootApi, type XrPageNav } from "../../src/xr/boot";
import type { XrRemoteInput } from "../../src/xr/input";
import { ident, mulTo } from "../../src/xr/mat4";
import type { XrInputMode } from "../../src/xr/opts";
import { invertRigidTo, type RigidInit } from "../../src/xr/rig";
import { XrSession } from "../../src/xr/session";
import type { StorageLike } from "../../src/xr/store";
import type {
  XrFrameCallback,
  XrFrameLike,
  XrReferenceSpaceLike,
  XrRigidTransformLike,
  XrSessionLike,
  XrSystemLike,
  XrViewerPoseLike,
} from "../../src/xr/types";
import type { XrInputSources } from "../../src/xr/input";

export class MemStorage implements StorageLike {
  readonly map: Map<string, string>;
  constructor(seed: Record<string, string> = {}) {
    this.map = new Map(Object.entries(seed));
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export const mul = (a: ArrayLike<number>, b: ArrayLike<number>): Float32Array => mulTo(ident(), a, b);

/** A rigid pose: Ry(yaw) * Rx(pitch) * Rz(roll), then translation (xr-phase0.test.mjs:406-413). */
export function pose(x = 0, y = 1.65, z = 0, yaw = 0, pitch = 0, roll = 0): Float32Array {
  const ry = ident(), rx = ident(), rz = ident();
  ry[0] = ry[10] = Math.cos(yaw); ry[8] = Math.sin(yaw); ry[2] = -(ry[8] as number);
  rx[5] = rx[10] = Math.cos(pitch); rx[6] = Math.sin(pitch); rx[9] = -(rx[6] as number);
  rz[0] = rz[5] = Math.cos(roll); rz[1] = Math.sin(roll); rz[4] = -(rz[1] as number);
  const m = mul(mul(ry, rx), rz);
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

type ResetFn = (ev: { target?: unknown; transform?: unknown }) => void;

export interface FakeSpace extends XrReferenceSpaceLike {
  origin: Float32Array;
  events: Map<string, ResetFn>;
  fireReset(transform?: unknown): void;
}

export function makeSpace(origin: Float32Array = ident()): FakeSpace {
  const events = new Map<string, ResetFn>();
  const space: FakeSpace = {
    origin,
    events,
    addEventListener(name: string, fn: ResetFn) { events.set(name, fn); },
    removeEventListener(name: string, fn: ResetFn) { if (events.get(name) === fn) events.delete(name); },
    fireReset(transform?: unknown) { const fn = events.get("reset"); if (fn) fn({ target: space, transform }); },
    getOffsetReferenceSpace(t: XrRigidTransformLike) { return makeSpace(mul(space.origin, t.matrix)); },
  };
  return space;
}

/** XRRigidTransform from position + yaw quaternion (xr-phase0.test.mjs:424-428). */
export const rigidTransform = (init: RigidInit): XrRigidTransformLike => ({
  matrix: pose(init.position.x, init.position.y, init.position.z, 2 * Math.atan2(init.orientation.y, init.orientation.w)),
});

type Listener = (ev: { target?: unknown }) => void;

export interface FakeSession extends XrSessionLike {
  visibilityState: string;
  inputSources: XrInputSources;
  enabledFeatures: string[];
  frames: Map<number, XrFrameCallback>;
  history: XrFrameCallback[];
  cancelled: number[];
  base: FakeSpace;
  events: Map<string, Listener>;
  fire(type: string): void;
}

export interface HarnessOptions {
  reference?: (type: string, base: FakeSpace) => Promise<FakeSpace>;
  request?: (create: () => FakeSession) => Promise<FakeSession>;
  attach?: (s: XrSessionLike) => Promise<unknown>;
  rafFails?: boolean;
  onFrame?: (h: Harness) => void;
  overlayRoot?: Element;
}

export interface Harness {
  session: XrSession;
  boot: XrBoot;
  sessions: FakeSession[];
  windowQueue: Map<number, (t: number) => void>;
  windowHistory: Array<(t: number) => void>;
  windowCancelled: number[];
  tick: (t: number) => void;
  frame(): XrFrameLike;
  physical(m: Float32Array): void;
  tracking(v: boolean): void;
  stats(): { requestCount: number; attachments: number; detachments: number; windowTicks: number; xrTicks: number; cam: number };
  fire(s?: FakeSession): void;
  input: { current: XrRemoteInput | null };
  inputMode: { current: XrInputMode };
}

export function createFakeSession(options: HarnessOptions = {}): FakeSession {
  const events = new Map<string, Listener>(), frames = new Map<number, XrFrameCallback>();
  const history: XrFrameCallback[] = [], cancelled: number[] = [];
  let next = 0, ended = false;
  const base = makeSpace();
  const s: FakeSession = {
    enabledFeatures: ["local-floor"],
    visibilityState: "visible",
    inputSources: [],
    addEventListener(name: string, fn: Listener) { events.set(name, fn); },
    removeEventListener(name: string, fn: Listener) { if (events.get(name) === fn) events.delete(name); },
    requestReferenceSpace(type: string) {
      if (options.reference) return options.reference(type, base);
      return Promise.resolve(base);
    },
    requestAnimationFrame(fn: XrFrameCallback) {
      if (ended || options.rafFails) throw new Error("XR request failed");
      const id = ++next; frames.set(id, fn); history.push(fn); return id;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); cancelled.push(id); },
    async end() { ended = true; const fn = events.get("end"); if (fn) fn({ target: s }); },
    fire(type: string) { const fn = events.get(type); if (fn) fn({ target: s }); },
    frames, history, cancelled, base, events,
  };
  return s;
}

/** xr-phase0.test.mjs:403-494: the real XrSession + XrBoot over fake WebXR. */
export function xrHarness(options: HarnessOptions = {}): Harness {
  let physical = pose(), tracking = true, requestCount = 0, attachments = 0, detachments = 0;
  let windowTicks = 0, xrTicks = 0, cam = 0, nextWindow = 0;
  const sessions: FakeSession[] = [];
  const windowQueue = new Map<number, (t: number) => void>(), windowHistory: Array<(t: number) => void> = [], windowCancelled: number[] = [];
  const input: { current: XrRemoteInput | null } = { current: null };
  const inputMode: { current: XrInputMode } = { current: "controllers" };
  const createSession = (): FakeSession => {
    const s = createFakeSession(options);
    sessions.push(s);
    return s;
  };
  const xr: XrSystemLike = {
    isSessionSupported: async () => true,
    requestSession() {
      requestCount++;
      return options.request ? options.request(createSession) : Promise.resolve(createSession());
    },
  };
  const session = new XrSession({
    xr: () => xr,
    rigidTransform: () => rigidTransform,
    overlayRoot: () => options.overlayRoot ?? null,
    input: () => input.current,
    inputMode: () => inputMode.current,
  });
  const store = new MemStorage();
  const boot = new XrBoot({
    session,
    storage: () => store,
    raf: (fn) => { const id = ++nextWindow; windowQueue.set(id, fn); windowHistory.push(fn); return id; },
    cancelRaf: (id) => { windowCancelled.push(id); windowQueue.delete(id); },
  });
  const h = {} as Harness;
  const tick = (): void => { windowTicks++; boot.afterTick(tick); };
  const api: XrBootApi = {
    gfx: {
      xrCapable: () => true,
      attachXrSession(s) { attachments++; return options.attach ? options.attach(s) : Promise.resolve(); },
      detachXrSession() { detachments++; },
    },
    tickBody: () => { xrTicks++; if (options.onFrame) options.onFrame(h); },
    windowTick: tick,
    getCamMode: () => cam,
    setCamMode: (v) => { cam = v; },
    camModes: [{ id: "chase" }, { id: "cockpit" }],
  };
  boot.bind(api);
  const frame = (): XrFrameLike => ({
    getViewerPose(space: XrReferenceSpaceLike): XrViewerPoseLike | null {
      if (!tracking) return null;
      const inv = invertRigidTo(ident(), (space as FakeSpace).origin);
      const head = mul(inv, physical);
      const views = [-0.032, 0.032].map((x) => {
        const eye = ident(); eye[12] = x;
        return { transform: { matrix: mul(head, eye) }, projectionMatrix: ident() };
      });
      return { transform: { matrix: head }, views };
    },
  });
  Object.assign(h, {
    session, boot, sessions, windowQueue, windowHistory, windowCancelled, tick, frame, input, inputMode,
    physical(m: Float32Array) { physical = m; },
    tracking(v: boolean) { tracking = v; },
    stats: () => ({ requestCount, attachments, detachments, windowTicks, xrTicks, cam }),
    fire(s: FakeSession | undefined = sessions.at(-1)) {
      if (!s) throw new Error("no session");
      const first = s.frames.entries().next().value;
      if (!first) throw new Error("no queued XR frame");
      const [id, fn] = first;
      s.frames.delete(id);
      fn(16, frame());
    },
  });
  return h;
}

export type Planes = Float32Array[];

function setPlane(p: Float32Array, a: number, b: number, c: number, d: number): void {
  const inv = 1 / (Math.hypot(a, b, c) || 1);
  p[0] = a * inv; p[1] = b * inv; p[2] = c * inv; p[3] = d * inv;
}

/** frustum.js:18-27: Gribb-Hartmann planes from a column-major view-proj. */
export function extractPlanes(m: ArrayLike<number>): Planes {
  const g = (i: number): number => m[i] as number;
  const p = [0, 1, 2, 3, 4, 5].map(() => new Float32Array(4)) as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
  setPlane(p[0], g(3) + g(0), g(7) + g(4), g(11) + g(8), g(15) + g(12));
  setPlane(p[1], g(3) - g(0), g(7) - g(4), g(11) - g(8), g(15) - g(12));
  setPlane(p[2], g(3) + g(1), g(7) + g(5), g(11) + g(9), g(15) + g(13));
  setPlane(p[3], g(3) - g(1), g(7) - g(5), g(11) - g(9), g(15) - g(13));
  setPlane(p[4], g(3) + g(2), g(7) + g(6), g(11) + g(10), g(15) + g(14));
  setPlane(p[5], g(3) - g(2), g(7) - g(6), g(11) - g(10), g(15) - g(14));
  return p;
}

/** frustum.js:30-39 */
export function aabbInFrustum(planes: Planes, mn: number[], mx: number[]): boolean {
  for (const p of planes) {
    const px = (p[0] as number) >= 0 ? (mx[0] as number) : (mn[0] as number);
    const py = (p[1] as number) >= 0 ? (mx[1] as number) : (mn[1] as number);
    const pz = (p[2] as number) >= 0 ? (mx[2] as number) : (mn[2] as number);
    if ((p[0] as number) * px + (p[1] as number) * py + (p[2] as number) * pz + (p[3] as number) < 0) return false;
  }
  return true;
}

export type { XrPageNav };
