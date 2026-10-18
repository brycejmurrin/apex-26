/**
 * The FREE CAMERA pause-menu panel (#freecam): photo mode's fly-cam
 * (./photo-cam.ts) as a first-class tool, with a speed dial, roll, FOV, snaps
 * to the car and to each corner, a RACE/FLYBY lens, and COPY as an
 * __apex.view() line or as a flyby pose (FlybySeq.shotFromView).
 *
 * Ported verbatim from f1-game js/camera/free-cam.js:1-524 (`FreeCam`), plus
 * the layer's static shell from index.html:3421-3427 (#freecam and its
 * #fc-close door), which `mountFreeCam` builds with the same ids.
 *
 * The `G` context and the IIFE's globals become `FreeCamDeps`:
 *   G.photoCam                        → deps.photoCam (photo mode's fly-cam state)
 *   G.dbgCam                          → deps.dbgCam() (photo mode publishes it)
 *   G.track / G.track.id || .name     → deps.track(); the id is read off it as f1-game does
 *   G.player (c.px/pz/head/s)         → deps.player() — a DISPLAY pose of the
 *       player car, read-only. TODO(lane-shell): the shell maps the render
 *       pose (CarState px/pz/head/s) into it; nothing here writes it back.
 *   G.paused / G.photoMode            → deps.paused() / deps.photoMode()
 *   G.store                           → deps.store (./store.ts, a26.freecamMarks)
 *   Tracks.sample                     → deps.sample (default src/track/core)
 *   FlybySeq                          → deps.flyby (a ./flyby-seq.ts instance);
 *       `track._fbCorners` is `flyby.cornerList(track)`, and cornerPose's
 *       per-track memo (`track._fcCorner`) is a WeakMap.
 *   ApexClipboard.write               → deps.clipboard (default navigator.clipboard)
 *   G.soundOn && GameAudio.uiTick     → deps.uiTick. TODO(lane-shell): audio.
 *   photo = { enter, exit, publish, releaseKeys } → deps.photo (photo-cam.ts
 *       passes its own, exactly as photo-cam.js:146-148 does)
 *   the module's `live` instance      → the returned mount: the flyby editor and
 *       __apex.freeCam (TODO(lane-shell)) take it as a dep instead of a global.
 *   window / document                 → deps.win / el.ownerDocument
 *
 * Camera only: everything here moves the free camera; the player car is only
 * ever read (SNAP TO CAR), never driven (AGENTS.md arc rule).
 */
import { log } from "../data/log";
import { clamp } from "../physics/math";   // f1-game js/core/mat4.js:5 (M4.clamp)
import { sample as coreSample } from "../track/core/tracks";
import type { Sample } from "../track/core/types";
import type { FlybyCorner, FlybyPose, FlybyShot, FlybyTrack, Vec3 } from "./flyby-seq";
import * as PhotoKit from "./photo-kit";
import type { MarkStore } from "./photo-kit";
import "../styles";   // fixes the @layer order before the camera sheets join `components`
import "./camera.css";
import "./photo.css";

// ---- pure camera maths -----------------------------------------------------
//
// Everything in this block is data in, data out — no DOM, no G. It is the half
// tests/unit/camera/free-cam.test.ts holds without mounting the panel.

export const SPD_MIN = 5, SPD_MAX = 200, SPD_DEF = 34;   // m/s; 34 is photo mode's walk
export const BOOST = 95 / 34;                             // Shift, photo mode's ratio
export const ROLL_MAX = 45;                               // degrees either way
const ROLL_RATE = 40;                                     // deg/s while Q/E is held
const WHEEL_STEP = 1.15;                                  // one wheel notch of speed
const SLIDER_MAX = 1000;
export const FOV_MIN = 20, FOV_MAX = 110;                 // photo mode's #pc-fov range

const fin = (v: unknown): v is number => typeof v === "number" && isFinite(v);

/** The SPEED slider is logarithmic: 0 -> 5 m/s, 1000 -> 200 m/s. A linear
 *  5-200 slider spends its first centimetre on everything that frames a car. free-cam.js:23 */
export function speedFromSlider(v: unknown): number {
  const t = clamp(fin(Number(v)) ? Number(v) : 0, 0, SLIDER_MAX) / SLIDER_MAX;
  return SPD_MIN * Math.pow(SPD_MAX / SPD_MIN, t);
}
/** free-cam.js:27 */
export function sliderFromSpeed(s: unknown): number {
  const c = clampSpeed(s);
  return Math.round(SLIDER_MAX * Math.log(c / SPD_MIN) / Math.log(SPD_MAX / SPD_MIN));
}
/** free-cam.js:31 */
export function clampSpeed(s: unknown): number { return clamp(fin(Number(s)) ? Number(s) : SPD_DEF, SPD_MIN, SPD_MAX); }
/** One wheel event: up (deltaY < 0) is faster. free-cam.js:33 */
export function wheelSpeed(s: unknown, deltaY: number): number {
  if (!deltaY) return clampSpeed(s);
  return clampSpeed(clampSpeed(s) * (deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP));
}
/** Roll in DEGREES, clamped to ±ROLL_MAX; anything unparseable is level. free-cam.js:38 */
export function clampRoll(deg: unknown): number { return clamp(fin(Number(deg)) ? Number(deg) : 0, -ROLL_MAX, ROLL_MAX); }
/** free-cam.js:39 */
export function clampFov(f: unknown): number { return clamp(fin(Number(f)) ? Number(f) : 60, FOV_MIN, FOV_MAX); }

