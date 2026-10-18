/**
 * The GARAGE's public entry: the seam lane-shell wires. `mountGarage(el, deps)`
 * builds (or adopts) the #carsetup screen inside `el`, creates the setup
 * camera (./setup-camera.ts) and the sheet (./setup-sheet.ts) over one host
 * facade, and returns { open, close, frame, unmount }.
 *
 * What f1-game spread across js/game.js this module gathers, each cited:
 * - the #carsetup markup: index.html:2930-3067 (ids, classes and comments'
 *   intent verbatim, so ./garage.css — f1-game css/carsetup.css — applies);
 * - the G helpers the sheet and camera read: cssCol / hexToArr / arrToHex
 *   (game.js:4137-4140), armConfirm (game.js:4147-4163), getTeamParts /
 *   saveTeamParts outside a career (game.js:1204-1213), partsVisualKey
 *   (game.js:1282-1292), teamSwatch (js/ui/select-screen.js:207-232), and
 *   the G façade getters/setters (game.js:3150-3240);
 * - openGarage / leaveGarage / the BACK, DONE and FREE BUILD handlers
 *   (game.js:8862-8982), minus what belongs to other screens (the select
 *   screen, race settings, the career hub, the lobby, the loading card):
 *   those are `onExit`'s.
 * The shell owns the render loop: call `frame(dt)` from it while the garage
 * is open (f1-game render() → renderSetupPreview, game.js:7144-7150).
 */
import { CustomLiveries, type CustomLiveriesApi, type LiveryStore } from "../car/custom-liveries";
import { Parts, type PartSetup } from "../car/parts";
import { Teams, type Team } from "../car/teams";
import type { Rgb } from "../car/liveries";
import { createGarageStore, type GarageStore } from "./store";
import { createSetupTune, SetupTune as PageTune, type SetupTuneApi } from "./setup-tune";
import { createSetupCamera, type CameraCareer, type CameraTeam, type GarageAudioLike, type LightTuneLike, type PerfGovLike,
  type SetupCameraApi, type SetupCameraDeps, type SetupGfx, type SurfaceOutlineLike } from "./setup-camera";
import { createSetupSheet, type PeerSeat, type SetupSheetApi, type SetupSheetDeps, type SheetCareer, type SheetLiveryTex } from "./setup-sheet";
import { createSurfaceInspection } from "./surface-inspection";
import { createGarageScene, type GarageSceneApi } from "./scene/scene";
import type { GarageAchievements, GarageLiveryTex, GarageLog } from "./scene/types";
import type { LiveryDesignLike } from "./livery-design-editor";
import type { ExperimentsDeps } from "./setup-experiments";

export { playerSetup, SetupTune, createSetupTune, type PlayerSetup, type SetupTuneApi, type Tune } from "./setup-tune";
export { createGarageScene, type GarageSceneApi } from "./scene/scene";
export { GarageExperience, createGarageExperience } from "./experience";
export { createSetupCamera, panelCover, presentOpts, glareScale, type SetupGfx, type SetupCameraApi } from "./setup-camera";
export { createSetupSheet, type SetupSheetApi } from "./setup-sheet";
export { createLiveryDesignEditor, type LiveryDesignLike } from "./livery-design-editor";
export { createGarageStore, type GarageStore } from "./store";

/** Where the garage was opened from: it picks DONE's label and what `onExit` should do. game.js openGarage(from). */
export type GarageFrom = "menu" | "select" | "pit" | "career" | "vsfriend";

/** The race the garage's room reflects (G.trackIdx / raceWeather / raceTimeOfDay / seasonMode / season / skyHold / skyT). */
export interface GarageRaceContext {
  readonly trackIdx?: number | undefined;
  readonly weather?: string | null | undefined;
  readonly timeOfDay?: string | null | undefined;
  readonly seasonMode?: boolean | undefined;
  readonly season?: { readonly round: number } | null | undefined;
  /** A held render clock (visual regression): the room animates on skyT * 1000 ms. */
  readonly skyHold?: boolean | undefined;
  readonly skyT?: number | undefined;
}

/** Career, as the sheet, the camera and the room read it. TODO(lane-race). */
export type GarageMountCareer = SheetCareer & CameraCareer;

/**
 * Everything lane-shell hands mountGarage. Only `gfx` is required; every
 * other member defaults to the garage's own module or to f1-game's "global
 * absent" branch, and names the lane that owns the real one.
 */
