// @vitest-environment happy-dom
/**
 * PHOTO STUDIO: src/camera/photo-studio.ts. Ports f1-game
 * tests/unit/photo-studio.test.mjs (camera borrowing, readback ordering,
 * bounded composition, cancellation, local persistence failure, the anchor /
 * native download paths), adds the apex-26 seams (an injected `capture` Blob
 * hook, `saveBlob`), a mount/unmount leak check, and holds the pure framing /
 * filename maths and the composed draw ops bit-for-bit against f1-game's
 * js/ui/photo-studio.js in node:vm, with a committed fixture for CI.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  canvasCapture, crop, filename, mountPhotoStudio, text,
  type IdbLike, type PhotoStudioDeps, type PhotoStudioMount, type StudioCar, type StudioConditions, type StudioFreeCam,
} from "../../../src/camera/photo-studio";
import type { FreeCamMount } from "../../../src/camera/free-cam";
import type { PhotoModeMount } from "../../../src/camera/photo-cam";
import type { Sample } from "../../../src/track/core/types";
import { leakProbe } from "./leak";
import { asJson, f1Vm, haveF1Photo, maybeWriteFixture, miniDom, readFixture, type MiniEl } from "./f1-photo-vm";
import { existsSync } from "node:fs";
import path from "node:path";
import { F1_ROOT } from "../data/f1-vm";

// Compile-time: the existing ports satisfy the studio's seams.
type Assert<T extends true> = T;
export type _FreeCamFits = Assert<FreeCamMount extends StudioFreeCam ? true : false>;
export type _PhotoCamFits = Assert<PhotoModeMount["photoCam"] extends NonNullable<PhotoStudioDeps["photoCam"]> ? true : false>;

type Op = unknown[];
/** The same recording 2D context in both realms (f1-game photo-studio.test.mjs:16-21, plus text/font). */
function fakeCtx(ops: Op[]): Record<string, unknown> {
  let font = "";
  return {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: { data: Uint8ClampedArray }) => ops.push(["pixels", image.data[0]]),
    drawImage: (...args: unknown[]) => ops.push(["draw", ...args.slice(1)]),
    fillRect: (...args: unknown[]) => ops.push(["caption", ...args]),
    fillText: (...args: unknown[]) => ops.push(["text", ...args]),
    fillStyle: "",
    get font() { return font; },
    set font(v: string) { font = v; ops.push(["font", v]); },
  };
}

interface BootOpts {
  encode?: (cb: (b: Blob | null) => void) => void;
  nullBlob?: boolean;
  priorCamera?: { open?: boolean } & Record<string, unknown>;
  priorPhoto?: boolean;
  player?: StudioCar | Record<string, unknown> | null;
  arc?: unknown;
  readback?: Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  storageFull?: boolean;
  requestAnimationFrame?: (fn: () => void) => unknown;
  indexedDB?: unknown;
  saveBlob?: (blob: Blob, name: string) => Promise<void>;
  bitmap?: () => Promise<ImageBitmap>;
  borrowCar?: (G: { player: unknown }) => () => void;
  capture?: PhotoStudioDeps["capture"];
  noGfx?: boolean;
}

const mounts: PhotoStudioMount[] = [];
const realCreate = document.createElement;
const unpatch = (): void => { delete (document as unknown as Record<string, unknown>)["createElement"]; };
afterEach(() => {
  for (const m of mounts.splice(0)) m.unmount();
  unpatch();
  document.body.replaceChildren(); document.body.className = "";
});

/** f1-game photo-studio.test.mjs:10-58 `boot`, over happy-dom. */
function boot(options: BootOpts = {}) {
  const order: string[] = [], downloads: string[] = [], canvasOps: Op[] = [], storage = new Map<string, string>();
  unpatch();
  document.createElement = function (this: Document, tag: string, o?: ElementCreationOptions) {
    const el = realCreate.call(document, tag, o) as HTMLElement & Record<string, unknown>;
    if (tag === "canvas") {
      el["getContext"] = () => fakeCtx(canvasOps);
      el["toDataURL"] = () => "data:image/jpeg;base64,ZmFrZQ==";
      el["toBlob"] = (cb: (b: Blob | null) => void) => options.encode ? options.encode(cb) : cb(options.nullBlob ? null : new Blob(["photo"], { type: "image/png" }));
    }
    if (tag === "a") el["click"] = () => downloads.push((el as unknown as HTMLAnchorElement).download);
    return el;
  } as typeof document.createElement;
  const gameCanvas = document.createElement("canvas"); gameCanvas.id = "game"; document.body.appendChild(gameCanvas);
  const overlay = document.createElement("div"); overlay.id = "overlay"; overlay.tabIndex = -1; document.body.appendChild(overlay);
  const fcInner = document.createElement("div"); fcInner.id = "freecam-inner"; document.body.appendChild(fcInner);
  let closed = 0, restored: unknown = null, overlays = true, current: unknown = options.priorCamera || { open: false };
  const G = {
    track: { name: "Monza", total: 1000 }, photoMode: !!options.priorPhoto,
    player: (options.player || null) as unknown, raceTimeOfDay: "day", raceWeather: "dry",
    photoCam: { pos: [1, 2, 3], yaw: 1, pitch: 0.3, fov: 60 },
    gfx: { capturePixels: (): Promise<{ width: number; height: number; data: Uint8ClampedArray }> => { order.push("read"); return options.readback || Promise.resolve({ width: 160, height: 90, data: new Uint8ClampedArray(160 * 90 * 4).fill(123) }); } } as Record<string, unknown>,
  };
  const conditions: StudioConditions = {
    timeOfDay(v?: string) { if (v !== undefined) G.raceTimeOfDay = v; return G.raceTimeOfDay; },
    weather(v?: string) { if (v !== undefined) { conditions.weatherArc = null; G.raceWeather = v; } return G.raceWeather; },
    weatherArc: options.arc || null,
  };
  const freeCam: StudioFreeCam = {
    state: () => current as { open?: boolean },
    setOverlaysVisible: (on) => { overlays = on; },
    enterFrom: () => { order.push("enter"); G.photoMode = true; return true; },
    panel: () => document.getElementById("freecam-inner"),
    close: (_pause, keep) => { closed++; order.push("close"); if (!keep) G.photoMode = false; },
    cmd: (v) => { current = v; restored = v; },
  };
  const garage = { snapshot: () => ({ az: 1, spin: true }), shot: (v: string) => order.push("shot:" + v), restore: (v: unknown) => { restored = v; order.push("restore"); } };
  const host = document.createElement("div"); document.body.appendChild(host);
  const api = mountPhotoStudio(host, {
    freeCam, garage, renderFrame: () => order.push("draw"),
    borrowCar: options.borrowCar ? () => options.borrowCar!(G) : null,
    photoMode: () => G.photoMode, photoCam: G.photoCam,
    track: () => G.track, player: () => G.player as StudioCar | null,
    conditions,
    sample: (_t, s, out: Sample) => { out.p = [s, 2, 0]; out.t = [1, 0, 0]; out.r = [0, .6, .8]; return out; }, // the right vector after banking
    banking: null,
    gfx: options.noGfx ? null : G.gfx,
    capture: options.capture || null,
    canvas: () => gameCanvas,
    saveBlob: options.saveBlob || null,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { if (options.storageFull) throw new Error("Quota"); storage.set(k, v); }, removeItem: (k) => { storage.delete(k); } },
    indexedDB: (options.indexedDB || null) as IdbLike | null,
    createImageBitmap: (options.bitmap || (async () => ({ width: 1024, height: 768, close: () => {} }) as unknown as ImageBitmap)) as NonNullable<PhotoStudioDeps["createImageBitmap"]>,
    requestAnimationFrame: options.requestAnimationFrame || ((fn) => fn()),
    win: { dispatchEvent: () => true },
  });
  mounts.push(api);
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
  return { api, order, downloads, canvasOps, G, conditions, storage, byId, gameCanvas, closed: () => closed, restored: () => restored, overlays: () => overlays };
}
const fire = (el: HTMLElement, type: string): void => { el.dispatchEvent(new Event(type, { bubbles: true })); };
const setSel = (el: HTMLElement, v: string): void => { (el as HTMLSelectElement).value = v; fire(el, "change"); };
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const kids = (el: Element): HTMLElement[] => Array.from(el.children) as HTMLElement[];

