/**
 * TrackDesigner: the TRACK DESIGNER screen. Ported verbatim from f1-game
 * js/editor/designer.js (TrackDesigner, :1-2520).
 *
 * The player composes a circuit (drags and inserts control points, stamps
 * straights, corners, hairpins, chicanes and S-bends onto the loop, draws one
 * freehand or randomises one), picks a theme, names it and saves it into MY
 * CIRCUITS (CustomTracks), then races it through the ordinary RACE / TIME TRIAL
 * doors. The preview is the ENGINE's own centreline (TrackValidate), debounced
 * 80 ms and never mid-drag; a RED issue blocks SAVE and RACE, and a draft is
 * autosaved so nothing is lost on close.
 *
 * Differences from f1-game:
 * - The IIFE body is `createDesigner(deps)` (one instance per screen). `mount(el,
 *   deps)` builds a fresh instance inside `el`, which stands in for index.html's
 *   `<dialog id="trackdesigner">` (:3509-3514): mount recreates its `sheet-head`
 *   (the TRACK DESIGNER heading and the `#td-close` button) inside `el`. The
 *   named exports (every member of f1-game's return object, designer.js:2514)
 *   delegate to the latest mounted instance, or to a lazily created bare one.
 * - Every global designer.js reads that is not an editor module arrives through
 *   `DesignerDeps` (GameStore.store, CustomTracks, GameAudio, the `_G` façade,
 *   Log, ApexClipboard, NativeDownload, Flags, TrackMaps, Tracks.LIST's custom
 *   tail, and the #mb-race / #mb-tt title doors). `mount` defaults `trackMaps` to
 *   the ported src/track/maps/track-maps.ts and injects it into validate.ts
 *   (setTrackMaps) while mounted, as f1-game's browser always loads TrackMaps.
 * - Editor modules are static imports, so their `typeof X !== "undefined"`
 *   guards (ElevPresets, TrackDesignerProps, TrackInsight, TrackFixes,
 *   DesignerProfile, TrackShape, CustomTracks.KERB_STYLES / sanitizeHeights)
 *   are always true and are gone; the try/catch around each call stays.
 * - `#td-close` is looked up inside the root first (the root need not be in the
 *   document), then by id. `destroy()` is new: it removes the listeners,
 *   timers and nodes `init()` added.
 * - DOM access happens only inside functions: importing this module in Node
 *   does not touch `document`.
 */
import "./editor.css";
import * as DesignerBridges from "./bridge-panel";
import * as DesignerCanvas from "./canvas";
import * as TrackCodec from "./codec";
import * as CustomTracks from "./custom-tracks";
import type { BankZoneRec, BumpRec, CustomTracksApi, HwZoneRec, Look } from "./custom-tracks";
import { el } from "./dom";
import * as ElevPresets from "./elev-presets";
import * as TrackFixes from "./fixes";
import * as DesignerFollowup from "./followup-tools";
import * as Hash32 from "./hash32";
import * as TrackInsight from "./insight";
import type { Corner } from "./insight";
import * as DesignerProfile from "./profile";
import * as TrackDesignerProps from "./props";
import type { DesignerProp, PropKind } from "./props";
import * as TrackRandom from "./randomise";
import * as DesignerScenery from "./scenery-panel";
import * as DesignerSelection from "./selection-panel";
import * as TrackShape from "./shape";
import type { Pt } from "./shape";
import * as TrackStamps from "./stamps";
import type { EditorStore } from "./store";
import * as TrackThemes from "./track-themes";
import * as TrackValidate from "./validate";
import type { Issue, Stats } from "./validate";
import * as DesignerWorkspace from "./workspace";
import type { BuiltDef } from "../track/core/def";
import * as TrackMaps from "../track/maps/track-maps";
import * as Tracks from "../track/core/tracks";
import type { Track } from "../track/core/types";

// ── types ─────────────────────────────────────────────────────────────────

/** The working design (sanitize's record, loosely: a work in progress may be red). */
export interface Design {
  name: string; seed: number; theme: string; baseHW: number;
  pts: Pt[]; heights: number[];
  hwZones: HwZoneRec[]; bankZones: BankZoneRec[]; elevations: BumpRec[]; bridges: BumpRec[];
  turns: number[]; lengthM: number;
  look?: Look | undefined; country?: string | undefined; kerbStyle?: string | undefined; berms?: boolean | undefined;
  props?: DesignerProp[] | undefined;
  /** The content id (SAVE), the MY CIRCUITS id SAVE replaces, and the history lineage (load). */
  id?: string | undefined; originId?: string | undefined; lin?: number | undefined;
  created?: number | undefined; updated?: number | undefined;
}
/** runPreview's verdict: TrackValidate.check's, or the empty-sheet stand-in (no stats, no def). */
export type PreviewVerdict = { ok: boolean; red: number; amber: number; issues: Issue[]; stats: Stats | null; def?: BuiltDef | null; tr: Track | null; turns: number[] };
/** The player as placeAt writes it (game.js / agent/apex.js fields). */
export interface TestPlayer { [field: string]: unknown; s: number; prog?: number; px?: number; pz?: number; head?: number; speed?: number }
/** f1-game's `_G` façade (js/game.js), the fields designer.js reads and writes. TODO(lane-shell) */
export interface DesignerGame {
  soundOn?: boolean; store?: DesignerStore | null; trackIdx?: number;
  seasonMode?: boolean; timeTrial?: boolean; headlessMode?: boolean;
  state?: string; player?: TestPlayer | null; track?: Track | null;
  startRace?(): unknown; raceIntro?(go: () => void): void; goRolling?(): unknown;
  snapGameCam?(): void; refreshHud?(force: boolean): void; quitToMenu?(): void;
}
/** GameStore.store as the designer reads it: an EditorStore, plus the mirror flush. */
export type DesignerStore = EditorStore & { mirrorFlush?(): void };
/** TEST HERE's way back (CustomTracks.armReturn / open({ resume })). */
export interface DesignerReturn { id: string; sel?: number; span?: number; s?: number; msg?: string }
/** open()'s options (designer.js:1658). */
export interface OpenOpts { design?: object | null; shared?: boolean; originId?: string | null; resume?: DesignerReturn | null }

/**
 * Everything designer.js reads from globals. Each member is optional where
 * f1-game guards the global with `typeof` (or a truthiness check); an absent one
 * takes f1-game's "not loaded" branch.
 */
export interface DesignerDeps {
  /** CustomTracks: an instance from createCustomTracks (designer.js:1626 `deps.custom || CustomTracks`). TODO(lane-shell) */
  custom?: CustomTracksApi | null;
  /** f1-game's `_G` façade (designer.js:1625 init(G_)). TODO(lane-shell) */
  game?: DesignerGame | null;
  /** GameStore.store (designer.js:159 gstore, :1631 mirrorFlush); `game.store` wins. TODO(lane-shell) */
  store?: DesignerStore | null;
  /** GameAudio (designer.js:103-104, typeof-guarded). TODO(lane-shell) */
  audio?: { uiTick?(): void; uiSelect?(): void } | null;
  /** The title screen's RACE door: `document.getElementById("mb-race").click()` (designer.js:814). TODO(lane-shell) */
  onRace?: (() => void) | null;
  /** The title screen's TIME TRIAL door: `#mb-tt` (designer.js:814). TODO(lane-shell) */
  onTimeTrial?: (() => void) | null;
  /** Tracks.LIST with the custom tail (designer.js:1603, :1833, :1858). Default: the shipped LIST. TODO(lane-shell) */
  trackList?: (() => readonly BuiltDef[]) | null;
  /** Log (js/core/log.js): absent drops the line. TODO(lane-shell) */
  log?: { info?(ns: string, msg: string): void; warn?(ns: string, msg: string): void; debug?(ns: string, msg: string): void } | null;
  /** ApexClipboard (designer.js:1297, typeof-guarded). TODO(lane-shell) */
  clipboard?: { write?(text: string): unknown } | null;
  /** NativeDownload (designer.js:2278, typeof-guarded). TODO(lane-shell) */
  nativeDownload?: { viable?(): boolean; saveBlob?(blob: Blob, name: string): unknown } | null;
  /** Flags: the country picker's names (designer.js:1164, typeof-guarded). TODO(lane-shell) */
  flags?: { countries(): readonly string[]; code(name: string): string | null | undefined } | null;
  /** TrackMaps (js/ui/track-maps.js): library thumbnails and the card's ink (designer.js:1604, :2370). mount() defaults it to src/track/maps/track-maps.ts. */
  trackMaps?: { draw?(c: HTMLCanvasElement, def: BuiltDef, opts: { width: number; color: string }): void; themeColor?(def: unknown): string | null | undefined } | null;
}

/** Workspace group (DesignerWorkspace.group): a div or details with its label node. */
type Group = DesignerWorkspace.TdGroup;
/** A folding group (DesignerWorkspace FOLDS: CORNERS, SHARE CODE, …): a details. */
type Fold = HTMLDetailsElement & { _label: HTMLElement };
/** stepper()'s row: label, −, value, + (designer.js:1084). */
type StepperRow = HTMLDivElement & { _label: HTMLSpanElement; _refresh: () => void };
type ParamKey = "L" | "R" | "deg";
type Params = { [key: string]: number | undefined; L?: number; R?: number; deg?: number; dir?: number; Ls?: number };
type FracMap = (f: number, role: "p" | "s0" | "s1") => number | null;
type Timer = ReturnType<typeof setTimeout> | 0;

/** The named nodes, built once (designer.js:82). */
interface Ui {
  stats: HTMLDivElement; hint: HTMLDivElement; ctx: HTMLDivElement;
  ctxDel: HTMLButtonElement; ctxStart: HTMLButtonElement; ctxClose: HTMLButtonElement; ctxTest: HTMLButtonElement;
  toolbar: HTMLDivElement; undo: HTMLButtonElement; redo: HTMLButtonElement; fitBtn: HTMLButtonElement;
  outlineView: HTMLButtonElement; sceneryView: HTMLButtonElement; heightHeat: HTMLButtonElement;
  rail: HTMLDivElement; tabDesign: HTMLButtonElement; tabLib: HTMLButtonElement; tabHow: HTMLButtonElement;
  paneDesign: HTMLElement; paneLib: HTMLElement; paneHow: HTMLElement;
  recoverDraft: HTMLButtonElement; libraryFile: HTMLInputElement; libraryReview: Group;
  libraryProgress: HTMLParagraphElement; libraryRecords: HTMLUListElement;
  libraryApply: HTMLButtonElement; libraryCancel: HTMLButtonElement; lib: HTMLDivElement;
  save: HTMLButtonElement; race: HTMLButtonElement; tt: HTMLButtonElement; share: HTMLButtonElement;
  card: HTMLButtonElement; export: HTMLButtonElement; import: HTMLButtonElement; file: HTMLInputElement; msg: HTMLDivElement;
  modeGroup: HTMLDivElement; modes: HTMLDivElement; tools: HTMLDivElement; toolHint: HTMLDivElement; toolsGroup: Group;
  shape: Fold; shapeLabel: HTMLElement; paramRows: Record<ParamKey, StepperRow>;
  dirL: HTMLButtonElement; dirR: HTMLButtonElement; apply: HTMLButtonElement; shapeHint: HTMLDivElement;
  themeGroup: HTMLElement; circuitGroup: Group; name: HTMLInputElement; country: HTMLSelectElement; width: StepperRow;
  randomise: HTMLButtonElement; reverse: HTMLButtonElement; start: HTMLButtonElement; del: HTMLButtonElement;
  prevPt: HTMLButtonElement; nextPt: HTMLButtonElement; spanEnd: HTMLButtonElement; testHere: HTMLButtonElement;
  elevGroup: Group; elevPresets: HTMLDivElement; elevHint: HTMLDivElement; elevNode: StepperRow; elevActions: HTMLDivElement;
  bankGroup: Group; bankHint: HTMLDivElement; kerbChips: HTMLDivElement; bermChips: HTMLDivElement;
  bermOn: HTMLButtonElement; bermOff: HTMLButtonElement;
  checksGroup: HTMLDivElement; fixAll: HTMLButtonElement; issues: HTMLUListElement;
  sharingGroup: Fold; code: HTMLInputElement; load: HTMLButtonElement;
  quickHeight: HTMLDivElement; quickHeightLabel: HTMLDivElement; heightDelta: HTMLInputElement; quickHeightHint: HTMLDivElement;
  coach: HTMLElement | null; coachFirst: HTMLButtonElement | null;
  seedRow: HTMLDivElement; totd: HTMLButtonElement; fromBtn: HTMLButtonElement; heat: HTMLButtonElement; from: HTMLDivElement;
  turnsGroup: Group; turns: HTMLUListElement;
  spiral: StepperRow; spanW: StepperRow; turnPick: HTMLDivElement; turnPickLabel: HTMLDivElement; bank: StepperRow;
  profile: HTMLCanvasElement;
  styleRow: HTMLDivElement; styles: Record<string, HTMLButtonElement>; cands: HTMLDivElement; candidateSection: HTMLDivElement;
}

// ── constants (designer.js:16-78) ─────────────────────────────────────────
const PREVIEW_MS = 80, DRAFT_MS = 600, UNDO_CAP = 100, NUDGE_MS = 500, IMPORT_MAX = 64 * 1024;
/** designer.js:17 */
export const TOOLS: readonly (readonly [string, string])[] = [["select", "SELECT"], ["draw", "DRAW"], ["straight", "STRAIGHT"], ["corner", "CORNER"], ["hairpin", "HAIRPIN"], ["chicane", "CHICANE"], ["sbend", "S-BEND"]];
/** designer.js:18 */
export const MODES: readonly (readonly [string, string])[] = Object.freeze([
  ["draw", "DRAW"],
  ["edit", "EDIT"],
  ["elevation", "ELEVATION"],
  ["scenery", "SCENERY"],
  ["test", "TEST"],
] as const);
const STEPS: Record<ParamKey, number> = { L: 10, R: 5, deg: 5 };
const PARAM_LABEL: Record<ParamKey, string> = { L: "LENGTH m", R: "RADIUS m", deg: "ANGLE °" };
/** The HOW TO tab's text, one table (docs/TRACK-DESIGNER.md is the long form):
 *  STEPS in the order a first circuit is built, GESTURES per input, LIMITS. designer.js:29 */
export const HOWTO = Object.freeze({
  STEPS: Object.freeze([
    { n: 1, title: "Start", text: "Open DRAW and use RANDOMISE for a starting circuit, START FROM… for a template, or DRAW one closed loop." },
    { n: 2, title: "Shape", text: "Open EDIT and drag a selected point to move the road; RANGE selects a whole section. UNDO restores the previous edit." },
    { n: 3, title: "Corners", text: "In EDIT, choose a corner shape and its size, then tap a point to place it. REPLACE THE SELECTED SPAN reshapes a selected section." },
    { n: 4, title: "Elevation", text: "Open ELEVATION to adjust point heights or add ROAD BRIDGES. Select a turn here; BANK ° tilts it; KERB chooses flat, sausage or rumble, and BERMS supports banked corners." },
    { n: 5, title: "Look", text: "Open SCENERY and choose a theme; LIVE SCENERY shows an overhead preview. Tune the atmosphere or place objects beside the road." },
    { n: 6, title: "Checks", text: "Open TEST and resolve red CHECKS before saving. Use FIX where a repair is available." },
    { n: 7, title: "Race and share", text: "Name your circuit and SAVE, then RACE or TIME TRIAL. SHARE copies a link; CARD / EXPORT / IMPORT move one circuit; MY CIRCUITS → EXPORT ALL / IMPORT LIBRARY backs up the collection." },
  ]),
  TASKS: Object.freeze([
    { id: "selection", title: "Select several points", mode: "edit", steps: [
      "Open EDIT or ELEVATION → SELECT POINTS → RANGE.",
      "On either view, tap the first and last points or drag between them. On desktop, click then Shift-click also works.",
      "Both views highlight the same section. Check the point count; use point numbers or FOCUS for crowded points.",
      "Use LOWER / RAISE under HEIGHT to change every selected point by the shown metres, without leaving EDIT or RANGE. Switch to POINT to move the group on the map.",
      "SELECT ALL picks the loop; CLEAR resets selection.",
    ], note: "A range includes every point between its ends in driving order; an earlier end wraps over the start line. Separate Ctrl/Cmd-click selections are not supported." },
    { id: "height", title: "Raise, lower or smooth a section", mode: "elevation", steps: [
      "HEIGHT colours the road from low purple to high yellow; the legend shows metres above sea level. Toggle HEIGHT above the map to hide it.",
      "Select one point, or use RANGE for a section, on either view. Under HEIGHT, enter a change in metres and press LOWER or RAISE; the whole selection moves together, even in EDIT.",
      "Choose POINT, then drag a selected grip up or down on the elevation strip; the selected points move together.",
      "For precision, enter POINT m / SPAN m or choose a 0.25, 1 or 5 m step and use − / +.",
      "LEVEL makes the selection the same height, SMOOTH softens its slopes, and ZERO returns it to sea level; UNDO reverses the change.",
    ], note: "Raising a range preserves its hills within the height limits; points outside the selection stay unchanged." },
    { id: "scenery", title: "Preview a theme and place scenery", mode: "scenery", steps: [
      "Open SCENERY → THEMES and choose a look; LIVE SCENERY updates the overhead map automatically.",
      "Open ATMOSPHERE to change time of day, trees and crowd; use OUTLINE when you want a clear editing map.",
      "Open OBJECTS and search or filter NATURE, TERRAIN, WATER or RACE VENUE. Choose an object, then tap a map point or enter its number; for a section, enter the start and end points.",
      "Choose LEFT, RIGHT or BOTH, set the roadside gap, then PLACE; the map updates and UNDO removes the placement.",
    ], note: "Mountains, hills, dunes and rocks decorate the ground; use ELEVATION to change the road. Landscape objects that overlap the road are hidden. RACE or TIME TRIAL opens the full 3D circuit." },
    { id: "draw", title: "Start a new loop", mode: "draw", steps: [
      "Use RANDOMISE, TRACK OF THE DAY or START FROM… for a starting circuit, or draw one closed loop on the map.",
      "Open EDIT to reshape points and corners. UNDO restores the previous circuit if you replace an unsaved design.",
    ], note: "The map, elevation profile and undo history belong to the same working circuit across all modes." },
    { id: "test", title: "Check, save and test drive", mode: "test", steps: [
      "Use the footer CHECKS button to review validation. Fix red issues before saving or racing; FIX and FIX ALL offer repairs when available.",
      "Enter a name and country, then SAVE. RACE and TIME TRIAL open the full circuit; TEST HERE starts from a selected point.",
      "Open SHARE & FILES for a link, picture card, export or import. MY CIRCUITS contains the saved collection.",
    ], note: "Warnings are advice. Red checks block saving and racing; navigation and UNDO remain available." },
  ]),
  GESTURES: Object.freeze([
    { input: "Touch", text: "Tap a point to select · RANGE then tap or drag to an end point on either view for a SPAN · drag a selected point or span to move · tap the road to add / double-tap to delete · press and hold for DELETE / START HERE · pinch to zoom, drag empty space to pan · on the elevation strip, tap then drag vertically (≥44 px)." },
    { input: "Mouse", text: "Click a point to select · RANGE drag selects a section without moving it · POINT drag past a short threshold moves it (a SPAN moves as a group) · click the road to add one · double-click to delete · wheel to zoom, drag empty space to pan · shift-click a second point to select the span between them." },
    { input: "Keyboard", text: "Tab / [ ] cycle points · arrows nudge the selected point or SPAN 1 m (10 m with Shift) · Delete removes the anchor · Enter stamps · Esc deselects · Ctrl/⌘Z undo · Shift+Ctrl/⌘Z redo · on the elevation strip, Up/Down set height (whole SPAN when one is selected)." },
    { input: "Gamepad", text: "The d-pad and A work every button and chip. With a point or SPAN selected, the d-pad nudges it on the canvas; B lets go of the selection, and B again closes the designer." },
  ]),
  LIMITS: "2.5–7 km a lap · 8–200 points · 24 saved circuits · no online play on your own circuits yet.",
});
const COACH_KEY = "designerCoached";
const stampKind = (name: string): TrackStamps.StampKind | undefined => (TrackStamps.KINDS as { [k: string]: TrackStamps.StampKind | undefined })[name];

