/**
 * The GARAGE pre-built while the title or race settings sits idle.
 *
 * Ported verbatim from f1-game js/garage/prebuild.js:1-267 (GaragePrebuild).
 *
 * WHY. The garage's first frame builds the room (GarageScene rebuild: shell,
 * props, the live and dress atlases), the player's car (into the six-slot
 * preview LRU) and compiles their programs, synchronously, ON THE TAP: 1.3-1.8 s
 * of frozen screen under SwiftShader.
 *
 * WHAT. One sequence, three steps, each its own task behind the menu's own idle
 * gate: 1. the car — setupCam.prebuild("car"); 2. the room —
 * setupCam.prebuild("room") (GarageScene.prepare with the SETUP garage's ctx);
 * 3. the programs — two hidden setup-garage frames after one gfx.warm()
 * request per session. What the title is DRAWING decides which steps may run
 * (plan()). KEYED, NOT ONE-SHOT: `gate.garageKey` is setupCam.prebuildKey().
 * DRAWN, NOT JUST BUILT: `gate.garageReady` means the setup garage DREW for
 * that key; a frameless plan only records `prepped`.
 *
 * OFF SWITCH: localStorage `a26.garagePrewarm = "off"` at boot, or
 * setEnabled(false).
 *
 * Differences from the IIFE:
 * - f1-game's `G` game object and its globals (performance, setTimeout,
 *   document, navigator, matchMedia, Assets, localStorage, Log, GarageScene)
 *   are typed parameters: `G` is PrebuildGame, the f1-game `d` deps object is
 *   PrebuildDeps, and the browser globals are PrebuildEnv (browser defaults).
 * - The storage key is `a26.garagePrewarm` (AGENTS.md: f1-game owns
 *   `apex26.*` on the same origin).
 * - `instance()` stays module state, as f1-game's `_instance` (the page's one
 *   prebuild, for the debug API).
 */
import { log as dataLog } from "../../data/log";
import type { GarageLog } from "./types";

export const POLL_MS = 1000;      // the title's idle check: a few property reads
export const GIVE_UP_MS = 30000;  // a hidden frame withheld this long (a compile) is logged as pending
/** The A/B switch's localStorage key. f1-game: "apex26.garagePrewarm". */
export const SWITCH_KEY = "a26.garagePrewarm";

/** The material pack's state (f1-game js/render/shared/assets.js state()). TODO(lane-render): src/assets/. */
export interface PackState {
  readonly supported?: boolean | undefined;
  readonly uploaded?: boolean | undefined;
  readonly error?: unknown;
  readonly tier?: string | null | undefined;
}

// Settled = uploaded, failed or unsupported. prebuild.js:62-65
export function packSettled(s: PackState | null | undefined): boolean {
  return !s || s.supported === false || !!s.uploaded || !!s.error || s.tier === "off";
}

/** The navigator slice saveData reads. */
export interface NavLike { readonly connection?: { readonly saveData?: boolean } | null | undefined }
export type MatchMedia = (q: string) => { readonly matches: boolean };

// The Save-Data client hint (NetworkInformation.saveData) or the
// prefers-reduced-data media feature; either one means "no speculative work".
// prebuild.js:67-74
export function saveData(nav: NavLike | null | undefined, matchMedia: MatchMedia | null | undefined): boolean {
  try {
    if (nav && nav.connection && nav.connection.saveData === true) return true;
    return !!(matchMedia && matchMedia("(prefers-reduced-data: reduce)").matches);
  } catch { return false; }
}

/** UiExperience.state() as homeKind reads it. TODO(lane-shell): the title / Home experience. */
export interface UiState {
  readonly home?: boolean | undefined;
  readonly painted?: boolean | undefined;
  readonly scene?: { readonly mode?: string | undefined } | null | undefined;
  readonly world?: { readonly active?: boolean | undefined } | null | undefined;
}
export type HomeKind = "none" | "track" | "studio" | "garage";