const r2 = (n: number): number => Math.round(n * 100) / 100;
const v3 = (a: ArrayLike<number>): string => "[" + r2(a[0]!) + "," + r2(a[1]!) + "," + r2(a[2]!) + "]";
/** The line COPY VIEW puts on the clipboard: pasted into a console on the same
 *  circuit, it frames exactly this picture through the documented dev hook. free-cam.js:45 */
export function viewSnippet(eye: ArrayLike<number>, target: ArrayLike<number>, fov: number): string {
  return "__apex.view({eye:" + v3(eye) + ",target:" + v3(target) + ",fov:" + r2(fov) + "})";
}

/** Photo mode's look convention (./photo-cam.ts integrate):
 *  fwd = [sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)]. free-cam.js:51 */
export function aim(eye: Readonly<Vec3>, target: Readonly<Vec3>): { yaw: number; pitch: number } {
  let dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
  const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
  return { yaw: Math.atan2(dx, -dz), pitch: clamp(Math.asin(clamp(dy, -1, 1)), -1.45, 1.45) };
}

const CAR_BACK = 9, CAR_UP = 3.2, CAR_AHEAD = 14, CAR_LOOK_UP = 1;
/** The player car as SNAP TO CAR reads it: world (px, pz), heading `head`, arc `s`. */
export interface FreeCamCar { readonly px?: number | null; readonly pz: number; readonly head?: number; readonly s?: number }
/** A chase-style framing of a car at world (px, pz), heading `head`
 *  (c.head = atan2(t.x, t.z), so forward is [sin head, cos head]), road at y. free-cam.js:60 */
export function carPose(car: FreeCamCar, y: number): { eye: Vec3; target: Vec3 } {
  const fx = Math.sin(car.head || 0), fz = Math.cos(car.head || 0);
  const px = car.px as number;
  return {
    eye: [px - fx * CAR_BACK, y + CAR_UP, car.pz - fz * CAR_BACK],
    target: [px + fx * CAR_AHEAD, y + CAR_LOOK_UP, car.pz + fz * CAR_AHEAD],
  };
}

/** The FlybySeq members the free camera reads (a ./flyby-seq.ts instance satisfies it). */
export interface FreeCamFlyby {
  cornerList(track: FlybyTrack): readonly FlybyCorner[];
  solve(track: FlybyTrack, u: number, shots?: readonly FlybyShot[] | null): { readonly eye: Readonly<Vec3>; readonly tgt: Readonly<Vec3> };
  reset(): void;
  poseFromWorld?(track: FlybyTrack, p: Readonly<Vec3>): { pose: FlybyPose; err: number };
  shotFromView?(track: FlybyTrack, eye: Readonly<Vec3>, target: Readonly<Vec3>, fov?: number | null): { shot: FlybyShot; err: { eye: number; look: number } };
  readonly FAR: number;
  readonly FOG: number;
}

export interface CornerPose { n: number; count: number; eye: Vec3; target: Vec3 }

const CN_OUT = 30, CN_BACK = 18, CN_UP = 9;
// track._fcCorner (free-cam.js:83), per flyby instance: a different solver may plan differently.
const _cornerMemo = new WeakMap<FreeCamFlyby, WeakMap<FlybyTrack, Record<number, CornerPose>>>();
/** Corner n (1-based, wrapped into the circuit's own count) seen from its
 *  OUTSIDE, a little before the apex, looking at the apex. Reads the same
 *  corner list the flyby sequencer and the picker's map use. free-cam.js:72-92 */
export function cornerPose(flyby: FreeCamFlyby, track: FlybyTrack, n: number): CornerPose | null {
  const count = flyby.cornerList(track).length;   // FlybySeq.cornerS(track, 1) fills the list
  if (!count) return null;
  const k = ((((n | 0) - 1) % count) + count) % count + 1;
  // Through the FLYBY PLANNER, as a held one-frame shot: the same fence cap,
  // step-in, tree and building clearance the loading screen's corner shots
  // get. A raw point 30 m out landed inside Monza's pine canopy.
  // The plan is a pure function of the built track, but solving it costs up to
  // ~650 ms on a busy circuit, so each corner is solved once and memoised on the
  // track object (a rebuilt track is a new object and re-plans). Callers get a copy.
  let byTrack = _cornerMemo.get(flyby);
  if (!byTrack) { byTrack = new WeakMap(); _cornerMemo.set(flyby, byTrack); }
  let memo = byTrack.get(track);
  if (!memo) { memo = {}; byTrack.set(track, memo); }
  let hit = memo[k];
  if (!hit) {
    const eye: FlybyPose = { at: "corner", n: k, off: -CN_BACK, x: CN_OUT, y: CN_UP }, look: FlybyPose = { at: "corner", n: k, off: 0, x: 0, y: 1 };
    const v = flyby.solve(track, 0, [{ id: "snap", dur: 1, ease: "linear", eye: [eye, eye], look: [look, look], fov: [50, 50] }]);
    hit = memo[k] = { n: k, count, eye: v.eye.slice() as Vec3, target: v.tgt.slice() as Vec3 };
    flyby.reset();   // a borrowed solve must not leave the next loading-screen flyby thinking its first frame is not a cut
  }
  return { n: hit.n, count: hit.count, eye: hit.eye.slice() as Vec3, target: hit.target.slice() as Vec3 };
}

