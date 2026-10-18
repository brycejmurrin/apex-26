/* net-scan.test.ts — the camera QR reader without a camera.
 * Ports f1-game tests/unit/net-qr.test.mjs:115-198 (NetScan: platform decoder
 * first, jsQR as the fallback, stop() absolute) and the three scan tests in
 * tests/unit/async-lifecycle.test.mjs:199-277 (late stream, late play(),
 * decoder load not memoised). f1-game's phone-input-improvements scan tests
 * drive the phone pad and belong with that port. Platform seams arrive through
 * ScanEnv instead of stubbed globals, except where the global lookup itself is
 * under test.
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  create,
  loadDecoder,
  platformDetector,
  supported,
  type BarcodeDetectorCtor,
  type DetectedBarcodeLike,
  type ScanEnv,
  type ScanStream,
  type ScanVideo,
} from "../../src/net/scan";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

interface FakeTrack { stopped: number; stop(): void }
const fakeTrack = (): FakeTrack => ({ stopped: 0, stop() { this.stopped++; } });
const fakeVideo = (over: Partial<ScanVideo> = {}): ScanVideo => ({
  videoWidth: 4, videoHeight: 4, srcObject: null, muted: false, setAttribute() {}, play: async () => {}, ...over,
});

function detectorCtor(detect: (v: unknown) => Promise<readonly DetectedBarcodeLike[]>, formats: readonly string[] = ["qr_code"]): BarcodeDetectorCtor {
  return class {
    static async getSupportedFormats(): Promise<readonly string[]> { return formats; }
    constructor(_opts: { formats: string[] }) {}
    detect(v: unknown): Promise<readonly DetectedBarcodeLike[]> { return detect(v); }
  };
}

function scanWorld({ detector, formats, decode }: {
  detector?: (v: unknown) => Promise<readonly DetectedBarcodeLike[]>;
  formats?: readonly string[];
  decode?: () => { data: string } | null;
} = {}): { tracks: FakeTrack[]; stream: ScanStream; video: ScanVideo; env: ScanEnv } {
  const tracks = [fakeTrack(), fakeTrack()]; // a camera stream with more than one track
  const stream: ScanStream = { getTracks: () => tracks };
  const env: ScanEnv = {
    getUserMedia: async () => stream,
    BarcodeDetector: detector ? detectorCtor(detector, formats) : null,
    loadDecoder: async () => decode ?? (() => null),
    createFrameReader: () => ({ read: () => new Uint8ClampedArray(4 * 4 * 4) }),
  };
  return { tracks, stream, video: fakeVideo(), env };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("NetScan uses BarcodeDetector when the platform reads qr_code, and stops the camera on a hit", async () => {
  let calls = 0;
  const w = scanWorld({ detector: async () => (++calls < 2 ? [] : [{ rawValue: "APEX1.s.SCANNED" }]) });
  const sc = create(w.env);
  const got: string[] = [];
  expect((await sc.start(w.video, (t) => got.push(t))).ok).toBe(true);
  expect(sc.decoder()).toBe("barcode");
  await sleep(450);
  expect(got).toEqual(["APEX1.s.SCANNED"]);
  expect(sc.active(), "a hit stops the scan").toBe(false);
  expect(w.tracks.map((t) => t.stopped), "…and every camera track").toEqual([1, 1]);
  expect(w.video.srcObject).toBeNull();
  expect(calls >= 2 && calls <= 4, `detect() runs once per tick, never stacked (${calls})`).toBe(true);
});

test("a BarcodeDetector result landing after stop() delivers nothing", async () => {
  let release: ((v: readonly DetectedBarcodeLike[]) => void) | null = null;
  const w = scanWorld({ detector: () => new Promise((r) => { release = r; }) });
  const sc = create(w.env);
  const got: string[] = [];
  expect((await sc.start(w.video, (t) => got.push(t))).ok).toBe(true);
  await sleep(200);
  expect(release, "a detect() is in flight").not.toBeNull();
  sc.stop();
  (release as unknown as (v: readonly DetectedBarcodeLike[]) => void)([{ rawValue: "LATE" }]);
  await sleep(50);
  expect(got, "the late decode is dropped").toEqual([]);
  expect(w.tracks.map((t) => t.stopped)).toEqual([1, 1]);
});

test("without qr_code support (or without BarcodeDetector) NetScan falls back to jsQR", async () => {
  const w = scanWorld({ detector: async () => [{ rawValue: "NEVER" }], formats: ["ean_13"] });
  expect(await platformDetector(w.env.BarcodeDetector ?? null), "qr_code missing from the formats").toBeNull();
  const sc = create(w.env);
  const got: string[] = [];
  expect((await sc.start(w.video, (t) => got.push(t))).ok).toBe(true);
  expect(sc.decoder()).toBe("jsqr");
  await sleep(200);
  expect(got, "the platform detector was never consulted").toEqual([]);
  sc.stop();
  expect(w.tracks.map((t) => t.stopped)).toEqual([1, 1]);
  expect(sc.decoder()).toBeNull();
  expect(await platformDetector(null), "no BarcodeDetector at all").toBeNull();
});

test("the jsQR path decodes a frame through the injected decoder and stops", async () => {
  const seen: [number, number][] = [];
  const w = scanWorld({ decode: () => ({ data: "APEX1.s.JSQR" }) });
  w.env.createFrameReader = () => ({ read: (_v, cw, ch) => { seen.push([cw, ch]); return new Uint8ClampedArray(cw * ch * 4); } });
  w.video = fakeVideo({ videoWidth: 1280, videoHeight: 720 });
  const sc = create(w.env);
  const got: string[] = [];
  expect((await sc.start(w.video, (t) => got.push(t))).ok).toBe(true);
  await sleep(200);
  expect(got).toEqual(["APEX1.s.JSQR"]);
  expect(seen[0], "decoded at MAX_EDGE 640, aspect kept").toEqual([640, 360]);
  expect(w.tracks.map((t) => t.stopped)).toEqual([1, 1]);
});

test("platformDetector reads window.BarcodeDetector, and a throwing getSupportedFormats means jsQR", async () => {
  vi.stubGlobal("window", { BarcodeDetector: detectorCtor(async () => []) });
  expect(await platformDetector()).not.toBeNull();
  vi.stubGlobal("window", {});
  expect(await platformDetector()).toBeNull();
  const Throws = class { static getSupportedFormats(): Promise<readonly string[]> { return Promise.reject(new Error("policy")); } detect(): Promise<[]> { return Promise.resolve([]); } };
  expect(await platformDetector(Throws)).toBeNull();
});

test("supported() follows getUserMedia; without it start() reports unsupported", async () => {
  expect(supported({ getUserMedia: null })).toBe(false);
  expect(supported({ getUserMedia: async () => ({ getTracks: () => [] }) })).toBe(true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
  expect(supported()).toBe(true);
  vi.stubGlobal("navigator", {});
  expect(supported()).toBe(false);
  const r = await create({ getUserMedia: null }).start(fakeVideo(), () => {});
  expect(r.ok === false && r.error).toBe("unsupported");
});

test("a refused camera is 'denied', any other failure 'no_camera'", async () => {
  const fail = (name: string): ScanEnv => ({
    ...scanWorld().env,
    getUserMedia: () => Promise.reject(Object.assign(new Error(name), { name })),
  });
  const denied = await create(fail("NotAllowedError")).start(fakeVideo(), () => {});
  expect(denied.ok === false && denied.error).toBe("denied");
  const none = await create(fail("NotFoundError")).start(fakeVideo(), () => {});
  expect(none.ok === false && none.error).toBe("no_camera");
});

test("no decoder and no canvas are reported, and no_canvas still stops every track", async () => {
  const w = scanWorld();
  const noDec = await create({ ...w.env, loadDecoder: () => Promise.reject(new Error("offline")) }).start(fakeVideo(), () => {});
  expect(noDec.ok === false && noDec.error).toBe("no_decoder");
  const noCanvas = await create({ ...w.env, createFrameReader: () => null }).start(fakeVideo(), () => {});
  expect(noCanvas.ok === false && noCanvas.error).toBe("no_canvas");
  expect(w.tracks.map((t) => t.stopped)).toEqual([1, 1]);
});

test("a stopped QR attempt disposes a camera stream that arrives late", async () => {
  const media = deferred<ScanStream>(), requested = deferred<void>();
  const interval = vi.spyOn(globalThis, "setInterval");
  const track = fakeTrack();
  const sc = create({ ...scanWorld().env, getUserMedia: () => { requested.resolve(); return media.promise; } });
  const video = fakeVideo();
  const started = sc.start(video, () => {});
  await requested.promise;
  sc.stop();
  media.resolve({ getTracks: () => [track] });
  const r = await started;
  expect(r.ok === false && r.error).toBe("cancelled");
  expect(sc.active()).toBe(false);
  expect(track.stopped).toBe(1);
  expect(video.srcObject).toBeNull();
  expect(interval).not.toHaveBeenCalled();
});

test("a canceled QR attempt cannot arm an interval after video.play settles", async () => {
  const playing = deferred<void>(), playEntered = deferred<void>();
  const interval = vi.spyOn(globalThis, "setInterval");
  const w = scanWorld();
  const sc = create(w.env);
  const started = sc.start(fakeVideo({ play: () => { playEntered.resolve(); return playing.promise; } }), () => {});
  await playEntered.promise;
  sc.stop();
  playing.resolve();
  const r = await started;
  expect(r.ok === false && r.error).toBe("cancelled");
  expect(w.tracks.map((t) => t.stopped)).toEqual([1, 1]);
  expect(interval).not.toHaveBeenCalled();
});

test("the jsqr import is shared while in flight and resolves to the decoder", async () => {
  // f1-game's version of this test retried a script that loaded without
  // registering; with import() the module cache owns retries, so what is left
  // to check is the shared promise and that the npm package is the function.
  const a = loadDecoder();
  const b = loadDecoder();
  expect(a).toBe(b);
  const fn = await a;
  expect(typeof fn).toBe("function");
  expect(fn(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBeNull();
});

test("a decoder that loads without registering is not memoised, so a later start retries", async () => {
  vi.resetModules();
  vi.doMock("jsqr", () => ({ default: "not a function" }));
  try {
    const fresh = await import("../../src/net/scan");
    const first = fresh.loadDecoder();
    await expect(first).rejects.toThrow("decoder loaded but did not register");
    const second = fresh.loadDecoder();
    expect(second, "a fresh attempt, not the memoised rejection").not.toBe(first);
    await expect(second).rejects.toThrow("did not register");
    const r = await fresh.create({ ...scanWorld().env, loadDecoder: fresh.loadDecoder }).start(fakeVideo(), () => {});
    expect(r.ok === false && r.error).toBe("no_decoder");
  } finally {
    vi.doUnmock("jsqr");
    vi.resetModules();
  }
});
