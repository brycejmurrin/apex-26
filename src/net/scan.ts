/**
 * Reading a QR code with the device camera, in the page: the platform
 * BarcodeDetector when it reads qr_code, else jsQR loaded on demand.
 * Port of f1-game js/net/scan.js:1-219 (NetScan).
 *
 * The invite already travels as a link and as a QR; scanning it in the page
 * means the guest's phone never has to leave the lobby. A refused or missing
 * camera is an ordinary outcome and the caller falls back to paste. stop() is
 * absolute: it kills every track (the camera light must go out) and any decode
 * that lands after it delivers nothing.
 *
 * apex-26 differences: jsQR comes from the `jsqr` npm package via a dynamic
 * import() (f1-game injected vendor/jsqr-1.4.0/jsQR.js as a script tag), and
 * getUserMedia, BarcodeDetector, the decoder loader and the frame reader are
 * injectable through ScanEnv so the module runs under node.
 */
import { netLog } from "./log";

const DECODE_EVERY_MS = 120; // ~8 Hz: fast enough to feel instant, cheap
const MAX_EDGE = 640; // decode at 640px; more pixels buys nothing

/** jsQR's call signature, as far as the scanner uses it. */
export type JsQrFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" },
) => { data: string } | null;

export interface ScanTrack {
  stop(): void;
}
/** The slice of MediaStream the scanner touches; a real MediaStream satisfies it. */
export interface ScanStream {
  getTracks(): readonly ScanTrack[];
}

/** The slice of HTMLVideoElement the scanner touches; a real <video> satisfies it. */
export interface ScanVideo {
  readonly videoWidth: number;
  readonly videoHeight: number;
  srcObject: unknown;
  muted: boolean;
  setAttribute(name: string, value: string): void;
  play(): Promise<void>;
}

export interface DetectedBarcodeLike {
  rawValue?: string;
}
export interface BarcodeDetectorLike {
  detect(source: unknown): Promise<readonly DetectedBarcodeLike[]> | readonly DetectedBarcodeLike[];
}
/** The BarcodeDetector constructor (not yet in TypeScript's DOM lib). */
export interface BarcodeDetectorCtor {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<readonly string[]>;
}

/** Draws a video frame scaled to w x h and returns its RGBA pixels, or null (tainted canvas). */
export interface FrameReader {
  read(video: ScanVideo, w: number, h: number): Uint8ClampedArray | null;
}

export type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<ScanStream>;

/** Platform seams. Each one omitted falls back to the browser global, read at call time. */
export interface ScanEnv {
  getUserMedia?: GetUserMedia | null;
  /** null means "this platform has no BarcodeDetector". */
  BarcodeDetector?: BarcodeDetectorCtor | null;
  loadDecoder?: () => Promise<JsQrFn>;
  /** Returns null when no 2D canvas is available (the no_canvas outcome). */
  createFrameReader?: () => FrameReader | null;
}

export type ScanError = "cancelled" | "unsupported" | "no_decoder" | "denied" | "no_camera" | "no_canvas";
export type ScanStartResult = { ok: true } | { ok: false; error: ScanError; message: string };
export type ScanDecoderKind = "barcode" | "jsqr";

export interface Scanner {
  /** `videoEl` must already be in the DOM; it is set playsinline and muted here. */
  start(videoEl: ScanVideo, cb: (text: string) => void): Promise<ScanStartResult>;
  stop(): void;
  active(): boolean;
  decoder(): ScanDecoderKind | null;
}

function globalBarcodeDetector(): BarcodeDetectorCtor | null {
  const w = (globalThis as { window?: unknown }).window;
  if (typeof w !== "object" || w === null || !("BarcodeDetector" in w)) return null;
  const BD = (w as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof BD === "function" ? (BD as BarcodeDetectorCtor) : null;
}

function globalGetUserMedia(): GetUserMedia | null {
  const nav = (globalThis as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } }).navigator;
  const md = nav?.mediaDevices;
  if (!md || typeof md.getUserMedia !== "function") return null;
  const gum = md.getUserMedia as (c: MediaStreamConstraints) => Promise<ScanStream>;
  return (c) => gum.call(md, c);
}