/** A pose from FlybySeq.poseFromWorld as a short human line. free-cam.js:95 */
export function anchorText(pose: FlybyPose | null | undefined): string {
  if (!pose) return "—";
  const sg = (v: number | undefined): string => ((v as number) >= 0 ? "+" : "") + r2(v || 0);
  switch (pose.at) {
    case "corner": return "T" + pose.n + " " + sg(pose.off) + " m, " + sg(pose.x) + " m out";
    case "start": return "start " + sg(pose.off) + " m";
    case "landmark": return "landmark #" + ((pose.rank as number) + 1);
    case "centre": return "whole circuit";
    default: return String(pose.at);
  }
}

// ---- the panel -------------------------------------------------------------

/** Photo mode's fly-cam state (G.photoCam). */
export interface PhotoCamState { pos: Vec3; yaw: number; pitch: number; fov: number }

/** The camera photo mode publishes each frame (G.dbgCam), as the free camera decorates it. */
export interface FreeCamView {
  eye: Vec3; target: Vec3; fov: number;
  far?: number; fog?: number; roll?: number; cine?: boolean;
  dof?: { focus: number; blur: number };
}

/** The photo-mode hooks the panel drives (photo-cam.js:147). */
export interface PhotoHooks {
  enter?(): void;
  exit?(): void;
  publish?(): void;
  releaseKeys?(): void;
}

/** One pose action a tool hands the panel: run(flybyPose) -> message or falsy. */
export interface FreeCamAction {
  readonly label: string;
  readonly title?: string;
  run(r: { shot: FlybyShot; err: { eye: number; look: number } }): string | null | undefined | void;
}

/** __apex.freeCam's options (docs/DEBUG-HOOKS.md), plus enterFrom's back/actions. */
export interface FreeCamCmd {
  speed?: unknown; roll?: unknown; lens?: string | null;
  snap?: "car" | "corner" | string; n?: number | null;
  eye?: Readonly<Vec3> | null; target?: Readonly<Vec3> | null; fov?: unknown;
  back?: (() => void) | null;
  actions?: readonly FreeCamAction[] | null;
}

export interface FreeCamState {
  open: boolean; speed: number; roll: number; lens: string; corner: number;
  eye: number[] | null; target: number[] | null; fov: number | null;
  anchor: string; poseErr: string | null;
  grid: string; dofFocus: number; dofBlur: number;
}

export interface FreeCamDeps {
  readonly photoCam: PhotoCamState;
  /** G.dbgCam: the camera photo mode published last. */
  dbgCam(): FreeCamView | null;
  /** G.track (null before a race is built). */
  track(): FlybyTrack | null | undefined;
  /** G.player, read-only display pose. TODO(lane-shell). */
  readonly player?: (() => FreeCamCar | null | undefined) | null;
  readonly paused?: (() => boolean) | null;
  readonly photoMode?: (() => boolean) | null;
  readonly flyby?: FreeCamFlyby | null;
  readonly store?: MarkStore | null;
  readonly sample?: ((track: FlybyTrack, s: number, out: Sample) => Sample) | null;
  readonly clipboard?: ((text: string) => Promise<boolean>) | null;
  readonly uiTick?: (() => void) | null;
  /** Photo mode's hooks; photo-cam.ts passes its own. */
  readonly photo?: PhotoHooks | null;
  /** Where the viewport overlays go (default the document body). */
  readonly overlayParent?: HTMLElement | null;
  /** The window wheel / blur listen on (default the element's window). */
  readonly win?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
}

export interface FreeCamMount {
  open(): boolean;
  close(showPauseMenu?: boolean, keepPhotoMode?: boolean): void;
  isOpen(): boolean;
  onPhotoExit(): void;
  enterFrom(opts?: FreeCamCmd | null): boolean;
  speed(boost?: boolean): number;
  decorate(cam: FreeCamView | null | undefined, dt: number): void;
  key(code: string, down: boolean, focused: Element | null): number;
  releaseKeys(): void;
  cmd(opts?: FreeCamCmd | boolean | null): FreeCamState | false;
  state(): FreeCamState;
  place(eye: Readonly<Vec3>, target: Readonly<Vec3>, fov?: unknown): void;
  snapCar(): boolean;
  snapCorner(n: number): boolean;
  copyView(): string;
  copyPose(): { shot: FlybyShot; err: { eye: number; look: number } } | null;
  flybyPose(): { shot: FlybyShot; err: { eye: number; look: number } } | null;
  setOverlaysVisible(on: boolean): void;
  panel(): HTMLElement | null;
  /** The #freecam layer this mount built. */
  readonly root: HTMLElement;
  unmount(): void;
}

function defaultClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) return navigator.clipboard.writeText(text).then(() => true, () => false);
  } catch { /* no clipboard */ }
  return Promise.resolve(false);
}

/** index.html:3421-3427: the layer and its Escape door, built rather than static. */
function buildShell(doc: Document): HTMLElement {
  const root = doc.createElement("div");
  root.id = "freecam"; root.setAttribute("role", "region"); root.setAttribute("aria-label", "Free camera");
  root.dataset["escClose"] = "fc-close"; root.hidden = true;
  const close = doc.createElement("button");
  close.id = "fc-close"; close.className = "bigbtn"; close.type = "button"; close.textContent = "DONE";
  root.appendChild(close);
  return root;
}