// One shared object store, with serialized transactions and staged writes
// (f1-game photo-studio.test.mjs:88-145, verbatim).
interface Row { id: string; at: number; title: string; thumb: string; blob: Blob }
interface FakeReq { result?: unknown; error?: Error; onsuccess?: () => void }
interface FakeTx { error: Error | null; abort?: () => void; oncomplete?: () => void; onabort?: () => void; onerror?: (e: unknown) => void; objectStore?: () => unknown }
function photoDb(seed: Row[] = []) {
  const rows = new Map(seed.map((row) => [row.id, row] as const)), failures: string[] = [];
  type Op1 = { kind: string; value: unknown; req: FakeReq };
  type State = { tx: FakeTx; mode: string; ops: Op1[]; held: ((v?: unknown) => void) | null };
  const queue: State[] = [];
  let active = false, hold: ((v?: unknown) => void) | null = null, release: (() => void) | null = null, writes = 0;
  const start = (): void => {
    if (active || !queue.length) return;
    active = true; const state = queue.shift()!, tx = state.tx;
    const staged = new Map(rows); let ended = false;
    const finish = (error?: Error | null): void => {
      if (ended) return; ended = true;
      if (error) { tx.error = error; if (tx.onabort) tx.onabort(); }
      else {
        if (state.mode === "readwrite") { rows.clear(); for (const [k, v] of staged) rows.set(k, v); }
        if (tx.oncomplete) tx.oncomplete();
      }
      active = false; start();
    };
    tx.abort = () => finish(tx.error || new Error("Transaction aborted"));
    const step = (): void => {
      if (ended) return;
      const op = state.ops.shift();
      if (!op) {
        if (failures[0] === "commit" && state.mode === "readwrite") { failures.shift(); finish(new Error("Injected commit failure")); return; }
        if (state.held) { release = () => finish(); state.held(); }
        else finish();
        return;
      }
      if (failures[0] === op.kind) {
        failures.shift(); op.req.error = new Error("Injected " + op.kind + " failure");
        if (tx.onerror) tx.onerror({ target: op.req });
        setImmediate(() => finish(op.req.error)); return;
      }
      op.req.result = op.kind === "getAll" ? [...staged.values()] : op.kind === "put" ? (staged.set((op.value as Row).id, op.value as Row), (op.value as Row).id) : (staged.delete(op.value as string), undefined);
      if (op.req.onsuccess) op.req.onsuccess();
      setImmediate(step);
    };
    setImmediate(step);
  };
  const db = { close() {}, transaction(_store: string, mode: string) {
    const tx: FakeTx = { error: null }, state: State = { tx, mode, ops: [], held: mode === "readwrite" ? hold : null };
    if (mode === "readwrite") { writes++; hold = null; }
    const request = (kind: string, value?: unknown): FakeReq => {
      if (kind === "delete" && failures[0] === "delete-sync") { failures.shift(); throw new Error("Injected delete enqueue failure"); }
      const req: FakeReq = {}; state.ops.push({ kind, value, req }); return req;
    };
    tx.objectStore = () => ({ getAll: () => request("getAll"), put: (v: unknown) => request("put", v), delete: (v: unknown) => request("delete", v) });
    queue.push(state); setImmediate(start); return tx;
  } };
  return {
    rows, get writes() { return writes; }, failNext(kind: string) { failures.push(kind); },
    holdNextCommit() { return new Promise((resolve) => { hold = resolve; }); },
    releaseCommit() { const done = release!; release = null; done(); },
    open() { const req: { result: unknown; onsuccess?: () => void } = { result: db }; queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); }); return req; },
  };
}
const seededPhotos = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: "old-" + i, at: i, title: "Old " + i, thumb: "data:image/jpeg;base64,ZmFrZQ==", blob: new Blob(["old"]) }));