/**
 * THE PLATFORM DECODER FIRST. BarcodeDetector is still absent on desktop
 * Linux Chrome and iOS Safari (which is why jsQR ships at all), but where it
 * exists (Android Chrome, macOS Safari 16+) it is hardware-assisted, needs no
 * extra download, and reads a phone screen at an angle jsQR gives up on.
 * Feature-detected per call, never cached: a rejected getSupportedFormats()
 * (permissions policy, a stubbed window) simply means jsQR. Resolves to a
 * detector or null; never throws.
 */
export async function platformDetector(BD: BarcodeDetectorCtor | null = globalBarcodeDetector()): Promise<BarcodeDetectorLike | null> {
  try {
    if (!BD) return null;
    if (typeof BD.getSupportedFormats !== "function") return null;
    const formats: unknown = await BD.getSupportedFormats();
    if (!Array.isArray(formats) || !formats.includes("qr_code")) return null;
    const det = new BD({ formats: ["qr_code"] });
    return typeof (det as { detect?: unknown }).detect === "function" ? det : null;
  } catch {
    return null;
  }
}

/** True when the page can ask for a camera at all. */
export function supported(env: ScanEnv = {}): boolean {
  const gum = env.getUserMedia === undefined ? globalGetUserMedia() : env.getUserMedia;
  return typeof gum === "function";
}

let loading: Promise<JsQrFn> | null = null; // the in-flight import, shared by callers
let loaded: JsQrFn | null = null;

/**
 * Import the decoder once. A second start() while the first load is still in
 * flight must not fetch it twice, hence the shared promise. A failed load is
 * not memoised: a later attempt may arrive after the network has recovered.
 */
export function loadDecoder(): Promise<JsQrFn> {
  if (loaded) return Promise.resolve(loaded);
  if (loading) return loading;
  loading = import("jsqr").then(
    (mod) => {
      // CJS interop: Vite and node both put module.exports (the function) on default.
      const fn: unknown = (mod as { default?: unknown }).default;
      if (typeof fn !== "function") {
        loading = null;
        throw new Error("decoder loaded but did not register");
      }
      loaded = fn as JsQrFn;
      return loaded;
    },
    () => {
      loading = null;
      throw new Error("could not load the QR reader");
    },
  );
  return loading;
}

function domFrameReader(): FrameReader | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  return {
    read(video, cw, ch) {
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      // ScanVideo is the slice of HTMLVideoElement we were handed; in the browser it is one.
      ctx.drawImage(video as unknown as CanvasImageSource, 0, 0, cw, ch);
      try { return ctx.getImageData(0, 0, cw, ch).data; } catch { return null; } // tainted canvas
    },
  };
}

const errorName = (e: unknown): unknown =>
  typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;

