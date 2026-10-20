// @vitest-environment happy-dom
// The garage setup camera (src/garage/setup-camera.ts) against f1-game's
// js/garage/setup-camera.js.
// - panelCover / presentOpts / glareScale: f1-game tests/unit/garage-panel-side.test.mjs
//   assertions, ported, plus a bit-exact sweep against the original.
// - The camera itself: f1-game's create(G, deps) runs in a Node VM whose
//   window/document are this happy-dom page, beside the TS port, both over the
//   same #carsetup markup, stub room and recording renderer. The same session
//   (turntable frames, presets, nudges, pan, held controls, drag, pinch-free
//   wheel zoom, left dock, portrait, active aero, arrival, drive-out, Home) is
//   played on each and every begin() matrix, eye, draw matrix and present must
//   match bit for bit. Skipped where /home/f1-game is absent.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSetupCamera, glareScale, lookAtTo, panelCover, perspectiveTo, presentOpts, SP_VIEWS, type SetupCameraDeps, type SetupCameraHost,
} from "../../../src/garage/setup-camera";
import { buildCarsetup } from "../../../src/garage/index";
import { recentre } from "../../../src/garage/scene/scene";
import * as CssZoom from "../../../src/styles/css-zoom";
import { F1_ROOT, hasF1 } from "../data/f1-vm";

const hasCam = hasF1 && (() => { try { readFileSync(path.join(F1_ROOT, "js/garage/setup-camera.js")); return true; } catch { return false; } })();
const read = (f: string): string => readFileSync(path.join(F1_ROOT, f), "utf8");
const LOG = { info() {}, warn() {}, error() {}, debug() {}, enabled: () => false };
type Fn = (...a: unknown[]) => unknown;
/** Numbers as tagged strings so -0 / NaN / bit differences fail deep equality. */
const bits = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x: unknown) =>
  typeof x === "number" ? `n:${Object.is(x, -0) ? "-0" : x}` : (x && typeof x === "object" && ArrayBuffer.isView(x)) ? Array.from(x as unknown as ArrayLike<number>) : x));

function f1Static(globals: Record<string, unknown> = {}): Record<string, Fn> {
  const ctx = createContext({ PhysicsConsts: { X_OPEN_RATE: 1, X_CLOSE_RATE: 1 }, ...globals });
  runInContext(read("js/garage/setup-camera.js"), ctx);
  return runInContext("SetupCamera", ctx) as Record<string, Fn>;
}
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
const noCam = (): number => { throw new Error("camTop must only be read on the portrait axis"); };
const CANVAS = rect(0, 0, 1440, 900);

