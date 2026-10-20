/* CamModes — the PLAYER camera-mode registry and switch: the CAM button (tap to
   cycle, hold/right-click for the picker grid) and the C-key cycle.
   BROADCAST-ONLY: it changes which CAM_MODES rig you look through and never
   touches car state.

   Ported verbatim from f1-game js/camera/mode-switch.js:1-250 (CamModes), plus
   the boot clamp of the saved mode from js/game.js:837. The IIFE singleton
   becomes `createCamModes(deps)`; game.js's `camMode` / `camCutT` closure
   state (game.js:837, :950, written through G at game.js:3114-3115) lives on
   the registry's `state`. Ambient globals are injected:
     G.store                 → deps.store                         mode-switch.js:88
     G.$ / document          → deps.doc                           mode-switch.js:35, :45-81
     RealRace.replay()       → deps.watch  TODO(lane-data real-race): js/race/real-replay.js   :41-44
     ExtraRigs.reset         → deps.extraRigs TODO(lane-data extra-rigs): js/camera/extra-rigs.js :92
     CamFeel.resetFollow     → deps.feel  (src/camera/feel.ts)    :95
     GameAudio.setCameraMix  → deps.audio TODO(lane-audio)        :97, :241
     CamTunerPanel.refresh   → deps.tuner (src/camera/tuner-panel.ts refreshCamTunePanel) :102
     CockpitOpts             → deps.cockpit (src/camera/cockpit-opts.ts)   :66-68, :237
     HudLayout.setCam        → deps.hudLayout TODO(lane-shell): js/ui/hud-layout.js  :74
     G.state / G.refreshHud  → deps.gameState / deps.refreshHud TODO(lane-shell)    :78-80
     CamComfort.boot         → src/camera/cam-comfort.ts boot     :244
     GameCams.vantage        → deps.gameCams TODO(lane-shell): js/camera/vantage.js

   THE REGISTRY (new, the coordinator's seam): CAM_MODES is the built-in list.
   A rig — the function that solves a mode's eye/target/fov — is registered by
   whoever owns it (`registerMode`), so this module never imports the shell:
   lane-shell registers chase/far/… and vantage's family; an id that is not in
   CAM_MODES is APPENDED (the index is the save format, so never inserted).
   `vantage(mode, …)` dispatches to the registered rig, else to deps.gameCams.

   THE ARC RULE: cameras read the world; nothing here reaches PlayerInput. */
import type { Vec3 } from "../contracts/track";
import { boot as comfortBoot } from "./cam-comfort";
import type { CamStore } from "./store";

/** One CAM_MODES entry (mode-switch.js:8-30). `cut`: the eased glide (s) on a cut to it; 0 = instant. */
export interface CamModeDef {
  readonly id: string;
  readonly label: string;
  readonly cut: number;
}

// CAM_MODES index IS `camMode` (persisted as a26.camMode), so the order is a
// save-format contract: append, never reorder. js/camera/vantage.js resolves
// each id to a rig; cam-tuner, apex.js, agentview.js and game.js read the list
// through CamModes.CAM_MODES.
export const CAM_MODES: ReadonlyArray<CamModeDef> = Object.freeze([
  { id: "chase",     label: "CHASE",     cut: 0.35 },
  { id: "far",       label: "FAR",       cut: 0.35 },
  { id: "drift",     label: "DRIFT",     cut: 0.35 },
  { id: "cockpit",   label: "COCKPIT",   cut: 0 },
  { id: "hood",      label: "HOOD",      cut: 0 },
  { id: "overhead",  label: "OVERHEAD",  cut: 0.5 },
  { id: "heli",      label: "HELI",      cut: 0.55 },
  { id: "reverse",   label: "REVERSE",   cut: 0.35 },
  { id: "side",      label: "TV SIDE",   cut: 0.45 },
  { id: "cinematic", label: "CINEMATIC", cut: 0.6 },
  { id: "low",       label: "LOW",       cut: 0.4 },
  { id: "tcam",      label: "T-CAM",     cut: 0 },
  { id: "rear",      label: "REAR CAM",  cut: 0.15 },
  { id: "visor",     label: "VISOR",     cut: 0 },        // the cockpit without its steering wheel (a linked phone is the wheel)
  { id: "trackside", label: "TRACKSIDE", cut: 0.5 },      // fixed corner cams that auto-switch as the car passes (append-only)
  // Append-only: a26.camMode is an index. New player cams land HERE (after TRACKSIDE).
  { id: "rival",     label: "RIVAL LOCK", cut: 0.4 },     // frames the nearest battle rival (Broadcast.battles)
  { id: "pitwall",   label: "PIT WALL",   cut: 0.45 },    // pit-lane / pit-exit wall cam (optional auto-cut)
  { id: "drone",     label: "DRONE",      cut: 0.5 },     // smoothed tether with corner look-ahead (heli alternative)
  { id: "tv",        label: "TV",        cut: 0.5 },      // live TV director (src/camera/director.ts) — append only; index is a26.camMode
  { id: "helmet",    label: "HELMET",     cut: 0 },       // the cockpit from inside the lid: eye forward, visor frame (css/hud.css)
].map((m) => Object.freeze(m)));