describe("PhotoStudio (photo-studio.test.mjs)", () => {
  it("Home circuit photo borrows a subject, places its complete pose, and returns ownership", () => {
    const prior = { px: 88 }, subject = {} as StudioCar;
    let released = 0;
    const { api, G, byId, restored } = boot({ player: prior, borrowCar: (g) => {
      g.player = subject;
      return () => { g.player = prior; released++; };
    } });
    api.open({ source: "home-track" });
    expect(api.hasCar()).toBe(true);
    for (const [id, value] of [["ps-car-position", "25"], ["ps-car-offset", "3"], ["ps-car-rotation", "90"]] as const) {
      const view = JSON.stringify(restored());
      byId<HTMLInputElement>(id).value = value;
      fire(byId(id), "input");
      if (id === "ps-car-rotation") expect(JSON.stringify(restored()), "rotating the car preserves the composed camera").toBe(view);
    }
    expect(subject.s).toBe(250); expect(subject.x).toBe(3);
    expect(subject.px).toBe(250); expect(subject.pz).toBe(3);
    expect(subject.head).toBe(0); expect(subject.yawVis).toBe(Math.PI / 2);
    for (const [a, b] of [["rPrevS", "s"], ["rPrevX", "x"], ["rPrevPx", "px"], ["rPrevPz", "pz"], ["rPrevYawVis", "yawVis"], ["rPrevHead", "head"]] as const) {
      expect(subject[a], "no interpolation from a stale " + b).toBe(subject[b]);
    }
    api.close(false); api.close(false);
    expect(released).toBe(1); expect(G.player).toBe(prior); expect(api.hasCar()).toBe(false);
    expect(prior).toEqual({ px: 88 });
    api.open({ source: "race" });
    expect(api.hasCar()).toBe(false); expect(G.player).toBe(prior);
  });

  it("centre crops preserve composition across aspect ratios and filenames stay safe", () => {
    expect(plain(crop(1600, 900, "square"))).toEqual({ x: 350, y: 0, width: 900, height: 900 });
    expect(plain(crop(1600, 900, "portrait"))).toEqual({ x: 440, y: 0, width: 720, height: 900 });
    expect(crop(1600, 900, "scene").width).toBe(1600);
    expect(filename("../../My <Monza> Photo!")).toBe("apex26-my-monza-photo.png");
  });

  it("capture draws before reading a live backbuffer, omits DOM overlays and downloads actual image", async () => {
    const b = boot(); expect(b.api.open({ source: "race" })).toBe(true);
    expect(await b.api.capture()).toBe(true);
    expect(b.order.slice(-2)).toEqual(["draw", "read"]);
    expect(b.canvasOps[0]![0]).toBe("pixels"); expect(b.canvasOps[0]![1]).toBe(123);
    expect(b.api.state().captured).toBe(true);
    await b.api.exportPhoto(); expect(b.downloads).toEqual(["apex26-photo.png"]);
    b.api.close(true); expect(b.closed()).toBe(1); expect(b.G.photoMode).toBe(false);
  });

  it("native photo export awaits the share outcome and reports a cancelled or failed download", async () => {
    for (const outcome of ["success", "cancel", "failure"]) {
      let resolve!: () => void, reject!: (e: Error) => void, saved: { blob: Blob; name: string } | null = null, calls = 0;
      const held = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const b = boot({ saveBlob: (blob, name) => { calls++; saved = { blob, name }; return calls === 1 ? held : Promise.resolve(); } });
      b.api.open(); await b.api.capture();
      const pending = b.api.exportPhoto();
      await b.api.exportPhoto();
      await turn();
      expect(saved!.name).toBe("apex26-photo.png");
      expect(await saved!.blob.text()).toBe("photo");
      expect(b.byId("ps-message").textContent).not.toMatch(/download requested/i);
      expect(b.downloads).toEqual([]);
      expect(calls, "a second tap must not overlap the native chooser").toBe(1);
      expect(b.api.state().busy, "download does not take ownership of capture/close busy state").toBe(false);
      expect(b.byId<HTMLButtonElement>("ps-close").disabled).toBe(false);
      if (outcome === "success") resolve(); else reject(new Error(outcome === "cancel" ? "Share canceled" : "disk full"));
      await pending;
      expect(b.byId("ps-message").textContent).toMatch(outcome === "success" ? /PNG download requested/ : outcome === "cancel" ? /Download failed: Share canceled/ : /Download failed: disk full/);
      await b.api.exportPhoto();
      expect(calls, "settlement allows a later export after success, cancellation, or failure").toBe(2);
      mounts.pop()!.unmount(); unpatch(); document.body.replaceChildren();
    }
  });

  it("library DOWNLOAD shares the in-flight guard with PNG export and permits retry after a cancelled share", async () => {
    let reject!: (e: Error) => void, calls = 0;
    const held = new Promise<void>((_resolve, no) => { reject = no; });
    const b = boot({ saveBlob: () => { calls++; return calls === 1 ? held : Promise.resolve(); } });
    b.api.open({ source: "garage" }); await b.api.capture(); await b.api.savePhoto();
    const row = kids(b.byId("ps-library"))[0]!;
    const download = kids(row).find((child) => child.textContent === "DOWNLOAD")!;
    download.click(); download.click();
    await b.api.exportPhoto();
    expect(calls, "library double taps and the PNG action cannot overlap native sharing").toBe(1);
    expect(b.byId<HTMLButtonElement>("ps-close").disabled).toBe(false);
    reject(new Error("Share canceled")); await turn();
    expect(b.byId("ps-message").textContent).toMatch(/Download failed: Share canceled/);
    download.click(); await turn();
    expect(calls).toBe(2);
    expect(b.byId("ps-message").textContent).toMatch(/Photo download requested/);
  });

  it("closing and reopening during a photo export stays usable and ignores stale completion feedback", async () => {
    let finish!: () => void, calls = 0;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const b = boot({ saveBlob: () => { calls++; return calls === 1 ? held : Promise.resolve(); } });
    b.api.open({ source: "garage" }); await b.api.capture();
    const pending = b.api.exportPhoto(); await turn();
    b.api.close(false); b.api.open({ source: "garage" }); await b.api.capture();
    const message = b.byId("ps-message").textContent;
    await b.api.exportPhoto();
    expect(calls, "the original chooser remains the in-flight download across reopen").toBe(1);
    finish(); await pending;
    expect(b.byId("ps-message").textContent).toBe(message);
    expect(b.api.state().busy).toBe(false);
    await b.api.exportPhoto();
    expect(calls).toBe(2);
  });

  it("software presentation is awaited while raw pixels are captured before compositing", async () => {
    const b = boot(); let present!: (v?: unknown) => void;
    b.G.gfx["softPresent"] = () => true;
    b.G.gfx["invalidateSoftPresent"] = () => b.order.push("invalidate");
    b.G.gfx["awaitSoftPresent"] = () => { b.order.push("wait"); return new Promise((resolve) => { present = resolve; }); };
    b.api.open(); const pending = b.api.capture();
    expect(b.order.slice(-4)).toEqual(["invalidate", "wait", "draw", "read"]);
    expect(b.canvasOps.length, "composition waits for the presentation result").toBe(0); present(); await pending;
    expect(b.order.at(-1)).toBe("read");
  });

  it("a backend without readback falls back to an immediate canvas copy", async () => {
    const b = boot(); b.gameCanvas.width = 160; b.gameCanvas.height = 90;
    b.G.gfx["capturePixels"] = () => { b.order.push("read-unavailable"); return Promise.reject(new Error("No readback target")); };
    b.api.open(); expect(await b.api.capture()).toBe(true);
    expect(b.order.slice(-3)).toEqual(["draw", "read-unavailable", "draw"]);
    expect(b.canvasOps[0]![0]).toBe("draw");
  });

  it("closing while readback is pending prevents an obsolete capture entering a reopened studio", async () => {
    let resolve!: (v: { width: number; height: number; data: Uint8ClampedArray }) => void;
    const b = boot({ readback: new Promise((r) => { resolve = r; }) });
    b.api.open(); const pending = b.api.capture(); b.api.close(false); b.api.open({ source: "garage" });
    resolve({ width: 160, height: 90, data: new Uint8ClampedArray(160 * 90 * 4) });
    expect(await pending).toBe(false); expect(b.api.state().captured).toBe(false); expect(b.api.state().busy).toBe(false);
  });

  it("a delayed save retains its original photo and cannot clear a reopened capture's busy state", async () => {
    let encode!: (b: Blob | null) => void, read!: (v: unknown) => void;
    const b = boot({ encode: (cb) => { encode = cb; } });
    b.api.open({ metadata: { title: "Old Monza photo" } }); await b.api.capture();
    const saved = b.api.savePhoto();
    b.api.close(false); b.api.open({ source: "garage", metadata: { title: "New garage" } }); await turn();
    const libraryBefore = kids(b.byId("ps-library"))[0];
    b.G.gfx["capturePixels"] = () => new Promise((r) => { read = r; });
    const captured = b.api.capture();
    encode(new Blob(["old photo"], { type: "image/jpeg" })); await saved;
    expect(b.api.state().busy, "old finally cannot enable a new operation's buttons").toBe(true);
    expect(b.byId("ps-message").textContent).toMatch(/Capturing/);
    expect(kids(b.byId("ps-library"))[0], "old save cannot repaint the current library").toBe(libraryBefore);
    read({ width: 160, height: 90, data: new Uint8ClampedArray(160 * 90 * 4) }); await captured;
    b.api.close(false); b.api.open({ source: "garage" }); await turn();
    expect(kids(kids(b.byId("ps-library"))[0]!)[1]!.textContent, "persisted entry retains its initiating context").toBe("Old Monza photo");
  });

  it("garage camera snapshot is restored and a borrowed FreeCam returns only on normal exit", () => {
    const garage = boot(); garage.api.open({ source: "garage" }); garage.api.close(true);
    expect(plain(garage.restored())).toEqual({ az: 1, spin: true }); expect(garage.closed()).toBe(0);
    const prior = { open: true, speed: 25, roll: 5, lens: "flyby", eye: [1, 2, 3], target: [4, 5, 6], fov: 40 };
    const b = boot({ priorCamera: prior }); b.api.open(); b.api.close(true);
    expect(b.restored()).toBe(prior); expect(b.closed()).toBe(0);
    b.api.open(); b.api.close(false); expect(b.closed(), "lifecycle teardown must hand ownership back to the game").toBe(1);
  });

  it("pre-existing photo mode keeps its pose on normal exit", () => {
    const b = boot({ priorPhoto: true }); b.api.open(); b.G.photoCam.pos[0] = 99; b.api.close(true);
    expect(b.G.photoMode).toBe(true); expect(b.G.photoCam.pos).toEqual([1, 2, 3]);
  });

  it("DONE paints a busy state before restoring the scene (Escape door stays live)", () => {
    const frames: (() => void)[] = [], events: string[] = [];
    const b = boot({ requestAnimationFrame: (fn) => frames.push(fn) });
    b.api.open({ source: "garage", back: () => {
      events.push(document.body.classList.contains("photo-studio-open") ? "class-on" : "class-off");
      events.push(b.byId("photo-studio").hidden ? "hidden" : "visible");
      events.push("restored");
    } });
    b.api.close(true);
    expect(b.api.state().busy).toBe(true);
    expect(b.byId<HTMLButtonElement>("ps-close").disabled, "DONE stays the Escape door while CLOSING… paints").toBe(false);
    expect(b.byId("ps-close").textContent).toBe("CLOSING…");
    expect(b.byId("ps-panel").getAttribute("aria-busy")).toBe("true");
    expect(b.byId("photo-studio").hidden, "studio stays up so CLOSING… can paint").toBe(false);
    expect(document.body.classList.contains("photo-studio-open")).toBe(true);
    expect(events).toEqual([]);
    expect(b.order.includes("restore")).toBe(false);
    // A second DONE/Escape during CLOSING… must no-op (st.closing guard), not hang.
    b.api.close(true);
    expect(frames.length, "a second close while closing does not queue another restore").toBe(1);
    frames.shift()!();
    expect(b.order.includes("restore")).toBe(true);
    expect(events, "portrait rotate-device can read display after photo-studio-open is gone").toEqual(["class-off", "hidden", "restored"]);
    expect(b.byId("photo-studio").hidden).toBe(true);
    expect(b.api.state().busy).toBe(false);
    expect(b.byId("ps-close").textContent).toBe("DONE");
  });

  it("queued opener focus cannot steal focus from a reopened Studio or a detached caller", () => {
    const frames: (() => void)[] = [], b = boot({ requestAnimationFrame: (fn) => frames.push(fn) });
    const opener = document.createElement("button"); document.body.appendChild(opener); opener.focus();
    b.api.open({ source: "home" }); b.api.close(true); frames.shift()!(); frames.shift()!(); b.api.open({ source: "garage" });
    while (frames.length) frames.shift()!();
    expect(document.activeElement === b.byId("ps-close"), "reopening between frames cancels opener focus").toBe(true);
    b.api.close(false); opener.focus(); b.api.open({ source: "home" }); b.api.close(true); frames.shift()!();
    b.api.open({ source: "garage" }); b.api.close(false); b.byId("overlay").focus();
    while (frames.length) frames.shift()!();
    expect(document.activeElement === b.byId("overlay"), "a new generation invalidates focus even after it closes").toBe(true);
    b.api.close(false); opener.focus(); b.api.open({ source: "home" }); b.api.close(true); frames.shift()!(); opener.remove();
    while (frames.length) frames.shift()!();
    expect(document.activeElement === b.byId("ps-close"), "a detached opener is no longer a focus target").toBe(true);
  });

  it("DONE returns focus to the opener after two frames", () => {
    const frames: (() => void)[] = [], b = boot({ requestAnimationFrame: (fn) => frames.push(fn) });
    const opener = document.createElement("button"); document.body.appendChild(opener); opener.focus();
    b.api.open({ source: "home" });
    expect(document.activeElement).toBe(b.byId("ps-close"));
    b.api.close(true); frames.shift()!();
    expect(frames.length).toBe(1); frames.shift()!();
    expect(frames.length, "only one further frame is scheduled").toBe(1); frames.shift()!();
    expect(document.activeElement).toBe(opener);
  });

  it("an import finishing after close is discarded and its bitmap is released", async () => {
    let resolve!: (v: ImageBitmap) => void, disposed = 0;
    const b = boot({ bitmap: () => new Promise((r) => { resolve = r; }) }); b.api.open({ source: "garage" });
    const file = b.byId<HTMLInputElement>("ps-import");
    Object.defineProperty(file, "files", { configurable: true, value: [{ type: "image/jpeg", size: 1000 }] });
    fire(file, "change");
    b.api.close(false); b.api.open({ source: "garage" });
    resolve({ width: 1024, height: 768, close: () => disposed++ } as unknown as ImageBitmap); await turn();
    expect(disposed).toBe(1); expect(b.api.state().captured).toBe(false); expect(b.api.state().busy).toBe(false);
  });

  it("missing IndexedDB uses a visit-only library and localStorage quota failure remains recoverable", async () => {
    const b = boot({ storageFull: true }); b.api.open({ source: "garage" }); await b.api.capture(); await b.api.savePhoto();
    expect(b.byId("ps-message").textContent).toMatch(/this visit/);
    expect(b.byId("ps-library").children.length).toBe(1);
    expect(b.api.setBackground("data:image/jpeg;base64,ZmFrZQ==")).toBe(false);
    expect(b.api.setBackground("javascript:alert(1)")).toBe(false);
    expect(b.api.state().busy).toBe(false);
  });

  it("background round-trips through a26.photoBackground and rejects anything but a small image data URL", () => {
    const b = boot();
    expect(b.api.setBackground("data:image/png;base64,QUJD")).toBe(true);
    expect(b.storage.get("a26.photoBackground")).toBe("data:image/png;base64,QUJD");
    expect(b.api.background()).toBe("data:image/png;base64,QUJD");
    expect(b.api.setBackground("data:image/png;base64," + "A".repeat(240000))).toBe(false);
    expect(b.api.setBackground("")).toBe(true); expect(b.api.background()).toBe("");
  });

  it("failed PNG encoding reports a recoverable error instead of creating a bogus download", async () => {
    const b = boot({ nullBlob: true }); b.api.open(); await b.api.capture(); await b.api.exportPhoto();
    expect(b.downloads.length).toBe(0); expect(b.byId("ps-message").textContent).toMatch(/could not be encoded/);
  });

  it("Studio uses canonical sheet regions and enumerated controls with a persistent capture/done footer", () => {
    const b = boot(); b.api.open();
    const panel = b.byId("ps-panel"), body = b.byId("ps-body");
    expect(kids(panel).map((el) => el.className)).toEqual(["sheet-head", "sheet-body pane", "sheet-foot"]);
    expect(b.byId("ps-close").parentElement).toBe(kids(panel)[2]);
    expect(b.byId("ps-capture").parentElement).toBe(kids(panel)[2]);
    expect(b.byId("ps-capture").classList.contains("bigbtn")).toBe(true);
    expect(body.contains(b.byId("ps-export"))).toBe(true);
    setSel(b.byId("ps-aspect"), "portrait");
    expect(b.api.state().aspect).toBe("portrait");
    b.byId("ps-aspect-row-next").click(); expect(b.api.state().aspect).toBe("scene");
    setSel(b.byId("ps-postcard"), "on");
    expect(b.api.state().postcard).toBe(true);
    expect(b.byId("photo-studio").dataset["escClose"]).toBe("ps-close");
  });

  it("Studio suspends a borrowed FreeCam's guides and restores them on returning to its owner", () => {
    const b = boot({ priorCamera: { open: true } }); b.api.open();
    expect(b.overlays()).toBe(false); expect(b.byId("freecam-inner").hidden).toBe(true);
    b.api.close(true); expect(b.overlays()).toBe(true); expect(b.byId("freecam-inner").hidden).toBe(false);
  });

  it("concurrent Studio saves in separate instances keep exactly six durable photos", async () => {
    const idb = photoDb(seededPhotos(6)), a = boot({ indexedDB: idb });
    const bApi = boot({ indexedDB: idb });
    a.api.open({ metadata: { title: "Tab A" } });
    // Two mounts in one document share ids; drive the second through its API only.
    bApi.api.open({ metadata: { title: "Tab B" } });
    await Promise.all([a.api.capture(), bApi.api.capture()]);
    await Promise.all([a.api.savePhoto(), bApi.api.savePhoto()]);
    expect(idb.rows.size).toBe(6);
    expect(idb.writes, "each save has one atomic write transaction").toBe(2);
    expect([...idb.rows.values()].filter((row) => /^Tab /.test(row.title)).map((row) => row.title).sort()).toEqual(["Tab A", "Tab B"]);
    expect(idb.rows.has("old-0")).toBe(false); expect(idb.rows.has("old-1")).toBe(false);
  });

  it("saving repairs a previously oversized library in the same transaction", async () => {
    const idb = photoDb(seededPhotos(9)), b = boot({ indexedDB: idb });
    b.api.open(); await b.api.capture(); await b.api.savePhoto();
    expect(idb.rows.size).toBe(6); expect(idb.writes).toBe(1);
    expect([...idb.rows.keys()].filter((id) => id.startsWith("old-")).sort()).toEqual(["old-4", "old-5", "old-6", "old-7", "old-8"]);
  });

  it("save remains busy and unannounced until the write transaction commits", async () => {
    const idb = photoDb(seededPhotos(6)), b = boot({ indexedDB: idb });
    b.api.open(); await b.api.capture(); const held = idb.holdNextCommit(), saving = b.api.savePhoto(); await held;
    expect(b.api.state().busy).toBe(true); expect(b.byId("ps-message").textContent).not.toMatch(/Saved to My Photos/);
    expect([...idb.rows.keys()], "request success has not changed durable rows").toEqual(seededPhotos(6).map((p) => p.id));
    idb.releaseCommit(); await saving;
    expect(b.api.state().busy).toBe(false); expect(b.byId("ps-message").textContent).toMatch(/Saved to My Photos/);
  });

  it("put, prune, and commit failures roll back all durable changes and retain a visit-only photo", async () => {
    for (const failure of ["put", "delete", "delete-sync", "commit"]) {
      const seed = seededPhotos(6), idb = photoDb(seed), b = boot({ indexedDB: idb });
      b.api.open(); await b.api.capture(); idb.failNext(failure); await b.api.savePhoto();
      expect([...idb.rows.keys()], failure + " cannot commit a partial save or prune").toEqual(seed.map((p) => p.id));
      expect(b.byId("ps-message").textContent).toMatch(/Saved for this visit/);
      expect(b.api.state().busy).toBe(false);
      expect(kids(kids(b.byId("ps-library"))[0]!)[1]!.textContent).toBe("Photo");
      mounts.pop()!.unmount(); unpatch(); document.body.replaceChildren();
    }
  });

  it("equal timestamps prune deterministically by ID instead of request or enumeration order", async () => {
    const seed = seededPhotos(8).map((row) => ({ ...row, at: 1 })).reverse(), idb = photoDb(seed), b = boot({ indexedDB: idb });
    b.api.open(); await b.api.capture(); await b.api.savePhoto();
    expect([...idb.rows.keys()].filter((id) => id.startsWith("old-")).sort()).toEqual(["old-3", "old-4", "old-5", "old-6", "old-7"]);
  });

  it("a committed save from a closed Studio retains its original metadata without touching a reopened session", async () => {
    const idb = photoDb(), b = boot({ indexedDB: idb });
    b.api.open({ metadata: { title: "Earlier session" } }); await b.api.capture();
    const held = idb.holdNextCommit(), saving = b.api.savePhoto(); await held;
    b.api.close(false); b.api.open({ source: "garage", metadata: { title: "Current session" } });
    let read!: (v: unknown) => void; b.G.gfx["capturePixels"] = () => new Promise((resolve) => { read = resolve; });
    const capturing = b.api.capture(); idb.releaseCommit(); await saving;
    expect([...idb.rows.values()][0]!.title).toBe("Earlier session");
    expect(b.api.state().busy).toBe(true); expect(b.byId("ps-message").textContent).toMatch(/Capturing/);
    read({ width: 160, height: 90, data: new Uint8ClampedArray(160 * 90 * 4) }); await capturing;
  });

  it("the SUBJECT row shows only when the door offers one, and hands the other pick back without changing anything itself", () => {
    const b = boot(), picks: string[] = [];
    const group = b.byId("ps-subject-row").parentElement!, sel = b.byId<HTMLSelectElement>("ps-subject");
    expect(b.api.open({ source: "garage" })).toBe(true);
    expect(group.hidden, "a garage or race door offers no subject").toBe(true);
    expect(b.api.state().subject).toBe(false);
    b.api.close(false);
    expect(b.api.open({ source: "home", subject: (v) => { picks.push(v); return Promise.resolve(true); } })).toBe(true);
    expect(group.hidden).toBe(false);
    expect(b.api.state().subject).toBe(true);
    expect(sel.value, "a Home garage opens on GARAGE").toBe("garage");
    setSel(sel, "garage");
    expect(picks, "re-picking the shown subject is not a switch").toEqual([]);
    setSel(sel, "circuit");
    expect(picks, "the pick goes to the door; the studio swaps nothing itself").toEqual(["circuit"]);
    expect(b.api.state().source, "still open on the garage until the door reopens it").toBe("home");
    b.api.close(false);
    expect(b.api.open({ source: "home-track", subject: (v) => { picks.push(v); return Promise.resolve(true); } })).toBe(true);
    expect(sel.value, "a Home circuit opens on CIRCUIT").toBe("circuit");
    b.api.close(false);
    expect(b.api.open({ source: "race" })).toBe(true);
    expect(group.hidden, "the pause-menu door (already on the circuit) offers no subject").toBe(true);
    b.api.close(false);
  });

  it("leaks #1: closing the studio releases the composed canvas and its preview source", async () => {
    const b = boot(); expect(b.api.open({ source: "race" })).toBe(true);
    expect(await b.api.capture()).toBe(true);
    const preview = b.byId<HTMLImageElement>("ps-preview");
    expect(preview.getAttribute("src"), "preview holds the thumbnail while open").toBeTruthy(); expect(b.api.state().captured).toBe(true);
    b.api.close(true);
    expect(b.api.state().captured, "`last` canvas is dropped").toBe(false);
    expect(preview.hasAttribute("src"), "the ~640x360 JPEG data URL is dropped").toBe(false); expect(preview.hidden).toBe(true);
    await b.api.exportPhoto(); expect(b.downloads, "nothing left to export after close").toEqual([]);
  });

  it("deferred capture keeps its requested composition; recrop retains the uncropped frame", async () => {
    let resolve!: (v: { width: number; height: number; data: Uint8ClampedArray }) => void;
    const b = boot({ readback: new Promise((r) => { resolve = r; }) });
    b.api.open({ metadata: { title: "Requested moment" } });
    const pending = b.api.capture();
    setSel(b.byId("ps-aspect"), "portrait"); setSel(b.byId("ps-postcard"), "on");
    resolve({ width: 160, height: 90, data: new Uint8ClampedArray(160 * 90 * 4) });
    expect(await pending).toBe(true);
    expect(b.byId("ps-message").textContent).toMatch(/160 × 90/);
    expect(b.canvasOps.some((op) => op[0] === "caption")).toBe(false);
    const aspect = b.byId("ps-aspect"); setSel(aspect, "square"); setSel(aspect, "portrait");
    expect(b.canvasOps.some((op) => op[0] === "draw" && op[1] === 44 && op[3] === 72)).toBe(true);
    setSel(aspect, "wide");
    expect(b.canvasOps.some((op) => op[0] === "draw" && op[1] === 0 && op[3] === 160), "wide recrop recovers both clipped sides").toBe(true);
    b.api.close(false); const count = b.canvasOps.length;
    setSel(aspect, "square");
    expect(b.canvasOps.length, "close releases the recrop source").toBe(count);
  });

  it("coaching is optional DOM content; presets cannot move a pending capture", async () => {
    let resolve!: (v: { width: number; height: number; data: Uint8ClampedArray }) => void;
    const b = boot({ readback: new Promise((r) => { resolve = r; }) });
    b.api.open({ source: "garage" }); const pending = b.api.capture();
    kids(b.byId("ps-shots"))[1]!.click();
    expect(b.order.some((s) => s.startsWith("shot:"))).toBe(false);
    const coach = b.byId("ps-coach"); kids(coach)[coach.children.length - 1]!.click();
    expect(coach.hidden).toBe(true);
    resolve({ width: 160, height: 90, data: new Uint8ClampedArray(160 * 90 * 4) }); await pending;
    b.api.close(false); b.api.open({ source: "garage" }); expect(coach.hidden).toBe(true);
  });

  it("contact sheet captures three sequential renderer frames and labels one bounded PNG", async () => {
    const b = boot(); const times: number[] = [], captureTimes = [1, 2, 3];
    expect(await b.api.contactSheet(captureTimes, (t) => times.push(t), () => false)).toBe(true);
    expect(times).toEqual(captureTimes); expect(b.order.filter((s) => s === "read").length).toBe(3);
    expect(b.downloads).toEqual(["apex26-replay-moment.png"]);
    expect(b.canvasOps.filter((op) => op[0] === "caption").length).toBe(3);
    expect(await b.api.contactSheet(captureTimes, () => {}, () => true).catch(() => false)).toBe(false);
    expect(b.downloads.length, "cancel does not download").toBe(1);
  });

  for (const outcome of ["success", "write failure", "share cancellation"]) it("contact sheet awaits native export " + outcome, async () => {
    let resolve!: () => void, reject!: (e: Error) => void, calls = 0, saved: { blob: Blob; name: string } | null = null, settled = false;
    const held = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const b = boot({ saveBlob: (blob, name) => { calls++; saved = { blob, name }; return held; } });
    const pending = b.api.contactSheet([1, 2, 3], () => {}, () => false);
    pending.then(() => { settled = true; }, () => { settled = true; });
    await turn();
    expect(calls).toBe(1);
    expect(saved!.name).toBe("apex26-replay-moment.png");
    expect(await saved!.blob.text()).toBe("photo");
    expect(b.downloads, "native export must not fall back to an anchor").toEqual([]);
    expect(settled, "contact-sheet completion must wait for native saving and sharing").toBe(false);
    if (outcome === "success") {
      resolve();
      expect(await pending).toBe(true);
    } else {
      const error = new Error(outcome === "share cancellation" ? "Share canceled" : "disk full");
      const rejected = expect(pending).rejects.toBe(error);
      reject(error);
      await rejected;
    }
    expect(settled).toBe(true);
  });

  it("album exposes bounded safe read-only thumbnails and recovers with visit photos", async () => {
    const db = photoDb(seededPhotos(8)); const b = boot({ indexedDB: { open: () => db.open() } });
    const rows = await b.api.album(); expect(rows.length).toBe(6);
    expect(Object.keys(rows[0]!).sort()).toEqual(["at", "id", "thumb", "title"]);
    expect(Object.isFrozen(rows[0])).toBe(true);
    mounts.pop()!.unmount(); unpatch(); document.body.replaceChildren();
    const fallback = boot(); await expect(fallback.api.album()).rejects.toThrow(/storage unavailable/);
    fallback.api.open(); await fallback.api.capture(); await fallback.api.savePhoto();
    expect((await fallback.api.album()).length).toBe(1);
  });

  it("Studio state exposes monotonic session generation across same-open reentry", () => {
    const b = boot(); b.api.open(); const first = b.api.state();
    expect(first.open).toBe(true); expect(typeof first.generation).toBe("number");
    b.api.close(false); b.api.open(); const next = b.api.state();
    expect(next.open).toBe(first.open); expect(next.generation).toBeGreaterThan(first.generation);
  });

  it("Time & weather preview changes the session live and every reset or close restores it, arc included", () => {
    const arc = { from: "dry", to: "rain" };
    const { api, G, conditions, byId } = boot({ arc });
    api.open({ source: "race" });
    const group = byId("ps-tod").closest("section")!;
    expect(group.hidden).toBe(false);
    const reset = byId<HTMLButtonElement>("ps-cond-reset");
    expect(reset.disabled, "nothing to reset until a condition changes").toBe(true);
    setSel(byId("ps-tod"), "night"); setSel(byId("ps-weather"), "storm");
    expect([G.raceTimeOfDay, G.raceWeather, conditions.weatherArc]).toEqual(["night", "storm", null]);
    expect(reset.disabled).toBe(false);
    reset.click();
    expect([G.raceTimeOfDay, G.raceWeather, conditions.weatherArc]).toEqual(["day", "dry", arc]);
    setSel(byId("ps-tod"), "dusk");
    api.close(false);
    expect([G.raceTimeOfDay, G.raceWeather, conditions.weatherArc]).toEqual(["day", "dry", arc]);
  });

  it("Time & weather group stays out of the garage subject", () => {
    const { api, G, byId } = boot({});
    api.open({ source: "garage" });
    expect(byId("ps-tod").closest("section")!.hidden).toBe(true);
    expect([G.raceTimeOfDay, G.raceWeather]).toEqual(["day", "dry"]);
  });
});

