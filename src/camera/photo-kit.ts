/**
 * Photo-mode kit extras: composition grids, depth-of-field hint, and
 * per-circuit camera bookmarks (a26.freecamMarks). Pure helpers + a thin DOM
 * binder the FREE CAMERA panel (./free-cam.ts) calls so free-cam stays the
 * panel owner. DoF is a CSS soft-focus overlay (no optical DoF in any backend
 * yet — the flyby plan rejected backend DoF); bookmarks are world
 * eye/target/fov (+ optional roll).
 *
 * Ported verbatim from f1-game js/camera/photo-kit.js:1-133 (`PhotoKit`).
 *
 * Port notes:
 * - The store is the camera lane's `CamStore` (./store.ts), whose keys land
 *   under `a26.` (f1-game: `apex26.freecamMarks`).
 * - `saveMark` takes an optional clock (`now`, default Date.now) for the
 *   bookmark's `t` stamp, so tests can pin it. Same value in the game.
 * - `mountOverlays` also returns `remove()`, which takes down exactly the
 *   overlay nodes this call created (the panel's unmount; f1-game never
 *   unmounts).
 */
import { clamp } from "../physics/math";   // f1-game js/core/mat4.js:5 (M4.clamp)
import type { CamStore } from "./store";

export const MARK_KEY = "freecamMarks";
export const GRID_IDS: readonly string[] = Object.freeze(["off", "thirds", "golden"]);
export const DOF_BLUR_MAX = 6;      // CSS px at full strength
export const MAX_MARKS = 12;        // per track

export type Vec3 = [number, number, number];

/** One saved bookmark (photo-kit.js:34-41). */
export interface PhotoMark { name: string; eye: Vec3; target: Vec3; fov: number; roll: number; t: number }
/** What SAVE MARK hands in: any eye/target triple, the rest optional and sanitised. */
export interface MarkInput {
  readonly name?: unknown;
  readonly eye: ArrayLike<unknown>;
  readonly target: ArrayLike<unknown>;
  readonly fov?: unknown;
  readonly roll?: unknown;
}
/** The JSON lane of the store, which is all the bookmarks use. */
export type MarkStore = Pick<CamStore, "get" | "set">;
/** The DoF fields `applyDof` attaches to a published camera (dbgCam). */
export interface DofCam { dof?: { focus: number; blur: number } }

const fin = (v: unknown): v is number => typeof v === "number" && isFinite(v);