export const HOLD_MS = 340;   // CAM button hold before the picker opens
/** game.js:837 `store.get("camMode", 19)`: a first boot looks through HELMET. */
export const DEFAULT_MODE = 19;
export const STORE_KEY = "camMode";

// ── The vantage seam (GameCams.vantage, js/camera/vantage.js) ─────────────

/** The `extra` bag callers hand a vantage solve (director.js:140-152, results-cam.js:24-30, :138-143). */
export interface VantageExtra {
  att?: unknown;              // the subject car (attitude source). TODO(lane-shell): vantage's car type.
  noLook?: boolean;           // the PLAYER's look-back / glance never steers this shot
  frameSubject?: boolean;
  dt?: number;
  snap?: boolean;
  carPos?: readonly [number, number] | readonly number[] | null;
  carHead?: number | undefined;
  bankDy?: number;
}

/** A solved pose. `tgt` is vantage.js's name; results-cam also accepts `target`. */
export interface VantagePose {
  readonly eye: Vec3 | readonly number[];
  readonly tgt?: Vec3 | readonly number[];
  readonly target?: Vec3 | readonly number[];
  readonly fov?: number;
}

/** G.camVantage (game.js): one solve of `mode` at arc s / lateral x. */
export type CamVantage = (mode: string, s: number, x: number, speed: number, now: number, extra: VantageExtra) => VantagePose | null | undefined;

/** A registered mode's solver: CamVantage with the mode bound. */
export type CamRig = (s: number, x: number, speed: number, now: number, extra: VantageExtra) => VantagePose | null | undefined;

/** TODO(lane-shell): js/camera/vantage.js GameCams, the rig family behind every built-in id. */
export interface GameCamsLike {
  vantage: CamVantage;
  resetSmoothing?(): void;
}

/** RealRace.replay() while a REAL RACE WATCH runs (js/race/real-replay.js). TODO(lane-data real-race). */
export interface WatchReplay {
  isRunning(): boolean;
  autoOn(): boolean;
  setAuto(on: boolean): void;
  takePicture(): void;
}

export interface CamModesDeps {
  readonly store?: CamStore | null;
  /** Where the CAM button and body flags live; null = no DOM. Default: the global document. */
  readonly doc?: Document | null;
  /** RealRace.replay (mode-switch.js:41-44, :87). TODO(lane-data real-race). */
  readonly watch?: (() => WatchReplay | null | undefined) | null;
  /** ExtraRigs.reset (mode-switch.js:92). TODO(lane-data extra-rigs): src/camera/extra-rigs.ts. */
  readonly extraRigs?: { reset(id: string): void } | null;
  /** CamFeel.resetFollow (mode-switch.js:95). */
  readonly feel?: { resetFollow(): void } | null;
  /** GameAudio.setCameraMix (mode-switch.js:97, :241). TODO(lane-audio). */
  readonly audio?: { setCameraMix(id: string): void } | null;
  /** CamTunerPanel.refresh (mode-switch.js:102): a mounted tuner's refreshCamTunePanel. */
  readonly tuner?: { refreshCamTunePanel(): void } | null;
  /** CockpitOpts (mode-switch.js:66-68, :237). */
  readonly cockpit?: { wheelHasScreen(): boolean; onWheel(fn: () => void): () => void } | null;
  /** HudLayout.setCam (mode-switch.js:74). TODO(lane-shell): src/hud layout. */
  readonly hudLayout?: { setCam(id: string): void } | null;
  /** G.state (mode-switch.js:78). TODO(lane-shell). */
  readonly gameState?: (() => string) | null;
  /** G.refreshHud (mode-switch.js:78-80). TODO(lane-shell). */
  readonly refreshHud?: ((force: boolean) => void) | null;
  /** GameCams (js/camera/vantage.js): the fallback solver for ids with no registered rig. TODO(lane-shell). */
  readonly gameCams?: GameCamsLike | null;
  /** The starting index; default: the saved a26.camMode clamped (game.js:837). */
  readonly initialMode?: number;
  /** Run CamComfort.boot on the store (mode-switch.js:244). Default true. */
  readonly comfortBoot?: boolean;
}

