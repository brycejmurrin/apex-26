// @vitest-environment happy-dom
// The TRACK DESIGNER screen (src/editor/designer.ts) mounted into a happy-dom div over
// the real engine. Ported from f1-game tests/unit/track-designer-dom.test.mjs (the only
// f1-game unit test that drives TrackDesigner; the other files `grep -l TrackDesigner`
// names only mention TrackDesignerProps or stub TrackDesigner for CustomTracks).
//
// Translation:
// - f1-game booted the IIFEs in a Node VM over tests/helpers/mini-dom.mjs; here
//   `mount(div, deps)` builds the screen and CustomTracks is createCustomTracks over a
//   memoryStore (or a localStore over a fake Storage), with a mutable track list as
//   Tracks.LIST's custom tail.
// - Globals the f1-game test swapped on the VM context (TrackFixes, TrackValidate.check,
//   TrackCodec.encode/decode, DesignerCanvas.create) are swapped through vi.mock
//   delegates (`over`); the others (ApexClipboard, NativeDownload, the title doors,
//   UiLayers, location / history) through DesignerDeps / CustomTracksDeps.
// - mini-dom gave every canvas a 640×400 box and a no-op 2D context; the same stubs sit
//   on HTMLCanvasElement.prototype here.
// - Store keys are a26.-prefixed (f1-game: apex26.).
// Skipped (each also named at its site): assertions on f1-game files apex-26 has not
// ported (js/ui/menu-nav.js MenuNav, js/ui/select-screen.js, js/game.js source pins),
// and the GameStore write-through cache (see "SAVE preserves its nondurable warning").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

type Fn = (...a: never[]) => unknown;
const over = vi.hoisted(() => ({
  check: null as null | ((d: unknown) => unknown),
  encode: null as null | ((d: unknown) => Promise<string | null>),
  decode: null as null | ((c: unknown) => Promise<unknown>),
  canvasCreate: null as null | ((c: HTMLCanvasElement, h: object, real: Fn) => unknown),
  real: {} as { check?: (d: unknown) => unknown; encode?: (d: unknown) => Promise<string | null>; decode?: (c: unknown) => Promise<unknown> },
  fixes: null as null | "absent" | { canFix?: (it: unknown) => boolean; apply?: (d: unknown, it: unknown, b: unknown) => unknown; fixAll?: (d: unknown, check: unknown) => unknown },
}));
vi.mock("../../src/editor/validate", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/editor/validate")>();
  over.real.check = real.check;
  return { ...real, check: (d: unknown) => (over.check ? over.check(d) : real.check(d)) };
});
vi.mock("../../src/editor/codec", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/editor/codec")>();
  over.real.encode = real.encode; over.real.decode = real.decode;
  return { ...real, encode: (d: unknown) => (over.encode ? over.encode(d) : real.encode(d)), decode: (c: unknown) => (over.decode ? over.decode(c) : real.decode(c)) };
});
vi.mock("../../src/editor/canvas", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/editor/canvas")>();
  return { ...real, create: (c: HTMLCanvasElement, h: object) => (over.canvasCreate ? over.canvasCreate(c, h, real.create as unknown as Fn) : real.create(c, h)) };
});
vi.mock("../../src/editor/fixes", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/editor/fixes")>();
  type FixesLike = { canFix?: (it: unknown) => boolean; apply?: (d: unknown, it: unknown, b: unknown) => unknown; fixAll?: (d: unknown, check: unknown) => unknown };
  const F = (): FixesLike | null => (over.fixes === "absent" ? null : over.fixes || (real as unknown as FixesLike));
  return {
    ...real,
    canFix: (it: unknown) => { const f = F(); return !!(f && f.canFix && f.canFix(it)); },
    apply: (d: unknown, it: unknown, b: unknown) => { const f = F(); return f && f.apply ? f.apply(d, it, b) : null; },
    fixAll: (d: unknown, check: unknown) => { const f = F(); return f && f.fixAll ? f.fixAll(d, check) : null; },
  };
});

import * as TrackCodec from "../../src/editor/codec";
import * as CustomTracksMod from "../../src/editor/custom-tracks";
import { createCustomTracks, type CustomTracksApi } from "../../src/editor/custom-tracks";
import * as DesignerCanvas from "../../src/editor/canvas";
import * as Designer from "../../src/editor/designer";
import { mount, type Design, type DesignerGame, type DesignerHandle, type DesignerDeps } from "../../src/editor/designer";
import * as TrackInsight from "../../src/editor/insight";
import * as TrackDesignerProps from "../../src/editor/props";
import { localStore, memoryStore, type EditorStore } from "../../src/editor/store";
import * as TrackThemes from "../../src/editor/track-themes";
import * as TrackValidate from "../../src/editor/validate";
import { fromRaw, type BuiltDef, type RawDef } from "../../src/track/core/def";
import * as Tracks from "../../src/track/core/tracks";
import type { Track } from "../../src/track/core/types";

// ── helpers (f1-game tests/helpers/editor-vm.mjs) ─────────────────────────
const plain = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
type P = [number, number];
/** An a×b ellipse of n control points on the 0.25 m lattice (≈ 4.1 km at 800×500). */
function ellipse(n = 36, a = 800, b = 500): P[] {
  const pts: P[] = [], q = (v: number) => Math.round(v * 4) / 4;
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; pts.push([q(a * Math.cos(t)), q(b * Math.sin(t))]); }
  return pts;
}
const design = (extra?: object) => Object.assign({ name: "Test Loop", seed: 7, theme: "parkland", baseHW: 7, pts: ellipse() }, extra) as Record<string, unknown> & { pts: P[] };
const CSS = readFileSync(resolve(process.cwd(), "src/editor/editor.css"), "utf8");

// ── the DOM mini-dom gave every canvas (640×400 box, no-op 2D context) ────
type Ctx2D = Record<string | symbol, unknown>;
const noop2d = (): CanvasRenderingContext2D => new Proxy({} as Ctx2D, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? (s: unknown) => ({ width: String(s).length * 6 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } }) as unknown as CanvasRenderingContext2D;
const RECT = { left: 0, top: 0, right: 640, bottom: 400, width: 640, height: 400, x: 0, y: 0, toJSON() { return this; } } as DOMRect;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) { return ((this as unknown as { _ctx?: CanvasRenderingContext2D })._ctx ||= noop2d()); } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(RECT);
  vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLCanvasElement.prototype, "clientHeight", "get").mockReturnValue(400);
  // f1-game's bootScreen: ctx.requestAnimationFrame = (fn) => setTimeout(fn, 0).
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
});