export interface GarageMountDeps {
  /** The renderer facade (js/render/gfx.js): draw/drawDecal/createMesh… plus resize/begin/drawGlow/present. TODO(lane-render). */
  gfx: SetupGfx;
  /** The canvas the car renders to (f1-game #game): orbit drag, wheel zoom, panel coverage. Default `document.getElementById("game")`. */
  canvas?: HTMLElement | null | undefined;
  /** The garage store (localStorage under `a26.`). Default createGarageStore(). */
  store?: GarageStore | undefined;
  /** The setup sheet the SETUP tab edits. Default: the page's SetupTune, or one over `store` when a store is given. */
  tune?: SetupTuneApi | undefined;
  /** Teams.LIST with MY TEAM / LEGENDS spliced in. Default src/car/teams.ts LIST. */
  teams?: readonly Team[] | undefined;
  /** Liveries (CustomLiveries over `store`). Default CustomLiveries.create({ store }). */
  liveries?: CustomLiveriesApi | undefined;
  /** The garage room. Default createGarageScene({ career, livery: liveryTex }) initialised with gfx. */
  scene?: GarageSceneApi | undefined;
  /** The fitted parts in a career (game.js careerFitted). TODO(lane-race). Default store `parts.<team>`. */
  getTeamParts?: ((teamId: string) => PartSetup) | undefined;
  saveTeamParts?: ((teamId: string, parts: PartSetup) => void) | undefined;
  /** game.js `state`: "race" during WORK ON CAR (locks team and driver). TODO(lane-shell). */
  state?: (() => string) | undefined;
  /** The race the room reflects. TODO(lane-shell). */
  context?: (() => GarageRaceContext) | undefined;
  /** Sound on (G.soundOn). TODO(lane-audio). */
  soundOn?: (() => boolean) | undefined;
  /** GameAudio (uiTick / uiSelect / uiReject, the drive-out engine). TODO(lane-audio). */
  audio?: GarageAudioLike | null | undefined;
  /** Career. TODO(lane-race). */
  career?: GarageMountCareer | null | undefined;
  /** G.careerOwned(): the career's owned-part set. TODO(lane-race). */
  careerOwned?: (() => { has(id: string): boolean } | null | false | undefined) | undefined;
  /** CareerExperience.garageMetadata. TODO(lane-race). */
  careerExperience?: { garageMetadata(): GarageAchievements | null | undefined } | null | undefined;
  /** SeasonCal.track(round). TODO(lane-race). */
  seasonCal?: SetupCameraDeps["seasonCal"];
  /** LiveryTex (the sheet's swatches / pill ids and the room's atlases). TODO(lane-car): src/car/liverytex.ts. */
  liveryTex?: (SheetLiveryTex & GarageLiveryTex) | null | undefined;
  /** LiveryDesign. TODO(lane-car): src/car/livery-design.ts. */
  liveryDesign?: LiveryDesignLike | null | undefined;
  /** Helmets.STYLES. TODO(lane-car). */
  helmetStyles?: readonly string[] | null | undefined;
  /** GarageSurfaceOutline.create(gfx). TODO(lane-car). */
  surfaceOutline?: SurfaceOutlineLike | null | undefined;
  /** car-draw helpers (game.js): decals, flaps, paint, the paused-race frame. TODO(lane-render). */
  carDraw?: Pick<SetupCameraDeps, "teamDecalState" | "drawAeroFlaps" | "carDecalNum" | "drawCarDecals" | "carPaintMat"
    | "PAINT_DRY_DAY" | "MAT_REFLECT_X" | "previewDecalMesh" | "render" | "drawRearLights" | "mirrorStandDown"> | undefined;
  /** car-draw invalidateDecalTextures. TODO(lane-render). */
  invalidateDecalTextures?: ((teamId: string) => void) | null | undefined;
  /** LightTune.LT. TODO(lane-render). */
  lightTune?: (() => LightTuneLike | null | undefined) | undefined;
  /** PerfGov. TODO(lane-shell). */
  perfGov?: PerfGovLike | null | undefined;
  /** LoadingScreen.isAutomation. TODO(lane-shell). */
  isAutomation?: (() => boolean) | undefined;
  /** GaragePrebuild.packSettled(Assets.state()). TODO(lane-shell). */
  packSettled?: (() => boolean) | undefined;
  /** The team picker (Menus.setTeamPicker). TODO(lane-shell). */
  setTeamPicker?: ((open: boolean) => void) | undefined;
  /** EDIT MY TEAM (CustomTeam). TODO(lane-race). */
  openCustomize?: (() => void) | undefined;
  /** VS FRIEND seats. TODO(lane-net). */
  peerSeats?: (() => readonly PeerSeat[]) | undefined;
  /** SettingsExport / ShareCode / ApexClipboard. TODO(lane-shell). */
  settingsExport?: SetupSheetDeps["settingsExport"];
  shareCode?: SetupSheetDeps["shareCode"];
  clipboard?: SetupSheetDeps["clipboard"];
  /** SetupExperiments' presets / trials / tracks. */
  experiments?: ExperimentsDeps | undefined;
  /**
   * After BACK or DONE closed the garage: the shell shows what comes next
   * (game.js:8961-8977 — the select screen, race settings, the career hub,
   * the lobby, the title; a pit visit returns to the race).
   */
  onExit?: ((how: "back" | "done", from: GarageFrom) => void) | undefined;
  log?: GarageLog | undefined;
}