type Props = Record<string, unknown> & { attrs?: Record<string, string> };

/** Build the FREE CAMERA in `el` and wire it to `deps` (free-cam.js:114-510 `create`). */
export function mountFreeCam(el: HTMLElement, deps: FreeCamDeps): FreeCamMount {
  log.info("FreeCam.create");
  const doc = el.ownerDocument;
  const win = deps.win !== undefined ? deps.win : (doc.defaultView as Window | null);
  const photoCam = deps.photoCam;
  const photo = deps.photo || null;
  const flyby = deps.flyby || null;
  const sampleFn = deps.sample || ((t: FlybyTrack, s: number, out: Sample): Sample => coreSample(t, s, out));
  const clipboard = deps.clipboard || defaultClipboard;
  const $ = (id: string): HTMLElement | null => doc.getElementById(id);
  const track = (): FlybyTrack | null => deps.track() || null;
  const trackKey = (t: FlybyTrack): string => { const o = t as unknown as { id?: string; name?: string }; return o.id || o.name || "track"; };
  const paused = (): boolean => !!(deps.paused && deps.paused());
  const photoMode = (): boolean => !!(deps.photoMode && deps.photoMode());
  // back / actions: set only when a tool opened this as its SUB-MODE (the flyby
  // editor's FREE CAMERA button, enterFrom below). DONE then returns to that tool
  // rather than to the pause menu, and the tool's pose actions show in #fc-shot.
  const st = { open: false, speed: SPD_DEF, roll: 0, lens: "race", corner: 0, anchor: "—", poseErr: null as string | null, statusT: 0,
    back: null as (() => void) | null, actions: null as readonly FreeCamAction[] | null, overlays: true, grid: "off", dofFocus: 0.4, dofBlur: 0 };
  const rk = { q: false, e: false };
  // Composition grid + soft DoF overlays (./photo-kit.ts) — viewport, not panel.
  const kitOverlays = PhotoKit.mountOverlays(deps.overlayParent || doc.body, doc);

  // ---- DOM (built here: the shell holds only the layer and its door) ----
  const root = buildShell(doc);
  el.appendChild(root);
  // E: every element built below, by id — held here rather than looked up again.
  const E: Record<string, HTMLElement> = {};
  const mk = (tag: string, props?: Props | null, kids?: readonly Node[]): HTMLElement => {
    const node = doc.createElement(tag);
    if (props && typeof props["id"] === "string" && props["id"]) E[props["id"]] = node;
    if (props) for (const k in props) {
      if (k === "attrs") { for (const a in props.attrs) node.setAttribute(a, props.attrs[a]!); } else (node as unknown as Record<string, unknown>)[k] = props[k];
    }
    if (kids) for (const c of kids) node.appendChild(c);
    return node;
  };
  const slider = (id: string, label: string, min: number, max: number, step: number, valId: string): HTMLElement => mk("label", { className: "tune-row", id: id + "-row" }, [
    mk("span", { className: "tune-label" }, [mk("span", { textContent: label + " " }), mk("b", { id: valId })]),
    mk("input", { id, type: "range", min: String(min), max: String(max), step: String(step), attrs: { "aria-label": label } }),
  ]);
  const btn = (id: string, text: string, title?: string): HTMLButtonElement => mk("button", { id, type: "button", textContent: text, title: title || "" }) as HTMLButtonElement;
  const inner = mk("div", { id: "freecam-inner", className: "sheet" }, [
    mk("div", { id: "fc-head" }, [mk("h2", { textContent: "FREE CAMERA" })]),
    mk("div", { id: "fc-status" }),
    mk("div", { id: "fc-rows", className: "pane" }, [
      mk("div", { id: "fc-shot", className: "balanced-row", hidden: true, attrs: { role: "group", "aria-label": "Use this view in the flyby" } }),
      slider("fc-speed", "SPEED", 0, SLIDER_MAX, 1, "fc-speed-val"),
      slider("fc-roll", "ROLL", -ROLL_MAX, ROLL_MAX, 1, "fc-roll-val"),
      slider("fc-fov", "FOV", FOV_MIN, FOV_MAX, 1, "fc-fov-val"),
      mk("div", { id: "fc-snaps", className: "balanced-row", attrs: { role: "group", "aria-label": "Snap the camera" } }, [
        btn("fc-snap-car", "SNAP TO CAR", "Put the camera behind your car"),
        btn("fc-corner-prev", "‹ CORNER", "Jump to the previous corner, seen from its outside"),
        btn("fc-corner-next", "CORNER ›", "Jump to the next corner, seen from its outside"),
      ]),
      mk("div", { id: "fc-lens", className: "balanced-row", attrs: { role: "group", "aria-label": "Lens" } }, [
        btn("fc-lens-race", "RACE LENS", "The race camera's far plane and fog"),
        btn("fc-lens-flyby", "FLYBY LENS", "The pre-race flyby's far plane, near plane and thinned fog"),
      ]),
      mk("div", { id: "fc-copies", className: "balanced-row", attrs: { role: "group", "aria-label": "Copy this view" } }, [
        btn("fc-copy-view", "COPY VIEW", "Copy an __apex.view({eye,target,fov}) line that frames this picture"),
        btn("fc-copy-pose", "COPY FLYBY POSE", "Copy this view as a held flyby shot, anchored to the nearest corner or landmark"),
      ]),
      mk("div", { id: "fc-kit", className: "balanced-row", attrs: { role: "group", "aria-label": "Photo kit" } }, [
        btn("fc-grid", "GRID: OFF", "Cycle composition grid: off, rule of thirds, golden ratio"),
        btn("fc-mark-save", "SAVE MARK", "Bookmark this camera pose for this circuit"),
        btn("fc-mark-load", "LOAD MARK", "Load the selected bookmark; defaults to the latest"),
        mk("input", { id: "fc-mark-name", maxLength: 40, placeholder: "Bookmark name", attrs: { "aria-label": "New bookmark name" } }),
        mk("select", { id: "fc-mark-picker", attrs: { "aria-label": "Saved camera bookmarks" } }),
        btn("fc-mark-delete", "DELETE MARK", "Delete the selected bookmark"),
        mk("span", { id: "fc-mark-warning", attrs: { "aria-live": "polite" } }),
      ]),
      slider("fc-dof-focus", "DoF FOCUS", 0, 100, 1, "fc-dof-focus-val"),
      slider("fc-dof-blur", "DoF BLUR", 0, 100, 1, "fc-dof-blur-val"),
      mk("p", { id: "fc-help", className: "adv-help", textContent: "WASD move · R/F up and down · Q/E roll · mouse wheel speed · drag or arrow keys look (arrows while focus is outside this panel) · Shift boost · GRID / SAVE MARK / DoF for photo kit" }),
      mk("p", { id: "fc-msg", attrs: { "aria-live": "polite" } }),
      mk("textarea", { id: "fc-out", readOnly: true, hidden: true, attrs: { "aria-label": "Copied camera text" } }),
    ]),
  ]);
  const closeBtn = root.querySelector<HTMLElement>("#fc-close");
  const foot = mk("div", { className: "sheet-foot balanced-row" }, closeBtn ? [closeBtn] : []);
  inner.appendChild(foot);
  root.appendChild(inner);
  const input = (id: string): HTMLInputElement => E[id] as HTMLInputElement;

  // ---- state -> DOM ----
  function paint(): void {
    const set = (id: string, v: number, txt: string): void => {
      const i = E[id] as HTMLInputElement | undefined; if (i && doc.activeElement !== i) i.value = String(v);
      const b = E[id + "-val"]; if (b) b.textContent = txt;
    };
    set("fc-speed", sliderFromSpeed(st.speed), Math.round(st.speed) + " m/s");
    set("fc-roll", Math.round(st.roll), Math.round(st.roll) + "°");
    set("fc-fov", Math.round(photoCam.fov), Math.round(photoCam.fov) + "°");
    set("fc-dof-focus", Math.round(st.dofFocus * 100), Math.round(st.dofFocus * 100) + "%");
    set("fc-dof-blur", Math.round(st.dofBlur * 100), Math.round(st.dofBlur * 100) + "%");
    for (const [id, on] of [["fc-lens-race", st.lens === "race"], ["fc-lens-flyby", st.lens === "flyby"]] as const) {
      const b = E[id]; if (!b) continue;
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    const gb = E["fc-grid"];
    if (gb) gb.textContent = "GRID: " + (st.grid === "off" ? "OFF" : st.grid === "thirds" ? "THIRDS" : "GOLDEN");
  }
  function paintStatus(): void {
    const s = E["fc-status"]; if (!s) return;
    const e = photoCam.pos;
    s.textContent = "(" + Math.round(e[0]) + ", " + Math.round(e[1]) + ", " + Math.round(e[2]) + ") · " + st.anchor +
      (st.poseErr ? " · pose err " + st.poseErr : "");
  }
  function refreshAnchor(): void {
    const t = track();
    if (!t || !flyby || !flyby.poseFromWorld) return;
    try { st.anchor = anchorText(flyby.poseFromWorld(t, photoCam.pos).pose); } catch { st.anchor = "—"; }
  }
  function say(msg: string): void { const m = E["fc-msg"]; if (m) m.textContent = msg; }
  /** The opener's pose actions (SET SHOT START / END from the flyby editor): each
   *  hands the view, as a flyby pose, to the tool that opened this panel. */
  function paintActions(): void {
    const box = E["fc-shot"]; if (!box) return;
    box.replaceChildren();
    const list = st.actions || [];
    for (const a of list) {
      const b = btn("", a.label, a.title);
      b.addEventListener("click", () => {
        tick();
        const r = flybyPose();
        say(r ? (a.run(r) || "Could not use this view.") : "No circuit to anchor a pose to.");
      });
      box.appendChild(b);
    }
    box.hidden = !list.length;
  }

  // ---- placing the camera ----
  function place(eye: Readonly<Vec3>, target: Readonly<Vec3>, fov?: unknown): void {
    photoCam.pos[0] = eye[0]; photoCam.pos[1] = eye[1]; photoCam.pos[2] = eye[2];
    const a = aim(eye, target); photoCam.yaw = a.yaw; photoCam.pitch = a.pitch;
    if (fov != null) setFov(fov);
    if (photo && photo.releaseKeys) photo.releaseKeys();
    publish();
  }
  function publish(): void {
    // photo.publish integrates zero time and writes dbgCam, which decorate()
    // then finishes — so an API placement shows even on a frame nobody flew.
    if (photo && photo.publish) photo.publish(); else decorate(deps.dbgCam(), 0);
    refreshAnchor(); paintStatus(); paint();
  }
  function setFov(f: unknown): void {
    photoCam.fov = clampFov(f);
    const pc = $("pc-fov") as HTMLInputElement | null; if (pc) pc.value = String(Math.round(photoCam.fov));
  }
  function setLens(l: unknown): void { st.lens = l === "flyby" ? "flyby" : "race"; }
  function snapCar(): boolean {
    const c = deps.player ? deps.player() : null;
    const t = track();
    if (!c || c.px == null || !t) return false;
    const smp: Sample = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
    sampleFn(t, c.s || 0, smp);
    const p = carPose(c, smp.p[1]);
    place(p.eye, p.target);
    say("Behind the car.");
    return true;
  }
  function snapCorner(n: number): boolean {
    const t = track();
    if (!t || !flyby) return false;
    const p = cornerPose(flyby, t, n);
    if (!p) { say("This circuit has no measured corners."); return false; }
    st.corner = p.n;
    place(p.eye, p.target);
    say("Turn " + p.n + " of " + p.count + ".");
    return true;
  }
  const stepCorner = (d: number): boolean => snapCorner((st.corner || (d > 0 ? 0 : 1)) + d);

  // ---- the frame hook (photo-cam.ts updatePhotoCam, after it builds dbgCam) ----
  /** Speed for this frame, m/s. */
  function speed(boost?: boolean): number { return st.speed * (boost ? BOOST : 1); }
  function decorate(cam: FreeCamView | null | undefined, dt: number): void {
    if (!st.open || !cam) return;
    const d = (rk.e ? 1 : 0) - (rk.q ? 1 : 0);
    if (d && dt > 0) { st.roll = clampRoll(st.roll + d * ROLL_RATE * dt); paint(); }
    cam.roll = st.roll * Math.PI / 180;
    if (st.lens === "flyby" && flyby) {
      cam.cine = true; cam.far = flyby.FAR; cam.fog = flyby.FOG;
    }
    if (st.overlays) {
      PhotoKit.applyDof(cam, st.dofFocus, st.dofBlur, kitOverlays.dof);
      PhotoKit.setGrid(kitOverlays.grid, st.grid);
    }
    st.statusT -= dt;
    if (st.statusT <= 0) { st.statusT = 0.25; refreshAnchor(); paintStatus(); }
  }
  /** Photo mode's key handler asks first. 1 = mine (consume), -1 = not the
   *  camera's (leave it to the focused control), 0 = photo mode's to handle. */
  function key(code: string, down: boolean, focused: Element | null): number {
    if (!st.open) return 0;
    if (code === "KeyQ") { rk.q = down; return 1; }
    if (code === "KeyE") { rk.e = down; return 1; }
    // ARROW-KEY LOOK ONLY WITH FOCUS OUTSIDE THE PANEL: inside it the arrows
    // belong to the control that has focus (a slider, the button row).
    if (/^Arrow/.test(code) && inner && focused && inner.contains(focused)) return -1;
    return 0;
  }
  function releaseKeys(): void { rk.q = rk.e = false; }
  function onWheel(e: WheelEvent): void {
    const tgt = e.target as Element | null;
    if (!st.open || e.ctrlKey || e.defaultPrevented || (inner && tgt && typeof tgt.nodeType === "number" && inner.contains(tgt))
      || (tgt && typeof tgt.closest === "function" && tgt.closest("#ps-panel"))) return;
    st.speed = wheelSpeed(st.speed, e.deltaY); paint();
  }

  function setOverlaysVisible(on: boolean): void {
    st.overlays = !!on;
    if (!on || !st.open) PhotoKit.showOverlays(false, kitOverlays.grid, kitOverlays.dof);
    else { PhotoKit.setGrid(kitOverlays.grid, st.grid); PhotoKit.applyDof(null, st.dofFocus, st.dofBlur, kitOverlays.dof); }
  }

  // ---- open / close ----
  function isOpen(): boolean { return st.open; }
  function open(): boolean {
    paintMarks();
    if (st.open) return true;
    if (!track()) return false;
    log.info("FreeCam.open");
    st.open = true; st.roll = 0; st.lens = "race"; st.poseErr = null; st.statusT = 0;
    releaseKeys();
    root.hidden = false;
    const out = E["fc-out"]; if (out) out.hidden = true;
    say("");
    doc.body.classList.add("lt-open");   // same dock as the three tuners: race HUD and touch controls stand down
    PhotoKit.setGrid(kitOverlays.grid, st.grid);
    PhotoKit.applyDof(null, st.dofFocus, st.dofBlur, kitOverlays.dof);
    const ps = $("pmsettings"); if (ps) ps.hidden = true;
    // Nested under DISPLAY -> ADVANCED VISUALS: hide that page too, or its own
    // .hidden survives underneath and reappears the moment pmsettings does.
    const dp = $("pm-panel-display"); if (dp) dp.hidden = true;
    if (photo && photo.enter) photo.enter();   // starts from the game camera (initPhotoCam)
    if (win) {
      win.addEventListener("wheel", onWheel as EventListener, { passive: true });
      win.addEventListener("blur", releaseKeys);
    }
    publish();
    return true;
  }
  /** Exit restores: the game camera (dbgCam cleared by photo mode's exit), a
   *  level horizon and the race lens for the next photo mode, and — when asked
   *  and still paused — the settings page the panel was opened from. */
  function close(showPauseMenu?: boolean, keepPhotoMode?: boolean): void {
    if (!st.open) return;
    log.info("FreeCam.close");
    const back = st.back;
    st.open = false; st.overlays = true; st.roll = 0; st.lens = "race"; st.back = null; st.actions = null;
    paintActions();
    releaseKeys();
    root.hidden = true;
    inner.hidden = false;           // HIDE PANEL tucks this; do not carry it over
    doc.body.classList.remove("lt-open");
    PhotoKit.showOverlays(false, kitOverlays.grid, kitOverlays.dof);
    if (win) {
      win.removeEventListener("wheel", onWheel as EventListener, { passive: true } as EventListenerOptions);
      win.removeEventListener("blur", releaseKeys);
    }
    if (!keepPhotoMode && photoMode() && photo && photo.exit) photo.exit();
    // Opened as a tool's sub-mode: DONE goes back to that tool, not the menu.
    if (showPauseMenu && back) { back(); return; }
    if (showPauseMenu && paused()) {
      const ps = $("pmsettings"); if (ps) ps.hidden = false;
      const dp = $("pm-panel-display"); if (dp) dp.hidden = false;
      const b = $("pm-visual-tuners-sum"); if (b && b.focus) b.focus();
    }
  }
  /** Open as ANOTHER TOOL'S SUB-MODE. opts is __apex.freeCam's (eye/target/fov,
   *  lens, ...) plus back (DONE returns there) and actions ([{label, title, run}],
   *  run(flybyPose) -> message or falsy). */
  function enterFrom(opts?: FreeCamCmd | null): boolean {
    const o = opts || {};
    if (!cmd(o)) return false;
    st.back = typeof o.back === "function" ? o.back : null;
    st.actions = Array.isArray(o.actions) ? o.actions : null;
    paintActions();
    return true;
  }
  /** Photo mode left by some other door (resume, quit, the lighting tuner). */
  function onPhotoExit(): void { if (st.open) close(false); }

  // ---- copy ----
  function copyOut(text: string, okMsg: string): string {
    const ta = E["fc-out"] as HTMLTextAreaElement | undefined;
    if (ta) { ta.value = text; ta.hidden = false; ta.focus(); if (ta.setSelectionRange) ta.setSelectionRange(0, text.length); }
    // preferSync in f1-game (execCommand during the gesture); the injected clipboard owns that.
    void clipboard(text).then((ok) => {
      if (ok && ta && ta.blur) ta.blur();
      say(ok ? okMsg : "Select the text below and copy it.");
    });
    return text;
  }
  function cam(): FreeCamView { return deps.dbgCam() || { eye: photoCam.pos, target: photoCam.pos, fov: photoCam.fov }; }
  function copyView(): string { const c = cam(); return copyOut(viewSnippet(c.eye, c.target, c.fov), "Copied the __apex.view() line."); }
  function flybyPose(): { shot: FlybyShot; err: { eye: number; look: number } } | null {
    const t = track();
    if (!t || !flyby || !flyby.shotFromView) return null;
    const c = cam();
    return flyby.shotFromView(t, c.eye, c.target, c.fov);
  }
  function copyPose(): { shot: FlybyShot; err: { eye: number; look: number } } | null {
    const r = flybyPose();
    if (!r) { say("No circuit to anchor a pose to."); return null; }
    st.poseErr = "eye " + r.err.eye + " m, look " + r.err.look + " m";
    paintStatus();
    copyOut(JSON.stringify(r.shot, null, 2), "Copied the flyby pose (round trip: " + st.poseErr + ").");
    return r;
  }

  // ---- __apex.freeCam(opts) ----
  function state(): FreeCamState {
    const c = deps.dbgCam();
    return {
      open: st.open, speed: r2(st.speed), roll: r2(st.roll), lens: st.lens, corner: st.corner,
      eye: c ? c.eye.map(r2) : null, target: c ? c.target.map(r2) : null, fov: c ? r2(c.fov) : null,
      anchor: st.anchor, poseErr: st.poseErr,
      grid: st.grid, dofFocus: r2(st.dofFocus), dofBlur: r2(st.dofBlur),
    };
  }
  function cmd(opts?: FreeCamCmd | boolean | null): FreeCamState | false {
    if (opts === undefined) return state();
    if (opts === false) { close(paused()); return state(); }
    if (!open()) return false;
    if (opts === true || typeof opts !== "object" || !opts) return state();
    if (opts.speed != null) st.speed = clampSpeed(opts.speed);
    if (opts.roll != null) st.roll = clampRoll(opts.roll);
    if (opts.lens != null) setLens(opts.lens);
    if (opts.snap === "car" && !snapCar()) return false;
    if (opts.snap === "corner" && !(opts.n != null ? snapCorner(opts.n) : stepCorner(1))) return false;
    if (opts.eye && opts.target) place(opts.eye, opts.target, opts.fov);
    else if (opts.fov != null) setFov(opts.fov);
    publish();
    return state();
  }

  // ---- wiring ----
  const offs: (() => void)[] = [];
  const on = (node: EventTarget | null | undefined, ev: string, fn: (e: Event) => void): void => {
    if (!node) return;
    node.addEventListener(ev, fn);
    offs.push(() => node.removeEventListener(ev, fn));
  };
  const tick = (): void => { if (deps.uiTick) deps.uiTick(); };
  const valueOf = (e: Event): string => (e.target as HTMLInputElement).value;
  on(closeBtn, "click", () => { tick(); close(true); });
  on(E["fc-speed"], "input", (e) => { st.speed = speedFromSlider(valueOf(e)); paint(); });
  on(E["fc-roll"], "input", (e) => { st.roll = clampRoll(valueOf(e)); paint(); publish(); });
  on(E["fc-fov"], "input", (e) => { setFov(valueOf(e)); paint(); publish(); });
  on($("pc-fov"), "input", () => paint());      // photo mode's own FOV slider, mirrored
  on(E["fc-snap-car"], "click", () => { tick(); if (!snapCar()) say("No car on track to snap to."); });
  on(E["fc-corner-prev"], "click", () => { tick(); stepCorner(-1); });
  on(E["fc-corner-next"], "click", () => { tick(); stepCorner(1); });
  on(E["fc-lens-race"], "click", () => { tick(); setLens("race"); publish(); });
  on(E["fc-lens-flyby"], "click", () => { tick(); setLens("flyby"); publish(); });
  on(E["fc-copy-view"], "click", copyView);
  on(E["fc-copy-pose"], "click", copyPose);
  on(E["fc-grid"], "click", () => {
    tick();
    st.grid = PhotoKit.nextGrid(st.grid);
    PhotoKit.setGrid(kitOverlays.grid, st.grid);
    paint();
  });
  function paintMarks(selected?: number): void {
    const picker = E["fc-mark-picker"] as HTMLSelectElement | undefined; if (!picker) return;
    const t = track();
    const list = PhotoKit.marksFor(deps.store, t && trackKey(t) || "track");
    picker.replaceChildren();
    list.forEach((m, i) => picker.appendChild(mk("option", { value: String(i), textContent: m.name })));
    picker.value = String(selected == null ? list.length - 1 : Math.min(selected, list.length - 1));
    picker.disabled = !list.length; (E["fc-mark-load"] as HTMLButtonElement).disabled = !list.length; (E["fc-mark-delete"] as HTMLButtonElement).disabled = !list.length;
    E["fc-mark-warning"]!.textContent = list.length >= PhotoKit.MAX_MARKS ? "Next save replaces “" + list[0]!.name + "”." : "";
  }
  on(E["fc-mark-delete"], "click", () => {
    const t = track();
    if (!t || !deps.store) return;
    const index = Number((E["fc-mark-picker"] as HTMLSelectElement).value);
    PhotoKit.deleteMark(deps.store, trackKey(t), index); paintMarks(index); say("Bookmark deleted.");
  });
  on(E["fc-mark-save"], "click", () => {
    tick();
    const t = track();
    if (!t || !deps.store) { say("No circuit to bookmark."); return; }
    const c = cam();
    const list = PhotoKit.saveMark(deps.store, trackKey(t), {
      eye: c.eye, target: c.target, fov: c.fov, roll: st.roll, name: input("fc-mark-name").value,
    });
    paintMarks();
    say(list ? ("Saved mark " + list.length + " of " + PhotoKit.MAX_MARKS + ".") : "Could not save bookmark.");
  });
  on(E["fc-mark-load"], "click", () => {
    tick();
    const t = track();
    if (!t || !deps.store) { say("No bookmarks."); return; }
    const list = PhotoKit.marksFor(deps.store, trackKey(t));
    if (!list.length) { say("No bookmarks on this circuit."); return; }
    const m = list[Number((E["fc-mark-picker"] as HTMLSelectElement).value)] || list[list.length - 1]!;
    st.roll = clampRoll(m.roll || 0);
    place(m.eye, m.target, m.fov);
    say("Loaded “" + m.name + "”.");
  });
  on(E["fc-dof-focus"], "input", (e) => {
    st.dofFocus = clamp((Number(valueOf(e)) || 0) / 100, 0, 1); paint(); publish();
  });
  on(E["fc-dof-blur"], "input", (e) => {
    st.dofBlur = clamp((Number(valueOf(e)) || 0) / 100, 0, 1); paint(); publish();
  });
  paint();

  return {
    open, close, isOpen, onPhotoExit, enterFrom, speed, decorate, key, releaseKeys, cmd, state,
    place, snapCar, snapCorner, copyView, copyPose, flybyPose, setOverlaysVisible, panel: () => inner,
    root,
    unmount() {
      if (st.open) close(false, true);
      for (const off of offs.splice(0)) off();
      if (win) { win.removeEventListener("wheel", onWheel as EventListener); win.removeEventListener("blur", releaseKeys); }
      kitOverlays.remove();
      root.remove();
    },
  };
}

export const FreeCam = Object.freeze({
  mount: mountFreeCam,
  speedFromSlider, sliderFromSpeed, clampSpeed, wheelSpeed, clampRoll, clampFov,
  viewSnippet, aim, carPose, cornerPose, anchorText,
  SPD_MIN, SPD_MAX, SPD_DEF, ROLL_MAX, BOOST,
});
