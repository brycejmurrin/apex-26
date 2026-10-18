// @vitest-environment happy-dom
/** CamModes (src/camera/modes.ts). Parity against f1-game js/camera/mode-switch.js
 *  in a VM over a scripted switch sequence (setCamMode / cycleCam / pickCam /
 *  toAuto, a WATCH, a wheel change): every return, camMode, camCutT and side
 *  effect, Object.is on numbers; the same trace is committed as
 *  tests/fixtures/camera/modes.json for CI. Assertions ported from f1-game
 *  tests/unit/director.test.mjs:156-163, camera-defaults.test.mjs:11-38, :214-231,
 *  ui-improve-pass.test.mjs:961-1053 and a11y-pwa-pass.test.mjs:303-325; then the
 *  registry (new). */
import { describe, expect, it } from "vitest";
import type { XrBootApi } from "../../../src/xr/boot";
import { CAM_MODES, createCamModes, mountCamPicker, type CamModesDeps, type WatchReplay } from "../../../src/camera/modes";
import type { CamStore } from "../../../src/camera/store";
import { expectBitExact, hasFixture, maybeWriteFixture, readFixture } from "./fixture";
import { f1Cam, hasCam } from "./f1-cam-vm";

// ── A scripted world both implementations act on ──────────────────────────
type Ev = Array<string | number | boolean | null>;
interface World {
  log: Ev[];
  replay: { running: boolean; auto: boolean } & WatchReplay;
  wheelLcd: boolean;
  wheelFns: Array<() => void>;
  btn: { textContent: string; setAttribute(k: string, v: string): void; addEventListener(): void };
  doc: { addEventListener(): void; body: { classList: { toggle(n: string, f?: boolean): boolean; contains(): boolean }; toggleAttribute(n: string, f?: boolean): boolean }; getElementById(id: string): unknown };
  store: CamStore;
  extraRigs: { reset(id: string): void };
  feel: { resetFollow(): void };
  audio: { setCameraMix(id: string): void };
  tuner: () => void;
  cockpit: { wheelHasScreen(): boolean; onWheel(fn: () => void): () => void };
  hudLayout: { setCam(id: string): void };
  refreshHud: (force: boolean) => void;
  state: string;
}

function world(): World {
  const log: Ev[] = [];
  const w: World = {
    log,
    replay: {
      running: false, auto: false,
      isRunning: () => w.replay.running,
      autoOn: () => w.replay.auto,
      setAuto: (v: boolean) => { log.push(["setAuto", v]); w.replay.auto = !!v; },
      takePicture: () => { log.push(["take"]); w.replay.auto = false; },
    },
    wheelLcd: true,
    wheelFns: [],
    // The picker's aria-haspopup / aria-expanded wiring is mountCamPicker's in the
    // port (create() order differs); the label writes are the parity surface.
    btn: { textContent: "", setAttribute: (k, v) => { if (k === "aria-label") log.push(["btnAttr", k, v]); }, addEventListener: () => {} },
    doc: {
      addEventListener: () => {},
      body: {
        classList: { toggle: (n, f) => { log.push(["class", n, !!f]); return !!f; }, contains: () => false },
        toggleAttribute: (n, f) => { log.push(["attr", n, !!f]); return !!f; },
      },
      getElementById: (id) => (id === "btn-cam" ? w.btn : null),
    },
    store: {
      get: (_k, d) => d, set: (k, v) => { log.push(["store", k, v as number]); return true; },
      raw: () => null, rawSet: () => true,
    },
    extraRigs: { reset: (id) => { log.push(["extraRigs.reset", id]); } },
    feel: { resetFollow: () => { log.push(["feel.resetFollow"]); } },
    audio: { setCameraMix: (id) => { log.push(["mix", id]); } },
    tuner: () => { log.push(["tuner.refresh"]); },
    cockpit: { wheelHasScreen: () => w.wheelLcd, onWheel: (fn) => { w.wheelFns.push(fn); return () => {}; } },
    hudLayout: { setCam: (id) => { log.push(["hud.setCam", id]); } },
    refreshHud: (f) => { log.push(["refreshHud", f]); },
    state: "race",
  };
  return w;
}

