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
  fixes: null as null | "absent" | { canFix?: (it: unknown) => boolean; apply?: (d: unknown, it: unknown, b: unknown) => unknown; fixAll?: (d: unknown, check: unknown) => unknown },
}));
vi.mock("../../src/editor/validate", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/editor/validate")>();
  return { ...real, check: (d: unknown) => (over.check ? over.check(d) : real.check(d)) };
});
vi.mock("../../src/editor/codec", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/editor/codec")>();
  return { ...real, encode: (d: unknown) => (over.encode ? over.encode(d) : real.encode(d)), decode: (c: unknown) => (over.decode ? over.decode(c) : real.decode(c)) };
});
vi.mock("../../src/editor/canvas", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/editor/canvas")>();
  return { ...real, create: (c: HTMLCanvasElement, h: object) => (over.canvasCreate ? over.canvasCreate(c, h, real.create as unknown as Fn) : real.create(c, h)) };
});
vi.mock("../../src/editor/fixes", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/editor/fixes")>();
  const F = () => (over.fixes === "absent" ? null : over.fixes || real);
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
  hooks?: Record<string, Fn>;
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
    designer: () => D,
    codec: () => TrackCodec,
    roster: { LAZY_EDITOR: ["src/editor/designer.ts"], LAZY_EDITOR_EDGES: [] },
    location: () => loc,
    replaceState: (u) => { replaced.push(u); },
    layers: { inRace: () => layers.race },
  });
  const C = opts.custom ? opts.custom(C0) : C0;
  const root = document.createElement("div");
  document.body.appendChild(root);
  D = mount(root, Object.assign({ custom: C, game: G, store, trackList: () => list, onRace: () => clicks.push("mb-race"), onTimeTrial: () => clicks.push("mb-tt") }, opts.deps || {}));
  const data = () => Object.fromEntries(Object.entries(mem.data).map(([k, v]) => [k, JSON.parse(v)]));
  const b: Boot = { D, C, G, root, store, list, clicks, data, loc, replaced, layers };
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
  // eslint-disable-next-line prefer-const
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
  afterEach(() => { /* bootCanvas canvases are not mounted */ });

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
