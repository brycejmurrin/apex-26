/**
 * PHOTO STUDIO (#photo-studio / #ps-panel): capture the rendered scene, frame
 * it (crop to an aspect, composition guides, a postcard caption), keep it in a
 * six-photo device library, download it, or use it as the menu background.
 *
 * Ported verbatim from f1-game js/ui/photo-studio.js:1-524 (`PhotoStudio`),
 * plus the layer's static shell from index.html:2069 (#photo-studio), which
 * `mountPhotoStudio` builds with the same id and attributes. Styles:
 * css/photo-studio.css → ./photo.css (`@layer overlays`).
 *
 *   Photo Studio captures only the renderer, then composes a cropped image.
 *   Camera ownership is borrowed from FreeCam or the garage and always returned.
 *   Canvas API: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob
 *   Persistence: https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/put
 *
 * The `G` context and the IIFE's globals become `PhotoStudioDeps`:
 *   G.$("photo-studio")                 → built in `el` (index.html:2069)
 *   deps.freeCam || FreeCam             → deps.freeCam (a ./free-cam.ts mount satisfies StudioFreeCam)
 *   G.photoMode / G.photoCam            → deps.photoMode() / deps.photoCam (./photo-cam.ts mount's isActive / photoCam)
 *   G.track / G.player                  → deps.track() / deps.player(). The player here is the
 *       BORROWED Home subject (deps.borrowCar) whose display pose PLACE YOUR CAR
 *       writes, exactly as f1-game; nothing here drives a car (AGENTS.md arc rule).
 *   G.setTimeOfDay / G.weather / G.weatherArc → deps.conditions. TODO(lane-render):
 *       the shell wires Atmosphere's session time-of-day / weather seam.
 *   Tracks.sample / Tracks.banking      → deps.sample / deps.banking (default src/track/core)
 *   G.gfx (capturePixels, softPresent…) → deps.gfx. TODO(lane-render): the three.js
 *       renderer's readback.
 *   (new) deps.capture(opts) → Blob     → TODO(lane-render): a renderer readback that hands
 *       back an encoded frame (`canvasCapture(canvas)` is the `canvas.toBlob` one).
 *   G.canvas || G.$("game")             → deps.canvas() (default #game in el's document)
 *   NativeDownload.viable()/.saveBlob   → deps.saveBlob. TODO(lane-shell): native save /
 *       share; absent, the anchor download f1-game falls back to.
 *   TopModal.keepFocus                  → deps.keepFocus. TODO(lane-shell).
 *   Log.warn("ui", …)                   → ../data/log
 *   localStorage / indexedDB / createImageBitmap / requestAnimationFrame
 *                                       → deps.storage / deps.indexedDB / deps.createImageBitmap /
 *                                         deps.requestAnimationFrame (default: the element's window)
 *   the module's `live` instance        → the returned mount (no module global): album(),
 *       contactSheet() and state() are its methods, for replay-buf / appearance-studio.
 *
 * Storage: `a26.photoBackground` (localStorage) and `a26.photoLibrary`
 * (IndexedDB) — AGENTS.md: f1-game owns `apex26.` on the same origin.
 */
import { log } from "../data/log";
import { sample as coreSample, banking as coreBanking } from "../track/core/tracks";
import type { Sample, Track } from "../track/core/types";
import type { FreeCamCmd } from "./free-cam";
import type { StorageLike } from "./store";
import { buildSettingRow, paintSettingRow, wireSettingRow, type RowOption } from "./setting-row";
import "../styles";   // fixes the @layer order before the camera sheets join their layers
import "./photo.css";

// photo-studio.js:7-11
export const KEY = "a26.photoBackground", DB = "a26.photoLibrary", LIMIT = 6;
/** The window event setBackground fires (photo-studio.js:27). */
export const BACKGROUND_EVENT = "apex26:photo-background";
export const ASPECTS: Readonly<Record<string, number>> = Object.freeze({ scene: 0, wide: 16 / 9, square: 1, portrait: 4 / 5 });
// TIME and WEATHER are the engine's own discrete sets (js/race/weather-arc.js VALID, setTimeOfDay): no continuous clock exists.
const TODS: readonly RowOption[] = [["dawn", "Dawn"], ["day", "Day"], ["dusk", "Dusk"], ["night", "Night"], ["default", "Track default"]];
const WXS: readonly RowOption[] = [["dry", "Dry"], ["overcast", "Overcast"], ["fog", "Fog"], ["wet", "Wet"], ["rain", "Rain"], ["storm", "Storm"]];

// ---- pure helpers (photo-studio.js:13-19) -----------------------------------

/** Control characters to spaces, trimmed, capped (default 80). photo-studio.js:13 */
export const text = (v: unknown, max?: number): string => String(v || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max || 80);
/** A safe download name. photo-studio.js:14 */
export function filename(label: unknown): string { return "apex26-" + (text(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "photo") + ".png"; }

export interface CropBox { x: number; y: number; width: number; height: number }
/** The centred crop of a width × height frame to `aspect` (an ASPECTS key; unknown = the frame's own). photo-studio.js:15 */
export function crop(width: number, height: number, aspect: string): CropBox {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height)), r = ASPECTS[aspect] || w / h;
  const cw = Math.min(w, h * r), ch = Math.min(h, w / r);
  return { x: (w - cw) / 2, y: (h - ch) / 2, width: cw, height: ch };
}

/** The composed output size for a crop box: bounded to 2048 px a side (photo-studio.js:397-398). */
export function composeSize(box: CropBox): { width: number; height: number } {
  const scale = Math.min(1, 2048 / box.width, 2048 / box.height);
  return { width: Math.round(box.width * scale), height: Math.round(box.height * scale) };
}
/** The kept (uncropped) source size, bounded to 2048 (photo-studio.js:384-385). */
export function keepSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 2048 / width, 2048 / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
/** The preview / library thumbnail size, bounded to 640 × 360 (photo-studio.js:412-413). */
export function thumbSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 640 / width, 360 / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
/** The postcard caption band for an output size (photo-studio.js:402-407). */
export function postcardLayout(width: number, height: number): { h: number; pad: number; titlePx: number; subPx: number; titleY: number; subY: number; maxW: number } {
  const h = Math.max(54, height * 0.11), pad = Math.max(16, width * 0.025);
  return { h, pad, titlePx: Math.round(h * 0.32), subPx: Math.round(h * 0.22), titleY: height - h * 0.5, subY: height - h * 0.18, maxW: width - pad * 2 };
}

// ---- background + library (photo-studio.js:20-84) ---------------------------