/** What mountGarage returns. */
export interface MountedGarage {
  /** openGarage(from) (game.js:8862-8898): optionally switch to `teamId` first; a "pit" visit plays the arrival. */
  open(teamId?: string, from?: GarageFrom): void;
  /** leaveGarage (game.js:8937-8943): hide the screen and stop the preview. Does not call onExit. */
  close(): void;
  /** One garage frame (renderSetupPreview); false when closed or not yet presentable. Call from the shell's loop. */
  frame(dt: number): boolean;
  readonly isOpen: boolean;
  /** The #carsetup element. */
  readonly root: HTMLElement;
  /** The team on the lift. */
  readonly teamId: string;
  readonly camera: SetupCameraApi;
  readonly sheet: SetupSheetApi;
  readonly scene: GarageSceneApi;
  /** The SetupTune the SETUP tab writes (pass it to playerSetup). */
  readonly tune: SetupTuneApi;
  /** Close, remove every listener this mount added, and remove the screen if mountGarage built it. */
  unmount(): void;
}

// ── the markup (index.html:2930-3067) ───────────────────────────────────────
const CARSETUP_HTML = `
  <div id="cs-arrival" hidden>
    <span id="cs-arrival-label" role="status" aria-live="polite">OPENING GARAGE</span>
    <button id="cs-arrival-skip" type="button">SKIP TO WORK</button>
  </div>
  <div id="cs-stack">
    <div id="cs-cam-panel" hidden>
      <div>
        <span class="cs-pan-lbl" aria-hidden="true">VIEW</span>
        <div id="cs-view" role="group" aria-label="Camera presets">
          <button type="button" class="cs-view-btn" data-cs-view="hero" title="Three-quarter view">3/4</button>
          <button type="button" class="cs-view-btn" data-cs-view="front" title="Front view">FRONT</button>
          <button type="button" class="cs-view-btn" data-cs-view="side" title="Side view">SIDE</button>
          <button type="button" class="cs-view-btn" data-cs-view="rear" title="Rear view">REAR</button>
          <button type="button" class="cs-view-btn" data-cs-view="top" title="Top view">TOP</button>
        </div>
      </div>
      <div>
        <span class="cs-pan-lbl" aria-hidden="true">WINGS</span>
        <div id="cs-wing-views" role="group" aria-label="Wing framings">
          <button type="button" id="cs-wing-front" class="cs-view-btn" data-cs-view="wingFront"
                  title="Frame the FRONT wing from a three-quarter angle — the best view of its elements opening"
                  aria-label="View the front wing">FRONT</button>
          <button type="button" id="cs-wing-rear" class="cs-view-btn" data-cs-view="wingRear"
                  title="Frame the REAR wing from a three-quarter angle — the best view of its elements opening"
                  aria-label="View the rear wing">REAR</button>
        </div>
      </div>
      <div>
        <span class="cs-pan-lbl" aria-hidden="true">MOVE</span>
        <div class="cs-pan-grp" role="group" aria-label="Move the camera">
          <button type="button" id="cs-view-left" class="cs-view-btn" title="Rotate left" aria-label="Rotate left">&#9664;</button>
          <button type="button" id="cs-view-right" class="cs-view-btn" title="Rotate right" aria-label="Rotate right">&#9654;</button>
          <button type="button" id="cs-view-up" class="cs-view-btn" title="Raise the camera" aria-label="Raise the camera">&#9650;</button>
          <button type="button" id="cs-view-down" class="cs-view-btn" title="Lower the camera" aria-label="Lower the camera">&#9660;</button>
          <span class="cs-view-sep" aria-hidden="true"></span>
          <button type="button" id="cs-view-in" class="cs-view-btn" title="Zoom in" aria-label="Zoom in">&plus;</button>
          <button type="button" id="cs-view-out" class="cs-view-btn" title="Zoom out" aria-label="Zoom out">&minus;</button>
        </div>
      </div>
      <div>
        <span class="cs-pan-lbl" aria-hidden="true">PAN</span>
        <div class="cs-pan-grp" role="group" aria-label="Pan the camera">
          <button type="button" id="cs-pan-left" class="cs-view-btn" title="Slide left" aria-label="Pan left">&larr;</button>
          <button type="button" id="cs-pan-right" class="cs-view-btn" title="Slide right" aria-label="Pan right">&rarr;</button>
          <span class="cs-view-sep" aria-hidden="true"></span>
          <button type="button" id="cs-pan-fwd" class="cs-view-btn" title="Slide forward, toward the nose" aria-label="Pan forward">&uarr;</button>
          <button type="button" id="cs-pan-back" class="cs-view-btn" title="Slide back, toward the rear wing" aria-label="Pan back">&darr;</button>
        </div>
      </div>
      <div>
        <span class="cs-pan-lbl" aria-hidden="true"></span>
        <div class="cs-pan-grp">
          <span class="cs-view-grp">
            <button type="button" id="cs-view-spin" class="cs-view-btn active" aria-pressed="true" title="Auto-rotate the car">SPIN</button>
          </span>
          <span class="cs-view-grp">
            <button type="button" id="cs-view-reset" class="cs-view-btn" title="Back to the default view">RESET</button>
          </span>
          <span class="cs-view-hint">drag to orbit</span>
        </div>
      </div>
    </div>
    <div id="cs-bar">
      <span class="cs-view-grp">
        <button type="button" id="cs-cam" aria-expanded="false" aria-controls="cs-cam-panel"
                title="Camera: presets, wing framings, and manual orbit">
          <span>CAMERA</span>
          <span class="cs-cam-caret" aria-hidden="true">&#9652;</span>
        </button>
      </span>
      <div id="cs-aero-bar">
        <button type="button" id="cs-aero" aria-pressed="false"
                title="Active aero: open and close the front and rear wing flaps (Z-mode = downforce, X-mode = low drag)">
          <span class="cs-aero-lbl">ACTIVE AERO</span>
          <span class="cs-aero-val">CORNER MODE</span>
        </button>
      </div>
    </div>
  </div>
  <div id="cs-inner" class="sheet pane-pair pair-foot-full">
    <div id="cs-header" class="sheet-head">
      <div id="cs-titlebar">
        <h2>GARAGE</h2>
        <div id="cs-team"></div>
      </div>
      <div id="cs-budget-wrap">
        <div id="cs-budget-bar"><div id="cs-budget-fill"></div></div>
        <div id="cs-budget-row">
          <div id="cs-budget"></div>
          <button id="cs-unlimited" class="cs-unlimited-btn">&#8734; FREE BUILD</button>
        </div>
      </div>
      <div id="cs-stats-inner"></div>
    </div>
    <div id="cs-body" class="sheet-body">
      <div id="cs-tabs" class="pane pair-side"></div>
      <div id="cs-options" class="pane pair-main"></div>
    </div>
    <div class="sheet-foot"><button id="cs-back" class="bigbtn alt">BACK</button><button id="cs-done" class="bigbtn">DONE</button></div>
  </div>`;