describe("panelCover (garage-panel-side.test.mjs)", () => {
  it("a RIGHT dock returns the same unsigned fraction it always did", () => {
    for (const w of [0, 120, 410, 540, 1100, 1440]) {
      const c = panelCover(rect(1440 - w, 0, w, 900), CANVAS, 1440, 900, noCam);
      expect(c.x, `width ${w}`).toBe(Math.min(Math.max(w / 1440, 0), 0.85));
      expect(Object.is(c.x, -0), "a right dock never goes negative, not even -0").toBe(false);
      expect(c.y).toBe(0);
    }
  });
  it("a LEFT dock is the exact mirror, so the car lands in the right half", () => {
    for (const w of [120, 410, 540, 1300]) {
      const r = panelCover(rect(1440 - w, 0, w, 900), CANVAS, 1440, 900, noCam);
      const l = panelCover(rect(0, 0, w, 900), CANVAS, 1440, 900, noCam);
      expect(l.x).toBe(-r.x); expect(l.x).toBeLessThan(0);
      const f = Math.abs(l.x);
      expect(Math.abs(-l.x - ((-1 + 2 * f) + 1) / 2)).toBeLessThan(1e-12);
      expect(Math.abs(-r.x - (-1 + (1 - 2 * f)) / 2)).toBeLessThan(1e-12);
    }
  });
  it("the side is judged against the canvas's own rect, not x = 0", () => {
    const off = rect(100, 0, 1440, 900);
    expect(panelCover(rect(100, 0, 500, 900), off, 1440, 900, noCam).x).toBeLessThan(0);
    expect(panelCover(rect(1040, 0, 500, 900), off, 1440, 900, noCam).x).toBeGreaterThan(0);
  });
  it("portrait keeps its vertical band and reads the camera panel lazily", () => {
    let reads = 0;
    const c = panelCover(rect(0, 0, 393, 597), rect(0, 0, 393, 852), 393, 852, () => { reads++; return 700; });
    expect(reads).toBe(1); expect(c.x).toBe(0); expect(c.y).toBe((597 + 700 - 852) / 852);
  });
  it.skipIf(!hasCam)("matches f1-game bit for bit over a sweep", () => {
    const F = f1Static();
    for (const [cw, ch] of [[1440, 900], [393, 852], [844, 390], [1024, 1366]] as const)
      for (const w of [0, 120, 300, 410, 700, 2000]) for (const left of [-40, 0, 300, cw - w])
        for (const h of [200, ch, ch + 40]) {
          const pr = rect(left, 0, w, h), cr = rect(0, 0, cw, ch);
          expect(bits(panelCover(pr, cr, cw, ch, () => 640))).toEqual(bits(F["panelCover"]!(pr, cr, cw, ch, () => 640)));
        }
  });
});

describe("presentOpts / glareScale (garage-panel-side.test.mjs:178-212)", () => {
  it("garage present routes through Lighting Tuner multipliers", () => {
    const def = presentOpts({ exposureMul: 1, bloomMul: 1, threshOff: 0, sunShaftMul: 1, glareStr: 0.12 });
    const defExposure = def.exposure, defBloom = def.bloom, defThreshold = def.threshold;
    expect(defExposure > 0.92 && defExposure < 1.12).toBe(true);
    expect(defBloom > 0.10 && defBloom < 0.32).toBe(true);
    expect(defThreshold).toBeGreaterThanOrEqual(0.75);
    expect([def.contact, def.reflect, def.carReflect, def.ssao, def.godray]).toEqual([0, 0, 0, 0, 0]);
    expect(def.tune!.sunShaftMul).toBe(0);
    const hot = presentOpts({ exposureMul: 1.5, bloomMul: 2, threshOff: 0, sunShaftMul: 2.5, glareStr: 0.24 });
    expect(Math.abs(hot.exposure - defExposure * 1.5)).toBeLessThan(1e-9);
    expect(Math.abs(hot.bloom - defBloom * 2)).toBeLessThan(1e-9);
    expect(hot.tune!.sunShaftMul, "hot race sunShaftMul must not reopen garage shafts").toBe(0);
    expect(glareScale({ glareStr: 0.12 })).toBe(1);
    expect(glareScale({ glareStr: 0 })).toBe(0);
    expect(Math.abs(glareScale({ glareStr: 0.24 }) - 2)).toBeLessThan(1e-9);
  });
  it.skipIf(!hasCam)("matches f1-game for tuner, phone and PerfGov combinations", () => {
    const tunes = [undefined, null, { exposureMul: 1.3, bloomMul: 0.5, threshOff: -0.7, glareStr: 0.2, vignette: 0.3 }, { threshOff: 0.9 }, { exposureMul: NaN }];
    const govs = [null, { autoTier: () => 4 }, { userTier: () => 2, autoShed: () => 0 }, { userTier: () => 4 }, { userTier: () => 0, autoShed: () => 3 }];
    for (const phone of [false, true]) for (const gov of govs) for (const live of [null, { exposureMul: 0.8, bloomMul: 1.4 }]) {
      const F = f1Static({ GLX: { isMobile: phone }, ...(gov ? { PerfGov: gov } : {}), ...(live ? { LightTune: { LT: live } } : {}) });
      const env = { phone: () => phone, perfGov: gov, lightTune: () => live };
      for (const t of tunes) {
        const a = presentOpts(t, env), b = F["presentOpts"]!(t) as typeof a;
        const flat = (o: typeof a) => ({ ...o, tune: o.tune && { sunShaftMul: o.tune.sunShaftMul, proto: Object.getPrototypeOf(o.tune) && JSON.stringify(Object.getPrototypeOf(o.tune)) } });
        expect(bits(flat(a))).toEqual(bits(flat(b)));
        expect(bits(glareScale(t, env))).toEqual(bits(F["glareScale"]!(t)));
      }
    }
  });
  it.skipIf(!hasCam)("perspectiveTo / lookAtTo are js/core/mat4.js bit for bit", () => {
    const ctx = createContext({}); runInContext(read("js/core/mat4.js"), ctx);
    const M4 = runInContext("M4", ctx) as Record<string, Fn>;
    for (const [fov, aspect] of [[36, 1.6], [72, 0.46], [54, 1.33]] as const) {
      const a = perspectiveTo(new Float32Array(16), fov * Math.PI / 180, aspect, 0.1, 60);
      expect(bits(a)).toEqual(bits(M4["perspectiveTo"]!(new Float32Array(16), fov * Math.PI / 180, aspect, 0.1, 60)));
    }
    for (const eye of [[3, 2, 8], [0, 11, 0.001], [-7.3, 0.4, -2]]) {
      const a = lookAtTo(new Float32Array(16), eye, [0, 0.45, 0.245], [0, 1, 0]);
      expect(bits(a)).toEqual(bits(M4["lookAtTo"]!(new Float32Array(16), eye, [0, 0.45, 0.245], [0, 1, 0])));
    }
  });
});