describe("PhotoStudio seams (apex-26)", () => {
  it("capture → download through an injected capture hook and saveBlob", async () => {
    const hookOpts: unknown[] = [], saved: { blob: Blob; name: string }[] = [];
    const b = boot({
      noGfx: true,
      capture: async (opts) => { hookOpts.push(opts); return new Blob(["frame"], { type: "image/png" }); },
      bitmap: async () => ({ width: 320, height: 180, close: () => {} }) as unknown as ImageBitmap,
      saveBlob: async (blob, name) => { saved.push({ blob, name }); },
    });
    b.api.open({ metadata: { title: "Parabolica" } });
    expect(await b.api.capture()).toBe(true);
    expect(hookOpts).toEqual([{ aspect: "wide", postcard: false, metadata: { title: "Parabolica", subtitle: "RACE MOMENT" } }]);
    expect(b.order.filter((s) => s === "draw").length, "one render before the hook, no repaint after it").toBe(1);
    expect(b.canvasOps[0]).toEqual(["draw", 0, 0]);   // the decoded frame copied into the source canvas
    expect(b.byId("ps-message").textContent).toMatch(/320 × 180/);
    await b.api.exportPhoto();
    expect(saved.map((s) => s.name)).toEqual(["apex26-parabolica.png"]);
    expect(await saved[0]!.blob.text()).toBe("photo");
    expect(b.downloads, "a native save never also downloads through an anchor").toEqual([]);
    expect(b.byId("ps-message").textContent).toMatch(/PNG download requested/);
  });

  it("a failing capture hook falls back to the immediate canvas copy", async () => {
    const b = boot({ noGfx: true, capture: () => Promise.reject(new Error("no readback")) });
    b.gameCanvas.width = 64; b.gameCanvas.height = 36;
    b.api.open(); expect(await b.api.capture()).toBe(true);
    expect(b.order).toEqual(["enter", "draw", "draw"]);
    expect(b.byId("ps-message").textContent).toMatch(/64 × 36/);
  });

  it("without saveBlob, export falls back to an anchor download and revokes its object URL", async () => {
    const created: string[] = [], revoked: string[] = [];
    const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    URL.createObjectURL = () => { const u = "blob:test-" + created.length; created.push(u); return u; };
    URL.revokeObjectURL = (u: string) => { revoked.push(u); };
    try {
      const b = boot();
      b.api.open({ metadata: { title: "Eau Rouge" } }); await b.api.capture(); await b.api.exportPhoto();
      expect(b.downloads).toEqual(["apex26-eau-rouge.png"]);
      expect(document.querySelectorAll("a").length, "the anchor is removed after click").toBe(0);
      expect(revoked).toEqual([]);
      b.api.unmount();
      expect(revoked, "unmount revokes the pending object URL").toEqual(created);
    } finally { URL.createObjectURL = oc; URL.revokeObjectURL = orv; }
  });

  it("canvasCapture encodes the given canvas through toBlob", async () => {
    boot();
    const c = document.createElement("canvas");
    const blob = await canvasCapture(c)({ aspect: "wide", postcard: false, metadata: { title: "", subtitle: "" } });
    expect(await blob.text()).toBe("photo");
    await expect(canvasCapture(() => null)({ aspect: "wide", postcard: false, metadata: { title: "", subtitle: "" } })).rejects.toThrow(/No rendered scene/);
  });

  it("mount → open → capture → export → close → unmount leaves no listener or timer behind", async () => {
    const probe = leakProbe();
    try {
      const b = boot();
      b.api.open(); await b.api.capture(); await b.api.exportPhoto();
      b.api.close(true);
      b.api.open({ source: "garage" });
      b.api.unmount(); mounts.pop();
      expect(probe.liveListeners()).toEqual([]);
      expect(probe.pendingTimers()).toBe(0);
      expect(document.getElementById("photo-studio")).toBeNull();
      expect(document.body.classList.contains("photo-studio-open"), "unmount while open closes first").toBe(false);
      expect(b.api.open(), "an unmounted studio does not reopen").toBe(false);
    } finally { probe.restore(); }
  });
});