// What the title draws under its buttons (UiExperience.state()). prebuild.js:76-82
export function homeKind(st: UiState | null | undefined): HomeKind {
  if (!st) return "none";
  if (st.world && st.world.active) return "track";
  if (st.home) return st.scene && st.scene.mode === "studio" ? "studio" : "garage";
  return "none";
}

export type Want = "title" | "settings";
export interface Plan { car: boolean; room: boolean; frames: boolean }

// Which steps may run without stealing a visible frame or thrashing the room.
// prebuild.js:84-89
export function plan(want: Want, kind: HomeKind): Plan {
  if (want === "settings" || kind === "none") return { car: true, room: true, frames: true };
  if (kind === "track") return { car: true, room: true, frames: false };
  return { car: true, room: false, frames: false };   // garage/studio Home draws them itself
}

/** The plain snapshot blockers() judges (prebuild.js env()). */
export interface PrebuildEnvSnapshot {
  want: Want; kind: HomeKind; off: boolean; state: string; setupOpen: boolean; starting: boolean;
  tabHidden: boolean; headless: boolean; surface: string; intro: boolean; saveData: boolean;
  packSettled: boolean; worldReady: boolean; homePainted: boolean; worldWarm: boolean; warming: boolean;
}

// Why the prebuild may not start now; [] means go. prebuild.js:91-110
export function blockers(e: PrebuildEnvSnapshot): string[] {
  const out: string[] = [];
  if (e.state !== "menu") out.push("state");
  if (e.setupOpen) out.push("garage-open");
  if (e.starting) out.push("race-start");
  if (e.tabHidden) out.push("tab-hidden");
  if (e.headless) out.push("headless");
  if (e.surface !== e.want) out.push("surface");
  if (e.want === "title") {
    if (e.off) out.push("off");
    if (e.intro) out.push("title-intro");
    if (e.saveData) out.push("save-data");
    // Pack is NOT a start blocker: car/room build while it downloads. Frames
    // still wait on packSettled inside run() so programs compile once.
    if (e.kind === "track" && !e.worldReady) out.push("world-build");
    if (e.kind === "garage" && !e.homePainted) out.push("home-unpainted");
  }
  if (e.worldWarm || e.warming) out.push("world-warm");
  return out;
}

/** A Storage's getItem. */
export interface StorageLike { getItem(key: string): string | null }

// THE A/B SWITCH: localStorage a26.garagePrewarm = "off" (read at boot) or
// setEnabled(false) turns the TITLE prebuild off — the tip's behaviour, so one
// tree measures both. Race settings' prewarm (older, RACE!'s) stays on.
// prebuild.js:112-122. `storage` undefined reads the global localStorage.
export function readSwitch(storage?: StorageLike | null): boolean {
  try {
    const disk = storage === undefined ? (typeof localStorage !== "undefined" ? localStorage : null) : storage;
    const v = disk && disk.getItem(SWITCH_KEY);
    return !(v === "off" || v === '"off"' || v === "0" || v === "false");
  } catch { return true; }
}

/** A DOM element as surface()/env() read it. */
export interface PrebuildEl {
  readonly hidden?: boolean;
  readonly inert?: boolean;
  hasAttribute?(name: string): boolean;
}

/**
 * The slice of f1-game's game object `G` the prebuild reads.
 * TODO(lane-shell): the app's menu / garage state.
 */
export interface PrebuildGame {
  $(id: string): PrebuildEl | null | undefined;
  readonly state: string;
  readonly setupPreviewOn?: boolean | undefined;
  readonly loadingScreen?: { active(): boolean } | null | undefined;
  readonly headlessMode?: boolean | undefined;
  readonly gfx: { warm?(): void; warming?(): boolean };
}

/** The menu gate (game.js `_menuGate`). TODO(lane-shell). */
export interface PrebuildGate {
  warm: number;
  garageWarm: number;
  garageReady: boolean;
  garageKey: string;
}