// ── the live camera, f1-game vs TS ──────────────────────────────────────────

const HULL: number[] = [];
for (let i = 0; i < 48; i++) HULL.push(Math.sin(i * 1.3) * 0.95, 0.05 + Math.abs(Math.cos(i * 0.7)) * 0.95, Math.sin(i * 0.41) * 2.9 + 0.245);
const TEAMS = [{ id: "mclaren", name: "McLaren", short: "MCL", engine: "mercedes", drivers: [{ name: "Lando Norris", code: "NOR", num: 4 }, { name: "Oscar Piastri", code: "PIA", num: 81 }] }];
const LIV = { id: "default", c1: [0.95, 0.45, 0.05], c2: [0.05, 0.05, 0.06], stripe: null, finShape: "none" };
const TRACKS = { LIST: [{ id: "monza", name: "Monza", night: false }, { id: "sing", name: "Singapore", night: true }], SEASON: [] };
const AIM = (_v: unknown, which: unknown): number[] => (which === "rear" ? [0, 0.95, -2.6] : [0, 0.32, 2.95]);

interface Side { cam: Record<string, Fn> & { az: number; el: number; dist: number; spin: boolean; aeroX: number; effDist: number }; log: unknown[];
  container: HTMLElement; G: { setupPreviewOn: boolean; teamIdx: number; raceTimeOfDay: string; trackIdx: number }; gfx: { aspect: number };
  canvas: HTMLElement; panel: HTMLElement; clock: { t: number } }