// ---- parity with f1-game's js/ui/photo-studio.js (node:vm) + committed fixture ----

const SIZES: readonly (readonly [number, number])[] = [[160, 90], [1920, 1080], [4096, 2160], [1000, 1000], [333, 777], [2560, 1440.4], [1, 1]];
const ASPECT_KEYS = ["scene", "wide", "square", "portrait", "bogus"];
const LABELS = ["../../My <Monza> Photo!", "", "  Spa\n\tFrancorchamps  ", "ÀÉÎ ünïcödé", "---", "A".repeat(120), "Lap 3 — P1 @ 1:21.003"];
const COMPOSE_CASES: readonly (readonly [number, number, string, boolean])[] = [
  [160, 90, "portrait", true], [1920, 1080, "square", true], [4096, 2160, "wide", false], [4096, 2160, "wide", true],
  [333, 777, "wide", true], [1000, 1000, "portrait", false], [3000, 500, "scene", true],
];

interface Reference { crop: unknown; filename: unknown; text: unknown; compose: unknown }

function portPure(): Omit<Reference, "compose"> {
  return {
    crop: SIZES.flatMap(([w, h]) => ASPECT_KEYS.map((a) => crop(w, h, a))),
    filename: LABELS.map((l) => filename(l)),
    text: LABELS.map((l) => [text(l), text(l, 5)]),
  };
}