/** One TrackDesigner: f1-game's IIFE body (designer.js:12-2519) over `deps`. */
function createDesigner(deps: DesignerDeps) {
  const S = TrackShape;
  const Log = {
    info(ns: string, msg: string) { if (deps.log && deps.log.info) deps.log.info(ns, msg); },
    warn(ns: string, msg: string) { if (deps.log && deps.log.warn) deps.log.warn(ns, msg); },
    debug(ns: string, msg: string) { if (deps.log && deps.log.debug) deps.log.debug(ns, msg); },
  };
  const GameAudio = deps.audio || null;
  const trackList = (): readonly BuiltDef[] => (deps.trackList ? deps.trackList() : Tracks.LIST);

  let G: DesignerGame | null = deps.game || null, custom: CustomTracksApi | null = deps.custom || null, root: HTMLElement | null = null, built = false, openFlag = false, returnFocus: Element | null = null;
  let cv: ReturnType<typeof DesignerCanvas.create> | null = null, canvas: HTMLCanvasElement | null = null;
  const ui = {} as Ui;                 // named nodes, built once
  let lineage = 0;   // which loaded design a history entry belongs to (restore)
  let design: Design | null = null, verdict: PreviewVerdict | null = null, sel = -1, span = -1, tool = "select", mode = "edit";
  // spanArm: next pick sets the span end (touch-friendly stand-in for shift-tap).
  let spanArm = false, selectionMode = "point", selectionPanel: ReturnType<typeof DesignerSelection.create> | null = null, heightStep = 1;
  let params: Params = { L: 200, R: 60, deg: 90, dir: 1 };
  // propKind: the scenery-mode props palette selection (TrackDesignerProps.KINDS).
  let propKind: PropKind = "stand", scenery: ReturnType<typeof DesignerScenery.create> | null = null, sceneryView = false, repair: ReturnType<typeof DesignerFollowup.repairPanel> | null = null, bridges: ReturnType<typeof DesignerBridges.create> | null = null, workspace: ReturnType<typeof DesignerWorkspace.create> | null = null;
  const undo: string[] = [], redo: string[] = [];
  let replacementGeneration = 0, lifecycleWired = false;
  let libraryImportGeneration = 0, libraryImportPlan: CustomTracks.PreflightSummary | null = null;
  let previewT: Timer = 0, draftT: Timer = 0, confirmDel: string | null = null, msgT: Timer = 0;
  // savedSnap: the design as last loaded or saved — anything else is unsaved
  // work a load must not drop. nudge: the arrow-key run one undo entry covers.
  // checksSaid: the red/amber counts last announced through ui.msg.
  let savedSnap: string | null = null, nudge: { sel: number; span: number; kind: string | undefined; t: number } | null = null, checksSaid: string | null = null;
  // ctxAt: the point the canvas's press-and-hold row acts on (-1 = hidden).
  // randomisedOnOpen: this visit began on a fresh RANDOMISE (the coach card says so).
  let ctxAt = -1, randomisedOnOpen = false;
  // destroy(): the window / document listeners init() and build() added.
  const unlisten: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, fn: EventListener, capture?: boolean) => {
    target.addEventListener(type, fn, capture);
    unlisten.push(() => target.removeEventListener(type, fn, capture));
  };

  // ── helpers (designer.js:102) ─────────────────────────────────────────────
  const tick = () => { if (G && G.soundOn && GameAudio && GameAudio.uiTick) GameAudio.uiTick(); };
  const selectSnd = () => { if (G && G.soundOn && GameAudio && GameAudio.uiSelect) GameAudio.uiSelect(); };
  void selectSnd;   // f1-game defines it and never calls it
  const copy = <T>(d: T): T => JSON.parse(JSON.stringify(d)) as T;
  const lattice = (pts: readonly (readonly number[])[]): Pt[] => pts.map((p) => [Math.round(p[0]! * 4) / 4, Math.round(p[1]! * 4) / 4]);
  const fmtKm = (m: number) => (m / 1000).toFixed(2) + " km";
  const fmtLap = (s: number | undefined) => { if (!(s! > 0)) return "—"; const ds = Math.round(s! * 10), m = Math.floor(ds / 600), r = (ds - m * 600) / 10; return m + ":" + (r < 10 ? "0" : "") + r.toFixed(1); };   // round first: never "1:60.0"
  function blank(): Design {
    // kerbStyle / berms omitted at defaults (flat + berms on) so content ids match older saves.
    return { name: "MY CIRCUIT", seed: (Date.now() % 4294967296) >>> 0, theme: TrackThemes.ORDER[0]!, baseHW: 7, pts: [], heights: [], hwZones: [], bankZones: [], elevations: [], bridges: [], turns: [], lengthM: 0 };
  }
  const KERB_STYLES: readonly string[] = CustomTracks.KERB_STYLES || ["flat", "sausage", "rumble"];
  const hasSpan = () => !!design && sel >= 0 && span >= 0 && sel !== span && sel < design.pts.length && span < design.pts.length;
  function kerbOf(d: Design | null) {
    const v = d && d.kerbStyle;
    return KERB_STYLES.includes(v as string) ? v as string : "flat";
  }
  function bermsOn(d: Design | null) { return !(d && d.berms === false); }
  /** Parallel heights for the current pts (Flat when missing — old saves). designer.js:121 */
  function ensureHeights<D extends Design | null>(d: D): D {
    if (!d || !Array.isArray(d.pts)) return d;
    const src = d.heights;
    d.heights = ElevPresets.sanitize(d.pts, src);
    return d;
  }
  function flatHeights(pts: readonly unknown[]): number[] {
    return (Array.isArray(pts) ? pts : []).map(() => 0);
  }
  /** What a CANDIDATE loop is judged against: the look of the circuit (theme,
   *  width, seed, kerbs, berms), never the old loop's heights / elevations /
   *  bridges / zones — those belong to a road that is about to be replaced, and
   *  a hill on an unrelated loop is a grade RED (RANDOMISE failed 12/12 after any
   *  ELEVATION edit, and TRACK OF THE DAY gave a different circuit per player). designer.js:137 */
  function cleanBase(d: Design | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ["theme", "baseHW", "seed", "look", "kerbStyle", "berms"] as const) if (d && d[key] !== undefined) out[key] = d[key];
    return out;
  }
  /** A new loop on the same sheet (DRAW, RANDOMISE, USE, START FROM): the old
   *  loop's zones, bridges, authored props and turn marks are arc fractions of a
   *  road that is gone, so they would land at arbitrary places on this one. designer.js:145 */
  function freshLoop(d: Design, pts: Pt[], seed?: number): Design {
    const next: Design = Object.assign({}, d, { pts, heights: flatHeights(pts), hwZones: [], bankZones: [], elevations: [], bridges: [], turns: [], originId: undefined });
    if (seed !== undefined) next.seed = seed;
    delete next.props;
    return next;
  }
  function message(text: string, warn?: boolean) {
    if (!ui.msg) return;
    ui.msg.textContent = text || "";
    ui.msg.dataset.warn = warn ? "1" : "";
    clearTimeout(msgT);
    if (text) msgT = setTimeout(() => { if (ui.msg.textContent === text) ui.msg.textContent = ""; }, 6000);
  }
  /** The game's store (G.store, the GameStore façade) — null in a bare harness. designer.js:159 */
  const gstore = (): DesignerStore | null => (G && G.store) || deps.store || null;
  function coached() { const st = gstore(); try { return !!(st && st.get(COACH_KEY, false)); } catch (_) { return true; } }
  function setCoached() { const st = gstore(); try { if (st) st.set(COACH_KEY, true); } catch (e) { Log.warn("track", "designer: coach flag not stored: " + (e && (e as Error).message)); } }
  /** The active tool's one-line instruction (the stage hint, the rail copy, the status line on a change). designer.js:163 */
  function toolHint() {
    if (mode === "elevation") return "ELEVATION: POINT or RANGE on either view · drag height or enter metres · zoom for precise picks";
    if (mode === "scenery") return (sceneryView ? "LIVE SCENERY" : "OUTLINE") + ": theme → atmosphere → objects · HOW TO for help";
    if (mode === "test") return "TEST: fix red CHECKS, then RACE, TIME TRIAL, or TEST HERE from a selected point";
    if (mode === "draw" || tool === "draw") return "DRAW: draw one closed loop in a single stroke — it closes and smooths itself";
    const kind = stampKind(tool);
    return kind ? kind.label + ": tap a point to stamp it after that point (or REPLACE THE SELECTED SPAN when a group is selected)"
      : "EDIT: POINT selects one · RANGE selects a section on either view · switch to POINT to move the group · UNDO reverses edits";
  }
  function refreshMapView() {
    if (cv && design && cv.setScenery) cv.setScenery(design, sceneryView);
    for (const [b, on] of [[ui.outlineView, !sceneryView], [ui.sceneryView, sceneryView]] as const) if (b) {
      b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
    }
    if (ui.hint && design) ui.hint.textContent = toolHint();
  }
  /** "CORNER R 45 m × 90° LEFT" — what STAMP will lay down with the stepper values. designer.js:180 */
  function stampExample() {
    const kind = stampKind(tool); if (!kind) return "";
    const p = stampParams()!, bits = [kind.label];
    if (p.L != null) bits.push(p.L + " m");
    if (p.R != null) bits.push("R " + p.R + " m");
    if (p.deg != null) bits.push("× " + p.deg + "°");
    if (p.dir != null) bits.push(p.dir === -1 ? "RIGHT" : "LEFT");
    if (p.Ls! > 0) bits.push("· SPIRAL " + p.Ls + " m");
    return bits.join(" ");
  }
  function btn(label: string, cls: string, onClick: (ev: MouseEvent) => unknown): HTMLButtonElement {
    const b = el("button", cls, label); b.type = "button";
    b.addEventListener("click", (ev) => { tick(); onClick(ev); });
    return b;
  }

  // ── zones follow the loop (designer.js:196) ───────────────────────────────
  // Every zone list is keyed by ARC fraction of the control polygon (toRaw maps
  // hwZones to the engine's index fractions; the rest are read as arc
  // fractions of the built lap). bankZones are { frac, angleDeg, widthM },
  // elevations / bridges { s, … }, hwZones { s0, s1, … } — sanitize's shapes.
  const wrap01 = (v: number) => ((v % 1) + 1) % 1;
  function cumArc(pts: readonly (readonly number[])[]): number[] {
    const c = [0];
    for (let i = 0; i < pts.length; i++) { const a = pts[i]!, b = pts[(i + 1) % pts.length]!; c.push(c[i]! + Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!)); }
    return c;
  }
  /** Every zone list through one fraction map at(f, role) → f' | null (drop).
   *  A range asks for each end as a point first; an end that is dropped asks
   *  again as "s0"/"s1" (a clamp to the edit's edge); both ends gone drops it.
   *  flip swaps the ends (REVERSE). angleDeg is never touched: its SIGN is not
   *  the camber side (mesh.js reads that off curvature), a negative is adverse. designer.js:212 */
  function zoneMap(d: Design, at: FracMap, flip: boolean) {
    const pt = (key: string) => <Z extends object>(z: Z): Z | null => { const f = at((z as Record<string, number>)[key]!, "p"); return f == null ? null : Object.assign({}, z, { [key]: wrap01(f) }); };
    const range = <Z extends { s0: number; s1: number }>(z: Z): Z | null => {
      let a = at(z.s0, "p"), b = at(z.s1, "p");
      if (a == null && b == null) return null;
      if (a == null) a = at(z.s0, "s0");
      if (b == null) b = at(z.s1, "s1");
      if (a == null || b == null) return null;
      if (flip) { const t = a; a = b; b = t; }
      return Object.assign({}, z, { s0: wrap01(a), s1: wrap01(b) });
    };
    const each = <T, R>(list: readonly T[] | null | undefined, fn: (z: T) => R | null): R[] => (Array.isArray(list) ? list as T[] : []).map(fn).filter(Boolean) as R[];
    // Authored scenery props (slice H) are arc-fraction keyed like elevations —
    // reverse / START HERE / insert·delete·stamp must carry them or they strand.
    const out: { hwZones: HwZoneRec[]; bankZones: BankZoneRec[]; elevations: BumpRec[]; bridges: BumpRec[]; props?: DesignerProp[] } = {
      hwZones: each(d.hwZones, range),
      bankZones: each(d.bankZones, pt("frac")),
      elevations: each(d.elevations, pt("s")),
      bridges: each(d.bridges, pt("s")),
    };
    if (Array.isArray(d.props)) {
      out.props = each(d.props, pt("s"));
      // `side` is relative to the travel direction (+1 right): REVERSE turns the
      // road round, so the same bank is now the other side.
      if (flip) out.props = out.props.map((p) => Object.assign({}, p, { side: p.side < 0 ? 1 : -1 }));
    }
    return out;
  }
  /** Apply zoneMap and drop an emptied props list (absent, like look defaults). designer.js:241 */
  function withZones(d: Design, extra: Partial<Design> | null, at: FracMap, flip: boolean): Design {
    const zm = zoneMap(d, at, flip);
    const next: Design = Object.assign({}, d, extra || {}, zm);
    if (Array.isArray(zm.props) && !zm.props.length) delete next.props;
    return next;
  }
  /** After an insert / delete / stamp: a zone BEFORE the edited span keeps its
   *  arc distance from the start, one AFTER it its distance to the finish, one
   *  inside it is dropped (a range is clipped to the span's edge). Anchors are
   *  the control points both loops share — the unchanged head walked forward,
   *  the unchanged tail walked back (a stamp may thin the tail with RDP, so its
   *  survivors are a subsequence) — and a zone between two anchors keeps its
   *  share of that stretch. When the start point itself changed there is no
   *  anchor and the fractions stand — but heights are keyed by control-point
   *  identity (coordinates), not arc fraction, so they are remapped regardless. designer.js:256 */
  function remapZones(d: Design, oldPts: readonly Pt[], newPts: readonly Pt[]): Design {
    const N = oldPts.length, M = newPts.length;
    const same = (p: Pt, q: Pt) => p[0] === q[0] && p[1] === q[1];
    if (!N || !M) return d;
    if (!same(oldPts[0]!, newPts[0]!)) return Object.assign({}, d, { heights: remapHeights(d, oldPts, newPts) });
    const head: [number, number][] = [[0, 0]];
    let i = 1, j = 1;
    while (i < N && j < M && same(oldPts[i]!, newPts[j]!)) head.push([i++, j++]);
    if (i === N && j === M) return d;                    // nothing changed
    const tail: [number, number][] = [[N, M]];           // both loops close back onto point 0
    for (let jn = M - 1, io = N - 1; jn >= j; jn--) {
      let k = io;
      while (k >= i && !same(oldPts[k]!, newPts[jn]!)) k--;
      if (k < i) break;                                  // a new point: the edit ends here
      tail.unshift([k, jn]); io = k - 1;
    }
    const cO = cumArc(oldPts), cP = cumArc(newPts), LO = cO[N]!, LP = cP[M]!;
    if (!(LO > 0 && LP > 0)) return d;
    const A = head.concat(tail).map(([o, n]): [number, number] => [cO[o]!, cP[n]!]), gap = head.length - 1, eps = 1e-9 * LO;
    const at: FracMap = (f, role) => {
      const x = wrap01(f) * LO;
      let k = 0;
      while (k < A.length - 2 && x > A[k + 1]![0]) k++;
      if (k === gap && x > A[k]![0] + eps && x < A[k + 1]![0] - eps) return role === "s0" ? A[k + 1]![1] / LP : role === "s1" ? A[k]![1] / LP : null;
      const span = A[k + 1]![0] - A[k]![0];
      return (A[k]![1] + (span > 0 ? (x - A[k]![0]) / span : 0) * (A[k + 1]![1] - A[k]![1])) / LP;
    };
    return withZones(d, { heights: remapHeights(d, oldPts, newPts) }, at, false);
  }
  /** Keep per-node heights on shared control points; a new point takes the
   *  arc-weighted blend of the nearest kept heights either side (0 m would carve
   *  a notch when it is inserted mid-hill). designer.js:288 */
  function remapHeights(d: Design, oldPts: readonly Pt[], newPts: readonly Pt[]): number[] {
    const oldH = Array.isArray(d.heights) ? d.heights : [];
    const idx = new Map<string, number>();
    for (let i = 0; i < oldPts.length; i++) idx.set(oldPts[i]![0] + "," + oldPts[i]![1], i);
    const M = newPts.length, known: (number | null)[] = new Array(M);
    for (let j = 0; j < M; j++) {
      const k = idx.get(newPts[j]![0] + "," + newPts[j]![1]);
      known[j] = k != null && k < oldH.length && Number.isFinite(+oldH[k]!) ? +oldH[k]! : null;
    }
    const c = cumArc(newPts), L = c[M]!;
    const next = known.map((v, j) => {
      if (v != null || !known.some((u) => u != null)) return v != null ? v : 0;
      let a = j, b = j;
      while (known[a] == null) a = (a - 1 + M) % M;
      while (known[b] == null) b = (b + 1) % M;
      const back = (c[j]! - c[a]! + L) % L, fwd = (c[b]! - c[j]! + L) % L;
      return back + fwd > 0 ? known[a]! + (known[b]! - known[a]!) * back / (back + fwd) : known[a]!;
    });
    return ElevPresets.sanitize(newPts, next);
  }

  // ── state transitions (designer.js:309) ───────────────────────────────────
  function snapshot() { return JSON.stringify(design); }
  function pushUndo(snap: string) { undo.push(snap); if (undo.length > UNDO_CAP) undo.shift(); redo.length = 0; }
  const REMAP = /^(insert|delete|stamp:)/;
  /** Replace the design (geometry edits go through here so UNDO sees them). A
   *  run of arrow nudges on one point (or one span) inside NUDGE_MS is ONE entry. designer.js:315 */
  function commit(next: Design, kind?: string) {
    ++replacementGeneration;
    const now = Date.now();
    const nudgeKind = kind === "nudge" || kind === "nudge-span";
    const sameNudge = nudge && nudge.sel === sel && nudge.span === span && nudge.kind === kind && now - nudge.t < NUDGE_MS && undo.length;
    if (nudgeKind && sameNudge) redo.length = 0;
    else pushUndo(snapshot());
    nudge = nudgeKind ? { sel, span, kind, t: now } : null;
    next.pts = lattice(next.pts);
    if (REMAP.test(kind || "") && design && design.pts) next = remapZones(next, design.pts, next.pts);
    ensureHeights(next);
    design = next;
    afterChange(kind);
    // First real edit dismisses the coach so SHAPE / mode chips stay usable.
    if (ui.coach && kind && kind !== "blank" && kind !== "undo" && kind !== "redo") dismissCoach(false);
  }
  function afterChange(kind?: string) {
    if (sel >= design!.pts.length) sel = -1;
    if (span >= design!.pts.length) span = -1;
    if (ctxAt >= 0) hideCtx();                         // its point index may name another point now
    if (cv) { cv.setPoints(design!.pts); cv.setSelection(sel, span); }
    schedulePreview();
    scheduleDraft();
    refreshControls();
    Log.debug("track", "designer edit: " + (kind || "change") + " (" + design!.pts.length + " pts)");
  }
  function schedulePreview() { clearTimeout(previewT); previewT = setTimeout(runPreview, PREVIEW_MS); }
  /** designer.js:342 */
  function runPreview(): PreviewVerdict | null {
    clearTimeout(previewT); previewT = 0;
    if (!design) return null;
    verdict = design.pts.length ? TrackValidate.check(design) : { ok: false, red: 1, amber: 0, issues: [{ code: "points", level: "red", msg: "Draw a loop, stamp one, or press RANDOMISE" }], stats: null, tr: null, turns: [] };
    // A design the registry refuses outright (a loop under 1 km, a point out
    // of range) builds nothing and may name no red: never show "All checks pass".
    if (!verdict.ok && !verdict.red) verdict = Object.assign({}, verdict, { red: 1, issues: verdict.issues.concat([{ code: "bounds", level: "red", msg: "This loop cannot be built — make it bigger (2.5–7 km) and keep its points in range" }]) });
    if (cv) { cv.setBuilt(verdict.tr); cv.setIssues(verdict.issues as unknown as readonly DesignerCanvas.CanvasIssue[]); }
    refreshMapView();
    renderIssues(); renderStats(); announceChecks();
    if (workspace) workspace.review(verdict);
    renderInsight();
    renderProfile();
    const blocked = !verdict.ok;
    for (const b of [ui.save, ui.race, ui.tt]) if (b) { b.disabled = blocked; b.setAttribute("aria-disabled", blocked ? "true" : "false"); }
    return verdict;
  }
  function scheduleDraft() { ++replacementGeneration; clearTimeout(draftT); draftT = setTimeout(saveDraft, DRAFT_MS); }
  function saveDraft() { clearTimeout(draftT); draftT = 0; if (design && custom && design.pts.length) custom.setDraft(design); }
  /** The CHECKS list is not a live region (it is rebuilt every preview); the
   *  status line says only when the red / amber counts change. designer.js:363 */
  function announceChecks() {
    if (!verdict || !openFlag || !ui.msg) return;
    const key = verdict.red + "/" + verdict.amber;
    if (key === checksSaid) return;
    const first = checksSaid == null;
    checksSaid = key;
    if (first) return;
    const n = (k: number, w: string) => k + " " + w + (k === 1 ? "" : "s");
    const said = verdict.red ? n(verdict.red, "red issue") + (verdict.amber ? ", " + n(verdict.amber, "warning") : "") : verdict.amber ? n(verdict.amber, "warning") : "all checks pass";
    const base = String(ui.msg.textContent || "").split(" · CHECKS: ")[0];
    message((base ? base + " · " : "") + "CHECKS: " + said, base ? ui.msg.dataset.warn === "1" : verdict.red > 0);
  }

  // ── edits (designer.js:376) ───────────────────────────────────────────────
  function stampParams(): Params | null {
    const k = stampKind(tool); if (!k) return null;
    const out: Params = {};
    for (const key of Object.keys(k.params)) out[key] = params[key] != null ? params[key] : (k.params as Params)[key];
    return out;
  }
  /** Stamp the active tool after control i0, or over the span (i0 … i1). designer.js:384 */
  function applyStamp(i0: number, i1?: number | null, kind?: string) {
    const k = kind || tool;
    if (!stampKind(k)) { message("Pick a shape tool first (STRAIGHT, CORNER, HAIRPIN, CHICANE, S-BEND)", true); return false; }
    if (!design!.pts.length || design!.pts.length < 3) {
      // A first stamp on an empty sheet: a loop from the shape itself, closed by the splice.
      const seed = TrackRandom.generate(design!.seed, { targetL: 3800 }).pts;
      commit(Object.assign({}, design!, { pts: seed }), "seed");
      i0 = 0; i1 = 0;
    }
    if (!(i0 >= 0)) i0 = Math.max(0, sel);
    const p = kind ? Object.assign({}, stampKind(k)!.params, params) : stampParams();
    const r = TrackStamps.splice(design!.pts, i0, i1 == null ? i0 : i1, k, p);
    if (!r.ok) { message(r.reason, true); return false; }
    sel = r.sel[1]; span = -1;
    commit(Object.assign({}, design!, { pts: r.pts }), "stamp:" + k);
    message(stampKind(k)!.label + " stamped" + (r.word ? " (rejoin " + r.word + ")" : ""));
    return true;
  }
  /** A freehand pointer path (world metres) → a closed, spaced, start-rotated loop. designer.js:403 */
  function freehand(path: readonly (readonly number[])[] | null | undefined) {
    if (!path || path.length < 3) return false;
    let p = S.rdp(path, 3);
    p = S.resample(p, 30, false);
    if (p.length < 3) { message("Draw a bigger loop", true); return false; }
    const a = p[0]!, z = p[p.length - 1]!, gap = Math.hypot(z[0]! - a[0]!, z[1]! - a[1]!);
    if (gap < 60) { if (gap < 12) p.pop(); }
    else {
      // Close the loop with the gentlest Dubins fill from the pen-up pose to the pen-down pose.
      const h = (pts: readonly (readonly number[])[], i: number, j: number) => Math.atan2(pts[j]![0]! - pts[i]![0]!, pts[j]![1]! - pts[i]![1]!);
      const q0 = { x: z[0]!, z: z[1]!, th: h(p, p.length - 2, p.length - 1) }, q1 = { x: a[0]!, z: a[1]!, th: h(p, 0, 1) };
      let fill: ReturnType<typeof S.dubins> = null;
      for (const r of [80, 50, 30, 20]) { const d = S.dubins(q0, q1, r, 25); if (d && d.len < gap * 4 + 2 * Math.PI * r) { fill = d; break; } }
      if (fill) p = p.concat(fill.pts.slice(0, -1));
    }
    for (let i = 0; i < 20; i++) if (!TrackRandom.fixAngles(p as Pt[], 100)) break;
    p = S.enforceSpacing(p, TrackStamps.SPACING);
    if (p.length < CustomTracks.LIMITS.ptsMin) { message("Draw a bigger loop — at least " + CustomTracks.LIMITS.ptsMin + " points", true); return false; }
    if (p.length > CustomTracks.LIMITS.ptsMax) p = S.rdp(p, 2);
    p = startOnLongestStraight(p as Pt[]);
    sel = -1; span = -1;
    commit(freshLoop(design!, p as Pt[]), "draw");   // a new circuit: SAVE adds, never replaces
    message("Loop drawn — drag the points to tune it");
    return true;
  }
  function startOnLongestStraight(p: Pt[]): Pt[] {
    try {
      const ls = TrackRandom.longestStraight(p);
      if (!ls || !ls.dense || !ls.dense.length) return p;
      const along = Math.min(Math.max(ls.lenM * 0.6, 240), Math.max(ls.lenM - 140, 0));
      const d = ls.dense[(ls.start + Math.round(along / 4)) % ls.dense.length]!;
      return S.rotate(p, S.project(p, d[0], d[1]).i);
    } catch (_) { return p; }
  }
  /** designer.js:437 */
  function randomise(seed?: number) {
    const s = Number.isFinite(seed) ? (seed! >>> 0) : ((Math.imul(design!.seed ^ (design!.seed >>> 16), 0x45d9f3b) + 0x9e3779b9) >>> 0);
    const base = cleanBase(design);
    const r = TrackRandom.generateValid(s, (pts) => TrackValidate.check(Object.assign({}, base, { pts })).ok, 12);
    sel = -1; span = -1;
    commit(freshLoop(design!, r.pts, r.seed), "randomise");   // a new circuit, as DRAW
    if (cv) cv.fit();
    message(r.ok ? "Randomised — seed " + r.seed : "No clean loop in 12 tries — RANDOMISE again or tune the points", !r.ok);
    return !!r.ok;
  }
  /** designer.js:447 */
  function reverse() {
    const pts = design!.pts;
    if (pts.length < 3) return false;
    // The start point stays; every arc fraction f is 1 − f on the reversed loop.
    const hs = Array.isArray(design!.heights) ? design!.heights : flatHeights(pts);
    const next = withZones(design!, {
      pts: [pts[0]!].concat(pts.slice(1).reverse()),
      heights: [hs[0] || 0].concat(hs.slice(1).reverse()),
    }, (f) => 1 - f, true);
    commit(next, "reverse");
    message("Direction reversed");
    return true;
  }
  /** designer.js:460 */
  function setStart(i: number) {
    const pts = design!.pts, N = pts.length;
    if (!(i > 0 && i < N)) { message("Select a point that is not already the start", true); return false; }
    let L = 0, upto = 0;
    for (let k = 0; k < N; k++) { const a = pts[k]!, b = pts[(k + 1) % N]!; const d = Math.hypot(b[0] - a[0], b[1] - a[1]); if (k < i) upto += d; L += d; }
    const f = L ? upto / L : 0;
    const hs = Array.isArray(design!.heights) ? design!.heights.slice() : flatHeights(pts);
    const next = withZones(design!, {
      pts: S.rotate(pts, i),
      heights: hs.length === pts.length ? hs.slice(i).concat(hs.slice(0, i)) : flatHeights(pts),
    }, (v) => v - f, false);
    sel = 0; span = -1;
    commit(next, "start");
    message("Start line moved");
    return true;
  }
  /** designer.js:476 */
  function deletePoint(i: number) {
    const pts = design!.pts;
    if (!(i >= 0 && i < pts.length)) return false;
    if (pts.length <= CustomTracks.LIMITS.ptsMin) { message("A loop needs at least " + CustomTracks.LIMITS.ptsMin + " points", true); return false; }
    const next = pts.slice(); next.splice(i, 1);
    sel = -1; span = -1;
    commit(Object.assign({}, design!, { pts: next }), "delete");
    return true;
  }
  /** Cycle the selected control point (PREV / NEXT POINT, Tab / [ ]). designer.js:486 */
  function cyclePoint(dir: number) {
    if (!design || !design.pts || !design.pts.length) return false;
    const N = design.pts.length;
    const d = dir < 0 ? -1 : 1;
    sel = sel < 0 ? (d > 0 ? 0 : N - 1) : (sel + d + N) % N;
    span = -1; spanArm = false;
    if (cv) cv.setSelection(sel, span);
    if (prof && mode === "elevation") {
      if (prof.setSelection) prof.setSelection(sel, span);
      else prof.select(sel);
    }
    refreshControls();
    return true;
  }
  /** designer.js:500 */
  function selectRange(i: number, j?: number) {
    if (!design || !Number.isInteger(i)) return false;
    const n = design.pts.length;
    sel = i < 0 ? -1 : Math.min(i, n - 1);
    const end = Number.isInteger(j) && j! >= 0 ? Math.min(j!, n - 1) : -1;
    span = sel >= 0 && end !== sel ? end : -1;
    spanArm = false;
    if (cv) cv.setSelection(sel, span);
    refreshControls();
    return true;
  }
  /** designer.js:511 */
  function setSelectionMode(value: string) {
    selectionMode = value === "range" ? "range" : "point";
    spanArm = false;
    if (tool !== "select") setTool("select");
    if (cv) cv.setSelection(sel, span);
    refreshControls();
    return selectionMode;
  }
  function focusSelection() {
    if (!design || sel < 0) return false;
    const c = cumArc(design.pts), f = c[sel]! / (c[design.pts.length] || 1);
    if (cv && verdict && verdict.tr) cv.focusAt(f * verdict.tr.total);
    if (prof && prof.zoom) prof.zoom(4);
    return true;
  }
  /** designer.js:526 */
  function profileView(action: string) {
    if (!prof) return false;
    if (action === "fit") prof.fit();
    else if (action === "left" || action === "right") prof.pan(action === "left" ? -0.4 : 0.4);
    else prof.zoom(action === "in" ? 2 : 0.5);
    return true;
  }
  function shiftSelectedHeight(direction: number) {
    if (!design || sel < 0) return false;
    ensureHeights(design);
    const ids = S.spanIndices(sel, span, design.pts.length), limit = CustomTracks.LIMITS.rise;
    const values = ids.map(i => design!.heights[i] || 0);
    // Stop the whole selection at the limit; do not squash its relative hills.
    const delta = Math.max(-limit - Math.min(...values), Math.min(limit - Math.max(...values), direction * heightStep));
    if (!delta) { message("Selected points have reached the height limit", true); return false; }
    const next = design.heights.slice();
    for (const i of ids) next[i] = elevH(next[i]! + delta);
    const changed = setHeights(next, sel);
    if (changed) {
      toggleElevationHeat(true);
      message((delta > 0 ? "Raised " : "Lowered ") + ids.length + (ids.length === 1 ? " point" : " points") + " by " + Math.abs(delta) + " m · UNDO to revert");
    }
    return changed;
  }
  function revealSelectionHeight() {
    if (ui.rail && sel >= 0 && (mode === "edit" || mode === "elevation")) ui.rail.scrollTop = 0;
  }
  /** designer.js:553 */
  function adjustElevation(action: string) {
    if (!design || sel < 0 || !["level", "smooth", "zero"].includes(action)) return false;
    const src = design.heights, next = src.slice(), n = src.length, group = TrackShape.spanIndices(sel, span, n);
    for (const [k, i] of group.entries()) {
      if (action === "smooth" && group.length > 1 && group.length < n && (k === 0 || k === group.length - 1)) continue;
      next[i] = elevH(action === "zero" ? 0 : action === "level" ? src[sel] : (src[(i - 1 + n) % n]! + 2 * src[i]! + src[(i + 1) % n]!) / 4);
    }
    return setHeights(next, sel);
  }
  /** Arm the next tap as the span end (touch-friendly group select). designer.js:563 */
  function armSpanEnd() {
    if (!design || sel < 0) { message("Select a start point first, then SELECT END", true); return false; }
    selectionMode = "point";
    spanArm = !spanArm;
    if (spanArm) message("Tap the end point for the SPAN (group move · elevate · replace)");
    refreshControls();
    return spanArm;
  }
  /** Restore a history entry. Name and library link (id / originId) are not
   *  undoable edits — setName and SAVE write them outside commit() — so inside
   *  one loaded design they stay as they are; an entry from ANOTHER design (the
   *  stash load() keeps) brings its own back (`lin` marks which design it was). designer.js:575 */
  function restore(snap: string) {
    const was = design, next = ensureHeights(JSON.parse(snap) as Design);
    if (was && next.lin === was.lin) {
      next.name = was.name;
      for (const k of ["id", "originId"] as const) { if (was[k] === undefined) delete next[k]; else next[k] = was[k]; }
    }
    design = next; sel = -1; span = -1; nudge = null;
  }
  /** designer.js:583 */
  function doUndo() { if (!undo.length) return false; redo.push(snapshot()); restore(undo.pop()!); afterChange("undo"); return true; }
  /** designer.js:584 */
  function doRedo() { if (!redo.length) return false; undo.push(snapshot()); restore(redo.pop()!); afterChange("redo"); return true; }
  /** designer.js:585 */
  function setTheme(id: string) {
    if (!TrackThemes.has(id) || id === design!.theme) return false;
    commit(Object.assign({}, design!, { theme: id }), "theme");
    return true;
  }
  /** A scenery option (TrackThemes.LOOK): one UNDO entry; all at default stores none. designer.js:591 */
  function setLook(key: string, v: string) {
    const LOOK = TrackThemes.LOOK as { readonly [k: string]: readonly string[] | undefined };
    if (!LOOK[key] || !LOOK[key].includes(v)) return false;
    const cur = TrackThemes.lookOf(design) as unknown as Record<string, string>;
    if (cur[key] === v) return false;
    const look = TrackThemes.sanitizeLook(Object.assign({}, cur, { [key]: v }));
    const next = Object.assign({}, design!);
    if (look) next.look = look; else delete next.look;
    commit(next, "look");
    return true;
  }
  /** Apply a complete atmosphere as one undoable edit, using the existing look schema. designer.js:602 */
  function setAtmosphere(id: string) {
    const preset = (DesignerScenery.PRESETS as { readonly [k: string]: unknown })[id];
    if (!preset || !design) return false;
    const look = TrackThemes.sanitizeLook(preset);
    if (JSON.stringify(look) === JSON.stringify(TrackThemes.sanitizeLook(design.look))) return false;
    const next = Object.assign({}, design);
    if (look) next.look = look; else delete next.look;
    commit(next, "atmosphere");
    return true;
  }
  /** Scenery props palette: select which kind PLACE AT POINT will add. designer.js:613 */
  function setPropKind(kind: string) {
    if (!TrackDesignerProps.has(kind)) return false;
    if (propKind === kind) return false;
    propKind = kind;
    refreshControls();
    return true;
  }
  /** Place the selected prop kind at the selected control point (or start). designer.js:621 */
  function placeProp(kind?: string) {
    if (!design || !design.pts.length) return false;
    const k = kind || propKind;
    if (!TrackDesignerProps.has(k)) return false;
    const i = sel >= 0 ? sel : 0;
    const opts: { side?: number; count?: number; gap?: unknown; mode?: string } = scenery ? scenery.placement(k) : { side: 1, count: 1 };
    if (opts.mode === "range" && (sel < 0 || span < 0 || sel === span)) { message("Select a start and end point for the scenery section", true); return false; }
    const start = TrackDesignerProps.pointFrac(design.pts, i), end = span >= 0 ? TrackDesignerProps.pointFrac(design.pts, span) : null;
    const next = TrackDesignerProps.placeBatch(design.props, k, Object.assign({ start, end }, opts) as TrackDesignerProps.PlaceBatchOpts);
    if (!next) { message("Placement exceeds the object limit — reduce positions or choose one side", true); return false; }
    const added = next.length - (design.props || []).length;
    const d = Object.assign({}, design);
    if (next.length) d.props = next; else delete d.props;
    commit(d, "prop");
    message("Placed " + added + " " + (TrackDesignerProps.LABELS[k] || k) + (opts.mode === "range" ? " along the selected section" : " at point " + (i + 1)));
    return true;
  }
  /** Remove only the chosen kind; never silently remove a different object. designer.js:639 */
  function removeProp(kind?: string) {
    if (!design) return false;
    const list = design.props;
    if (!list || !list.length) { message("No props to remove", true); return false; }
    const k = kind || propKind;
    const next = TrackDesignerProps.removeLast(list, k);
    if (next.length === list.length) return false;
    const d = Object.assign({}, design);
    if (next.length) d.props = next; else delete d.props;
    commit(d, "prop");
    return true;
  }
  /** designer.js:651 */
  function removePropAt(i: number) {
    if (!design || !design.props || !Number.isInteger(i) || i < 0 || i >= design.props.length) return false;
    const next = Object.assign({}, design), props = TrackDesignerProps.removeAt(design.props, i);
    if (props.length) next.props = props; else delete next.props;
    commit(next, "prop");
    return true;
  }
  /** designer.js:658 */
  function editPropAt(i: number, patch: TrackDesignerProps.PropPatch | null | undefined) {
    if (!design) return false;
    const props = TrackDesignerProps.updateAt(design.props, i, patch);
    if (!props) return false;
    commit(Object.assign({}, design, { props }), "prop"); return true;
  }
  /** designer.js:664 */
  function copyPropAt(i: number) {
    const p = design && design.props && design.props[i]; if (!p || sel < 0 || sel >= design!.pts.length) return false;
    const props = TrackDesignerProps.place(design!.props, p.kind, Object.assign({}, p, { s: TrackDesignerProps.pointFrac(design!.pts, sel) }));
    if (!props) { message("Object limit reached", true); return false; }
    commit(Object.assign({}, design!, { props }), "prop"); return true;
  }
  /** designer.js:670 */
  function setWidth(hw: number) {
    hw = Math.round(Math.min(CustomTracks.LIMITS.hwMax, Math.max(CustomTracks.LIMITS.hwMin, hw)) * 10) / 10;
    if (hw === design!.baseHW) return false;
    commit(Object.assign({}, design!, { baseHW: hw }), "width");
    return true;
  }
  /** designer.js:676 */
  function setName(s: unknown) { ++replacementGeneration; design!.name = CustomTracks.sanitizeName(s); scheduleDraft(); if (ui.name && ui.name.value !== design!.name && document.activeElement !== ui.name) ui.name.value = design!.name; }
  /** The ghost a stamp would lay down from control i, in world metres from
   *  that point's pose (the canvas draws it under the pointer). designer.js:679 */
  function ghost(i: number): { pts: Pt[] } | null {
    if (!design || !stampKind(tool) || !(i >= 0 && i < design.pts.length) || design.pts.length < 3) return null;
    const a = design.pts[i]!;
    const st = TrackStamps.sample(tool, stampParams(), { x: a[0], z: a[1], th: S.heading(design.pts, i) });
    return st && st.pts.length ? { pts: ([[a[0], a[1]]] as Pt[]).concat(st.pts) } : null;
  }
  /** cv.setTool(name, previewFn): a canvas without the ghost ignores the second argument. designer.js:686 */
  function canvasTool() {
    if (!cv) return;
    if (mode === "draw") { cv.setTool("draw"); return; }
    // Scenery / elevation / test: pick a point only — no road-insert, drag or
    // double-tap delete (PLACE AT POINT / strip / CHECKS own the edits).
    if (mode === "elevation" || mode === "scenery" || mode === "test") {
      cv.setTool("select", null, { pickOnly: true });
      return;
    }
    if (stampKind(tool)) cv.setTool(tool, ghost); else cv.setTool(tool);
  }
  /** designer.js:697 */
  function setTool(name: string) {
    if (workspace) workspace.remember();
    const was = tool;
    tool = TOOLS.some((t) => t[0] === name) ? name : "select";
    if (tool !== "select") selectionMode = "point";
    // Stamp / draw chips also switch mode so the rail stays coherent.
    if (tool === "draw" && mode !== "draw") mode = "draw";
    else if (tool !== "draw" && (mode === "draw" || mode === "elevation" || mode === "scenery" || mode === "test")) mode = "edit";
    canvasTool();
    refreshControls();
    if (ui.coach) dismissCoach(false);
    if (tool !== was && built && design) message(toolHint());
  }
  /** designer.js:710 */
  function setMode(name: string) {
    if (workspace) workspace.remember();
    const next = MODES.some((m) => m[0] === name) ? name : "edit";
    if (next === "scenery") sceneryView = true;
    if (next === mode) { refreshControls(); return mode; }
    hideCtx();
    mode = next;
    if (mode === "elevation") toggleElevationHeat(true);
    if (mode === "draw") tool = "draw";
    else if (mode === "edit" && tool === "draw") tool = "select";
    else if (mode !== "edit" && mode !== "draw") tool = "select";
    canvasTool();
    refreshControls();
    if (ui.coach) dismissCoach(false);
    if (built && design) message(toolHint());
    return mode;
  }
  /** Unsaved work about to be replaced → one UNDO away, and kept under
   *  a26.customTrackDraftPrev so the new design's autosave cannot clobber
   *  it. True when something was kept. designer.js:730 */
  function stash() {
    if (!design || !design.pts || !design.pts.length) return false;
    const snap = snapshot();
    if (snap === savedSnap) return false;
    pushUndo(snap);
    if (custom && custom.setDraftPrev) custom.setDraftPrev(JSON.parse(snap));
    return true;
  }
  /** Replace the design. `origin`: the MY CIRCUITS id it was opened from, which
   *  SAVE replaces instead of adding a copy per geometry change (it rides the
   *  design as `originId`; sanitize drops it, so it never reaches the id). designer.js:741 */
  function load(item: object, label?: string, origin?: string | null) {
    ++replacementGeneration;
    const kept = stash();
    if (!kept) { undo.length = 0; redo.length = 0; }
    design = copy(item) as Design;
    design.lin = ++lineage;
    for (const k of ["hwZones", "bankZones", "elevations", "bridges", "turns"] as const) if (!Array.isArray(design[k])) design[k] = [];
    ensureHeights(design);   // old saves without heights → flat zeros
    if (origin) design.originId = origin; else delete design.originId;
    sel = -1; span = -1; nudge = null;
    afterChange(label || "load");
    savedSnap = snapshot();
    if (cv) cv.fit();
    return kept;
  }
  const keptNote = (kept: boolean) => (kept ? " · UNDO brings back the design you had" : "");
  /** The autosaved draft, sanitized loosely (a work in progress may be red). designer.js:758 */
  function draftItem(previous?: boolean): (CustomTracks.CustomDesign & { originId?: string }) | null {
    const d = (previous ? (custom!.draftPrev && custom!.draftPrev()) : custom!.draft()) as { originId?: unknown } | null;
    const it: (CustomTracks.CustomDesign & { originId?: string }) | null = d && custom!.sanitize(d, { loose: true });
    if (!it || !it.pts.length) return null;
    if (typeof d!.originId === "string") it.originId = d!.originId;
    return it;
  }

  /** designer.js:766 */
  function recoverDraft() {
    const previous = draftItem(true);
    if (!previous) { renderLibrary(); return false; }
    // Recovery always keeps the current draft, including name-only edits.
    savedSnap = null;
    const kept = load(previous, "recover", previous.originId);
    savedSnap = null;
    saveDraft();
    showPane("design");
    message("Previous draft recovered" + keptNote(kept));
    return true;
  }

  // ── save / race (designer.js:779) ─────────────────────────────────────────
  /** designer.js:780 */
  function save(forRace?: boolean) {
    if (previewT || !verdict) runPreview();
    if (!verdict || !verdict.ok) { setMode("test"); message("Fix the red issues before " + (forRace ? "racing" : "saving"), true); return { ok: false as const, reason: "red" }; }
    design!.turns = verdict.turns.slice();
    design!.lengthM = Math.round(verdict.tr!.total);
    design!.name = CustomTracks.sanitizeName(ui.name ? ui.name.value : design!.name);
    const r = custom!.upsert(design, { replace: design!.originId } as { replace?: string | null });
    if (!r.ok) {
      // A race runs a SAVED circuit, so a full library blocks racing a new design too.
      message(r.reason === "full" ? "MY CIRCUITS is full (" + (r as { limit?: number }).limit + " circuits) — delete one in MY CIRCUITS to " + (forRace ? "race" : "save") + " this design" : "Could not save this design", true);
      Log.warn("track", "designer save refused: " + r.reason);
      return r;
    }
    design!.id = r.id; design!.originId = r.id;
    // The draft may already be on disk: a reload must edit this saved id,
    // rather than add a duplicate through the old, now-replaced library link.
    saveDraft();
    savedSnap = snapshot();
    message(r.durable ? "Saved to MY CIRCUITS" : "Saved — but storage is full, so it may not survive a reload", !r.durable);
    Log.info("track", "designer saved " + r.id + " (" + design!.name + ", " + design!.lengthM + " m)");
    renderLibrary();
    return r;
  }
  /** designer.js:803 */
  function race(mode: string) {
    const r = save(true);
    if (!r.ok) return false;
    return raceId(r.id, mode);
  }
  function raceId(id: string, mode: string) {
    const idx = custom!.select(id);
    if (idx < 0) { message("That circuit is not in the list any more", true); return false; }
    G!.trackIdx = idx;
    close();
    // Two literal lookups, not one computed id: the shell-id guard reads them.
    const door = mode === "tt" ? deps.onTimeTrial : deps.onRace;
    if (door) door();
    Log.info("track", "designer → " + (mode === "tt" ? "time trial" : "race") + " on " + id);
    return true;
  }

  // ── DOM (designer.js:820) ─────────────────────────────────────────────────
  /** designer.js:821 */
  function build() {
    if (built || !root) return;
    built = true;
    const closeBtn = root.querySelector<HTMLButtonElement>("#td-close") || document.getElementById("td-close");
    if (closeBtn) { closeBtn.hidden = false; closeBtn.addEventListener("click", close); }

    const body = el("div", "td-body");
    // stage
    const stage = el("div", "td-stage");
    canvas = el("canvas");
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Circuit design. POINT selects one point; RANGE selects a section on this map or the elevation strip. Switch to POINT to move the selected group. OUTLINE and LIVE SCENERY change the view. Arrow keys nudge the selection.");
    ui.stats = el("div", "td-stats");
    ui.hint = el("div", "td-hint", "Tap to select · SELECT END / shift-tap a SPAN · drag moves the group · tap the road to add one");
    // The canvas's press-and-hold row (hooks.onContext): absolute over the
    // stage at the press, acting on one point; any new press on the canvas hides it.
    ui.ctx = el("div", "td-chips td-ctx"); ui.ctx.hidden = true; ui.ctx.setAttribute("role", "group");
    ui.ctxDel = btn("DELETE", "sel-chip", () => { const i = ctxAt; hideCtx(); deletePoint(i); });
    ui.ctxStart = btn("START HERE", "sel-chip", () => { const i = ctxAt; hideCtx(); setStart(i); });
    ui.ctxClose = btn("CLOSE", "sel-chip", () => hideCtx());
    ui.ctx.append(ui.ctxDel, ui.ctxStart, ui.ctxClose);
    ui.ctxTest = btn("TEST HERE", "sel-chip", () => { const i = ctxAt; hideCtx(); testHere(i); });
    ui.ctx.appendChild(ui.ctxTest);
    canvas.addEventListener("pointerdown", () => hideCtx());
    stage.append(canvas, ui.stats, ui.hint, ui.ctx);
    // Canvas toolbar: UNDO / REDO always visible (not buried under DETAILS).
    ui.toolbar = el("div", "td-chips");
    ui.toolbar.setAttribute("data-role", "toolbar");
    ui.toolbar.setAttribute("role", "toolbar");
    ui.toolbar.setAttribute("aria-label", "Edit history and map view");
    ui.undo = btn("UNDO", "sel-chip", () => doUndo());
    ui.redo = btn("REDO", "sel-chip", () => doRedo());
    ui.undo.setAttribute("aria-keyshortcuts", "Control+Z Meta+Z");
    ui.redo.setAttribute("aria-keyshortcuts", "Control+Shift+Z Meta+Shift+Z");
    ui.fitBtn = btn("FIT VIEW", "sel-chip", () => cv && cv.fit());
    ui.toolbar.append(ui.undo, ui.redo, ui.fitBtn);
    ui.outlineView = btn("OUTLINE", "sel-chip", () => { sceneryView = false; refreshMapView(); });
    ui.sceneryView = btn("LIVE SCENERY", "sel-chip", () => { sceneryView = true; refreshMapView(); });
    ui.outlineView.dataset.mapView = "outline"; ui.sceneryView.dataset.mapView = "scenery";
    ui.heightHeat = btn("HEIGHT", "sel-chip", () => toggleElevationHeat());
    ui.heightHeat.setAttribute("aria-label", "Elevation heat map");
    ui.heightHeat.setAttribute("aria-pressed", String(heightHeatOn));
    ui.heightHeat.title = "Colour road height: low purple → high yellow; legend in metres above sea level";
    ui.toolbar.append(ui.outlineView, ui.sceneryView, ui.heightHeat);
    stage.insertBefore(ui.toolbar, canvas);
    // rail
    const rail = el("div", "td-rail"); ui.rail = rail;
    const tabs = el("div", "td-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Track Designer workspace");
    ui.tabDesign = tabBtn("DESIGN", "design"); ui.tabLib = tabBtn("MY CIRCUITS", "library"); ui.tabHow = tabBtn("HOW TO", "howto");
    tabs.append(ui.tabDesign, ui.tabLib, ui.tabHow);
    ui.paneDesign = el("section", "td-pane"); ui.paneDesign.id = "td-pane-design"; ui.paneDesign.setAttribute("role", "tabpanel"); ui.paneDesign.dataset.pane = "design";
    ui.paneLib = el("section", "td-pane"); ui.paneLib.id = "td-pane-library"; ui.paneLib.setAttribute("role", "tabpanel"); ui.paneLib.dataset.pane = "library"; ui.paneLib.hidden = true;
    ui.paneHow = el("section", "td-pane"); ui.paneHow.id = "td-pane-howto"; ui.paneHow.setAttribute("role", "tabpanel"); ui.paneHow.dataset.pane = "howto"; ui.paneHow.hidden = true;
    ui.paneHow.setAttribute("aria-label", "How to build a circuit");
    rail.append(tabs, ui.paneDesign, ui.paneLib, ui.paneHow);
    buildDesignPane(ui.paneDesign);
    const libraryFiles = el("div", "td-chips"); libraryFiles.dataset.role = "library-files";
    ui.recoverDraft = btn("RECOVER PREVIOUS DRAFT", "sel-chip", recoverDraft);
    ui.recoverDraft.hidden = true;
    libraryFiles.append(ui.recoverDraft, btn("EXPORT ALL", "sel-chip", exportLibraryFile), btn("IMPORT LIBRARY", "sel-chip", () => ui.libraryFile.click()));
    ui.libraryFile = el("input"); ui.libraryFile.type = "file"; ui.libraryFile.accept = ".json,application/json"; ui.libraryFile.hidden = true;
    ui.libraryFile.setAttribute("aria-label", "Import a circuit library file");
    ui.libraryFile.addEventListener("change", () => { const f = ui.libraryFile.files && ui.libraryFile.files[0]; ui.libraryFile.value = ""; if (f) importLibraryFile(f); });
    ui.libraryReview = group("REVIEW LIBRARY IMPORT"); ui.libraryReview.hidden = true;
    ui.libraryProgress = el("p", "adv-help"); ui.libraryProgress.setAttribute("role", "status");
    ui.libraryRecords = el("ul", "td-issues"); ui.libraryRecords.setAttribute("aria-label", "Incoming circuits");
    ui.libraryApply = btn("IMPORT", "sel-chip", commitLibraryImport); ui.libraryApply.disabled = true;
    ui.libraryApply.dataset.role = "library-import-apply";
    ui.libraryCancel = btn("CANCEL", "sel-chip", () => cancelLibraryImport(true));
    ui.libraryCancel.dataset.role = "library-import-cancel";
    const importActions = el("div", "td-chips"); importActions.append(ui.libraryApply, ui.libraryCancel);
    ui.libraryReview.append(ui.libraryProgress, ui.libraryRecords, importActions);
    ui.lib = el("div", "td-grid"); ui.paneLib.append(libraryFiles, ui.libraryFile, ui.libraryReview, ui.lib);
    buildHowTo(ui.paneHow);
    body.append(ui.modeGroup, stage, rail);
    // foot
    const foot = el("div", "td-foot");
    ui.save = btn("SAVE", "sel-edit", () => save(false));
    ui.race = btn("RACE", "sel-edit", () => race("gp"));
    ui.tt = btn("TIME TRIAL", "sel-edit", () => race("tt"));
    ui.share = btn("SHARE", "sel-chip", () => share());
    ui.card = btn("CARD", "sel-chip", () => shareCard());
    ui.card.setAttribute("aria-label", "Share a picture card of this circuit");
    ui.export = btn("EXPORT", "sel-chip", () => exportFile());
    ui.import = btn("IMPORT", "sel-chip", () => ui.file.click());
    ui.file = el("input"); ui.file.type = "file"; ui.file.accept = ".json,application/json"; ui.file.hidden = true; ui.file.setAttribute("aria-label", "Import a circuit file");
    ui.file.addEventListener("change", () => { const f = ui.file.files && ui.file.files[0]; ui.file.value = ""; if (f) importFile(f); });
    ui.msg = el("div", "td-msg"); ui.msg.setAttribute("role", "status"); ui.msg.setAttribute("aria-live", "polite");
    const files = el("div", "td-chips"); files.dataset.role = "file-actions";
    files.append(ui.share, ui.card, ui.export, ui.import);
    foot.append(ui.save, ui.race, ui.tt, files, ui.file, ui.msg);
    root.append(body, foot);
    // Short landscape phone: the foot rides under the rail (inside the body) so the dialog never scrolls.
    // Sizes are the effective ones (UI SIZE zooms the dialog); a very narrow effective width keeps the stacked layout.
    const seatFoot = () => {
      let tuck = false;
      try {
        const cs = getComputedStyle(document.documentElement);
        const k = (parseFloat(cs.getPropertyValue("--ui-scale")) || 1) * (parseFloat(cs.getPropertyValue("--look-designer-size")) || 1);
        tuck = innerWidth > innerHeight && innerHeight / k <= 600 && innerWidth / k >= 560;
      } catch (_) { /* no layout engine (unit VM): the foot stays under the body */ }
      (tuck ? body : root!).appendChild(foot); root!.dataset.foot = tuck ? "in" : "out";
    };
    if (typeof addEventListener === "function") listen(globalThis as unknown as EventTarget, "resize", seatFoot);
    seatFoot();
    workspace = DesignerWorkspace.create({ root, ui, files, el, btn,
      onTest: () => { showPane("design"); setMode("test"); },
      onHelp: () => {
        const task = mode === "edit" ? "selection" : mode === "elevation" ? "height" : mode;
        for (const d of ui.paneHow.querySelectorAll("details")) d.open = d.dataset.helpTask === task;
        showPane("howto");
        const active = ui.paneHow.querySelector('[data-help-task="' + task + '"]');
        if (active) requestAnimationFrame(() => { active.querySelector<HTMLElement>("summary")!.focus(); active.scrollIntoView({ block: "nearest" }); });
      } });

    cv = DesignerCanvas.create(canvas, {
      rangeSelect: () => selectionMode === "range" && (mode === "edit" || mode === "elevation"),
      extendSelection: () => spanArm,
      onBegin: () => {},
      onChange: (pts: Pt[], kind: string) => { commit(Object.assign({}, design!, { pts }), kind); },
      onLimit: () => message(CustomTracks.LIMITS.ptsMax + " points is the most a circuit holds — delete one first", true),
      onSelect: (i: number, j: number) => {
        sel = Number.isInteger(i) ? i : -1;
        span = (sel >= 0 && Number.isInteger(j) && j !== sel) ? j : -1;
        if (sel < 0) { span = -1; spanArm = false; }
        if (span >= 0) spanArm = false;
        refreshControls(); revealSelectionHeight();
      },
      onPick: (i: number, ev?: { shiftKey?: boolean; altKey?: boolean } | null) => {
        const extend = !!(ev && (ev.shiftKey || spanArm));
        if (stampKind(tool)) {
          if (extend && sel >= 0 && sel !== i) applyStamp(sel, i);
          else applyStamp(i, i);
          spanArm = false;
          return;
        }
        if (extend && sel >= 0 && sel !== i) { span = i; spanArm = false; }
        else { sel = i; span = -1; }
        cv!.setSelection(sel, span);
        if (prof && mode === "elevation" && prof.setSelection) prof.setSelection(sel, span);
        refreshControls(); revealSelectionHeight();
      },
      onDelete: (i: number) => deletePoint(i),
      onDraw: (path: Pt[]) => freehand(path),
      // A canvas that supports press-and-hold calls this; an older one never does.
      onContext: (i: number, at: { x: number; y: number }) => showCtx(i, at),
    });
    canvasTool();
    buildProfile(stage);
    // Window CAPTURE, ahead of TopModal's document-capture Escape and the
    // dialog's own cancel (a pad's B arrives as `cancel`): with a point
    // selected the focused canvas owns the arrows, so Escape / B first lets go
    // of it — deselect and move focus to the rail — rather than close the screen.
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      listen(window, "keydown", onBack as EventListener, true);
      listen(window, "cancel", onBack as EventListener, true);
    }
  }
  function tabBtn(label: string, pane: string) {
    const b = btn(label, "sel-chip td-tab", () => showPane(pane));
    b.id = "td-tab-" + pane;
    b.dataset.pane = pane;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", "td-pane-" + pane);
    b.tabIndex = -1;
    b.addEventListener("keydown", (e) => {
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
      if (!keys.includes(e.key)) return;
      const tabs = [ui.tabDesign, ui.tabLib, ui.tabHow];
      const at = tabs.indexOf(b);
      if (at < 0) return;
      const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1
        : (at + ((e.key === "ArrowRight" || e.key === "ArrowDown") ? 1 : -1) + tabs.length) % tabs.length;
      e.preventDefault(); e.stopPropagation();
      const target = tabs[next]!;
      showPane(target.dataset.pane!);
      target.focus();
    });
    return b;
  }
  /** designer.js:1003 */
  function showPane(pane: string) {
    if (workspace) workspace.remember();
    if (pane !== "library" && pane !== "howto") pane = "design";
    if (root) root.dataset.pane = pane;
    for (const [b, p, id] of [[ui.tabDesign, ui.paneDesign, "design"], [ui.tabLib, ui.paneLib, "library"], [ui.tabHow, ui.paneHow, "howto"]] as const) {
      const on = id === pane;
      p.hidden = !on;
      b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false");
      b.setAttribute("aria-controls", p.id);
      b.tabIndex = on ? 0 : -1;
      p.setAttribute("aria-labelledby", b.id);
    }
    if (pane === "library") renderLibrary();
    if (workspace) workspace.navigate(pane === "design" ? "design:" + mode : pane);
  }
  function group(label: string): Group { return DesignerWorkspace.group(el, label); }
  /** HOW TO: flat info rows (the CHECKS row recipe) under .td-label headings, from HOWTO. designer.js:1020 */
  function buildHowTo(pane: HTMLElement) {
    pane.appendChild(el("p", "td-hint", "Start with a task below. Selection is shared between the main map and elevation strip; UNDO reverses your edits."));
    for (const task of HOWTO.TASKS) {
      const details = el("details", "td-group"); details.dataset.helpTask = task.id;
      details.open = task.id === "selection";
      details.appendChild(el("summary", "td-label", task.title));
      const steps = el("ol");
      for (const text of task.steps) steps.appendChild(el("li", "td-hint", text));
      details.append(steps, el("p", "td-hint", task.note), btn("OPEN " + task.mode.toUpperCase(), "sel-chip", () => { setMode(task.mode); showPane("design"); if (ui.tabDesign) ui.tabDesign.focus(); }));
      pane.appendChild(details);
    }
    const list = (label: string, rows: readonly string[]) => {
      const ul = el("ul", "td-issues"); ul.setAttribute("aria-label", label);
      for (const t of rows) { const li = el("li", "td-issue", t); li.dataset.level = "info"; ul.appendChild(li); }
      pane.append(el("div", "td-label", label), ul);
    };
    list("Your first circuit", HOWTO.STEPS.map((st) => st.n + " · " + st.title.toUpperCase() + " — " + st.text));
    list("Controls", HOWTO.GESTURES.map((g) => g.input.toUpperCase() + " — " + g.text));
    list("Limits", [HOWTO.LIMITS]);
  }
  /** The first-open card: docks BELOW the mode/SHAPE tools (never covers them),
   *  until GOT IT, a mode/tool change, or the first edit. designer.js:1042 */
  function showCoach() {
    if (ui.coach || coached() || !ui.paneDesign) return;
    const lead = randomisedOnOpen ? "RANDOMISE gave you a circuit to start from. " : "";
    const card = el("div", "td-group");
    card.setAttribute("data-role", "coach");
    const li = el("div", "td-issue", lead + "EDIT shapes the road; ELEVATION changes height; SCENERY previews its look. Select one point with POINT, or a section with RANGE. HOW TO has step-by-step guides.");
    li.dataset.level = "info";
    const row = el("div", "td-chips");
    const howTo = btn("HOW TO", "sel-chip", () => showPane("howto"));
    row.append(howTo, btn("GOT IT", "sel-chip", () => dismissCoach(true)));
    card.append(li, row);
    ui.coach = card; ui.coachFirst = howTo;
    // Dock after the tool groups so SHAPE chips stay clickable (FINDINGS #3 / UX-1).
    const anchor = ui.checksGroup || ui.themeGroup || null;
    if (anchor && anchor.parentNode === ui.paneDesign) ui.paneDesign.insertBefore(card, anchor);
    else ui.paneDesign.appendChild(card);
  }
  function dismissCoach(focusRail: boolean) {
    if (!ui.coach) return;
    setCoached();
    ui.coach.remove(); ui.coach = null; ui.coachFirst = null;
    if (focusRail && ui.modes && ui.modes.firstChild) (ui.modes.firstChild as HTMLElement).focus();
    else if (focusRail && ui.tools && ui.tools.firstChild) (ui.tools.firstChild as HTMLElement).focus();
  }
  /** The canvas's press-and-hold: DELETE · START HERE · CLOSE for point i, anchored at the press. designer.js:1067 */
  function showCtx(i: number, at: { x?: number; y?: number } | null | undefined) {
    if (!ui.ctx || !design || !(i >= 0 && i < design.pts.length)) return;
    ctxAt = i; sel = i; span = -1; spanArm = false;
    if (cv) cv.setSelection(sel, span);
    refreshControls();
    const x = Math.max(0, +(at && at.x)! || 0), y = Math.max(0, +(at && at.y)! || 0);
    const r = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    const w = (r && r.width) || 0, h = (r && r.height) || 0;
    // Open away from the nearer edges so the row never hangs off the canvas.
    const st = ui.ctx.style;
    if (w && x > w / 2) { st.left = ""; st.right = Math.round(w - x) + "px"; } else { st.right = ""; st.left = Math.round(x) + "px"; }
    if (h && y > h / 2) { st.top = ""; st.bottom = Math.round(h - y) + "px"; } else { st.bottom = ""; st.top = Math.round(y) + "px"; }
    ui.ctx.setAttribute("aria-label", "Point " + (i + 1));
    ui.ctxStart.disabled = i === 0;
    ui.ctx.hidden = false;
  }
  function hideCtx() { ctxAt = -1; if (ui.ctx) ui.ctx.hidden = true; }
  function stepper(label: string, get: () => number, set: (v: number) => unknown, step: number | (() => number), fmt?: ((v: number) => string) | null, editable?: boolean): StepperRow {
    const row = el("div", "td-row") as StepperRow;
    const lab = el("span", "", label);
    const delta = () => typeof step === "function" ? step() : step;
    const minus = btn("−", "sel-chip", () => set(get() - delta()));
    const val = el(editable ? "input" : "span", editable ? "td-input td-num" : "td-num", editable ? "" : fmt ? fmt(get()) : String(get())) as HTMLInputElement;
    if (editable) {
      val.type = "number"; val.step = "0.25"; val.min = String(-CustomTracks.LIMITS.rise); val.max = String(CustomTracks.LIMITS.rise);
      val.setAttribute("aria-label", "Selected point height in metres");
      const applyValue = () => { if (val.value.trim() && Number.isFinite(+val.value)) set(+val.value); val.value = String(get()); };
      val.addEventListener("change", applyValue);
      val.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); applyValue(); } });
    }
    const plus = btn("+", "sel-chip", () => set(get() + delta()));
    minus.setAttribute("aria-label", label + " down"); plus.setAttribute("aria-label", label + " up");
    row.append(lab, minus, val, plus);
    row._label = lab;
    row._refresh = () => { if (editable) { if (document.activeElement !== val) val.value = String(get()); } else val.textContent = fmt ? fmt(get()) : String(get()); };
    return row;
  }
  /** designer.js:1104 */
  function buildDesignPane(pane: HTMLElement) {
    // Mode tabs first — clear switch between draw / edit / elevation / scenery / test.
    const modes = el("div", "td-group");
    modes.dataset.role = "mode-bar"; ui.modeGroup = modes;
    ui.modes = el("div", "td-chips");
    ui.modes.setAttribute("role", "group");
    ui.modes.setAttribute("aria-label", "Designer mode");
    for (const [id, label] of MODES) {
      const b = btn(label, "sel-chip", () => { showPane("design"); setMode(id); });
      b.dataset.mode = id; b.setAttribute("aria-pressed", "false");
      ui.modes.appendChild(b);
    }
    modes.appendChild(ui.modes);
    // tools
    // The rail reads as the order a circuit is built in: 1 SHAPE … 5 CHECKS.
    const tools = group("SHAPE");
    ui.tools = el("div", "td-chips");
    for (const [id, label] of TOOLS) {
      const b = btn(label, "sel-chip", () => setTool(id)); b.dataset.tool = id; b.setAttribute("aria-pressed", "false");
      b.hidden = id === "draw"; ui.tools.appendChild(b);
    }
    // The stage's hint is hidden on a phone (css/editor.css): this copy stays in the rail.
    ui.toolHint = el("div", "td-hint", toolHint());
    tools.append(ui.tools, ui.toolHint);
    ui.toolsGroup = tools;
    // stamp params
    ui.shape = group("CORNERS") as Fold;
    ui.shapeLabel = ui.shape._label;
    ui.paramRows = {} as Record<ParamKey, StepperRow>;
    for (const key of ["L", "R", "deg"] as const) {
      const row = stepper(PARAM_LABEL[key], () => params[key]!, (v) => { params[key] = clampParam(key, v); refreshControls(); }, STEPS[key]);
      ui.paramRows[key] = row; ui.shape.appendChild(row);
    }
    const dirRow = el("div", "td-chips");
    ui.dirL = btn("TURNS LEFT", "sel-chip", () => { params.dir = 1; refreshControls(); });
    ui.dirR = btn("TURNS RIGHT", "sel-chip", () => { params.dir = -1; refreshControls(); });
    dirRow.append(ui.dirL, ui.dirR); ui.shape.appendChild(dirRow);
    ui.apply = btn("STAMP AT SELECTED POINT", "sel-edit", () => applyStamp(sel >= 0 ? sel : 0, span >= 0 ? span : null));
    // Always keep 2 CORNERS in the rail (hiding the whole group left 1 SHAPE → 3 LOOK).
    ui.shapeHint = el("div", "td-hint", "Pick STRAIGHT, CORNER, HAIRPIN, CHICANE or S-BEND under SHAPE to stamp.");
    ui.shape.append(ui.apply, ui.shapeHint);
    // Scenery owns discovery and placement controls; all writes remain in this
    // module so history, validation, autosave and race hand-off share one path.
    scenery = DesignerScenery.create({ el, btn, group, stepper,
      onTheme: setTheme, onLook: setLook, onPreset: setAtmosphere, onKind: setPropKind,
      onPlace: () => placeProp(), onRemove: () => removeProp(), onRemoveAt: removePropAt,
      onSelect: selectRange, onEditAt: editPropAt, onCopyAt: copyPropAt,
      onRecipe: (props: DesignerProp[]) => { commit(Object.assign({}, design!, { props }), "prop"); return true; } });
    const theme = scenery.root; ui.themeGroup = theme;
    // circuit
    const circuit = group("ROAD"); ui.circuitGroup = circuit;
    ui.name = el("input", "td-input"); ui.name.type = "text"; ui.name.maxLength = CustomTracks.LIMITS.name; ui.name.autocomplete = "off"; ui.name.spellcheck = false;
    ui.name.setAttribute("aria-label", "Circuit name"); ui.name.placeholder = "CIRCUIT NAME";
    ui.name.addEventListener("input", () => { design!.name = CustomTracks.sanitizeName(ui.name.value); scheduleDraft(); });
    ui.name.addEventListener("blur", () => { ui.name.value = design!.name; });
    circuit.appendChild(ui.name);
    // COUNTRY: the picker's flag and LOCATION row. One entry per flag the game
    // draws (Flags lists aliases too: the first name per flag is the label).
    ui.country = el("select", "td-input"); ui.country.setAttribute("aria-label", "Country");
    const Flags = deps.flags || null;
    const seenFlag = new Set<string>(), names: string[] = [];
    for (const n of (Flags ? Flags.countries() : [])) { const c = Flags!.code(n); if (c && !seenFlag.has(c)) { seenFlag.add(c); names.push(n); } }
    for (const n of [""].concat(names.sort())) { const o = el("option", "", n ? n.toUpperCase() : "NO COUNTRY"); o.value = n; ui.country.appendChild(o); }
    ui.country.addEventListener("change", () => { design!.country = CustomTracks.sanitizeCountry(ui.country.value); if (!design!.country) delete design!.country; scheduleDraft(); });
    circuit.appendChild(ui.country);
    // build() runs before the first design is loaded: read through the null.
    ui.width = stepper("HALF-WIDTH m", () => (design ? design.baseHW : 7), (v) => setWidth(v), 0.5, (v) => v.toFixed(1));
    circuit.appendChild(ui.width);
    const actions = el("div", "td-chips");
    ui.randomise = btn("RANDOMISE", "sel-chip", () => randomise());
    ui.reverse = btn("REVERSE", "sel-chip", () => reverse());
    ui.start = btn("START HERE", "sel-chip", () => setStart(sel));
    ui.del = btn("DELETE POINT", "sel-chip", () => deletePoint(sel));
    ui.prevPt = btn("PREV POINT", "sel-chip", () => cyclePoint(-1));
    ui.nextPt = btn("NEXT POINT", "sel-chip", () => cyclePoint(1));
    ui.spanEnd = btn("SELECT END", "sel-chip", () => armSpanEnd());
    ui.prevPt.setAttribute("aria-label", "Select previous control point");
    ui.nextPt.setAttribute("aria-label", "Select next control point");
    ui.spanEnd.setAttribute("aria-label", "Next tap sets the end of a selected span (group move, elevate, or replace)");
    ui.spanEnd.setAttribute("aria-pressed", "false");
    actions.append(ui.randomise, ui.reverse, ui.start, ui.del, ui.prevPt, ui.nextPt, ui.spanEnd);
    ui.testHere = btn("TEST HERE", "sel-chip", () => testHere());
    ui.testHere.setAttribute("aria-label", "Test drive from the selected point");
    actions.appendChild(ui.testHere);
    circuit.appendChild(actions);
    // Elevation presets (always built; shown in elevation mode).
    ui.elevGroup = group("ELEVATION");
    ui.elevPresets = el("div", "td-chips");
    ui.elevPresets.setAttribute("aria-label", "Elevation presets");
    for (const name of ["flat", "rolling", "hilly"]) {
      const b = btn(name.toUpperCase(), "sel-chip", () => applyElevPreset(name));
      b.dataset.elev = name;
      ui.elevPresets.appendChild(b);
    }
    ui.elevHint = el("div", "td-hint", "Pick a point anywhere in its profile column. Drag vertically to change height, or enter metres below. RANGE selects a whole section on either view.");
    ui.elevNode = stepper("POINT m", () => {
      if (!design || sel < 0 || !design.heights) return 0;
      return design.heights[sel] || 0;
    }, (v) => setNodeHeight(sel, v), () => heightStep, null, true);
    const steps = el("div", "td-chips"); steps.setAttribute("aria-label", "Elevation adjustment step");
    for (const v of [0.25, 1, 5]) {
      const b = btn(v + " m STEP", "sel-chip", () => { heightStep = v; refreshControls(); });
      b.dataset.heightStep = String(v); b.setAttribute("aria-pressed", String(v === heightStep)); b.classList.toggle("active", v === heightStep); steps.appendChild(b);
    }
    ui.elevActions = el("div", "td-chips");
    for (const [id, text] of [["level", "LEVEL"], ["smooth", "SMOOTH"], ["zero", "ZERO"]] as const) {
      const b = btn(text, "sel-chip", () => adjustElevation(id)); b.dataset.heightAction = id;
      b.title = id === "level" ? "Set selected points to the first point's height" : id === "smooth" ? "Soften selected heights; keep range endpoints" : "Set selected heights to zero"; ui.elevActions.appendChild(b);
    }
    ui.elevGroup.append(ui.elevHint, steps, ui.elevNode, ui.elevActions, el("div", "td-label", "WHOLE CIRCUIT PRESETS"), ui.elevPresets);
    // Banking + kerbs (E+F) and berms (G): elevation mode owns the road cross-section.
    ui.bankGroup = group("BANKING & KERBS");
    ui.bankGroup.setAttribute("data-role", "bank-kerbs");
    ui.bankHint = el("div", "td-hint", "Tap a row under TURNS, then set BANK ° · kerbs and berms apply to the whole circuit");
    ui.kerbChips = el("div", "td-chips");
    ui.kerbChips.setAttribute("aria-label", "Kerb style");
    ui.kerbChips.setAttribute("data-role", "kerb-style");
    for (const name of KERB_STYLES) {
      const b = btn(name.toUpperCase(), "sel-chip", () => setKerbStyle(name));
      b.dataset.kerb = name;
      ui.kerbChips.appendChild(b);
    }
    ui.bermChips = el("div", "td-chips");
    ui.bermChips.setAttribute("aria-label", "Berms on banked corners");
    ui.bermChips.setAttribute("data-role", "berms");
    ui.bermOn = btn("BERMS ON", "sel-chip", () => setBerms(true));
    ui.bermOff = btn("BERMS OFF", "sel-chip", () => setBerms(false));
    ui.bermChips.append(ui.bermOn, ui.bermOff);
    ui.bankGroup.append(ui.bankHint, ui.kerbChips, ui.bermChips);
    // issues
    const issues = el("div", "td-group");
    ui.checksGroup = issues;
    // The label row carries FIX ALL (shown while a red issue has an automatic fix).
    const head = el("div", "td-chips");
    ui.fixAll = btn("FIX ALL", "sel-chip", () => fixEverything());
    ui.fixAll.hidden = true; ui.fixAll.setAttribute("aria-label", "Fix every issue the designer can repair");
    head.append(el("div", "td-label", "CHECKS"), ui.fixAll);
    // Not a live region: it is rebuilt on every preview (announceChecks speaks the counts).
    ui.issues = el("ul", "td-issues"); ui.issues.setAttribute("aria-label", "Design checks");
    repair = DesignerFollowup.repairPanel({ el, btn, getDesign: () => design, check: TrackValidate.check, onApply: (next: Design | null, codes: string[], msg: string) => { commitFix(next!, codes); message(msg); } });
    issues.append(head, ui.issues, repair.root);
    // share in: a pasted code or link (SHARE on the foot copies one out)
    const sharing = group("SHARE CODE") as Fold; ui.sharingGroup = sharing;
    ui.code = el("input", "td-input"); ui.code.type = "text"; ui.code.autocomplete = "off"; ui.code.spellcheck = false;
    ui.code.placeholder = "PASTE A SHARE CODE OR LINK"; ui.code.setAttribute("aria-label", "Share code or link");
    ui.code.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); loadFrom(ui.code.value); } });
    const loadRow = el("div", "td-chips");
    ui.load = btn("LOAD", "sel-chip", () => loadFrom(ui.code.value));
    loadRow.appendChild(ui.load);
    sharing.append(ui.code, loadRow);
    selectionPanel = DesignerSelection.create({ el, btn, group, onSelect: selectRange, onMode: setSelectionMode, onCycle: cyclePoint, onFocus: focusSelection, onView: profileView });
    ui.quickHeight = el("div", "td-group"); ui.quickHeight.dataset.role = "selection-height";
    ui.quickHeightLabel = el("div", "td-label");
    const quickRow = el("div", "td-chips"); quickRow.dataset.role = "height-shift";
    const lower = btn("LOWER", "sel-chip", () => shiftSelectedHeight(-1)); lower.setAttribute("aria-label", "Lower selected points");
    const raise = btn("RAISE", "sel-chip", () => shiftSelectedHeight(1)); raise.setAttribute("aria-label", "Raise selected points");
    ui.heightDelta = el("input", "td-input"); ui.heightDelta.type = "number";
    ui.heightDelta.min = "0.25"; ui.heightDelta.max = String(CustomTracks.LIMITS.rise * 2); ui.heightDelta.step = "0.25";
    ui.heightDelta.setAttribute("aria-label", "Elevation change in metres");
    const readDelta = () => {
      if (ui.heightDelta.value.trim() && Number.isFinite(+ui.heightDelta.value)) heightStep = Math.max(0.25, Math.min(CustomTracks.LIMITS.rise * 2, Math.round(+ui.heightDelta.value * 4) / 4));
      ui.heightDelta.value = String(heightStep); refreshControls();
    };
    ui.heightDelta.addEventListener("change", readDelta);
    ui.heightDelta.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); readDelta(); } });
    quickRow.append(lower, ui.heightDelta, raise);
    ui.quickHeightHint = el("div", "td-hint");
    ui.quickHeight.append(ui.quickHeightLabel, quickRow, ui.quickHeightHint);
    selectionPanel.root.insertBefore(ui.quickHeight, selectionPanel.root.children[2] || null);
    pane.append(selectionPanel.root, tools, ui.shape, ui.elevGroup, ui.bankGroup, theme, circuit, issues, sharing);
    buildInsight(pane, circuit, actions, sharing);
    buildAuthoring();
    buildDesigned(circuit);
    bridges = DesignerBridges.create({ el, btn, group, onChange: (next: DesignerBridges.BridgeDesign, msg: string) => { commit(next as unknown as Design, "bridges"); message(msg + " · open TEST to check clearance"); } });
    ui.elevGroup.appendChild(bridges.root);
  }

  // ── share out / in (designer.js:1280) ─────────────────────────────────────
  let lastCode: string | null = null;
  /** The APXT1 code for the current design (null when it does not sanitise). designer.js:1283 */
  async function shareCode() {
    if (!design || !design.pts.length) return null;
    lastCode = await TrackCodec.encode(design);
    return lastCode;
  }
  /** Copy the share link; the code also lands in the SHARE CODE field for a long-press copy. designer.js:1289 */
  async function share() {
    if (previewT || !verdict) runPreview();
    if (!verdict || !verdict.ok) { setMode("test"); message("Fix the red issues before sharing", true); return null; }
    const code = await shareCode();
    if (!code) { message("This design cannot be encoded", true); return null; }
    const url = TrackCodec.shareUrl(code);
    if (ui.code) ui.code.value = url;
    let copied = false;
    const ApexClipboard = deps.clipboard || null;
    try { if (ApexClipboard && ApexClipboard.write) copied = !!(await ApexClipboard.write(url)); } catch (_) { copied = false; }
    if (!copied) {
      showPane("design"); setMode("test"); ui.sharingGroup.open = true;
      ui.code.focus(); ui.code.select(); ui.code.scrollIntoView({ block: "nearest" });
    }
    message(copied ? "Share link copied" : "Share link is in the SHARE CODE field — copy it from there", !copied);
    Log.info("track", "designer share " + (design!.id || "(unsaved)") + " " + code.length + " chars" + (copied ? " copied" : ""));
    return url;
  }
  /** The `apex26.track` file envelope for the current design (what EXPORT writes). designer.js:1307 */
  async function exportEnvelope() {
    if (!design || !design.pts.length) return null;
    const d = copy(design);
    const code = await TrackCodec.encode(d);
    if (!code) return null;
    delete d.originId;   // this player's library link, not the circuit
    return TrackCodec.fileEnvelope(d, code);
  }
  /** designer.js:1315 */
  async function exportFile() {
    const env = await exportEnvelope();
    if (!env) { message("Nothing to export yet", true); return false; }
    const name = fileStem(env.design) + ".apextrack.json";
    const blob = new Blob([JSON.stringify(env, null, 2)], { type: "application/json" });
    try {
      await saveFile(blob, name);
      message("Exported " + name);
      return true;
    } catch (e) { message("Export failed: " + (e && (e as Error).message || e), true); return false; }
  }
  /** designer.js:1326 */
  async function exportLibraryFile() {
    const data = custom!.exportCollection();
    try {
      await saveFile(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), "apex26-circuits.apextracks.json");
      message("Exported " + data.items.length + " saved circuits"); return true;
    } catch (e) { message("Library export failed: " + (e && (e as Error).message || e), true); return false; }
  }
  function libraryImportError(r: { reason?: string; index?: number }) {
    const why = r.reason === "full" ? "MY CIRCUITS holds at most " + custom!.LIMITS.items + " circuits — remove some before importing"
      : r.reason === "invalid" || r.reason === "collision" ? "Circuit " + (r.index! + 1) + " " + (r.reason === "collision" ? "has a conflicting content ID" : "failed validation")
      : r.reason === "write" ? "Library storage write failed"
      : r.reason === "changed" ? "MY CIRCUITS changed — review the file again"
      : "Not a supported Apex 26 circuit library";
    message(why + ". Nothing imported.", true);
  }
  function paintLibraryProgress(p: { done: number; total: number; added: number; skipped: number; records: readonly { name: string; status: string; reason: string | null }[] }) {
    if (!ui.libraryProgress) return;
    ui.libraryProgress.textContent = p.done + " of " + p.total + " checked · " + p.added + " to add · " + p.skipped + " duplicates";
    ui.libraryRecords.textContent = "";
    for (const row of p.records) ui.libraryRecords.appendChild(el("li", "", row.name + " — " + (row.status === "error" ? row.reason : row.status === "add" ? "ADD" : "DUPLICATE · KEEP EXISTING")));
  }
  /** designer.js:1347 */
  function cancelLibraryImport(tell?: boolean) {
    ++libraryImportGeneration;
    if (libraryImportPlan) custom!.cancelCollectionPreflight(libraryImportPlan);
    libraryImportPlan = null;
    if (ui.libraryReview) { ui.libraryReview.hidden = true; ui.libraryReview.removeAttribute("aria-busy"); }
    if (ui.libraryApply) ui.libraryApply.disabled = true;
    if (tell) { message("Import canceled. Nothing imported."); if (ui.tabLib) ui.tabLib.focus(); }
  }
  /** designer.js:1355 */
  function commitLibraryImport() {
    if (!libraryImportPlan) return false;
    const r = custom!.commitCollectionPreflight(libraryImportPlan);
    cancelLibraryImport(false);
    if (!r.ok) { libraryImportError(r); return false; }
    renderLibrary(); showPane("library");
    message("Imported " + r.added + " circuits · " + r.skipped + " duplicates kept unchanged" + (r.durable ? "" : " · storage unavailable: export a backup before reloading"), !r.durable);
    if (ui.tabLib) ui.tabLib.focus();
    return true;
  }
  /** designer.js:1365 */
  async function loadCollection(data: unknown, generation?: number | null) {
    if (generation == null) { cancelLibraryImport(false); generation = libraryImportGeneration; }
    const valid = () => generation === libraryImportGeneration;
    showPane("library");
    ui.libraryReview.hidden = false; ui.libraryReview.setAttribute("aria-busy", "true"); ui.libraryApply.disabled = true;
    const items = data && (data as { items?: unknown }).items;
    paintLibraryProgress({ done: 0, total: data && Array.isArray(items) ? items.length : 0, added: 0, skipped: 0, records: [] });
    ui.libraryCancel.focus();
    const r = await custom!.preflightCollection(data, TrackValidate.check, { valid, onProgress: (p) => { if (valid()) paintLibraryProgress(p); } });
    if (!valid()) { custom!.cancelCollectionPreflight(r); return false; }
    ui.libraryReview.removeAttribute("aria-busy");
    if (!r.ok) { libraryImportError(r); return false; }
    libraryImportPlan = r; ui.libraryApply.disabled = false;
    message("Review " + r.added + " additions and " + r.skipped + " duplicates, then IMPORT. Nothing imported yet.");
    ui.libraryApply.focus();
    return true;
  }
  /** designer.js:1381 */
  async function importLibraryFile(file: { size: number; text(): Promise<string> } | null | undefined) {
    cancelLibraryImport(false);
    const generation = libraryImportGeneration;
    if (!file || !(file.size <= IMPORT_MAX * custom!.LIMITS.items)) { message("Library file is too large (" + (IMPORT_MAX * custom!.LIMITS.items >> 10) + " KB max)", true); return false; }
    try {
      const data = JSON.parse(await file.text());
      return generation === libraryImportGeneration ? await loadCollection(data, generation) : false;
    } catch (_) { if (generation === libraryImportGeneration) message("Could not read the library file. Nothing imported.", true); return false; }
  }
  /** designer.js:1390 */
  async function importFile(file: { size: number; text(): Promise<string> } | null | undefined) {
    const generation = ++replacementGeneration;
    // An exported circuit is a few KB; never read a large file into memory to find out it is not one.
    if (!file || !(file.size <= IMPORT_MAX)) { message("That file is too big to be an Apex 26 circuit (" + (IMPORT_MAX >> 10) + " KB max)", true); return false; }
    try { const text = await file.text(); return generation === replacementGeneration ? await loadFrom(text, generation) : false; } catch (e) { if (generation === replacementGeneration) message("Could not read that file", true); return false; }
  }
  /** Load a design from any of: a share link, a bare APXT1 code, or an exported file's JSON. designer.js:1397 */
  async function loadFrom(text: unknown, generation = ++replacementGeneration) {
    const s = String(text || "").trim();
    if (!s) { message("Paste a share code or link first", true); return false; }
    let code: string | null = null, raw: object | null = null;
    if (s[0] === "{") {
      let obj: unknown = null; try { obj = JSON.parse(s); } catch (_) { obj = null; }
      if (obj && (obj as { format?: unknown }).format === custom!.COLLECTION_FORMAT) return loadCollection(obj);
      const f = TrackCodec.fromFile(obj);
      if (!f) { message("Not an Apex 26 circuit file", true); return false; }
      if ("code" in f && f.code) code = f.code; else raw = (f as { design: object }).design;
    } else if (/[#&]track=/.test(s)) {
      try { code = TrackCodec.fromHash(s.slice(Math.max(0, s.indexOf("#")))); } catch (_) { code = null; }
      if (!code) { message("That link carries no readable share code", true); return false; }
    } else code = s;
    let it: object | null = null;
    if (code) {
      let r: Awaited<ReturnType<typeof TrackCodec.decode>> | null = null;
      try { r = await TrackCodec.decode(code); } catch (_) { r = null; }
      if (generation !== replacementGeneration) return false;
      if (!r) { message("That share code could not be read", true); return false; }
      if (!r.ok) { message("That share code was refused (" + r.reason + ")", true); return false; }
      it = r.design;
    } else it = custom!.sanitize(raw);
    if (!it) { message("That design could not be loaded", true); return false; }
    const kept = load(it, "import");
    showPane("design");
    message("Loaded " + (it as { name: string }).name + " — SAVE to keep it in MY CIRCUITS" + keptNote(kept));
    return true;
  }
  function clampParam(key: string, v: number) {
    const k = stampKind(tool) || TrackStamps.KINDS.corner;
    const min = k.min as Params, max = k.max as Params;
    const lo = k.min && min[key] != null ? min[key]! : (key === "L" ? 20 : 10), hi = k.max && max[key] != null ? max[key]! : (key === "L" ? 1200 : 600);
    return Math.min(hi, Math.max(lo, Math.round(v)));
  }
  /** designer.js:1431 */
  function refreshControls() {
    if (!built || !design) return;
    refreshMapView();
    if (ui.modes) for (const b of ui.modes.children as HTMLCollectionOf<HTMLElement>) {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on); b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    for (const b of ui.tools.children as HTMLCollectionOf<HTMLElement>) { const on = b.dataset.tool === tool; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on ? "true" : "false"); }
    const kind = stampKind(tool);
    const showElev = mode === "elevation";
    if (ui.toolsGroup) ui.toolsGroup.hidden = mode !== "edit";
    // #1039: keep 2 CORNERS in the rail so numbering never skips 1 → 3; hide only stamp controls (and only outside EDIT).
    if (ui.shape) ui.shape.hidden = mode !== "edit";
    if (ui.elevGroup) ui.elevGroup.hidden = !showElev;
    // Banking/kerbs live in elevation mode (road cross-section); turn BANK ° also
    // stays under TURNS when a corner is selected (buildAuthoring).
    if (ui.bankGroup) ui.bankGroup.hidden = !showElev;
    if (ui.themeGroup) ui.themeGroup.hidden = !(mode === "scenery");
    if (ui.shapeHint) ui.shapeHint.hidden = !!kind || mode !== "edit";
    if (ui.apply) ui.apply.hidden = !kind || mode !== "edit";
    for (const key of ["L", "R", "deg"] as const) {
      const row = ui.paramRows[key];
      row.hidden = !(kind && key in kind.params) || mode !== "edit";
      if (!row.hidden) { params[key] = clampParam(key, params[key] != null ? params[key]! : kind!.params[key]!); row._refresh(); }
    }
    const dir = !!(kind && "dir" in kind.params) && mode === "edit";
    ui.dirL.hidden = ui.dirR.hidden = !dir;
    if (kind && mode === "edit") {
      ui.dirL.classList.toggle("active", params.dir === 1); ui.dirR.classList.toggle("active", params.dir === -1);
      ui.dirL.setAttribute("aria-pressed", params.dir === 1 ? "true" : "false"); ui.dirR.setAttribute("aria-pressed", params.dir === -1 ? "true" : "false");
      ui.apply.textContent = span >= 0 && sel >= 0 ? "REPLACE THE SELECTED SPAN" : sel >= 0 ? "STAMP AFTER POINT " + (sel + 1) : "STAMP AT THE START";
      ui.shapeLabel.textContent = "CORNERS · " + stampExample();
    } else if (ui.shapeLabel) {
      ui.shapeLabel.textContent = "CORNERS";
    }
    if (bridges && showElev) bridges.refresh({ design: design as unknown as DesignerBridges.BridgeDesign, sel });
    if (scenery) scenery.refresh({ design: design as DesignerScenery.SceneryDesign, sel, span, propKind });
    if (selectionPanel) selectionPanel.refresh({ design, sel, span, mode, selectionMode });
    if (ui.quickHeight) {
      ui.quickHeight.hidden = sel < 0 || (mode !== "edit" && !showElev);
      if (sel >= 0) {
        const count = S.spanIndices(sel, span, design.pts.length).length;
        ui.quickHeightLabel.textContent = "HEIGHT CHANGE (m) · " + count + (count === 1 ? " POINT" : " POINTS");
        ui.quickHeightHint.textContent = "Change all " + count + " by " + heightStep + " m. Keeps relative hills and your selection.";
        if (document.activeElement !== ui.heightDelta) ui.heightDelta.value = String(heightStep);
      }
      for (const b of root!.querySelectorAll<HTMLElement>("[data-height-step]")) {
        const on = +b.dataset.heightStep! === heightStep; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
      }
    }
    if (ui.elevActions) for (const b of ui.elevActions.children as HTMLCollectionOf<HTMLButtonElement>) b.disabled = sel < 0;
    if (document.activeElement !== ui.name) ui.name.value = design.name;
    if (ui.country) ui.country.value = design.country || "";
    ui.width._refresh();
    if (ui.undo) ui.undo.disabled = !undo.length;
    if (ui.redo) ui.redo.disabled = !redo.length;
    ui.start.disabled = ui.del.disabled = !(sel >= 0);
    if (ui.prevPt) { ui.prevPt.disabled = !design.pts.length; ui.prevPt.hidden = mode !== "test"; }
    if (ui.nextPt) { ui.nextPt.disabled = !design.pts.length; ui.nextPt.hidden = mode !== "test"; }
    if (ui.spanEnd) {
      ui.spanEnd.hidden = true; // RANGE is the single visible selection workflow.
      ui.spanEnd.disabled = !(sel >= 0);
      ui.spanEnd.classList.toggle("active", !!spanArm);
      ui.spanEnd.setAttribute("aria-pressed", spanArm ? "true" : "false");
      ui.spanEnd.textContent = hasSpan() ? ("SPAN " + (sel + 1) + "–" + (span + 1)) : (spanArm ? "TAP END…" : "SELECT END");
    }
    ui.hint.textContent = ui.toolHint.textContent = toolHint();
    if (ui.elevNode) {
      ui.elevNode.hidden = !(showElev && sel >= 0);
      if (!ui.elevNode.hidden) {
        // SPAN: label shows the group so POINT m reads as a group offset.
        if (ui.elevNode._label) ui.elevNode._label.textContent = hasSpan() ? ("SPAN m · " + (sel + 1) + "–" + (span + 1)) : "POINT m";
        ui.elevNode._refresh();
      }
    }
    if (ui.kerbChips) for (const b of ui.kerbChips.children as HTMLCollectionOf<HTMLElement>) {
      const on = b.dataset.kerb === kerbOf(design);
      b.classList.toggle("active", on); b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (ui.bermOn) {
      const on = bermsOn(design);
      ui.bermOn.classList.toggle("active", on); ui.bermOn.setAttribute("aria-pressed", on ? "true" : "false");
      ui.bermOff.classList.toggle("active", !on); ui.bermOff.setAttribute("aria-pressed", !on ? "true" : "false");
    }
    if (ui.circuitGroup) {
      ui.circuitGroup.hidden = mode === "scenery" || showElev;
      ui.circuitGroup._label.textContent = mode === "draw" ? "START A CIRCUIT" : mode === "test" ? "CIRCUIT DETAILS" : "ROAD";
      for (const node of [ui.name, ui.country]) node.hidden = mode !== "test";
      ui.width.hidden = ui.spanW.hidden = mode !== "edit";
      for (const node of [ui.reverse, ui.start, ui.del]) node.hidden = mode !== "edit";
      for (const node of [ui.heat, ui.testHere]) node.hidden = mode !== "test";
      ui.seedRow.hidden = ui.styleRow.hidden = mode !== "draw";
      ui.candidateSection.hidden = mode !== "draw";
    }
    if (ui.turnsGroup) ui.turnsGroup.hidden = mode === "draw" || mode === "scenery";
    if (ui.checksGroup) ui.checksGroup.hidden = mode !== "test";
    if (ui.sharingGroup) ui.sharingGroup.hidden = mode !== "test";
    if (root) root.dataset.mode = mode;
    if (workspace) { workspace.refresh(mode, tool); workspace.navigate(root!.dataset.pane === "design" ? "design:" + mode : root!.dataset.pane!); }
    refreshAuthoring();
    syncProfile();
    if (ui.testHere) ui.testHere.setAttribute("aria-disabled", sel >= 0 ? "false" : "true");
  }
  // ── FIX: TrackFixes (the editor fixes module) repairs what it can; each is one UNDO entry (designer.js:1534) ──
  const fixer = () => TrackFixes;
  function canFix(it: Issue) { const F = fixer(); try { return !!(F && F.canFix && F.canFix(it)); } catch (_) { return false; } }
  /** designer.js:1537 */
  function fixIssue(it: Issue) {
    const F = fixer();
    let r: TrackFixes.FixResult | null = null;
    try { r = F && F.apply ? F.apply(design, it, verdict as TrackFixes.BuiltLike | null) : null; } catch (e) { Log.warn("track", "designer fix " + (it && it.code) + " threw: " + (e && (e as Error).message)); r = null; }
    if (!r || !r.design || r.design === (design as unknown)) { message("No automatic fix for this one", true); return false; }
    repair!.preview(r.design, [it.code], "Fixed: " + (r.msg || it.code) + " — UNDO to revert");
    return true;
  }
  /** One UNDO entry for a remedy, keyed off issue.code (never issue.fix: the
   *  crossing's tag is "bridge"). A start remedy rotates point 0 like setStart;
   *  a length remedy rescales everything, so the view refits. designer.js:1548 */
  function commitFix(next: Design, codes: readonly string[]) {
    sel = codes.includes("start") ? 0 : -1; span = -1;
    commit(next, "fix");
    if (codes.includes("length") && cv) cv.fit();
  }
  /** designer.js:1553 */
  function fixEverything() {
    const F = fixer();
    let r: ReturnType<typeof TrackFixes.fixAll<Design>> | null = null;
    try { r = F && F.fixAll ? F.fixAll(design!, TrackValidate.check) : null; } catch (e) { Log.warn("track", "designer fix all threw: " + (e && (e as Error).message)); r = null; }
    const applied = r && Array.isArray(r.applied) ? r.applied : [];
    // Nothing applied → fixAll hands back the SAME design object: no commit.
    if (!r || !r.design || r.design === design || !applied.length) { message("Nothing here can be fixed automatically", true); return false; }
    repair!.preview(r.design, applied, "Fixed " + applied.join(", ") + " — UNDO to revert");
    return true;
  }
  function renderIssues() {
    if (!ui.issues) return;
    while (ui.issues.firstChild) ui.issues.removeChild(ui.issues.firstChild);
    const list = verdict ? verdict.issues : [];
    if (ui.fixAll) ui.fixAll.hidden = !list.some((it) => it.level === "red" && canFix(it));
    if (!list.length) { const li = el("li", "td-issue", "All checks pass — ready to save and race"); li.dataset.level = "ok"; ui.issues.appendChild(li); return; }
    const order: Record<string, number> = { red: 0, amber: 1, info: 2 };
    for (const it of list.slice().sort((a, b) => (order[a.level] || 0) - (order[b.level] || 0))) {
      const li = el("li", "td-issue", it.msg); li.dataset.level = it.level; li.tabIndex = 0;
      const go = () => { if (Number.isFinite(it.s) && cv) cv.focusAt(it.s!); if (Number.isFinite(it.ctrl)) { sel = it.ctrl!; span = -1; cv!.setSelection(sel, span); refreshControls(); } if (it.fix === "start" && sel >= 0) message("START HERE moves the line to the selected point"); };
      // The row's own presses only: a key or click on its FIX chip is the chip's.
      li.addEventListener("click", (ev) => { if (ev && ev.target && ev.target !== li) return; go(); });
      li.addEventListener("keydown", (ev) => { if (ev.target && ev.target !== li) return; if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
      if (canFix(it)) {
        const fix = btn("FIX", "sel-chip", (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); fixIssue(it); });
        fix.setAttribute("aria-label", "Fix: " + it.msg);
        li.appendChild(fix);
      }
      ui.issues.appendChild(li);
    }
  }
  function renderStats() {
    if (!ui.stats) return;
    while (ui.stats.firstChild) ui.stats.removeChild(ui.stats.firstChild);
    const st = verdict && verdict.stats, tr = verdict && verdict.tr;
    const cells = tr ? [
      fmtKm(tr.total), "est lap " + fmtLap(st ? st.estLapS : undefined), "min R " + (st && st.minR != null ? st.minR + " m" : "—"),
      (st && st.turns != null ? st.turns : (verdict!.turns || []).length) + " corners", design!.pts.length + " pts", "seed " + design!.seed,
    ] : [design!.pts.length + " pts"];
    for (const c of cells) ui.stats.appendChild(el("span", "", c));
  }
  function renderLibrary() {
    if (!ui.lib) return;
    if (ui.recoverDraft) ui.recoverDraft.hidden = !draftItem(true);
    while (ui.lib.firstChild) ui.lib.removeChild(ui.lib.firstChild);
    const items = custom!.list();
    if (!items.length) { ui.lib.appendChild(el("div", "td-empty", "No saved circuits yet — open DESIGN, then SAVE your circuit. Saved circuits also show under MY CIRCUITS in the RACE picker.")); return; }
    const TrackMaps = deps.trackMaps || null;
    for (const it of items) {
      const card = el("div", "td-card");
      const c = el("canvas"); c.width = 320; c.height = 220; c.setAttribute("aria-hidden", "true");
      const def = trackList().find((t) => t.id === it.id);
      try { if (def) TrackMaps!.draw!(c, def, { width: 3, color: "#f6f6f9" }); } catch (e) { Log.warn("track", "library thumbnail failed: " + (e && (e as Error).message)); }
      const name = el("strong", "", it.name);
      const meta = el("div", "td-card-meta", fmtKm(it.lengthM) + " · " + (TrackThemes.get(it.theme).label || it.theme) + " · " + (it.turns ? it.turns.length : 0) + " corners");
      const row = el("div", "td-chips");
      row.append(
        btn("EDIT", "sel-chip", () => { const kept = load(it, "library", it.id); showPane("design"); message("Editing " + it.name + keptNote(kept)); }),
        btn("RACE", "sel-chip", () => raceId(it.id, "gp")),
        btn(confirmDel === it.id ? "DELETE?" : "DELETE", "sel-chip", () => {
          if (confirmDel !== it.id) { confirmDel = it.id; renderLibrary(); return; }
          confirmDel = null; custom!.remove(it.id);
          if (design && design.id === it.id) delete design.id;
          if (design && design.originId === it.id) delete design.originId;
          renderLibrary(); message("Deleted " + it.name);
        }),
      );
      card.append(c, name, meta, row);
      ui.lib.appendChild(card);
    }
  }

  // ── lifecycle (designer.js:1624) ──────────────────────────────────────────
  /** designer.js:1625 */
  function init(G_?: DesignerGame | null, initDeps?: { custom?: CustomTracksApi | null; root?: HTMLElement | null } | null) {
    G = G_ || G; custom = (initDeps && initDeps.custom) || custom || null;
    // `|| root`: a mounted screen keeps its element when CustomTracks.ensureEditor() re-inits it without one.
    root = (initDeps && initDeps.root) || root || document.getElementById("trackdesigner");
    if (!root || !custom) { Log.warn("track", "track designer: no #trackdesigner dialog in this shell"); return false; }
    build();
    if (!lifecycleWired) {
      const flush = () => { if (!draftT) return; saveDraft(); const st = deps.store; if (st && st.mirrorFlush) st.mirrorFlush(); };
      if (typeof window !== "undefined" && (window as Partial<Window>).addEventListener) listen(window, "pagehide", flush);
      if ((document as Partial<Document>).addEventListener) listen(document, "visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
      lifecycleWired = true;
    }
    return true;
  }
  function onBack(ev: KeyboardEvent) {
    if (workspace && workspace.closeMenu(ev)) return;
    if (ev.type === "keydown" && (ev.key === "z" || ev.key === "Z") && (ev.ctrlKey || ev.metaKey)) {
      if (!openFlag) return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      ev.preventDefault();
      if (ev.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (profileBack(ev)) return;
    if (!openFlag || !canvas || sel < 0 || document.activeElement !== canvas) return;
    if (ev.type === "keydown" && ev.key !== "Escape") return;
    ev.preventDefault(); ev.stopPropagation();
    sel = -1; span = -1;
    if (cv) cv.setSelection(sel, span);
    refreshControls();
    const first = (ui.modes && ui.modes.children[0]) || (ui.tools && ui.tools.children[0]);
    if (first) (first as HTMLElement).focus();
  }
  /** designer.js:1658 */
  function open(opts?: OpenOpts | null) {
    ++replacementGeneration;
    if (!built && !init()) return false;
    // A share link opened while the screen is up (hashchange) must not make
    // close() hand focus back into the hidden dialog.
    if (!openFlag) returnFocus = document.activeElement;
    if (cv) cv.reset();
    // A fresh page has the player's unsaved draft only on disk: bring it in
    // first, so a share link's design replaces it through stash(), not over it.
    if (!design && opts && opts.design) {
      const it = draftItem();
      if (it) { load(it, "draft", it.originId); if (!custom!.get(it.id)) savedSnap = null; }
    }
    if (opts && opts.design) { const kept = load(opts.design, "open", opts.shared ? null : opts.originId); if (opts.shared) message("Shared circuit loaded — SAVE to keep it in MY CIRCUITS" + keptNote(kept)); }
    else if (!design) {
      const it = draftItem();
      if (it) { load(it, "draft", it.originId); if (!custom!.get(it.id)) savedSnap = null; message("Draft restored"); }
      else { design = blank(); afterChange("blank"); randomise(design.seed); randomisedOnOpen = true; }
    }
    root!.hidden = false; openFlag = true; checksSaid = null;
    showPane("design");
    hideCtx();
    showCoach();
    confirmDel = null;
    Log.info("track", "designer open");
    // Boxes exist only once TopModal's observer has opened the dialog (a
    // microtask after the hidden flip): size and fit the canvas then.
    requestAnimationFrame(() => { if (openFlag && cv) { cv.resize(); cv.fit(); } });
    // Focus the first-open card's HOW TO while the card is up: focusing the first
    // tool chip scrolled a phone's rail past the card (portrait, 412x915, measured).
    queueMicrotask(() => {
      if (!openFlag) return;
      // Prefer MODE tabs so the coach (docked below) never steals the first focus scroll.
      const first = (ui.modes && ui.modes.firstChild) || (ui.coach && ui.coachFirst) || (ui.tools && ui.tools.firstChild);
      if (first) (first as HTMLElement).focus();
    });
    schedulePreview();
    if (opts && opts.resume) resume(opts.resume);
    return true;
  }
  /** designer.js:1698 */
  function close() {
    if (!root || !openFlag) return;
    ++replacementGeneration;   // pending single-circuit reads/decodes no longer own this visit
    saveDraft();
    cancelLibraryImport(false);
    if (repair) repair.cancel();
    if (cv) cv.reset();
    hideCtx();
    // The card is a one-time note: seen for one visit is enough (GOT IT also stores it).
    if (ui.coach) dismissCoach(false);
    randomisedOnOpen = false;
    root.hidden = true; openFlag = false;
    Log.info("track", "designer close");
    if (returnFocus && returnFocus.isConnected && (returnFocus as HTMLElement).focus) (returnFocus as HTMLElement).focus();
    returnFocus = null;
  }
  /** designer.js:1714 */
  const isOpen = () => openFlag;
  /** For tests and the agent: a plain snapshot of what the screen shows. designer.js:1716 */
  function state() {
    return {
      open: openFlag, tool, mode, sel, span, selectionMode, spanArm: !!spanArm, pending: !!previewT, propKind,
      design: design ? copy(design) : null,
      ok: !!(verdict && verdict.ok), red: verdict ? verdict.red : null, amber: verdict ? verdict.amber : null,
      issues: verdict ? verdict.issues.map((i) => i.code + ":" + i.level) : [],
      stats: verdict && verdict.stats ? copy(verdict.stats) : null,
      lengthM: verdict && verdict.tr ? Math.round(verdict.tr.total) : null,
      undo: undo.length, redo: redo.length, library: custom ? custom.list().map((i) => i.id) : [],
      lastCode,
      corners: ins.map((c) => ({ n: c.n, dir: c.dir, angDeg: Math.round(c.angDeg), R: Math.round(c.R), kmh: Math.round(c.vApex! * 3.6), lenM: Math.round(c.lenM), i0: c.i0, i1: c.i1, fit: c.fit ? copy(c.fit) : null })),
      heat: heatOn, elevationHeat: heightHeatOn,
      candidates: cands.map((c) => ({ seed: c.seed >>> 0, score: +c.score.toFixed(3) })),
      thumbs: { cached: thumbTr.size, maxPts: Math.max(0, ...[...thumbTr.values()].map((t) => t.n)) },
      coach: !!ui.coach,
    };
  }

  // ── insight: TURNS, SPEED, TRACK OF THE DAY, START FROM (TrackInsight) (designer.js:1734) ──
  // ins: the TURNS rows of the last preview; heatV: its per-node speeds (m/s).
  let ins: Corner[] = [], heatOn = false, heightHeatOn = false, heatV: Float64Array | null = null, fromJob = 0;
  // START FROM: def id → the OUTLINE DesignerCanvas.thumb strokes ({ px, pz, n }, at most
  // THUMB_PTS points), built once. It held each whole line-less centreline: 52 circuits,
  // ~4 MB pinned for the page after the panel opened once, for a 160×110 card.
  const thumbTr = new Map<string, { px: Float32Array; pz: Float32Array; n: number }>(), THUMB_PTS = 256;
  function thumbOutline(tr: Track) {
    const step = Math.max(1, Math.ceil(tr.n / THUMB_PTS)), n = Math.ceil(tr.n / step);
    const px = new Float32Array(n), pz = new Float32Array(n);
    for (let k = 0; k < n; k++) { px[k] = tr.px[k * step]!; pz[k] = tr.pz[k * step]!; }
    return { px, pz, n };
  }
  const insight = () => TrackInsight;
  /** The 4 DETAILS rows become [RANDOMISE][TRACK OF THE DAY][START FROM…] over
   *  [REVERSE]…[FIT VIEW][SPEED]; the START FROM cards and a TURNS group after 5 CHECKS. designer.js:1750 */
  function buildInsight(pane: HTMLElement, circuit: Group, actions: HTMLDivElement, before: Group) {
    const seedRow = el("div", "td-chips"); ui.seedRow = seedRow;
    ui.totd = btn("TRACK OF THE DAY", "sel-chip", () => trackOfTheDay());
    ui.fromBtn = btn("START FROM…", "sel-chip", () => toggleStartFrom());
    ui.fromBtn.setAttribute("aria-expanded", "false");
    ui.randomise.remove();                              // moves up from the actions row
    seedRow.append(ui.randomise, ui.totd, ui.fromBtn);
    circuit.insertBefore(seedRow, actions);
    ui.heat = btn("SPEED", "sel-chip", () => toggleHeat());
    ui.heat.setAttribute("aria-pressed", "false");
    ui.heat.setAttribute("aria-label", "Speed map: colour the road slow (yellow) to fast (purple)");
    // SPEED sits before TEST HERE (#766 appends that chip last; the doc reads "… FIT VIEW · SPEED · TEST HERE").
    actions.insertBefore(ui.heat, ui.testHere && ui.testHere.parentNode === actions ? ui.testHere : null);
    ui.from = el("div", "td-grid"); ui.from.hidden = true; ui.from.setAttribute("aria-label", "Start from a real circuit");
    circuit.appendChild(ui.from);
    const turns = group("TURNS"); ui.turnsGroup = turns;
    ui.turns = el("ul", "td-issues"); ui.turns.setAttribute("aria-label", "Corners, in driving order");
    turns.appendChild(ui.turns);
    pane.appendChild(DesignerFollowup.learningPanel({ el, btn }).root);
    pane.insertBefore(turns, before);
  }
  const fmtTurn = (c: Corner) => "T" + c.n + " · " + (c.dir < 0 ? "RIGHT " : "LEFT ") + Math.round(Math.abs(c.angDeg)) + "° · R " + Math.round(c.R) + " m · " + Math.round(c.vApex! * 3.6) + " km/h · " + Math.round(c.lenM) + " m" + turnTags(c);
  /** After each preview: the TURNS rows and, while SPEED is on, the road's colours. designer.js:1773 */
  function renderInsight() {
    const I = insight(), tr = verdict && verdict.tr;
    heatV = I && tr ? I.speedProfile(tr) : null;
    ins = I && tr ? I.corners(tr, design!.pts, heatV, verdict!.turns) : [];
    refreshHeat();
    refreshAuthoring();
    if (!ui.turns) return;
    while (ui.turns.firstChild) ui.turns.removeChild(ui.turns.firstChild);
    if (!ins.length) { const li = el("li", "td-issue", tr ? "No corners yet" : "Build a loop to list its corners"); li.dataset.level = "info"; ui.turns.appendChild(li); return; }
    for (const c of ins) {
      const li = el("li", "td-issue", fmtTurn(c)); li.dataset.level = "info"; li.tabIndex = 0;
      li.setAttribute("aria-label", fmtTurn(c).replace(/·/g, ",") + ". Select to reshape it with the " + (c.fit ? c.fit.kind : "corner") + " tool");
      li.addEventListener("click", () => selectCorner(c.n));
      li.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectCorner(c.n); } });
      ui.turns.appendChild(li);
    }
  }
  /** A TURNS row: select its control span, centre on the apex, and prefill the
   *  CORNER (or HAIRPIN) tool with the arc that fits the span — 2 CORNERS then
   *  offers REPLACE THE SELECTED SPAN. No data-model field: the fit is the record. designer.js:1793 */
  function selectCorner(n: number) {
    if (previewT || !verdict) runPreview();
    const c = ins.find((x) => x.n === n);
    if (!c || !(c.i0! >= 0) || !(c.i1! >= 0) || !c.fit) { message("Turn " + n + " cannot be selected", true); return false; }
    sel = c.i0!; span = c.i1!;
    params = Object.assign({}, params, { R: c.fit.R, dir: c.fit.dir }, c.fit.kind === "corner" ? { deg: c.fit.deg } : {});
    if (cv) { cv.setSelection(sel, span); cv.focusAt(c.sApex); }
    if (mode !== "elevation" && mode !== "test") setTool(c.fit.kind);
    refreshControls();
    message("T" + n + (mode === "elevation" ? " selected — set BANK ° below" : mode === "test" ? " selected — TEST HERE to drive this section" : " selected — tune it and press REPLACE THE SELECTED SPAN"));
    return true;
  }
  function refreshHeat() {
    for (const [button, on] of [[ui.heat, heatOn], [ui.heightHeat, heightHeatOn]] as const) if (button) {
      button.setAttribute("aria-pressed", String(on)); button.classList.toggle("active", on);
    }
    if (cv && cv.setHeat) cv.setHeat(heightHeatOn ? verdict && verdict.tr && verdict.tr.py : heatOn ? heatV : null, heightHeatOn ? "elevation" : "speed");
  }
  /** designer.js:1811 */
  function toggleHeat(on?: boolean | null) {
    heatOn = on == null ? !heatOn : !!on;
    if (heatOn) heightHeatOn = false;
    refreshHeat();
    return heatOn;
  }
  /** designer.js:1817 */
  function toggleElevationHeat(on?: boolean | null) {
    heightHeatOn = on == null ? !heightHeatOn : !!on;
    if (heightHeatOn) heatOn = false;
    refreshHeat();
    return heightHeatOn;
  }
  /** TRACK OF THE DAY: the same RANDOMISE seed for everyone on one UTC day. designer.js:1824 */
  function trackOfTheDay(day?: unknown) {
    const I = insight(); if (!I) return false;
    const seed = I.totdSeed(day), ok = randomise(seed);
    if (ok) message("Track of the day (" + I.dayKey(day) + ") — seed " + seed);
    return ok;
  }
  /** START FROM: a shipped circuit traced into a new design (one UNDO entry; SAVE adds, never replaces). designer.js:1831 */
  function startFrom(id: string) {
    const I = insight();
    const def = trackList().find((t) => t.id === id && !t.custom);
    if (!I || !def) { message("That circuit is not available", true); return false; }
    let f: ReturnType<typeof TrackInsight.fromCircuit> = null;
    try { f = I.fromCircuit(def); } catch (e) { Log.warn("track", "start from " + id + " failed: " + (e && (e as Error).message || e)); f = null; }
    if (!f || f.pts.length < CustomTracks.LIMITS.ptsMin) { message("Could not trace " + def.name, true); return false; }
    sel = -1; span = -1;
    commit(Object.assign(freshLoop(design!, f.pts, (Date.now() % 4294967296) >>> 0), { baseHW: f.baseHW, name: CustomTracks.sanitizeName(def.name + " REMIX") }), "seed:" + id);
    if (ui.name) ui.name.value = design!.name;
    if (cv) cv.fit();
    if (ui.from) { ui.from.hidden = true; ui.fromBtn.setAttribute("aria-expanded", "false"); }
    message(def.name + " traced — make it yours, UNDO to go back");
    return true;
  }
  /** designer.js:1846 */
  function toggleStartFrom() {
    if (!ui.from) return false;
    const open = ui.from.hidden;
    ui.from.hidden = !open; ui.fromBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderStartFrom();                        // cheap: the outlines are memoised
    return open;
  }
  /** One card per shipped circuit; the outlines draw ONE per frame from a
   *  memoised line-less build (DesignerCanvas.thumb — never TrackMaps' baked line). designer.js:1855 */
  function renderStartFrom() {
    while (ui.from.firstChild) ui.from.removeChild(ui.from.firstChild);
    const job = ++fromJob, queue: [HTMLCanvasElement, BuiltDef][] = [];
    for (const def of trackList()) {
      if (def.custom) continue;
      const card = el("div", "td-card");
      const c = el("canvas"); c.width = 160; c.height = 110; c.setAttribute("aria-hidden", "true");
      const meta = el("div", "td-card-meta", (+def.lengthKm || 0).toFixed(2) + " km · " + ((def.turns && def.turns.length) || 0) + " corners");
      const go = btn(def.name, "sel-chip", () => startFrom(def.id));
      go.setAttribute("aria-label", "Start from " + def.name);
      card.append(c, meta, go);
      ui.from.appendChild(card);
      queue.push([c, def]);
    }
    const next = () => {
      if (job !== fromJob || !queue.length || ui.from.hidden) return;   // closed: the next open starts over
      const [c, def] = queue.shift()!;
      try {
        let tr = thumbTr.get(def.id);
        if (!tr) { tr = thumbOutline(Tracks.buildCenterline(def, { line: false })); thumbTr.set(def.id, tr); }
        DesignerCanvas.thumb(c, tr as unknown as DesignerCanvas.ThumbTrack, { color: "#f6f6f9", width: 2 });
      } catch (e) { Log.warn("track", "start-from thumbnail " + def.id + " failed: " + (e && (e as Error).message)); }
      requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }

  // ── authoring: SPIRAL m, SPAN WIDTH m, the SELECTED TURN's BANK ° (designer.js:1882) ─────────
  // No data-model field: SPIRAL is a stamp parameter (TrackStamps.spiralSweep),
  // SPAN WIDTH writes an hwZone and BANK a bankZone — the shapes sanitize and
  // the share code already carry. Neither zone kind is a REMAP edit: the
  // control points do not move, and a later insert / delete / stamp carries
  // the zone along through remapZones (zoneMap.range / pt).
  const ZONE_EPS = 1e-9;
  /** 2 CORNERS: SPIRAL m before the direction chips (the curved kinds only);
   *  4 DETAILS: SPAN WIDTH m under HALF-WIDTH; TURNS: a SELECTED TURN block. designer.js:1891 */
  function buildAuthoring() {
    ui.spiral = stepper("SPIRAL m", () => params.Ls || 0, (v) => { params.Ls = clampParam("Ls", v); refreshControls(); }, 5);
    ui.shape.insertBefore(ui.spiral, ui.dirL.parentNode);
    // Right after HALF-WIDTH (children indexes in the browser and in the test DOM alike).
    const box = ui.width.parentNode as HTMLElement, at = Array.prototype.indexOf.call(box.children, ui.width);
    ui.spanW = stepper("SPAN WIDTH m", spanHW, (v) => setSpanWidth(v), 0.1, (v) => (hasSpan() ? v.toFixed(1) : "—"));
    box.insertBefore(ui.spanW, box.children[at + 1] || null);
    ui.turnPick = el("div"); ui.turnPick.hidden = true; ui.turnPick.setAttribute("role", "group"); ui.turnPick.setAttribute("aria-label", "Selected turn");
    ui.turnPickLabel = el("div", "td-label", "SELECTED TURN");
    ui.bank = stepper("BANK °", pickedBank, (v) => { const c = pickedTurn(); if (c) setCornerBank(c, v); }, 2, (v) => (v > 0 ? v + "°" : "FLAT"));
    ui.turnPick.append(ui.turnPickLabel, ui.bank);
    ui.turns.parentNode!.appendChild(ui.turnPick);
  }
  /** The stepper's − and + (stepper() builds label, −, value, +). */
  const stepBtns = (row: StepperRow) => [row.children[1]!, row.children[3]!];
  function refreshAuthoring() {
    if (!built || !design || !ui.spiral) return;
    const kind = stampKind(tool), curved = !!(kind && "Ls" in kind.params);
    ui.spiral.hidden = !curved;
    if (curved) { params.Ls = clampParam("Ls", params.Ls != null ? params.Ls : kind!.params.Ls!); ui.spiral._refresh(); }
    const on = hasSpan();
    ui.spanW.setAttribute("aria-disabled", on ? "false" : "true");
    for (const b of stepBtns(ui.spanW)) b.setAttribute("aria-disabled", on ? "false" : "true");
    ui.spanW._refresh();
    const c = pickedTurn();
    ui.turnPick.hidden = !c || mode !== "elevation";
    if (c) { ui.turnPickLabel.textContent = "SELECTED TURN · T" + c.n; ui.bank._refresh(); }
  }
  // SPAN WIDTH: the span sel → span in driving order (REPLACE's span), as
  // control-polygon arc fractions — the frame remapZones keeps and toRaw maps
  // to the engine's index fractions (CustomTracks.arcToIndexFrac).
  function spanFracs(): [number, number] | null {
    const c = cumArc(design!.pts), L = c[design!.pts.length]!;
    return L > 0 ? [c[sel]! / L, c[span]! / L] : null;
  }
  /** Two lap ranges share road (s1 < s0 runs over the line; touching ends do not count). */
  function rangesOverlap(a0: number, a1: number, b0: number, b1: number) {
    const len = (x0: number, x1: number) => wrap01(x1 - x0);
    const inside = (x: number, x0: number, x1: number) => { const d = wrap01(x - x0); return d > ZONE_EPS && d < len(x0, x1) - ZONE_EPS; };
    return Math.abs(wrap01(a0 - b0 + 0.5) - 0.5) < ZONE_EPS || inside(b0, a0, a1) || inside(a0, b0, b1);
  }
  function spanHW() {
    if (!design) return 7;
    const f = hasSpan() ? spanFracs() : null;
    const z = f && (design.hwZones || []).find((q) => rangesOverlap(f[0], f[1], q.s0, q.s1));
    return z ? z.hw : design.baseHW;
  }
  /** Narrow the selected span to half-width hw (5 m … the base): one hwZone,
   *  replacing any it overlaps; the base width clears it. The engine only ever
   *  narrows (def.js applyHwZones keeps the smaller), so the base is the top. designer.js:1941 */
  function setSpanWidth(hw: number) {
    if (!hasSpan()) { message("Select a span first: tap a point, then shift-tap a second (or tap a row under TURNS)", true); return false; }
    const LIM = CustomTracks.LIMITS, base = design!.baseHW;
    hw = Math.round(Math.min(base, Math.max(LIM.hwMin, Number.isFinite(+hw) ? +hw : base)) * 10) / 10;
    const [s0, s1] = spanFracs()!, had = design!.hwZones || [];
    const keep = had.filter((z) => !rangesOverlap(s0, s1, z.s0, z.s1));
    if (hw !== base && keep.length >= LIM.zones) { message("A circuit keeps " + LIM.zones + " width zones at most — set one back to the base width first", true); return false; }
    // The taper: no steeper than 1 m of half-width per 20 m (×1.5), never under the engine's 0.025 default.
    const Lb = verdict && verdict.tr ? verdict.tr.total : S.polyLen(design!.pts);
    const ease = Math.round(Math.min(0.2, Math.max(0.005, Math.max(0.025, 1.5 * 20 * Math.abs(hw - base) / Lb))) * 1000) / 1000;
    const next = hw === base ? keep : keep.concat([{ s0, s1, hw, ease }]);
    if (JSON.stringify(next) === JSON.stringify(had)) return false;
    commit(Object.assign({}, design!, { hwZones: next }), "zone:hw");
    message(hw === base ? "Span back to the full " + (2 * base).toFixed(1) + " m" : "Span narrowed to " + (2 * hw).toFixed(1) + " m wide — UNDO to revert");
    return true;
  }
  // BANK: the selected TURNS row (its span is the selection) banked at its
  // apex — frac on the BUILT lap, the frame mesh.js bankingProfile paints in,
  // widthM the corner's own length. The engine's re-seat snaps a loose zone to
  // the nearest apex; this one already sits on it.
  const lapDist = (a: number, b: number, L: number) => { const d = Math.abs(a - b) % L; return Math.min(d, L - d); };
  function pickedTurn() { return hasSpan() ? ins.find((c) => c.i0 === sel && c.i1 === span) || null : null; }
  function bankNear(c: Corner, L: number, reach: (z: BankZoneRec) => number) { return (design!.bankZones || []).find((z) => lapDist(z.frac * L, c.sApex, L) < reach(z)) || null; }
  function pickedBank() {
    const c = pickedTurn(), tr = verdict && verdict.tr;
    const z = c && tr ? bankNear(c, tr.total, (q) => Math.max(q.widthM / 2, c.lenM / 2)) : null;
    return z ? z.angleDeg : 0;
  }
  /** Bank turn `row` (a TURNS row, or its number) at `deg` (0 = flat, else 2 … 30). designer.js:1970 */
  function setCornerBank(row: Corner | number, deg: number) {
    if (previewT || !verdict) runPreview();
    const c = typeof row === "number" ? ins.find((x) => x.n === row) : row, tr = verdict && verdict.tr;
    if (!c || !tr || !Number.isFinite(c.sApex)) { message("Select a turn under TURNS first", true); return false; }
    const L = tr.total, LIM = CustomTracks.LIMITS, had = design!.bankZones || [];
    deg = Math.round(Math.min(LIM.angleDeg, Math.max(0, +deg || 0)));
    if (deg < 2) deg = 0;
    const keep = had.filter((z) => !(lapDist(z.frac * L, c.sApex, L) < c.lenM / 2));
    if (deg && keep.length >= LIM.zones) { message("A circuit keeps " + LIM.zones + " banked corners at most — flatten one first", true); return false; }
    const next = deg ? keep.concat([{ frac: wrap01(c.sApex / L), angleDeg: deg, widthM: Math.round(Math.min(600, Math.max(20, c.lenM))) }]) : keep;
    if (JSON.stringify(next) === JSON.stringify(had)) return false;
    commit(Object.assign({}, design!, { bankZones: next }), "zone:bank");
    const I = insight(), fiaMax = I && I.THRESH ? I.THRESH.bankDeg : 5.7;
    message("T" + c.n + (deg ? " banked " + deg + "°" + (deg > fiaMax ? " — over the FIA's " + fiaMax + "°" : "") : " is flat again"));
    return true;
  }
  /** Whole-circuit kerb ribbon: flat / sausage / rumble (mesh.js buildKerbs). designer.js:1987 */
  function setKerbStyle(style: string) {
    if (!design) return false;
    const next = KERB_STYLES.includes(style) ? style : "flat";
    if (kerbOf(design) === next) return false;
    commit(Object.assign({}, design, { kerbStyle: next }), "kerb:" + next);
    message("Kerb style: " + next.toUpperCase() + " — UNDO to revert");
    return true;
  }
  /** Berms on the outer side of banked corners (surface.js). Default ON. designer.js:1996 */
  function setBerms(on: boolean) {
    if (!design) return false;
    const want = !!on;
    if (bermsOn(design) === want) return false;
    const next = Object.assign({}, design);
    if (want) {
      if ((design.bankZones || []).length) next.berms = true;
      else delete next.berms;
    } else {
      next.berms = false;
    }
    commit(next, want ? "berms:on" : "berms:off");
    message(want ? "Berms ON for banked corners" : "Berms OFF — UNDO to revert");
    return true;
  }
  /** "· BANK 6° · 12.6 m WIDE" on a TURNS row whose apex carries a zone. */
  function turnTags(c: Corner) {
    return (c.bankDeg! > 0 ? " · BANK " + Math.round(c.bankDeg!) + "°" : "") + (c.hwSpan != null ? " · " + +(2 * c.hwSpan).toFixed(1) + " m WIDE" : "");
  }

  // ── elevation: per-node heights[] + the strip (DesignerProfile) (designer.js:2016) ──
  // Control points stay [x, z]; heights[i] is metres at point i (0.25 m lattice).
  // Presets write heights and clear legacy cosine elevations so the strip matches
  // the road. Old saves without heights load flat (ensureHeights).
  let prof: ReturnType<typeof DesignerProfile.create> | null = null;
  function buildProfile(stage: HTMLElement) {
    if (!stage) return;
    ui.profile = el("canvas");
    ui.profile.setAttribute("data-role", "profile"); // queryable in tests + CSS
    ui.profile.setAttribute("aria-label", "Elevation profile");
    // Under the main canvas, above stats — always mounted (CSS keeps it on phone).
    stage.insertBefore(ui.profile, ui.stats);
    prof = DesignerProfile.create(ui.profile, {
      rangeSelect: () => selectionMode === "range",
      extendSelection: () => spanArm,
      onChange: (i: number, h: number, live: boolean, all?: number[] | null) => {
        if (live) return;
        if (Array.isArray(all)) setHeights(all, i);
        else setNodeHeight(i, h);
      },
      onSelect: (i: number, j: number) => {
        if (i >= 0) {
          sel = i;
          span = (Number.isInteger(j) && j !== i) ? j : -1;
          if (span >= 0) spanArm = false;
          if (cv) cv.setSelection(sel, span);
        } else {
          sel = -1; span = -1;
          if (cv) cv.setSelection(sel, span);
        }
        refreshControls(); revealSelectionHeight();
      },
    });
  }
  /** Per-node height lattice (same as ElevPresets.clampH / the strip). */
  function elevH(h: unknown) {
    return ElevPresets.clampH(h);
  }
  /** Replace the whole heights[] array (group elev from the strip). Keeps sel/span. designer.js:2055 */
  function setHeights(list: readonly number[], anchor?: number) {
    if (!design || !Array.isArray(list)) return false;
    ensureHeights(design);
    const next = design.pts.map((_, k) => elevH(k < list.length ? list[k] : 0));
    let same = next.length === design.heights.length;
    if (same) for (let k = 0; k < next.length; k++) if (next[k] !== design.heights[k]) { same = false; break; }
    if (Number.isInteger(anchor) && anchor! >= 0 && anchor! < design.pts.length && !(hasSpan() && TrackShape.inSpan(anchor!, sel, span, design.pts.length))) sel = anchor!;
    if (same) {
      if (cv) cv.setSelection(sel, span);
      if (prof) { if (prof.setSelection) prof.setSelection(sel, span); else prof.select(sel); }
      refreshControls();
      return false;
    }
    commit(Object.assign({}, design, { heights: next, elevations: [] }), hasSpan() ? "elev:span" : "elev:node");
    if (prof) { if (prof.setSelection) prof.setSelection(sel, span); else prof.select(sel); }
    return true;
  }
  /** designer.js:2072 */
  function setNodeHeight(i: number, h: number) {
    if (!design || !(i >= 0 && i < design.pts.length)) return false;
    ensureHeights(design);
    const v = elevH(h);
    const keepSpan = hasSpan() && TrackShape.inSpan(i, sel, span, design.pts.length);
    // POINT m / single-node edit: when a SPAN is selected and the anchor is in
    // it, offset every grip in the group by the same delta (relative hills stay).
    if (keepSpan) {
      const group = TrackShape.spanIndices(sel, span, design.pts.length);
      const values = group.map(j => elevH(design!.heights[j] || 0));
      const limit = CustomTracks.LIMITS.rise;
      const dh = Math.max(-limit - Math.min(...values), Math.min(limit - Math.max(...values), v - elevH(design.heights[i] || 0)));
      if (dh === 0) { refreshControls(); return false; }
      const next = design.heights.slice();
      for (const j of group) next[j] = elevH((next[j] || 0) + dh);
      commit(Object.assign({}, design, { heights: next, elevations: [] }), "elev:span");
      if (prof && prof.setSelection) prof.setSelection(sel, span);
      return true;
    }
    const next = design.heights.slice();
    // Keep the screen selection on this node so POINT m / strip stay in sync.
    sel = i; span = -1; spanArm = false;
    if (next[i] === v) {
      if (cv) cv.setSelection(sel, span);
      if (prof) { if (prof.setSelection) prof.setSelection(sel, span); else prof.select(i); }
      refreshControls();
      return false;
    }
    next[i] = v;
    // Clear legacy cosine hills so they do not stack on node heights.
    commit(Object.assign({}, design, { heights: next, elevations: [] }), "elev:node");
    if (prof) { if (prof.setSelection) prof.setSelection(sel, span); else prof.select(i); }
    return true;
  }
  /** designer.js:2106 */
  function applyElevPreset(style: string) {
    if (!design || !design.pts.length) { message("Draw or randomise a loop first", true); return false; }
    const r = ElevPresets.apply(style, design.pts, { seed: design.seed });
    commit(Object.assign({}, design, { heights: r.heights, elevations: [] }), "elev:" + r.style);
    message(r.style === "flat" ? "Elevation cleared (flat)" : "Applied " + r.style.toUpperCase() + " elevation — UNDO to revert");
    if (mode !== "elevation") setMode("elevation");
    return true;
  }
  function syncProfile() {
    if (!prof || !design) return;
    ensureHeights(design);
    if (prof.setHeights) prof.setHeights(design.heights);
    const tr = verdict && verdict.tr, pts = design.pts;
    let at: number | null = null;
    if (tr && sel >= 0 && sel < pts.length) { const c = cumArc(pts); at = c[sel]! / (c[pts.length] || 1) * tr.total; }
    prof.setCursor(at);
    if (prof.setSelection || sel >= 0) {
      if (prof.setSelection) prof.setSelection(sel, span);
      else prof.select(sel);
    }
  }
  function renderProfile() {
    if (!prof) return;
    prof.setBuilt(verdict && verdict.tr, heatV, design && design.pts);
    prof.setIssues((verdict ? verdict.issues : []) as unknown as readonly DesignerProfile.ProfileIssue[]);
    syncProfile();
  }
  function profileBack(ev: KeyboardEvent) {
    if (!openFlag || !prof || !ui.profile || document.activeElement !== ui.profile || prof.selected() < 0) return false;
    if (ev.type === "keydown" && ev.key !== "Escape") return false;
    ev.preventDefault(); ev.stopPropagation();
    prof.select(-1);
    refreshControls();
    return true;
  }

  // ── DESIGNED RANDOMISE: FAST / TECHNICAL / MIXED, USE, MORE LIKE THIS (designer.js:2143) ──
  // cands: the cards on show ({ seed, pts, score, feats, tr, stats }, best
  // first); candJob: the run in flight (a newer press drops an older one).
  type Cand = { seed: number; pts: Pt[]; score: number; feats: TrackInsight.Features | undefined; tr: Track | null; stats: Stats | null };
  const DESIGN_N = 16, DESIGN_SLICES = 4, DESIGN_STYLES = ["FAST", "TECHNICAL", "MIXED"];
  let cands: Cand[] = [], candStyle: string | null = null, candJob = 0, candThumbJob = 0, candBusy = false;
  /** Under the RANDOMISE row's group: [FAST][TECHNICAL][MIXED] and the candidate cards. designer.js:2149 */
  function buildDesigned(circuit: Group) {
    ui.styleRow = el("div", "td-chips");
    ui.styles = {};
    for (const st of DESIGN_STYLES) {
      const b = btn(st, "sel-chip", () => designed(st));
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-label", st + ": design " + DESIGN_N + " circuits and show the best four");
      ui.styles[st] = b; ui.styleRow.appendChild(b);
    }
    ui.cands = el("div", "td-grid"); ui.cands.hidden = true; ui.cands.setAttribute("aria-label", "Designed circuits, best first");
    ui.candidateSection = el("div");
    ui.from.remove();
    ui.candidateSection.append(ui.from, ui.styleRow, ui.cands);
    circuit.appendChild(ui.candidateSection);
  }
  function setDesignBusy(on: boolean) {
    candBusy = on;
    if (ui.cands) { if (on) ui.cands.setAttribute("aria-busy", "true"); else ui.cands.removeAttribute("aria-busy"); }
    if (ui.styles) for (const st of DESIGN_STYLES) ui.styles[st]!.disabled = on;
  }
  /** `slices` synchronous steps, each on its own timer (the first after 30 ms so
   *  the busy state paints), then done() → the Promise's value. A newer run
   *  supersedes this one (false). designer.js:2172 */
  function runSliced(text: string, slices: number, work: (k: number) => void, done: () => boolean): Promise<boolean> {
    const job = ++candJob;
    setDesignBusy(true); message(text);
    return new Promise((resolve) => {
      let k = 0;
      const step = () => {
        if (job !== candJob) { resolve(false); return; }
        try { work(k); } catch (e) {
          Log.warn("track", "designed randomise failed: " + (e && (e as Error).message || e));
          setDesignBusy(false); message("Could not design circuits — RANDOMISE instead", true); resolve(false); return;
        }
        if (++k < slices) { setTimeout(step, 0); return; }
        setDesignBusy(false);
        resolve(done());
      };
      setTimeout(step, 30);
    });
  }
  /** FAST / TECHNICAL / MIXED: DESIGN_N seeds (from `seed`, default the design's
   *  own) validated, scored for the style, the best four as cards. Promise<bool>. designer.js:2192 */
  function designed(style: string, seed?: number): Promise<boolean> {
    const I = insight();
    if (!I || !I.rate || !TrackRandom.designOne || !(TrackRandom.STYLES as { readonly [k: string]: unknown })[style] || !design) return Promise.resolve(false);
    const s0 = design.seed >>> 0;
    const baseSeed = Number.isFinite(seed) ? seed! >>> 0 : (Math.imul(s0 ^ (s0 >>> 13), 0x2c1b3c6d) + 0x6a09e667) >>> 0;
    candStyle = style;
    for (const st of DESIGN_STYLES) { const on = st === style; ui.styles[st]!.setAttribute("aria-pressed", on ? "true" : "false"); ui.styles[st]!.classList.toggle("active", on); }
    const opts = { tries: 3, base: cleanBase(design), check: TrackValidate.check, score: I.rate as (v: TrackValidate.Verdict, style: unknown) => ReturnType<typeof I.rate> };
    const per = Math.ceil(DESIGN_N / DESIGN_SLICES), found: (TrackRandom.DesignCandidate<TrackValidate.Verdict> | null)[] = [];
    return runSliced("Designing " + DESIGN_N + " circuits…", DESIGN_SLICES, (k) => {
      for (let i = k * per; i < Math.min(DESIGN_N, (k + 1) * per); i++) found.push(TrackRandom.designOne(baseSeed, i, style, opts));
    }, () => {
      cands = TrackRandom.rank(found, 4) as Cand[];
      renderCandidates();
      message(cands.length ? style + ": the best " + cands.length + " of " + DESIGN_N + " — USE one, or MORE LIKE THIS" : "No clean " + style + " circuit in " + DESIGN_N + " seeds — press it again", !cands.length);
      return cands.length > 0;
    });
  }
  /** USE: the card's circuit becomes the design (one UNDO entry; SAVE adds a new circuit). designer.js:2211 */
  function useCandidate(i: number) {
    const c = cands[i];
    if (!c || candBusy || !design) return false;
    sel = -1; span = -1;
    commit(freshLoop(design, c.pts.map((p): Pt => [p[0], p[1]]), c.seed >>> 0), "randomise");
    if (cv) cv.fit();
    message("Design " + (i + 1) + " loaded — seed " + (c.seed >>> 0) + ", UNDO to go back");
    return true;
  }
  /** MORE LIKE THIS: four nudges of the card's loop (TrackRandom.mutate, seeds
   *  Hash32.mix(seed + j)), validated, re-scored for the style, as the new cards. designer.js:2222 */
  function moreLikeThis(i: number): Promise<boolean> {
    const c = cands[i], I = insight();
    if (!c || candBusy || !I || !TrackRandom.mutate || !design) return Promise.resolve(false);
    const style = candStyle || "MIXED", base = cleanBase(design), found: Cand[] = [];
    return runSliced("Designing 4 circuits like design " + (i + 1) + "…", 4, (j) => {
      const seed = Hash32.mix((c.seed + j) >>> 0);
      const m = TrackRandom.mutate(c.pts, seed, { check: (pts) => TrackValidate.check(Object.assign({}, base, { pts })) });
      if (!m.ok || !m.verdict) return;
      const r = I.rate(m.verdict, style);
      found.push({ seed, pts: m.pts, score: r.score, feats: r.feats, tr: m.verdict.tr, stats: m.verdict.stats });
    }, () => {
      if (!found.length) { message("No clean variant of design " + (i + 1) + " — try another card", true); return false; }
      cands = TrackRandom.rank(found, 4);
      renderCandidates();
      message(cands.length + " circuits like design " + (i + 1) + " — USE one, or MORE LIKE THIS again");
      return true;
    });
  }
  const candMeta = (c: Cand) => {
    const km = c.tr ? c.tr.total / 1000 : 0, corners = c.feats ? Math.round(c.feats.C * km) : (c.stats ? c.stats.turns : 0);
    return km.toFixed(1) + " km · " + corners + " corners · " + ((c.stats && c.stats.passZones) || 0) + " passing";
  };
  /** The cards: outline (one per frame, DesignerCanvas.thumb over the verdict's own tr), meta, USE, MORE LIKE THIS. designer.js:2245 */
  function renderCandidates() {
    if (!ui.cands) return;
    while (ui.cands.firstChild) ui.cands.removeChild(ui.cands.firstChild);
    ui.cands.hidden = !cands.length;
    const job = ++candThumbJob, queue: [HTMLCanvasElement, Track | null][] = [];
    cands.forEach((c, i) => {
      const card = el("div", "td-card");
      const cvs = el("canvas"); cvs.width = 160; cvs.height = 110; cvs.setAttribute("aria-hidden", "true");
      const row = el("div", "td-chips");
      const use = btn("USE", "sel-chip", () => useCandidate(i));
      use.setAttribute("aria-label", "Use design " + (i + 1) + ": " + candMeta(c));
      const more = btn("MORE LIKE THIS", "sel-chip", () => moreLikeThis(i));
      more.setAttribute("aria-label", "More like this: four variants of design " + (i + 1));
      row.append(use, more);
      card.append(cvs, el("div", "td-card-meta", candMeta(c)), row);
      ui.cands.appendChild(card);
      queue.push([cvs, c.tr]);
    });
    const next = () => {
      if (job !== candThumbJob || !queue.length) return;
      const [cvs, tr] = queue.shift()!;
      try { DesignerCanvas.thumb(cvs, tr, { color: "#f6f6f9", width: 2 }); } catch (e) { Log.warn("track", "designed thumbnail failed: " + (e && (e as Error).message)); }
      requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }

  // ── files, the share card, the test drive (designer.js:2272) ──────────────
  /** "apex26-track-<name>": the stem EXPORT and CARD name their files with. designer.js:2274 */
  const fileStem = (item: { name?: string } | null = design) => "apex26-track-" + (item && item.name || "circuit").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  /** A blob onto the player's device: the native share sheet where the app
   *  shell has one (NativeDownload), else an <a download>. Throws what they throw. designer.js:2277 */
  async function saveFile(blob: Blob, name: string) {
    const NativeDownload = deps.nativeDownload || null;
    if (NativeDownload && NativeDownload.viable && NativeDownload.viable() && NativeDownload.saveBlob) { await NativeDownload.saveBlob(blob, name); return true; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return true;
  }
  /** canvas → PNG blob (js/ui/photo-studio.js keeps its own copy private). */
  function blobOf(c: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
      try { c.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be encoded"))), "image/png"); } catch (e) { reject(e); }
    });
  }
  const CARD_W = 640, CARD_H = 360;
  /** The built centreline fitted into rect {x, y, w, h}, z down the card as on
   *  the designer's canvas, with a casing and a start-line dot. */
  function strokeOutline(g: CanvasRenderingContext2D, tr: Track, rect: { x: number; y: number; w: number; h: number }, color: string) {
    const n = tr.n, px = tr.px, pz = tr.pz;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < n; k++) { x0 = Math.min(x0, px[k]!); x1 = Math.max(x1, px[k]!); z0 = Math.min(z0, pz[k]!); z1 = Math.max(z1, pz[k]!); }
    const sc = Math.min(rect.w / Math.max(1, x1 - x0), rect.h / Math.max(1, z1 - z0));
    const ox = rect.x + (rect.w - (x1 - x0) * sc) / 2 - x0 * sc, oz = rect.y + (rect.h - (z1 - z0) * sc) / 2 - z0 * sc;
    const step = Math.max(1, Math.floor(n / 600));
    g.beginPath();
    for (let k = 0; k < n; k += step) { const X = ox + px[k]! * sc, Y = oz + pz[k]! * sc; if (k) g.lineTo(X, Y); else g.moveTo(X, Y); }
    g.closePath();
    g.lineJoin = "round"; g.lineCap = "round";
    g.strokeStyle = "rgba(0,0,0,0.55)"; g.lineWidth = 9; g.stroke();
    g.strokeStyle = color; g.lineWidth = 5; g.stroke();
    g.fillStyle = DesignerCanvas.COL.start; g.beginPath(); g.arc(ox + px[0]! * sc, oz + pz[0]! * sc, 6, 0, Math.PI * 2); g.fill();
  }
  /** Measure text width (mono fallback when the VM's canvas has no metrics). */
  function textW(g: CanvasRenderingContext2D, t: string) { const m = g.measureText(t); return m && m.width > 0 ? m.width : t.length * 6.6; }
  /** Wrap a share URL for the 640×360 card: keep `#track=` intact (never
   *  `…#trac` / `k=…`), put the host on its own line when the path is long,
   *  and cap at three lines. Live apex8 cards broke mid-word under wrapChars.
   *  A link that does not fit is NOT cut mid-code (a prefix of a share code
   *  decodes to nothing, yet read as a link): the host and `#track=…` stand
   *  for it and the full link rides SHARE / the share text. designer.js:2316 */
  function wrapUrl(g: CanvasRenderingContext2D, url: string, w: number) {
    const lines = wrapUrlAll(g, url, w);
    if (lines.length <= 3) return lines;
    return [url.indexOf("#track=") < 0 ? lines[0] + "…" : lines[0]!, "#track=…", "full link: SHARE"];
  }
  function wrapUrlAll(g: CanvasRenderingContext2D, url: string, w: number) {
    const at = url.indexOf("#track=");
    if (at < 0) {
      const lines: string[] = []; let cur = "";
      for (const ch of url) { if (cur && textW(g, cur + ch) > w) { lines.push(cur); cur = ""; } cur += ch; }
      if (cur) lines.push(cur);
      return lines;
    }
    let head = url.slice(0, at);
    const code = url.slice(at + 7);                       // after "#track="
    if (textW(g, head) > w) {
      const origin = (url.match(/^[a-z]+:\/\/[^/#?]+/i) || [head])[0];
      head = origin + "…";
    }
    const lines = [head];
    // Prefer a single `#track=<code>` line; if that is too long, break only
    // after `=` or in the opaque code (never inside the "#track" token).
    const marker = "#track=";
    if (textW(g, marker + code) <= w) {
      lines.push(marker + code);
    } else {
      lines.push(marker);
      let cur = "";
      for (const ch of code) {
        if (cur && textW(g, cur + ch) > w) { lines.push(cur); cur = ""; }
        cur += ch;
      }
      if (cur) lines.push(cur);
    }
    return lines;
  }
  /** The 640×360 track card: the outline in the left 360², name, facts, theme,
   *  the game's mark and the share link in the right column. { canvas, url, name } | null. designer.js:2354 */
  async function cardCanvas() {
    if (previewT || !verdict) runPreview();
    if (!verdict || !verdict.ok || !verdict.tr) { setMode("test"); message("Fix the red issues before sharing", true); return null; }
    // The encoder yields to compression; editing can continue meanwhile. One
    // snapshot owns the link, drawing, filename AND native share-sheet title.
    const item = copy(design!), preview = verdict;
    const code = await TrackCodec.encode(item);
    lastCode = code;
    if (!code) { message("This design cannot be encoded", true); return null; }
    const url = TrackCodec.shareUrl(code), tr = preview.tr!, st: Partial<Stats> = preview.stats || {}, COL = DesignerCanvas.COL;
    const c = document.createElement("canvas"); c.width = CARD_W; c.height = CARD_H;
    const g = c.getContext("2d");
    if (!g) { message("This browser cannot draw the card", true); return null; }
    g.fillStyle = "#000"; g.fillRect(0, 0, CARD_W, CARD_H);   // opaque under the translucent chip ink
    g.fillStyle = COL.chipBg; g.fillRect(0, 0, CARD_W, CARD_H);
    let ink: string = COL.handle;
    const TrackMaps = deps.trackMaps || null;
    try { ink = (TrackMaps!.themeColor && TrackMaps!.themeColor(preview.def)) || ink; } catch (_) { ink = COL.handle; }
    strokeOutline(g, tr, { x: 28, y: 28, w: 304, h: 304 }, ink);
    const X = 376, W = CARD_W - X - 24, T = TrackThemes.get(item.theme);
    g.textBaseline = "top";
    g.fillStyle = COL.chipText; g.font = "bold 24px system-ui, sans-serif"; g.fillText(item.name, X, 40, W);
    g.fillStyle = COL.text; g.font = "14px system-ui, sans-serif";
    g.fillText(fmtKm(tr.total) + " · " + (st.turns != null ? st.turns : (preview.turns || []).length) + " corners · est lap " + fmtLap(st.estLapS), X, 80, W);
    g.fillText((T && T.label) || item.theme, X, 102, W);
    g.fillStyle = COL.sel; g.font = "bold 12px system-ui, sans-serif"; g.fillText("APEX 26 · TRACK DESIGNER", X, 140, W);
    g.fillStyle = COL.text; g.font = "11px ui-monospace, monospace";
    const lines = wrapUrl(g, url, W);
    lines.forEach((l, k) => g.fillText(l, X, CARD_H - 24 - (lines.length - k) * 15));
    return { canvas: c, url, title: item.name, name: fileStem(item) + "-card.png" };
  }
  /** CARD: the OS share sheet with the PNG and the full link where the browser
   *  can share files (canShare({files})), else the file is saved. A dismissed
   *  sheet (AbortError) is the player's choice — no fallback, no message.
   *  Re-entry while a draw/share is in flight is refused (double-click used to
   *  fire two downloads). designer.js:2390 */
  let cardBusy = false;
  async function shareCard() {
    if (cardBusy) return false;
    cardBusy = true;
    try {
      const card = await cardCanvas();
      if (!card) return false;
      let blob: Blob | null = null;
      try { blob = await blobOf(card.canvas); } catch (e) { message("Could not draw the card: " + (e && (e as Error).message || e), true); return false; }
      const nav = typeof navigator !== "undefined" ? navigator : null;
      const file = typeof File === "function" ? new File([blob], card.name, { type: "image/png" }) : null;
      if (file && nav && typeof nav.share === "function" && nav.canShare && nav.canShare({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: card.title, text: card.url });
          message("Card shared"); Log.info("track", "designer card shared");
          return true;
        } catch (e) {
          if (e && (e as Error).name === "AbortError") return false;
          Log.info("track", "designer card share refused (" + (e && (e as Error).name || e) + ") — saving it instead");
        }
      }
      try { await saveFile(blob, card.name); message("Card saved as " + card.name); return true; } catch (e) { message("Could not save the card: " + (e && (e as Error).message || e), true); return false; }
    } finally { cardBusy = false; }
  }
  /** Arc s (m) of the preview build's node nearest control point i, or -1. */
  function builtS(i: number) {
    const tr = verdict && verdict.tr, p = design && design.pts[i];
    if (!tr || !tr.n || !p) return -1;
    let k = 0, best = Infinity;
    for (let j = 0; j < tr.n; j++) { const d = (tr.px[j]! - p[0]) * (tr.px[j]! - p[0]) + (tr.pz[j]! - p[1]) * (tr.pz[j]! - p[1]); if (d < best) { best = d; k = j; } }
    return k * tr.total / tr.n;
  }
  /** The player at rest at arc s — the fields __apex.jump (js/agent/apex.js)
   *  and launchFlyingLap (js/game.js) write for a teleport and a standing lap:
   *  track and world pose, cleared transients and teleport accumulators, seeded
   *  render anchors. prog = s − total makes it an OUT-LAP: the first line
   *  crossing starts the timed lap, so no partial lap reaches the TT board. designer.js:2426 */
  function placeAt(p: TestPlayer, track: Track, s: number) {
    const L = track.total, smp = { p: [0, 0, 0] as [number, number, number], t: [0, 0, 1] as [number, number, number], r: [1, 0, 0] as [number, number, number], hw: 0 };
    s = ((s % L) + L) % L;
    Tracks.sample(track, s, smp);
    p.prog = s - L; p.s = p._prevS = s;
    p.x = p.xVis = 0;                                    // on the centreline
    p.px = smp.p[0]; p.pz = smp.p[2];
    p.head = Math.atan2(smp.t[0], smp.t[2]);
    p.speed = 0;                                         // a standing start: no raw m/s against PACE
    p.vLat = 0; p.yawRateCur = 0; p.yawVis = 0; p.steerVis = 0;
    p.rescueT = 0; p.wallT = 0; p.wasOnWall = false; p.wrongT = 0; p.wrongWay = false; p.offT = 0;
    p.rPrevPx = p.px; p.rPrevPz = p.pz; p.rPrevS = p.s; p.rPrevX = p.x; p.rPrevHead = p.head; p.rPrevYawVis = 0;
    return s;
  }
  /** The solo start every other route plays: the pre-race screen (garage leave, card, flyby), which runs
   *  startRace itself once the card is up. A headless or hidden page has no frames for it (raceIntro's other
   *  callers take the same quick path) and a throw before the card starts the race anyway — the title is
   *  already hidden. Resolves with startRace's own result; never when the player abandons the intro. designer.js:2444 */
  function startViaIntro() {
    if (typeof G!.raceIntro !== "function" || G!.headlessMode || document.hidden) return G!.startRace!();
    return new Promise((resolve, reject) => {
      const go = () => { try { resolve(G!.startRace!()); } catch (e) { reject(e); } };
      try { G!.raceIntro!(go); } catch (e) { Log.warn("track", "test drive pre-race screen failed — starting straight away: " + (e && (e as Error).message || e)); go(); }
    });
  }
  /** The car at rest on a test drive's point and green at once. Every start while the return is armed comes
   *  here (CustomTracks.afterStart): the first, TRY AGAIN and the pause RESTART alike.
   *  Also relocates when startRace's awaits let the lights finish so state is already
   *  "race" before afterStart runs (selected-4 TEST HERE, tip 210d293 / ship #1296). designer.js:2455 */
  function placeTest(r: DesignerReturn | null | undefined) {
    if (!G!.player || !G!.track || !r || !(r.s! >= 0) || !design || design.originId !== r.id) return false;
    if (G!.state !== "count" && G!.state !== "race") return false;
    const L = G!.track.total || 0;
    if (G!.state === "race" && L > 0) {
      const ds = Math.abs(G!.player.s - r.s!);
      if (Math.min(ds, L - ds) <= 20) return false;   // already on the point (second afterStart)
    }
    placeAt(G!.player, G!.track, r.s!);
    if (G!.snapGameCam) G!.snapGameCam();
    if (G!.refreshHud) G!.refreshHud(true);
    if (G!.state === "count") return !!G!.goRolling!();
    return true;
  }
  /** TEST HERE: save, then a TIME TRIAL (startRaceBody clears practiceMode, so
   *  a time trial is the unscored session that survives it) with the car at
   *  rest on point i — the selected one by default — and green at once.
   *  CustomTracks holds the way back; quitToMenu's consumeTrackHash() takes it. designer.js:2473 */
  async function testHere(i?: number) {
    const at = Number.isInteger(i) ? i! : sel;
    if (!design || !(at >= 0 && at < design.pts.length)) { message("Select a point to test drive from", true); return false; }
    const r = save(true);
    if (!r.ok) return false;
    const idx = custom!.select(r.id);
    if (idx < 0) { message("That circuit is not in the list any more", true); return false; }
    sel = at;
    const s = builtS(at), back = { id: r.id, sel: at, span, s };
    if ((custom as Partial<CustomTracksApi>).armReturn) custom!.armReturn(back);
    G!.trackIdx = idx; G!.seasonMode = false; G!.timeTrial = true;   // openTimeTrial's flow + session
    close();
    Log.info("track", "designer test drive on " + r.id + " from point " + (at + 1) + " (s " + Math.round(s) + " m)");
    try { await startViaIntro(); } catch (e) { Log.warn("track", "test drive start failed: " + (e && (e as Error).message || e)); }
    // afterStart usually placed during "count"; if the lights already rolled to
    // "race", placeTest still relocates onto the point (see placeTest above).
    if (G!.state === "count" || G!.state === "race") placeTest(back);
    if (G!.state === "race") return true;
    // Never a frozen race: out through the pause menu's own quit (quitToMenu),
    // whose consumeTrackHash() hands the screen back with the reason. A start
    // that already failed back to the menu (startRace's onFail quits) is
    // reopened directly; a second open() is harmless and says why.
    if ((custom as Partial<CustomTracksApi>).armReturn) custom!.armReturn(Object.assign({}, back, { msg: "The test drive could not start — try TIME TRIAL" }));
    if (G!.state === "menu") { if ((custom as Partial<CustomTracksApi>).consumeTrackHash) custom!.consumeTrackHash(); } else if (G!.quitToMenu) G!.quitToMenu();
    return false;
  }
  /** Back from TEST HERE (open({resume})): the same design reselects the point
   *  the drive left from and brings it into view. designer.js:2501 */
  function resume(r: DesignerReturn | null | undefined) {
    if (!r || !design || design.originId !== r.id) return false;
    const N = design.pts.length;
    sel = Number.isInteger(r.sel) && r.sel! < N ? r.sel! : -1;
    span = Number.isInteger(r.span) && r.span! < N ? r.span! : -1;
    if (cv) cv.setSelection(sel, span);
    refreshControls();
    // After open()'s own resize + fit: animation frames run in request order.
    if (Number.isFinite(r.s) && r.s! >= 0) requestAnimationFrame(() => { if (openFlag && cv) cv.focusAt(r.s!); });
    message(r.msg || "Back from the test drive", !!r.msg);
    return true;
  }

  /** New (no f1-game counterpart): undo what init() / build() added, so the
   *  element can be mounted again or dropped. */
  function destroy() {
    close();
    clearTimeout(previewT); clearTimeout(draftT); clearTimeout(msgT); previewT = draftT = msgT = 0;
    ++fromJob; ++candThumbJob; ++candJob; ++libraryImportGeneration; ++replacementGeneration;
    for (const off of unlisten.splice(0)) off();
    if (cv && cv.destroy) cv.destroy();
    if (prof && prof.destroy) prof.destroy();
    if (root) for (const n of [...root.children]) if (n.classList.contains("td-body") || n.classList.contains("td-foot")) n.remove();
    cv = null; prof = null; canvas = null; built = false; lifecycleWired = false;
  }

  // designer.js:2514
  return { init, open, close, isOpen, state, preview: runPreview, randomise, freehand, applyStamp, reverse, setStart, deletePoint, cyclePoint, armSpanEnd, undo: doUndo, redo: doRedo, setTheme, setLook, setAtmosphere, setPropKind, placeProp, removeProp, removePropAt, editPropAt, copyPropAt, setWidth, setName, setTool, setMode, applyElevPreset, setNodeHeight, setHeights, selectRange, setSelectionMode, adjustElevation, profileView, save, race, load, shareCode, share, exportEnvelope, exportFile, importFile, loadFrom, showPane, fixIssue, fixAll: fixEverything, TOOLS, MODES, HOWTO, saveFile, cardCanvas, shareCard, testHere, placeTest,
    selectCorner, toggleHeat, toggleElevationHeat, trackOfTheDay, startFrom, toggleStartFrom,
    designed, useCandidate, moreLikeThis,
    setSpanWidth, setCornerBank, setKerbStyle, setBerms,
    exportLibraryFile, importLibraryFile, loadCollection, commitLibraryImport, cancelLibraryImport,
    destroy };
}

/** The screen: f1-game's TrackDesigner object (designer.js:2514) plus destroy(). */
export type DesignerHandle = Readonly<ReturnType<typeof createDesigner>>;

// ── the module's TrackDesigner (designer.js:12 / :2520) ───────────────────
let current: DesignerHandle | null = null;
const cur = (): DesignerHandle => current || (current = Object.freeze(createDesigner({})));

/**
 * Build the TRACK DESIGNER inside `el` (f1-game's `<dialog id="trackdesigner">`,
 * index.html:3509-3514) and return its handle. `el` gets the dialog's id,
 * accessible name and `sheet-head` (heading + `#td-close`), starts hidden like
 * the shipped dialog, and becomes the target of this module's named exports.
 */
export function mount(el: HTMLElement, deps: DesignerDeps): DesignerHandle {
  if (!el.id) el.id = "trackdesigner";
  el.setAttribute("aria-labelledby", "td-title");
  el.setAttribute("data-esc-close", "td-close");
  el.hidden = true;
  if (!el.querySelector("#td-close")) {
    const head = document.createElement("div"); head.className = "sheet-head";
    const h2 = document.createElement("h2"); h2.id = "td-title"; h2.textContent = "TRACK DESIGNER";
    const close = document.createElement("button"); close.id = "td-close"; close.className = "dh-close"; close.type = "button";
    close.setAttribute("aria-label", "Close track designer"); close.hidden = true; close.textContent = "✕";
    head.append(h2, close);
    el.appendChild(head);
  }
  // f1-game's browser always loads js/ui/track-maps.js: the mounted screen gets the
  // ported TrackMaps for its thumbnails and card ink, and validate.ts gets it for
  // bakeTurns / insight's classes. The unmounted default stays TrackMaps-less (the
  // goldens' headless VM); destroy() puts back whatever was injected before.
  if (!deps.trackMaps) deps = Object.assign({}, deps, { trackMaps: TrackMaps });
  const priorMaps = TrackValidate.getTrackMaps();
  TrackValidate.setTrackMaps(TrackMaps);
  const d = createDesigner(deps);
  const handle: DesignerHandle = Object.freeze(Object.assign({}, d, {
    destroy() {
      d.destroy();
      if (current === handle) { current = null; if (TrackValidate.getTrackMaps() === TrackMaps) TrackValidate.setTrackMaps(priorMaps); }
    },
  }));
  current = handle;
  handle.init(deps.game || null, { custom: deps.custom || null, root: el });
  return handle;
}

// Every member of f1-game's return object (designer.js:2514), on the current screen.
type H = DesignerHandle;
/** designer.js:1625 */ export const init: H["init"] = (...a) => cur().init(...a);
/** designer.js:1658 */ export const open: H["open"] = (...a) => cur().open(...a);
/** designer.js:1698 */ export const close: H["close"] = (...a) => cur().close(...a);
/** designer.js:1714 */ export const isOpen: H["isOpen"] = (...a) => cur().isOpen(...a);
/** designer.js:1716 */ export const state: H["state"] = (...a) => cur().state(...a);
/** designer.js:342 */ export const preview: H["preview"] = (...a) => cur().preview(...a);
/** designer.js:437 */ export const randomise: H["randomise"] = (...a) => cur().randomise(...a);
/** designer.js:403 */ export const freehand: H["freehand"] = (...a) => cur().freehand(...a);
/** designer.js:384 */ export const applyStamp: H["applyStamp"] = (...a) => cur().applyStamp(...a);
/** designer.js:447 */ export const reverse: H["reverse"] = (...a) => cur().reverse(...a);
/** designer.js:460 */ export const setStart: H["setStart"] = (...a) => cur().setStart(...a);
/** designer.js:476 */ export const deletePoint: H["deletePoint"] = (...a) => cur().deletePoint(...a);
/** designer.js:486 */ export const cyclePoint: H["cyclePoint"] = (...a) => cur().cyclePoint(...a);
/** designer.js:563 */ export const armSpanEnd: H["armSpanEnd"] = (...a) => cur().armSpanEnd(...a);
/** designer.js:583 */ export const undo: H["undo"] = (...a) => cur().undo(...a);
/** designer.js:584 */ export const redo: H["redo"] = (...a) => cur().redo(...a);
/** designer.js:585 */ export const setTheme: H["setTheme"] = (...a) => cur().setTheme(...a);
/** designer.js:591 */ export const setLook: H["setLook"] = (...a) => cur().setLook(...a);
/** designer.js:602 */ export const setAtmosphere: H["setAtmosphere"] = (...a) => cur().setAtmosphere(...a);
/** designer.js:613 */ export const setPropKind: H["setPropKind"] = (...a) => cur().setPropKind(...a);
/** designer.js:621 */ export const placeProp: H["placeProp"] = (...a) => cur().placeProp(...a);
/** designer.js:639 */ export const removeProp: H["removeProp"] = (...a) => cur().removeProp(...a);
/** designer.js:651 */ export const removePropAt: H["removePropAt"] = (...a) => cur().removePropAt(...a);
/** designer.js:658 */ export const editPropAt: H["editPropAt"] = (...a) => cur().editPropAt(...a);
/** designer.js:664 */ export const copyPropAt: H["copyPropAt"] = (...a) => cur().copyPropAt(...a);
/** designer.js:670 */ export const setWidth: H["setWidth"] = (...a) => cur().setWidth(...a);
/** designer.js:676 */ export const setName: H["setName"] = (...a) => cur().setName(...a);
/** designer.js:697 */ export const setTool: H["setTool"] = (...a) => cur().setTool(...a);
/** designer.js:710 */ export const setMode: H["setMode"] = (...a) => cur().setMode(...a);
/** designer.js:2106 */ export const applyElevPreset: H["applyElevPreset"] = (...a) => cur().applyElevPreset(...a);
/** designer.js:2072 */ export const setNodeHeight: H["setNodeHeight"] = (...a) => cur().setNodeHeight(...a);
/** designer.js:2055 */ export const setHeights: H["setHeights"] = (...a) => cur().setHeights(...a);
/** designer.js:500 */ export const selectRange: H["selectRange"] = (...a) => cur().selectRange(...a);
/** designer.js:511 */ export const setSelectionMode: H["setSelectionMode"] = (...a) => cur().setSelectionMode(...a);
/** designer.js:553 */ export const adjustElevation: H["adjustElevation"] = (...a) => cur().adjustElevation(...a);
/** designer.js:526 */ export const profileView: H["profileView"] = (...a) => cur().profileView(...a);
/** designer.js:780 */ export const save: H["save"] = (...a) => cur().save(...a);
/** designer.js:803 */ export const race: H["race"] = (...a) => cur().race(...a);
/** designer.js:741 */ export const load: H["load"] = (...a) => cur().load(...a);
/** designer.js:1283 */ export const shareCode: H["shareCode"] = (...a) => cur().shareCode(...a);
/** designer.js:1289 */ export const share: H["share"] = (...a) => cur().share(...a);
/** designer.js:1307 */ export const exportEnvelope: H["exportEnvelope"] = (...a) => cur().exportEnvelope(...a);
/** designer.js:1315 */ export const exportFile: H["exportFile"] = (...a) => cur().exportFile(...a);
/** designer.js:1390 */ export const importFile: H["importFile"] = (...a) => cur().importFile(...a);
/** designer.js:1397 */ export const loadFrom: H["loadFrom"] = (...a) => cur().loadFrom(...a);
/** designer.js:1003 */ export const showPane: H["showPane"] = (...a) => cur().showPane(...a);
/** designer.js:1537 */ export const fixIssue: H["fixIssue"] = (...a) => cur().fixIssue(...a);
/** designer.js:1553 (fixEverything) */ export const fixAll: H["fixAll"] = (...a) => cur().fixAll(...a);
/** designer.js:2277 */ export const saveFile: H["saveFile"] = (...a) => cur().saveFile(...a);
/** designer.js:2354 */ export const cardCanvas: H["cardCanvas"] = (...a) => cur().cardCanvas(...a);
/** designer.js:2390 */ export const shareCard: H["shareCard"] = (...a) => cur().shareCard(...a);
/** designer.js:2473 */ export const testHere: H["testHere"] = (...a) => cur().testHere(...a);
/** designer.js:2455 */ export const placeTest: H["placeTest"] = (...a) => cur().placeTest(...a);
/** designer.js:1793 */ export const selectCorner: H["selectCorner"] = (...a) => cur().selectCorner(...a);
/** designer.js:1811 */ export const toggleHeat: H["toggleHeat"] = (...a) => cur().toggleHeat(...a);
/** designer.js:1817 */ export const toggleElevationHeat: H["toggleElevationHeat"] = (...a) => cur().toggleElevationHeat(...a);
/** designer.js:1824 */ export const trackOfTheDay: H["trackOfTheDay"] = (...a) => cur().trackOfTheDay(...a);
/** designer.js:1831 */ export const startFrom: H["startFrom"] = (...a) => cur().startFrom(...a);
/** designer.js:1846 */ export const toggleStartFrom: H["toggleStartFrom"] = (...a) => cur().toggleStartFrom(...a);
/** designer.js:2192 */ export const designed: H["designed"] = (...a) => cur().designed(...a);
/** designer.js:2211 */ export const useCandidate: H["useCandidate"] = (...a) => cur().useCandidate(...a);
/** designer.js:2222 */ export const moreLikeThis: H["moreLikeThis"] = (...a) => cur().moreLikeThis(...a);
/** designer.js:1941 */ export const setSpanWidth: H["setSpanWidth"] = (...a) => cur().setSpanWidth(...a);
/** designer.js:1970 */ export const setCornerBank: H["setCornerBank"] = (...a) => cur().setCornerBank(...a);
/** designer.js:1987 */ export const setKerbStyle: H["setKerbStyle"] = (...a) => cur().setKerbStyle(...a);
/** designer.js:1996 */ export const setBerms: H["setBerms"] = (...a) => cur().setBerms(...a);
/** designer.js:1326 */ export const exportLibraryFile: H["exportLibraryFile"] = (...a) => cur().exportLibraryFile(...a);
/** designer.js:1381 */ export const importLibraryFile: H["importLibraryFile"] = (...a) => cur().importLibraryFile(...a);
/** designer.js:1365 */ export const loadCollection: H["loadCollection"] = (...a) => cur().loadCollection(...a);
/** designer.js:1355 */ export const commitLibraryImport: H["commitLibraryImport"] = (...a) => cur().commitLibraryImport(...a);
/** designer.js:1347 */ export const cancelLibraryImport: H["cancelLibraryImport"] = (...a) => cur().cancelLibraryImport(...a);