function defaultStorage(): StorageLike | null {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}
const BG_RE = /^data:image\/(jpeg|png);base64,/;
/** The stored menu background data URL, or "" (photo-studio.js:20). */
export function background(storage: StorageLike | null = defaultStorage()): string {
  try { const v = storage ? storage.getItem(KEY) : null; return v && BG_RE.test(v) && v.length < 240000 ? v : ""; } catch { return ""; }
}
/** Store (or, with "", clear) the menu background; false when refused. photo-studio.js:23 */
export function setBackground(value: string, storage: StorageLike | null = defaultStorage(),
  target: Pick<EventTarget, "dispatchEvent"> | null = typeof window !== "undefined" ? window : null): boolean {
  if (value && (!BG_RE.test(value) || value.length >= 240000)) return false;
  try {
    if (!storage) throw new Error("no storage");
    if (value) storage.setItem(KEY, value); else storage.removeItem(KEY);
    if (target) target.dispatchEvent(new CustomEvent(BACKGROUND_EVENT, { detail: { available: !!value } }));
    return true;
  } catch { return false; }
}

/** One saved photo (IndexedDB row, or a visit-only entry). */
export interface PhotoEntry { id: string; at: number; title: string; blob: Blob; thumb: string }
/** What album() hands out: frozen, safe, no blob. */
export interface AlbumRow { readonly id: string; readonly title: string; readonly thumb: string; readonly at: number }

/** The IndexedDB factory surface used (`indexedDB` satisfies it). */
export type IdbLike = Pick<IDBFactory, "open">;

function openDb(idb: IdbLike | null | undefined): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!idb) { reject(new Error("Photo storage unavailable")); return; }
    const req = idb.open(DB, 1); let abandoned = false;
    req.onupgradeneeded = () => req.result.createObjectStore("photos", { keyPath: "id" });
    req.onerror = () => reject(req.error || new Error("Photo storage unavailable"));
    req.onsuccess = () => { if (abandoned) req.result.close(); else resolve(req.result); };
    req.onblocked = () => { abandoned = true; reject(new Error("Close another game tab to open photo storage")); };
  });
}
async function library(idb: IdbLike | null | undefined, action: "list" | "save" | "delete", value?: PhotoEntry | string): Promise<unknown> {
  const db = await openDb(idb);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("photos", action === "list" ? "readonly" : "readwrite"), store = tx.objectStore("photos");
      let result: unknown = null, failure: unknown = null;
      const req: IDBRequest = action === "delete" ? store.delete(value as string) : store.getAll();
      req.onsuccess = () => {
        if (action !== "save") { result = req.result; return; }
        const entry = value as PhotoEntry;
        // Queue every mutation in this active request callback. Readwrite
        // transactions on the same store serialize across tabs; an await here
        // would let this transaction become inactive and lose that isolation.
        try {
          const photos = (req.result as PhotoEntry[]).filter((p) => p.id !== entry.id).concat(entry)
            .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
          const keep = photos.slice(0, LIMIT);
          for (const old of photos.slice(LIMIT)) if (old.id !== entry.id) store.delete(old.id);
          if (keep.some((p) => p.id === entry.id)) {
            const put = store.put(entry); put.onsuccess = () => { result = put.result; };
          }
        } catch (e) { failure = e; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = (e) => { failure = failure || (e && e.target && (e.target as IDBRequest).error) || tx.error; };
      // Reject only once abort has finished rolling back the whole write.
      tx.onabort = () => reject(failure || tx.error || new Error("Photo storage is full or unavailable"));
    });
  } finally { db.close(); }
}
/** canvas.toBlob as a promise; a null blob is an encoding failure. photo-studio.js:70 */
export function blobOf(canvas: HTMLCanvasElement, type?: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try { canvas.toBlob((b) => b ? resolve(b) : reject(new Error("The image could not be encoded")), type || "image/png", quality); }
    catch (e) { reject(e); }
  });
}

// ---- injected seams ---------------------------------------------------------

/** The composition a capture is for (photo-studio.js:377 options()). */
export interface PhotoOptions { aspect: string; postcard: boolean; metadata: { title: string; subtitle: string } }
/** Encoded-frame capture: resolves the rendered scene (no DOM overlays) as an image Blob.
 *  TODO(lane-render): the three.js renderer's readback; `canvasCapture` is the canvas.toBlob one. */
export type CaptureHook = (opts: PhotoOptions) => Promise<Blob>;
/** A CaptureHook over a canvas's `toBlob` (PNG). */
export function canvasCapture(canvas: HTMLCanvasElement | (() => HTMLCanvasElement | null)): CaptureHook {
  return () => {
    const c = typeof canvas === "function" ? canvas() : canvas;
    return c ? blobOf(c) : Promise.reject(new Error("No rendered scene is ready"));
  };
}
/** Native save / share (f1-game NativeDownload.saveBlob). TODO(lane-shell). */
export type SaveBlob = (blob: Blob, name: string) => Promise<void>;

/** Raw RGBA readback (f1-game gfx.capturePixels). */
export interface Pixels { readonly width: number; readonly height: number; readonly data: ArrayLike<number> }
/** The renderer members frame() reads (f1-game G.gfx). TODO(lane-render). */
export interface StudioGfx {
  capturePixels?(): Promise<Pixels | null | undefined>;
  softPresent?(): boolean;
  invalidateSoftPresent?(): void;
  awaitSoftPresent?(ms: number): Promise<unknown>;
}
/** A camera state the free camera hands out and takes back (FreeCamState round-trips through cmd). */
export interface StudioCamState { readonly open?: boolean }
/** The FreeCam members the studio borrows (a ./free-cam.ts FreeCamMount satisfies it). */
export interface StudioFreeCam {
  state?(): StudioCamState;
  cmd?(opts?: FreeCamCmd | boolean | null): unknown;
  enterFrom?(opts?: FreeCamCmd | null): boolean;
  panel?(): HTMLElement | null;
  setOverlaysVisible?(on: boolean): void;
  close?(showPauseMenu?: boolean, keepPhotoMode?: boolean): void;
}
/** The garage camera rig (f1-game setupCam via game.js:8986-8987). TODO(lane-shell). */
export interface StudioGarage {
  snapshot?(): unknown;
  restore?(snapshot: unknown): void;
  shot?(id: string): void;
}
/** Photo mode's fly-cam pose (G.photoCam; ./free-cam.ts PhotoCamState). */
export interface StudioPhotoCam { pos: number[]; yaw: number; pitch: number; fov: number }
/** The session's lighting seam (G.setTimeOfDay / G.weather / G.weatherArc): called with no
 *  argument each reads; with one each sets. TODO(lane-render): Atmosphere.applyRaceSettings. */