interface Driver {
  setCamMode(m: number, opts?: { persist: boolean }): string;
  cycleCam(): string;
  camMode(): number;
  camCutT(): number;
  setCamModeRaw(m: number): void;
  pick(m: number): string;
  toAuto(): string;
}

const START = 2;

/** The script: a few hundred steps of the C key, direct picks, a WATCH and a wheel swap. */
function script(w: World, d: Driver): unknown[] {
  const out: unknown[] = [];
  const step = (label: string, fn: () => string | void): void => {
    w.log.length = 0;
    const r = fn();
    out.push({ label, r: r ?? null, camMode: d.camMode(), camCutT: d.camCutT(), btn: w.btn.textContent, log: w.log.slice() });
  };
  for (let i = 0; i < 45; i++) step("cycle", () => d.cycleCam());
  for (const m of [3, 3, -1, 25, -21, 0, 18, 19, 40, 8, 9, 5, 6, 11, 13]) step("set " + m, () => d.setCamMode(m));
  step("set 3 eph", () => d.setCamMode(3, { persist: false }));
  w.wheelLcd = false;
  step("wheel", () => { for (const f of w.wheelFns) f(); });
  step("set 3 again", () => d.setCamMode(3));
  w.wheelLcd = true;
  w.state = "menu";
  step("set 0 menu", () => d.setCamMode(0));
  w.state = "count";
  // A REAL RACE WATCH with AUTO on.
  w.replay.running = true; w.replay.auto = true;
  step("watch set 4", () => d.setCamMode(4));
  step("watch pick 7", () => d.pick(7));
  step("watch auto", () => d.toAuto());
  for (let i = 0; i < 25; i++) step("watch cycle", () => d.cycleCam());
  d.setCamModeRaw(CAM_MODES.length - 1);
  step("watch cycle@last", () => d.cycleCam());
  step("watch cycle@auto", () => d.cycleCam());
  w.replay.running = false;
  step("watch over", () => d.cycleCam());
  step("toAuto off-watch", () => d.toAuto());
  return out;
}

function runPort(): unknown {
  const w = world();
  const deps: CamModesDeps = {
    store: w.store, doc: w.doc as unknown as Document, watch: () => w.replay,
    extraRigs: w.extraRigs, feel: w.feel, audio: w.audio, tuner: { refreshCamTunePanel: w.tuner },
    cockpit: w.cockpit, hudLayout: w.hudLayout, gameState: () => w.state, refreshHud: w.refreshHud,
    initialMode: START, comfortBoot: false,
  };
  const cams = createCamModes(deps);
  const boot = w.log.slice();
  const trace = script(w, {
    setCamMode: (m, o) => cams.setCamMode(m, o), cycleCam: () => cams.cycleCam(),
    camMode: () => cams.state.camMode, camCutT: () => cams.state.camCutT,
    setCamModeRaw: (m) => { cams.state.camMode = m; }, pick: (m) => cams.pickCam(m), toAuto: () => cams.toAuto(),
  });
  return { modes: CAM_MODES, boot, trace };
}