/** The draw ops one capture + recrop sequence makes, over any studio (port or f1-game). */
async function composeOps(drive: {
  ops: Op[]; setPixels(w: number, h: number): void; open(): void; capture(): Promise<unknown>;
  set(id: string, v: string): void; message(): string; close(): void;
}): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const [w, h, aspect, postcard] of COMPOSE_CASES) {
    drive.setPixels(w, h); drive.open();
    drive.set("ps-aspect", "scene"); drive.set("ps-postcard", "off");
    drive.ops.length = 0;
    await drive.capture();
    const captured = drive.ops.splice(0);
    drive.set("ps-aspect", aspect); drive.set("ps-postcard", postcard ? "on" : "off");
    out.push({ captured, recomposed: drive.ops.splice(0), message: drive.message() });
    drive.close();
  }
  return out;
}

async function portCompose(): Promise<unknown[]> {
  let size = [1, 1];
  const b = boot();
  b.G.gfx["capturePixels"] = () => Promise.resolve({ width: size[0], height: size[1], data: new Uint8ClampedArray(4).fill(7) });
  return composeOps({
    ops: b.canvasOps, setPixels: (w, h) => { size = [w, h]; },
    open: () => { b.api.open({ metadata: { title: "Monza\u0001 Grand Prix", subtitle: "RACE MOMENT" } }); },
    capture: () => b.api.capture(), set: (id, v) => setSel(b.byId(id), v),
    message: () => b.byId("ps-message").textContent || "", close: () => b.api.close(false),
  });
}

