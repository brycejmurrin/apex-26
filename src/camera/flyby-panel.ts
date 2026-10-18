/**
 * The FLYBY SHOT EDITOR's always-loaded half: the shot language as an editable
 * registry, the pure list operations (add / duplicate / delete / reorder /
 * normalise / validate / export), the saved-list reader the run start uses,
 * and the guarded lazy "door" both camera editors open through.
 *
 * Ported verbatim from f1-game js/camera/flyby-panel.js:1-387 (`FlybyPanel`).
 * The DOM panel itself is ./flyby-editor.ts (FlybyEditor, LAZY_CAM_EDITOR).
 *
 * Port notes:
 * - ensureCamEditor (flyby-panel.js:276-297) loaded LAZY_CAM_EDITOR through
 *   ScriptLoader; here `createCamEditorLoader(load)` memoises any loader (the
 *   shell's dynamic import() of ./flyby-editor and ./tuner-panel, the default)
 *   and forgets a failed attempt so the next open retries, as f1-game does.
 * - The module-level `_pendingUiOpen` shared by both doors is an
 *   `EditorDoorHub`; `DEFAULT_HUB` is the one the two facades share unless the
 *   shell hands them another.
 * - `G` (G.$, G.state, G.paused, G.store) becomes `EditorDoorDeps` /
 *   `FlybyPanelDeps`. TODO(lane-shell): the shell's state machine supplies
 *   state() / paused().
 * - Log.warn("game", …) is the data lane's log sink (src/data/log.ts).
 */
import { log } from "../data/log";
import type { FlybyPose, FlybyShot } from "./flyby-seq";
import type { CamStore } from "./store";