/** game.js `camMode` / `camCutT` (game.js:837, :950): the render loop reads both and eases camCutT down. */
export interface CamModeState {
  camMode: number;
  camCutT: number;
}

export interface SetModeOpts {
  /** false: ephemeral override (WebXR cockpit): do not write a26.camMode. */
  readonly persist?: boolean;
}

export type CamModeListener = (mode: CamModeDef, index: number, prevIndex: number) => void;

export type CamModes = ReturnType<typeof createCamModes>;

/** game.js:837: the saved index, clamped to the list. */
export function savedMode(store: CamStore | null | undefined, count: number): number {
  const v = store ? store.get(STORE_KEY, DEFAULT_MODE) : DEFAULT_MODE;
  return Math.min(Math.max((v as number) | 0, 0), count - 1);
}

export function createCamModes(deps: CamModesDeps = {}) {
  const store = deps.store ?? null;
  const doc: Document | null = deps.doc !== undefined ? deps.doc : (typeof document !== "undefined" ? document : null);
  const $ = (id: string): HTMLElement | null => (doc ? doc.getElementById(id) : null);

  // The live list: the built-ins, then any appended mode. One array, mutated
  // only by registerMode's append, so a reader holding `modes` sees growth.
  const modes: CamModeDef[] = CAM_MODES.slice();
  const rigs = new Map<string, CamRig>();
  const listeners = new Set<CamModeListener>();
  const state: CamModeState = {
    camMode: deps.initialMode !== undefined
      ? Math.min(Math.max(deps.initialMode | 0, 0), modes.length - 1)
      : savedMode(store, modes.length),
    camCutT: 0,
  };
  const mode = (i: number): CamModeDef => modes[i] ?? (modes[0] as CamModeDef);

  // ── Registry ────────────────────────────────────────────────────────────
  function indexOf(id: string): number { return modes.findIndex((m) => m.id === id); }
  /**
   * Register `def` (and its rig). A known id keeps its index and takes the new
   * rig; an unknown id is appended (never inserted: the index is the save
   * format). Returns the mode's index.
   */
  function registerMode(def: CamModeDef | string, rig?: CamRig | null): number {
    const id = typeof def === "string" ? def : def.id;
    let i = indexOf(id);
    if (i < 0) {
      if (typeof def === "string") throw new Error(`CamModes.registerMode: unknown id "${id}" needs a {id,label,cut}`);
      modes.push(Object.freeze({ id: def.id, label: def.label, cut: def.cut }));
      i = modes.length - 1;
    }
    if (rig) rigs.set(id, rig);
    return i;
  }
  function rigOf(id: string): CamRig | undefined { return rigs.get(id); }
  /** One solve of `id`: its registered rig, else GameCams.vantage. Null when neither knows it. */
  function vantage(id: string, s: number, x: number, speed: number, now: number, extra: VantageExtra): VantagePose | null {
    const r = rigs.get(id);
    if (r) return r(s, x, speed, now, extra) ?? null;
    const g = deps.gameCams;
    return g ? g.vantage(id, s, x, speed, now, extra) ?? null : null;
  }
  function onChange(fn: CamModeListener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }
  function current(): CamModeDef { return mode(state.camMode); }
  function currentIndex(): number { return state.camMode; }

  // ── mode-switch.js:37-119 ────────────────────────────────────────────────
  // A REAL RACE WATCH (js/race/real-replay.js): its TV director is one more
  // "camera" — AUTO — in the picker and the C / CAM cycle. Never a CAM_MODES
  // entry: that list is the saved a26.camMode index and GameCams.vantage's
  // mode ids, and AUTO is neither.
  function watchReplay(): WatchReplay | null {
    const r = deps.watch ? deps.watch() : null;
    return r && typeof r.isRunning === "function" && r.isRunning() && typeof r.setAuto === "function" ? r : null;
  }
  function refreshCamBtn(): void {
    const b = $("btn-cam");
    const r = watchReplay();
    // The NAME starts with the visible word (WCAG 2.5.3 Label in Name): a
    // fixed "Camera" left a voice-control user saying "click CHASE" to a
    // button whose name had no CHASE in it.
    // https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html
    // In a WATCH with the director on the picture, the word is AUTO.
    if (b && r && r.autoOn()) {
      b.textContent = "AUTO · " + mode(state.camMode).label;
      b.setAttribute("aria-label", `AUTO camera, ${mode(state.camMode).label}`);
    } else if (b) { b.textContent = mode(state.camMode).label; b.setAttribute("aria-label", `${mode(state.camMode).label} camera`); }
    // cockpit-cam hides the HUD readouts the wheel's LCD carries — only while
    // the chosen wheel HAS one (src/camera/cockpit-opts.ts WHEEL), and only in
    // COCKPIT. HELMET looks at the same wheel. On a phone the LCD is readable
    // (852×393), so the track-detail CSS also hides the floating speed there
    // while data-wheel-lcd is set. GEAR stays on the visor (HELMET_TOUCH).
    // CLASSIC / NONE keep the chip. Helmet wears the visor frame (hud.css),
    // keyed on an attribute because the cssClasses ratchet has no room for a class.
    const camId = mode(state.camMode).id;
    const cockpit = deps.cockpit ?? null;
    const wheelLcd = !cockpit || cockpit.wheelHasScreen();
    if (doc && doc.body) {
      doc.body.classList.toggle("cockpit-cam", camId === "cockpit"
        && (!cockpit || cockpit.wheelHasScreen()));
      doc.body.toggleAttribute("data-helmet-cam", camId === "helmet");
      doc.body.toggleAttribute("data-wheel-lcd", wheelLcd);
    }
    // MOVE & SIZE swaps its cockpit / other layout on the SAME frame: waiting
    // for the HUD's 10 Hz tick (js/ui/hud.js) left one tick of chips at the
    // cockpit offsets over the touch buttons after leaving the cockpit.
    if (deps.hudLayout) deps.hudLayout.setCam(mode(state.camMode).id);
    // hud-bcam / hud-prof-* and --hud-top-h live in that same tick. A player
    // (or __apex.camera) cut must not wait for rAF either — software GL can
    // block the thread longer than layout probes budget.
    const st = deps.gameState ? deps.gameState() : "";
    if ((st === "race" || st === "count") && typeof deps.refreshHud === "function") {
      deps.refreshHud(true);
    }
  }
  function setCamMode(m: number, opts?: SetModeOpts | null): string {
    const prev = state.camMode;
    state.camMode = ((m % modes.length) + modes.length) % modes.length;
    // opts.persist === false: ephemeral override (WebXR cockpit) — do not
    // write a26.camMode so EXIT VR restores the player's saved choice.
    const replay = deps.watch ? deps.watch() : null;
    if (!(opts && opts.persist === false) && !(replay && replay.isRunning()) && store) store.set(STORE_KEY, state.camMode);
    if (state.camMode !== prev) {
      state.camCutT = (modes[state.camMode] || modes[0])?.cut ?? 0.35;   // cut: 0 is an instant cut, not missing
      if (deps.extraRigs) deps.extraRigs.reset(mode(state.camMode).id);
      // A cut: the new rig's eased bend sides start from its own target,
      // not from wherever that rig was the last time it was on air.
      if (deps.feel) deps.feel.resetFollow();
    }
    if (deps.audio) deps.audio.setCameraMix(mode(state.camMode).id);   // onboard / chase / TV mix
    refreshCamBtn();   // the CAM button label is the only mode indicator (no big announce)
    // The CAMERA TUNER edits whichever mode you are looking through, so every
    // mode change re-points its sliders.
    if (deps.tuner) deps.tuner.refreshCamTunePanel();
    if (state.camMode !== prev) for (const fn of [...listeners]) fn(mode(state.camMode), state.camMode, prev);
    return mode(state.camMode).id;
  }
  /** setCamMode by index or id (an unknown id is a no-op that returns the current id). */
  function setMode(m: number | string, opts?: SetModeOpts | null): string {
    if (typeof m === "string") {
      const i = indexOf(m);
      if (i < 0) return mode(state.camMode).id;
      m = i;
    }
    return setCamMode(m, opts);
  }
  // The viewer picks a shot: in a WATCH that takes the picture from the director.
  function pickCam(m: number): string {
    const id = setCamMode(m);
    const r = watchReplay();
    if (r) { r.takePicture(); refreshCamBtn(); }
    return id;
  }
  function toAuto(): string { const r = watchReplay(); if (r) { r.setAuto(true); refreshCamBtn(); } return "auto"; }
  // In a WATCH the cycle runs the shots and then AUTO (where it would wrap);
  // from AUTO the next press is the next shot, the viewer's.
  function cycleCam(): string {
    const r = watchReplay();
    if (r && !r.autoOn() && state.camMode === modes.length - 1) return toAuto();
    return r ? pickCam(state.camMode + 1) : setCamMode(state.camMode + 1);
  }
  /** The reverse cycle (new: f1-game has no backwards key). No AUTO stop. */
  function cycleBack(): string {
    return watchReplay() ? pickCam(state.camMode - 1) : setCamMode(state.camMode - 1);
  }

  // ── Boot (mode-switch.js:235-244) ────────────────────────────────────────
  refreshCamBtn();
  // A WHEEL change mid-race flips whether the HUD shows gear and speed.
  const offWheel = deps.cockpit ? deps.cockpit.onWheel(refreshCamBtn) : null;
  // The SAVED camera's mix, at boot: setCamMode is the only other caller,
  // so a session that starts in the cockpit heard the chase mix until the
  // first camera change.
  if (deps.audio) deps.audio.setCameraMix(mode(state.camMode).id);
  // AUTO COMFORT on first touch/XR boot (src/camera/cam-comfort.ts) — no-op
  // when the player already chose a preference.
  if (deps.comfortBoot !== false && store) comfortBoot(store);

  function dispose(): void { if (offWheel) offWheel(); listeners.clear(); }

  return {
    /** The live mode list (CAM_MODES + appended); index = a26.camMode. */
    modes: modes as ReadonlyArray<CamModeDef>,
    state,
    registerMode, rigOf, vantage, indexOf, onChange,
    current, currentIndex, setMode, next: cycleCam, prev: cycleBack,
    // f1-game names (mode-switch.js:246)
    refreshCamBtn, setCamMode, cycleCam, pickCam, toAuto, watchReplay,
    dispose,
  };
}