async function f1Reference(): Promise<Reference> {
  const dom = miniDom(), ops: Op[] = [];
  const doc = dom.document as unknown as { createElement(t: string): MiniEl };
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag: string) => {
    const el = create(tag);
    if (tag === "canvas") {
      el["getContext"] = () => fakeCtx(ops);
      el["toDataURL"] = () => "data:image/jpeg;base64,ZmFrZQ==";
      el["toBlob"] = (cb: (b: Blob) => void) => cb(new Blob(["photo"]));
    }
    return el;
  };
  let size = [1, 1];
  const vm = f1Vm(dom, ["js/ui/setting-row.js", "js/ui/photo-studio.js"], {
    CustomEvent: class {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} }, Log: { warn() {} },
    Tracks: { sample() {} }, Blob, Uint8ClampedArray, queueMicrotask, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn: () => void) => fn(),
  });
  const PS = vm.get<{
    crop(w: number, h: number, a: string): unknown; filename(l: string): string;
    create(G: unknown, deps: unknown): { open(o?: unknown): boolean; capture(): Promise<boolean>; close(b: boolean): void };
  }>("PhotoStudio");
  // text() is private to the IIFE; filename() and the caption carry it, and so does #ps-context:
  const G = {
    $: dom.byId, canvas: dom.byId("game"), track: { name: "Monza", total: 1000 }, photoMode: false, player: null,
    setTimeOfDay: () => "day", weather: () => "dry", weatherArc: null, photoCam: { pos: [0, 0, 0], yaw: 0, pitch: 0, fov: 60 },
    gfx: { capturePixels: () => Promise.resolve({ width: size[0], height: size[1], data: new Uint8ClampedArray(4).fill(7) }) },
  };
  const freeCam = { state: () => ({ open: false }), enterFrom: () => true, cmd() {}, close() {}, setOverlaysVisible() {}, panel: () => null };
  const api = PS.create(G, { freeCam, renderFrame() {} });
  const texts = LABELS.map((l) => {
    api.open({ metadata: { title: l } }); const full = dom.byId("ps-context").textContent; api.close(false);
    return full;
  });
  const compose = await composeOps({
    ops, setPixels: (w, h) => { size = [w, h]; },
    open: () => { api.open({ metadata: { title: "Monza\u0001 Grand Prix", subtitle: "RACE MOMENT" } }); },
    capture: () => api.capture(),
    set: (id, v) => { const el = dom.byId(id); el.value = v; dom.dispatch(el, { type: "change" }); },
    message: () => dom.byId("ps-message").textContent, close: () => api.close(false),
  });
  return {
    crop: SIZES.flatMap(([w, h]) => ASPECT_KEYS.map((a) => PS.crop(w, h, a))),
    filename: LABELS.map((l) => PS.filename(l)),
    text: texts,
    compose,
  };
}