function dom(): { container: HTMLElement; canvas: HTMLElement; panel: HTMLElement; $: (id: string) => HTMLElement | null } {
  const container = document.createElement("div");
  container.appendChild(buildCarsetup());
  // The ARRIVAL TUNER's controls (index.html #garrival), which bindSettings reads.
  const tuner = document.createElement("div");
  tuner.innerHTML = '<input id="ga-enabled" type="checkbox"><input id="ga-speed"><select id="ga-angle"><option value="cut">cut</option><option value="left">left</option></select><input id="ga-fov"><button id="ga-reset"></button>';
  container.appendChild(tuner);
  const canvas = document.createElement("div"); canvas.id = "game"; container.appendChild(canvas);
  document.body.appendChild(container);
  const $ = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[id="${id}"]`);
  const panel = $("cs-inner")!;
  const size = (el: HTMLElement, w: () => number, h: () => number, r: () => ReturnType<typeof rect>): void => {
    Object.defineProperty(el, "clientWidth", { get: w, configurable: true });
    Object.defineProperty(el, "clientHeight", { get: h, configurable: true });
    el.getBoundingClientRect = () => r() as DOMRect;
  };
  const geo = { cw: 1440, ch: 900, pw: 410, side: "right" as "right" | "left" };
  (container as unknown as { geo: typeof geo }).geo = geo;
  size(canvas, () => geo.cw, () => geo.ch, () => rect(0, 0, geo.cw, geo.ch));
  size(panel, () => geo.pw, () => (geo.cw > geo.ch ? geo.ch : 520), () => geo.cw > geo.ch
    ? rect(geo.side === "right" ? geo.cw - geo.pw : 0, 0, geo.pw, geo.ch) : rect(0, 0, geo.cw, 520));
  return { container, canvas, panel, $ };
}

function stubScene(log: unknown[]) {
  return {
    SKYLIGHT: [0.55, 0.55, 0.58], AMB_SKY: [0.2, 0.215, 0.25], AMB_GROUND: [0.13, 0.125, 0.118], BACKDROP: [0.035, 0.038, 0.046],
    spot: (n: unknown) => log.push(["spot", n]), dropPreviewMeshes: () => log.push(["drop"]),
    previewMesh: (key: string, hullKey: string, build: () => unknown) => { log.push(["previewMesh", key, hullKey, build()]); return { mesh: { key }, hull: HULL, hullKey }; },
    seatDriverAt: (team: typeof TEAMS[0], i: number) => team.drivers[i] || team.drivers[0],
    recentre, live: (_l: unknown, t: number, ctx: Record<string, unknown>) => { log.push(["live", t, { ...ctx, track: (ctx["track"] as { id?: string } | null)?.id }]); return [1, 2, 3]; },
    draw: (_t: unknown, _l: unknown, eye: number[], _g: unknown, d: number, ctx: Record<string, unknown>, mesh: unknown, arr: unknown, mat: ArrayLike<number>) =>
      log.push(["scene.draw", [...eye], d, ctx["night"], ctx["ambient"], ctx["studio"], mesh, arr, Array.from(mat)]),
    glareStr: () => 0.08, ctxKey: () => "ctx", prepare: () => true, prepared: () => true, release: () => 0,
  };
}
function recGfx(log: unknown[]) {
  return {
    aspect: 1.6, isMobile: false,
    resize: () => {}, warming: () => false,
    begin: (o: Record<string, ArrayLike<number> | unknown>) => { log.push(["begin", Array.from(o["viewProj"] as ArrayLike<number>), Array.from(o["view"] as ArrayLike<number>), Array.from(o["proj"] as ArrayLike<number>), Array.from(o["invProj"] as ArrayLike<number>), Array.from(o["eye"] as ArrayLike<number>), o["lights"]]); return true; },
    draw: (m: unknown, mat: ArrayLike<number>, opts: unknown) => log.push(["draw", m, Array.from(mat), JSON.stringify(opts)]),
    drawGlow: (l: unknown, s: number) => log.push(["glow", l, s]),
    present: (o: unknown) => log.push(["present", JSON.stringify(o)]),
    createMesh: () => ({}), freeMesh: () => {}, drawDecal: () => {},
  };
}
const rearLights = (log: unknown[]) => (mat: ArrayLike<number>, k: number): void => { log.push(["rear", Array.from(mat), k]); };
const carDeps = (log: unknown[]) => ({
  resolveLivery: () => LIV, partsVisualKey: (id: string) => id + "|parts",
  drawAeroFlaps: (_t: unknown, val: number, x: number, mat: ArrayLike<number>) => log.push(["flaps", val, x, Array.from(mat)]),
  teamDecalState: () => ({ val: 2, aero: null }), carDecalNum: () => 99,
  drawCarDecals: (_t: unknown, mat: ArrayLike<number>, p: boolean, num: unknown) => log.push(["decals", Array.from(mat), p, num]),
  carPaintMat: () => ({ roughness: 0.3 }), PAINT_DRY_DAY: 1,
  MAT_REFLECT_X: new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), render: () => {},
});
function host(d: ReturnType<typeof dom>, gfx: ReturnType<typeof recGfx>) {
  const store = new Map<string, unknown>([["motion", "off"]]);
  return {
    $: d.$, gfx, clamp: (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v), getTeamParts: () => ({}),
    store: { get: (k: string, def: unknown) => (store.has(k) ? store.get(k) : def), set: (k: string, v: unknown) => { store.set(k, v); return true; }, rev: 1 },
    teamIdx: 0, driverIdx: 1, soundOn: false, setupPreviewOn: true, skyHold: false, raceWeather: "dry", raceTimeOfDay: "default", trackIdx: 0, unlimitedBudget: false,
  };
}

function f1Side(): Side {
  const log: unknown[] = [], d = dom(), gfx = recGfx(log), clock = { t: 1000 };
  (window as unknown as { CssZoom: typeof CssZoom }).CssZoom = CssZoom;
  const pc = createContext({}); (pc as { window?: unknown }).window = pc;
  runInContext(read("js/physics/consts.js"), pc);
  const ctx = createContext({
    window, document, CssZoom, Log: LOG, PhysicsConsts: (pc as { PhysicsConsts?: unknown }).PhysicsConsts, performance: { now: () => clock.t }, requestAnimationFrame: () => 0,
    GarageScene: stubScene(log), Teams: { LIST: TEAMS }, Car3D: { aeroFlapAim: AIM, build: () => ({ built: true }) },
    Parts: { getVisualTiers: () => ({ tiers: 1 }) }, CarMesh: { drawRearLights: rearLights(log) }, Career: { inCareer: () => false }, Tracks: TRACKS,
  });
  for (const f of ["js/core/mat4.js", "js/garage/arrival.js", "js/garage/experience.js", "js/garage/setup-camera.js"])
    runInContext(read(f).replace(/^const (\w+) = /m, "var $1 = "), ctx, { filename: f });
  const G = host(d, gfx);
  const cam = (runInContext("SetupCamera", ctx) as { create: Fn }).create(G, carDeps(log)) as Side["cam"];
  return { cam, log, container: d.container, G, gfx, canvas: d.canvas, panel: d.panel, clock };
}
function tsSide(): Side {
  const log: unknown[] = [], d = dom(), gfx = recGfx(log), clock = { t: 1000 };
  const G = host(d, gfx);
  const deps = {
    ...carDeps(log), scene: stubScene(log), teams: TEAMS, tracks: TRACKS, career: { inCareer: () => false },
    drawRearLights: rearLights(log), aeroFlapAim: AIM, buildCar: () => ({ built: true }), surfaceInspection: null, now: () => clock.t, log: LOG,
  } as unknown as SetupCameraDeps;
  const cam = createSetupCamera(G as unknown as SetupCameraHost, deps) as unknown as Side["cam"];
  return { cam, log, container: d.container, G, gfx, canvas: d.canvas, panel: d.panel, clock };
}

/** One garage session; returns the snapshots taken along the way. */
function session(s: Side): unknown[] {
  const out: unknown[] = [];
  const $ = (id: string): HTMLElement => s.container.querySelector<HTMLElement>(`[id="${id}"]`)!;
  const geo = (s.container as unknown as { geo: { cw: number; ch: number; pw: number; side: string } }).geo;
  const frame = (dt: number): void => { s.clock.t += dt * 1000; out.push(s.cam["renderSetupPreview"]!(dt)); };
  const snap = (label: string): void => { out.push(label, s.cam.az, s.cam.el, s.cam.dist, s.cam.spin, s.cam.aeroX, s.cam.effDist, s.cam["captureCamera"]!()); };
  const ptr = (el: EventTarget, type: string, id: number, x: number, y: number): void => {
    el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  };
  for (let i = 0; i < 3; i++) frame(1 / 60);
  snap("turntable");
  for (const v of Object.keys(SP_VIEWS)) { s.cam["setSetupView"]!(v); frame(0.016); snap(v); }
  s.cam["nudgeSetupCam"]!(0.18, 0.12, 1 / 1.12); frame(0.02); snap("nudge");
  s.cam["nudgeSetupCam"]!(0, 9, 0.01); frame(0.02); snap("clamped");
  s.cam["setupPan"]!(5, -7); frame(0.02); snap("pan clamp");
  $("cs-view-reset").click(); frame(0.016); snap("reset");
  ptr($("cs-view-left"), "pointerdown", 7, 0, 0); frame(0.1); frame(0.1); ptr(window, "pointerup", 7, 0, 0); frame(0.05); snap("held left");
  ptr($("cs-view-out"), "pointerdown", 8, 0, 0); frame(0.2); ptr($("cs-view-out"), "pointerup", 8, 0, 0); snap("held out");
  ptr($("cs-pan-fwd"), "pointerdown", 9, 0, 0); frame(0.3); ptr(window, "pointercancel", 9, 0, 0); snap("held pan");
  ptr(s.canvas, "pointerdown", 3, 500, 400); ptr(window, "pointermove", 3, 380, 455); ptr(window, "pointerup", 3, 380, 455); frame(0.016); snap("drag");
  s.canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 3, cancelable: true })); frame(0.016); snap("wheel");
  $("cs-cam").click(); out.push($("cs-cam-panel").hidden); $("cs-view-spin").click(); frame(0.5); snap("spin on, panel open");
  geo.side = "left"; document.documentElement.setAttribute("data-look-garage-side", s === undefined ? "" : "left"); frame(0.016); snap("left dock");
  document.documentElement.removeAttribute("data-look-garage-side"); geo.side = "right";
  geo.cw = 393; geo.ch = 852; s.gfx.aspect = 393 / 852; frame(0.016); snap("portrait");
  geo.cw = 1440; geo.ch = 900; s.gfx.aspect = 1.6;
  s.cam["setSetupAero"]!(true); for (let i = 0; i < 8; i++) frame(1 / 30); snap("aero open");
  s.cam["setSetupAero"]!(false); for (let i = 0; i < 4; i++) frame(1 / 30); snap("aero shut");
  s.G.raceTimeOfDay = "night"; frame(0.016); s.G.raceTimeOfDay = "default"; s.G.trackIdx = 1; frame(0.016); snap("night track");
  s.cam["startArrival"]!(); for (let i = 0; i < 40; i++) frame(0.1); snap("arrival");
  out.push(s.cam["startDriveOut"]!()); for (let i = 0; i < 30; i++) { s.clock.t += 120; out.push(s.cam["renderSetupPreview"]!(0.05)); }
  out.push(s.cam["driveOutLeft"]!()); s.cam["stopDriveOut"]!(); snap("drive-out");
  // Home: the title borrows the room (the garage screen is hidden).
  $("carsetup").hidden = true;
  const homePanel = document.createElement("div"); s.container.appendChild(homePanel);
  Object.defineProperty(homePanel, "clientWidth", { get: () => 500 }); Object.defineProperty(homePanel, "clientHeight", { get: () => 900 });
  homePanel.getBoundingClientRect = () => rect(940, 0, 500, 900) as DOMRect;
  out.push(s.cam["beginHome"]!("night", { shot: "front", motion: "ambient", panel: homePanel }));
  for (let i = 0; i < 3; i++) { s.clock.t += 16; out.push(s.cam["renderHome"]!(0.016)); }
  out.push(s.cam["homeState"]!()); out.push(s.cam["endHome"]!()); snap("home restored");
  out.push(s.cam["previewKey"]!(), s.cam["meshKey"]);
  s.G.setupPreviewOn = false;   // park this side's window listeners
  return out;
}

afterEach(() => { document.body.replaceChildren(); });

describe.skipIf(!hasCam)("the live camera matches f1-game's create(G, deps) bit for bit", () => {
  it("a full garage session: frames, presets, controls, docks, aero, arrival, drive-out, Home", () => {
    const a = f1Side(), outA = session(a);
    const b = tsSide(), outB = session(b);
    expect(bits(outB)).toEqual(bits(outA));
    // …and the session really reached every path it claims to.
    const kinds: Record<string, number> = {};
    for (const e of a.log) { const k = (e as unknown[])[0] as string; kinds[k] = (kinds[k] || 0) + 1; }
    expect(kinds["begin"]).toBeGreaterThan(80);
    expect(kinds["rear"], "the night arrival lights the rain light").toBeGreaterThan(0);
    expect(kinds["flaps"]).toBe(kinds["begin"]);
    expect(kinds["previewMesh"]).toBe(1);
    const snapAt = (label: string): unknown[] => outA.slice(outA.indexOf(label), outA.indexOf(label) + 8);
    expect(snapAt("drag")[1], "the drag orbited").not.toBe(snapAt("held pan")[1]);
    expect(snapAt("aero open")[5], "flaps ease open at X_OPEN_RATE").toBeCloseTo(8 / 30 * 2.6, 12);
    expect(outA.filter((v) => v === true).length).toBeGreaterThan(80);
    expect(b.log.length).toBe(a.log.length);
    for (let i = 0; i < a.log.length; i++) expect(bits(b.log[i]), `log[${i}] ${JSON.stringify((a.log[i] as unknown[])[0])}`).toEqual(bits(a.log[i]));
    b.cam["dispose"]!();
  });
});

describe("the camera's own behaviour", () => {
  it("presets stop the turntable; RESET restores it with the default framing; dispose removes window listeners", () => {
    const added: string[] = [], removed: string[] = [];
    const add = window.addEventListener.bind(window), rem = window.removeEventListener.bind(window);
    window.addEventListener = ((t: string, f: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => { added.push(t); add(t, f, o); }) as typeof window.addEventListener;
    window.removeEventListener = ((t: string, f: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => { removed.push(t); rem(t, f, o); }) as typeof window.removeEventListener;
    try {
      const s = tsSide();
      expect(s.cam.spin).toBe(true);
      s.cam["setSetupView"]!("top");
      expect([s.cam.az, s.cam.el, s.cam.dist, s.cam.spin]).toEqual([Math.PI * 0.5, 1.2, 11.5, false]);
      const spin = s.container.querySelector("#cs-view-spin")!;
      expect(spin.getAttribute("aria-pressed")).toBe("false");
      s.cam["setSetupAero"]!(true);
      const aero = s.container.querySelector("#cs-aero")!;
      expect(aero.querySelector(".cs-aero-val")!.textContent).toBe("STRAIGHT MODE");
      (s.container.querySelector("#cs-view-reset") as HTMLElement).click();
      expect([s.cam.az, s.cam.dist, s.cam.spin]).toEqual([0.6, 8.35, true]);
      // Escape shuts the camera panel before the garage's BACK sees it.
      (s.container.querySelector("#cs-cam") as HTMLElement).click();
      expect((s.container.querySelector("#cs-cam-panel") as HTMLElement).hidden).toBe(false);
      const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      window.dispatchEvent(esc);
      expect((s.container.querySelector("#cs-cam-panel") as HTMLElement).hidden).toBe(true);
      expect(esc.defaultPrevented).toBe(true);
      s.cam["dispose"]!();
      expect(removed.sort()).toEqual(added.sort());
    } finally { window.addEventListener = add; window.removeEventListener = rem; }
  });
});