function runF1(): unknown {
  const w = world();
  const G = {
    $: (id: string) => w.doc.getElementById(id), camMode: START, camCutT: 0, store: w.store,
    get state() { return w.state; }, refreshHud: w.refreshHud,
  };
  const CamModes = f1Cam<{ CAM_MODES: unknown[]; create(g: unknown): Record<string, (...a: unknown[]) => string> }>(["mode-switch.js"], "window.CamModes", {
    window: {}, document: w.doc,
    RealRace: { replay: () => w.replay }, ExtraRigs: w.extraRigs, CamFeel: w.feel, GameAudio: w.audio,
    CamTunerPanel: { refresh: w.tuner }, CockpitOpts: w.cockpit, HudLayout: w.hudLayout,
    setTimeout, clearTimeout,
  });
  w.log.length = 0;
  const api = CamModes.create(G);
  const boot = w.log.slice();
  // pickCam / toAuto are not on f1-game's create() surface: reach them through
  // the picker's AUTO / shot behaviour, which is cycleCam + setCamMode here.
  const trace = script(w, {
    setCamMode: (m, o) => api["setCamMode"]!(m, o), cycleCam: () => api["cycleCam"]!(),
    camMode: () => G.camMode, camCutT: () => G.camCutT,
    setCamModeRaw: (m) => { G.camMode = m; },
    // pickCam(m) = setCamMode(m) then, in a WATCH, takePicture + refreshCamBtn (mode-switch.js:106-111).
    pick: (m) => { const id = api["setCamMode"]!(m); if (w.replay.running && w.replay.isRunning()) { w.replay.takePicture(); api["refreshCamBtn"]!(); } return id; },
    toAuto: () => { if (w.replay.running) { w.replay.setAuto(true); api["refreshCamBtn"]!(); } return "auto"; },
  });
  return { modes: CamModes.CAM_MODES, boot, trace };
}

describe("CamModes parity with f1-game mode-switch.js", () => {
  it.skipIf(!hasCam)("matches the VM bit-exactly over the scripted sequence (and refreshes the fixture)", () => {
    const f1 = runF1();
    maybeWriteFixture("modes", f1);
    expectBitExact(runPort(), f1);
  });
  it("matches the committed f1-game fixture", () => {
    expect(hasFixture("modes")).toBe(true);
    expectBitExact(runPort(), readFixture("modes"));
  });
});