// ---- the shot language, as an editable registry --------------------------
//
// ./flyby-seq.ts owns the MEANING of these fields; this table owns how far a
// slider may push each one. The ranges are authoring bounds, not physical
// ones: the solver already clamps `centre` distances to a helicopter's envelope
// and lifts an eye out of a building, so a slider that can reach silly numbers
// only costs the author a bad frame, never a crash.
export const EASES: readonly string[] = ["linear", "in", "out", "inOut"];
export const AT_KINDS: readonly string[] = ["start", "pole", "grid", "slot", "corner", "centre", "landmark"];
export interface PoseSlot { readonly key: string; readonly arr: "eye" | "look"; readonly i: 0 | 1; readonly label: string }
export const SLOTS: readonly PoseSlot[] = [
  { key: "eye0", arr: "eye", i: 0, label: "EYE FROM" },
  { key: "eye1", arr: "eye", i: 1, label: "EYE TO" },
  { key: "look0", arr: "look", i: 0, label: "LOOK FROM" },
  { key: "look1", arr: "look", i: 1, label: "LOOK TO" },
];
export type PoseField = "off" | "x" | "y" | "bear" | "distR" | "yR" | "distK" | "yK";
// Which numeric fields each anchor actually reads. A field outside this set is
// ignored by the solver, so the editor hides it rather than offering a slider
// that does nothing — the failure mode the camera tuner's `knobApplies` exists
// to prevent, in the same shape.
export const POSE_FIELDS: Readonly<Record<string, readonly PoseField[]>> = {
  start: ["off", "x", "y"],
  pole: ["off", "x", "y"],
  grid: ["off", "x", "y"],
  slot: ["off", "x", "y"],
  corner: ["off", "x", "y"],
  centre: ["bear", "distR", "yR", "y"],
  landmark: ["bear", "distK", "yK", "y"],
};
export interface FieldDef { readonly label: string; readonly min: number; readonly max: number; readonly step: number; readonly unit: string; readonly def: number }
export interface RangeDef { readonly min: number; readonly max: number; readonly step: number; readonly unit: string; readonly def?: number }
export const FIELD: Readonly<Record<PoseField, FieldDef>> = {
  off: { label: "ARC OFFSET", min: -400, max: 400, step: 1, unit: " m", def: 0 },
  // + is RIGHT of the road, except at a corner, where + is its OUTSIDE (flyby-seq.ts)
  x: { label: "LATERAL (+ OUTSIDE AT A CORNER)", min: -60, max: 60, step: 0.5, unit: " m", def: 0 },
  y: { label: "HEIGHT", min: -5, max: 200, step: 0.05, unit: " m", def: 5 },
  bear: { label: "BEARING (0 = TRACK SIDE)", min: -3.15, max: 3.15, step: 0.01, unit: " rad", def: 0 },
  distR: { label: "DISTANCE (LAP RADII)", min: 0, max: 3, step: 0.01, unit: "", def: 1.2 },
  yR: { label: "HEIGHT (LAP RADII)", min: 0, max: 1.5, step: 0.01, unit: "", def: 0.4 },
  distK: { label: "DISTANCE (LANDMARK SIZES)", min: 0, max: 6, step: 0.05, unit: "", def: 1.8 },
  yK: { label: "HEIGHT (LANDMARK HEIGHTS)", min: -1, max: 3, step: 0.05, unit: "", def: 0.4 },
};
export const FIELD_IDS = Object.keys(FIELD) as PoseField[];
// `rank` is a landmark index and `n` a corner, and neither is a continuous
// quantity — both are pickers, and both live outside FIELD for that reason.
export const RANKS: readonly number[] = [0, 1, 2, 3, 4, 5];
export const CORNER_NS: readonly string[] = ["first", "mid", "late", "slowest", "fastest", "lore", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18"];

// max 1: a NORMALISED one-shot list is a single shot of dur 1, and a cap below
// it left that slider pinned at the end and the value unreachable.
export const DUR: RangeDef = { min: 0.01, max: 1, step: 0.005, unit: "" };
export const FOV: RangeDef = { min: 15, max: 90, step: 0.5, unit: "°" };

// ---- pure list operations -------------------------------------------------
//
// Everything below this line is data in, data out: no DOM, no globals, no
// FlybySeq. That is deliberate — it is the half a node test can hold, and
// tests/unit/camera/flyby-panel.test.ts holds it.

/** flyby-panel.js:61 */
export function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

/** The fields this pose's anchor reads, in row order. flyby-panel.js:64 */
export function poseFields(pose: FlybyPose | null | undefined): readonly PoseField[] { return POSE_FIELDS[(pose && pose.at) as string] || POSE_FIELDS["start"]!; }
/** A field's label for this anchor. On `centre` and `landmark` the height is
 *  yR / yK; `y` there is metres ADDED to it, and "HEIGHT" read as the height. flyby-panel.js:67 */
export function fieldLabel(at: string | undefined, f: PoseField): string {
  return (f === "y" && (at === "centre" || at === "landmark")) ? "HEIGHT OFFSET" : FIELD[f].label;
}
/** Centre anchors stay portable as lap-radius fractions, while the editor
 *  shows the concrete distance on the circuit currently being framed. flyby-panel.js:72 */
export function metricValue(f: string, v: unknown, radius: number | null | undefined): string | null {
  return (f === "distR" || f === "yR") && (radius as number) > 0 && typeof v === "number"
    ? Math.round(v * (radius as number)) + " m" : null;
}

/** Re-anchor a pose, KEEPING whatever the new anchor can still use. Switching
 *  `corner` -> `centre` has no sensible arc offset to carry, but a height does,
 *  and dropping it silently would reset an author's framing on every mis-click. flyby-panel.js:80 */
export function switchPoseAt(pose: FlybyPose | null | undefined, at: string): FlybyPose {
  if (AT_KINDS.indexOf(at) === -1) return clone(pose) as FlybyPose;
  const next: FlybyPose = { at: at };
  if (at === "corner") next.n = (pose && pose.n !== undefined) ? pose.n : "first";
  if (at === "slot") next.n = "player";
  if (at === "landmark") next.rank = (pose && typeof pose.rank === "number") ? pose.rank : 0;
  for (const f of POSE_FIELDS[at]!) {
    const carried = (pose && typeof pose[f] === "number") ? pose[f] : undefined;
    next[f] = (carried === undefined) ? FIELD[f].def : carried;
  }
  return next;
}

/** An id nothing else in the list is using: `wide`, `wide-2`, `wide-3`… flyby-panel.js:94 */
export function uniqueId(list: readonly FlybyShot[] | null | undefined, base: string): string {
  const taken: Record<string, boolean> = {};
  for (const s of (list || [])) taken[String(s && s.id)] = true;
  if (!taken[base]) return base;
  for (let n = 2; n < 999; n++) if (!taken[base + "-" + n]) return base + "-" + n;
  return base + "-" + Date.now();
}

/** A new shot, anchored where an author can see it: a slow pull along the
 *  start straight. Not a copy of any shipped shot — a blank one that reads. flyby-panel.js:104 */
export function blankShot(list: readonly FlybyShot[] | null | undefined): FlybyShot {
  return {
    id: uniqueId(list, "shot"), dur: 0.125, ease: "inOut",
    eye: [{ at: "start", off: -60, x: 10, y: 6 }, { at: "start", off: 20, x: 8, y: 5 }],
    look: [{ at: "start", off: 0, x: 0, y: 0.8 }, { at: "start", off: 60, x: 0, y: 0.8 }],
    fov: [38, 42],
  };
}

/** flyby-panel.js:113 */
export function addShot(list: readonly FlybyShot[] | null | undefined, index?: number): FlybyShot[] {
  const out = clone(list || []) as FlybyShot[];
  const at = Math.max(-1, Math.min(out.length - 1, index === undefined ? out.length - 1 : index));
  out.splice(at + 1, 0, blankShot(out));
  return out;
}

/** flyby-panel.js:120 */
export function duplicateShot(list: readonly FlybyShot[] | null | undefined, index?: number): FlybyShot[] {
  const out = clone(list || []) as FlybyShot[];
  if (!out.length) return addShot(out, -1);
  const i = Math.max(0, Math.min(out.length - 1, index || 0));
  const copy = clone(out[i]!);
  copy.id = uniqueId(out, String(out[i]!.id || "shot"));
  out.splice(i + 1, 0, copy);
  return out;
}

/** REFUSES TO EMPTY THE LIST. FlybySeq.solve() falls back to DEFAULT when it is
 *  handed an empty array, so an editor that allowed zero shots would show the
 *  shipped sequence while claiming to show the edit — the one state in which
 *  the live preview lies about what it is previewing. flyby-panel.js:134 */
export function deleteShot(list: readonly FlybyShot[] | null | undefined, index?: number): FlybyShot[] {
  if (!list || list.length <= 1) return clone(list || []) as FlybyShot[];
  const out = clone(list) as FlybyShot[];
  out.splice(Math.max(0, Math.min(out.length - 1, index || 0)), 1);
  return out;
}

/** flyby-panel.js:141 */
export function moveShot(list: readonly FlybyShot[] | null | undefined, index: number, delta: number): FlybyShot[] {
  const out = clone(list || []) as FlybyShot[];
  const from = index | 0, to = from + (delta | 0);
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  out.splice(to, 0, out.splice(from, 1)[0]!);
  return out;
}

/** Rescale durations to sum to exactly 1. The solver normalises internally, so
 *  this changes no framing — it makes the numbers in the copied blob mean what
 *  they look like they mean, which is what bake-flyby.mjs then checks. flyby-panel.js:152 */
export function normaliseDurs(list: readonly FlybyShot[] | null | undefined): FlybyShot[] {
  const out = clone(list || []) as FlybyShot[];
  if (!out.length) return out;
  let sum = 0;
  for (const s of out) sum += (typeof s.dur === "number" && isFinite(s.dur) && s.dur > 0) ? s.dur : 0;
  if (!(sum > 0)) { for (const s of out) s.dur = +(1 / out.length).toFixed(6); return out; }
  for (const s of out) {
    const d = (typeof s.dur === "number" && isFinite(s.dur) && s.dur > 0) ? s.dur : 0;
    s.dur = +(d / sum).toFixed(6);
  }
  return out;
}

type Loose = Record<string, unknown>;

/** Why this pose's NUMBERS cannot be solved. A field the shipped shots leave out
 *  (solve() defaults it) passes; one that is PRESENT must be a finite number
 *  inside its slider range, because `x: "abc"` on a start-anchored pose gave a
 *  non-finite eye on every frame while the old structural check accepted it. flyby-panel.js:169 */
function poseErrors(p: Loose): string[] {
  const bad: string[] = [];
  for (const f of POSE_FIELDS[p["at"] as string]!) {
    const v = p[f];
    if (v === undefined) continue;
    if (typeof v !== "number" || !isFinite(v) || v < FIELD[f].min || v > FIELD[f].max) {
      bad.push(f + " must be a number from " + FIELD[f].min + " to " + FIELD[f].max + ", not " + JSON.stringify(v));
    }
  }
  const int = (v: unknown, lo: number): boolean => typeof v === "number" && isFinite(v) && v === Math.floor(v) && v >= lo;
  if (p["at"] === "corner" && p["n"] !== undefined && CORNER_NS.indexOf(p["n"] as string) === -1 && !int(p["n"], 1)) bad.push("n is not a corner: " + JSON.stringify(p["n"]));
  if (p["at"] === "slot" && p["n"] !== undefined && p["n"] !== "player" && !int(p["n"], 0)) bad.push("n is not a grid slot: " + JSON.stringify(p["n"]));
  if (p["at"] === "landmark" && p["rank"] !== undefined && RANKS.indexOf(p["rank"] as number) === -1) bad.push("rank must be one of " + RANKS.join(", ") + ", not " + JSON.stringify(p["rank"]));
  return bad;
}

/** Every reason FlybySeq.solve() could not PLAY this list. Empty == good.
 *  Split out of validateShots because a SAVED list is read back through this
 *  half only: solve() normalises by the durations' own total, so a list nobody
 *  pressed NORMALISE on still plays exactly as the editor previewed it. Holding
 *  a saved list to the bake step's sum rule would throw away the edit and fall
 *  back to the shipped sequence — which is the defect this file just fixed. flyby-panel.js:191 */
export function shotErrors(list: unknown): string[] {
  const bad: string[] = [];
  if (!Array.isArray(list) || !list.length) return ["the shot list must be a non-empty array"];
  (list as unknown[]).forEach((raw, i) => {
    const s = raw as Loose | null;
    const at = "shot " + i + " (" + ((s && s["id"] as string) || "?") + ")";
    if (!s || typeof s !== "object" || Array.isArray(s)) { bad.push(at + " is not an object"); return; }
    if (typeof s["id"] !== "string" || !s["id"]) bad.push(at + " has no string id");
    const dur = s["dur"];
    if (typeof dur !== "number" || !isFinite(dur) || dur <= 0) bad.push(at + " has no finite positive dur");
    if (EASES.indexOf(s["ease"] as string) === -1) bad.push(at + " ease must be one of " + EASES.join(", "));
    for (const k of ["eye", "look"]) {
      const pair = s[k];
      if (!Array.isArray(pair) || pair.length !== 2) { bad.push(at + " " + k + " must be a [from, to] pair"); continue; }
      (pair as unknown[]).forEach((pr, j) => {
        const p = pr as Loose | null;
        if (!p || typeof p !== "object") { bad.push(at + " " + k + "[" + j + "] is not a pose"); return; }
        if (AT_KINDS.indexOf(p["at"] as string) === -1) { bad.push(at + " " + k + "[" + j + "] has unknown at: " + JSON.stringify(p["at"])); return; }
        poseErrors(p).forEach((e) => bad.push(at + " " + k + "[" + j + "] " + e));
      });
    }
    // In the slider's range, not merely finite: the flyby skips the race
    // camera's FOV cap, so a saved fov of 0 reached the projection as fovY 0.
    const fov = s["fov"];
    if (!Array.isArray(fov) || fov.length !== 2 ||
        !(fov as unknown[]).every((n) => typeof n === "number" && isFinite(n))) bad.push(at + " fov must be [from, to] numbers");
    else if (!(fov as number[]).every((n) => n >= FOV.min && n <= FOV.max)) bad.push(at + " fov must be from " + FOV.min + " to " + FOV.max + ", not " + JSON.stringify(fov));
  });
  return bad;
}

/** Every reason this list would not BAKE. shotErrors plus the one rule the
 *  solver does not need but tools/gen/bake-flyby.mjs enforces, stated here so
 *  the panel can refuse to copy a blob the bake step would reject an hour later. flyby-panel.js:220 */
export function validateShots(list: unknown): string[] {
  const bad = shotErrors(list);
  if (bad.length) return bad;
  let sum = 0;
  for (const s of list as FlybyShot[]) sum += s.dur as number;
  if (Math.abs(sum - 1) > 0.01) bad.push("durations sum to " + sum.toFixed(4) + ", not 1 — press NORMALISE");
  return bad;
}

/** The copyable blob. NAMED `FlybyShots` ON PURPOSE: bake-flyby.mjs refuses any
 *  other name, so a half-list pasted from somewhere else cannot silently
 *  replace the shipped DEFAULT (the interlock the lighting tuner learned). flyby-panel.js:232 */
export function toBlob(list: readonly FlybyShot[] | null | undefined): string {
  const body = (list || []).map((s) => {
    const pose = (p: unknown): string => JSON.stringify(p);
    const fov = s.fov as number[];   // a shot without one throws here, as in f1-game
    return "  {\n" +
      "    id: " + JSON.stringify(s.id) + ", dur: " + s.dur + ", ease: " + JSON.stringify(s.ease) + ",\n" +
      "    eye: [" + pose(s.eye[0]) + ",\n          " + pose(s.eye[1]) + "],\n" +
      "    look: [" + pose(s.look[0]) + ",\n           " + pose(s.look[1]) + "],\n" +
      "    fov: [" + fov[0] + ", " + fov[1] + "],\n" +
      "  }";
  }).join(",\n");
  return "window.FlybyShots = [\n" + body + "\n];";
}

/* THE SAVED LIST CARRIES THE MEANING IT WAS AUTHORED IN. The saved flybyShots
 * was first written as a bare array while a `centre`/`landmark` bear was a WORLD
 * bearing and a corner's +x was its right. Both became relative (bear 0 = the
 * track side, +x = the corner's outside), and a bare array is structurally
 * identical under either meaning — so an old edit would have loaded clean and
 * played every such shot from the other side. No migration is possible: the
 * new value depends on each circuit's geometry, and one list serves them all.
 * So a list is saved as { v, shots }, and anything that is not the current
 * version is ignored (not deleted: the player's next edit overwrites it). Bump
 * SHOTS_VERSION whenever a pose field changes what it means. flyby-panel.js:245-267 */
export const SHOTS_VERSION = 2;
export interface SavedShots { v: number; shots: FlybyShot[] }
export function savedForm(list: FlybyShot[]): SavedShots { return { v: SHOTS_VERSION, shots: list }; }
/** The list inside a saved value, or null when it is from another version.
 *  A numeric fov is CLAMPED to the slider here, on a copy: the free camera
 *  saved 20-110° views before shotErrors held fov to FOV, and refusing those
 *  would drop the whole edit for the shipped flyby. Anything else is judged
 *  by shotErrors as before. */
export function fromSaved(saved: unknown): FlybyShot[] | null {
  const sv = saved as { v?: unknown; shots?: unknown } | null;
  const list = (sv && !Array.isArray(sv) && sv.v === SHOTS_VERSION) ? sv.shots : null;
  const num = (n: unknown): boolean => typeof n === "number" && isFinite(n);
  return !Array.isArray(list) ? list as null : (list as unknown[]).map((raw) => {
    const s = raw as FlybyShot | null;
    return (s && Array.isArray(s.fov) && s.fov.every(num))
      ? Object.assign({}, s, { fov: s.fov.map((n) => Math.min(FOV.max, Math.max(FOV.min, n))) }) : s;
  }) as FlybyShot[];
}

/** The playable saved list, or null (flyby-panel.js:352-361; flyby-editor.js:60-69). A COPY. */
export function loadSavedFrom(store: Pick<CamStore, "get"> | null | undefined): FlybyShot[] | null {
  let saved: unknown = null;
  try { saved = store ? store.get("flybyShots", null) : null; } catch { return null; }
  if (!saved) return null;
  const list = fromSaved(saved);
  if (!list) { log.warn("saved flyby shots predate the current pose meaning — playing the shipped sequence"); return null; }
  const bad = shotErrors(list);
  if (bad.length) { log.warn("saved flyby shots unusable: " + bad[0]); return null; }
  return clone(list);
}

// ---- the lazy editor bundle and its two doors -----------------------------

/** ensureCamEditor (flyby-panel.js:276-297): load once, retry after a failure. */
export function createCamEditorLoader(load: () => Promise<boolean>): () => Promise<boolean> {
  let pending: Promise<boolean> | null = null;
  return function ensureCamEditor(): Promise<boolean> {
    if (pending) return pending;
    pending = Promise.resolve().then(load).then((ok) => {
      if (!ok) { pending = null; log.warn("the camera editor bundle did not load"); return false; }
      return true;
    }, (e: unknown) => { pending = null; log.warn("the camera editor bundle did not load", e); return false; });
    return pending;
  };
}

interface DoorRequest {
  cancel(): void;
  readonly state: unknown;
  readonly paused: boolean;
  observer: MutationObserver | null;
}
/** The one pending UI open both doors share (flyby-panel.js:301 `_pendingUiOpen`). */
export interface EditorDoorHub { pending: DoorRequest | null }
export const DEFAULT_HUB: EditorDoorHub = { pending: null };

export interface EditorDoorDeps {
  /** G.$ */
  $(id: string): HTMLElement | null;
  /** G.state. TODO(lane-shell). */
  state(): unknown;
  /** G.paused. TODO(lane-shell). */
  paused(): boolean;
  readonly hub?: EditorDoorHub;
  readonly MutationObserver?: typeof MutationObserver | null;
}

export interface EditorOpener { open(): Promise<void>; cancel(): void; bind(): void }

/** Both editor doors share one lazy bundle and one Settings route. Loading may
 *  finish after BACK, resume or a newer door; only that visit may reveal a dock.
 *  flyby-panel.js:302-345 */
export function createEditorOpener<T>(G: EditorDoorDeps, buttonId: string, ensure: () => Promise<T | null>, method: keyof T & string): EditorOpener {
  const hub = G.hub || DEFAULT_HUB;
  const MO = G.MutationObserver !== undefined ? G.MutationObserver : (typeof MutationObserver !== "undefined" ? MutationObserver : null);
  let pending: DoorRequest | null = null;
  function cancel(): void {
    const request = pending;
    pending = null;
    if (request && request.observer) request.observer.disconnect();
    if (hub.pending === request) hub.pending = null;
  }
  function bind(): void {
    const button = G.$(buttonId);
    if (button) button.onclick = () => { void open(true); };
  }
  function open(fromUi: boolean): Promise<void> {
    cancel();
    // Follow the button's owning Settings page when destinations are reorganized.
    const settings = G.$("pmsettings"), button = G.$(buttonId), host = button && button.closest<HTMLElement>('[id^="pm-panel-"]');
    const visible = (): boolean => !!(settings && !settings.hidden && host && !host.hidden);
    if (fromUi && !visible()) return Promise.resolve();
    if (fromUi && hub.pending) hub.pending.cancel();
    const request: DoorRequest = { cancel, state: G.state(), paused: G.paused(), observer: null };
    pending = request;
    if (fromUi) {
      hub.pending = request;
      if (MO) {
        request.observer = new MO(() => { if (pending === request) cancel(); });
        // Even hide-then-reopen ends the old visit. Observe only while waiting.
        request.observer.observe(settings!, { attributes: true, attributeFilter: ["hidden"] });
        request.observer.observe(host!, { attributes: true, attributeFilter: ["hidden"] });
      }
    }
    return Promise.resolve().then(ensure).then((real) => {
      if (pending !== request) return;
      const changed = !!request.observer && request.observer.takeRecords().length > 0;
      const allowed = !fromUi || (!changed && visible() && G.state() === request.state && G.paused() === request.paused);
      cancel(); // real.open hides Settings itself; release its observer first.
      const fn = real ? (real as Record<string, unknown>)[method] : null;
      if (allowed && real && typeof fn === "function") (fn as () => void).call(real);
    }, (error: unknown) => {
      if (pending === request) cancel();
      log.warn("camera editor did not open", error);
    });
  }
  bind();
  return { open: () => open(false), cancel, bind };
}

/** What the lazily-created editor exposes (./flyby-editor.ts FlybyEditorMount). */
export interface FlybyEditorLike {
  openFlyby(): void;
  closeFlyby(showPauseMenu?: boolean): void;
  isOpen(): boolean;
  setApiLoader?(fn: (() => unknown) | null): void;
  list?(): FlybyShot[];
}

export interface FlybyPanelDeps extends EditorDoorDeps {
  readonly store?: Pick<CamStore, "get"> | null;
  /** Load the editor bundle and create the editor (ensureCamEditor + FlybyEditor.create(G)). TODO(lane-shell). */
  createEditor(): Promise<FlybyEditorLike | null>;
}

/** The always-loaded FLYBY SHOT EDITOR facade (flyby-panel.js:348-383 `create`). */
export function createFlybyPanel(G: FlybyPanelDeps) {
  log.info("FlybyPanel.create");
  const { store } = G;
  let real: FlybyEditorLike | null = null, _apiLoader: (() => unknown) | null = null;
  function loadSaved(): FlybyShot[] | null { return loadSavedFrom(store); }
  function ensure(): Promise<FlybyEditorLike | null> {
    if (real) return Promise.resolve(real);
    return G.createEditor().then((ed) => {
      if (!ed) return null;
      if (!real) {
        real = ed;
        opener.bind(); // create() wires a direct handler; keep the guarded door.
        if (_apiLoader && real.setApiLoader) real.setApiLoader(_apiLoader);
      }
      return real;
    });
  }
  const opener = createEditorOpener(G, "pm-flyby", ensure, "openFlyby");
  return {
    openFlyby: opener.open,
    closeFlyby: (show?: boolean): void => { opener.cancel(); if (real) real.closeFlyby(show); },
    isOpen: (): boolean => !!(real && real.isOpen && real.isOpen()),
    setApiLoader: (fn: (() => unknown) | null): void => { _apiLoader = fn; if (real && real.setApiLoader) real.setApiLoader(fn); },
    loadSaved,
    list: (): FlybyShot[] => real && real.list ? real.list() : [],
  };
}
export type FlybyPanel = ReturnType<typeof createFlybyPanel>;

export const FlybyPanelOps = Object.freeze({
  EASES, AT_KINDS, POSE_FIELDS, FIELD, FIELD_IDS, FOV, SLOTS, CORNER_NS, RANKS, SHOTS_VERSION, DUR,
  clone, poseFields, fieldLabel, metricValue, switchPoseAt, uniqueId, blankShot, savedForm, fromSaved,
  addShot, duplicateShot, deleteShot, moveShot, normaliseDurs, shotErrors, validateShots, toBlob,
});