// ── the screen ────────────────────────────────────────────────────────────
interface Boot {
  D: DesignerHandle; C: CustomTracksApi; G: DesignerGame; root: HTMLElement; store: EditorStore;
  list: BuiltDef[]; clicks: string[]; data: () => Record<string, unknown>;
  loc: { hash: string; pathname: string; search: string }; replaced: string[]; layers: { race: boolean };
  /** The deps handed to mount(), read at call time: a test may swap a member (f1-game swapped VM globals). */
  deps: DesignerDeps;
  hooks?: Record<string, Fn> | undefined;
}
const live: Boot[] = [];
afterEach(() => {
  for (const b of live.splice(0)) { b.D.destroy(); b.root.remove(); }
  over.check = over.encode = over.decode = over.canvasCreate = over.fixes = null;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const SHIPPED = Tracks.LIST.length;

function bootScreen(stored: Record<string, unknown> = {}, opts: { store?: EditorStore; deps?: Partial<DesignerDeps>; custom?: (c: CustomTracksApi) => CustomTracksApi } = {}): Boot {
  const mem = memoryStore();
  const store = opts.store || mem;
  for (const [k, v] of Object.entries(stored)) store.set(k, v);
  const list: BuiltDef[] = [...Tracks.LIST];
  const G: DesignerGame = { soundOn: false, trackIdx: 0 };
  const clicks: string[] = [], replaced: string[] = [];
  const loc = { hash: "", pathname: "/", search: "" }, layers = { race: false };
  let D: DesignerHandle | null = null;
  const C0 = createCustomTracks(store, {
    trackList: () => list,
    setCustomTail: (defs) => { list.splice(SHIPPED, list.length - SHIPPED, ...defs); },
    // TODO(lane-shell): custom-tracks.ts TrackDesignerHooks types init's opts as { custom: unknown }; the handle takes CustomTracksApi.
    designer: () => D as unknown as CustomTracksMod.TrackDesignerHooks,
    codec: () => TrackCodec,
    roster: { LAZY_EDITOR: ["src/editor/designer.ts"], LAZY_EDITOR_EDGES: [] },
    location: () => loc,
    replaceState: (u) => { replaced.push(u); },
    layers: { inRace: () => layers.race },
  });
  const C = opts.custom ? opts.custom(C0) : C0;
  const root = document.createElement("div");
  document.body.appendChild(root);
  const deps: DesignerDeps = Object.assign({ custom: C, game: G, store, trackList: () => list, onRace: () => { clicks.push("mb-race"); }, onTimeTrial: () => { clicks.push("mb-tt"); } }, opts.deps || {});
  D = mount(root, deps);
  const data = () => Object.fromEntries(Object.entries(mem.data).map(([k, v]) => [k, JSON.parse(v)]));
  const b: Boot = { D, C, G, root, store, list, clicks, data, loc, replaced, layers, deps };
  live.push(b);
  return b;
}

/** Every descendant of `root`. */
const walk = (n: Element, out: HTMLElement[] = []): HTMLElement[] => { for (const c of n.children) { out.push(c as HTMLElement); walk(c, out); } return out; };
const kids = (n: Element | null | undefined) => [...(n ? n.children : [])] as HTMLElement[];
const chipsIn = (n: Element, text?: string) => walk(n).filter((e) => e.tagName === "BUTTON" && (text == null || e.textContent === text)) as HTMLButtonElement[];
/** The rail's three panes in build order: design, library, howto. */
const panes = (b: Boot) => kids(b.root.querySelector(".td-rail")).filter((c) => c.tagName === "SECTION");
const msgText = (b: Boot) => b.root.querySelector(".td-msg")!.textContent;
const q = <T extends Element = HTMLElement>(n: ParentNode, sel: string) => n.querySelector(sel) as T;
const st = (b: Boot) => b.D.state();
const dz = (b: Boot) => b.D.state().design!;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function key(target: EventTarget, k: string, extra: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, extra));
  target.dispatchEvent(e);
  return e;
}
function fire(target: EventTarget, type: string, init: Record<string, unknown> = {}) {
  const I = Object.assign({ bubbles: true, cancelable: true }, init);
  const e = type === "wheel" ? new WheelEvent(type, I) : type.startsWith("pointer") || type === "lostpointercapture" ? new PointerEvent(type, I) : type === "dblclick" ? new MouseEvent(type, I) : new Event(type, I);
  // happy-dom's WheelEvent drops clientX / clientY (mini-dom passed the plain object through).
  for (const [k, v] of Object.entries(init)) if ((e as unknown as Record<string, unknown>)[k] !== v) Object.defineProperty(e, k, { value: v });
  target.dispatchEvent(e);
  return e;
}
function openGreen(b: Boot, seed = 7) { b.D.init(b.G, { custom: b.C, root: b.root }); b.D.open(); b.D.randomise(seed); b.D.preview(); return plain(dz(b)); }

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
/** The point at arc fraction f along a closed control polygon. */
function pointAt(pts: readonly P[], f: number): P {
  const N = pts.length, c = [0];
  for (let i = 0; i < N; i++) { const a = pts[i]!, b = pts[(i + 1) % N]!; c.push(c[i]! + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const x = (((f % 1) + 1) % 1) * c[N]!;
  let i = 0; while (i < N - 1 && c[i + 1]! < x) i++;
  const t = (x - c[i]!) / ((c[i + 1]! - c[i]!) || 1), a = pts[i]!, b = pts[(i + 1) % N]!;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
/** The point at control INDEX fraction u (what applyHwZones keys on). */
function pointAtIndex(pts: readonly P[], u: number): P {
  const N = pts.length, x = u * N, i = Math.min(N - 1, Math.floor(x)), t = x - i, a = pts[i]!, b = pts[(i + 1) % N]!;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
const samePlace = (p: readonly number[], q2: readonly number[], tol: number, what: string) => assert.ok(Math.hypot(p[0]! - q2[0]!, p[1]! - q2[1]!) <= tol, `${what}: ${p} vs ${q2}`);
const ZONES = {
  hwZones: [{ s0: 0.2, s1: 0.3, hw: 6, ease: 0.025 }],
  bankZones: [{ frac: 0.4, angleDeg: 12, widthM: 120 }, { frac: 0.05, angleDeg: -6, widthM: 80 }],
  elevations: [{ s: 0.25, halfM: 100, rise: 3 }],
  bridges: [{ s: 0.6, halfM: 120, rise: 6 }],
};
/** A ~1.6 km ellipse: RED on length and on the start straights. */
function shortLoop(b: Boot) {
  const d0 = openGreen(b);
  const pts: P[] = [];
  for (let i = 0; i < 36; i++) { const t = i / 36 * Math.PI * 2; pts.push([Math.round(300 * Math.cos(t) * 4) / 4, Math.round(200 * Math.sin(t) * 4) / 4]); }
  b.D.load(Object.assign({}, d0, { pts }));
  const v = b.D.preview()!;
  assert.equal(v.ok, false);
  return d0;
}
const SHORT_LOOP = () => { const pts: P[] = []; for (let i = 0; i < 36; i++) { const t = i / 36 * Math.PI * 2; pts.push([Math.round(300 * Math.cos(t) * 4) / 4, Math.round(200 * Math.sin(t) * 4) / 4]); } return pts; };
/** Boot with the canvas hooks in hand (a span is a tap and a shift-tap; an insert is onChange). */
function bootHooked(stored?: Record<string, unknown>) {
  const holder: { hooks?: Record<string, Fn> } = {};
  over.canvasCreate = (c, h, real) => { holder.hooks = h as Record<string, Fn>; return real(c as never, h as never); };
  const b = bootScreen(stored);
  b.hooks = holder.hooks;
  return b as Boot & { hooks: Record<string, (...a: unknown[]) => unknown> };
}
const cumOf = (p: readonly P[]) => { const c = [0]; for (let i = 0; i < p.length; i++) { const a = p[i]!, q2 = p[(i + 1) % p.length]!; c.push(c[i]! + Math.hypot(q2[0] - a[0], q2[1] - a[1])); } return c; };
const rowOf = (root: Element, label: string) => walk(root).find((e) => e.classList.contains("td-row") && e.children[0] && e.children[0].textContent === label)!;
const stepBy = (row: Element, n: number) => { const b = row.children[n > 0 ? 3 : 1] as HTMLElement; for (let i = 0; i < Math.abs(n); i++) b.click(); };
const turnsList = (b: Boot) => walk(b.root).find((e) => e.getAttribute("aria-label") === "Corners, in driving order")!;
const followupText = (node: Element) => [node, ...walk(node)].map((e) => e.textContent || "").join(" ");
const by = (b: Boot, k: string, value: string) => walk(b.root).find((e) => e.dataset && e.dataset[k] === value)!;

// ── the task's minimum: mount, seeded open, stamp, undo, save, draft key, close, destroy ──
describe("mount()", () => {
  it("mounts into a div, opens a seeded random design, stamps, undoes, saves, autosaves the a26. draft and tears down", () => {
    const disk = new Map<string, string>();
    const storage = { get length() { return disk.size; }, key: (i: number) => [...disk.keys()][i] ?? null, getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => { disk.set(k, String(v)); }, removeItem: (k: string) => { disk.delete(k); }, clear: () => disk.clear() } as Storage;
    const b = bootScreen({}, { store: localStore(storage) });
    // the shell dialog's sheet-head (index.html:3509-3514), recreated inside the div
    assert.equal(b.root.id, "trackdesigner");
    assert.equal(b.root.getAttribute("aria-labelledby"), "td-title");
    assert.equal(q(b.root, "#td-title").textContent, "TRACK DESIGNER");
    assert.equal(q<HTMLButtonElement>(b.root, "#td-close").hidden, false, "the close control is adopted and shown");
    assert.ok(q(b.root, ".td-body") && q(b.root, ".td-foot"), "built at mount");
    assert.equal(b.root.hidden, true); assert.equal(b.D.isOpen(), false);
    // the module's named exports reach the mounted screen
    assert.equal(Designer.isOpen, Designer.isOpen); assert.equal(Designer.state().open, false);
    assert.equal(b.D.open(), true);
    assert.equal(b.root.hidden, false);
    assert.equal(b.D.randomise(7), true);
    const v = b.D.preview()!;
    assert.equal(v.ok, true, v.issues.map((i) => i.code + ":" + i.level).join(","));
    const p0 = plain(dz(b).pts), u0 = st(b).undo;
    b.D.setTool("corner");
    assert.equal(b.D.applyStamp(3, 3), true);
    assert.notDeepEqual(plain(dz(b).pts), p0);
    assert.equal(st(b).undo, u0 + 1);
    assert.equal(Designer.undo(), true, "the named export undoes on the mounted screen");
    assert.deepEqual(plain(dz(b).pts), p0);
    b.D.preview();
    const r = b.D.save();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match((r as { id: string }).id, /^custom-[0-9a-f]{8}$/);
    assert.deepEqual(b.C.list().map((i) => i.id), [(r as { id: string }).id]);
    assert.ok(disk.has("a26.customTracks"), "the library is stored under a26.");
    assert.ok(disk.has("a26.customTrackDraft"), "SAVE writes the draft under a26.customTrackDraft");
    assert.equal(JSON.parse(disk.get("a26.customTrackDraft")!).originId, (r as { id: string }).id);
    assert.ok(![...disk.keys()].some((k) => k.startsWith("apex26.")), "never f1-game's apex26. keys");
    b.D.setTheme("alpine");
    b.D.close();
    assert.equal(b.D.isOpen(), false); assert.equal(b.root.hidden, true);
    assert.equal(JSON.parse(disk.get("a26.customTrackDraft")!).theme, "alpine", "close flushes the autosave");
    b.D.destroy();
    assert.equal(b.root.querySelector(".td-body"), null, "destroy removes the screen");
    assert.equal(Designer.state().open, false, "the named exports fall back to a bare instance");
    const again = mount(b.root, { custom: b.C, game: b.G, store: b.store, trackList: () => b.list });
    assert.ok(q(b.root, ".td-body"), "the element mounts again");
    again.destroy();
  });

  it("imports in Node without touching the DOM (the module evaluated before any mount)", () => {
    assert.equal(typeof Designer.mount, "function");
    assert.deepEqual(Designer.MODES.map((m) => m[0]), ["draw", "edit", "elevation", "scenery", "test"]);
  });
});

describe("track-designer-dom (f1-game)", () => {
  it("workspace remembers each mode and tab, reveals stamp controls, and routes persistent checks", async () => {
    const b = bootScreen(); openGreen(b);
    const rail = q(b.root, ".td-rail");
    const fold = walk(b.root).find((e) => e.tagName === "DETAILS" && (e as { _label?: HTMLElement })._label && (e as unknown as { _label: HTMLElement })._label.textContent === "CORNERS") as HTMLDetailsElement;
    assert.equal(fold.open, false, "unused stamp parameters begin collapsed");
    b.D.setTool("corner"); assert.equal(fold.open, true, "choosing a stamp reveals its parameters");
    // happy-dom has no layout: scrollTop sticks only on a scrollable box, so the rail reports what is set.
    let top = 0; Object.defineProperty(rail, "scrollTop", { get: () => top, set: (v: number) => { top = v; }, configurable: true });
    rail.scrollTop = 180;
    b.D.setMode("elevation"); rail.scrollTop = 85;
    b.D.showPane("library"); rail.scrollTop = 20;
    b.D.showPane("design"); assert.equal(rail.scrollTop, 85);
    b.D.setMode("edit"); assert.equal(rail.scrollTop, 180);
    const before = plain(dz(b));
    const checks = walk(b.root).find((e) => e.dataset.role === "checks-summary")!;
    assert.match(checks.textContent!, /CHECKS/);
    checks.click(); await tick(5);
    assert.equal(st(b).mode, "test");
    assert.deepEqual(plain(dz(b)), before, "navigation never edits the circuit");
    const menu = walk(b.root).find((e) => e.dataset.role === "file-menu") as HTMLDetailsElement;
    menu.open = true;
    key(menu, "Escape");
    assert.equal(menu.open, false); assert.equal(b.D.isOpen(), true, "Escape closes just the file menu");
    menu.open = true;
    fire(menu, "cancel");
    assert.equal(menu.open, false, "gamepad Back closes just the file menu too");
    assert.equal(b.D.isOpen(), true);
  });

  it("workspace keeps validation failures reachable when save is blocked", () => {
    const b = bootScreen(); shortLoop(b);
    b.D.setMode("edit");
    const checks = walk(b.root).find((e) => e.dataset.role === "checks-summary") as HTMLButtonElement;
    assert.equal(checks.disabled, false, "blocked save must not disable the review action");
    assert.match(checks.textContent!, /TO FIX/);
    checks.click();
    assert.equal(st(b).mode, "test");
    assert.equal((q(b.root, '[aria-label="Design checks"]').parentNode as HTMLElement).hidden, false);
  });

  it("init() builds the rail before any design exists; open() randomises a green loop; close() hides", () => {
    const b = bootScreen();
    assert.equal(b.D.init(b.G, { custom: b.C, root: b.root }), true, "init builds into the shell dialog");
    // f1-game's mini-dom dialog was not hidden; mount() starts the div hidden like index.html's dialog.
    assert.equal(b.root.hidden, true, "the dialog stays as mount left it (hidden is the open flag, flipped by open())");
    assert.equal(q<HTMLButtonElement>(b.root, "#td-close").hidden, false, "the shell's close control is adopted and shown");
    assert.ok(q(b.root, ".td-body"), "body built");
    assert.ok(q(b.root, ".td-foot"), "foot built");
    assert.equal(b.D.isOpen(), false);
    b.D.open();
    assert.equal(b.D.isOpen(), true);
    let s = st(b);
    assert.ok(s.design && s.design.pts.length >= 8, "open() with no draft randomises a loop");
    assert.equal(b.D.randomise(7), true, "seed 7 finds a loop the validator accepts");
    const v = b.D.preview()!;
    assert.equal(v.ok, true, "the engine-built preview is green: " + v.issues.map((i) => i.code + ":" + i.level).join(","));
    s = st(b);
    assert.equal(s.pending, false);
    assert.ok(s.lengthM! >= 2500 && s.lengthM! <= 7000, "lap length in bounds: " + s.lengthM);
    assert.ok(s.design!.pts.every((p) => Number.isInteger(p[0] * 4) && Number.isInteger(p[1] * 4)), "lattice");
    const again = b.D.randomise(7); b.D.preview();
    assert.equal(again, true);
    assert.deepEqual(plain(dz(b).pts), plain(s.design!.pts), "deterministic per seed");
    b.D.close();
    assert.equal(b.D.isOpen(), false);
    assert.equal(b.root.hidden, true);
    assert.ok(b.C.draft(), "a draft is autosaved on close");
  });

  it("the rail's edits: stamp, undo/redo, reverse, start, delete floor, theme, width, name", () => {
    const b = bootScreen();
    b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.open(); b.D.randomise(7); b.D.preview();
    const p0 = plain(dz(b).pts), u0 = st(b).undo;
    b.D.setTool("corner");
    assert.equal(b.D.applyStamp(3, 3), true, "a CORNER stamps after point 4");
    const p1 = plain(dz(b).pts);
    assert.notDeepEqual(p1, p0, "the stamp changed the loop");
    assert.deepEqual(p1.slice(0, 4), p0.slice(0, 4), "…downstream of the anchor only");
    assert.equal(st(b).undo, u0 + 1);
    assert.equal(b.D.undo(), true);
    assert.deepEqual(plain(dz(b).pts), p0);
    assert.equal(st(b).redo, 1);
    assert.equal(b.D.redo(), true);
    assert.deepEqual(plain(dz(b).pts), p1);
    b.D.undo();
    const before = dz(b).pts;
    assert.equal(b.D.reverse(), true);
    const rev = plain(dz(b).pts);
    assert.deepEqual(rev[0], plain(before[0]), "REVERSE keeps the start point");
    assert.deepEqual(rev[1], plain(before[before.length - 1]), "…and walks the loop the other way");
    assert.equal(b.D.setStart(5), true);
    assert.deepEqual(plain(dz(b).pts[0]), rev[5], "START HERE rotates the chosen point to index 0");
    assert.equal(b.D.setStart(0), false, "the start itself is refused");
    assert.equal(b.D.setTheme("alpine"), true);
    assert.equal(dz(b).theme, "alpine");
    assert.equal(b.D.setTheme("nope"), false);
    assert.equal(b.D.setWidth(9), true);
    assert.equal(dz(b).baseHW, 8, "width clamps to the registry's cap");
    b.D.setName("my  test!! loop that is far too long for the cap");
    assert.equal(dz(b).name, b.C.sanitizeName("my  test!! loop that is far too long for the cap"));
    let n = dz(b).pts.length;
    while (n > b.C.LIMITS.ptsMin && b.D.deletePoint(n - 1)) n = dz(b).pts.length;
    assert.equal(n, b.C.LIMITS.ptsMin);
    assert.equal(b.D.deletePoint(0), false, "the point floor holds");
  });

  it("SAVE lands in CustomTracks + Tracks.LIST (same geometry updates, never duplicates); RACE presses the title door", () => {
    const b = bootScreen();
    b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.open(); b.D.randomise(23); b.D.preview();
    const base = b.list.length;
    const r = b.D.save() as { ok: boolean; id: string };
    assert.equal(r.ok, true, "save: " + JSON.stringify(r));
    assert.match(r.id, /^custom-[0-9a-f]{8}$/);
    assert.equal(b.list.length, base + 1);
    const t = b.list[b.list.length - 1]!;
    assert.equal(t.id, r.id); assert.equal(t.custom, true);
    assert.ok((t.turns || []).length >= 3, "baked turns");
    // apex-26's fromRaw does not copy `scenery` (src/track/core/def.ts, TODO(lane-scenery)): the closure rides the raw def.
    assert.equal(typeof b.C.toRaw(b.C.sanitize(dz(b))!).scenery, "function", "the theme's inline scenery closure rides the raw def");
    assert.deepEqual(plain(st(b).library), [r.id]);
    b.D.save();
    assert.equal(b.list.filter((x) => x.custom).length, 1, "re-saving the same geometry updates");
    assert.equal(b.D.race("tt"), true);
    assert.equal(b.D.isOpen(), false, "RACE closes the screen");
    assert.deepEqual(b.clicks, ["mb-tt"], "…and presses the TIME TRIAL door");
    assert.equal(b.list[b.G.trackIdx!]!.id, r.id, "the façade's trackIdx points at the saved circuit");
  });

  it("a freehand stroke closes into a valid loop", () => {
    const b = bootScreen();
    b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.open();
    const path: P[] = [];
    for (let i = 0; i < 160; i++) { const t = i / 160 * Math.PI * 2; path.push([Math.cos(t) * 700, Math.sin(t) * 420 + 60 * Math.sin(3 * t)]); }
    assert.equal(b.D.freehand(path), true);
    const v = b.D.preview()!;
    assert.ok(v.tr, "the engine built the drawn loop");
    assert.ok(v.tr.total > 3000, "≈ the drawn perimeter: " + v.tr.total);
    assert.equal(b.D.freehand([[0, 0], [1, 1]]), false, "two points are not a loop");
  });

  it("share out / in: a code, a link and an exported file all load back as the same design; a #track= link opens the screen", async () => {
    const written: string[] = [];
    const b = bootScreen({}, { deps: { clipboard: { write: async (t: string) => { written.push(t); return true; } } } });
    b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.open(); b.D.randomise(7); b.D.preview();
    const pts = plain(dz(b).pts), id = b.C.sanitize(dz(b))!.id;
    const code = (await b.D.shareCode())!;
    assert.match(code, /^APXT1\.[pz]\./, "an APXT1 share code");
    assert.equal(st(b).lastCode, code);
    const env = (await b.D.exportEnvelope())!;
    assert.equal(env.format, TrackCodec.FILE_FORMAT); assert.equal(env.code, code); assert.ok(env.design && env.design.pts.length === pts.length);
    const url = await b.D.share();
    assert.equal(url, TrackCodec.shareUrl(code));
    assert.deepEqual(plain(written), [url]);
    assert.equal(msgText(b), "Share link copied", "no character-count noise in the status");
    for (const text of [code, url!, JSON.stringify(env)]) {
      b.D.randomise(99); b.D.preview();
      assert.notDeepEqual(plain(dz(b).pts), pts);
      assert.equal(await b.D.loadFrom(text), true, "loads from " + text.slice(0, 12));
      assert.deepEqual(plain(dz(b).pts), pts);
      assert.equal(b.C.sanitize(dz(b))!.id, id, "the content id survives the round trip");
    }
    assert.equal(await b.D.loadFrom("APXT1.p.not-a-code"), false, "a bad code is refused, not thrown");
    assert.equal(await b.D.loadFrom("{\"format\":\"other\"}"), false, "a foreign file is refused");
    assert.equal(await b.D.loadFrom(""), false);
    // The boot path: CustomTracks.consumeTrackHash() reads location, loads the
    // bundle (already loaded here), opens the design and strips the fragment.
    b.D.close();
    b.D.randomise(5); b.D.preview();
    b.C.create(b.G, { load: async () => true });
    Object.assign(b.loc, { hash: "#track=" + code, pathname: "/", search: "?x=1" });
    assert.equal(await b.C.consumeTrackHash(), true);
    assert.equal(b.D.isOpen(), true, "the designer opened on the shared design");
    assert.deepEqual(plain(dz(b).pts), pts);
    assert.deepEqual(plain(b.replaced), ["/?x=1"], "the fragment is stripped, the query kept");
    Object.assign(b.loc, { hash: "", pathname: "/", search: "" });
    assert.equal(await b.C.consumeTrackHash(), false, "no link, no-op");
    Object.assign(b.loc, { hash: "#track=APXT1.p.garbage", pathname: "/", search: "" });
    assert.equal(await b.C.consumeTrackHash(), false, "a bad link is refused and still stripped");
    assert.equal(b.replaced.length, 2);
  });

  it("the terrain material knob: desert and alpine presets name it, shipped defs carry only the allowlisted ones", () => {
    assert.equal(TrackThemes.defFields("alpine").terrainMat, "SNOW");
    assert.equal(TrackThemes.defFields("oasis").terrainMat, "SAND");
    assert.equal(TrackThemes.defFields("desertnight").terrainMat, "SAND");
    assert.equal("terrainMat" in TrackThemes.defFields("parkland"), false);
    const SHIPPED_MAT: Record<string, string> = { vegas: "SAND", bahrain: "SAND", singapore: "CONCRETE" };
    for (const t of Tracks.LIST) if (!t.custom) assert.equal(t.terrainMat, SHIPPED_MAT[t.id], t.id + " terrainMat");
    const def = fromRaw({ id: "t", name: "T", gp: "T", country: "", lengthKm: 4, path: { len: 4000, pts: [[0, 0], [100, 0], [100, 100], [0, 100]] }, baseHW: 7, theme: "green", pal: {}, terrainMat: "SNOW" } as unknown as RawDef);
    assert.equal(def.terrainMat, "SNOW");
    const bad = fromRaw({ id: "t2", name: "T", gp: "T", country: "", lengthKm: 4, path: { len: 4000, pts: [[0, 0], [100, 0], [100, 100], [0, 100]] }, baseHW: 7, theme: "green", pal: {}, terrainMat: "LAVA" } as unknown as RawDef);
    assert.equal("terrainMat" in bad, false, "only SAND / SNOW / CONCRETE are honoured");
  });

  it("DesignerCanvas: fit() frames the loop; an arrow nudge comes back as a lattice-aligned edit", () => {
    const canvas = document.createElement("canvas");
    const changes: { pts?: P[]; kind?: string; begin?: boolean }[] = [];
    const cv = DesignerCanvas.create(canvas, { onChange: (pts, kind) => changes.push({ pts, kind }), onBegin: () => changes.push({ begin: true }) });
    const pts: P[] = [[0, 0], [100, 0], [100.125, 60.3], [0, 60]];
    cv.setPoints(pts);
    const v = cv.view();
    assert.equal(v.w, 640); assert.equal(v.h, 400);
    assert.ok(Math.abs(v.cx - 50) < 1 && Math.abs(v.cz - 30) < 1, "centred on the loop: " + JSON.stringify(v));
    assert.ok(v.scale > 3 && v.scale < 6, "scaled to fit 100 m into 640 px with margin: " + v.scale);
    cv.setSelection(2, -1);
    key(canvas, "ArrowLeft", { shiftKey: true });
    assert.equal(changes.length, 2);
    assert.deepEqual(plain(changes[0]), { begin: true });
    assert.equal(changes[1]!.kind, "nudge", "a keyboard nudge (the designer folds a run of them into one UNDO)");
    assert.deepEqual(plain(changes[1]!.pts![2]), [90.25, 60.25], "10 m left, snapped to the 0.25 m lattice");
    assert.deepEqual(pts[2], [100.125, 60.3], "the array it was handed is untouched");
    cv.setBuilt(null); cv.setIssues([]); cv.render(); cv.zoom(2);
    assert.ok(cv.view().scale > v.scale);
    cv.destroy();
  });

  it("REVERSE and START HERE carry every zone type to the same place on the loop; a bank keeps its angle (sign included)", () => {
    const b = bootScreen();
    const d0 = Object.assign(openGreen(b), plain(ZONES));
    b.D.load(d0);
    assert.equal(b.D.reverse(), true);
    const r = dz(b);
    near(r.bankZones[0]!.frac, 0.6, 1e-12, "bank frac → 1 − frac"); near(r.bankZones[1]!.frac, 0.95, 1e-12, "bank frac → 1 − frac");
    assert.deepEqual([r.bankZones[0]!.angleDeg, r.bankZones[1]!.angleDeg, r.bankZones[0]!.widthM], [12, -6, 120], "angleDeg is never negated");
    for (const z of r.bankZones) assert.deepEqual(Object.keys(z).sort(), ["angleDeg", "frac", "widthM"], "no stray s0/s1/angle on a bank");
    near(r.hwZones[0]!.s0, 0.7, 1e-12, "hw s0 = 1 − s1"); near(r.hwZones[0]!.s1, 0.8, 1e-12, "hw s1 = 1 − s0");
    near(r.elevations[0]!.s, 0.75, 1e-12, "elevation"); near(r.bridges[0]!.s, 0.4, 1e-12, "bridge");
    for (const [f, g] of [[0.4, r.bankZones[0]!.frac], [0.25, r.elevations[0]!.s], [0.6, r.bridges[0]!.s], [0.2, r.hwZones[0]!.s1]] as const) samePlace(pointAt(d0.pts, f), pointAt(r.pts, g), 1e-6, "the reversed loop's zone sits where it was");
    const before = plain(r);
    assert.equal(b.D.setStart(5), true);
    const s = dz(b);
    const L = (p: readonly P[]) => { let t = 0; for (let i = 0; i < p.length; i++) { const a = p[i]!, c = p[(i + 1) % p.length]!; t += Math.hypot(c[0] - a[0], c[1] - a[1]); } return t; };
    let upto = 0; for (let k = 0; k < 5; k++) { const a = before.pts[k]!, c = before.pts[k + 1]!; upto += Math.hypot(c[0] - a[0], c[1] - a[1]); }
    const sh = upto / L(before.pts), w = (v: number) => ((v % 1) + 1) % 1;
    near(s.bankZones[0]!.frac, w(before.bankZones[0]!.frac - sh), 1e-12, "bank frac shifts with the start");
    assert.equal(s.bankZones[1]!.angleDeg, -6);
    near(s.hwZones[0]!.s0, w(before.hwZones[0]!.s0 - sh), 1e-12, "hw s0"); near(s.elevations[0]!.s, w(before.elevations[0]!.s - sh), 1e-12, "elevation"); near(s.bridges[0]!.s, w(before.bridges[0]!.s - sh), 1e-12, "bridge");
    for (const [f, g] of [[before.bankZones[0]!.frac, s.bankZones[0]!.frac], [before.elevations[0]!.s, s.elevations[0]!.s], [before.hwZones[0]!.s0, s.hwZones[0]!.s0], [before.hwZones[0]!.s1, s.hwZones[0]!.s1]] as const) samePlace(pointAt(before.pts, f), pointAt(s.pts, g), 1e-6, "START HERE moves the line, not the zones");
    const it2 = b.C.sanitize(s)!, raw = b.C.toRaw(it2);
    samePlace(pointAtIndex(it2.pts, raw.hwZones![0]!.s0), pointAt(it2.pts, it2.hwZones![0]!.s0), 1e-6, "toRaw s0");
    samePlace(pointAtIndex(it2.pts, raw.hwZones![0]!.s1), pointAt(it2.pts, it2.hwZones![0]!.s1), 1e-6, "toRaw s1");
    samePlace(pointAt(before.pts, before.hwZones[0]!.s0), pointAtIndex(it2.pts, raw.hwZones![0]!.s0), 0.25, "end to end, within the u16 fraction grid");
  });

  it("an insert / delete / stamp keeps zones before the edit at their distance from the start, after it at their distance to the finish", () => {
    const b = bootScreen();
    const d0 = openGreen(b);
    const N = d0.pts.length;
    const c0 = cumOf(d0.pts), L0 = c0[N]!;
    const i = Math.floor(N / 2);
    const fBefore = c0[2]! / L0, fAfter = c0[N - 2]! / L0, fInside = (c0[i - 1]! + c0[i]!) / 2 / L0;
    b.D.load(Object.assign({}, d0, { elevations: [{ s: fBefore, halfM: 60, rise: 2 }, { s: fAfter, halfM: 60, rise: 2 }, { s: fInside, halfM: 60, rise: 2 }], bankZones: [{ frac: fAfter, angleDeg: 10, widthM: 100 }] }));
    assert.equal(b.D.deletePoint(i), true);
    const d1 = dz(b), c1 = cumOf(d1.pts), L1 = c1[d1.pts.length]!;
    assert.equal(d1.elevations.length, 2, "the zone on the edited span is dropped");
    near(d1.elevations[0]!.s * L1, fBefore * L0, 1e-6, "before the edit: same metres from the start");
    near(L1 - d1.elevations[1]!.s * L1, L0 - fAfter * L0, 1e-6, "after the edit: same metres to the finish");
    near(d1.bankZones[0]!.frac, d1.elevations[1]!.s, 1e-12, "banks ride the same map");
    samePlace(pointAt(d1.pts, d1.elevations[1]!.s), pointAt(d0.pts, fAfter), 1e-6, "…so it is still on the same piece of road");
    b.D.setTool("corner");
    assert.equal(b.D.applyStamp(3, 3), true);
    const d2 = plain(dz(b));
    assert.equal(d2.bankZones.length, 1);
    samePlace(pointAt(d2.pts, d2.bankZones[0]!.frac), pointAt(d0.pts, fAfter), 1.5, "a stamp upstream does not slide a zone off its corner");
    samePlace(pointAt(d2.pts, d2.elevations[0]!.s), pointAt(d0.pts, fBefore), 1e-6, "…nor one before the anchor");
    // An insert — a tap on the road at the middle of the loop's longest segment on the designer's own canvas.
    b.D.load(d2);
    let k = 20;
    for (let m = 20; m < d2.pts.length - 20; m++) if (Math.hypot(d2.pts[m + 1]![0] - d2.pts[m]![0], d2.pts[m + 1]![1] - d2.pts[m]![1]) > Math.hypot(d2.pts[k + 1]![0] - d2.pts[k]![0], d2.pts[k + 1]![1] - d2.pts[k]![1])) k = m;
    const xs = d2.pts.map((p) => p[0]), zs = d2.pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const sc = Math.min(640 / Math.max(60, x1 - x0), 400 / Math.max(60, z1 - z0)) * 0.82;
    const mid = [(d2.pts[k]![0] + d2.pts[k + 1]![0]) / 2, (d2.pts[k]![1] + d2.pts[k + 1]![1]) / 2] as const;
    const at = { clientX: (mid[0] - (x0 + x1) / 2) * sc + 320, clientY: (mid[1] - (z0 + z1) / 2) * sc + 200, pointerId: 9 };
    const canvas = q(b.root, "canvas");
    b.D.setTool("select");
    fire(canvas, "wheel", Object.assign({ deltaY: -2000 }, at));
    fire(canvas, "pointerdown", at);
    fire(canvas, "pointerup", at);
    const d3 = dz(b);
    assert.equal(d3.pts.length, d2.pts.length + 1, "the tap inserted a point");
    samePlace(pointAt(d3.pts, d3.bankZones[0]!.frac), pointAt(d2.pts, d2.bankZones[0]!.frac), 1e-6, "an insert upstream leaves a downstream zone in place");
    samePlace(pointAt(d3.pts, d3.elevations[0]!.s), pointAt(d2.pts, d2.elevations[0]!.s), 1e-6, "…and an upstream one");
  });
});

describe("track-designer-dom (f1-game): unsaved work, history, checks, keys", () => {
  it("open({design}), EDIT and IMPORT never drop unsaved work: UNDO brings it back and the previous draft is kept on disk", async () => {
    const b = bootScreen();
    const green = openGreen(b);
    b.D.setTheme("alpine");                                   // unsaved work (still green)
    const mine = plain(dz(b));
    const other = b.C.sanitize(Object.assign({}, green, { pts: green.pts.map(([x, z]) => [x + 40, z]) }))!;
    b.D.open({ design: other, shared: true });
    assert.deepEqual(plain(dz(b).pts), plain(other.pts), "the shared design is on screen");
    assert.match(msgText(b)!, /UNDO brings back/, "…and the player is told how to get theirs back");
    const prev = () => b.C.draftPrev() as Design;
    assert.deepEqual(plain(prev().pts), mine.pts, "the unsaved design is kept under a26.customTrackDraftPrev");
    assert.equal(prev().theme, "alpine");
    b.D.close();
    assert.deepEqual(plain((b.C.draft() as Design).pts), plain(other.pts), "the autosave writes the new draft…");
    assert.deepEqual(plain(prev().pts), mine.pts, "…and cannot clobber the kept one");
    assert.equal(b.D.undo(), true);
    assert.deepEqual(plain(dz(b).pts), mine.pts, "UNDO restores it");
    assert.equal(dz(b).theme, "alpine");
    b.D.preview(); assert.equal(b.D.save().ok, true);
    b.C.setDraftPrev(null);
    b.D.open({ design: other });
    assert.equal(b.C.draftPrev(), null); assert.equal(st(b).undo, 0);
    b.D.setWidth(6);
    const saved = b.C.list()[0]!;
    b.D.load(saved, "library", saved.id);
    b.D.undo();
    assert.equal(dz(b).baseHW, 6, "UNDO after EDIT is the edited design");
    b.D.setStart(4);
    const turned = plain(dz(b).pts);
    assert.equal(await b.D.loadFrom(await TrackCodec.encode(b.C.sanitize(Object.assign({}, other, { theme: "oasis" })))), true);
    assert.equal(dz(b).theme, "oasis");
    b.D.undo();
    assert.deepEqual(plain(dz(b).pts), turned, "UNDO after IMPORT is the edited design");
    const mineP = mine.pts;
    // A FRESH PAGE: the unsaved work exists only as the autosaved draft.
    const b2 = bootScreen({ customTrackDraft: Object.assign({}, mine, { theme: "harbour" }) });
    b2.D.init(b2.G, { custom: b2.C, root: b2.root });
    b2.D.open({ design: other, shared: true });
    b2.D.close();
    assert.deepEqual(plain((b2.C.draft() as Design).pts), plain(other.pts));
    assert.deepEqual(plain((b2.C.draftPrev() as Design).pts), mineP, "the on-disk draft survived the share link");
    assert.equal((b2.C.draftPrev() as Design).theme, "harbour");
    assert.equal(b2.D.undo(), true);
    assert.deepEqual(plain(dz(b2).pts), mineP);
    assert.equal(dz(b2).theme, "harbour");
  });

  it("SAVE durably updates the draft library link even after autosave has finished", async () => {
    // memoryStore keeps GameStore's durable JSON boundary (f1-game swapped store.set for it).
    const b = bootScreen();
    openGreen(b);
    const a = b.D.save() as { ok: boolean; id: string }; assert.equal(a.ok, true);
    b.D.setTheme("alpine");
    await tick(650);
    assert.equal((b.data().customTrackDraft as Design).originId, a.id, "autosaved before SAVE");
    const saved = b.D.save() as { ok: boolean; id: string }; assert.equal(saved.ok, true);
    assert.notEqual(saved.id, a.id);
    const disk = plain(b.data());
    b.D.close();
    const next = bootScreen(disk);
    next.D.init(next.G, { custom: next.C, root: next.root }); next.D.open();
    assert.equal(dz(next).originId, saved.id);
    next.D.setTheme("oasis");
    assert.equal(next.D.save().ok, true);
    assert.equal(next.C.list().length, 1, "save after reload replaces, never duplicates");
    next.D.close();
  });

  it("MY CIRCUITS recovers the previous unsaved draft after a fresh-page reload", () => {
    const b = bootScreen(); openGreen(b);
    b.D.setTheme("alpine");
    const mine = plain(dz(b));
    b.D.load(b.C.sanitize(design({ theme: "oasis" }))!, "replacement");
    b.D.close();
    const next = bootScreen(plain(b.data()));
    next.D.init(next.G, { custom: next.C, root: next.root }); next.D.open();
    assert.equal(dz(next).theme, "oasis");
    next.D.showPane("library");
    const recover = chipsIn(next.root, "RECOVER PREVIOUS DRAFT")[0]!;
    assert.equal(recover.hidden, false, "recovery is reachable even with an empty library");
    recover.click();
    assert.deepEqual(plain(dz(next).pts), mine.pts);
    assert.equal(dz(next).theme, "alpine");
    assert.equal((next.C.draft() as Design).theme, "alpine", "recovery immediately persists");
    assert.equal(next.D.undo(), true, "the current unsaved replacement is itself protected");
    assert.equal(dz(next).theme, "oasis");
    next.D.close();
  });

  it("recovering after reload keeps a name-only edit to a saved circuit in undo", () => {
    const b = bootScreen(); openGreen(b);
    b.D.setName("Previous A"); b.D.setTheme("alpine");
    b.D.load(b.C.sanitize(design({ theme: "oasis" }))!, "replacement"); b.D.preview();
    assert.equal(b.D.save().ok, true);
    b.D.setName("Unsaved B name"); b.D.close();
    const next = bootScreen(plain(b.data()));
    next.D.init(next.G, { custom: next.C, root: next.root }); next.D.open();
    next.D.showPane("library"); chipsIn(next.root, "RECOVER PREVIOUS DRAFT")[0]!.click();
    assert.equal(dz(next).name, "PREVIOUS A");
    assert.equal((next.C.draftPrev() as Design).name, "UNSAVED B NAME", "also protected across another reload");
    assert.equal(next.D.undo(), true);
    assert.equal(dz(next).name, "UNSAVED B NAME");
    next.D.close();
  });

  it("UNDO inside one design keeps its name and library link (setName and SAVE sit outside the history)", () => {
    const b = bootScreen();
    b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.open(); b.D.randomise(7); b.D.preview();
    b.D.setTheme("alpine");
    b.D.setName("Renamed Loop");
    assert.equal(b.D.undo(), true);
    assert.equal(dz(b).theme !== "alpine", true, "the edit was undone");
    assert.equal(dz(b).name, b.C.sanitizeName("Renamed Loop"), "…but not the rename");
    b.D.preview(); assert.equal(b.D.save().ok, true);
    const n = b.C.list().length, id = dz(b).originId;
    b.D.redo(); b.D.undo();
    assert.equal(dz(b).originId, id, "the library link survives UNDO");
    b.D.preview(); assert.equal(b.D.save().ok, true);
    assert.equal(b.C.list().length, n, "SAVE replaces the circuit instead of adding a copy");
  });

  it("a share link while the screen is open keeps the return focus; EDIT → SAVE replaces the circuit; a full library names its limit", () => {
    const b = bootScreen();
    const door = document.createElement("button"); door.id = "mb-designer"; document.body.appendChild(door);
    door.focus();
    openGreen(b);
    q(b.root, "canvas").focus();
    b.D.open({ design: b.C.sanitize(dz(b)), shared: true });   // hashchange while open
    b.D.close();
    assert.equal(document.activeElement, door, "close returns focus to the title door, not into the hidden dialog");
    door.remove();
    b.D.open(); b.D.preview();
    const first = b.D.save() as { ok: boolean; id: string };
    assert.equal(first.ok, true);
    const item = b.C.get(first.id)!;
    // SKIPPED: the f1-game pin on js/ui/select-screen.js's TrackDesigner.open call (not ported to apex-26).
    b.D.open({ design: item, originId: item.id });
    b.D.setStart(3); b.D.preview();
    const second = b.D.save() as { ok: boolean; id: string };
    assert.equal(second.ok, true); assert.notEqual(second.id, first.id);
    assert.deepEqual(plain(st(b).library), [second.id], "replaced, not duplicated");
    b.D.setWidth(6); b.D.preview();
    const third = b.D.save() as { ok: boolean; id: string };
    assert.deepEqual(plain(st(b).library), [third.id], "…on every later SAVE too");
    b.D.open({ design: b.C.get(third.id), originId: third.id, shared: true });
    assert.equal(dz(b).originId, undefined, "a shared import never replaces a local design");
    for (let i = 0; b.C.list().length < b.C.LIMITS.items; i++) assert.equal(b.C.upsert(Object.assign({}, b.C.get(third.id), { seed: 1000 + i })).ok, true);
    b.D.randomise(23); b.D.preview();
    assert.equal(b.D.race("gp"), false);
    assert.match(msgText(b)!, /full \(24 circuits\).*to race/, msgText(b)!);
    assert.deepEqual(b.clicks, [], "no race door pressed");
  });

  it("CHECKS is not a live region; count changes are announced once; an unbuildable loop never reads 'All checks pass'", () => {
    const b = bootScreen();
    const d0 = openGreen(b);
    const list = q(b.root, '[aria-label="Design checks"]');
    assert.equal(list.getAttribute("aria-live"), null, "the 80 ms rebuild is not read out");
    const tiny = Object.assign({}, d0, { pts: Array.from({ length: 36 }, (_, i) => [Math.round(120 * Math.cos(i / 36 * 2 * Math.PI) * 4) / 4, Math.round(80 * Math.sin(i / 36 * 2 * Math.PI) * 4) / 4]) });
    b.D.load(tiny);
    const v = b.D.preview()!;
    assert.equal(v.ok, false); assert.ok(v.red >= 1, "a ~630 m loop is RED, never a silent fail");
    assert.notEqual(kids(list)[0]!.dataset.level, "ok");
    assert.match(msgText(b)!, /CHECKS: \d+ red issue/, msgText(b)!);
    const said = msgText(b);
    b.D.preview();
    assert.equal(msgText(b), said, "the same counts are not announced again");
  });

  it("IMPORT caps the file size; a malformed link or code is a message, never a throw", async () => {
    const b = bootScreen();
    openGreen(b);
    assert.equal(await b.D.importFile({ size: 1 << 20, text: async () => { throw new Error("must not read"); } }), false);
    assert.match(msgText(b)!, /too big/);
    assert.equal(await b.D.loadFrom("https://x.example/#track=%E0%A4%A"), false);
    assert.ok(msgText(b)!.length > 0, "a message, not silence");
    assert.equal(await b.D.loadFrom("APXT1.z.%%%"), false);
    assert.ok(msgText(b)!.length > 0);
  });

  it("arrow nudges coalesce into one UNDO; arrows pass with nothing selected; Escape / B lets go of the canvas", () => {
    const win: { type: string; fn: (e: unknown) => void; cap: unknown }[] = [];
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation(((type: string, fn: EventListener, cap?: unknown) => { win.push({ type, fn: fn as (e: unknown) => void, cap }); add(type, fn, cap as boolean); }) as typeof window.addEventListener);
    const b = bootScreen();
    openGreen(b);
    const canvas = q<HTMLCanvasElement>(b.root, "canvas");
    canvas.focus();
    assert.equal(canvas.dataset.arrows, "pass", "nothing selected: MenuNav may walk focus off the canvas");
    assert.notEqual(key(canvas, "ArrowLeft").defaultPrevented, true, "…so the canvas leaves the key alone");
    key(canvas, "]");
    assert.equal(st(b).sel, 0);
    assert.equal(canvas.dataset.arrows, "own");
    const u0 = st(b).undo, p0 = plain(dz(b).pts[0]!);
    for (let i = 0; i < 4; i++) assert.equal(key(canvas, "ArrowRight").defaultPrevented, true);
    assert.deepEqual(plain(dz(b).pts[0]), [p0[0] + 4, p0[1]]);
    assert.equal(st(b).undo, u0 + 1, "four presses, one UNDO entry");
    key(canvas, "]"); key(canvas, "ArrowUp");
    assert.equal(st(b).undo, u0 + 2, "a new point starts a new entry");
    b.D.undo();
    assert.deepEqual(plain(dz(b).pts[0]), [p0[0] + 4, p0[1]]);
    b.D.undo();
    assert.deepEqual(plain(dz(b).pts[0]), p0, "one UNDO takes back the whole run");
    // SKIPPED: MenuNav.ownsArrows (js/ui/menu-nav.js, not ported); the canvas's data-arrows it reads is asserted instead.
    key(canvas, "]");
    assert.equal(canvas.dataset.arrows, "own", "a selected point: the pad's arrows nudge it");
    const back = win.filter((l) => l.cap && (l.type === "cancel" || l.type === "keydown"));
    assert.equal(back.length, 3, "file-menu Escape plus canvas Escape/cancel are captured before modal dismissal");
    const cancel = { type: "cancel", defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    back.find((l) => l.type === "cancel")!.fn(cancel);
    assert.equal(cancel.defaultPrevented, true); assert.equal(cancel.stopped, true, "the screen's close door never sees it");
    assert.equal(st(b).sel, -1);
    assert.notEqual(document.activeElement, canvas, "focus left the canvas");
    assert.equal(canvas.dataset.arrows, "pass");
    const again = { type: "cancel", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    back.find((l) => l.type === "cancel")!.fn(again);
    assert.equal(again.defaultPrevented, false, "a second B closes the screen as before");
  });
});

/** A DesignerCanvas over a 1.6 km loop, with a recording 2D context. */
function bootCanvas() {
  const b = bootScreen();
  const canvas = document.createElement("canvas");
  const fills: unknown[] = [];
  const ctx = new Proxy({} as Ctx2D, { get: (t, k) => (k === "fill" ? () => fills.push(t.fillStyle) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  Object.defineProperty(canvas, "getContext", { value: () => ctx });
  const ev = { changes: [] as { pts: P[]; kind: string }[], picks: [] as number[], deletes: [] as number[], limits: [] as string[] };
  let cv: ReturnType<typeof DesignerCanvas.create>;
  cv = DesignerCanvas.create(canvas, {
    onChange: (pts, kind) => { ev.changes.push({ pts, kind }); cv.setPoints(pts); },
    onPick: (i) => ev.picks.push(i), onDelete: (i) => ev.deletes.push(i), onSelect: () => {}, onLimit: (w) => ev.limits.push(w),
  });
  const pts: P[] = [];
  for (let i = 0; i < 24; i++) { const t = i / 24 * Math.PI * 2; pts.push([Math.round(300 * Math.cos(t) * 4) / 4, Math.round(200 * Math.sin(t) * 4) / 4]); }
  cv.setPoints(pts);
  const scr = (p: readonly number[]) => { const v = cv.view(); return { clientX: (p[0]! - v.cx) * v.scale + v.w / 2, clientY: (p[1]! - v.cz) * v.scale + v.h / 2 }; };
  const fireAt = (type: string, at: object, id = 1, extra?: object) => fire(canvas, type, Object.assign({ pointerId: id }, at, extra));
  const tap = (at: object, id = 1) => { fireAt("pointerdown", at, id); fireAt("pointerup", at, id); };
  return { b, canvas, cv, ev, pts, scr, fire: fireAt, tap, fills };
}

describe("track-designer-dom (f1-game): DesignerCanvas", () => {

  it("DesignerCanvas: lostpointercapture abandons a drag (no phantom pinch after a hidden dialog)", () => {
    const h = bootCanvas();
    h.fire("pointerdown", h.scr(h.pts[2]!), 1);
    h.fire("lostpointercapture", {}, 1);
    const a = h.scr(h.pts[5]!);
    h.fire("pointerdown", a, 2);
    h.fire("pointermove", { clientX: a.clientX + 30, clientY: a.clientY }, 2);
    h.fire("pointerup", { clientX: a.clientX + 30, clientY: a.clientY }, 2);
    assert.equal(h.ev.changes.length, 1, "the next touch is a drag, not the second finger of a pinch");
    assert.equal(h.ev.changes[0]!.kind, "move");
    h.fire("pointerdown", h.scr(h.pts[7]!), 3);
    h.cv.reset();
    h.tap(h.scr(h.pts[9]!), 4);
    assert.deepEqual(h.ev.picks, [9]);
  });

  it("DesignerCanvas: double-tap deletes only under SELECT and only the handle both taps picked", () => {
    const h = bootCanvas();
    const at = h.scr(h.pts[6]!);
    h.cv.setTool("corner");
    h.tap(at); h.tap(at); h.fire("dblclick", at);
    assert.deepEqual(h.ev.deletes, [], "a stamp tool's double-tap is two stamps, never a delete");
    h.cv.setTool("select");
    h.tap(at); h.tap(at); h.fire("dblclick", at);
    assert.deepEqual(h.ev.deletes, [6], "two picks of one handle under SELECT");
    const mid = h.scr([(h.pts[5]![0] + h.pts[6]![0]) / 2, (h.pts[5]![1] + h.pts[6]![1]) / 2]);
    h.tap(mid); h.tap(mid); h.fire("dblclick", mid);
    assert.equal(h.ev.changes.filter((c) => c.kind === "insert").length, 1);
    assert.deepEqual(h.ev.deletes, [6], "the inserted point is not deleted by the same double-tap");
  });

  it("DesignerCanvas: a tap on the road at the point cap inserts nothing and says so (bug-hunt H10)", () => {
    const h = bootCanvas();
    const max = h.b.C.LIMITS.ptsMax, ring: P[] = [], corners = [[-1000, -700], [1000, -700], [1000, 700], [-1000, 700]] as const;
    for (const c of corners) for (let i = 0; i < max / 4; i++) ring.push([c[0] + i * 0.25, c[1]]);
    h.cv.setPoints(ring); h.cv.fit();
    const edge = [(ring[49]![0] + ring[50]![0]) / 2, (ring[49]![1] + ring[50]![1]) / 2];
    h.tap(h.scr(edge));
    assert.equal(h.ev.changes.filter((c) => c.kind === "insert").length, 0, "the 201st point is refused");
    assert.deepEqual(h.ev.limits, ["points"], "the screen is told, so it can say why");
    h.cv.setPoints(ring.slice(0, max - 1)); h.cv.fit();
    h.tap(h.scr(edge));
    assert.equal(h.ev.changes.filter((c) => c.kind === "insert").length, 1, "one under the cap still inserts");
    assert.match(readFileSync(resolve(process.cwd(), "src/editor/designer.ts"), "utf8"), /onLimit: \(\) => message\(CustomTracks\.LIMITS\.ptsMax[^\n]*, true\)/, "the screen words the refusal as a warning");
  });

  it("DesignerCanvas: a drag stops at the storage bounds; a preview landing mid-drag keeps the road stale", () => {
    const h = bootCanvas();
    const tr = { n: h.pts.length, px: h.pts.map((p) => p[0]), pz: h.pts.map((p) => p[1]), hw: h.pts.map(() => 7), total: 1600 };
    h.cv.setBuilt(tr);
    const a = h.scr(h.pts[3]!);
    h.fire("pointerdown", a);
    h.fire("pointermove", { clientX: a.clientX + 40, clientY: a.clientY });
    h.fills.length = 0;
    h.cv.setBuilt(tr);
    assert.ok(h.fills.includes(DesignerCanvas.COL.roadStale) && !h.fills.includes(DesignerCanvas.COL.road), "still drawn stale: " + h.fills.join(","));
    h.fire("pointerup", { clientX: a.clientX + 40, clientY: a.clientY });
    h.cv.zoom(1e-6);
    const b0 = h.scr(h.ev.changes[0]!.pts[3]!);
    h.fire("pointerdown", b0);
    h.fire("pointermove", { clientX: 1e6, clientY: -1e6 });
    h.fire("pointerup", { clientX: 1e6, clientY: -1e6 });
    const p = h.ev.changes[h.ev.changes.length - 1]!.pts[3];
    assert.deepEqual(plain(p), [h.b.C.LIMITS.coord, -h.b.C.LIMITS.coord], "clamped to ±10 km, so the design stays saveable");
  });

  it("DesignerCanvas: select-without-move — tap keeps coords; jitter below threshold keeps coords; drag on selected moves", () => {
    const h = bootCanvas();
    assert.equal(DesignerCanvas.DRAG_MOUSE, 6);
    assert.equal(DesignerCanvas.DRAG_TOUCH, 10);
    assert.equal(DesignerCanvas.HIT_TOUCH, 44);
    const i = 4;
    const before = plain(h.pts[i]);
    const at = h.scr(h.pts[i]!);
    h.tap(at);
    assert.deepEqual(h.ev.picks, [i], "tap picks the node");
    assert.equal(h.ev.changes.length, 0, "tap does not move");
    assert.equal(h.cv.selection().sel, i, "canvas selection follows the tap");
    assert.deepEqual(plain(h.pts[i]), before, "coordinates unchanged after tap");
    h.fire("pointerdown", at, 2, { pointerType: "mouse" });
    h.fire("pointermove", { clientX: at.clientX + 4, clientY: at.clientY + 3 }, 2, { pointerType: "mouse" });
    h.fire("pointerup", { clientX: at.clientX + 4, clientY: at.clientY + 3 }, 2, { pointerType: "mouse" });
    assert.equal(h.ev.changes.length, 0, "below-threshold jitter does not move");
    h.fire("pointerdown", at, 3, { pointerType: "mouse" });
    h.fire("pointermove", { clientX: at.clientX + 40, clientY: at.clientY }, 3, { pointerType: "mouse" });
    h.fire("pointerup", { clientX: at.clientX + 40, clientY: at.clientY }, 3, { pointerType: "mouse" });
    assert.equal(h.ev.changes.length, 1, "deliberate drag moves");
    assert.equal(h.ev.changes[0]!.kind, "move");
    assert.notDeepEqual(plain(h.ev.changes[0]!.pts[i]), before, "coordinates changed");
  });

  it("DesignerCanvas: empty-space drag pans without moving nodes; touch tap does not move", () => {
    const h = bootCanvas();
    const i = 8;
    const before = plain(h.pts.map((p) => p.slice()));
    const v0 = h.cv.view();
    const empty = { clientX: 8, clientY: 8 };
    h.fire("pointerdown", empty, 1, { pointerType: "mouse" });
    h.fire("pointermove", { clientX: 48, clientY: 28 }, 1, { pointerType: "mouse" });
    h.fire("pointerup", { clientX: 48, clientY: 28 }, 1, { pointerType: "mouse" });
    assert.equal(h.ev.changes.length, 0, "pan never edits points");
    assert.deepEqual(plain(h.pts), before);
    const v1 = h.cv.view();
    assert.ok(Math.abs(v1.cx - v0.cx) > 0.01 || Math.abs(v1.cz - v0.cz) > 0.01, "view panned");
    const at = h.scr(h.pts[i]!);
    h.fire("pointerdown", at, 2, { pointerType: "touch" });
    h.fire("pointermove", { clientX: at.clientX + 8, clientY: at.clientY + 6 }, 2, { pointerType: "touch" });
    h.fire("pointerup", { clientX: at.clientX + 8, clientY: at.clientY + 6 }, 2, { pointerType: "touch" });
    assert.equal(h.ev.changes.length, 0, "touch jitter below threshold does not move");
    assert.deepEqual(h.ev.picks.at(-1), i);
  });
});

describe("track-designer-dom (f1-game): FIX, HOW TO, coach, rail, context row", () => {
  it("FIX chips: only on rows TrackFixes can repair; FIX commits one UNDO entry and says so; the press never reaches the row", () => {
    const seen: { code: unknown; built: boolean }[] = [];
    let green: Design | null = null;
    over.fixes = {
      canFix: (it) => (it as { code: string }).code === "length",
      apply: (d, it, built) => { seen.push({ code: (it as { code: string }).code, built: !!(built && (built as { issues?: unknown }).issues) }); return seen.length === 1 ? { design: Object.assign({}, d, { pts: green!.pts }), msg: "lap stretched to 3.2 km" } : null; },
      fixAll: () => null,
    };
    const b = bootScreen();
    green = shortLoop(b);
    const rows = kids(q(b.root, '[aria-label="Design checks"]'));
    const fixable = rows.filter((li) => chipsIn(li, "FIX").length);
    assert.equal(fixable.length, 1, "one FIX chip, on the length row");
    assert.match(fixable[0]!.textContent!, /Lap is/);
    assert.ok(rows.filter((li) => li.dataset.level === "red").length > 1, "the start rows are red too, and carry no chip");
    const fixAll = chipsIn(b.root, "FIX ALL")[0]!;
    assert.equal(fixAll.hidden, false, "FIX ALL shows while a red issue is fixable");
    const u0 = st(b).undo;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    let stopped = false; const stop = ev.stopPropagation.bind(ev); ev.stopPropagation = () => { stopped = true; stop(); };
    chipsIn(fixable[0]!, "FIX")[0]!.dispatchEvent(ev);
    assert.equal(stopped, true, "the chip's click stops at the chip (the row would refocus the canvas)");
    assert.deepEqual(plain(seen), [{ code: "length", built: true }], "apply(design, issue, the current verdict)");
    assert.equal(st(b).undo, u0, "preview does not commit");
    chipsIn(b.root, "APPLY REPAIR")[0]!.click();
    assert.equal(st(b).undo, u0 + 1, "one UNDO entry");
    assert.deepEqual(plain(dz(b).pts), plain(green.pts));
    assert.equal(msgText(b), "Fixed: lap stretched to 3.2 km — UNDO to revert");
    assert.equal(b.D.preview()!.ok, true);
    assert.equal(chipsIn(b.root, "FIX ALL")[0]!.hidden, true, "nothing red, no FIX ALL");
    assert.equal(b.D.undo(), true);
    assert.equal(b.D.preview()!.ok, false, "UNDO takes the fix back");
    chipsIn(q(b.root, '[aria-label="Design checks"]'), "FIX")[0]!.click();
    assert.equal(msgText(b), "No automatic fix for this one");
    // No TrackFixes (the module did not load): no chips at all, never a throw.
    over.fixes = "absent";
    b.D.preview();
    assert.equal(chipsIn(q(b.root, '[aria-label="Design checks"]'), "FIX").length, 0);
    assert.equal(chipsIn(b.root, "FIX ALL")[0]!.hidden, true);
  });

  it("FIX ALL runs fixAll(design, TrackValidate.check) and commits once, naming the codes it applied", () => {
    let green: Design | null = null;
    const calls: boolean[] = [];
    over.fixes = {
      canFix: (it) => ["length", "start"].includes((it as { code: string }).code),
      apply: () => null,
      fixAll: (d, check) => { calls.push(check === TrackValidate.check); return { design: Object.assign({}, d, { pts: green!.pts }), applied: ["length", "start"] }; },
    };
    let fits = 0;
    over.canvasCreate = (c, h, real) => { const api = real(c as never, h as never) as { fit: () => void }; const fit = api.fit; api.fit = () => { fits++; return fit(); }; return api; };
    const b = bootScreen();
    green = shortLoop(b);
    assert.ok(chipsIn(q(b.root, '[aria-label="Design checks"]'), "FIX").length >= 2, "every fixable row has its chip");
    const u0 = st(b).undo, f0 = fits;
    chipsIn(b.root, "FIX ALL")[0]!.click();
    assert.deepEqual(calls, [true], "handed the validator's own check");
    assert.equal(st(b).undo, u0, "preview does not commit");
    chipsIn(b.root, "APPLY REPAIR")[0]!.click();
    assert.equal(st(b).undo, u0 + 1, "one UNDO entry for the whole batch");
    assert.equal(st(b).sel, 0, "a start remedy selects the new point 0, as START HERE does");
    assert.equal(fits, f0 + 1, "a length remedy rescales the loop, so the view refits");
    assert.equal(msgText(b), "Fixed length, start — UNDO to revert");
    assert.equal(b.D.preview()!.ok, true);
    b.D.undo(); b.D.preview();
    (over.fixes as { fixAll: unknown }).fixAll = (d: unknown) => ({ design: d, applied: [], msgs: [] });   // nothing applies → the SAME object
    chipsIn(b.root, "FIX ALL")[0]!.click();
    assert.equal(st(b).undo, u0, "nothing applied, nothing committed");
    assert.match(msgText(b)!, /Nothing here can be fixed automatically/);
  });

  it("HOW TO: a third tab lists every HOWTO step, every input and the limits; the limits match the registry", () => {
    const b = bootScreen();
    openGreen(b);
    const tabs = walk(b.root).filter((e) => e.classList.contains("td-tab"));
    assert.deepEqual(tabs.map((t) => t.textContent), ["DESIGN", "MY CIRCUITS", "HOW TO"]);
    for (const t of tabs) assert.equal(t.getAttribute("role"), "tab");
    assert.equal(q(b.root, '[role="tablist"]').getAttribute("aria-label"), "Track Designer workspace");
    assert.deepEqual(tabs.map((t) => t.getAttribute("aria-controls")), ["td-pane-design", "td-pane-library", "td-pane-howto"]);
    assert.deepEqual(tabs.map((t) => t.tabIndex), [0, -1, -1]);
    const [dsg, lib, how] = panes(b) as [HTMLElement, HTMLElement, HTMLElement];
    assert.equal(how.dataset.pane, "howto"); assert.equal(how.getAttribute("role"), "tabpanel");
    assert.deepEqual([dsg.getAttribute("aria-labelledby"), lib.getAttribute("aria-labelledby"), how.getAttribute("aria-labelledby")], [tabs[0]!.id, tabs[1]!.id, tabs[2]!.id]);
    assert.equal(how.hidden, true);
    tabs[2]!.click();
    assert.deepEqual([dsg.hidden, lib.hidden, how.hidden], [true, true, false]);
    assert.deepEqual(tabs.map((t) => t.getAttribute("aria-selected")), ["false", "false", "true"]);
    assert.deepEqual(tabs.map((t) => t.tabIndex), [-1, -1, 0]);
    assert.equal(b.root.dataset.pane, "howto", "phone layout can give the guide its own space");
    tabs[2]!.focus();
    key(tabs[2]!, "ArrowLeft");
    assert.equal(b.root.dataset.pane, "library", "ArrowLeft activates the previous designer tab");
    assert.equal(document.activeElement, tabs[1], "tab focus follows activation");
    key(tabs[1]!, "Home");
    assert.equal(b.root.dataset.pane, "design", "Home activates the first designer tab");
    assert.equal(document.activeElement, tabs[0]);
    const H = b.D.HOWTO;
    const tasks = walk(how).filter((e) => e.dataset.helpTask) as HTMLDetailsElement[];
    assert.deepEqual(tasks.map((e) => e.dataset.helpTask), ["selection", "height", "scenery", "draw", "test"]);
    assert.equal(tasks[0]!.open, true);
    const history = st(b).undo;
    chipsIn(how, "OPEN SCENERY")[0]!.click();
    assert.equal(st(b).mode, "scenery");
    assert.equal(how.hidden, true);
    assert.equal(b.root.dataset.pane, "design");
    const liveBtn = walk(b.root).find((e) => e.dataset.mapView === "scenery" && e.tagName === "BUTTON")!;
    assert.equal(liveBtn.getAttribute("aria-pressed"), "true");
    chipsIn(b.root, "OUTLINE")[0]!.click();
    assert.equal(liveBtn.getAttribute("aria-pressed"), "false");
    assert.equal(st(b).undo, history, "view and help navigation do not edit the circuit");
    tabs[2]!.click();
    const rows = walk(how).filter((e) => e.classList.contains("td-issue"));
    for (const r of rows) assert.equal(r.dataset.level, "info", "info rows, the CHECKS recipe");
    const text = rows.map((r) => r.textContent).join("\n");
    assert.equal(H.STEPS.length, 7);
    H.STEPS.forEach((s, i) => {
      assert.equal(s.n, i + 1);
      assert.ok(text.includes(s.n + " · " + s.title.toUpperCase() + " — " + s.text), "step " + s.n + " is listed");
      assert.ok(s.text.split(/(?<=[.?!])\s+(?=[A-Z])/).length <= 2, "≤ 2 sentences: " + s.title);
    });
    assert.deepEqual(plain(H.GESTURES.map((g) => g.input)), ["Touch", "Mouse", "Keyboard", "Gamepad"]);
    for (const g of H.GESTURES) assert.ok(text.includes(g.input.toUpperCase() + " — " + g.text));
    assert.ok(text.includes(H.LIMITS));
    const L = b.C.LIMITS, VL = TrackValidate.LIMITS;
    assert.ok(H.LIMITS.includes(VL.lenMin / 1000 + "–" + VL.lenMax / 1000 + " km"), "lap length limits");
    assert.ok(H.LIMITS.includes(L.ptsMin + "–" + L.ptsMax + " points"), "point limits");
    assert.ok(H.LIMITS.includes(L.items + " saved circuits"), "library limit");
    tabs[0]!.click();
    assert.deepEqual([dsg.hidden, lib.hidden, how.hidden], [false, true, true]);
    tabs[1]!.click();
    const empty = q(lib, ".td-empty");
    assert.ok(empty, "empty library copy");
    assert.match(empty.textContent!, /No saved circuits yet/);
    assert.ok((empty.parentNode as HTMLElement).classList.contains("td-grid"), "lives in the card grid");
  });

  it("the first-open card: shown once, HOW TO switches tab, GOT IT stores designerCoached; a later open has none", () => {
    const b = bootScreen();
    b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.open();
    const dsg = panes(b)[0]!;
    const card = q(dsg, '[data-role="coach"]');
    assert.ok(card && card.classList.contains("td-group"), "coach card docks in the design pane (not over MODE/SHAPE)");
    const shape = walk(dsg).find((g) => kids(g).some((c) => c.classList.contains("td-chips") && c.children[0] && (c.children[0] as HTMLElement).dataset.tool))!;
    assert.ok(shape, "1 SHAPE tools exist");
    const dk = kids(dsg);
    assert.ok(dk.indexOf(card) > dk.indexOf((shape.parentNode as HTMLElement) || shape) || dk.indexOf(card) > 0, "coach is below the tool groups");
    const note = card.children[0] as HTMLElement;
    assert.ok(note.classList.contains("td-issue")); assert.equal(note.dataset.level, "info");
    assert.match(note.textContent!, /RANDOMISE gave you a circuit/);
    assert.match(note.textContent!, /EDIT shapes the road/);
    assert.deepEqual(chipsIn(card).map((c) => c.textContent), ["HOW TO", "GOT IT"]);
    const u0 = st(b).undo;
    chipsIn(card, "HOW TO")[0]!.click();
    assert.equal(panes(b)[2]!.hidden, false, "HOW TO opens the guide");
    assert.equal(b.data().designerCoached, undefined, "…without dismissing the card");
    chipsIn(card, "GOT IT")[0]!.click();
    assert.equal(b.data().designerCoached, true, "GOT IT stores the flag");
    assert.ok(!dsg.contains(card), "…and removes the card");
    assert.equal(st(b).undo, u0, "UNDO / REDO untouched");
    b.D.close(); b.D.open();
    assert.equal(chipsIn(panes(b)[0]!, "GOT IT").length, 0, "no card on a later open");
    const b2 = bootScreen();
    b2.D.init(b2.G, { custom: b2.C, root: b2.root });
    b2.D.open();
    const card2 = q(panes(b2)[0]!, '[data-role="coach"]');
    assert.ok(card2 && card2.children[0] && /RANDOMISE gave you/.test(card2.children[0].textContent!));
    b2.D.close();
    assert.equal(b2.data().designerCoached, true);
    const b3 = bootScreen({ designerCoached: true });
    b3.D.init(b3.G, { custom: b3.C, root: b3.root });
    b3.D.open();
    assert.equal(chipsIn(panes(b3)[0]!, "GOT IT").length, 0);
  });

  it("the rail: per-tool hint under 1 SHAPE (the stage copy is hidden on a phone), the status line says it once, and the group labels", () => {
    const b = bootScreen();
    openGreen(b);
    const stage = q(b.root, ".td-stage");
    const toolsGroup = kids(panes(b)[0]).find((g) => kids(g).some((c) => kids(c).some((t) => t.dataset && t.dataset.tool)))!;
    const hint = q(toolsGroup, ".td-hint"), stageHint = q(stage, ".td-hint");
    assert.ok(hint && stageHint && hint !== stageHint);
    assert.ok(toolsGroup && kids(toolsGroup).some((c) => c.classList.contains("td-chips") && kids(c).every((t) => t.dataset.tool)), "the hint sits in the TOOLS group");
    assert.match(hint.textContent!, /^EDIT: POINT selects one/);
    const css = CSS;
    assert.equal((css.match(/\.td-stage \.td-hint \{ display: none; \}/g) || []).length, 2, "narrow/portrait and short both hide the stage hint");
    assert.doesNotMatch(css, /^\s*\.td-hint \{ display: none/m, "no rule hides every .td-hint");
    assert.match(css, /@media \(max-width: 760px\) and \(max-height: 500px\) and \(orientation: landscape\) \{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(240px,\s*38%\)/, "narrow+short landscape keeps a usable side-by-side inspector");
    assert.match(css, /@media \(max-width: 760px\) and \(max-height: 500px\) and \(orientation: landscape\) \{[\s\S]*?\.td-foot \{ display: flex/, "narrow+short landscape restores a single-row foot");
    assert.match(css, /@media \(max-width: 760px\) and \(max-height: 500px\) and \(orientation: landscape\) \{[\s\S]*?min-height:\s*72px/, "narrow+short landscape floors the main canvas above WCAG 24");
    const shortOnly = css.match(/@media \(max-height: 500px\) \{([\s\S]*?)\n\}/);
    assert.ok(shortOnly, "short-height media query present");
    assert.doesNotMatch(shortOnly[1]!, /\.td-body\s*\{/, "max-height:500 alone must not restack .td-body (safari 2-col stays)");
    for (const [tool, re] of [["draw", /^DRAW: draw one closed loop/], ["corner", /^CORNER: tap a point to stamp/], ["hairpin", /^HAIRPIN: tap a point/], ["straight", /^STRAIGHT: tap a point/], ["select", /^EDIT: /]] as const) {
      b.D.setTool(tool);
      assert.match(hint.textContent!, re, tool);
      assert.equal(stageHint.textContent, hint.textContent, "one string, two places");
      assert.equal(msgText(b), hint.textContent, "the status line says it once on a change");
    }
    b.D.setTool("select");
    const labels = () => kids(panes(b)[0]).map((g) => (g.children[0] && g.children[0].classList.contains("td-label") ? g.children[0] : walk(g).find((e) => e.classList.contains("td-label")))).filter(Boolean).map((l) => l!.textContent);
    assert.deepEqual(labels().slice(0, 7), ["SELECT POINTS", "SHAPE", "CORNERS", "ELEVATION", "BANKING & KERBS", "SCENERY", "ROAD"]);
    assert.ok(labels().includes("CHECKS"));
    const shapeG = kids(panes(b)[0]).find((g) => g.children[0] && g.children[0].textContent === "CORNERS")!;
    assert.ok(shapeG && !shapeG.hidden, "CORNERS group stays visible under EDIT/SELECT");
    assert.match(q(shapeG, ".td-hint").textContent!, /^Pick STRAIGHT/);
    assert.deepEqual(chipsIn(b.root).filter((c) => c.dataset.mode).map((c) => c.dataset.mode), ["draw", "edit", "elevation", "scenery", "test"]);
    b.D.setMode("elevation");
    assert.equal(st(b).mode, "elevation");
    assert.match(hint.textContent!, /^ELEVATION:/);
    b.D.setMode("edit");
    b.D.setTool("corner");
    const all = labels();
    const cornerLabel = all.find((t) => t!.startsWith("CORNERS ·"));
    const m = cornerLabel && cornerLabel.match(/^CORNERS · CORNER R (\d+) m × 90° LEFT$/);
    assert.ok(m, cornerLabel || all.join("|"));
    chipsIn(b.root, "TURNS RIGHT")[0]!.click();
    walk(b.root).find((e) => e.getAttribute("aria-label") === "RADIUS m up")!.click();
    assert.equal(labels().find((t) => t!.startsWith("CORNERS ·")), "CORNERS · CORNER R " + (+m[1]! + 5) + " m × 90° RIGHT", "live from the steppers");
    b.D.setTool("straight");
    assert.equal(labels().find((t) => t!.startsWith("CORNERS ·")), "CORNERS · STRAIGHT 200 m");
    assert.match(css, /\.td-row \.sel-chip \{[^}]*min-height:\s*var\(--tap-paint\)/, "stepper ± keys floor at --tap-paint on touch");
    assert.match(css, /\.td-row \.sel-chip \{[^}]*min-width:\s*var\(--tap-paint\)/, "stepper ± keys width floor at --tap-paint on touch");
    assert.match(css, /\.td-issue \{[^}]*min-height:\s*var\(--tap-paint\)/, "CHECKS issue rows floor at --tap-paint");
    assert.match(css, /@media \(max-width: 760px\), \(orientation: portrait\) \{[\s\S]*?\.td-stats \{ display: none; \}/, "portrait stack hides duplicate stage stats");
    assert.match(css, /\.td-rail \{[^}]*overflow-x:\s*hidden/, "rail clips horizontal overflow");
    assert.match(css, /\.td-rail \{[^}]*scrollbar-gutter:\s*stable/, "rail reserves scrollbar gutter");
    assert.match(css, /\.td-tab \{[^}]*flex:\s*1 1 0/, "equal-width tabs (no jump)");
    assert.match(css, /\.td-card > strong \{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/, "saved circuit names wrap inside narrow cards");
    assert.match(css, /\.td-issue \{[^}]*overflow-wrap:\s*anywhere/, "validation messages wrap beside FIX on narrow rails");
    assert.match(css, /\.td-empty \{[^}]*grid-column:\s*1\s*\/\s*-1/, "empty MY CIRCUITS spans the full grid");
    assert.match(css, /max-height: 500px[\s\S]*?data-role="profile"[\s\S]*?display:\s*block/, "profile strip kept on short phones");
    assert.match(css, /\.td-stage canvas \{[^}]*min-height:\s*72px/, "main map canvas keeps a 72px floor in every layout");
    assert.match(css, /@media \(max-width: 760px\), \(orientation: portrait\) \{[\s\S]*?grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*1\.2fr\)/, "portrait stack reserves space for the inspector below the map");
    assert.match(css, /@media \(max-height: 500px\) \{[\s\S]*?\.td-stats \{ display: none; \}/, "short viewports hide duplicate stage stats");
    assert.match(css, /@media \(max-width: 760px\), \(orientation: portrait\) \{[\s\S]*?grid-template-rows:\s*minmax\(72px,\s*1fr\)\s*auto/, "portrait stage grid: definite map row + profile");
    assert.match(css, /@media \(max-width: 760px\) and \(orientation: portrait\) \{[\s\S]*?#trackdesigner:not\(\[data-mode="scenery"\]\) \.td-stage > \.td-chips\[data-role="toolbar"\][\s\S]*?position:\s*static[\s\S]*?grid-row:\s*1/, "portrait toolbar gets its own row instead of covering the map");
    assert.match(css, /#trackdesigner:not\(\[data-mode="scenery"\]\) \.td-stage > canvas\[data-role="profile"\][\s\S]*?grid-row:\s*3/, "portrait profile stays below the dedicated toolbar and map rows");
  });

  it("the canvas's press-and-hold row: DELETE · START HERE · CLOSE act on that point, anchored at the press; a canvas press hides it; a stamp tool hands the canvas a ghost", () => {
    let hooks: Record<string, (...a: unknown[]) => unknown> | null = null;
    const toolCalls: [string, unknown][] = [];
    over.canvasCreate = (c, h, real) => {
      hooks = h as typeof hooks;
      const api = real(c as never, h as never) as { setTool: (n: string, fn?: unknown) => unknown }, set = api.setTool;
      api.setTool = (name, fn) => { toolCalls.push([name, fn]); return set(name); };
      return api;
    };
    const b = bootScreen();
    const d0 = openGreen(b);
    const H = hooks!;
    assert.equal(typeof H.onContext, "function", "the designer offers the hook");
    const row = q(b.root, ".td-ctx"), stage = q(b.root, ".td-stage");
    assert.ok(kids(stage).includes(row), "anchored in the stage"); assert.equal(row.hidden, true);
    assert.ok(row.classList.contains("td-chips"));
    H.onContext!(5, { x: 600, y: 50 });
    assert.equal(row.hidden, false);
    assert.equal(st(b).sel, 5, "the point is selected");
    assert.deepEqual([row.style.right, row.style.top, row.style.left, row.style.bottom], ["40px", "50px", "", ""], "opens away from the right edge (canvas 640 × 400)");
    assert.equal(row.getAttribute("aria-label"), "Point 6");
    chipsIn(row, "DELETE")[0]!.click();
    assert.equal(row.hidden, true);
    assert.equal(dz(b).pts.length, d0.pts.length - 1);
    assert.deepEqual(plain(dz(b).pts[5]), plain(d0.pts[6]), "point 6 (index 5) went");
    const before = plain(dz(b).pts);
    H.onContext!(4, { x: 10, y: 390 });
    assert.deepEqual([row.style.left, row.style.bottom], ["10px", "10px"], "opens away from the bottom edge");
    chipsIn(row, "START HERE")[0]!.click();
    assert.deepEqual(plain(dz(b).pts[0]), before[4], "START HERE on that point");
    H.onContext!(0, { x: 100, y: 100 });
    assert.equal(chipsIn(row, "START HERE")[0]!.disabled, true, "the start itself cannot be the new start");
    chipsIn(row, "CLOSE")[0]!.click();
    assert.equal(row.hidden, true);
    H.onContext!(3, { x: 100, y: 100 });
    const canvas = q(b.root, "canvas");
    fire(canvas, "pointerdown", { pointerId: 7, clientX: 5, clientY: 5 });
    fire(canvas, "pointercancel", { pointerId: 7 });
    assert.equal(row.hidden, true, "the next press on the canvas hides it");
    for (const mode of ["scenery", "elevation", "test", "draw"]) {
      b.D.setMode("edit"); H.onContext!(3, { x: 100, y: 100 });
      const points = plain(dz(b).pts);
      b.D.setMode(mode);
      assert.equal(row.hidden, true, "switch to " + mode + " dismisses point actions");
      chipsIn(row, "DELETE")[0]!.click();
      assert.deepEqual(plain(dz(b).pts), points, "stale action cannot delete a point");
    }
    b.D.setMode("edit");
    H.onContext!(3, { x: 100, y: 100 });
    b.D.close();
    assert.equal(row.hidden, true, "closing the screen hides it");
    H.onContext!(999, { x: 1, y: 1 });
    assert.equal(row.hidden, true, "an index off the loop is ignored");
    b.D.open();
    b.D.setTool("corner");
    const [name, fn] = toolCalls[toolCalls.length - 1]!;
    assert.equal(name, "corner"); assert.equal(typeof fn, "function");
    const pts = dz(b).pts, g = (fn as (i: number) => { pts: P[] } | null)(3)!;
    assert.deepEqual(plain(g.pts[0]), plain(pts[3]), "the ghost starts on the point");
    assert.ok(g.pts.length > 3, "…and runs the corner");
    assert.equal((fn as (i: number) => unknown)(-1), null);
    b.D.setTool("select");
    assert.equal(toolCalls[toolCalls.length - 1]![1], undefined, "SELECT clears the ghost");
  });
});

describe("track-designer-dom (f1-game): insight", () => {
  it("TURNS: one info row per corner; a row selects its span, prefills the tool and REPLACE re-stamps it green", () => {
    const b = bootScreen();
    openGreen(b);
    const s = st(b), list = turnsList(b);
    assert.equal(list.getAttribute("aria-label"), "Corners, in driving order");
    // f1-game: >= 3. Its VM loaded js/ui/track-maps.js (TrackMaps.detectCorners); apex-26 has not ported it
    // (validate.ts setTrackMaps is unset), so seed 7 bakes 2 turns. Rows 0 and 1 are all the test reads.
    assert.ok(s.corners.length >= 2, s.corners.length + " corners");
    assert.equal(list.children.length, s.corners.length, "one row per corner");
    for (const li of kids(list)) {
      assert.equal(li.dataset.level, "info"); assert.equal(li.tabIndex, 0);
      assert.match(li.textContent!, /^T\d+ · (LEFT|RIGHT) \d+° · R \d+ m · \d+ km\/h · \d+ m$/);
    }
    const c = s.corners[1]!, u0 = s.undo, dir = c.fit!.dir < 0 ? "RIGHT" : "LEFT";
    kids(list)[1]!.click();
    const now = st(b);
    assert.deepEqual([now.sel, now.span, now.tool], [c.i0, c.i1, c.fit!.kind], "the row's span, the fitted tool");
    assert.ok(now.sel !== now.span && !(now.span > 0 && now.span < now.sel), "point 0 is never inside the span");
    const label = walk(panes(b)[0]!).find((e) => e.classList.contains("td-label") && /^CORNERS/.test(e.textContent!))!;
    assert.equal(label.textContent, c.fit!.kind === "corner" ? "CORNERS · CORNER R " + c.fit!.R + " m × " + c.fit!.deg + "° " + dir : "CORNERS · HAIRPIN R " + c.fit!.R + " m " + dir);
    assert.equal(now.design!.pts.length, s.design!.pts.length, "selecting changes nothing");
    assert.equal(now.undo, u0);
    const replace = chipsIn(b.root, "REPLACE THE SELECTED SPAN")[0]!;
    assert.ok(replace, "CORNERS offers REPLACE THE SELECTED SPAN");
    replace.click();
    const v = b.D.preview()!;
    assert.equal(v.red, 0, "the re-stamped turn is green: " + v.issues.map((i) => i.code + ":" + i.level).join(","));
    assert.equal(st(b).undo, u0 + 1, "one UNDO entry");
    const first = kids(turnsList(b))[0]!, c0 = st(b).corners[0]!;
    key(first, "Enter");
    assert.deepEqual([st(b).sel, st(b).span], [c0.i0, c0.i1]);
  });

  it("4 DETAILS: RANDOMISE · TRACK OF THE DAY · START FROM… over the edit row, which ends in SPEED then TEST HERE (#766)", () => {
    const b = bootScreen();
    openGreen(b);
    const dsg = panes(b)[0]!;
    assert.equal(chipsIn(dsg, "RANDOMISE").length, 1, "RANDOMISE moved, not copied");
    const seedRow = chipsIn(dsg, "RANDOMISE")[0]!.parentNode as HTMLElement;
    assert.deepEqual(kids(seedRow).map((c) => c.textContent), ["RANDOMISE", "TRACK OF THE DAY", "START FROM…"]);
    const speed = chipsIn(dsg, "SPEED")[0]!, editRow = speed.parentNode as HTMLElement;
    assert.deepEqual(kids(editRow).map((c) => c.textContent), ["REVERSE", "START HERE", "DELETE POINT", "PREV POINT", "NEXT POINT", "SELECT END", "SPEED", "TEST HERE"]);
    const toolbar = q(b.root, '.td-chips[data-role="toolbar"]');
    assert.ok(toolbar, "stage toolbar");
    assert.deepEqual(kids(toolbar).map((c) => c.textContent), ["UNDO", "REDO", "FIT VIEW", "OUTLINE", "LIVE SCENERY", "HEIGHT"]);
    assert.equal(speed.getAttribute("aria-pressed"), "false"); assert.equal(st(b).heat, false);
    speed.click();
    assert.equal(speed.getAttribute("aria-pressed"), "true"); assert.equal(st(b).heat, true);
    speed.click();
    assert.equal(speed.getAttribute("aria-pressed"), "false"); assert.equal(st(b).heat, false);
    chipsIn(dsg, "TRACK OF THE DAY")[0]!.click();
    const a = plain(dz(b).pts);
    assert.match(msgText(b)!, /^Track of the day \(\d{4}-\d{2}-\d{2}\) — seed \d+$/);
    assert.equal(b.D.trackOfTheDay(), true);
    assert.deepEqual(plain(dz(b).pts), a, "deterministic for the day");
    assert.equal(dz(b).seed >>> 0, dz(b).seed);
  });

  it("HEIGHT maps engine elevation, survives scenery and undo, and excludes SPEED without editing the design", () => {
    const b = bootScreen(); openGreen(b);
    const before = plain(st(b));
    const height = chipsIn(b.root, "HEIGHT")[0]!;
    b.D.setMode("elevation");
    assert.equal(height.getAttribute("aria-pressed"), "true");
    assert.equal(st(b).elevationHeat, true);
    assert.deepEqual(plain(dz(b)), before.design);
    assert.equal(st(b).undo, before.undo);
    b.D.applyElevPreset("hilly"); b.D.preview();
    b.D.setMode("scenery");
    assert.equal(st(b).elevationHeat, true);
    b.D.undo(); b.D.preview();
    assert.deepEqual(plain(dz(b).heights), before.design!.heights);
    assert.equal(st(b).elevationHeat, true);
    b.D.toggleHeat(true);
    assert.equal(height.getAttribute("aria-pressed"), "false");
    assert.equal(st(b).heat, true);
    height.click();
    assert.equal(st(b).heat, false);
    assert.equal(st(b).elevationHeat, true);
    height.click();
    assert.equal(st(b).elevationHeat, false);
  });

  it("START FROM…: a card per shipped circuit; a pick traces it into a new design, one UNDO away", () => {
    const b = bootScreen();
    const d0 = openGreen(b);
    const dsg = panes(b)[0]!, from = chipsIn(dsg, "START FROM…")[0]!;
    const grid = walk(dsg).find((e) => e.classList.contains("td-grid"))!;
    assert.equal(grid.hidden, true, "closed until asked");
    from.click();
    assert.equal(grid.hidden, false); assert.equal(from.getAttribute("aria-expanded"), "true");
    const shipped = b.list.filter((t) => !t.custom);
    assert.equal(grid.children.length, shipped.length, "one card per shipped circuit");
    for (const card of kids(grid)) {
      assert.ok(card.classList.contains("td-card"));
      assert.equal(card.children[0]!.tagName, "CANVAS"); assert.equal(card.children[0]!.getAttribute("aria-hidden"), "true");
      assert.match(card.children[1]!.textContent!, /^\d+\.\d\d km · \d+ corners$/);
    }
    const u0 = st(b).undo;
    chipsIn(grid, "MONZA")[0]!.click();
    const s = st(b);
    assert.equal(s.design!.name, "MONZA REMIX");
    assert.ok(s.design!.pts.length >= 60 && s.design!.pts.length <= 120, s.design!.pts.length + " points");
    assert.equal(s.design!.originId, undefined, "SAVE adds a new circuit");
    assert.deepEqual(plain([s.design!.hwZones, s.design!.bankZones, s.design!.elevations, s.design!.bridges]), [[], [], [], []]);
    assert.equal(s.undo, u0 + 1);
    assert.equal(grid.hidden, true, "the cards fold away");
    const v = b.D.preview()!;
    assert.equal(v.red, 0, "Monza traces green: " + v.issues.map((i) => i.code + ":" + i.level).join(","));
    const real = Tracks.buildCenterline(shipped.find((t) => t.id === "monza")!, { line: false }).total;
    assert.ok(Math.abs(v.tr!.total / real - 1) < 0.03, "Monza's length: " + Math.round(v.tr!.total) + " vs " + Math.round(real));
    assert.equal(b.D.undo(), true);
    assert.deepEqual(plain(dz(b).pts), d0.pts, "UNDO brings the design back");
    assert.equal(b.D.startFrom("custom-nope"), false);
  });

  it("START FROM… memoises a small outline per circuit, not its whole centreline", async () => {
    const b = bootScreen();
    openGreen(b);
    chipsIn(panes(b)[0]!, "START FROM…")[0]!.click();
    const shipped = b.list.filter((t) => !t.custom).length;
    for (let i = 0; i < shipped * 4 && st(b).thumbs.cached < shipped; i++) await tick(0);
    const th = st(b).thumbs;
    assert.equal(th.cached, shipped, "every card drew");
    assert.ok(th.maxPts > 32 && th.maxPts <= 256, "an outline of at most 256 points: " + th.maxPts);
  });
});

describe("track-designer-dom (f1-game): authoring", () => {
  it("SPIRAL m: a stepper for CORNER / HAIRPIN / CHICANE / S-BEND only, 0–80 in 5s, named in the label and carried by STAMP", () => {
    const b = bootScreen();
    openGreen(b);
    const row = rowOf(b.root, "SPIRAL m");
    assert.ok(row, "the row exists");
    assert.match((row.parentNode as HTMLElement).children[0]!.textContent!, /^CORNERS/, "inside CORNERS");
    for (const [tool] of b.D.TOOLS) {
      b.D.setTool(tool);
      const curved = ["corner", "hairpin", "chicane", "sbend"].includes(tool);
      assert.equal(!row.hidden && !(row.parentNode as HTMLElement).hidden, curved, tool + (curved ? " shows" : " hides") + " SPIRAL m");
    }
    b.D.setTool("corner");
    const val = row.children[2]!;
    assert.equal(val.textContent, "0");
    stepBy(row, 3); assert.equal(val.textContent, "15");
    stepBy(row, 30); assert.equal(val.textContent, "80", "clamps at 80");
    const label = () => walk(panes(b)[0]!).find((e) => e.classList.contains("td-label") && /^CORNERS/.test(e.textContent!))!.textContent!;
    assert.match(label(), /^CORNERS · CORNER R \d+ m × \d+° (LEFT|RIGHT) · SPIRAL 80 m$/);
    b.D.setTool("hairpin"); assert.equal(val.textContent, "80", "the value rides across the curved tools");
    stepBy(row, -30); assert.equal(val.textContent, "0", "clamps at 0");
    assert.doesNotMatch(label(), /SPIRAL/, "no spiral, no mention");
    b.D.setTool("corner");
    stepBy(rowOf(b.root, "RADIUS m"), 7); stepBy(rowOf(b.root, "ANGLE °"), 6);
    assert.match(label(), /^CORNERS · CORNER R 60 m × 90° /);
    const d0 = plain(dz(b));
    assert.equal(b.D.applyStamp(3, 3), true);
    const flat = plain(dz(b).pts);
    assert.equal(b.D.undo(), true);
    stepBy(row, 8);
    assert.equal(b.D.applyStamp(3, 3), true);
    const spiral = plain(dz(b).pts);
    assert.notDeepEqual(spiral, flat, "SPIRAL 40 m changes the stamp");
    assert.deepEqual(spiral.slice(0, 4), d0.pts.slice(0, 4), "upstream of the anchor nothing moves");
  });

  it("SPAN WIDTH m: one hwZone on the span's control points, merged on repeat, cleared at the base width, capped at 24, carried by an insert and a delete", () => {
    const b = bootHooked();
    const d0 = openGreen(b);
    const row = rowOf(b.root, "SPAN WIDTH m"), val = row.children[2]!;
    const details = row.parentNode as HTMLElement;
    assert.ok(/^ROAD/.test(details.children[0]!.textContent!), "in 4 DETAILS");
    assert.equal(kids(details)[kids(details).indexOf(rowOf(b.root, "HALF-WIDTH m")) + 1], row, "right under HALF-WIDTH");
    assert.equal(row.getAttribute("aria-disabled"), "true", "no span: disabled");
    assert.equal(row.children[1]!.getAttribute("aria-disabled"), "true");
    assert.equal(val.textContent, "—");
    stepBy(row, -1);
    assert.match(msgText(b)!, /^Select a span first/);
    assert.deepEqual(plain(dz(b).hwZones), []);
    b.hooks.onPick!(5, {}); b.hooks.onPick!(9, { shiftKey: true });
    assert.deepEqual([st(b).sel, st(b).span], [5, 9]);
    assert.equal(row.getAttribute("aria-disabled"), "false");
    assert.equal(val.textContent, d0.baseHW.toFixed(1));
    const u0 = st(b).undo;
    stepBy(row, -10);
    let d = dz(b);
    assert.equal(d.hwZones.length, 1, "ten presses, one zone");
    const z = d.hwZones[0]!, hw = Math.round((d0.baseHW - 1) * 10) / 10;
    assert.equal(z.hw, hw); assert.equal(val.textContent, hw.toFixed(1));
    assert.equal(z.ease, 0.025, "a 1 m step tapers over the engine's default");
    assert.equal(st(b).undo, u0 + 10, "one UNDO per press");
    assert.deepEqual(plain(d.pts), d0.pts, "no point moves");
    samePlace(pointAt(d.pts, z.s0), d.pts[5]!, 1e-6, "s0 on point 6"); samePlace(pointAt(d.pts, z.s1), d.pts[9]!, 1e-6, "s1 on point 10");
    const it2 = b.C.sanitize(d)!, raw = b.C.toRaw(it2);
    samePlace(pointAtIndex(it2.pts, raw.hwZones![0]!.s0), d.pts[5]!, 0.25, "toRaw s0");
    const v = b.D.preview()!, mid = d.pts[7]!;
    let k = 0; for (let j = 0; j < v.tr!.n; j++) if (Math.hypot(v.tr!.px[j]! - mid[0], v.tr!.pz[j]! - mid[1]) < Math.hypot(v.tr!.px[k]! - mid[0], v.tr!.pz[k]! - mid[1])) k = j;
    assert.ok(Math.abs(v.tr!.hw[k]! - hw) < 0.05, "built half-width " + v.tr!.hw[k] + " under the span");
    assert.equal(b.D.setSpanWidth(d0.baseHW + 1), true, "over the base clamps to it…");
    assert.deepEqual(plain(dz(b).hwZones), [], "…which clears the zone");
    assert.equal(b.D.setSpanWidth(d0.baseHW), false, "nothing left to clear");
    assert.equal(b.D.setSpanWidth(5.5), true);
    assert.equal(b.D.setSpanWidth(5.5), false, "the same width again is no edit");
    assert.equal(b.D.setSpanWidth(2), true, "under the registry's 5 m floor clamps to it");
    d = dz(b);
    assert.equal(d.hwZones.length, 1); assert.equal(d.hwZones[0]!.hw, 5);
    const Pp = d.pts, ins = Pp.slice(0, 2).concat([[(Pp[1]![0] + Pp[2]![0]) / 2, (Pp[1]![1] + Pp[2]![1]) / 2]], Pp.slice(2));
    b.hooks.onChange!(ins, "insert");
    let e = dz(b);
    assert.equal(e.pts.length, Pp.length + 1);
    samePlace(pointAt(e.pts, e.hwZones[0]!.s0), Pp[5]!, 1e-6, "insert before: s0 still on the same point"); samePlace(pointAt(e.pts, e.hwZones[0]!.s1), Pp[9]!, 1e-6, "…and s1");
    assert.equal(b.D.deletePoint(14), true);
    e = dz(b);
    samePlace(pointAt(e.pts, e.hwZones[0]!.s0), Pp[5]!, 1e-6, "delete after: s0 still on the same point"); samePlace(pointAt(e.pts, e.hwZones[0]!.s1), Pp[9]!, 1e-6, "…and s1");
    b.hooks.onPick!(5, {}); b.hooks.onPick!(8, { shiftKey: true });
    assert.equal(b.D.setSpanWidth(6), true);
    e = dz(b);
    assert.equal(e.hwZones.length, 1, "an overlapping span replaces the zone"); assert.equal(e.hwZones[0]!.hw, 6);
    const N = e.pts.length, c = cumOf(e.pts), L = c[N]!;
    const many: { s0: number; s1: number; hw: number; ease: number }[] = [];
    for (let m = 0; m < 24; m++) { const a = c[20 + m]! / L, q2 = (c[20 + m]! + 4) / L; many.push({ s0: a, s1: q2, hw: 6.5, ease: 0.025 }); }
    b.D.load(Object.assign({}, e, { hwZones: many }));
    b.hooks.onPick!(2, {}); b.hooks.onPick!(5, { shiftKey: true });
    assert.equal(b.D.setSpanWidth(6), false);
    assert.match(msgText(b)!, /24 width zones at most/);
    assert.equal(dz(b).hwZones.length, 24);
    b.hooks.onPick!(20, {}); b.hooks.onPick!(22, { shiftKey: true });
    assert.equal(b.D.setSpanWidth(6), true, "over zones it replaces, the cap is not reached");
    assert.equal(dz(b).hwZones.filter((z2) => z2.hw === 6).length, 1);
    assert.ok(dz(b).hwZones.length <= 24);
  });

  it("BANK °: the SELECTED TURN banks its apex — {frac, angleDeg, widthM: the corner's length}; over 5.7° is FIA amber; 0 flattens it; TURNS reads it back", () => {
    const b = bootScreen();
    openGreen(b);
    const list = turnsList(b), pick = kids(list.parentNode as HTMLElement).find((e) => e.getAttribute("role") === "group")!;
    assert.ok(pick, "a SELECTED TURN block inside TURNS");
    assert.equal(pick.hidden, true, "hidden until a turn is selected");
    const row = rowOf(pick, "BANK °"), val = row.children[2]!;
    b.D.setMode("elevation");
    kids(list)[1]!.click();
    assert.equal(st(b).mode, "elevation", "selecting a turn keeps the banking workspace");
    assert.equal(pick.hidden, false);
    assert.equal(pick.children[0]!.textContent, "SELECTED TURN · T2");
    assert.equal(val.textContent, "FLAT");
    const v0 = b.D.preview()!, s = st(b);
    const c = TrackInsight.corners(v0.tr, s.design!.pts, null, v0.turns)[1]!;
    assert.equal(c.bankDeg, 0); assert.equal(c.hwSpan, null);
    const u0 = s.undo;
    stepBy(row, 3);
    let d = dz(b);
    assert.equal(d.bankZones.length, 1, "three presses, one zone");
    // f1-game compared frac with c.sApex / total; designer.js:1979 stores wrap01(c.sApex / L), which rounds
    // 0.7499999999999999 to 0.75 on this (TrackMaps-less) build's T2.
    const wrap01 = (x: number) => ((x % 1) + 1) % 1;
    assert.deepEqual(plain(d.bankZones[0]), { frac: wrap01(c.sApex / v0.tr!.total), angleDeg: 6, widthM: Math.round(Math.min(600, Math.max(20, c.lenM))) });
    assert.equal(st(b).undo, u0 + 3);
    assert.deepEqual(plain(d.pts), s.design!.pts, "no point moves");
    assert.equal(val.textContent, "6°");
    let v = b.D.preview()!;
    assert.ok(v.issues.some((i) => i.code === "fia-bank" && i.level === "amber"), "6° is over the FIA's 5.7°: " + v.issues.map((i) => i.code).join(","));
    assert.equal(v.red, 0);
    assert.match(kids(turnsList(b))[1]!.textContent!, / · BANK 6°$/, "TURNS says so");
    assert.equal(TrackInsight.corners(v.tr, d.pts, null, v.turns)[1]!.bankDeg, 6);
    assert.equal(pick.hidden, false, "still selected after the preview");
    stepBy(row, -1);
    v = b.D.preview()!;
    assert.equal(dz(b).bankZones[0]!.angleDeg, 4);
    assert.ok(!v.issues.some((i) => i.code === "fia-bank"), "4° is within Grade 1");
    stepBy(row, -5);
    assert.deepEqual(plain(dz(b).bankZones), [], "down past 2° is flat: the zone goes");
    assert.equal(val.textContent, "FLAT");
    assert.equal(b.D.setCornerBank(2, 99), true, "by number; clamps to 30");
    assert.equal(dz(b).bankZones[0]!.angleDeg, 30);
    assert.equal(b.D.setCornerBank(2, 30), false, "the same again is no edit");
    assert.equal(b.D.setCornerBank(2, 0), true);
    assert.equal(b.D.setCornerBank(99, 6), false, "no such turn");
    kids(turnsList(b))[1]!.click();
    assert.equal(b.D.setSpanWidth(6), true);
    b.D.preview();
    assert.match(kids(turnsList(b))[1]!.textContent!, / · 12 m WIDE$/);
    b.D.setTool("select");
    b.D.undo();
    assert.equal(pick.hidden, true, "UNDO clears the selection");
    void d;
  });

  it("elevation: presets + node height undo/redo; strip selects a point; Escape lets go first", () => {
    const win: { type: string; fn: (e: unknown) => void; cap: unknown }[] = [];
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation(((type: string, fn: EventListener, cap?: unknown) => { win.push({ type, fn: fn as (e: unknown) => void, cap }); add(type, fn, cap as boolean); }) as typeof window.addEventListener);
    const kinds: string[] = [];
    const b = bootScreen({}, { deps: { log: { debug: (_ns: string, msg: string) => { const m = /designer edit: (\S+)/.exec(String(msg)); if (m) kinds.push(m[1]!); } } } });
    openGreen(b);
    b.D.setMode("elevation");
    const strip = q<HTMLCanvasElement>(b.root, 'canvas[data-role="profile"]'), stage = q(b.root, ".td-stage");
    assert.ok(strip, "the strip is built");
    assert.ok(stage.contains(strip), "strip under the stage");
    assert.equal(strip.tabIndex, 0);
    const presets = chipsIn(panes(b)[0]!, "ROLLING")[0]!.parentNode as HTMLElement;
    assert.deepEqual(kids(presets).map((c) => c.textContent), ["FLAT", "ROLLING", "HILLY"]);
    const u0 = st(b).undo;
    chipsIn(panes(b)[0]!, "ROLLING")[0]!.click();
    assert.equal(kinds.at(-1), "elev:rolling");
    const s = st(b);
    assert.equal(s.undo, u0 + 1);
    assert.equal(s.design!.heights.length, s.design!.pts.length);
    assert.ok(s.design!.heights.some((h) => h !== 0), "rolling moves nodes");
    assert.deepEqual(s.design!.elevations, [], "presets clear legacy cosine hills");
    b.D.setMode("elevation");
    const pick = Math.floor(s.design!.pts.length / 2);
    q(b.root, "canvas").focus();
    b.D.setNodeHeight(pick, 5);
    assert.equal(kinds.at(-1), "elev:node");
    assert.equal(dz(b).heights[pick], 5);
    strip.focus();
    const back = win.filter((l) => l.cap && l.type === "keydown");
    const esc = { type: "keydown", key: "Escape", defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const l of back) l.fn(esc);
    assert.equal(b.D.undo(), true);
    assert.notEqual(dz(b).heights[pick], 5);
    assert.equal(b.D.redo(), true);
    assert.equal(dz(b).heights[pick], 5);
    chipsIn(panes(b)[0]!, "FLAT")[0]!.click();
    assert.ok(dz(b).heights.every((h) => h === 0));
    const bare: Partial<Design> = Object.assign({}, s.design!); delete bare.heights;
    b.D.load(bare);
    assert.ok(dz(b).heights.every((h) => h === 0), "missing heights → flat");
    assert.equal(dz(b).heights.length, dz(b).pts.length);
  });

  it("DESIGNED RANDOMISE: FAST fills four cards (busy while it runs), USE loads one in one UNDO, MORE LIKE THIS replaces them", async () => {
    const b = bootScreen();
    openGreen(b);
    const dsg = panes(b)[0]!, fast = chipsIn(dsg, "FAST")[0]!, row = fast.parentNode as HTMLElement;
    assert.deepEqual(kids(row).map((c) => c.textContent), ["FAST", "TECHNICAL", "MIXED"]);
    assert.ok(kids(row).every((c) => c.getAttribute("aria-pressed") === "false"));
    const grid = walk(dsg).filter((e) => e.classList.contains("td-grid"))[1]!;
    assert.equal(grid.hidden, true, "no cards before a style is pressed");
    assert.equal(row.parentNode, grid.parentNode, "the style row and the cards share 4 DETAILS");
    const run = b.D.designed("FAST", 21);
    assert.equal(grid.getAttribute("aria-busy"), "true", "aria-busy while designing");
    assert.ok(kids(row).every((c) => (c as HTMLButtonElement).disabled), "style chips disabled while designing");
    assert.equal(msgText(b), "Designing 16 circuits…");
    assert.equal(fast.getAttribute("aria-pressed"), "true");
    assert.equal(chipsIn(dsg, "TECHNICAL")[0]!.getAttribute("aria-pressed"), "false");
    assert.equal(await run, true);
    assert.equal(grid.hasAttribute("aria-busy"), false, "aria-busy cleared");
    assert.ok(kids(row).every((c) => !(c as HTMLButtonElement).disabled));
    assert.equal(grid.hidden, false);
    assert.equal(grid.children.length, 4, "four cards");
    const s = st(b);
    assert.equal(s.candidates.length, 4);
    for (let i = 1; i < 4; i++) assert.ok(s.candidates[i - 1]!.score >= s.candidates[i]!.score, "best first");
    for (const card of kids(grid)) {
      assert.ok(card.classList.contains("td-card"));
      assert.equal(card.children[0]!.tagName, "CANVAS"); assert.equal(card.children[0]!.getAttribute("aria-hidden"), "true");
      assert.match(card.children[1]!.textContent!, /^\d+\.\d km · \d+ corners · \d+ passing$/);
      assert.deepEqual(chipsIn(card).map((c) => c.textContent), ["USE", "MORE LIKE THIS"]);
    }
    assert.match(msgText(b)!, /^FAST: the best 4 of 16/);
    await b.D.designed("FAST", 21);
    assert.deepEqual(plain(st(b).candidates), plain(s.candidates));
    const u0 = st(b).undo, d0 = plain(dz(b).pts);
    chipsIn(kids(grid)[1]!, "USE")[0]!.click();
    const now = st(b);
    assert.equal(now.undo, u0 + 1, "one UNDO entry");
    assert.equal(now.design!.seed, s.candidates[1]!.seed);
    assert.equal(now.design!.originId, undefined, "SAVE adds a new circuit");
    assert.equal(b.D.preview()!.ok, true, "the card is green");
    assert.equal(b.D.undo(), true);
    assert.deepEqual(plain(dz(b).pts), d0, "UNDO brings the design back");
    const more = b.D.moreLikeThis(0);
    assert.equal(grid.getAttribute("aria-busy"), "true");
    assert.equal(await more, true);
    assert.equal(grid.hasAttribute("aria-busy"), false);
    const after = st(b).candidates;
    assert.ok(after.length >= 2 && after.length <= 4 && grid.children.length === after.length, after.length + " variants");
    assert.ok(after.every((c) => !s.candidates.some((o) => o.seed === c.seed)), "new seeds: the cards were replaced");
    assert.match(msgText(b)!, /circuits like design 1/);
    assert.equal(b.D.useCandidate(0), true);
    assert.equal(b.D.preview()!.ok, true, "a variant is green");
    assert.equal(b.D.useCandidate(9), false, "no such card");
  });
});

// ── Round 3 PR E: the share card and TEST HERE ─────────────────────────────
/** A 2D context that records the text it draws (and measures 6.6 px a glyph). */
function recordingCanvas(texts: string[], canvases: HTMLCanvasElement[], blobDelay = -1) {
  const mk = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, o?: ElementCreationOptions) => {
    const e = mk(tag, o);
    if (String(tag).toLowerCase() === "canvas") {
      canvases.push(e as HTMLCanvasElement);
      const ctx = new Proxy({} as Ctx2D, { get: (t, k) => (k === "fillText" ? (s: unknown) => texts.push(String(s)) : k === "measureText" ? (s: unknown) => ({ width: String(s).length * 6.6 }) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
      Object.defineProperty(e, "getContext", { value: () => ctx });
      const toBlob = (cb: BlobCallback, type?: string) => cb(new Blob(["\x89PNG"], { type: type || "image/png" }));
      Object.defineProperty(e, "toBlob", { value: blobDelay >= 0 ? (cb: BlobCallback, type?: string) => setTimeout(() => toBlob(cb, type), blobDelay) : toBlob, writable: true });
    }
    return e;
  }) as typeof document.createElement);
}

describe("track-designer-dom (f1-game): CARD and TEST HERE", () => {
  it("CARD: a share link too long for the card is not cut mid-code; the card points at SHARE instead", async () => {
    const b = bootScreen();
    const texts: string[] = [], canvases: HTMLCanvasElement[] = [];
    openGreen(b, 11);
    recordingCanvas(texts, canvases);
    vi.stubGlobal("navigator", { canShare: () => true, share: async () => {} });
    await b.D.shareCard();
    const code = st(b).lastCode!;
    assert.ok(TrackCodec.shareUrl(code).length > 400, "a real code is far longer than the card's link column");
    const lines = texts.slice(texts.indexOf("APEX 26 · TRACK DESIGNER") + 1);
    assert.equal(lines.some((t) => t.length > 6 && code.includes(t.replace(/…$/, ""))), false, "no fragment of the code on the card: " + lines.join(" | "));
    assert.ok(lines.includes("#track=…") && lines.includes("full link: SHARE"), lines.join(" | "));
  });

  it("CARD: a 640×360 PNG to the share sheet when canShare({files}) allows, else NativeDownload, else <a download>; a dismissed sheet is silent; red refuses", async () => {
    const b = bootScreen();
    const texts: string[] = [], canvases: HTMLCanvasElement[] = [], shared: { files: File[]; title: string; text: string }[] = [], native: [string, string][] = [], anchors: [string, string][] = [];
    openGreen(b);
    recordingCanvas(texts, canvases);
    let canShare = true, shareErr: Error | null = null;
    vi.stubGlobal("navigator", { canShare: (d: { files?: unknown[] }) => canShare && Array.isArray(d.files) && d.files.every((f) => f instanceof File), share: async (d: { files: File[]; title: string; text: string }) => { if (shareErr) throw shareErr; shared.push(d); } });
    const foot = q(b.root, ".td-foot");
    assert.deepEqual(chipsIn(foot).map((c) => c.textContent).slice(3, 6), ["SHARE", "CARD", "EXPORT"], "CARD sits after SHARE in the foot");
    assert.equal(await b.D.shareCard(), true);
    const c = canvases[canvases.length - 1]!;
    assert.deepEqual([c.width, c.height], [640, 360], "an offscreen 640×360 card");
    const url = TrackCodec.shareUrl(st(b).lastCode!), name = dz(b).name;
    assert.equal(shared.length, 1);
    const f = shared[0]!.files[0]!;
    assert.match(f.name, /^apex26-track-[a-z0-9-]+-card\.png$/);
    assert.equal(f.type, "image/png");
    assert.deepEqual([shared[0]!.title, shared[0]!.text], [name, url], "the full link always rides the share text");
    assert.ok(texts.includes(name) && texts.includes("APEX 26 · TRACK DESIGNER"), "name and mark drawn: " + texts.join(" | "));
    assert.ok(texts.some((t) => /km · \d+ corners · est lap \d+:\d\d\.\d$/.test(t)), "the facts line");
    const urlLines = texts.filter((t) => /#track=|^https?:|^\.\.\.|…|^[A-Za-z0-9._~%-]+$/.test(t) && t !== name);
    assert.ok(urlLines.length >= 1 && urlLines.length <= 3, "the link in at most three lines: " + urlLines.join(" | "));
    assert.equal(urlLines.some((t) => /#trac$/i.test(t) || /^k=/i.test(t)), false, "no mid-word #track wrap: " + urlLines.join(" | "));
    assert.ok(urlLines.some((t) => /#track=/.test(t) || t === "#track="), "#track= token stays whole: " + urlLines.join(" | "));
    assert.equal(msgText(b), "Card shared");
    canShare = false;
    b.deps.nativeDownload = { viable: () => true, saveBlob: async (blob: Blob, n: string) => { native.push([blob.type, n]); } };
    assert.equal(await b.D.shareCard(), true);
    assert.deepEqual(native, [["image/png", f.name]]);
    assert.equal(msgText(b), "Card saved as " + f.name);
    b.deps.nativeDownload = { viable: () => false };
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:card");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const mk = vi.mocked(document.createElement).getMockImplementation() as unknown as (tag: string) => HTMLElement;
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => { const e = mk(tag); if (String(tag).toLowerCase() === "a") Object.defineProperty(e, "click", { value: () => anchors.push([(e as HTMLAnchorElement).href, (e as HTMLAnchorElement).download]) }); return e; }) as typeof document.createElement);
    canShare = true; shareErr = Object.assign(new Error("no activation"), { name: "NotAllowedError" });
    assert.equal(await b.D.shareCard(), true);
    assert.deepEqual(anchors, [["blob:card", f.name]]);
    shareErr = Object.assign(new Error("dismissed"), { name: "AbortError" });
    b.D.load(Object.assign({}, dz(b)));
    const before = msgText(b);
    assert.equal(await b.D.shareCard(), false);
    assert.equal(anchors.length, 1); assert.equal(native.length, 1);
    assert.equal(msgText(b), before);
    const n0 = canvases.length;
    b.D.load(Object.assign({}, dz(b), { pts: SHORT_LOOP() }));
    assert.equal(b.D.preview()!.ok, false);
    assert.equal(await b.D.shareCard(), false);
    assert.equal(canvases.length, n0);
    assert.match(msgText(b)!, /Fix the red issues before sharing/);
  });

  it("CARD re-entry: a second shareCard while the first is mid-share is refused (no double download)", async () => {
    const b = bootScreen();
    openGreen(b);
    recordingCanvas([], [], 150);
    let release: (() => void) | null = null, entered: (() => void) | null = null;
    const shareEntered = new Promise<void>((resolve) => { entered = resolve; });
    vi.stubGlobal("navigator", {
      canShare: (d: { files?: unknown[] }) => Array.isArray(d.files) && d.files.every((f) => f instanceof File),
      share: () => new Promise<void>((resolve) => { release = resolve; entered!(); }),
    });
    const first = b.D.shareCard();
    await shareEntered;
    assert.equal(typeof release, "function", "first call entered nav.share");
    assert.equal(await b.D.shareCard(), false, "re-entry refused while busy");
    release!();
    assert.equal(await first, true);
    assert.equal(msgText(b), "Card shared");
  });

  it("TEST HERE: saves, arms the return, starts a TIME TRIAL on the circuit, drops the car at rest on the selected point and goes green; a failed start comes back with the reason", async () => {
    const b = bootHooked();
    openGreen(b);
    const hooks = b.hooks;
    const d = dz(b), tr = TrackValidate.check(d).tr!;
    const calls: unknown[][] = [];
    const grid = { s: tr.total - 14, _prevS: tr.total - 14, prog: -14, x: -3, xVis: -3, px: 1, pz: 2, head: 0, speed: 4, vLat: 2, yawRateCur: 1, yawVis: 0.2, steerVis: 0.1, rescueT: 3, wallT: 1, wasOnWall: true, wrongT: 2, wrongWay: true, offT: 1 };
    const G = b.G as DesignerGame & Record<string, unknown>;
    Object.assign(G, {
      state: "menu", player: null, track: null, timeTrial: false, seasonMode: true,
      startRace: async () => { calls.push(["startRace", G.trackIdx, G.timeTrial, G.seasonMode, b.D.isOpen()]); G.state = "count"; G.track = tr; G.player = Object.assign({}, grid); },
      raceIntro: (go: () => void) => { calls.push(["raceIntro"]); void Promise.resolve().then(go); },
      goRolling: () => { calls.push(["goRolling"]); if (G.state !== "count") return false; G.state = "race"; return true; },
      snapGameCam: () => { calls.push(["snap"]); }, refreshHud: () => { calls.push(["hud"]); },
      quitToMenu: () => { calls.push(["quit"]); G.state = "menu"; void b.C.consumeTrackHash(); },
    });
    b.C.create(G, { load: async () => true });
    const chip = chipsIn(q(b.root, ".td-rail"), "TEST HERE")[0]!;
    assert.equal(kids(chip.parentNode as HTMLElement).at(-1), chip, "appended to the actions row");
    assert.ok(q(b.root, '.td-chips[data-role="toolbar"]'), "FIT VIEW lives on the stage toolbar");
    assert.ok(chipsIn(q(b.root, ".td-stage"), "FIT VIEW").length === 1);
    const ctxRow = q(b.root, ".td-ctx");
    assert.equal(kids(ctxRow).at(-1)!.textContent, "TEST HERE", "…and to the press-and-hold row");
    assert.equal(chip.getAttribute("aria-disabled"), "true");
    assert.equal(await b.D.testHere(), false, "no point, no drive");
    assert.match(msgText(b)!, /Select a point/);
    assert.equal(calls.length, 0);
    hooks.onPick!(12, { shiftKey: false });
    assert.equal(chip.getAttribute("aria-disabled"), "false");
    assert.equal(await b.D.testHere(), true);
    const id = st(b).library[0]!;
    assert.ok(id && dz(b).originId === id, "saved first");
    assert.deepEqual(plain(calls), [["raceIntro"], ["startRace", b.list.findIndex((t) => t.id === id), true, false, false], ["snap"], ["hud"], ["goRolling"]], "trackIdx + time trial + gp flow, closed, the pre-race screen, then the drop and the green");
    assert.equal(G.state, "race");
    const p0 = d.pts[12]!;
    let k = 0; for (let j = 0, best = Infinity; j < tr.n; j++) { const qq = (tr.px[j]! - p0[0]) ** 2 + (tr.pz[j]! - p0[1]) ** 2; if (qq < best) { best = qq; k = j; } }
    const sExp = k * tr.total / tr.n, p = G.player as Record<string, number | boolean> & { s: number };
    const ds = Math.abs(p.s - sExp), wrapD = Math.min(ds, tr.total - ds);
    assert.ok(wrapD <= 20, "placed at s " + p.s + " vs " + sExp);
    const smp = { p: [0, 0, 0] as [number, number, number], t: [0, 0, 0] as [number, number, number], r: [0, 0, 0] as [number, number, number], hw: 0 };
    Tracks.sample(tr, p.s, smp);
    assert.deepEqual([p.px, p.pz, p.head], [smp.p[0], smp.p[2], Math.atan2(smp.t[0], smp.t[2])], "world pose from the track sample");
    assert.equal(p.prog, p.s - tr.total, "an out-lap: the first crossing starts the timed lap");
    assert.equal(p._prevS, p.s);
    assert.deepEqual([p.x, p.xVis, p.speed, p.vLat, p.yawRateCur, p.yawVis, p.steerVis, p.rescueT, p.wallT, p.wasOnWall, p.wrongT, p.wrongWay, p.offT], [0, 0, 0, 0, 0, 0, 0, 0, 0, false, 0, false, 0], "at rest, every transient cleared");
    assert.deepEqual([p.rPrevPx, p.rPrevPz, p.rPrevS, p.rPrevX, p.rPrevHead, p.rPrevYawVis], [p.px, p.pz, p.s, 0, p.head, 0], "render anchors seeded");
    const sTest = p.s;
    Object.assign(G.player!, { s: tr.total - 14, _prevS: tr.total - 14, prog: -14, speed: 55 }); G.state = "count"; calls.length = 0;
    b.C.afterStart();
    assert.deepEqual(plain(calls), [["snap"], ["hud"], ["goRolling"]], "a restart drops the car on the point again and goes green");
    assert.equal(G.state, "race");
    assert.equal(G.player!.s, sTest, "…the same point, not the grid line");
    assert.equal(G.player!.speed, 0);
    calls.length = 0; b.C.afterStart();
    assert.equal(calls.length, 0, "a race already rolling is left alone");
    Object.assign(G.player!, { s: tr.total - 14, _prevS: tr.total - 14, prog: -14, speed: 55 });
    G.state = "race"; calls.length = 0;
    b.C.afterStart();
    assert.deepEqual(plain(calls), [["snap"], ["hud"]], "late afterStart relocates without a second goRolling");
    assert.equal(G.state, "race");
    assert.equal(G.player!.s, sTest, "…onto the armed point, not the grid");
    assert.equal(G.player!.speed, 0);
    // SKIPPED: the js/game.js source pin (CustomTracks.afterStart on the owning committed session): game.js is not ported.
    b.D.load(Object.assign({}, dz(b)), "library", id);
    b.D.close();
    b.layers.race = true;
    assert.equal(await b.C.consumeTrackHash(), null, "mid-race it waits");
    assert.equal(b.D.isOpen(), false);
    b.layers.race = false;
    assert.equal(await b.C.consumeTrackHash(), true);
    assert.equal(b.D.isOpen(), true);
    assert.equal(st(b).sel, 12, "the selected point is back");
    G.state = "count"; calls.length = 0; b.C.afterStart();
    assert.equal(calls.length, 0, "the return was taken: a later start is an ordinary one");
    assert.equal(msgText(b), "Back from the test drive");
    calls.length = 0; G.headlessMode = true; G.state = "menu";
    hooks.onPick!(12, { shiftKey: false });
    assert.equal(await b.D.testHere(), true);
    assert.deepEqual(plain(calls.map((c) => c[0])), ["startRace", "snap", "hud", "goRolling"], "headless: straight to the start, no pre-race screen");
    G.headlessMode = false;
    assert.equal(await b.C.consumeTrackHash(), true, "back on the designer for the next scenario");
    calls.length = 0; G.state = "menu";
    const intro = G.raceIntro; G.raceIntro = () => { calls.push(["raceIntro"]); throw new Error("no card"); };
    hooks.onPick!(12, { shiftKey: false });
    assert.equal(await b.D.testHere(), true);
    assert.deepEqual(plain(calls.map((c) => c[0])), ["raceIntro", "startRace", "snap", "hud", "goRolling"]);
    G.raceIntro = intro!;
    assert.equal(await b.C.consumeTrackHash(), true);
    calls.length = 0;
    G.startRace = async () => { calls.push(["startRace"]); };
    G.state = "results";
    hooks.onPick!(12, { shiftKey: false });
    assert.equal(await b.D.testHere(), false);
    await tick(0);
    assert.deepEqual(plain(calls), [["raceIntro"], ["startRace"], ["quit"]], "never a frozen race");
    assert.equal(b.D.isOpen(), true);
    assert.match(msgText(b)!, /could not start/);
    calls.length = 0;
    b.D.load(Object.assign({}, dz(b), { pts: SHORT_LOOP() }));
    hooks.onPick!(3, { shiftKey: false });
    assert.equal(await b.D.testHere(), false);
    assert.equal(calls.length, 0);
    assert.match(msgText(b)!, /Fix the red issues before racing/);
  });

  it("consumeTrackHash: an armed return reopens with sel/span (only for the same design), defers mid-race keeping it, and is taken once", async () => {
    const b = bootScreen();
    openGreen(b);
    const r = b.D.save() as { ok: boolean; id: string };
    assert.equal(r.ok, true);
    b.C.create(b.G, { load: async () => true });
    b.D.close();
    assert.equal(await b.C.consumeTrackHash(), false, "nothing armed, no link: a no-op");
    b.C.armReturn({ id: r.id, sel: 5, span: 9, s: 100 });
    b.layers.race = true;
    assert.equal(await b.C.consumeTrackHash(), null);
    assert.equal(await b.C.consumeTrackHash(), null, "still armed while racing");
    assert.equal(b.D.isOpen(), false);
    b.layers.race = false;
    assert.equal(await b.C.consumeTrackHash(), true);
    assert.equal(b.D.isOpen(), true);
    assert.deepEqual([st(b).sel, st(b).span], [5, 9]);
    assert.equal(msgText(b), "Back from the test drive");
    b.D.close();
    assert.equal(await b.C.consumeTrackHash(), false, "taken once: the second call is a no-op");
    assert.equal(b.D.isOpen(), false);
    b.D.open(); b.D.randomise(99); b.D.preview(); b.D.close();
    b.C.armReturn({ id: r.id, sel: 7, span: -1, s: 0 });
    assert.equal(await b.C.consumeTrackHash(), true);
    assert.equal(b.D.isOpen(), true);
    assert.equal(st(b).sel, -1);
    assert.notEqual(msgText(b), "Back from the test drive");
    assert.equal(b.data().customTrackReturn, undefined, "memory only — nothing stored");
    assert.ok(!Object.keys(b.data()).some((k) => /return/i.test(k)), "no stored return key");
  });
});

describe("track-designer-dom (f1-game): look, kerbs, scenery", () => {
  it("3 LOOK: a chip per theme (thirty), dual-colour swatches, the theme's blurb, and TIME OF DAY / TREES / CROWD rows that set design.look in one UNDO each", () => {
    const b = bootScreen();
    openGreen(b);
    b.D.setMode("scenery");
    const T = TrackThemes;
    const LEGACY_20 = ["parkland", "alpine", "oasis", "desertnight", "harbour", "marina", "tilke", "autumn",
      "tuscany", "coast", "savanna", "ardennes", "airfield", "canyon", "winter", "twilight",
      "jungle", "lakeside", "moorland", "metropolis"];
    const SLICE_I = ["shipyard", "saltflat", "vineyard", "stadium", "island"];
    assert.equal(T.ORDER.length, 30);
    assert.deepEqual([...T.ORDER.slice(0, 20)], LEGACY_20, "legacy ORDER ids never reorder");
    assert.deepEqual([...T.ORDER.slice(20, 25)], SLICE_I, "slice I appends shipyard…island");
    assert.deepEqual([...T.ORDER.slice(25, 27)], ["blossom", "volcanic"], "new worlds append without shifting old share codes");
    assert.equal(typeof T.swatchCss, "function", "swatchCss helper for LOOK tiles");
    for (const id of T.ORDER) {
      const p = T.PRESETS[id]!;
      assert.ok(p && T.DRESS[id], id + " has PRESET + DRESS");
      assert.ok(Array.isArray(p.swatch) && p.swatch.length === 2, id + " has a swatch pair");
      assert.match(p.swatch[0]!, /^#[0-9a-fA-F]{6}$/, id + " swatch[0] hex");
      assert.match(p.swatch[1]!, /^#[0-9a-fA-F]{6}$/, id + " swatch[1] hex");
      assert.equal(T.swatchCss(id), "linear-gradient(135deg," + p.swatch[0] + " 50%," + p.swatch[1] + " 50%)");
    }
    const themeChips = walk(b.root).filter((e) => e.dataset && e.dataset.theme);
    assert.deepEqual(themeChips.map((e) => e.dataset.theme), [...T.ORDER], "one chip per preset, in share-code order");
    for (const chip of themeChips) {
      const p = T.get(chip.dataset.theme);
      assert.equal(chip.getAttribute("aria-label"), p.label || chip.dataset.theme);
      const sw = kids(chip).find((c) => c.classList.contains("swatch"))!;
      assert.ok(sw, chip.dataset.theme + " has a swatch");
      assert.equal(sw.getAttribute("aria-hidden"), "true");
      // happy-dom serialises the gradient (rgb(), spaces): compare through a probe element styled the same way.
      const probe = document.createElement("span"); probe.style.background = T.swatchCss(chip.dataset.theme);
      assert.equal(sw.style.background, probe.style.background, chip.dataset.theme + " paints its swatch pair");
      const lab = kids(chip).find((c) => c.dataset && c.dataset.role === "theme-label");
      assert.ok(lab && lab.textContent === (p.label || chip.dataset.theme!.toUpperCase()), chip.dataset.theme + " keeps a visible label");
    }
    const blurb = walk(b.root).find((e) => e.dataset && e.dataset.role === "theme-blurb")!;
    assert.ok(blurb, "the active theme's blurb is shown");
    assert.equal(blurb.textContent, T.get(dz(b).theme).blurb);
    assert.equal(b.D.setTheme("winter"), true);
    assert.equal(blurb.textContent, T.PRESETS.winter!.blurb, "…and follows the theme");
    const look = (k: string, v: string) => walk(b.root).find((e) => e.dataset && e.dataset.look === k + ":" + v)!;
    for (const k of ["time", "trees", "crowd"] as const) for (const v of T.LOOK[k]) assert.ok(look(k, v), k + ":" + v + " chip");
    assert.equal(dz(b).look, undefined, "a new design stores no look");
    assert.equal(look("time", "auto").getAttribute("aria-pressed"), "true");
    const u0 = st(b).undo;
    look("time", "night").click();
    assert.deepEqual(plain(dz(b).look), { time: "night", trees: "normal", crowd: "normal" });
    assert.equal(st(b).undo, u0 + 1, "one UNDO entry");
    assert.equal(look("time", "night").getAttribute("aria-pressed"), "true");
    assert.equal(look("time", "auto").getAttribute("aria-pressed"), "false");
    assert.equal(b.D.setLook("time", "night"), false, "no-op on the same value");
    assert.equal(b.D.setLook("time", "midnight"), false, "unknown values are refused");
    assert.equal(b.D.setLook("trees", "many"), true);
    assert.equal(b.D.setLook("crowd", "packed"), true);
    assert.deepEqual(plain(dz(b).look), { time: "night", trees: "many", crowd: "packed" });
    const idLook = b.C.sanitize(dz(b))!.id;
    for (const [k, v] of [["time", "auto"], ["trees", "normal"], ["crowd", "normal"]] as const) b.D.setLook(k, v);
    assert.equal(dz(b).look, undefined, "all defaults → no look stored");
    assert.notEqual(b.C.sanitize(dz(b))!.id, idLook);
    assert.equal(b.D.undo(), true);
    assert.deepEqual(plain(dz(b).look), { time: "auto", trees: "normal", crowd: "packed" }, "UNDO restores the previous look");
    assert.match(CSS, /#trackdesigner \.td-chips\[data-role="themes"\]\s*\{/, "theme grid");
    assert.match(CSS, /#trackdesigner \.td-chips\[data-role="themes"\] \.swatch\s*\{/, "theme swatch paint box");
    assert.match(CSS, /forced-colors: active[\s\S]*\[data-role="themes"\][\s\S]*forced-color-adjust:\s*none/, "swatch colour survives forced-colors");
  });

  it("ELEVATION mode exposes BANKING & KERBS: FLAT/SAUSAGE/RUMBLE + BERMS ON/OFF; undo restores", () => {
    const b = bootScreen();
    openGreen(b);
    const bank = q(b.root, '[data-role="bank-kerbs"]');
    assert.ok(bank, "bank-kerbs group is built");
    assert.equal(bank.hidden, true, "hidden outside elevation");
    b.D.setMode("elevation");
    assert.equal(bank.hidden, false, "shown in elevation");
    const kerbs = q(bank, '[data-role="kerb-style"]');
    assert.deepEqual(kids(kerbs).map((c) => c.textContent), ["FLAT", "SAUSAGE", "RUMBLE"]);
    assert.equal(kerbs.children[0]!.getAttribute("aria-pressed"), "true", "flat is default");
    const u0 = st(b).undo;
    kids(kerbs)[1]!.click();
    assert.equal(dz(b).kerbStyle, "sausage");
    assert.equal(st(b).undo, u0 + 1);
    assert.equal(kerbs.children[1]!.getAttribute("aria-pressed"), "true");
    assert.equal(b.D.setKerbStyle("sausage"), false, "same style is no edit");
    assert.equal(b.D.setKerbStyle("rumble"), true);
    assert.equal(dz(b).kerbStyle, "rumble");
    const berms = q(bank, '[data-role="berms"]');
    assert.deepEqual(kids(berms).map((c) => c.textContent), ["BERMS ON", "BERMS OFF"]);
    assert.equal(berms.children[0]!.getAttribute("aria-pressed"), "true", "berms on by default");
    assert.equal(b.D.setBerms(false), true);
    assert.equal(dz(b).berms, false);
    assert.equal(berms.children[1]!.getAttribute("aria-pressed"), "true");
    assert.equal(b.D.setBerms(false), false);
    assert.equal(b.D.undo(), true);
    assert.equal(dz(b).berms, undefined, "undo restores default (absent = ON)");
    assert.equal(b.D.undo(), true);
    assert.equal(dz(b).kerbStyle, "sausage");
  });

  it("HOWTO elevation step names bank, kerb styles and berms", () => {
    const b = bootScreen();
    const elev = b.D.HOWTO.STEPS.find((s) => s.title === "Elevation")!;
    assert.ok(elev, "Elevation step exists");
    assert.match(elev.text, /BANK/i);
    assert.match(elev.text, /sausage/i);
    assert.match(elev.text, /rumble/i);
    assert.match(elev.text, /BERMS/i);
  });

  it("SCENERY props palette: place at selected point, remove last, caps, UNDO, save keeps props", () => {
    const b = bootScreen();
    openGreen(b);
    b.D.setMode("scenery");
    const Pr = TrackDesignerProps;
    const chips = walk(b.root).filter((e) => e.dataset && e.dataset.prop);
    assert.equal(chips.map((e) => e.dataset.prop).join(","), Pr.KINDS.join(","), "one chip per kind");
    assert.ok(walk(b.root).find((e) => e.dataset && e.dataset.role === "props"), "props row");
    assert.ok(walk(b.root).find((e) => e.dataset && e.dataset.role === "prop-actions"), "place/remove");
    assert.equal(st(b).propKind, "stand", "default kind");
    assert.equal(b.D.setPropKind("stand"), false, "no-op on the same kind");
    assert.equal(b.D.setPropKind("gantry"), true);
    assert.equal(b.D.setPropKind("stand"), true);
    assert.equal(st(b).propKind, "stand");
    b.D.cyclePoint(1); b.D.cyclePoint(1); b.D.cyclePoint(1);
    const u0 = st(b).undo;
    assert.equal(b.D.placeProp(), true);
    assert.equal(dz(b).props!.length, 1);
    assert.equal(dz(b).props![0]!.kind, "stand");
    assert.equal(st(b).undo, u0 + 1);
    assert.equal(b.D.setPropKind("billboard"), true);
    assert.equal(b.D.placeProp("billboard"), true);
    assert.equal(dz(b).props!.length, 2);
    assert.equal(b.D.removeProp("billboard"), true);
    assert.equal(dz(b).props!.length, 1);
    assert.equal(dz(b).props![0]!.kind, "stand");
    assert.equal(b.D.undo(), true);
    assert.equal(dz(b).props!.length, 2, "UNDO restores the removed board");
    b.D.setPropKind("stand");
    let guard = 0;
    while (b.D.placeProp("stand") && guard++ < 20) { /* fill */ }
    assert.equal(Pr.counts(dz(b).props).stand, Pr.CAPS.stand);
    assert.equal(b.D.placeProp("stand"), false, "at the stand cap");
    const saved = b.D.save() as { ok: boolean; id: string };
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const stored = b.C.get(saved.id)!;
    assert.ok(stored.props && stored.props.length >= 1, "props persist in CustomTracks");
    // apex-26's fromRaw does not copy `scenery` (TODO(lane-scenery)): the closure rides the raw def.
    assert.ok(b.list.find((t) => t.id === saved.id), "the saved def is listed");
    assert.equal(typeof b.C.toRaw(stored).scenery, "function", "saved def still carries scenery");
  });

  it("scenery discovery filters without changing the circuit; atmosphere presets undo atomically", () => {
    const b = bootScreen(); openGreen(b); b.D.setMode("scenery");
    const visible = () => walk(b.root).filter((e) => e.dataset && e.dataset.theme && !e.hidden).map((e) => e.dataset.theme);
    const search = q<HTMLInputElement>(b.root, '[aria-label="Find a scenery theme"]');
    const before = plain(dz(b)), undo = st(b).undo;
    by(b, "category", "night").click();
    assert.deepEqual(visible(), ["desertnight", "marina", "twilight", "stadium"]);
    search.value = "floodlit sand"; fire(search, "input");
    assert.deepEqual(visible(), ["desertnight"], "search includes descriptions and intersects the category");
    search.value = "no matching world"; fire(search, "input");
    assert.deepEqual(visible(), []);
    assert.match(by(b, "role", "theme-results").textContent!, /No themes found/);
    q(b.root, '[aria-label="Clear theme search and filters"]').click();
    assert.equal(visible().length, 30);
    assert.deepEqual(plain(dz(b)), before, "browsing never edits the circuit");
    assert.equal(st(b).undo, undo);
    by(b, "preset", "golden").click();
    assert.deepEqual(plain(dz(b).look), { time: "dusk", trees: "many", crowd: "few" });
    assert.equal(st(b).undo, undo + 1);
    assert.equal(by(b, "preset", "golden").getAttribute("aria-pressed"), "true");
    by(b, "preset", "golden").click();
    assert.equal(st(b).undo, undo + 1, "reapplying the same preset is a no-op");
    b.D.undo(); assert.deepEqual(plain(dz(b)), before);
    by(b, "preset", "race").click();
    assert.equal(dz(b).look!.time, "night");
    assert.equal(dz(b).look!.crowd, "packed");
    by(b, "preset", "default").click();
    assert.equal(dz(b).look, undefined, "default stays compatible with old designs");
  });

  it("prop inspector places on either side, clamps gaps, removes exactly one object and round-trips", async () => {
    const b = bootScreen(); openGreen(b); b.D.setMode("scenery");
    by(b, "side", "-1").click();
    q(b.root, '[aria-label="ROADSIDE GAP m up"]').click();
    assert.equal(b.D.placeProp(), true);
    assert.equal(dz(b).props![0]!.side, -1);
    assert.equal(dz(b).props![0]!.gap, 20);
    b.D.setPropKind("billboard"); by(b, "side", "1").click(); b.D.placeProp();
    assert.equal(dz(b).props![1]!.side, 1);
    assert.equal(dz(b).props![1]!.gap, 9, "each kind keeps its own spacing");
    for (let i = 0; i < 8; i++) q(b.root, '[aria-label="ROADSIDE GAP m down"]').click();
    b.D.placeProp(); assert.equal(dz(b).props![2]!.gap, 6, "matches the renderer clearance floor");
    const original = plain(dz(b).props!);
    q(b.root, '[aria-label="Remove placed stand 1"]').click();
    assert.deepEqual(plain(dz(b).props), original.slice(1));
    assert.equal(b.D.removeProp("stand"), false, "missing kind never removes a different prop");
    b.D.undo(); assert.deepEqual(plain(dz(b).props), original);
    const decoded = await TrackCodec.decode(await b.D.shareCode());
    assert.equal(decoded.ok, true);
    assert.deepEqual(plain((decoded as { design: Design }).design.props), original);
    const saved = b.D.save() as { ok: boolean; id: string }; assert.equal(saved.ok, true);
    assert.deepEqual(plain(b.C.get(saved.id)!.props), original);
    b.D.setPropKind("gantry");
    assert.equal(by(b, "role", "prop-side").hidden, true);
    assert.equal(by(b, "role", "prop-gap").hidden, true, "gantries span the road");
    b.D.placeProp(); assert.equal(dz(b).props!.at(-1)!.gap, 0);
  });

  it("scenery sections are navigable without edits; paired section placement and object edits undo atomically", () => {
    const b = bootScreen(); openGreen(b); b.D.setMode("scenery");
    const undo = st(b).undo;
    const themes = by(b, "scenerySection", "themes"), atmosphere = by(b, "scenerySection", "atmosphere"), objects = by(b, "scenerySection", "objects");
    assert.equal(themes.getAttribute("aria-selected"), "true");
    assert.equal(by(b, "role", "prop-inspector").hidden, true);
    key(themes, "ArrowRight");
    assert.equal(atmosphere.getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, atmosphere);
    objects.click();
    assert.equal(by(b, "role", "prop-inspector").hidden, false);
    assert.equal(by(b, "role", "atmosphere").hidden, true);
    assert.equal(st(b).undo, undo, "tab navigation never changes the design");
    by(b, "preset", "festival").click();
    assert.deepEqual(plain(dz(b).look), { time: "dusk", trees: "many", crowd: "packed" });
    b.D.undo();
    b.D.setPropKind("hedge"); b.D.selectRange(dz(b).pts.length - 8, 8);
    by(b, "placementMode", "range").click(); by(b, "side", "0").click();
    assert.equal(b.D.placeProp(), true);
    const placed = plain(dz(b).props!);
    assert.equal(placed.length, 6); assert.equal(st(b).undo, undo + 1);
    assert.deepEqual(placed.map((p) => p.side), [-1, 1, -1, 1, -1, 1]);
    assert.equal(b.D.placeProp(), false, "a whole over-cap row is refused");
    assert.equal(st(b).undo, undo + 1);
    q(b.root, '[aria-label="Edit placed hedge 1"]').click();
    assert.equal(by(b, "role", "prop-editor").hidden, false);
    const lap = q<HTMLInputElement>(b.root, '[aria-label="Placed object lap percentage"]'); lap.value = "35";
    const gap = q<HTMLInputElement>(b.root, '[aria-label="Placed object roadside gap in metres"]'); gap.value = "22";
    walk(by(b, "role", "prop-editor")).find((e) => e.tagName === "BUTTON" && e.textContent === "APPLY")!.click();
    assert.ok(Math.abs(dz(b).props![0]!.s - 0.35) < 1e-4);
    assert.equal(dz(b).props![0]!.gap, 22);
    assert.deepEqual(plain(dz(b).props!.slice(1)), placed.slice(1));
    b.D.undo(); assert.deepEqual(plain(dz(b).props), placed);
    b.D.undo(); assert.equal(dz(b).props, undefined);
    by(b, "placementMode", "point").click(); by(b, "side", "1").click(); b.D.setPropKind("palms");
    b.D.placeProp(); b.D.selectRange(12); assert.equal(b.D.copyPropAt(0), true);
    assert.equal(dz(b).props!.length, 2);
    assert.notEqual(dz(b).props![0]!.s, dz(b).props![1]!.s);
    b.D.undo(); assert.equal(dz(b).props!.length, 1);
    b.D.close();
  });

  it("object categories, numeric gap and section swap are preferences; new objects undo and save", () => {
    const b = bootScreen(); openGreen(b); b.D.setMode("scenery");
    const undo = st(b).undo;
    by(b, "objectCategory", "nature").click();
    assert.equal(by(b, "prop", "pines").hidden, false); assert.equal(by(b, "prop", "marshal").hidden, true);
    by(b, "prop", "pines").click();
    const gap = q<HTMLInputElement>(b.root, '[aria-label="Roadside gap in metres"]');
    gap.value = "33"; fire(gap, "change");
    b.D.selectRange(4, 16); by(b, "placementMode", "range").click();
    q(b.root, '[aria-label="Swap scenery section start and end"]').click();
    assert.equal(st(b).sel, 16); assert.equal(st(b).span, 4);
    assert.equal(st(b).undo, undo, "browsing and placement preferences do not create edits");
    b.D.placeProp(); assert.equal(dz(b).props!.length, 3);
    assert.ok(dz(b).props!.every((p) => p.kind === "pines" && p.gap === 33));
    const saved = b.D.save() as { ok: boolean; id: string }; assert.equal(saved.ok, true); assert.equal(b.C.get(saved.id)!.props!.length, 3);
    b.D.undo(); assert.equal(dz(b).props, undefined);
    gap.value = "1"; fire(gap, "change"); assert.equal(gap.value, "20");
    q(b.root, '[aria-label="Reset roadside gap for selected object"]').click(); assert.equal(gap.value, "28");
    by(b, "objectCategory", "venue").click();
    assert.equal(by(b, "prop", "pines").hidden, true); assert.equal(by(b, "prop", "marshal").hidden, false);
    by(b, "prop", "marshal").click(); by(b, "placementMode", "point").click(); b.D.placeProp();
    assert.equal(dz(b).props![0]!.kind, "marshal");
    b.D.close();
  });

  it("SCENERY props: REVERSE / START HERE remap s; RANDOMISE clears props", () => {
    const b = bootScreen();
    openGreen(b);
    b.D.setMode("scenery");
    b.D.cyclePoint(1); b.D.cyclePoint(1); b.D.cyclePoint(1);
    assert.ok(st(b).sel > 0);
    assert.equal(b.D.placeProp("stand"), true);
    const s0 = dz(b).props![0]!.s;
    const expectFlip = ((1 - s0) % 1 + 1) % 1;
    assert.equal(b.D.reverse(), true);
    const sRev = dz(b).props![0]!.s;
    assert.ok(Math.abs(sRev - expectFlip) < 1e-6, "REVERSE flips prop s: " + s0 + " → " + sRev + " (want " + expectFlip + ")");
    const pts = dz(b).pts;
    const N = pts.length;
    const iStart = Math.floor(N / 3);
    let L = 0, upto = 0;
    for (let k = 0; k < N; k++) { const a = pts[k]!, c = pts[(k + 1) % N]!; const d = Math.hypot(c[0] - a[0], c[1] - a[1]); if (k < iStart) upto += d; L += d; }
    const f = L ? upto / L : 0;
    const expectStart = ((sRev - f) % 1 + 1) % 1;
    assert.equal(b.D.setStart(iStart), true);
    const sStart = dz(b).props![0]!.s;
    assert.ok(Math.abs(sStart - expectStart) < 1e-6, "START HERE remaps prop s: " + sRev + " → " + sStart + " (want " + expectStart + ")");
    const delAt = Math.min(2, dz(b).pts.length - 1);
    assert.equal(b.D.deletePoint(delAt), true);
    assert.ok(dz(b).props && dz(b).props!.length === 1, "delete keeps the prop");
    assert.notEqual(dz(b).props![0]!.s, sStart, "delete remaps prop s away from the pre-delete fraction");
    assert.equal(b.D.randomise(42), true);
    assert.equal(dz(b).props, undefined, "RANDOMISE clears props");
  });

  it("map ranges have immediate LOWER / RAISE controls in EDIT; offsets preserve hills, limits, selection and undo", () => {
    const b = bootHooked(); openGreen(b);
    const n = dz(b).pts.length;
    const heights = Array.from({ length: n }, (_, i) => i % 4);
    b.D.setHeights(heights, 0); b.D.setMode("edit"); b.D.setSelectionMode("range");
    const box = walk(b.root).find((e) => e.dataset.role === "selection-height")!;
    const raise = q(box, '[aria-label="Raise selected points"]');
    const lower = q(box, '[aria-label="Lower selected points"]');
    const amount = q<HTMLInputElement>(box, "input");
    const rail = q(b.root, ".td-rail");
    let top = 0; Object.defineProperty(rail, "scrollTop", { get: () => top, set: (v: number) => { top = v; }, configurable: true });
    rail.scrollTop = 900;
    b.hooks.onSelect!(n - 2, 1);
    assert.equal(rail.scrollTop, 0, "map selection reveals height controls");
    assert.equal(box.hidden, false);
    assert.match(box.children[0]!.textContent!, /HEIGHT CHANGE \(m\) · 4 POINTS/);
    amount.value = "2.5"; fire(amount, "change");
    const before = plain(st(b)); raise.click();
    let after = plain(st(b));
    assert.equal(after.mode, "edit"); assert.equal(after.selectionMode, "range");
    assert.deepEqual([after.sel, after.span], [n - 2, 1]);
    assert.equal(after.undo, before.undo + 1);
    for (let i = 0; i < n; i++) assert.equal(after.design!.heights[i], heights[i]! + (i >= n - 2 || i <= 1 ? 2.5 : 0));
    assert.equal(after.elevationHeat, true);
    b.D.undo(); assert.deepEqual(plain(dz(b).heights), heights);
    b.D.selectRange(n - 2, 1); lower.click();
    for (let i = 0; i < n; i++) assert.equal(dz(b).heights[i], heights[i]! - (i >= n - 2 || i <= 1 ? 2.5 : 0));
    const limit = CustomTracksMod.LIMITS.rise;
    const high = heights.slice(); high[0] = limit - 1; high[1] = limit - 4;
    b.D.setHeights(high, 0); b.D.selectRange(0, 1);
    amount.value = "5"; fire(amount, "change"); raise.click();
    after = plain(st(b));
    assert.equal(after.design!.heights[0], limit); assert.equal(after.design!.heights[1], limit - 3, "whole group stops together");
    raise.click(); assert.equal(st(b).undo, after.undo, "at limit is a no-op");
    b.D.selectRange(-1, -1); assert.equal(box.hidden, true);
  });

  it("SELECT END arms a touch-friendly span; stamp REPLACE uses it; group elev offsets the span", () => {
    const b = bootHooked();
    openGreen(b);
    const end = chipsIn(b.root, "SELECT END")[0]!;
    assert.ok(end, "SELECT END chip in 4 DETAILS");
    assert.equal(end.disabled, true, "disabled with no selection");
    b.hooks.onPick!(4, {});
    assert.equal(b.D.armSpanEnd(), true);
    assert.equal(st(b).spanArm, true);
    b.hooks.onPick!(8, {});
    assert.deepEqual([st(b).sel, st(b).span, st(b).spanArm], [4, 8, false]);
    assert.equal(end.textContent, "SPAN 5–9", "chip names the selected group");
    b.D.setTool("corner");
    assert.ok(chipsIn(b.root, "REPLACE THE SELECTED SPAN")[0], "CORNERS offers REPLACE for the group");
    const pts0 = plain(dz(b).pts);
    assert.equal(b.D.applyStamp(4, 8), true);
    assert.notDeepEqual(plain(dz(b).pts), pts0, "REPLACE rewrites the span");
    assert.equal(b.D.undo(), true, "UNDO the stamp");
    b.D.setTool("select");
    b.hooks.onPick!(5, {});
    b.hooks.onPick!(9, { shiftKey: true });
    assert.deepEqual([st(b).sel, st(b).span], [5, 9]);
    b.D.setMode("elevation");
    const hs0 = plain(dz(b).heights);
    for (let i = 5; i <= 9; i++) assert.equal(hs0[i], 0);
    const seeded = hs0.slice();
    for (let i = 5; i <= 9; i++) seeded[i] = (i - 5);
    assert.equal(b.D.setHeights(seeded, 5), true);
    assert.equal(b.D.setNodeHeight(5, 3), true, "POINT m on a span offsets the group");
    const hs = plain(dz(b).heights);
    for (let i = 5; i <= 9; i++) assert.equal(hs[i], (i - 5) + 3, "point " + i);
    assert.equal(hs[0], 0, "outside the span stays flat");
    assert.deepEqual([st(b).sel, st(b).span], [5, 9], "span selection survives group elev");
  });

  it("POINT m range offsets stop the whole selection at either height bound", () => {
    const b = bootHooked(); openGreen(b);
    for (const sign of [1, -1]) {
      const heights = dz(b).heights.map(() => 0);
      heights[3] = sign * 58; heights[4] = sign * 59;
      b.D.setHeights(heights, 3); b.D.selectRange(3, 4);
      assert.equal(b.D.setNodeHeight(3, sign * 60), true);
      assert.deepEqual(plain(dz(b).heights.slice(3, 5)), [sign * 59, sign * 60]);
      const undoCount = st(b).undo;
      assert.equal(b.D.setNodeHeight(3, sign * 60), false, "limit is a no-op, not a flattened hill");
      assert.equal(st(b).undo, undoCount);
      assert.equal(dz(b).heights[2], 0);
      b.D.undo(); assert.deepEqual(plain(dz(b).heights), heights);
    }
    b.D.close();
  });
});

// ── stale design state must not leak into a NEW loop ────────────────────────
const hilly = (b: Boot, extra?: object) => b.C.sanitize(design(Object.assign({
  pts: ellipse(36, 800, 500),
  heights: ellipse(36).map((_, i) => Math.round(30 * Math.sin(i / 3) * 4) / 4),
  elevations: [{ s: 0.5, halfM: 400, rise: 25 }],
}, extra)))!;
/** The previous design's fraction-keyed edits, a wide road and two props: all of it belongs to the OLD loop. */
function hillyBase(b: Boot) {
  const d = openGreen(b);
  b.D.load(Object.assign(d, plain(ZONES), { baseHW: 8 }));
  b.D.setNodeHeight(3, 9);
  b.D.cyclePoint(1); b.D.placeProp("stand");
  assert.ok(dz(b).props!.length >= 1 && dz(b).hwZones.length === 1, "the base carries the old loop's edits");
  b.D.preview();
}
/** Every design TrackValidate.check is asked about, recorded. */
function spyCheck() {
  const seen: Record<string, unknown>[] = [];
  over.check = (d) => { const x = d as Record<string, unknown>; seen.push(plain({ baseHW: x.baseHW, hwZones: x.hwZones, bankZones: x.bankZones, elevations: x.elevations, bridges: x.bridges, heights: x.heights, props: x.props })); return over.real.check!(d); };
  return seen;
}
const CLEAN = (s: Record<string, unknown>) => Number.isFinite(s.baseHW) && ["hwZones", "bankZones", "elevations", "bridges"].every((k) => !s[k] || !(s[k] as unknown[]).length) && (!s.heights || (s.heights as number[]).every((h) => h === 0)) && !s.props;
/** f1-game bootPersistedScreen: the real store over a serialised localStorage (here localStore, a26. keys). */
function bootPersistedScreen(disk = new Map<string, string>(), opts: { custom?: (c: CustomTracksApi) => CustomTracksApi } = {}) {
  let blocked = false;
  const storage = {
    get length() { return disk.size; }, key: (i: number) => [...disk.keys()][i] ?? null, getItem: (k: string) => disk.get(k) ?? null,
    setItem(k: string, v: string) { if (blocked) { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; } disk.set(k, String(v)); },
    removeItem: (k: string) => { disk.delete(k); }, clear: () => disk.clear(),
  } as Storage;
  const b = bootScreen({}, { store: localStore(storage), ...opts });
  return Object.assign(b, {
    disk,
    blockWrites: (v: boolean) => { blocked = v; },
    // f1-game ran the pending 600 ms draft timer by hand; pagehide runs the same flush (designer.js:1631).
    flushDraft() { window.dispatchEvent(new Event("pagehide")); },
  });
}

describe("track-designer-dom (f1-game): new loops, heights, selection, library", () => {
  it("RANDOMISE · TRACK OF THE DAY · FAST judge a candidate against the look only, never the old loop's elevations", async () => {
    const b = bootScreen();
    b.D.init(b.G, { custom: b.C, root: b.root }); b.D.open();
    b.D.load(hilly(b), "import");
    assert.equal(b.D.randomise(101), true, "RANDOMISE finds a clean loop after an ELEVATION edit");
    const day = "2026-10-09";
    b.D.load(b.C.sanitize(design({ pts: ellipse(36, 800, 500) }))!, "import");
    assert.equal(b.D.trackOfTheDay(day), true);
    const flat = plain(dz(b));
    b.D.load(hilly(b), "import");
    assert.equal(b.D.trackOfTheDay(day), true);
    const rolled = plain(dz(b));
    assert.deepEqual(rolled.pts, flat.pts, "same pts from a hilly start as from a flat one");
    assert.equal(rolled.seed, flat.seed);
    b.D.load(hilly(b), "import");
    assert.equal(await b.D.designed("FAST", 4242), true);
    assert.equal(st(b).candidates.length, 4, "FAST fills four cards from a hilly start");
  });

  it("every action that starts a new loop clears the old loop's zones, bridges, turns and props", async () => {
    const b = bootScreen();
    b.D.init(b.G, { custom: b.C, root: b.root }); b.D.open();
    const stale = () => b.C.sanitize(design({
      pts: ellipse(36, 800, 500),
      hwZones: [{ s0: 0.2, s1: 0.3, hw: 5.5, ease: 0.02 }],
      bankZones: [{ frac: 0.4, angleDeg: 6, widthM: 120 }],
      elevations: [{ s: 0.5, halfM: 300, rise: 6 }],
      bridges: [{ s: 0.8, halfM: 160, rise: 8 }],
      turns: [0.1, 0.4, 0.7],
      props: [{ kind: "stand", s: 0.3, side: 1, gap: 18 }],
    }))!;
    const clean = (what: string) => {
      const d = dz(b);
      assert.deepEqual(plain([d.hwZones, d.bankZones, d.elevations, d.bridges, d.turns]), [[], [], [], [], []], what + ": zone lists empty");
      assert.equal(d.props, undefined, what + ": no authored props");
    };
    b.D.load(stale(), "import"); assert.ok(dz(b).props!.length === 1, "the fixture carries a prop");
    assert.equal(b.D.randomise(101), true); clean("RANDOMISE");
    const path: P[] = [];
    for (let i = 0; i < 160; i++) { const t = i / 160 * Math.PI * 2; path.push([Math.cos(t) * 700, Math.sin(t) * 420 + 60 * Math.sin(3 * t)]); }
    b.D.load(stale(), "import");
    assert.equal(b.D.freehand(path), true); clean("DRAW");
    b.D.load(stale(), "import");
    assert.equal(await b.D.designed("FAST", 4242), true);
    b.D.load(stale(), "import");
    assert.equal(b.D.useCandidate(0), true); clean("USE");
    b.D.load(stale(), "import");
    assert.equal(b.D.startFrom("monza"), true); clean("START FROM");
  });

  it("REVERSE keeps each authored prop on the same bank (its side is relative to the travel direction)", () => {
    const b = bootScreen();
    b.D.init(b.G, { custom: b.C, root: b.root }); b.D.open();
    const pts = ellipse(36, 800, 500), N = pts.length, i = 10;
    const s = TrackDesignerProps.pointFrac(pts, i);
    b.D.load(b.C.sanitize(design({ pts, props: [{ kind: "stand", s, side: 1, gap: 18 }, { kind: "billboard", s: TrackDesignerProps.pointFrac(pts, 20), side: -1, gap: 12 }] }))!, "import");
    const before = plain(dz(b));
    const at = (d: Design, kind: string, k: number) => { const p = d.props!.find((x) => x.kind === kind)!, Pp = d.pts, a = Pp[(k - 1 + N) % N]!, c = Pp[(k + 1) % N]!, tx = c[0] - a[0], tz = c[1] - a[1], m = Math.hypot(tx, tz); return [p.side * tz / m, p.side * -tx / m] as const; };
    assert.equal(b.D.reverse(), true);
    const after = plain(dz(b));
    for (const [kind, k] of [["stand", 10], ["billboard", 20]] as const) {
      const o = at(before, kind, k), r = at(after, kind, N - k);
      assert.ok(o[0] * r[0] + o[1] * r[1] > 0.99, kind + " stays on the same bank after REVERSE: " + o + " vs " + r);
    }
    assert.deepEqual(after.props!.map((p) => p.kind + p.side).sort(), ["billboard1", "stand-1"], "the stored side is flipped with the travel direction");
    const sides = after.props!.map((p) => p.kind + p.side).sort();
    assert.equal(b.D.setStart(5), true);
    assert.deepEqual(dz(b).props!.map((p) => p.kind + p.side).sort(), sides, "START HERE leaves prop sides alone");
  });

  it("an inserted point takes the heights of its neighbours, not 0 m (no notch mid-hill)", () => {
    const b = bootScreen();
    b.D.init(b.G, { custom: b.C, root: b.root }); b.D.open();
    const pts = ellipse(36, 800, 500);
    const heights = pts.map((_, i) => (i === 10 || i === 11 ? 10 : 0));
    b.D.load(b.C.sanitize(design({ pts, heights }))!, "import");
    const d = plain(dz(b));
    b.D.setTool("straight");
    assert.equal(b.D.applyStamp(10, 10), true);
    const h = plain(dz(b).heights), Pp = plain(dz(b).pts);
    assert.equal(h.length, Pp.length);
    const k10 = Pp.findIndex((p) => p[0] === d.pts[10]![0] && p[1] === d.pts[10]![1]);
    assert.equal(h[k10], 10, "the kept point keeps its height");
    assert.ok(h[k10 + 1]! > 0, "the point inserted after a 10 m point is not a 0 m notch: " + h.slice(k10, k10 + 4));
  });

  it("selection controls synchronize both views; elevation edits keep the range and undo once", () => {
    const b = bootScreen(); openGreen(b);
    const before = st(b), n = before.design!.pts.length;
    b.D.setMode("elevation");
    b.D.setSelectionMode("range");
    b.D.selectRange(2, 5);
    const strip = q(b.root, 'canvas[data-role="profile"]');
    assert.match(strip.getAttribute("aria-label")!, /Span 3–6 \(4 points\)/);
    assert.equal(st(b).undo, before.undo, "selection stays outside history");
    const height = walk(b.root).find((e) => e.getAttribute("aria-label") === "Selected point height in metres") as HTMLInputElement;
    b.D.setSelectionMode("point");
    assert.equal(st(b).span, 5, "switching to height dragging retains the group");
    height.value = "3.25";
    key(height, "Enter");
    const raised = st(b);
    assert.equal(raised.undo, before.undo + 1);
    assert.deepEqual([raised.sel, raised.span], [2, 5]);
    for (let i = 0; i < n; i++) assert.equal(raised.design!.heights[i], i >= 2 && i <= 5 ? 3.25 : 0);
    b.D.undo();
    assert.deepEqual(dz(b).heights, before.design!.heights);
    assert.doesNotMatch(strip.getAttribute("aria-label")!, /Span 3–6/, "undo clears selection on both views");
    b.D.selectRange(n - 2, 1);
    b.D.setNodeHeight(n - 2, 2);
    const wrap = dz(b).heights;
    for (let i = 0; i < n; i++) assert.equal(wrap[i], i >= n - 2 || i <= 1 ? 2 : 0, "wrapped range follows driving order");
    b.D.selectRange(-1);
    assert.equal(b.D.adjustElevation("zero"), false, "empty selection cannot edit the whole track");
    b.D.close();
  });

  it("level, smooth and zero affect only selected heights and retain smooth endpoints", () => {
    const b = bootScreen(); openGreen(b);
    const n = dz(b).pts.length, hs = new Array<number>(n).fill(0);
    hs[2] = 2; hs[3] = 10; hs[4] = 2; hs[5] = 4;
    b.D.setHeights(hs); b.D.selectRange(2, 5);
    const undo = st(b).undo;
    assert.equal(b.D.adjustElevation("smooth"), true);
    const out = st(b);
    assert.equal(out.undo, undo + 1);
    assert.deepEqual(plain(out.design!.heights.slice(2, 6)), [2, 6, 4.5, 4]);
    assert.equal(out.design!.heights[1], 0); assert.equal(out.design!.heights[6], 0);
    assert.equal(b.D.adjustElevation("level"), true);
    assert.deepEqual(plain(dz(b).heights.slice(2, 6)), [2, 2, 2, 2]);
    assert.equal(b.D.adjustElevation("zero"), true);
    assert.ok(dz(b).heights.every((h) => h === 0));
    assert.equal(b.D.adjustElevation("zero"), false, "no-op does not add undo");
    b.D.close();
  });

  it("deleting the start point retains every surviving point's elevation, with undo", () => {
    const b = bootScreen(); const d = openGreen(b);
    d.heights = d.pts.map((_, i) => i / 4);
    b.D.load(d); b.D.deletePoint(0);
    assert.deepEqual(plain(dz(b).heights), d.heights.slice(1));
    assert.deepEqual(plain(dz(b).pts), d.pts.slice(1));
    b.D.undo(); assert.deepEqual(plain(dz(b).heights), d.heights);
    b.D.close();
  });

  it("dragging an interior elevation grip keeps both ends of the selected span", () => {
    const b = bootScreen(); const d = openGreen(b);
    b.D.setMode("elevation"); b.D.selectRange(2, 8); b.D.setSelectionMode("point");
    const strip = q(b.root, 'canvas[data-role="profile"]');
    const pts = d.pts, c = [0];
    for (let i = 0; i < pts.length; i++) c.push(c[i]! + Math.hypot(pts[(i + 1) % pts.length]![0] - pts[i]![0], pts[(i + 1) % pts.length]![1] - pts[i]![1]));
    const x = c[5]! / c[pts.length]! * 640;
    for (const [type, y] of [["pointerdown", 200], ["pointermove", 150], ["pointerup", 150]] as const) {
      fire(strip, type, { pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y });
    }
    assert.deepEqual([st(b).sel, st(b).span], [2, 8]);
    const h = dz(b).heights;
    assert.ok(h[5]! > 0); assert.equal(h[2], h[5]); assert.equal(h[8], h[5]); assert.equal(h[1], 0);
    b.D.close();
  });

  it("save after undo and redo replaces the current library record without duplicating", () => {
    const b = bootScreen(); openGreen(b);
    const first = b.D.save() as { ok: boolean; id: string }; assert.equal(first.ok, true);
    b.D.setWidth(6); b.D.preview(); const second = b.D.save() as { ok: boolean; id: string };
    assert.equal(second.ok, true); assert.notEqual(second.id, first.id);
    b.D.undo(); b.D.preview(); const restored = b.D.save() as { id: string };
    assert.equal(restored.id, first.id); assert.deepEqual(plain(st(b).library), [first.id]);
    b.D.redo(); b.D.preview(); const redone = b.D.save() as { id: string };
    assert.equal(redone.id, second.id); assert.deepEqual(plain(st(b).library), [second.id]);
    b.D.close();
  });

  it("MY CIRCUITS collection controls import atomically and leave the working draft intact", async () => {
    const b = bootScreen(); openGreen(b);
    assert.deepEqual(kids(walk(b.root).find((e) => e.dataset.role === "library-files")).map((e) => e.textContent), ["RECOVER PREVIOUS DRAFT", "EXPORT ALL", "IMPORT LIBRARY"]);
    const draft = plain(dz(b)), envelope = { format: b.C.COLLECTION_FORMAT, v: 1, items: [draft] };
    assert.equal(await b.D.importLibraryFile({ size: 1000, text: async () => JSON.stringify(envelope) }), true);
    assert.match(msgText(b)!, /Nothing imported yet/); assert.equal(b.C.list().length, 0);
    assert.equal(b.D.commitLibraryImport(), true);
    assert.match(msgText(b)!, /Imported 1 circuits/); assert.equal(b.C.list().length, 1);
    assert.deepEqual(plain(dz(b)), draft);
    let exported: { name: string; data: { format: string; items: unknown[] } } | null = null;
    b.deps.nativeDownload = { viable: () => true, saveBlob: async (blob: Blob, name: string) => { exported = { name, data: JSON.parse(await blob.text()) }; } };
    assert.equal(await b.D.exportLibraryFile(), true);
    assert.equal(exported!.name, "apex26-circuits.apextracks.json");
    assert.equal(exported!.data.format, b.C.COLLECTION_FORMAT); assert.equal(exported!.data.items.length, 1);
    assert.equal(await b.D.loadFrom(JSON.stringify(envelope)), true);
    assert.equal(b.D.commitLibraryImport(), true);
    assert.match(msgText(b)!, /Imported 0 circuits.*1 duplicates/);
    assert.equal(await b.D.importLibraryFile({ size: 1000, text: async () => JSON.stringify({ ...envelope, items: [draft, { pts: [] }] }) }), false);
    assert.match(msgText(b)!, /Circuit 2 failed validation.*Nothing imported/); assert.equal(b.C.list().length, 1);
    assert.equal(await b.D.importLibraryFile({ size: 2000000, text: async () => { throw new Error("must not read"); } }), false);
    assert.match(msgText(b)!, /too large/);
    b.store.write = () => ({ ok: false, durable: false });
    assert.equal(await b.D.loadCollection({ ...envelope, items: [{ ...draft, seed: 17 }] }), true);
    assert.equal(b.D.commitLibraryImport(), false);
    assert.match(msgText(b)!, /Library storage write failed.*Nothing imported/);
    assert.equal(b.C.list().length, 1); assert.deepEqual(plain(dz(b)), draft);
    b.D.close();
  });

  it("first-save history keeps its library identity without linking another imported document", () => {
    const b = bootScreen(); openGreen(b);
    b.D.setWidth(6); b.D.preview(); const first = b.D.save() as { id: string };
    b.D.undo(); b.D.preview(); const restored = b.D.save() as { ok: boolean; id: string };
    assert.equal(restored.ok, true); assert.notEqual(restored.id, first.id);
    assert.deepEqual(plain(st(b).library), [restored.id], "pre-first-save undo replaces, rather than adds");
    b.D.setName("MY UNSAVED LABEL");
    const imported = { ...dz(b), seed: 876543, name: "OTHER DOCUMENT" };
    b.D.load(imported, "import"); b.D.preview(); const other = b.D.save() as { ok: boolean; id: string };
    assert.equal(other.ok, true); assert.equal(b.C.list().length, 2);
    b.D.undo(); b.D.preview(); const back = b.D.save() as { id: string };
    assert.equal(back.id, restored.id); assert.equal(b.C.list().length, 2);
    assert.equal(b.C.get(other.id)!.name, "OTHER DOCUMENT", "saving the restored document does not replace the imported one");
    assert.equal(b.C.get(restored.id)!.name, "MY UNSAVED LABEL");
    b.D.close();
  });

  it("SAVE persists the current library identity across reload, even with 24 circuits", () => {
    for (const count of [1, 24]) {
      const b = bootPersistedScreen();
      b.D.init(b.G, { custom: b.C, root: b.root });
      b.D.open({ design: design() }); b.D.preview();
      const first = b.D.save() as { durable: boolean; id: string }; assert.equal(first.durable, true);
      for (let i = 1; i < count; i++) assert.equal(b.C.upsert(design({ seed: 100 + i })).ok, true);
      b.D.setWidth(7.5); b.D.preview(); b.flushDraft();
      assert.equal(JSON.parse(b.disk.get("a26.customTrackDraft")!).originId, first.id);
      const saved = b.D.save() as { durable: boolean; id: string }; assert.equal(saved.durable, true); assert.notEqual(saved.id, first.id);
      const draft = JSON.parse(b.disk.get("a26.customTrackDraft")!);
      assert.equal(draft.id, saved.id); assert.equal(draft.originId, saved.id);
      const restored = bootPersistedScreen(new Map(b.disk));
      restored.D.init(restored.G, { custom: restored.C, root: restored.root });
      restored.D.open(); restored.D.setWidth(8); restored.D.preview();
      const edited = restored.D.save() as { ok: boolean; id: string }; assert.equal(edited.ok, true, JSON.stringify(edited));
      assert.equal(restored.C.list().length, count, "reload edits replace rather than duplicate");
      assert.equal(restored.C.get(saved.id), null);
      assert.equal(restored.C.get(edited.id)!.baseHW, 8);
      b.D.close(); restored.D.close();
    }
  });

  it("SAVE preserves its nondurable warning and retries the draft identity when storage recovers", () => {
    const b = bootPersistedScreen();
    b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.open({ design: design() }); b.D.preview();
    const first = b.D.save() as { durable: boolean; id: string }; assert.equal(first.durable, true);
    b.D.setWidth(7.5); b.D.preview(); b.flushDraft();
    const before = b.disk.get("a26.customTrackDraft");
    b.blockWrites(true);
    const failedDisk = b.D.save() as { ok: boolean; durable: boolean; id: string };
    assert.equal(failedDisk.ok, true); assert.equal(failedDisk.durable, false);
    assert.match(msgText(b)!, /storage is full.*may not survive a reload/);
    assert.equal(dz(b).originId, failedDisk.id, "the session keeps its edited circuit");
    assert.equal(b.disk.get("a26.customTrackDraft"), before, "failed disk writes do not change persisted identity");
    assert.equal(JSON.parse(b.disk.get("a26.customTracks")!).items[0].id, first.id);
    b.blockWrites(false);
    assert.equal((b.D.save() as { durable: boolean }).durable, true);
    assert.equal(JSON.parse(b.disk.get("a26.customTrackDraft")!).originId, failedDisk.id);
    // localStore keeps GameStore's write-through cache, so the retry replaces the refused write's entry.
    assert.equal(JSON.parse(b.disk.get("a26.customTracks")!).items[0].id, failedDisk.id);
    b.D.close();
  });

  it("a refused SAVE leaves the draft's persisted library identity unchanged", () => {
    let refuse = false;
    const b = bootPersistedScreen(undefined, { custom: (C) => ({ ...C, upsert: ((d: unknown, o?: { replace?: string | null } | null) => (refuse ? { ok: false, reason: "write", id: "refused-id" } : C.upsert(d, o))) as CustomTracksApi["upsert"] }) });
    b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.open({ design: design() }); b.D.preview(); const first = b.D.save() as { id: string };
    b.D.setWidth(7.5); b.D.preview(); b.flushDraft();
    const before = b.disk.get("a26.customTrackDraft");
    refuse = true;
    assert.equal(b.D.save().ok, false);
    assert.equal(dz(b).originId, first.id);
    assert.equal(b.disk.get("a26.customTrackDraft"), before);
    assert.equal(b.C.list().length, 1); assert.ok(b.C.get(first.id));
    b.D.close();
  });

  it("an autosaved draft of an oversize loop is rejected on open instead of freezing the tab (13-F1)", () => {
    const pts: P[] = [];
    for (let i = 0; i < 40; i++) pts.push(i % 2 ? [-9000 + (i % 7) * 100, 9000 - i * 10] : [9000 - (i % 5) * 100, -9000 + i * 10]);
    const b = bootScreen({ customTrackDraft: { name: "HOSTILE", seed: 7, theme: "parkland", baseHW: 7, pts } });
    b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.open();
    const s = st(b);
    assert.ok(s.design && s.design.name !== "HOSTILE", "the oversize draft was not restored");
    const per = s.design.pts.reduce((acc, p, i) => { const q2 = s.design!.pts[(i + 1) % s.design!.pts.length]!; return acc + Math.hypot(q2[0] - p[0], q2[1] - p[1]); }, 0);
    assert.ok(per <= b.C.LIMITS.loopMaxLoose, "the opened design is a sane loop: " + Math.round(per) + " m");
  });

  it("DELETE POINT 0 and a stamp over the start line keep every surviving point's own height (13-F2)", () => {
    const b = bootScreen();
    const green = openGreen(b);
    assert.equal(b.D.applyElevPreset("hilly"), true);
    const d0 = plain(dz(b));
    assert.ok(d0.heights.filter(Boolean).length > 10, "the hilly preset left real heights to misalign");
    const keyOf = (p: readonly number[]) => p[0] + "," + p[1];
    const bad = (bef: Design, aft: Design) => {
      const m = new Map(bef.pts.map((p, i) => [keyOf(p), bef.heights[i]]));
      return aft.pts.filter((p, i) => m.has(keyOf(p)) && m.get(keyOf(p)) !== aft.heights[i]).length;
    };
    assert.equal(b.D.deletePoint(0), true);
    const d1 = plain(dz(b));
    assert.notDeepEqual(d1.pts[0], d0.pts[0], "the start point itself was deleted");
    assert.equal(bad(d0, d1), 0, "DELETE POINT 0: no survivor carries its neighbour's height");
    b.D.undo();
    const N = dz(b).pts.length, before = plain(dz(b));
    b.D.setTool("corner");
    assert.equal(b.D.applyStamp(N - 2, 2, "corner"), true, "a stamp whose span wraps the start line");
    const after = plain(dz(b));
    assert.ok(after.pts.filter((p) => before.pts.some((q2) => keyOf(q2) === keyOf(p))).length > 20, "plenty of shared points to check");
    assert.equal(bad(before, after), 0, "wrapping stamp: heights stay keyed to their points");
    assert.equal(green.pts.length > 0, true);
  });

  it("RANDOMISE judges candidates on a clean base: the same seed gives the same loop on a hilly and a flat base, and the fresh loop carries none of the old edits", () => {
    const flat = bootScreen(), hillyB = bootScreen();
    openGreen(flat); hillyBase(hillyB);
    assert.equal(flat.D.randomise(11), true);
    const seenHilly = spyCheck();
    assert.equal(hillyB.D.randomise(11), true);
    assert.deepEqual(plain(dz(hillyB).pts), plain(dz(flat).pts), "TRACK OF THE DAY: a seed means one loop, whatever the player had open");
    assert.ok(seenHilly.length >= 1 && seenHilly.every(CLEAN), "every candidate was judged flat: " + JSON.stringify(seenHilly.find((s) => !CLEAN(s))));
    const d = dz(hillyB);
    assert.deepEqual(plain([d.hwZones, d.bankZones, d.elevations, d.bridges, d.turns]), [[], [], [], [], []], "fraction-keyed edits of the old loop are gone");
    assert.equal(d.props, undefined); assert.ok(Number.isFinite(d.baseHW), "committed on the width it was judged on");
    assert.ok(d.heights.every((h) => h === 0));
  });

  it("DESIGNED, USE and MORE LIKE THIS judge on a clean base and USE commits a fresh loop; DRAW and START FROM clear the old loop's edits", async () => {
    const flat = bootScreen(), hillyB = bootScreen();
    openGreen(flat); hillyBase(hillyB);
    assert.equal(await flat.D.designed("FAST", 21), true);
    const seen = spyCheck();
    assert.equal(await hillyB.D.designed("FAST", 21), true);
    assert.deepEqual(plain(st(hillyB).candidates), plain(st(flat).candidates), "the same seeds give the same cards on either base");
    assert.ok(seen.length >= 16 && seen.every(CLEAN), "designed(): every check was on the clean base: " + seen.length + " " + JSON.stringify(seen.find((s) => !CLEAN(s))));
    seen.length = 0;
    assert.equal(await hillyB.D.moreLikeThis(0), true);
    assert.ok(seen.length >= 1 && seen.every(CLEAN), "moreLikeThis(): every check was on the clean base");
    over.check = null;
    assert.equal(hillyB.D.useCandidate(0), true);
    let d = dz(hillyB);
    assert.deepEqual(plain([d.hwZones, d.bankZones, d.elevations, d.bridges, d.turns]), [[], [], [], [], []]);
    assert.equal(d.props, undefined); assert.ok(Number.isFinite(d.baseHW));
    hillyBase(hillyB);
    assert.equal(hillyB.D.startFrom("monza"), true);
    d = dz(hillyB);
    assert.equal(d.props, undefined, "START FROM clears the old loop's props");
    assert.deepEqual(plain([d.hwZones, d.bankZones, d.elevations, d.bridges]), [[], [], [], []]);
    hillyBase(hillyB);
    const path: P[] = [];
    for (let i = 0; i < 160; i++) { const t = i / 160 * Math.PI * 2; path.push([Math.cos(t) * 700, Math.sin(t) * 420 + 60 * Math.sin(3 * t)]); }
    assert.equal(hillyB.D.freehand(path), true);
    d = dz(hillyB);
    assert.deepEqual(plain([d.hwZones, d.bankZones, d.elevations, d.bridges, d.turns]), [[], [], [], [], []], "DRAW clears the old loop's zones and bridges");
    assert.equal(d.props, undefined);
  });
});

describe("track-designer-dom (f1-game): ownership, lifecycle, follow-ups", () => {
  it("export uses one snapshot while edits and replacements continue", async () => {
    const b = bootScreen(); b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.load(design({ name: "BEFORE" }));
    let finish: ((v: string | null) => void) | null = null; let encoded: unknown = null;
    over.encode = (item) => { encoded = plain(item); return new Promise((resolve) => { finish = resolve; }); };
    const pending = b.D.exportEnvelope();
    b.D.setName("AFTER"); b.D.load(design({ name: "REPLACEMENT", pts: ellipse(400, 250) }));
    finish!(await over.real.encode!(encoded));
    const env = (await pending)!;
    assert.equal(env.design.name, "BEFORE");
    assert.deepEqual(plain(env.design.pts), (encoded as Design).pts);
    over.encode = null;
    const back = await TrackCodec.decode(env.code) as { design: Design };
    assert.deepEqual(plain(back.design.pts), (encoded as Design).pts);
    assert.equal(back.design.name, env.design.name);
    b.D.close();
  });

  it("hidden-page lifecycle flushes a pending draft before its debounce", () => {
    const b = bootScreen(); b.D.init(b.G, { custom: b.C, root: b.root });
    b.D.load(design()); b.D.setName("LAST EDIT");
    let flushes = 0; (b.store as EditorStore & { mirrorFlush?: () => void }).mirrorFlush = () => { flushes++; };
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      assert.equal((b.C.draft() as Design).name, "LAST EDIT"); assert.equal(flushes, 1);
      document.dispatchEvent(new Event("visibilitychange")); assert.equal(flushes, 1);
    } finally { delete (document as unknown as Record<string, unknown>).visibilityState; }
    b.D.close();
  });

  it("newer imports and manual edits supersede pending decodes", async () => {
    const b = bootScreen(); b.D.init(b.G, { custom: b.C, root: b.root }); b.D.load(design());
    const completions = new Map<string, (v: unknown) => void>();
    over.decode = (code) => new Promise((resolve) => completions.set(code as string, resolve));
    const old = b.D.loadFrom("old"), latest = b.D.loadFrom("latest");
    completions.get("latest")!({ ok: true, design: design({ name: "LATEST" }) }); assert.equal(await latest, true);
    completions.get("old")!({ ok: false, reason: "old failure" }); assert.equal(await old, false);
    assert.equal(dz(b).name, "LATEST");
    const edited = b.D.loadFrom("edited"); b.D.setName("MANUAL");
    completions.get("edited")!({ ok: true, design: design({ name: "STALE" }) }); assert.equal(await edited, false);
    assert.equal(dz(b).name, "MANUAL"); b.D.close();
  });

  it("designer tabs link panels and use one tab stop with wrapping arrows, Home and End", () => {
    const b = bootScreen(); openGreen(b);
    const tabs = walk(b.root).filter((e) => e.classList.contains("td-tab"));
    for (const t of tabs) {
      const panel = walk(b.root).find((e) => e.id === t.getAttribute("aria-controls"))!;
      assert.ok(panel); assert.equal(panel.getAttribute("aria-labelledby"), t.id);
    }
    assert.deepEqual(tabs.map((t) => t.tabIndex), [0, -1, -1]);
    key(tabs[0]!, "ArrowLeft"); assert.equal(document.activeElement, tabs[2]);
    assert.deepEqual(tabs.map((t) => t.tabIndex), [-1, -1, 0]);
    key(tabs[2]!, "Home"); assert.equal(document.activeElement, tabs[0]);
    key(tabs[0]!, "End"); assert.equal(document.activeElement, tabs[2]);
    key(tabs[2]!, "ArrowRight"); assert.equal(document.activeElement, tabs[0]);
    tabs[1]!.click(); assert.deepEqual(tabs.map((t) => t.tabIndex), [-1, 0, -1]);
    b.D.close();
  });

  it("imported clearance and copy/move destination labels match effective placement", () => {
    const b = bootScreen(), d = openGreen(b); d.props = [{ kind: "stand", s: 0.2, side: 1, gap: 0 }]; b.D.load(d); b.D.setMode("scenery");
    const list = walk(b.root).find((e) => e.dataset.role === "object-list")!; assert.match(followupText(list), /14 m \(stored 0 m\)/);
    q(b.root, '[aria-label="Edit placed stand 1"]').click();
    const move = chipsIn(b.root, "MOVE · SELECT DESTINATION")[0]!, cp = chipsIn(b.root, "COPY · SELECT DESTINATION")[0]!;
    assert.equal(move.disabled, true); assert.equal(cp.disabled, true); const u = st(b).undo;
    assert.equal(b.D.copyPropAt(0), false); assert.equal(st(b).undo, u);
    b.D.selectRange(3); assert.equal(move.textContent, "MOVE TO POINT 4"); assert.equal(cp.getAttribute("aria-label"), "COPY TO POINT 4");
    assert.equal(move.disabled, false); assert.equal(cp.disabled, false); b.D.close();
  });

  it("recipe preview/cancel preserve history; whole mixed recipe applies and undoes once", () => {
    const b = bootScreen(); const d = openGreen(b); b.D.setMode("scenery"); b.D.selectRange(3, 8);
    const u = st(b).undo; chipsIn(b.root, "PREVIEW MARSHAL + CAMERA")[0]!.click();
    assert.equal(st(b).undo, u); assert.deepEqual(plain(dz(b)), d);
    assert.match(followupText(walk(b.root).find((e) => e.dataset.role === "scenery-recipes")!), /2 objects/);
    chipsIn(b.root, "CANCEL RECIPE")[0]!.click(); assert.equal(st(b).undo, u);
    chipsIn(b.root, "PREVIEW MARSHAL + CAMERA")[0]!.click(); chipsIn(b.root, "APPLY RECIPE")[0]!.click();
    assert.deepEqual(plain(dz(b).props!.map((p) => p.kind)), ["marshal", "camera"]); assert.equal(st(b).undo, u + 1);
    b.D.undo(); assert.deepEqual(plain(dz(b)), d);
    b.D.selectRange(3, 8); chipsIn(b.root, "PREVIEW HEDGE SECTION")[0]!.click(); chipsIn(b.root, "APPLY RECIPE")[0]!.click();
    assert.equal(dz(b).props!.length, 3); assert.equal(st(b).undo, u + 1); b.D.undo(); b.D.close();
  });

  it("repair comparison cancels without edits and refuses a changed base before apply", () => {
    let green: Design | null = null;
    over.fixes = { canFix: (it) => (it as { code: string }).code === "length", apply: (d) => ({ design: { ...(d as object), pts: green!.pts }, msg: "length" }), fixAll: () => null };
    const b = bootScreen();
    green = shortLoop(b); const d = plain(dz(b)), u = st(b).undo;
    const preview = () => chipsIn(q(b.root, '[aria-label="Design checks"]'), "FIX")[0]!.click();
    preview(); const panel = walk(b.root).find((e) => e.dataset.role === "repair-preview")!;
    assert.equal(panel.hidden, false); assert.match(followupText(panel), /CURRENT · BLOCKED/); assert.match(followupText(panel), /PROPOSED · PASS/);
    chipsIn(b.root, "CANCEL REPAIR")[0]!.click(); assert.deepEqual(plain(dz(b)), d); assert.equal(st(b).undo, u);
    preview(); b.D.setName("Changed"); chipsIn(b.root, "APPLY REPAIR")[0]!.click();
    assert.equal(st(b).undo, u); assert.equal(dz(b).name, "CHANGED"); assert.match(followupText(panel), /Design changed/); b.D.close();
  });

  it("Spa corner memory cards highlight three apexes and reveal labels without authoring edits", () => {
    const b = bootScreen(); const d = openGreen(b), u = st(b).undo, sel = st(b).sel;
    chipsIn(b.root, "SPA CORNER MEMORY")[0]!.click(); const panel = walk(b.root).find((e) => e.dataset.role === "corner-memory")!;
    assert.equal(walk(panel).filter((e) => e.tagName === "CANVAS").length, 3);
    assert.match(followupText(panel), /T1/); chipsIn(panel, "HIDE LABEL")[0]!.click();
    assert.match(followupText(panel), /Recall this turn/); chipsIn(panel, "REVEAL LABEL")[0]!.click(); assert.match(followupText(panel), /T1/);
    assert.deepEqual(plain(dz(b)), d); assert.equal(st(b).undo, u); assert.equal(st(b).sel, sel); b.D.close();
  });

  it("CARD keeps its outline facts name link and native title on one pre-compression snapshot", async () => {
    const b = bootScreen(); openGreen(b, 11);
    const texts: string[] = [], canvases: HTMLCanvasElement[] = []; recordingCanvas(texts, canvases);
    const original = plain(dz(b));
    let release: (() => Promise<void>) | null = null, started: unknown = null;
    over.encode = (d) => { started = plain(d); return new Promise((resolve) => { release = async () => resolve(await over.real.encode!(d)); }); };
    const pending = b.D.cardCanvas();
    b.D.setName("Changed after click"); b.D.setTheme("oasis"); b.D.preview();
    assert.ok(release); await (release as (() => Promise<void>) | null)!(); const card = (await pending)!;
    assert.equal(card.title, original.name); assert.ok(texts.includes(original.name)); assert.ok(!texts.includes("CHANGED AFTER CLICK"));
    assert.match(card.name, new RegExp(original.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")));
    const decoded = await TrackCodec.decode(TrackCodec.fromHash(card.url.slice(card.url.indexOf("#")))) as { design: Design };
    assert.equal(decoded.design.name, original.name); assert.equal(decoded.design.theme, original.theme);
    assert.deepEqual(started, original);
    b.D.close();
  });

  it("library review is cancellable mid-preflight and on close, and stale approval never writes", async () => {
    const b = bootScreen(); openGreen(b); const draft = plain(dz(b));
    const env = { format: b.C.COLLECTION_FORMAT, v: 1, items: [draft, { ...draft, seed: 19 }] };
    const pending = b.D.loadCollection(env); b.D.cancelLibraryImport(true);
    assert.equal(await pending, false); assert.equal(b.C.list().length, 0);
    assert.equal(await b.D.loadCollection(env), true);
    assert.equal(b.C.list().length, 0, "review makes no write");
    b.C.upsert({ ...draft, seed: 21 });
    assert.equal(b.D.commitLibraryImport(), false); assert.match(msgText(b)!, /changed.*Nothing imported/);
    assert.equal(b.C.list().length, 1);
    const closing = b.D.loadCollection(env); b.D.close();
    assert.equal(await closing, false); assert.equal(b.C.list().length, 1);
  });

  it("native CARD share title remains captured when the design changes during PNG encoding", async () => {
    const b = bootScreen(); openGreen(b); const name = dz(b).name;
    let finishPng: (() => void) | null = null;
    const mk = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const e = mk(tag);
      if (tag === "canvas") Object.defineProperty(e, "toBlob", { value: (done: BlobCallback) => { finishPng = () => done(new Blob(["PNG"], { type: "image/png" })); } });
      return e;
    }) as typeof document.createElement);
    let shared: { title: string; text: string } | null = null;
    vi.stubGlobal("navigator", { canShare: () => true, share: async (d: { title: string; text: string }) => { shared = d; } });
    const pending = b.D.shareCard();
    for (let i = 0; i < 40 && !finishPng; i++) await tick(0);
    assert.equal(typeof finishPng, "function");
    b.D.setName("Different after PNG"); (finishPng as (() => void) | null)!();
    assert.equal(await pending, true); assert.equal(shared!.title, name);
    assert.equal(((await TrackCodec.decode(TrackCodec.fromHash(shared!.text.slice(shared!.text.indexOf("#"))))) as { design: Design }).design.name, name);
    b.D.close();
  });

  it("close cancels pending single-file and decoded imports without blocking a new closed API load", async () => {
    for (const path of ["file", "decode"]) {
      const b = bootScreen(); b.D.init(b.G, { custom: b.C, root: b.root }); b.D.open(); b.D.load(design({ name: "ORIGINAL" }));
      let finish: ((v: unknown) => void) | null = null; const gate = new Promise((resolve) => { finish = resolve; }); let pending: Promise<boolean>;
      if (path === "file") pending = b.D.importFile({ size: 100, text: () => gate as Promise<string> });
      else { over.decode = () => gate; pending = b.D.loadFrom("held-code"); }
      b.D.close(); const before = JSON.stringify(dz(b)), draft = JSON.stringify(b.C.draft());
      finish!(path === "file" ? JSON.stringify({ format: "apex26.track", v: 1, design: design({ name: "LATE" }) }) : { ok: true, design: design({ name: "LATE" }) });
      assert.equal(await pending, false, path + " loses ownership on close");
      assert.equal(JSON.stringify(dz(b)), before); assert.equal(JSON.stringify(b.C.draft()), draft); assert.equal(b.D.isOpen(), false);
      over.decode = null;
      assert.equal(await b.D.loadFrom(JSON.stringify({ format: "apex26.track", v: 1, design: design({ name: "EXPLICIT CLOSED" }) })), true, "a new intentional closed API import remains supported");
      assert.equal(dz(b).name, "EXPLICIT CLOSED"); assert.equal(b.D.isOpen(), false);
    }
  });

  it("mode workspaces show only their own controls and navigation never edits the circuit", () => {
    const b = bootScreen(); openGreen(b);
    const visible = (node: Element) => { for (let n: Element | null = node; n; n = n.parentElement) if ((n as HTMLElement).hidden) return false; return true; };
    const button = (text: string) => chipsIn(b.root, text)[0]!;
    const groups: Record<string, Element> = {
      draw: button("RANDOMISE").parentNode as Element,
      edit: button("REVERSE"),
      elevation: walk(b.root).find((e) => e.dataset.role === "bridges")!,
      scenery: walk(b.root).find((e) => e.dataset.role === "scenery")!,
      test: q(b.root, '[aria-label="Design checks"]').parentNode as Element,
    };
    const before = st(b);
    for (const mode of ["draw", "edit", "elevation", "scenery", "test"]) {
      b.D.setMode(mode);
      for (const [owner, node] of Object.entries(groups)) assert.equal(visible(node), owner === mode, owner + " controls in " + mode);
      assert.equal(chipsIn(q(b.root, ".td-rail"), "TEST HERE").some(visible), mode === "test");
      assert.equal(visible(q(b.root, '[aria-label="Circuit name"]')), mode === "test");
      assert.equal(visible(button("SELECT END")), false, "RANGE replaces the duplicate selection chip");
      assert.equal(visible(button("UNDO")), true, "history stays shared");
    }
    assert.deepEqual(plain(dz(b)), plain(before.design));
    assert.equal(st(b).undo, before.undo);
  });

  it("authored road bridge adds, refuses overlap/unsafe inputs, edits, undoes and survives save/share", async () => {
    const b = bootScreen(); openGreen(b); b.D.setMode("elevation");
    const panel = walk(b.root).find((e) => e.dataset.role === "bridges")!;
    const add = walk(panel).find((e) => e.dataset.role === "add-bridge") as HTMLButtonElement;
    const length = q<HTMLInputElement>(panel, '[aria-label="Bridge total span · m"]');
    const rise = q<HTMLInputElement>(panel, '[aria-label="Bridge rise · m"]');
    const list = walk(panel).find((e) => e.dataset.role === "bridge-list")!;
    const status = walk(panel).find((e) => e.dataset.role === "bridge-status")!;
    assert.equal(add.disabled, true);
    b.D.selectRange(10, -1);
    assert.equal(add.disabled, false);
    const before = st(b);
    rise.value = "30"; add.click();
    assert.match(status.textContent!, /grade budget/);
    assert.equal(st(b).undo, before.undo, "invalid bridge creates no history entry");
    rise.value = "8"; add.click();
    const added = st(b);
    assert.equal(added.design!.bridges.length, 1);
    assert.equal(added.undo, before.undo + 1);
    assert.equal(added.design!.bridges[0]!.halfM, 160);
    const v = b.D.preview()!;
    const flatB = TrackValidate.build(Object.assign({}, added.design, { bridges: [] }))!.tr!;
    assert.ok(Array.from(v.tr!.py).some((y, i) => y > flatB.py[i]! + 1), "native track build raises the actual road");
    add.click();
    assert.match(status.textContent!, /overlap/);
    assert.equal(st(b).undo, added.undo);
    q(list.children[0]!, '[aria-label="Edit road bridge 1"]').click();
    length.value = "400"; rise.value = "9";
    (walk(panel).find((e) => e.dataset.role === "apply-bridge") as HTMLElement).click();
    assert.equal(dz(b).bridges[0]!.rise, 9);
    assert.equal(b.D.undo(), true);
    assert.equal(dz(b).bridges[0]!.rise, 8);
    const stored = b.C.sanitize(dz(b))!;
    const code = await TrackCodec.encode(stored), decoded = await TrackCodec.decode(code) as { ok: boolean; design: Design };
    assert.equal(decoded.ok, true);
    assert.deepEqual(plain(decoded.design.bridges), plain(stored.bridges));
    const saved = b.C.upsert(stored);
    assert.equal(saved.ok, true);
    assert.deepEqual(plain(b.C.list()[0]!.bridges), plain(stored.bridges));
    q(list.children[0]!, '[aria-label="Remove road bridge 1"]').click();
    assert.equal(dz(b).bridges.length, 0);
    assert.equal(b.D.undo(), true);
    assert.equal(dz(b).bridges.length, 1);
    b.D.close(); b.D.open();
    assert.equal(dz(b).bridges.length, 1, "draft reopens with its bridge");
  });

  it("share clipboard fallback opens the workspace containing its copy field", async () => {
    const b = bootScreen(); openGreen(b); b.D.setMode("scenery"); b.D.showPane("library");
    b.deps.clipboard = { write: async () => false };
    const url = await b.D.share();
    assert.ok(url && url.includes("#track="));
    assert.equal(st(b).mode, "test");
    const field = q<HTMLInputElement>(b.root, '[aria-label="Share code or link"]');
    assert.equal(field.value, url);
    assert.equal((field.parentNode as HTMLElement).hidden, false);
    assert.equal(b.root.dataset.pane, "design");
    assert.equal((field.parentNode as HTMLDetailsElement).open, true, "fallback expands the copy field's disclosure");
    assert.equal(document.activeElement, field);
  });

  it("terrain library search filters without editing; landscapes place, undo and save", () => {
    const b = bootScreen(); openGreen(b); b.D.setMode("scenery");
    const search = q<HTMLInputElement>(b.root, '[aria-label="Find a scenery object"]'), undo = st(b).undo;
    by(b, "objectCategory", "terrain").click();
    assert.equal(by(b, "prop", "snowpeak").hidden, false); assert.equal(by(b, "prop", "pond").hidden, true);
    search.value = "snowy"; fire(search, "input");
    assert.equal(by(b, "prop", "snowpeak").hidden, false); assert.equal(by(b, "prop", "mountain").hidden, true);
    search.value = "no such scenery"; fire(search, "input");
    assert.match(by(b, "role", "object-results").textContent!, /No objects found/);
    search.value = ""; fire(search, "input");
    assert.equal(st(b).undo, undo);
    by(b, "prop", "snowpeak").click(); b.D.selectRange(0); b.D.placeProp();
    assert.equal(dz(b).props![0]!.kind, "snowpeak");
    const saved = b.D.save() as { ok: boolean; id: string }; assert.equal(saved.ok, true); assert.equal(b.C.get(saved.id)!.props![0]!.kind, "snowpeak");
    b.D.undo(); assert.equal(dz(b).props, undefined);
    for (const theme of ["fjord", "badlands", "redwood"]) { by(b, "theme", theme).click(); assert.equal(dz(b).theme, theme); }
    b.D.close();
  });
});