export interface StudioConditions {
  timeOfDay(v?: string): string;
  weather(v?: string): string;
  weatherArc: unknown;
}
/** The circuit fields read (G.track). */
export interface StudioTrack { readonly name?: string; readonly id?: string; readonly total: number }
/** The borrowed Home subject's display pose PLACE YOUR CAR writes (G.player). */
export interface StudioCar {
  s: number; x: number; xVis: number; px: number; pz: number; head: number; yawVis: number; speed: number;
  rPrevS: number; rPrevX: number; rPrevPx: number; rPrevPz: number; rPrevHead: number; rPrevYawVis: number;
}
/** open() options (photo-studio.js:247). */
export interface StudioOpenOpts {
  source?: "race" | "home" | "garage" | "home-track" | string;
  metadata?: { title?: string; subtitle?: string };
  back?: (() => void) | null;
  subject?: ((v: string) => unknown) | null;
  view?: { eye: [number, number, number]; tgt: [number, number, number]; fov?: number } | null;
}

export interface PhotoStudioDeps {
  readonly freeCam?: StudioFreeCam | null;
  readonly garage?: StudioGarage | null;
  readonly renderFrame?: (() => void) | null;
  /** Swap in a fresh Home subject car; returns the release. */
  readonly borrowCar?: (() => () => void) | null;
  readonly onClose?: ((r: { restoredPhoto: boolean }) => void) | null;
  readonly photoMode?: (() => boolean) | null;
  readonly photoCam?: StudioPhotoCam | null;
  readonly track?: (() => StudioTrack | null | undefined) | null;
  readonly player?: (() => StudioCar | null | undefined) | null;
  /** Absent: the TIME & WEATHER group stays hidden. */
  readonly conditions?: StudioConditions | null;
  /** Default src/track/core sample (the track must then be a built core Track). */
  readonly sample?: ((track: StudioTrack, s: number, out: Sample) => unknown) | null;
  readonly banking?: ((track: StudioTrack, s: number, x: number) => { dy: number } | null) | null;
  readonly gfx?: StudioGfx | null;
  readonly capture?: CaptureHook | null;
  /** The scene canvas (G.canvas || #game). */
  readonly canvas?: (() => HTMLCanvasElement | null) | null;
  readonly saveBlob?: SaveBlob | null;
  readonly keepFocus?: ((box: HTMLElement, render: () => void) => void) | null;
  readonly storage?: StorageLike | null;
  readonly indexedDB?: IdbLike | null;
  readonly createImageBitmap?: ((file: Blob, opts?: ImageBitmapOptions) => Promise<ImageBitmap>) | null;
  readonly requestAnimationFrame?: ((fn: () => void) => unknown) | null;
  /** Where setBackground's event fires (default the element's window). */
  readonly win?: Pick<EventTarget, "dispatchEvent"> | null;
}

export interface PhotoStudioState {
  open: boolean; generation: number; source: string; subject: boolean; aspect: string; grid: string;
  postcard: boolean; busy: boolean; captured: boolean; background: boolean;
}

export interface PhotoStudioMount {
  open(opts?: StudioOpenOpts | null): boolean;
  close(back?: boolean): void;
  isOpen(): boolean;
  capture(): Promise<boolean>;
  state(): PhotoStudioState;
  contactSheet(times: readonly number[], seek: (t: number) => void, cancelled: () => boolean): Promise<boolean>;
  album(): Promise<AlbumRow[]>;
  background(): string;
  setBackground(value: string): boolean;
  exportPhoto(): Promise<void>;
  savePhoto(): Promise<void>;
  hasCar(): boolean;
  /** The #photo-studio layer this mount built. */
  readonly root: HTMLElement;
  unmount(): void;
}

/** index.html:2069: the layer, built rather than static. */
function buildShell(doc: Document): HTMLElement {
  const root = doc.createElement("div");
  root.id = "photo-studio"; root.className = "screen"; root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Photo Studio"); root.dataset["escClose"] = "ps-close"; root.hidden = true;
  return root;
}

type Props = Record<string, unknown> & { attrs?: Record<string, string> };
type Sized = CanvasImageSource & { readonly width: number; readonly height: number };
const ctx2d = (c: HTMLCanvasElement): CanvasRenderingContext2D | null => c.getContext("2d");