/** The setup camera's prebuild surface (setup-camera.js). TODO(lane-data): src/garage/setup-camera.ts. */
export interface PrebuildCam {
  previewKey(): string;
  prebuildKey(): string;
  prebuild(part: "car" | "room"): unknown;
  roomReady(): boolean;
  meshKey: string;
  release?(): boolean;
}

/** f1-game's `d` argument to create(). */
export interface PrebuildDeps {
  readonly gate: PrebuildGate;
  readonly setupCam: PrebuildCam;
  ui(): { state?(): UiState | null } | null | undefined;
  studio(): unknown;
  worldReady(): boolean;
  menuIdle(current: () => boolean): Promise<boolean>;
  menuSlice(): Promise<unknown>;
}

/** The browser globals prebuild.js read. Each defaults to the real one. */
export interface PrebuildEnv {
  readonly now?: () => number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (h: unknown) => void;
  readonly hidden?: () => boolean;
  readonly navigator?: () => NavLike | null;
  readonly matchMedia?: () => MatchMedia | null;
  /** Assets.state(). TODO(lane-render): src/assets/. */
  readonly assetsState?: () => PackState | null;
  readonly storage?: StorageLike | null;
  readonly log?: GarageLog;
  /** GarageScene.debug's preview count. */
  readonly sceneDebug?: () => { readonly previewMeshes: number } | null;
}

export interface RunRecord {
  want: Want; kind: HomeKind; key: string; t0?: number; carMs: number; roomMs: number; frameMs: number;
  room: boolean; frames: boolean; result?: string; ms?: number;
}
export interface FirstFrame { from: string; visit: number; tapMs: number; workMs: number; calls: number; prebuilt: boolean }
export interface PrebuildState {
  enabled: boolean; ready: boolean; garageReady: boolean; prepped: boolean; garageWarm: number; key: string;
  running: boolean; kind: HomeKind; blockers: string[]; programsWarm: boolean; room: boolean;
  previewMeshes: number | null; last: RunRecord | null; firstFrame: FirstFrame | null;
}
export type FrameFn = (dt: number, hold?: unknown) => boolean;
export interface GaragePrebuildApi {
  run(current: () => boolean, want: Want): Promise<boolean>;
  start(): void;
  stop(): void;
  markOpen(from: string): void;
  timed(fn: FrameFn): FrameFn;
  state(): PrebuildState;
  setEnabled(on?: boolean): boolean;
  release(): boolean;
}

// The page's one instance (the MirrorPass.instance() idiom: no G member).
let _instance: GaragePrebuildApi | null = null;
export const instance = (): GaragePrebuildApi | null => _instance;