/**
 * The CAM button's hold / right-click picker grid (mode-switch.js:121-234).
 * `button` is #btn-cam; the grid is built lazily into doc.body as #campicker.
 */
export function mountCamPicker(cams: CamModes, button: HTMLElement | null, doc: Document = document): { show(): void; hide(): void; visible(): boolean; unmount(): void } {
  const camTrigger = button;
  let el: HTMLDivElement | null = null;
  const build = (): HTMLDivElement => {
    const box = doc.createElement("div");
    box.id = "campicker";
    box.setAttribute("role", "menu");
    box.setAttribute("aria-label", "Camera view");
    box.className = "balanced-row";
    box.hidden = true;
    for (let i = 0; i < cams.modes.length; i++) {
      const b = doc.createElement("button");
      b.textContent = (cams.modes[i] as CamModeDef).label;
      b.dataset["idx"] = String(i);
      b.setAttribute("role", "menuitemradio");
      b.tabIndex = -1;
      b.onclick = (e) => {
        e.stopPropagation(); cams.pickCam(+(b.dataset["idx"] ?? 0)); hide(); camTrigger?.focus();
      };
      box.appendChild(b);
    }
    box.addEventListener("keydown", (e) => {
      const items = [...box.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      const at = items.indexOf(doc.activeElement as HTMLElement);
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % items.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation(); hide(); camTrigger?.focus(); return;
      }
      else return;
      e.preventDefault(); e.stopPropagation(); items[next]?.focus();
    });
    doc.body.appendChild(box);
    el = box;
    return box;
  };
  // AUTO is an item only while a WATCH runs (added here, not in build(): the
  // picker is built once, and outside a WATCH it keeps its shape exactly).
  let autoBtn: HTMLButtonElement | null = null;
  const syncAuto = (box: HTMLDivElement, r: WatchReplay | null): void => {
    if (r && !autoBtn) {
      const a = doc.createElement("button");
      a.textContent = "AUTO · TV DIRECTOR";
      a.dataset["idx"] = "auto";
      a.setAttribute("role", "menuitemradio");
      a.tabIndex = -1;
      a.onclick = (e) => { e.stopPropagation(); cams.toAuto(); hide(); camTrigger?.focus(); };
      box.insertBefore(a, box.children[0] || null);
      autoBtn = a;
    } else if (!r && autoBtn) { autoBtn.remove(); autoBtn = null; }
  };
  const sync = (box: HTMLDivElement): void => {
    const r = cams.watchReplay();
    syncAuto(box, r);
    const auto = !!(r && r.autoOn());
    for (const b of Array.from(box.children) as HTMLElement[]) {
      const on = b === autoBtn ? auto : !auto && +(b.dataset["idx"] ?? -1) === cams.state.camMode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    }
  };
  const show = (): void => {
    if (doc.body.classList.contains("hud-hidden") ||
        doc.body.classList.contains("lt-open")) return;
    const box = el ?? build();
    sync(box);
    box.hidden = false;
    camTrigger?.setAttribute("aria-expanded", "true");
    box.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  };
  const hide = (): void => {
    if (el) el.hidden = true;
    camTrigger?.setAttribute("aria-expanded", "false");
  };
  const visible = (): boolean => !!el && !el.hidden;

  const offs: Array<() => void> = [];
  const b = camTrigger;
  if (b) {
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    let holdT: ReturnType<typeof setTimeout> | undefined;
    let held = false;
    let released = false;
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: Event) => void): void => {
      t.addEventListener(type, fn);
      offs.push(() => t.removeEventListener(type, fn));
    };
    on(b, "pointerdown", () => {
      held = false; released = false;
      holdT = setTimeout(() => { held = true; show(); }, HOLD_MS);
    });
    on(b, "pointerup", () => { clearTimeout(holdT); released = true; });
    on(b, "pointerleave", () => clearTimeout(holdT));
    // A cancelled touch is not a long press. iOS cancels touches routinely
    // (edge swipe, notification, gesture arbitration) and a touch pointer
    // holds implicit capture, so pointerleave never fires either: the timer
    // opened the picker mid-corner and `held` then ate the next genuine tap.
    const cancelHold = (): void => { clearTimeout(holdT); held = false; };
    on(b, "pointercancel", cancelHold);
    // Touch implicitly releases capture AFTER pointerup and BEFORE click.
    // Preserve the consumed long press through that normal release.
    on(b, "lostpointercapture", () => { if (!released) cancelHold(); });
    on(b, "contextmenu", (e) => { e.preventDefault(); show(); });
    b.onclick = () => {
      if (held) { held = false; return; }
      if (visible()) { hide(); return; }
      cams.cycleCam();
    };
    // Tap anywhere outside the grid closes it.
    on(doc, "pointerdown", (e) => {
      const t = e.target as Element | null;
      if (visible() && t !== b && !(t && t.closest && t.closest("#campicker"))) hide();
    });
    on(doc, "visibilitychange", () => {
      if (doc.hidden) hide();
    });
    offs.push(() => { clearTimeout(holdT); b.onclick = null; });
  }
  function unmount(): void {
    for (const off of offs.splice(0)) off();
    if (el) { el.remove(); el = null; autoBtn = null; }
  }
  return { show, hide, visible, unmount };
}