/** photo-kit.js:17 */
export function loadAll(store: MarkStore | null | undefined): Record<string, unknown> {
  if (!store || typeof store.get !== "function") return {};
  const raw = store.get(MARK_KEY, null);
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

/** photo-kit.js:23 */
export function marksFor(store: MarkStore | null | undefined, trackId: string): PhotoMark[] {
  const all = loadAll(store);
  const list = all[trackId];
  return Array.isArray(list) ? list as PhotoMark[] : [];
}

/** Save a bookmark. Returns the new list for that track, or null on failure. photo-kit.js:29-47 */
export function saveMark(store: MarkStore | null | undefined, trackId: string, mark: MarkInput | null | undefined, now: () => number = Date.now): PhotoMark[] | null {
  if (!store || !trackId || !mark || !mark.eye || !mark.target) return null;
  const all = loadAll(store);
  const prev = all[trackId];
  const list: PhotoMark[] = Array.isArray(prev) ? (prev as PhotoMark[]).slice() : [];
  const entry: PhotoMark = {
    name: String(mark.name || ("Mark " + (list.length + 1))).slice(0, 40),
    eye: [Number(mark.eye[0]), Number(mark.eye[1]), Number(mark.eye[2])],
    target: [Number(mark.target[0]), Number(mark.target[1]), Number(mark.target[2])],
    fov: clamp(fin(Number(mark.fov)) ? Number(mark.fov) : 60, 20, 110),
    roll: clamp(fin(Number(mark.roll)) ? Number(mark.roll) : 0, -45, 45),
    t: now(),
  };
  list.push(entry);
  while (list.length > MAX_MARKS) list.shift();
  all[trackId] = list;
  store.set(MARK_KEY, all);
  return list;
}

/** photo-kit.js:49-58 */
export function deleteMark(store: MarkStore | null | undefined, trackId: string, index: number): PhotoMark[] | null {
  if (!store || !trackId) return null;
  const all = loadAll(store);
  const prev = all[trackId];
  const list: PhotoMark[] = Array.isArray(prev) ? (prev as PhotoMark[]).slice() : [];
  if (!(index >= 0) || index >= list.length) return list;
  list.splice(index | 0, 1);
  all[trackId] = list;
  store.set(MARK_KEY, all);
  return list;
}

/** off → thirds → golden → off. photo-kit.js:60 */
export function nextGrid(cur: string): string {
  const i = GRID_IDS.indexOf(cur);
  return GRID_IDS[((i < 0 ? 0 : i) + 1) % GRID_IDS.length]!;
}

/** Attach DoF fields onto a dbgCam and drive the CSS overlay variables. photo-kit.js:65-81 */
export function applyDof(cam: DofCam | null | undefined, focus: unknown, blur: unknown, overlay: HTMLElement | null | undefined): { focus: number; blur: number } {
  const f = clamp(fin(Number(focus)) ? Number(focus) : 0.35, 0, 1);
  const b = clamp(fin(Number(blur)) ? Number(blur) : 0, 0, 1);
  if (cam) cam.dof = { focus: f, blur: b };
  if (overlay && overlay.style) {
    overlay.style.setProperty("--fc-dof-blur", (b * DOF_BLUR_MAX).toFixed(2) + "px");
    // Clear disc radius: larger focus = larger sharp centre.
    const clear = Math.round(18 + f * 42);
    const soft = Math.round(clear + 22 + b * 18);
    overlay.style.setProperty("--fc-dof-clear", clear + "%");
    overlay.style.setProperty("--fc-dof-soft", soft + "%");
    overlay.hidden = b < 0.02;
    overlay.setAttribute("aria-hidden", overlay.hidden ? "true" : "false");
  }
  return { focus: f, blur: b };
}

/** photo-kit.js:83-91 */
export function setGrid(overlay: HTMLElement | null | undefined, id: string): string {
  const g = GRID_IDS.indexOf(id) >= 0 ? id : "off";
  if (overlay) {
    overlay.dataset["grid"] = g;
    overlay.hidden = g === "off";
    overlay.setAttribute("aria-hidden", overlay.hidden ? "true" : "false");
  }
  return g;
}

export interface KitOverlays { grid: HTMLElement | null; dof: HTMLElement | null; remove(): void }

/**
 * Build the viewport overlays (grid + DoF) once. Returns { grid, dof } nodes
 * appended to `parent` (usually document.body). Id-styled — no new CSS class
 * tokens. photo-kit.js:93-119
 */
export function mountOverlays(parent: HTMLElement | null | undefined, doc?: Document | null): KitOverlays {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || !parent) return { grid: null, dof: null, remove() {} };
  const made: HTMLElement[] = [];
  let grid = d.getElementById("fc-comp-grid");
  if (!grid) {
    grid = d.createElement("div");
    grid.id = "fc-comp-grid";
    grid.hidden = true;
    grid.setAttribute("aria-hidden", "true");
    grid.dataset["grid"] = "off";
    parent.appendChild(grid);
    made.push(grid);
  }
  let dof = d.getElementById("fc-dof");
  if (!dof) {
    dof = d.createElement("div");
    dof.id = "fc-dof";
    dof.hidden = true;
    dof.setAttribute("aria-hidden", "true");
    parent.appendChild(dof);
    made.push(dof);
  }
  return { grid, dof, remove() { for (const el of made) el.remove(); made.length = 0; } };
}

/** photo-kit.js:121-126 */
export function showOverlays(on: boolean, grid: HTMLElement | null | undefined, dof: HTMLElement | null | undefined): void {
  if (!on) {
    if (grid) { grid.hidden = true; grid.setAttribute("aria-hidden", "true"); }
    if (dof) { dof.hidden = true; dof.setAttribute("aria-hidden", "true"); }
  }
}

export const PhotoKit = Object.freeze({
  MARK_KEY, GRID_IDS, DOF_BLUR_MAX, MAX_MARKS,
  loadAll, marksFor, saveMark, deleteMark, nextGrid,
  applyDof, setGrid, mountOverlays, showOverlays, clamp,
});