describe("CamModes (ported assertions)", () => {
  it("keeps tv at its shipped index 18 and visor before it (save-format index contract)", () => {
    const ids = CAM_MODES.map((m) => m.id);
    expect(ids.indexOf("tv")).toBe(18);
    expect(ids.indexOf("visor")).toBeLessThan(ids.indexOf("tv"));
    expect(ids.indexOf("helmet")).toBe(19);
  });

  it("carries per-mode cut ease durations; cut 0 is an instant cut", () => {
    const idx = (id: string): number => CAM_MODES.findIndex((m) => m.id === id);
    const cams = createCamModes({ doc: null, initialMode: 0, comfortBoot: false });
    const cutTo = (id: string): number => { cams.state.camMode = id === "chase" ? idx("cockpit") : idx("chase"); cams.setCamMode(idx(id)); return cams.state.camCutT; };
    expect(cutTo("cinematic")).toBe(0.6);
    expect(cutTo("heli")).toBe(0.55);
    expect(cutTo("side")).toBe(0.45);
    for (const id of ["cockpit", "hood", "tcam", "visor", "helmet"]) {
      cams.state.camCutT = 9;
      expect(cutTo(id)).toBe(0);
    }
  });

  it("the CAM button's accessible name starts with the word it shows", () => {
    const btn = document.createElement("button");
    btn.id = "btn-cam"; document.body.appendChild(btn);
    const cams = createCamModes({ doc: document, initialMode: 0, comfortBoot: false });
    expect(btn.textContent).toBe("CHASE");
    expect(btn.getAttribute("aria-label")).toBe("CHASE camera");
    cams.setCamMode(3);
    expect(btn.textContent).toBe("COCKPIT");
    expect(btn.getAttribute("aria-label")!.toLowerCase().startsWith("cockpit")).toBe(true);
    expect(document.body.classList.contains("cockpit-cam")).toBe(true);
    cams.setMode("helmet");
    expect(document.body.hasAttribute("data-helmet-cam")).toBe(true);
    expect(document.body.classList.contains("cockpit-cam")).toBe(false);
    btn.remove();
  });

  it("the picker is a keyboard radio menu; hold-release keeps it, a cancelled hold never eats a tap", () => {
    document.body.innerHTML = '<button id="btn-cam"></button>';
    const btn = document.getElementById("btn-cam")!;
    const saved: Record<string, unknown> = {};
    const store: CamStore = { get: (_k, d) => d, set: (k, v) => { saved[k] = v; }, raw: () => null, rawSet: () => {} };
    const cams = createCamModes({ doc: document, store, initialMode: 2, comfortBoot: false });
    const picker = mountCamPicker(cams, btn, document);
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    btn.dispatchEvent(new Event("contextmenu", { cancelable: true }));
    const grid = document.getElementById("campicker")!;
    expect(grid.getAttribute("role")).toBe("menu");
    expect(grid.className).toBe("balanced-row");
    expect(grid.hidden).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const items = Array.from(grid.children) as HTMLElement[];
    expect(items.length).toBe(CAM_MODES.length);
    expect(items.map((b) => b.getAttribute("aria-checked") === "true")).toEqual(items.map((_, i) => i === 2));
    expect(document.activeElement).toBe(items[2]);
    const key = (k: string): void => { grid.dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true })); };
    key("ArrowRight"); expect(document.activeElement).toBe(items[3]);
    key("ArrowDown"); expect(document.activeElement).toBe(items[4]);
    key("ArrowLeft"); expect(document.activeElement).toBe(items[3]);
    key("ArrowUp"); expect(document.activeElement).toBe(items[2]);
    key("End"); expect(document.activeElement).toBe(items[items.length - 1]);
    key("ArrowRight"); expect(document.activeElement).toBe(items[0]);
    key("Escape");
    expect(grid.hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(cams.cycleCam()).toBe("cockpit");
    expect(saved["camMode"]).toBe(3);
    // A short tap cycles; a picker open on the tap closes instead.
    btn.click();
    expect(cams.state.camMode).toBe(4);
    picker.show(); btn.click();
    expect(picker.visible()).toBe(false);
    expect(cams.state.camMode).toBe(4);
    picker.unmount();
    expect(document.getElementById("campicker")).toBeNull();
  });

  it("in a WATCH the picker and the C cycle carry AUTO; outside one they do not", () => {
    document.body.innerHTML = '<button id="btn-cam"></button>';
    const btn = document.getElementById("btn-cam")!;
    const calls: string[] = [];
    const r = {
      running: false, auto: false,
      isRunning: () => r.running, autoOn: () => r.auto,
      setAuto: (v: boolean) => { calls.push("auto"); r.auto = !!v; },
      takePicture: () => { calls.push("take"); r.auto = false; },
    };
    const cams = createCamModes({ doc: document, watch: () => r, initialMode: 2, comfortBoot: false });
    const picker = mountCamPicker(cams, btn, document);
    const open = (): HTMLElement[] => { picker.show(); return Array.from(document.getElementById("campicker")!.children) as HTMLElement[]; };
    const plain = open().length;
    expect(open().some((b) => b.dataset["idx"] === "auto")).toBe(false);
    picker.hide();
    r.running = true; r.auto = true;
    let items = open();
    expect(items.length).toBe(plain + 1);
    expect(items[0]!.dataset["idx"]).toBe("auto");
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");
    items[4]!.click();
    expect(calls).toEqual(["take"]);
    expect(cams.state.camMode).toBe(3);
    expect(btn.textContent!.startsWith("AUTO")).toBe(false);
    items = open();
    expect(items[0]!.getAttribute("aria-checked")).toBe("false");
    expect(items[4]!.getAttribute("aria-checked")).toBe("true");
    items[0]!.click();
    expect(calls).toEqual(["take", "auto"]);
    expect(btn.textContent).toMatch(/^AUTO · /);
    cams.cycleCam();
    expect(r.auto).toBe(false);
    cams.state.camMode = CAM_MODES.length - 1;
    expect(cams.cycleCam()).toBe("auto");
    expect(r.auto).toBe(true);
    r.running = false;
    expect(open().length).toBe(plain);
    picker.unmount();
  });
});