/** Build the #carsetup screen (index.html:2930-3067), hidden. */
export function buildCarsetup(doc: Document = document): HTMLElement {
  const root = doc.createElement("div");
  root.id = "carsetup"; root.className = "screen";
  root.setAttribute("role", "region"); root.setAttribute("aria-label", "Garage");
  root.setAttribute("data-esc-close", "cs-back");
  root.hidden = true;
  const tpl = doc.createElement("template");
  tpl.innerHTML = CARSETUP_HTML;
  root.appendChild(tpl.content);
  return root;
}

// ── the G helpers (game.js) ─────────────────────────────────────────────────
/** game.js:4137 */
export function cssCol(c: readonly number[]): string { return "rgb(" + (c[0]! * 255 | 0) + "," + (c[1]! * 255 | 0) + "," + (c[2]! * 255 | 0) + ")"; }
// Convert between an <input type=color> hex string and a [r,g,b] 0..1 array.
/** game.js:4139 */
export function hexToArr(h: string): Rgb { const n = parseInt(String(h).slice(1), 16) || 0; return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
/** game.js:4140 */
export function arrToHex(a: readonly number[]): string { const f = (v: number): string => ("0" + Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16)).slice(-2); return "#" + f(a[0]!) + f(a[1]!) + f(a[2]!); }
// Arm-then-confirm for destructive buttons — the career slot DELETE→DELETE?
// pattern, lifted so the livery ✕ and a mid-season APPLY stop being the only
// irreversible actions in the app with no confirmation. First press arms the
// button in place (label swap + .armed, no modal, no reflow); the second runs
// the action. Returns true when the action ran. Disarm is the caller's rebuild
// or any other click path replacing the node.
/** game.js:4147-4163 */
export function armConfirm(btn: HTMLElement, armedText: string, action: () => void): boolean {
  // An aria-label outranks the text, so a labelled button (the livery ✕) was
  // announced unchanged when armed; the armed state goes into the name too.
  const name = btn.getAttribute("aria-label");
  if (!btn.dataset["armed"]) {
    btn.dataset["armed"] = "1";
    btn.textContent = armedText;
    btn.classList.add("armed");
    if (name) { btn.dataset["name"] = name; btn.setAttribute("aria-label", "Confirm: " + name + ". Press again"); }
    return false;
  }
  delete btn.dataset["armed"];
  btn.classList.remove("armed");
  if (btn.dataset["name"]) { btn.setAttribute("aria-label", btn.dataset["name"]); delete btn.dataset["name"]; }
  action();
  return true;
}