/** Build the PHOTO STUDIO in `el` and wire it to `deps` (photo-studio.js:85-522 `create`). */
export function mountPhotoStudio(el: HTMLElement, deps: PhotoStudioDeps): PhotoStudioMount {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const storage = deps.storage !== undefined ? deps.storage : (() => { try { return view ? view.localStorage : null; } catch { return null; } })();
  const idb = deps.indexedDB !== undefined ? deps.indexedDB : (typeof indexedDB !== "undefined" ? indexedDB : null);
  const evTarget = deps.win !== undefined ? deps.win : view;
  const raf = deps.requestAnimationFrame || (view && typeof view.requestAnimationFrame === "function" ? (fn: () => void) => view.requestAnimationFrame(fn) : null);
  const bitmapOf = deps.createImageBitmap || (typeof createImageBitmap === "function" ? (b: Blob, o?: ImageBitmapOptions) => createImageBitmap(b, o || {}) : null);
  const sampleFn = deps.sample || ((t: StudioTrack, s: number, out: Sample) => coreSample(t as unknown as Track, s, out));
  const bankingFn = deps.banking !== undefined ? deps.banking : (t: StudioTrack, s: number, x: number) => coreBanking(t as unknown as Track, s, x);
  const conditions = deps.conditions || null;
  const track = (): StudioTrack | null => (deps.track && deps.track()) || null;
  const player = (): StudioCar | null => (deps.player && deps.player()) || null;
  const photoMode = (): boolean => !!(deps.photoMode && deps.photoMode());
  const sceneCanvas = (): HTMLCanvasElement | null => (deps.canvas ? deps.canvas() : null) || (doc.getElementById("game") as HTMLCanvasElement | null);
  const revokes = new Map<ReturnType<typeof setTimeout>, string>();

  const root = buildShell(doc);
  el.appendChild(root);
  const st = { open: false, source: "race", aspect: "wide", grid: "thirds", postcard: false, busy: false, closing: false,
    metadata: {} as { title?: string; subtitle?: string }, back: null as (() => void) | null, snapshot: null as unknown,
    borrowed: null as { open: boolean | undefined; state: StudioCamState | null; photo: boolean; pose: { pos: number[]; yaw: number; pitch: number; fov: number } | null } | null,
    generation: 0, subject: null as ((v: string) => unknown) | null };
  const E: Record<string, HTMLElement> = {}, session: PhotoEntry[] = [];
  let last: HTMLCanvasElement | null = null, raw: HTMLCanvasElement | null = null, capturedOptions: PhotoOptions | null = null;
  let focus: Element | null = null, libraryPaint = 0, releaseCar: (() => void) | null = null, downloading = false, mounted = true;
  const $b = (id: string): HTMLButtonElement => E[id] as HTMLButtonElement;
  const $i = (id: string): HTMLInputElement => E[id] as HTMLInputElement;
  const mk = (tag: string, props?: Props | null, kids?: readonly Node[]): HTMLElement => {
    const node = doc.createElement(tag);
    if (props) for (const k in props) {
      if (k === "attrs") { for (const a in props.attrs) node.setAttribute(a, props.attrs[a]!); } else (node as unknown as Record<string, unknown>)[k] = props[k];
    }
    if (props && typeof props["id"] === "string" && props["id"]) E[props["id"]] = node;
    if (kids) for (const c of kids) node.appendChild(c);
    return node;
  };
  const canvasEl = (): HTMLCanvasElement => mk("canvas") as HTMLCanvasElement;
  const button = (label: string, run: () => unknown, id?: string): HTMLButtonElement => {
    const b = mk("button", { type: "button", textContent: label, id: id || "" }) as HTMLButtonElement;
    b.addEventListener("click", () => { void run(); }); return b;
  };
  const select = (label: string, list: readonly RowOption[], read: () => string, run: (v: string) => void, id: string): HTMLElement => {
    const row = buildSettingRow(doc, id + "-row", label, list);
    row.sel.id = id; E[id] = row.sel;
    wireSettingRow(row.row, { read, write: run }); return row.row;
  };
  const shots = mk("div", { id: "ps-shots", className: "balanced-row", attrs: { role: "group", "aria-label": "Shot presets" } });
  const guide = mk("div", { id: "ps-guide", attrs: { "aria-hidden": "true" } }, [mk("div", { id: "ps-grid" })]);
  const importFile = mk("input", { id: "ps-import", type: "file", accept: "image/png,image/jpeg,image/webp", attrs: { "aria-label": "Import a personal photo" } }) as HTMLInputElement;
  importFile.addEventListener("change", () => { void importPhoto(importFile.files && importFile.files[0]); });
  const group = (title: string, kids: readonly Node[]): HTMLElement => mk("section", { attrs: { "aria-label": title } }, [mk("h3", { className: "adv-sec", textContent: title }), ...kids]);
  const captureButton = button("CAPTURE", capture, "ps-capture"), done = button("DONE", () => close(true), "ps-close");
  captureButton.className = "bigbtn"; done.className = "bigbtn alt";
  // SUBJECT: the Home door opens on whatever the Home scene shows, and the
  // default scene is the garage, so the circuit shoot (free camera over the
  // track) was reachable only by changing Appearance › Scene · Home first.
  // The row hands the pick to the door (opts.subject), which swaps the Home
  // world for this visit and reopens the studio; the stored scene is untouched.
  const subjectValue = (): string => (isGarage() ? "garage" : "circuit");
  const subjectRow = select("Subject", [["garage", "Garage"], ["circuit", "Circuit"]], subjectValue,
    (v) => { if (st.subject && !st.busy && v !== subjectValue()) st.subject(v); }, "ps-subject");
  const subjectGroup = group("SUBJECT", [subjectRow,
    mk("p", { className: "adv-help", textContent: "Your car in the garage or on the circuit. Your Home scene stays as it is." })]);
  // CONDITIONS: the SESSION's time of day and weather through the lighting tuner's own seam (G.setTimeOfDay /
  // G.weather → Atmosphere.applyRaceSettings). A preview only: open() records what the session had, RESET and
  // every close put it back, so a photo never leaks into a race, a career or a result (the race is paused and the
  // Home car is a fresh borrowed one while the studio is open).
  const cond = { tod: null as string | null, wx: null as string | null, arc: null as unknown, touched: false };
  const tod = (): string => (conditions ? conditions.timeOfDay() : "");
  const wx = (): string => (conditions ? conditions.weather() : "");
  const pick = (label: string, list: readonly RowOption[], read: () => string, run: (v: string) => void, id: string): HTMLElement =>
    select(label, list, read, (v) => { run(v); paintCond(); }, id);
  const setTod = (v: string): void => { if (st.busy || st.closing || isGarage() || !conditions) return; cond.touched = true; conditions.timeOfDay(v); };
  const setWx = (v: string): void => { if (st.busy || st.closing || isGarage() || !conditions) return; cond.touched = true; conditions.weather(v); };
  const todRow = pick("Time of day", TODS, tod, setTod, "ps-tod");
  const wxRow = pick("Weather", WXS, wx, setWx, "ps-weather");
  const condReset = button("RESET CONDITIONS", () => resetCond(), "ps-cond-reset");
  const condGroup = group("TIME & WEATHER", [todRow, wxRow, condReset,
    mk("p", { className: "adv-help", textContent: "Changes the light and weather for this photo only. Your race and results stay as they were." })]);
  function paintCond(): void {
    for (const [row, v] of [[todRow, tod()], [wxRow, wx()]] as const) {
      paintSettingRow(row, v);
    }
    $b("ps-cond-reset").disabled = st.busy || !(tod() !== cond.tod || wx() !== cond.wx);
  }
  function resetCond(): void {
    if (cond.tod == null || !conditions) return;
    if (conditions.timeOfDay() !== cond.tod) conditions.timeOfDay(cond.tod);
    if (conditions.weather() !== cond.wx || cond.touched) { conditions.weather(cond.wx as string); }
    if (cond.touched) conditions.weatherArc = cond.arc;   // a MIXED race's arc, dropped by weather()
    cond.touched = false;
    if (st.open) paintCond();
  }
  const placement = (label: string, id: string, min: number, max: number, step: number, unit: string): HTMLElement => {
    const out = mk("output", { id: id + "-value", textContent: "0" + unit });
    const input = mk("input", { id, type: "range", min: String(min), max: String(max), step: String(step), value: "0" }) as HTMLInputElement;
    input.addEventListener("input", () => { out.textContent = input.value + unit; placeCar(id !== "ps-car-rotation"); });
    return mk("label", { className: "tune-row" }, [mk("span", { className: "tune-label", textContent: label }), input, out]);
  };
  const carGroup = group("PLACE YOUR CAR", [
    placement("Circuit position", "ps-car-position", 0, 100, .1, "%"),
    placement("Sideways", "ps-car-offset", -20, 20, .1, " m"),
    placement("Rotation", "ps-car-rotation", -180, 180, 1, "°"),
    button("FRAME CAR", () => setShot("car"), "ps-car-frame"),
  ]);
  const panel = mk("section", { id: "ps-panel", className: "sheet", attrs: { "aria-label": "Photo Studio" } }, [
    mk("header", { className: "sheet-head" }, [mk("h2", { textContent: "PHOTO STUDIO" })]),
    mk("div", { id: "ps-body", className: "sheet-body pane" }, [
      mk("p", { id: "ps-context", className: "adv-help" }),
      subjectGroup,
      carGroup,
      condGroup,
      group("COMPOSITION", [
        select("Frame", [["scene", "Full scene"], ["wide", "16:9"], ["square", "1:1"], ["portrait", "4:5"]], () => st.aspect, (v) => { st.aspect = v; guides(); if (!st.busy) recompose(); }, "ps-aspect"),
        select("Guide", [["off", "Off"], ["thirds", "Thirds"], ["centre", "Centre"]], () => st.grid, (v) => { st.grid = v; guides(); }, "ps-grid-select"),
        shots, mk("p", { id: "ps-help", className: "adv-help" }),
        coaching(),
        select("Caption", [["off", "Off"], ["on", "Postcard"]], () => st.postcard ? "on" : "off", (v) => { st.postcard = v === "on"; if (!st.busy) recompose(); }, "ps-postcard"),
      ]),
      group("YOUR PHOTO", [
        mk("img", { id: "ps-preview", alt: "Captured photo preview", hidden: true }),
        mk("div", { className: "balanced-row" }, [button("DOWNLOAD PNG", exportPhoto, "ps-export"), button("SAVE PHOTO", savePhoto, "ps-save")]),
        mk("div", { className: "balanced-row" }, [button("USE AS MENU BACKGROUND", useBackground, "ps-background"), button("CLEAR BACKGROUND", () => say(setBg("") ? "Menu background cleared." : "Background could not be cleared."))]),
        mk("label", { className: "tune-row" }, [mk("span", { className: "tune-label", textContent: "Import your photo" }), importFile]),
      ]),
      mk("details", {}, [mk("summary", { textContent: "MY PHOTOS · up to 6" }), mk("div", { id: "ps-library" })]),
      mk("p", { id: "ps-message", attrs: { "aria-live": "polite", role: "status" } }),
    ]),
    mk("footer", { className: "sheet-foot" }, [captureButton, done]),
  ]);
  root.appendChild(guide); root.appendChild(panel);
  root.setAttribute("aria-label", "Photo Studio");
  root.setAttribute("data-esc-close", "ps-close");
  const preview = (): HTMLImageElement => E["ps-preview"] as HTMLImageElement;
  const say = (s: string): void => { E["ps-message"]!.textContent = s; };
  const bg = (): string => background(storage);
  const setBg = (v: string): boolean => setBackground(v, storage, evTarget);
  function busy(value: boolean): void {
    st.busy = value;
    const closing = !!st.closing;
    panel.setAttribute("aria-busy", value || closing ? "true" : "false");
    root.setAttribute("aria-busy", value || closing ? "true" : "false");
    // Keep #ps-close enabled: it is the data-esc-close / Start door. close()
    // already no-ops while st.closing, and TopModal.onEscape skips a disabled
    // door — so disabling DONE during CAPTURE/CLOSING trapped Escape until the
    // async restore finished (~10s on software GL).
    for (const id of ["ps-capture", "ps-export", "ps-save", "ps-background"]) {
      $b(id).disabled = value || closing || (id !== "ps-capture" && !last);
    }
    $b("ps-close").disabled = false;
    E["ps-capture"]!.textContent = value && !closing ? "CAPTURING…" : "CAPTURE";
    E["ps-close"]!.textContent = closing ? "CLOSING…" : "DONE";
  }
  function guides(): void { root.dataset["aspect"] = st.aspect; root.dataset["grid"] = st.grid; }
  function camera(): StudioFreeCam | null { return deps.freeCam || null; }
  function isGarage(): boolean { return st.source === "home" || st.source === "garage"; }
  function hasCar(): boolean { return st.open && !!releaseCar; }
  function placeCar(reframe = true): void {
    const t = track();
    if (!hasCar() || !player() || !t) return;
    const c = player() as StudioCar, sample: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
    c.s = (+$i("ps-car-position").value % 100) * t.total / 100;
    c.x = c.xVis = +$i("ps-car-offset").value;
    sampleFn(t, c.s, sample);
    const len = Math.hypot(sample.r[0], sample.r[2]) || 1; // horizontal metres, as worldFromTrack
    c.px = sample.p[0] + sample.r[0] / len * c.x;
    c.pz = sample.p[2] + sample.r[2] / len * c.x;
    c.yawVis = +$i("ps-car-rotation").value * Math.PI / 180;
    c.head = Math.atan2(sample.t[0], sample.t[2]) - c.yawVis;
    c.rPrevS = c.s; c.rPrevX = c.x; c.rPrevPx = c.px; c.rPrevPz = c.pz;
    c.rPrevHead = c.head; c.rPrevYawVis = c.yawVis; c.speed = 0;
    if (reframe) setShot("car");
  }
  function setShot(id: string): void {
    if (st.busy || st.closing) return;
    if (isGarage()) { if (deps.garage && deps.garage.shot) deps.garage.shot(id); }
    else {
      const fc = camera(); if (!fc || !fc.cmd) return;
      const fov = id === "detail" ? 35 : id === "wide" ? 80 : 60;
      const t = track();
      if (hasCar() && player() && t && id !== "corner") {
        // Keep the subject above the phone sticks and left of the studio sheet.
        const c = player() as StudioCar, sample: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
        sampleFn(t, c.s, sample);
        const bank = bankingFn ? bankingFn(t, c.s, c.x) : null;
        const y = sample.p[1] + (bank ? bank.dy : 0), fx = Math.sin(c.head), fz = Math.cos(c.head);
        fc.cmd({ eye: [c.px - fx * 9, y + 3.2, c.pz - fz * 9],
          target: [c.px - fz * 3, y + .5, c.pz + fx * 3], fov });
      } else fc.cmd(id === "corner" ? { snap: "corner" } : { snap: "car", fov });
    }
  }
  function open(opts?: StudioOpenOpts | null): boolean {
    const o: StudioOpenOpts = opts || {};
    if (!mounted) return false;
    if (st.open) close(false);
    last = null; raw = null; capturedOptions = null; preview().hidden = true;
    st.source = o.source || "race"; st.metadata = o.metadata || {}; st.back = typeof o.back === "function" ? o.back : null;
    st.subject = typeof o.subject === "function" ? o.subject : null;
    focus = doc.activeElement;
    if (isGarage()) {
      if (!deps.garage) return false;
      st.snapshot = deps.garage.snapshot ? deps.garage.snapshot() : null;
    } else {
      const fc = camera();
      const prior = fc && (fc.state ? fc.state() : fc.cmd ? (fc.cmd() as StudioCamState | null) : null);
      const pc = deps.photoCam;
      st.borrowed = { open: !!prior && prior.open, state: prior || null, photo: photoMode(),
        pose: pc ? { pos: pc.pos.slice(), yaw: pc.yaw, pitch: pc.pitch, fov: pc.fov } : null };
      if (!fc || !fc.enterFrom || !fc.enterFrom({})) return false;
      if (o.view && fc.cmd) fc.cmd(o.view.fov !== undefined ? { eye: o.view.eye, target: o.view.tgt, fov: o.view.fov } : { eye: o.view.eye, target: o.view.tgt });
      const p = fc.panel ? fc.panel() : doc.getElementById("freecam-inner"); if (p) p.hidden = true;
      if (fc.setOverlaysVisible) fc.setOverlaysVisible(false);
    }
    if (st.source === "home-track" && deps.borrowCar) releaseCar = deps.borrowCar();
    st.open = true; st.generation++; root.hidden = false;
    carGroup.hidden = !hasCar();
    for (const [id, unit] of [["ps-car-position", "%"], ["ps-car-offset", " m"], ["ps-car-rotation", "°"]] as const) {
      $i(id).value = "0"; E[id + "-value"]!.textContent = "0" + unit;
    }
    placeCar();
    condGroup.hidden = isGarage() || !conditions;
    if (!isGarage() && conditions) { cond.tod = tod(); cond.wx = wx(); cond.arc = conditions.weatherArc; cond.touched = false; paintCond(); }
    subjectGroup.hidden = !st.subject;
    if (st.subject) paintSettingRow(subjectRow, subjectValue());
    doc.body.classList.add("photo-studio-open");
    const t = track();
    E["ps-context"]!.textContent = text(st.metadata.title || (isGarage() ? "Your garage" : t && (t.name || t.id)) || "Race photo");
    E["ps-help"]!.textContent = isGarage() ? "Choose a shot or drag the scene to orbit. Guides stay out of the exported photo." : "WASD move · drag to look · R/F height · Shift boost. Guides and HUD stay out of the photo.";
    shots.replaceChildren();
    const list = isGarage() ? [["hero", "HERO"], ["front", "FRONT"], ["side", "SIDE"], ["rear", "REAR"], ["top", "TOP"]] : [["car", "CHASE"], ["wide", "WIDE"], ["detail", "DETAIL"], ["corner", "CORNER"]];
    for (const [id, label] of list as [string, string][]) shots.appendChild(button(label, () => setShot(id)));
    st.closing = false; guides(); busy(false); say("Capture the frame, then save or download it. Frame and Caption recrop your photo; moving the camera leaves it unchanged until CAPTURE."); void paintLibrary(); $b("ps-close").focus();
    return true;
  }
  function close(back?: boolean): void {
    if (!st.open) return;
    if (back) {
      if (st.closing) return;
      st.closing = true;
      const gen = st.generation;
      busy(true);
      say("Restoring the scene…");
      // Paint CLOSING… before garage/home restore takes the main thread (~10s
      // on software GL). Lifecycle teardown (back=false) stays synchronous.
      const go = (): void => { if (st.generation === gen && st.closing) finishClose(true); };
      if (raf) raf(go);
      else go();
      return;
    }
    finishClose(false);
  }
  function finishClose(back: boolean): void {
    if (!st.open && !st.closing) return;
    if (!isGarage() && cond.tod != null) { resetCond(); cond.tod = null; }
    const returnTo = st.back; st.generation++; st.open = false; st.back = null; st.closing = false;
    if (releaseCar) { releaseCar(); releaseCar = null; }
    if (isGarage()) { if (deps.garage && deps.garage.restore && st.snapshot) deps.garage.restore(st.snapshot); st.snapshot = null; }
    else {
      const fc = camera(), prior = st.borrowed;
      if (back && prior && prior.open && fc && fc.cmd) {
        // The FreeCamState it handed out goes straight back through cmd (free-cam.js cmd reads its fields).
        fc.cmd(prior.state as FreeCamCmd); if (fc.setOverlaysVisible) fc.setOverlaysVisible(true); const p = fc.panel ? fc.panel() : doc.getElementById("freecam-inner"); if (p) p.hidden = false;
      } else {
        if (fc && fc.close) fc.close(false, !!(back && prior && prior.photo)); else if (fc && fc.cmd) fc.cmd(false);
        if (back && prior && prior.photo && prior.pose && deps.photoCam) {
          const pc = deps.photoCam;
          pc.pos.splice(0, 3, ...prior.pose.pos); pc.yaw = prior.pose.yaw; pc.pitch = prior.pose.pitch; pc.fov = prior.pose.fov;
        }
      }
      st.borrowed = null;
    }
    if (deps.onClose) deps.onClose({ restoredPhoto: photoMode() });
    // Hide before returnTo(): body.photo-studio-open forces #rotate-device
    // display:none, so setPaused → syncRotateBlocker would miss the portrait
    // gate and leave the pause card up (photo-studio.spec.js race close).
    const target = focus as (Element & { focus?: () => void }) | null, generation = st.generation;
    // Release the composed canvas (up to 2048 px, ~17 MB RGBA) and its preview data URL; open() rebuilds both.
    last = null; raw = null; capturedOptions = null; preview().removeAttribute("src"); preview().hidden = true;
    root.hidden = true; doc.body.classList.remove("photo-studio-open");
    busy(false);
    if (back && returnTo) returnTo();
    // Let the caller paint its restored visibility after modal isolation settles.
    if (back && target && target.focus && raf) raf(() => raf(() => {
      if (!st.open && st.generation === generation && target.isConnected && target.focus) target.focus();
    }));
  }
  /** Decode a CaptureHook's Blob into a drawable (TODO(lane-render) hook). */
  async function decode(blob: Blob): Promise<ImageBitmap> {
    if (!bitmapOf) throw new Error("Image composition is unavailable");
    return bitmapOf(blob);
  }
  async function frame(opts: PhotoOptions): Promise<HTMLCanvasElement> {
    const gfx = deps.gfx;
    if (gfx && gfx.invalidateSoftPresent && gfx.softPresent && gfx.softPresent()) gfx.invalidateSoftPresent();
    const pending = gfx && gfx.softPresent && gfx.softPresent() && gfx.awaitSoftPresent ? gfx.awaitSoftPresent(15000) : null;
    if (deps.renderFrame) deps.renderFrame();
    // Read WebGL before yielding: its unpreserved backbuffer is cleared after compositing.
    let pixels: Pixels | null | undefined = null, encoded: ImageBitmap | null = null;
    if (gfx && gfx.capturePixels) {
      let read: Promise<Pixels | null | undefined>;
      try { read = gfx.capturePixels(); } catch (e) { read = Promise.reject(e instanceof Error ? e : new Error(String(e))); }
      // Observe both immediately, even when one rejects before the other is
      // ready. The raw pixels are captured now; software presentation may finish later.
      const [presented, captured] = await Promise.allSettled([pending || Promise.resolve(), read]);
      if (presented.status === "rejected") throw presented.reason;
      if (captured.status === "fulfilled") pixels = captured.value;
      else {
        // Native WebGPU canvases can compose directly even when a backend has
        // no readback render target. Draw and copy in this same task instead.
        log.warn("ui: backend readback unavailable; copying the scene canvas", captured.reason);
      }
    } else if (deps.capture) {
      // apex-26: an injected encoded-frame capture, observed alongside any
      // software presentation exactly as the raw readback above; a failure
      // falls back to the same immediate canvas copy.
      let read: Promise<Blob>;
      try { read = deps.capture(opts); } catch (e) { read = Promise.reject(e instanceof Error ? e : new Error(String(e))); }
      const [presented, captured] = await Promise.allSettled([pending || Promise.resolve(), read]);
      if (presented.status === "rejected") throw presented.reason;
      if (captured.status === "fulfilled") encoded = await decode(captured.value);
      else log.warn("ui: capture hook unavailable; copying the scene canvas", captured.reason);
    } else if (pending) await pending;
    if (!pixels && !encoded && !pending && deps.renderFrame) {
      // Repaint immediately before a native canvas copy; no await may come
      // between this draw and drawImage below.
      deps.renderFrame();
    }
    const canvas = canvasEl();
    if (pixels && pixels.data && pixels.width && pixels.height) {
      canvas.width = pixels.width; canvas.height = pixels.height;
      const ctx = ctx2d(canvas);
      if (!ctx) throw new Error("Image composition is unavailable");
      const image = ctx.createImageData(pixels.width, pixels.height); image.data.set(pixels.data); ctx.putImageData(image, 0, 0);
    } else if (encoded) {
      try {
        canvas.width = encoded.width; canvas.height = encoded.height;
        const ctx = ctx2d(canvas); if (!ctx) throw new Error("Image composition is unavailable"); ctx.drawImage(encoded, 0, 0);
      } finally { encoded.close(); }
    } else {
      const soft = doc.getElementById("game-soft") as HTMLCanvasElement | null, source = pending && soft ? soft : sceneCanvas();
      if (!source || !source.width || !source.height) throw new Error("No rendered scene is ready");
      canvas.width = source.width; canvas.height = source.height;
      const ctx = ctx2d(canvas); if (!ctx) throw new Error("Image composition is unavailable"); ctx.drawImage(source, 0, 0);
    }
    return canvas;
  }
  function options(): PhotoOptions { const t = track(); return { aspect: st.aspect, postcard: st.postcard, metadata: { title: st.metadata.title || t && t.name || "GARAGE", subtitle: st.metadata.subtitle || (isGarage() ? "PERSONAL PHOTO" : "RACE MOMENT") } }; }
  function recompose(): void {
    if (!raw || !capturedOptions) return;
    last = compose(raw, { ...capturedOptions, aspect: st.aspect, postcard: st.postcard });
    preview().src = thumbnail(last); preview().hidden = false;
  }
  function keepSource(source: Sized, opts: PhotoOptions): void {
    const size = keepSize(source.width, source.height), copy = canvasEl();
    copy.width = size.width; copy.height = size.height;
    (ctx2d(copy) as CanvasRenderingContext2D).drawImage(source, 0, 0, copy.width, copy.height); raw = copy; capturedOptions = opts;
  }
  function coaching(): HTMLElement {
    const box = mk("details", { id: "ps-coach" }, [mk("summary", { textContent: "COMPOSITION TIPS" })]);
    for (const [label, shot, tip] of [["Car detail", "detail", "Use a narrow lens to make one car detail the subject."], ["Corner story", "corner", "Include the entry and exit so the corner tells a story."], ["Space ahead", "wide", "Leave room in the direction the car is travelling."]] as const) {
      box.appendChild(mk("p", { className: "adv-help", textContent: tip }));
      box.appendChild(button(label, () => { if (st.busy) return; setShot(isGarage() ? ({ detail: "front", corner: "side", wide: "hero" } as const)[shot] : shot); st.grid = "thirds"; (E["ps-grid-select"] as HTMLSelectElement).value = "thirds"; guides(); }));
    }
    box.appendChild(button("DISMISS TIPS", () => { box.hidden = true; })); return box;
  }
  function compose(source: Sized, opts: PhotoOptions = options()): HTMLCanvasElement {
    const box = crop(source.width, source.height, opts.aspect), size = composeSize(box), out = canvasEl();
    out.width = size.width; out.height = size.height;
    const ctx = ctx2d(out); if (!ctx) throw new Error("Image composition is unavailable");
    ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, out.width, out.height);
    if (opts.postcard) {
      const L = postcardLayout(out.width, out.height);
      ctx.fillStyle = "rgba(12,12,20,0.9)"; ctx.fillRect(0, out.height - L.h, out.width, L.h);
      ctx.fillStyle = "#f6f6f9"; ctx.font = "bold " + L.titlePx + "px sans-serif";
      ctx.fillText("APEX 26 · " + text(opts.metadata.title, 70), L.pad, L.titleY, L.maxW);
      ctx.font = L.subPx + "px sans-serif";
      ctx.fillText(text(opts.metadata.subtitle, 90), L.pad, L.subY, L.maxW);
    }
    return out;
  }
  function thumbnail(canvas: HTMLCanvasElement): string {
    const thumb = canvasEl(), size = thumbSize(canvas.width, canvas.height);
    thumb.width = size.width; thumb.height = size.height;
    (ctx2d(thumb) as CanvasRenderingContext2D).drawImage(canvas, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL("image/jpeg", 0.7);
  }
  async function capture(): Promise<boolean> {
    if (!st.open || st.busy) return false;
    const gen = st.generation, opts = options(); busy(true); say("Capturing the rendered scene…");
    try {
      const source = await frame(opts); if (gen !== st.generation) return false;
      keepSource(source, opts); last = compose(raw as HTMLCanvasElement, opts); preview().src = thumbnail(last); preview().hidden = false;
      say("Captured " + last.width + " × " + last.height + ". Ready to download or save."); return true;
    } catch (e) { log.warn("ui: capture failed", e); if (gen === st.generation) say("Capture failed: " + text((e as Error).message, 120) + ". Try again once the scene is ready."); return false; }
    finally { if (gen === st.generation) busy(false); }
  }
  async function download(blob: Blob, name: string): Promise<void> {
    if (deps.saveBlob) {
      await deps.saveBlob(blob, name);
      return;
    }
    const url = URL.createObjectURL(blob), a = doc.createElement("a");
    a.href = url; a.download = name; doc.body.appendChild(a); a.click(); a.remove();
    const id = setTimeout(() => { revokes.delete(id); URL.revokeObjectURL(url); }, 30000);
    revokes.set(id, url);
  }
  async function exportPhoto(): Promise<void> {
    if (!st.open || !last || st.busy || downloading) return;
    downloading = true;
    const gen = st.generation, name = filename(st.metadata.title || "photo"), canvas = last;
    try { await download(await blobOf(canvas), name); if (gen === st.generation) say("PNG download requested."); }
    catch (e) { if (gen === st.generation) say("Download failed: " + text((e as Error).message)); }
    finally { downloading = false; }
  }
  async function savePhoto(): Promise<void> {
    if (!st.open || !last || st.busy) return;
    const gen = st.generation, canvas = last, title = text(st.metadata.title || "Photo");
    busy(true);
    try {
      const blob = await blobOf(canvas, "image/jpeg", 0.88);
      if (blob.size > 3 * 1024 * 1024) throw new Error("This photo is too large. Download the PNG instead");
      const entry: PhotoEntry = { id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), at: Date.now(), title, blob, thumb: thumbnail(canvas) };
      try {
        await library(idb, "save", entry);
        if (gen === st.generation) say("Saved to My Photos on this device.");
      } catch { session.unshift(entry); session.splice(LIMIT); if (gen === st.generation) say("Device storage is unavailable. Saved for this visit; download to keep it."); }
      if (gen === st.generation) await paintLibrary();
    } catch (e) { if (gen === st.generation) say("Save failed: " + text((e as Error).message)); }
    finally { if (gen === st.generation) busy(false); }
  }
  function useBackground(): void { if (last) say(setBg(thumbnail(last)) ? "Personal photo set as menu background. Select My Photo in Appearance." : "Device storage is full. Download the photo to keep it."); }
  async function paintLibrary(): Promise<void> {
    const gen = st.generation, paint = ++libraryPaint;
    let photos: PhotoEntry[]; try { photos = await library(idb, "list") as PhotoEntry[]; } catch { photos = []; }
    if (!st.open || gen !== st.generation || paint !== libraryPaint) return;
    const box = E["ps-library"] as HTMLElement;
    // DELETE repaints the list under the focused button; keepFocus lands on the
    // same slot in the new list instead of dropping focus to <body>.
    const render = (): void => { box.replaceChildren(); paintPhotos(box, photos); };
    if (deps.keepFocus) deps.keepFocus(box, render); else render();
  }
  function paintPhotos(box: HTMLElement, list: readonly PhotoEntry[]): void {
    const photos = list.concat(session).sort((a, b) => b.at - a.at).slice(0, LIMIT);
    if (!photos.length) { box.appendChild(mk("p", { className: "adv-help", textContent: "Capture a frame and save it here. Photos stay on this device." })); return; }
    for (const p of photos) {
      const row = mk("div", { className: "pane" }, [mk("img", { src: p.thumb, alt: p.title || "Saved photo" }), mk("span", { textContent: p.title || "Photo" }),
        button("DOWNLOAD", async () => {
          if (downloading) return;
          downloading = true;
          const gen = st.generation;
          try { await download(p.blob, filename(p.title).replace(/\.png$/, ".jpg")); if (gen === st.generation) say("Photo download requested."); }
          catch (e) { if (gen === st.generation) say("Download failed: " + text((e as Error).message)); }
          finally { downloading = false; }
        }),
        button("MENU BACKGROUND", () => say(setBg(p.thumb) ? "Personal menu background selected." : "Device storage is unavailable.")),
        button("DELETE", async () => { const i = session.findIndex((x) => x.id === p.id); if (i >= 0) session.splice(i, 1); else try { await library(idb, "delete", p.id); } catch { say("Photo could not be deleted."); return; } void paintLibrary(); }),
      ]);
      box.appendChild(row);
    }
  }
  async function importPhoto(file: File | null | undefined): Promise<void> {
    if (!file || !st.open || st.busy) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 12 * 1024 * 1024) { say("Choose a PNG, JPEG or WebP photo under 12 MB."); return; }
    const gen = st.generation, opts = options(); busy(true);
    try {
      if (!bitmapOf) throw new Error("Image decoding is unavailable");
      const image = await bitmapOf(file, { resizeWidth: 1024, resizeQuality: "high" });
      try {
        if (gen !== st.generation) return;
        if (image.height > 4096) throw new Error("Choose a photo with a less extreme aspect ratio");
        keepSource(image, opts); last = compose(raw as HTMLCanvasElement, opts); preview().src = thumbnail(last); preview().hidden = false; say("Personal photo imported. Save it or use it as your menu background.");
      }
      finally { image.close(); }
    } catch (e) { if (gen === st.generation) say("This photo could not be opened: " + text((e as Error).message)); }
    finally { if (gen === st.generation) { busy(false); importFile.value = ""; } }
  }
  function state(): PhotoStudioState { return { open: st.open, generation: st.generation, source: st.source, subject: !!st.subject, aspect: st.aspect, grid: st.grid, postcard: st.postcard, busy: st.busy, captured: !!last, background: !!bg() }; }
  async function album(): Promise<AlbumRow[]> {
    let photos: PhotoEntry[];
    try { photos = await library(idb, "list") as PhotoEntry[]; } catch (e) { if (!session.length) throw e; photos = []; }
    const seen = new Set<string>();
    return photos.concat(session).sort((a, b) => b.at - a.at || String(a.id).localeCompare(String(b.id)))
      .filter((p) => { if (seen.has(p.id)) return false; seen.add(p.id); return BG_RE.test(p.thumb || "") && p.thumb.length < 240000; })
      .slice(0, LIMIT).map((p) => Object.freeze({ id: String(p.id), title: text(p.title || "Photo"), thumb: p.thumb, at: +p.at || 0 }));
  }
  async function contactSheet(times: readonly number[], seek: (t: number) => void, cancelled: () => boolean): Promise<boolean> {
    const out = canvasEl(); out.width = 1536; out.height = 342;
    const ctx = ctx2d(out); if (!ctx) throw new Error("Image composition is unavailable");
    for (let i = 0; i < times.length; i++) {
      if (cancelled()) throw new Error("Contact sheet cancelled");
      seek(times[i]!); const image = await frame({ aspect: "wide", postcard: false, metadata: options().metadata });
      if (cancelled()) throw new Error("Contact sheet cancelled");
      const box = crop(image.width, image.height, "wide");
      ctx.drawImage(image, box.x, box.y, box.width, box.height, i * 512, 0, 512, 288);
      ctx.fillStyle = "#0c0c14"; ctx.fillRect(i * 512, 288, 512, 54); ctx.fillStyle = "#f6f6f9"; ctx.font = "18px sans-serif";
      ctx.fillText(["BEFORE", "MOMENT", "AFTER"][i] + " · " + times[i]!.toFixed(2) + "s", i * 512 + 16, 322);
    }
    const blob = await blobOf(out); if (cancelled()) throw new Error("Contact sheet cancelled");
    await download(blob, "apex26-replay-moment.png"); return true;
  }
  busy(false);
  return {
    open, close, capture, state, contactSheet, album, exportPhoto, savePhoto, hasCar,
    isOpen: () => st.open,
    background: bg,
    setBackground: setBg,
    root,
    unmount() {
      if (!mounted) return;
      if (st.open) { st.closing = false; finishClose(false); }
      st.generation++; mounted = false;
      for (const [id, url] of revokes) { clearTimeout(id); URL.revokeObjectURL(url); }
      revokes.clear();
      root.remove();
    },
  };
}

export const PhotoStudio = Object.freeze({ mount: mountPhotoStudio, background, setBackground, crop, filename, ASPECTS, LIMIT, canvasCapture });