/** prebuild.js:124-262 */
export function create(G: PrebuildGame, d: PrebuildDeps, envIn: PrebuildEnv = {}): GaragePrebuildApi {
  const gate = d.gate, cam = d.setupCam, $ = G.$;
  const log = envIn.log || dataLog;
  const perfNow = envIn.now || (() => performance.now());
  const setT = envIn.setTimeout || ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearT = envIn.clearTimeout || ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const isHidden = envIn.hidden || (() => typeof document !== "undefined" && !!document.hidden);
  const nav = envIn.navigator || (() => (typeof navigator !== "undefined" ? navigator as NavLike : null));
  const mm = envIn.matchMedia || (() => (typeof matchMedia === "function" ? matchMedia as MatchMedia : null));
  const assets = envIn.assetsState || (() => null);
  const now = (): number => perfNow(), ms = (t: number): number => Math.round(t);
  let enabled = readSwitch(envIn.storage);
  let running = false, warmed = false, last: RunRecord | null = null;
  let open: { from: string; visit: number; at: number; work: number; calls: number; prebuilt: boolean } | null = null;
  let firstFrame: FirstFrame | null = null, timer: unknown = 0, visits = 0;
  let prepped: { key: string; room: boolean } | null = null;   // built on the CPU by a frameless plan, frames NOT drawn
  const ui = (): UiState | null => { const u = d.ui(); return u && u.state ? u.state() : null; };
  const kind = (): HomeKind => homeKind(ui());
  function surface(): string {
    const rs = $("race-settings"), ov = $("overlay");
    if (rs && !rs.hidden) return "settings";
    return ov && !ov.hidden && !ov.inert ? "title" : "";
  }
  const starting = (): boolean => !!(G.loadingScreen && G.loadingScreen.active()) || !!d.studio();
  function env(want: Want): PrebuildEnvSnapshot {
    const ov = $("overlay"), st = ui(), k = homeKind(st);
    return {
      want, kind: k, off: !enabled, state: G.state, setupOpen: !!G.setupPreviewOn, starting: starting(),
      tabHidden: isHidden(), headless: !!G.headlessMode,
      surface: surface(), intro: !!(ov && ov.hasAttribute && ov.hasAttribute("data-intro")),
      saveData: saveData(nav(), mm()),
      packSettled: packSettled(assets()),
      worldReady: !!d.worldReady(), homePainted: !!(st && st.painted),
      worldWarm: gate.warm > 0, warming: !!(G.gfx && G.gfx.warming && G.gfx.warming()),
    };
  }
  // Ready = drawn for THIS key (or, for the title only, built as far as the
  // current Home's plan allows), and the car under that key still cached.
  function ready(want: Want = "title"): boolean {
    if (gate.garageKey !== cam.prebuildKey() || cam.meshKey !== cam.previewKey()) return false;
    if (gate.garageReady) return true;
    return want === "title" && !!prepped && prepped.key === gate.garageKey && !plan(want, kind()).frames;
  }
  function finish(rec: RunRecord, result: string): boolean {
    rec.result = result; rec.ms = ms(now() - rec.t0!); delete rec.t0;
    last = rec;
    log.info(`garage prewarm ${result} in ${rec.ms} ms (${rec.want}, home ${rec.kind}: car ${rec.carMs} ms, ` +
      `room ${rec.room ? rec.roomMs + " ms" : "skipped"}, frames ${rec.frames ? rec.frameMs + " ms" : "skipped"})`);
    return result === "ready";
  }
  // The sequence. `current` is the caller's ownership test (the circuit
  // build's, or the title's); false at any await abandons the rest.
  async function run(current: () => boolean, want: Want): Promise<boolean> {
    if (running || ready(want)) return false;
    // The menu world's warm is WAITED for below, not refused: menuFinish queues
    // it right before the circuit build's tail calls this.
    if (blockers(env(want)).some((r) => r !== "world-warm")) return false;
    running = true;
    try {
      if (!(await d.menuIdle(current))) return false;
      // The menu world's own hidden frames (and any compile they started) first.
      const until = now() + GIVE_UP_MS;
      while ((gate.warm > 0 || (G.gfx.warming && G.gfx.warming())) && current() && now() < until) await d.menuSlice();
      if (!current() || blockers(env(want)).length) return false;
      const k = kind(), p = plan(want, k);
      const rec: RunRecord = { want, kind: k, key: cam.prebuildKey(), t0: now(), carMs: 0, roomMs: 0, frameMs: 0, room: p.room, frames: p.frames };
      // What a frameless run already built for this key is not built again.
      const had = prepped && prepped.key === rec.key ? prepped : null;
      if (!had) prepped = null;
      gate.garageReady = false; gate.garageKey = rec.key;
      let t = now();
      if (!had || cam.meshKey !== cam.previewKey()) {
        cam.prebuild("car"); rec.carMs = ms(now() - t);
        await d.menuSlice();
        if (!current()) return finish(rec, "superseded");
      }
      if (p.room && !(had && had.room)) {
        t = now(); cam.prebuild("room"); rec.roomMs = ms(now() - t);
        await d.menuSlice();
        if (!current()) return finish(rec, "superseded");
      }
      if (!p.frames) { prepped = { key: rec.key, room: p.room || !!(had && had.room) }; return finish(rec, "ready"); }
      // Programs sample the material pack — wait for it before the hidden
      // frames, or the first real garage present recompiles them.
      const packUntil = now() + GIVE_UP_MS;
      while (!packSettled(assets()) && current() && now() < packUntil) await d.menuSlice();
      if (!current()) return finish(rec, "superseded");
      if (!packSettled(assets())) {
        prepped = { key: rec.key, room: true };
        return finish(rec, "pending");
      }
      // The renderer compiles the next present's programs once warm() is asked;
      // one request per session — a repeat links nothing yet holds presents.
      if (!warmed && G.gfx.warm) { G.gfx.warm(); warmed = true; }
      t = now(); gate.garageWarm = 2;
      while (!gate.garageReady && current() && now() - t < GIVE_UP_MS) await d.menuSlice();
      rec.frameMs = ms(now() - t);
      if (gate.garageReady) return finish(rec, "ready");
      if (!current()) { gate.garageWarm = 0; return finish(rec, "superseded"); }
      return finish(rec, "pending");   // still armed: render() flips garageReady when it draws
    } finally { running = false; }
  }
  const titleCurrent = (): boolean => G.state === "menu" && !G.setupPreviewOn && surface() === "title" && !starting();
  function tick(): void {
    timer = setT(tick, POLL_MS);
    if (running || G.state !== "menu" || ready("title")) return;
    run(titleCurrent, "title").catch((e: unknown) => log.warn("garage prewarm failed", e));
  }
  function start(): void { if (!timer) timer = setT(tick, POLL_MS); }
  function stop(): void { clearT(timer); timer = 0; }
  // THE MEASURE: tap (markOpen, in openGarage) to the first garage frame that
  // DREW, plus the time spent inside the frame calls on the way.
  function markOpen(from: string): void { open = { from, visit: ++visits, at: now(), work: 0, calls: 0, prebuilt: ready() }; }
  function timed(fn: FrameFn): FrameFn {
    return function (dt, hold) {
      const t = now(), ok = fn(dt, hold);
      if (open && G.setupPreviewOn) {
        open.work += now() - t; open.calls++;
        if (ok) {
          firstFrame = { from: open.from, visit: open.visit, tapMs: ms(now() - open.at), workMs: ms(open.work), calls: open.calls, prebuilt: open.prebuilt };
          open = null;
          log.info(`garage first frame ${firstFrame.tapMs} ms after the tap (${firstFrame.workMs} ms in ${firstFrame.calls} frame call(s), prebuilt ${firstFrame.prebuilt})`);
        }
      }
      return ok;
    };
  }
  function state(): PrebuildState {
    const dbg = envIn.sceneDebug ? envIn.sceneDebug() : null;
    return { enabled, ready: ready(), garageReady: !!gate.garageReady, prepped: !!prepped, garageWarm: gate.garageWarm, key: gate.garageKey || "",
      running, kind: kind(), blockers: blockers(env("title")), programsWarm: warmed, room: !!cam.roomReady(),
      previewMeshes: dbg ? dbg.previewMeshes : null, last, firstFrame };
  }
  // true also RE-ARMS: readiness and the last run are forgotten, so the next idle
  // title runs a fresh cycle (a spec on a shared page never reads a stale one).
  function setEnabled(on?: boolean): boolean {
    if (on !== undefined) enabled = !!on;
    if (on === true) { gate.garageReady = false; gate.garageKey = ""; last = null; prepped = null; }
    return enabled;
  }
  // RACE START frees the garage (GarageScene.release via setupCam.release) and
  // forgets readiness, so the next idle title builds it again. Refused while a
  // garage is on screen (the drive-out studio, a pit visit).
  function release(): boolean {
    if (!cam.release || !cam.release()) return false;
    gate.garageReady = false; gate.garageKey = ""; gate.garageWarm = 0;
    log.info("garage released for the race");
    return true;
  }
  _instance = { run, start, stop, markOpen, timed, state, setEnabled, release };
  return _instance;
}