describe("CamModes registry (the lane-shell seam)", () => {
  it("fits src/xr/boot.ts XrBootApi.camModes and finds the cockpit", () => {
    const cams = createCamModes({ doc: null, initialMode: 0, comfortBoot: false });
    const camModes: XrBootApi["camModes"] = cams.modes;
    const viaConst: XrBootApi["camModes"] = CAM_MODES;
    expect(camModes!.findIndex((c) => c.id === "cockpit")).toBe(3);
    expect(viaConst!.findIndex((c) => c.id === "cockpit")).toBe(3);
  });

  it("registers rigs on built-in ids in place and appends new ids; vantage dispatches", () => {
    const gameCams = { vantage: (mode: string, s: number) => ({ eye: [s, 1, 0], tgt: [0, 0, 0], fov: mode === "far" ? 61 : 50 }) };
    const cams = createCamModes({ doc: null, initialMode: 0, comfortBoot: false, gameCams });
    const live = cams.modes;
    expect(cams.registerMode("chase", (s) => ({ eye: [s, 2, 0], tgt: [0, 0, 0], fov: 57 }))).toBe(0);
    expect(cams.modes.length).toBe(CAM_MODES.length);
    expect(cams.vantage("chase", 5, 0, 0, 0, {})!.eye).toEqual([5, 2, 0]);
    expect(cams.vantage("far", 5, 0, 0, 0, {})!.fov).toBe(61);
    const i = cams.registerMode({ id: "vantage-x", label: "VANTAGE", cut: 0.3 }, () => ({ eye: [9, 9, 9], tgt: [0, 0, 0] }));
    expect(i).toBe(CAM_MODES.length);
    expect(live.length).toBe(CAM_MODES.length + 1);   // the same live array
    expect(cams.indexOf("vantage-x")).toBe(i);
    expect(cams.rigOf("vantage-x")).toBeTypeOf("function");
    expect(() => cams.registerMode("nope")).toThrow();
    expect(CAM_MODES.length).toBe(20);   // the built-in list never grows
    const none = createCamModes({ doc: null, initialMode: 0, comfortBoot: false });
    expect(none.vantage("chase", 0, 0, 0, 0, {})).toBeNull();
  });

  it("setMode by id, next/prev wrap, current(), change listeners fire on real changes only", () => {
    const cams = createCamModes({ doc: null, initialMode: 0, comfortBoot: false });
    const seen: Array<[string, number, number]> = [];
    const off = cams.onChange((m, i, p) => seen.push([m.id, i, p]));
    expect(cams.setMode("tv")).toBe("tv");
    expect(cams.current().id).toBe("tv");
    expect(cams.currentIndex()).toBe(18);
    cams.setMode("tv");
    expect(cams.setMode("unknown")).toBe("tv");
    expect(cams.next()).toBe("helmet");
    expect(cams.next()).toBe("chase");
    expect(cams.prev()).toBe("helmet");
    off();
    cams.prev();
    expect(seen).toEqual([["tv", 18, 0], ["helmet", 19, 18], ["chase", 0, 19], ["helmet", 19, 0]]);
  });

  it("boots from the saved a26.camMode, clamped (game.js:837), HELMET on a first boot", () => {
    const mk = (v: unknown): number => createCamModes({
      doc: null, comfortBoot: false,
      store: { get: (k, d) => (k === "camMode" && v !== undefined ? v : d), set: () => {}, raw: () => null, rawSet: () => {} },
    }).state.camMode;
    expect(mk(undefined)).toBe(19);
    expect(mk(4)).toBe(4);
    expect(mk(99)).toBe(19);
    expect(mk(-3)).toBe(0);
    expect(mk(3.7)).toBe(3);
  });
});