const FIXTURE = "photo-studio.json";
const haveF1Studio = haveF1Photo && existsSync(path.join(F1_ROOT, "js/ui/photo-studio.js")) && existsSync(path.join(F1_ROOT, "js/ui/setting-row.js"));

describe("PhotoStudio parity (f1-game js/ui/photo-studio.js)", () => {
  it.skipIf(!haveF1Studio)("crop / filename / #ps-context text / composed draw ops match f1-game bit for bit", async () => {
    const ref = await f1Reference();
    const pure = portPure();
    const bits = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "number" && Object.is(x, -0) ? "-0" : x))) as unknown;
    expect(bits(pure.crop)).toEqual(bits(ref.crop));
    expect(pure.filename).toEqual(ref.filename);
    // #ps-context shows text(title) — the f1 side's first column.
    expect(ref.text).toEqual(LABELS.map((l) => text(l || "Monza")));
    const compose = await portCompose();
    expect(bits(compose)).toEqual(bits(ref.compose));
    maybeWriteFixture(FIXTURE, asJson({ crop: pure.crop, filename: pure.filename, text: pure.text, compose }));
  });

  it("matches the committed reference fixture (tests/fixtures/camera/photo-studio.json)", async () => {
    const fx = readFixture(FIXTURE) as Reference;
    const pure = portPure();
    expect(asJson(pure.crop)).toEqual(fx.crop);
    expect(pure.filename).toEqual(fx.filename);
    expect(pure.text).toEqual(fx.text);
    expect(asJson(await portCompose())).toEqual(fx.compose);
  });
});