export function create(env: ScanEnv = {}): Scanner {
  let stream: ScanStream | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let video: ScanVideo | null = null;
  let reader: FrameReader | null = null;
  let jsqr: JsQrFn | null = null;
  let onCode: ((text: string) => void) | null = null;
  let stopped = true;
  let generation = 0;
  let detector: BarcodeDetectorLike | null = null; // BarcodeDetector when the platform has one
  let detecting = false; // one detect() in flight at a time

  function stopTracks(s: ScanStream | null): void {
    if (!s) return;
    try { s.getTracks().forEach((t) => t.stop()); } catch { /* a stopped stream has no remaining camera ownership */ }
  }

  function stop(): void {
    const wasLive = !stopped && !!stream;
    generation++;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (stream) {
      stopTracks(stream);
      stream = null;
    }
    if (video) { try { video.srcObject = null; } catch { /* element already detached */ } video = null; }
    onCode = null;
    detector = null;
    if (wasLive) netLog.info("scan stop");
  }

  // A decode that lands after stop() (the platform detect() is async and a
  // camera can be cut mid-frame) must deliver nothing and touch nothing.
  function found(gen: number, text: string | undefined): void {
    if (stopped || gen !== generation || !onCode || !text) return;
    const fn = onCode;
    stop();
    fn(text);
  }

  function tick(): void {
    if (stopped || !video || !onCode) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return; // first frames arrive with no size
    if (detector) {
      if (detecting) return; // never stack detect() calls
      detecting = true;
      const gen = generation;
      const det = detector;
      const v = video;
      Promise.resolve().then(() => det.detect(v)).then((codes) => {
        detecting = false;
        const hit = Array.isArray(codes) ? codes.find((c: DetectedBarcodeLike | null) => c && c.rawValue) : undefined;
        if (hit) found(gen, hit.rawValue);
      }, () => { detecting = false; }); // a detector throw is not a scan failure
      return;
    }
    if (!reader || !jsqr) return;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const data = reader.read(video, cw, ch);
    if (!data) return;
    let out: { data: string } | null = null;
    try { out = jsqr(data, cw, ch, { inversionAttempts: "dontInvert" }); } catch { return; } // a decoder throw is not a scan failure
    if (!out || !out.data) return;
    found(generation, out.data);
  }

  // Returns {ok:true} or {ok:false, error, message}: a refused camera is an
  // ordinary outcome (the player said no) and the caller falls back to paste.
  async function start(videoEl: ScanVideo, cb: (text: string) => void): Promise<ScanStartResult> {
    stop();
    const attempt = generation;
    const cancelled = (): ScanStartResult => ({ ok: false, error: "cancelled", message: "Camera scan cancelled." });
    const gum = env.getUserMedia === undefined ? globalGetUserMedia() : env.getUserMedia;
    if (typeof gum !== "function") {
      netLog.info("scan unsupported");
      return { ok: false, error: "unsupported", message: "This browser cannot use the camera, so paste the code instead." };
    }
    const platform = await platformDetector(env.BarcodeDetector === undefined ? globalBarcodeDetector() : env.BarcodeDetector);
    if (attempt !== generation) return cancelled();
    let decode: JsQrFn | null = null;
    if (!platform) {
      try { decode = await (env.loadDecoder ?? loadDecoder)(); } catch {
        if (attempt !== generation) return cancelled();
        netLog.warn("scan fail no_decoder");
        return { ok: false, error: "no_decoder", message: "Could not load the QR reader — paste the code instead." };
      }
      if (attempt !== generation) return cancelled();
    }
    let nextStream: ScanStream | null = null;
    try {
      nextStream = await gum({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      if (attempt !== generation) return cancelled();
      const name = errorName(e);
      const denied = name === "NotAllowedError" || name === "SecurityError";
      if (denied) netLog.info("scan denied");
      else netLog.warn("scan fail no_camera");
      return {
        ok: false,
        error: denied ? "denied" : "no_camera",
        message: denied
          ? "Camera access was refused. Allow it, or paste the code instead."
          : "No camera available — paste the code instead.",
      };
    }
    if (attempt !== generation) {
      stopTracks(nextStream);
      return cancelled();
    }
    stream = nextStream;
    stopped = false;
    video = videoEl;
    onCode = cb;
    detector = platform;
    detecting = false;
    jsqr = decode;
    if (!platform && !reader) reader = (env.createFrameReader ?? domFrameReader)();
    if (!platform && !reader) {
      stop();
      netLog.warn("scan fail no_canvas");
      return { ok: false, error: "no_canvas", message: "Could not start the QR reader — paste the code instead." };
    }
    videoEl.srcObject = stream;
    videoEl.setAttribute("playsinline", ""); // or iOS takes over the whole screen
    videoEl.muted = true;
    try { await videoEl.play(); } catch { /* autoplay policy; frames still arrive */ }
    if (attempt !== generation) {
      return cancelled();
    }
    timer = setInterval(tick, DECODE_EVERY_MS);
    netLog.info("scan start" + (platform ? " (BarcodeDetector)" : " (jsQR)"));
    return { ok: true };
  }

  return {
    start,
    stop,
    active: () => !stopped,
    decoder: () => (stopped ? null : detector ? "barcode" : "jsqr"),
  };
}