/** The DONE label per door (game.js:8867-8869). */
export function doneLabel(from: GarageFrom): string {
  return from === "select" ? "RACE SETUP" :
    from === "pit" ? "RETURN TO RACE" : from === "career" ? "RETURN TO CAREER" :
    from === "vsfriend" ? "RETURN TO LOBBY" : "CLOSE GARAGE";
}

/** Mount the GARAGE into `el`. See GarageMountDeps / MountedGarage. */
export function mountGarage(el: HTMLElement, deps: GarageMountDeps): MountedGarage {
  const doc = el.ownerDocument;
  let root = el.querySelector<HTMLElement>("#carsetup");
  const built = !root;
  if (!root) { root = buildCarsetup(doc); el.appendChild(root); }
  const screen = root;
  const store = deps.store || createGarageStore();
  const tune = deps.tune || (deps.store ? createSetupTune(deps.store) : PageTune);
  const TEAMS: readonly Team[] = deps.teams || Teams.LIST;
  const liveryStore: LiveryStore = {
    get: <T>(k: string, d: T): T => store.get(k, d) as T,
    set: (k, v) => store.set(k, v),
    get rev() { return store.rev; },
  };
  const liveries = deps.liveries || CustomLiveries.create({ store: liveryStore });
  const inspection = createSurfaceInspection();
  const scene = deps.scene || createGarageScene({ career: deps.career, livery: deps.liveryTex || null });
  if (!deps.scene) scene.init(deps.gfx);
  // The id lookup (f1-game `$`): this screen first, then the page.
  const $ = (id: string): HTMLElement | null => {
    if (id === "game" && deps.canvas !== undefined) return deps.canvas;
    return screen.querySelector<HTMLElement>(`[id="${id}"]`) || (doc.getElementById(id) as HTMLElement | null);
  };
  const idxOf = (teamId: string | null | undefined): number => TEAMS.findIndex((t) => t.id === teamId);
  const storedTeam = store.get("team", 2);
  let teamIdx = typeof storedTeam === "number" && storedTeam >= 0 && storedTeam < TEAMS.length ? storedTeam : Math.min(2, TEAMS.length - 1);
  let driverIdx = (store.get("driver", 0) as number) | 0;
  let unlimitedBudget = store.get("unlimitedBudget", true) !== false;
  let setupPreviewOn = false;
  let from: GarageFrom = "menu";
  let camera: SetupCameraApi | null = null;
  const getTeamParts = deps.getTeamParts || ((teamId: string): PartSetup => store.get("parts." + teamId, {}) as PartSetup);
  const saveTeamParts = deps.saveTeamParts || ((teamId: string, parts: PartSetup): void => { store.set("parts." + teamId, parts); });
  const ctx = (): GarageRaceContext => (deps.context ? deps.context() : {});
  // partsVisualKey(teamId) -> cheap cache key for the resolved cosmetic tiers.
  // Key on the resolved OPTION id per category — the option fully determines the
  // visual, so the mesh cache rebuilds whenever any choice changes. game.js:1282-1292
  function partsVisualKey(teamId: string): string {
    const team = TEAMS.find((t) => t.id === teamId);
    const vt = Parts.getVisualTiers(getTeamParts(teamId), team);
    const parts = vt._ids ? Parts.CATALOG.map((c) => vt._ids[c.id]).join("|")
                          : Parts.CATALOG.map((c) => vt[c.id]).join("");
    return parts + "|L:" + liveries.getLiveryId(teamId);   // livery repaints the mesh too
  }
  // js/ui/select-screen.js:207-232, without the crest lookup's legends override.
  function teamSwatch(t: Team): HTMLElement {
    const sw = doc.createElement("span");
    sw.className = "tm-colour";
    const liv = liveries.resolveLivery(t);
    const c1 = (liv && liv.c1) || t.color;
    const c2 = (liv && liv.c2) || t.color2 || t.color;
    const LT = deps.liveryTex;
    if (LT && LT.paintSwatch) {
      const c = doc.createElement("canvas");
      c.width = 48; c.height = 48;
      c.setAttribute("aria-hidden", "true");
      LT.paintSwatch(c.getContext("2d") as CanvasRenderingContext2D, t.id, (liv || { c1, c2 }) as never, c.width, c.height);
      sw.appendChild(c);
    } else {
      sw.style.background = "linear-gradient(135deg," + cssCol(c1) + " 62%," + cssCol(c2) + " 62%)";
    }
    sw.setAttribute("aria-hidden", "true");
    return sw;
  }

  // framePreset mutes G.soundOn across a synthetic click and restores it; the
  // shell's sound flag is read-only here, so the mute is a local override that
  // clears itself when set back to the shell's value.
  let soundOverride: boolean | undefined;
  // One live host: f1-game's G, as the camera and the sheet read it.
  const host = {
    $, gfx: deps.gfx, clamp: (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v),
    store, getTeamParts, saveTeamParts, cssCol, arrToHex, hexToArr, armConfirm, teamSwatch,
    getLiveryId: (id: string) => liveries.getLiveryId(id),
    saveLiveryId: (id: string, liv: string): void => { liveries.saveLiveryId(id, liv); },
    getCustomLiveries: (id: string) => liveries.getCustomLiveries(id),
    setCustomLiveries: (id: string, arr: Parameters<CustomLiveriesApi["setCustomLiveries"]>[1]): void => { liveries.setCustomLiveries(id, arr); },
    getLiveries: (t: Team) => liveries.getLiveries(t),
    invalidateDecalTextures: deps.invalidateDecalTextures || null,
    els: { select: doc.getElementById("select"), overlay: doc.getElementById("overlay") },
    get teamIdx() { return teamIdx; },
    get driverIdx() { return driverIdx; }, set driverIdx(v: number) { driverIdx = v; },
    get soundOn() { return soundOverride ?? (deps.soundOn ? deps.soundOn() : false); },
    set soundOn(v: boolean | undefined) { soundOverride = v === (deps.soundOn ? deps.soundOn() : false) ? undefined : v; },
    get state() { return deps.state ? deps.state() : "menu"; },
    setTeamPicker: (open: boolean): void => { if (deps.setTeamPicker) deps.setTeamPicker(open); },
    openCustomize: (): void => { if (deps.openCustomize) deps.openCustomize(); },
    peerSeats: deps.peerSeats,
    careerOwned: () => (deps.careerOwned ? deps.careerOwned() : null),
    get unlimitedBudget() { return unlimitedBudget; },
    get livDraftOverride() { return liveries.livDraftOverride; }, set livDraftOverride(v) { liveries.livDraftOverride = v; },
    get _spMeshKey() { return camera ? camera.meshKey : ""; }, set _spMeshKey(v: string) { if (camera) camera.meshKey = v; },
    get setupPreviewOn() { return setupPreviewOn; }, set setupPreviewOn(v: boolean) { setupPreviewOn = v; },
    get trackIdx() { return ctx().trackIdx; },
    get raceWeather() { return ctx().weather; },
    get raceTimeOfDay() { return ctx().timeOfDay; },
    get seasonMode() { return ctx().seasonMode; },
    get season() { return ctx().season; },
    get skyHold() { return ctx().skyHold; },
    get skyT() { return ctx().skyT; },
  };
  const resolveLivery = (team: CameraTeam) => liveries.resolveLivery(team as unknown as Team) as unknown as ReturnType<SetupCameraDeps["resolveLivery"]>;
  camera = createSetupCamera(host, {
    resolveLivery, partsVisualKey, ...(deps.carDraw || {}),
    scene, teams: TEAMS as unknown as readonly CameraTeam[], seasonCal: deps.seasonCal, career: deps.career,
    careerExperience: deps.careerExperience, audio: deps.audio, lightTune: deps.lightTune, perfGov: deps.perfGov,
    isAutomation: deps.isAutomation, packSettled: deps.packSettled, surfaceOutline: deps.surfaceOutline,
    surfaceInspection: inspection, log: deps.log,
  });
  const cam = camera;
  const sheet = createSetupSheet(host, {
    teams: TEAMS, tune, experiments: { tune, ...(deps.experiments || {}) }, career: deps.career, audio: deps.audio,
    liveryTex: deps.liveryTex, liveryDesign: deps.liveryDesign, helmetStyles: deps.helmetStyles,
    settingsExport: deps.settingsExport, shareCode: deps.shareCode, clipboard: deps.clipboard,
    scene, surfaceInspection: inspection, log: deps.log,
  });

  const uiTick = (): void => { if (host.soundOn && deps.audio && deps.audio.uiTick) deps.audio.uiTick(); };
  function close(): void {
    // leaveGarage (game.js:8937-8943), minus the loading card and recomputePlayerMods (the shell's).
    cam.cancelArrival();
    screen.hidden = true;
    setupPreviewOn = false;
  }
  function exit(how: "back" | "done"): void {
    if (how === "back") uiTick();
    close();
    if (deps.onExit) deps.onExit(how, from);
  }
  const back = $("cs-back"), done = $("cs-done"), unl = $("cs-unlimited");
  if (back) back.onclick = () => exit("back");
  if (done) done.onclick = () => exit("done");
  if (unl) unl.onclick = () => {
    unlimitedBudget = !unlimitedBudget;
    store.set("unlimitedBudget", unlimitedBudget);
    sheet.buildSetup();
  };

  function open(teamId?: string, door: GarageFrom = "menu"): void {
    if (teamId !== undefined) {
      const i = idxOf(teamId);
      if (i >= 0 && i !== teamIdx) { teamIdx = i; store.set("team", i); driverIdx = 0; store.set("driver", 0); }
    }
    from = door;
    if (done) done.textContent = doneLabel(door);
    // Fresh camera every visit (game.js:8870-8877): the turntable is the front door.
    cam.resetSetupCam();
    cam.setSetupCamPanel(false);
    sheet.openSetup();
    if (door === "pit") cam.startArrival();
  }

  let mounted = true;
  function unmount(): void {
    if (!mounted) return;
    mounted = false;
    if (!screen.hidden || setupPreviewOn) close();
    sheet.dispose();
    cam.dispose();
    cam.release();
    if (back) back.onclick = null;
    if (done) done.onclick = null;
    if (unl) unl.onclick = null;
    if (built) screen.remove();
  }

  return {
    open, close, unmount,
    frame: (dt: number): boolean => (mounted && setupPreviewOn ? cam.renderSetupPreview(dt) : false),
    get isOpen() { return !screen.hidden; },
    root: screen,
    get teamId() { return (TEAMS[teamIdx] as Team).id; },
    camera: cam, sheet, scene, tune,
  };
}

export type { SetupCameraDeps, SetupSheetDeps, GarageAudioLike, LightTuneLike, PerfGovLike, SurfaceOutlineLike, SheetCareer, SheetLiveryTex, CameraCareer, PeerSeat };
