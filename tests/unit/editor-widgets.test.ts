// @vitest-environment happy-dom
// The designer's DOM widgets (src/editor/canvas.ts, profile.ts, selection-panel.ts,
// bridge-panel.ts, workspace.ts, followup-tools.ts, scenery-panel.ts) on happy-dom over
// the real engine. Ported from f1-game's own unit tests:
//   tests/unit/designer-canvas.test.mjs   (every test but the two DesignerSceneryPreview
//                                          tests, already in editor-fixes-stamps.test.ts)
//   tests/unit/designer-profile.test.mjs  (every test)
//   tests/unit/track-designer-dom.test.mjs (the seven standalone DesignerCanvas tests)
//   tests/unit/designer-props.test.mjs    (the DesignerFollowup.recipe test)
// plus build-and-refresh smoke tests for the four panels f1-game only tests through the
// whole screen. f1-game's mini-dom (tests/helpers/mini-dom.mjs) is replaced by happy-dom:
// a test-owned getBoundingClientRect (mini-dom's `_rect`), clientWidth / clientHeight
// read from that rect (as mini-dom derives them), a recording 2D context assigned over
// getContext (as f1-game does), real PointerEvent / KeyboardEvent / MouseEvent objects
// for mini-dom's plain-object dispatch, and vi.stubGlobal'd setTimeout / clearTimeout
// for the VM's hand-driven timers. f1-game's TrackShape wrapper (`wrapShape`) is a
// vi.mock pass-through that counts span walks.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as DesignerCanvas from "../../src/editor/canvas";
import type { CanvasHooks, CanvasTrack } from "../../src/editor/canvas";
import * as CustomTracks from "../../src/editor/custom-tracks";
import { el } from "../../src/editor/dom";
import * as DesignerProfile from "../../src/editor/profile";
import type { ProfileHooks } from "../../src/editor/profile";
import * as DesignerSelection from "../../src/editor/selection-panel";
import * as DesignerBridges from "../../src/editor/bridge-panel";
import type { BridgeDesign } from "../../src/editor/bridge-panel";
import * as DesignerWorkspace from "../../src/editor/workspace";
import type { BtnFn, GroupFn, WorkspaceUi } from "../../src/editor/workspace";
import * as DesignerFollowup from "../../src/editor/followup-tools";
import type { RecipeState } from "../../src/editor/followup-tools";
import * as DesignerScenery from "../../src/editor/scenery-panel";
import * as TrackDesignerProps from "../../src/editor/props";
import type { DesignerProp, PropKind } from "../../src/editor/props";
import * as TrackRandom from "../../src/editor/randomise";
import * as S from "../../src/editor/shape";
import type { Pt } from "../../src/editor/shape";
import * as TrackThemes from "../../src/editor/track-themes";
import * as TrackValidate from "../../src/editor/validate";

// f1-game's `wrapShape` (designer-canvas.test.mjs:480): count the canvas's span walks.
const walks = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../src/editor/shape", async (importOriginal) => {
  const T = await importOriginal<typeof import("../../src/editor/shape")>();
  return {
    ...T,
    inSpan: (...a: Parameters<typeof T.inSpan>) => { walks.n++; return T.inSpan(...a); },
    spanIndices: (...a: Parameters<typeof T.spanIndices>) => { walks.n++; return T.spanIndices(...a); },
  };
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const V = TrackValidate, DC = DesignerCanvas, DP = DesignerProfile;

// ── f1-game tests/helpers/editor-vm.mjs ─────────────────────────────────────
const plain = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
function ellipse(n = 36, a = 800, b = 500): Pt[] {
  const pts: Pt[] = [], q = (v: number) => Math.round(v * 4) / 4;
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; pts.push([q(a * Math.cos(t)), q(b * Math.sin(t))]); }
  return pts;
}
type Design = { name: string; seed: number; theme: string; baseHW: number; pts: Pt[]; props?: DesignerProp[]; [k: string]: unknown };
const design = (extra?: object): Design => Object.assign({ name: "Test Loop", seed: 7, theme: "parkland", baseHW: 7, pts: ellipse() }, extra);
const ok = (cond: unknown, msg?: string) => expect(Boolean(cond), msg).toBe(true);

// ── f1-game tests/helpers/mini-dom.mjs, on happy-dom ────────────────────────
interface Rect { left: number; top: number; right?: number; bottom?: number; width: number; height: number }
/** A canvas whose box is the test's `rect` (mini-dom `_rect`, clientWidth / clientHeight from it). */
function boxCanvas(rect: Rect) {
  const canvas = document.createElement("canvas");
  const box = { rect };
  canvas.getBoundingClientRect = () => ({ x: box.rect.left, y: box.rect.top, right: box.rect.left + box.rect.width, bottom: box.rect.top + box.rect.height, ...box.rect, toJSON: () => box.rect }) as DOMRect;
  Object.defineProperty(canvas, "clientWidth", { configurable: true, get: () => box.rect.width });
  Object.defineProperty(canvas, "clientHeight", { configurable: true, get: () => box.rect.height });
  return { canvas, box };
}
const setContext = (canvas: HTMLCanvasElement, ctx: object) => { canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"]; };
/** mini-dom dispatch(el, { type, ... }) as a real event. */
function dispatch(target: EventTarget, init: { type: string; [k: string]: unknown }): Event {
  const { type, ...rest } = init;
  const opts = { cancelable: true, ...rest };
  const ev = type === "keydown" ? new KeyboardEvent(type, opts as KeyboardEventInit)
    : type === "dblclick" || type === "click" ? new MouseEvent(type, opts as MouseEventInit)
      : new PointerEvent(type, opts as PointerEventInit);
  target.dispatchEvent(ev);
  return ev;
}
/** The VM's hand-driven setTimeout / clearTimeout. */
function manualTimers() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  vi.stubGlobal("setTimeout", (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { fn, ms }); return id; });
  vi.stubGlobal("clearTimeout", (id: number) => { timers.delete(id); });
  const runTimers = () => { const due = [...timers.entries()]; timers.clear(); for (const [, t] of due) t.fn(); return due.length; };
  return { timers, runTimers };
}

// ════════════════════════════ DesignerCanvas ════════════════════════════
type At = { clientX?: number; clientY?: number };
interface Rec { strokes: { style: unknown; dash: number[]; width: unknown }[]; dashes: number[][]; texts: string[]; arcs: number[]; fills: unknown[] }

/** designer-canvas.test.mjs:20 boot(): the canvas, a recording context and manual timers. */
function boot(hooksExtra: CanvasHooks = {}, ptsIn: Pt[] | null = null) {
  const { timers, runTimers } = manualTimers();
  const { canvas } = boxCanvas({ left: 0, top: 0, right: 640, bottom: 400, width: 640, height: 400 });
  const rec: Rec = { strokes: [], dashes: [], texts: [], arcs: [], fills: [] };
  setContext(canvas, (() => {
    const st: Record<string | symbol, unknown> & { _dash: number[] } = { _dash: [] };
    return new Proxy(st, {
      get: (t, k) => {
        if (k === "stroke") return () => rec.strokes.push({ style: t.strokeStyle, dash: t._dash.slice(), width: t.lineWidth });
        if (k === "fill") return () => rec.fills.push(t.fillStyle);
        if (k === "setLineDash") return (d: number[]) => { t._dash = d.slice(); rec.dashes.push(d.slice()); };
        if (k === "fillText") return (s: unknown) => rec.texts.push(String(s));
        if (k === "arc") return (_x: number, _y: number, r: number) => rec.arcs.push(r);
        if (k === "measureText") return (s: unknown) => ({ width: String(s).length * 6 });
        return k in t ? t[k] : () => {};
      },
      set: (t, k, v) => { t[k] = v; return true; },
    });
  })());
  const ev = { changes: [] as { pts: Pt[]; kind: string }[], picks: [] as number[], contexts: [] as { i: number; at: { x: number; y: number } }[], selects: [] as { i: number; j: number }[] };
  let cv: DesignerCanvas.DesignerCanvasApi | null = null;
  cv = DC.create(canvas, Object.assign({
    onChange: (p: Pt[], kind: string) => { ev.changes.push({ pts: p, kind }); cv!.setPoints(p); },
    onPick: (i: number) => ev.picks.push(i), onSelect: (i: number, j: number) => ev.selects.push({ i, j: j == null ? -1 : j }),
    onContext: (i: number, at: { x: number; y: number }) => ev.contexts.push({ i, at }),
  }, hooksExtra));
  let pts = ptsIn;
  if (!pts) {
    pts = [];
    for (let i = 0; i < 24; i++) { const t = i / 24 * Math.PI * 2; pts.push([Math.round(300 * Math.cos(t) * 4) / 4, Math.round(200 * Math.sin(t) * 4) / 4]); }
  }
  cv.setPoints(pts);
  const c = cv;
  const scr = (p: readonly number[]) => { const v = c.view(); return { clientX: (p[0]! - v.cx) * v.scale + v.w / 2, clientY: (p[1]! - v.cz) * v.scale + v.h / 2 }; };
  const fire = (type: string, at: At, id = 1, extra?: object) => dispatch(canvas, Object.assign({ type, pointerId: id }, at, extra));
  const off = (at: { clientX: number; clientY: number }, dx: number, dy: number) => ({ clientX: at.clientX + dx, clientY: at.clientY + dy });
  return { canvas, cv: c, ev, pts, scr, fire, off, rec, timers, runTimers };
}

describe("DesignerCanvas (f1-game tests/unit/designer-canvas.test.mjs)", () => {
  it("range drag on the map selects a continuous section without moving the road", () => {
    const h = boot({ rangeSelect: () => true });
    const a = h.scr(h.pts[3]!), b = h.scr(h.pts[8]!);
    h.fire("pointerdown", a, 1, { pointerType: "mouse" });
    h.fire("pointermove", b);
    h.fire("pointerup", b);
    expect(plain(h.cv.selection())).toEqual({ sel: 3, span: 8 });
    expect(h.ev.changes.length).toBe(0);
    expect(h.ev.picks.length, "range release does not collapse back to one point").toBe(0);
  });

  it("armed end selection does not replace the map anchor on pointerdown", () => {
    let picked: { i: number; shift: boolean } | undefined;
    const h = boot({ extendSelection: () => true, onPick: (i, e) => { picked = { i, shift: e.shiftKey }; } });
    h.cv.setSelection(3, -1);
    const p = h.scr(h.pts[8]!);
    h.fire("pointerdown", p);
    expect(plain(h.cv.selection())).toEqual({ sel: 3, span: -1 });
    h.fire("pointerup", p);
    expect(picked).toEqual({ i: 8, shift: true });
    expect(h.ev.changes.length).toBe(0);
  });

  it("long-press: a handle held 500 ms fires onContext once, keeps it selected and never becomes a drag", () => {
    const h = boot();
    const a = h.scr(h.pts[5]!);
    h.fire("pointerdown", a, 1, { pointerType: "touch" });
    expect(h.timers.size, "one hold timer armed on a handle press").toBe(1);
    expect([...h.timers.values()][0]!.ms).toBe(DC.HOLD_MS);
    expect(DC.HOLD_MS).toBe(500);
    h.fire("pointermove", h.off(a, 4, 0), 1, { pointerType: "touch" });     // finger jitter, under 6 px
    expect(h.runTimers()).toBe(1);
    expect(h.ev.contexts.length).toBe(1);
    expect(h.ev.contexts[0]!.i).toBe(5);
    ok(Math.abs(h.ev.contexts[0]!.at.x - (a.clientX + 4)) < 1e-9 && Math.abs(h.ev.contexts[0]!.at.y - a.clientY) < 1e-9, "canvas-relative pointer position: " + JSON.stringify(plain(h.ev.contexts[0]!.at)));
    h.fire("pointermove", h.off(a, 60, 30), 1, { pointerType: "touch" });   // after the hold: no drag
    h.fire("pointerup", h.off(a, 60, 30), 1, { pointerType: "touch" });
    expect(h.runTimers(), "nothing re-armed").toBe(0);
    expect(h.ev.contexts.length, "fired once").toBe(1);
    expect(h.ev.changes.length, "the release after a long-press moves nothing").toBe(0);
    expect(h.ev.picks, "…and picks nothing").toEqual([]);
    expect(h.cv.selection().sel, "the held handle stays selected").toBe(5);
    // The next press is an ordinary drag again (mouse: threshold alone is enough).
    const b = h.scr(h.pts[8]!);
    h.fire("pointerdown", b, 2, { pointerType: "mouse" });
    h.fire("pointermove", h.off(b, 30, 0), 2, { pointerType: "mouse" });
    h.fire("pointerup", h.off(b, 30, 0), 2, { pointerType: "mouse" });
    expect(h.ev.changes.length).toBe(1);
    expect(h.ev.changes[0]!.kind).toBe("move");
    expect(h.ev.contexts.length).toBe(1);
  });

  it("long-press is cancelled by 10 px of movement, a second pointer, pointercancel and lostpointercapture", () => {
    const h = boot();
    const a = h.scr(h.pts[3]!);
    // moved 10 px: the timer is cleared and the drag goes on
    h.fire("pointerdown", a, 1);
    h.fire("pointermove", h.off(a, 10, 0), 1);
    expect(h.timers.size, "movement past 6 px clears the hold timer").toBe(0);
    h.fire("pointerup", h.off(a, 10, 0), 1);
    expect(h.ev.contexts.length).toBe(0);
    expect(h.ev.changes.length, "it stayed a drag").toBe(1);
    // a second pointer: a pinch, never a context
    const b = h.scr(h.ev.changes[0]!.pts[6]!);
    h.fire("pointerdown", b, 2);
    expect(h.timers.size).toBe(1);
    h.fire("pointerdown", h.off(b, 120, 80), 3);
    expect(h.timers.size, "a second pointer clears the hold timer").toBe(0);
    h.runTimers();
    h.fire("pointerup", b, 2); h.fire("pointerup", h.off(b, 120, 80), 3);
    // pointercancel / lostpointercapture
    for (const kind of ["pointercancel", "lostpointercapture"]) {
      const c = h.scr(h.ev.changes[0]!.pts[9]!);
      h.fire("pointerdown", c, 4);
      h.fire(kind, {}, 4);
      expect(h.timers.size, kind + " clears the hold timer").toBe(0);
      h.runTimers();
    }
    // reset() clears a pending hold too
    h.fire("pointerdown", h.scr(h.ev.changes[0]!.pts[12]!), 5);
    h.cv.reset();
    expect(h.timers.size, "reset() clears the hold timer").toBe(0);
    expect(h.ev.contexts.length, "no context from any cancelled hold").toBe(0);
    // A canvas without an onContext hook arms nothing (the drag is untouched).
    const q = boot({ onContext: undefined });
    q.fire("pointerdown", q.scr(q.pts[2]!), 1);
    expect(q.timers.size).toBe(0);
    q.fire("pointerup", q.scr(q.pts[2]!), 1);
    expect(q.ev.picks).toEqual([2]);
  });

  it("ghost: a previewFn's points draw as a dashed COL.ghost polyline only while a handle is hovered or selected", () => {
    const h = boot();
    const ghostStrokes = () => h.rec.strokes.filter((s) => s.style === DC.COL.ghost);
    const asked: number[] = [];
    const previewFn = (i: number) => { asked.push(i); const p = h.pts[i]!; return { pts: [p, [p[0] + 40, p[1]], [p[0] + 80, p[1] + 20]] }; };
    h.rec.strokes.length = 0;
    h.cv.render();
    expect(ghostStrokes().length, "no previewFn: no ghost").toBe(0);
    // A previewFn with nothing hovered or selected: nothing to anchor on.
    h.cv.setTool("corner", previewFn);
    h.cv.render();
    expect(ghostStrokes().length, "no anchor: no ghost").toBe(0);
    expect(asked).toEqual([]);
    // Mouse hover over handle 4 anchors it.
    h.fire("pointermove", h.scr(h.pts[4]!), 7, { pointerType: "mouse" });
    expect(h.cv.hover()).toBe(4);
    expect(asked, "asked once for the hovered handle").toEqual([4]);
    h.rec.strokes.length = 0;
    h.cv.render();
    const gs = ghostStrokes();
    expect(gs.length, "one ghost polyline").toBe(1);
    ok(gs[0]!.dash.length >= 2, "dashed: " + JSON.stringify(gs[0]!.dash));
    expect(asked, "a re-render reuses the answer (asked again only on a change)").toEqual([4]);
    // The pointer leaves: the ghost falls back to the selection.
    h.fire("pointerleave", {}, 7);
    expect(h.cv.hover()).toBe(-1);
    h.rec.strokes.length = 0; h.cv.render();
    expect(ghostStrokes().length, "no hover, no selection: no ghost").toBe(0);
    h.cv.setSelection(9, -1);
    expect(asked[asked.length - 1], "setSelection re-asks for the selected handle").toBe(9);
    h.rec.strokes.length = 0; h.cv.render();
    expect(ghostStrokes().length).toBe(1);
    h.cv.setPoints(h.pts.slice());
    expect(asked.filter((i) => i === 9).length, "setPoints re-asks").toBe(2);
    // Touch anchors on the selection, never a stale mouse hover.
    h.fire("pointermove", h.scr(h.pts[2]!), 7, { pointerType: "mouse" });
    expect(asked[asked.length - 1]).toBe(2);
    h.fire("pointerdown", h.scr(h.pts[11]!), 8, { pointerType: "touch" });
    h.fire("pointerup", h.scr(h.pts[11]!), 8, { pointerType: "touch" });
    h.rec.strokes.length = 0; h.cv.render();
    expect(asked[asked.length - 1], "touch: the selected handle").toBe(11);
    // A previewFn that answers null draws nothing; setTool without one clears it.
    h.cv.setTool("corner", () => null);
    h.rec.strokes.length = 0; h.cv.render();
    expect(ghostStrokes().length, "null answer: no ghost").toBe(0);
    h.cv.setTool("corner", previewFn);
    h.rec.strokes.length = 0; h.cv.render();
    expect(ghostStrokes().length).toBe(1);
    h.cv.setTool("select");
    h.rec.strokes.length = 0; h.cv.render();
    expect(ghostStrokes().length, "setTool without a previewFn clears the ghost").toBe(0);
  });

  it("measurement chip: R <n> m while dragging a handle on a curve, STRAIGHT on a collinear triple, <n> m over a span", () => {
    const h = boot();
    expect(h.cv.measure(), "nothing dragged or spanned: no chip").toBe(null);
    const a = h.scr(h.pts[6]!);
    h.fire("pointerdown", a, 1, { pointerType: "mouse" });
    h.fire("pointermove", h.off(a, 12, 5), 1, { pointerType: "mouse" });
    const text = h.cv.measure()!;
    expect(text).toMatch(/^R \d+ m$/);
    h.rec.texts.length = 0; h.cv.render();
    ok(h.rec.texts.includes(text), "the chip is drawn: " + h.rec.texts.join(" | "));
    h.fire("pointerup", h.off(a, 12, 5), 1);
    const p = h.ev.changes[0]!.pts;
    const R = S.menger(p[5]!, p[6]!, p[7]!);
    expect(text, "the Menger radius through the dragged point and its neighbours").toBe("R " + Math.round(R) + " m");
    expect(h.cv.measure(), "the drag chip goes with the drag").toBe(null);
    // A span [2, 5]: the polygon length, drawn at its middle.
    h.cv.setSelection(2, 5);
    let L = 0;
    for (let i = 2; i < 5; i++) L += Math.hypot(p[i + 1]![0] - p[i]![0], p[i + 1]![1] - p[i]![1]);
    expect(h.cv.measure()).toBe(Math.round(L) + " m");
    h.rec.texts.length = 0; h.cv.render();
    ok(h.rec.texts.includes(Math.round(L) + " m"));
    h.cv.setSelection(3, 3);
    expect(h.cv.measure(), "a one-point selection is not a span").toBe(null);
    // A collinear triple reads STRAIGHT, also while the point slides along its line.
    const s = boot({}, [[0, 0], [50, 0], [100, 0], [100, 60], [0, 60]]);
    const b = s.scr([50, 0]);
    s.fire("pointerdown", b, 1, { pointerType: "mouse" });
    s.fire("pointermove", s.off(b, 15, 0), 1, { pointerType: "mouse" });
    expect(s.cv.measure()).toBe("STRAIGHT");
    s.fire("pointerup", s.off(b, 15, 0), 1, { pointerType: "mouse" });
  });

  it("touch targets: a press 32 px from a handle picks it with pointerType touch, not with a mouse", () => {
    expect(DC.HIT_PX, "mouse pick radius (larger than the drawn dot)").toBe(28);
    const h = boot();
    expect(DC.HIT_TOUCH).toBe(44);
    // 32 px radially outward from handle 0 (on +x): outside mouse HIT_PX, inside HIT_TOUCH.
    const at = h.off(h.scr(h.pts[0]!), 32, 0);
    h.fire("pointerdown", at, 1, { pointerType: "mouse" });
    h.fire("pointerup", at, 1, { pointerType: "mouse" });
    expect(h.ev.picks, "a mouse at 32 px misses").toEqual([]);
    expect(h.ev.changes.length, "…and is a pan, not an insert").toBe(0);
    h.fire("pointerdown", at, 2, { pointerType: "touch" });
    h.fire("pointerup", at, 2, { pointerType: "touch" });
    expect(h.ev.picks, "a finger at 32 px picks the handle").toEqual([0]);
    // Handles draw 1.5x under touch (the last pointer type seen); a mouse puts them back.
    const plainR = () => { h.rec.arcs.length = 0; h.cv.render(); return Math.min(...h.rec.arcs); };
    expect(plainR(), "an unselected handle under touch").toBe(4.5 * 1.5);
    h.fire("pointermove", { clientX: 5, clientY: 5 }, 9, { pointerType: "mouse" });
    expect(plainR(), "…and under a mouse again").toBe(4.5);
  });

  it("SPEED: setHeat fills one COL.spd* polygon per run of a speed bucket (the wrap merged); null, stale and one-bucket rings", () => {
    const h = boot();
    const d = (pts: Pt[]) => ({ name: "Heat", seed: 7, theme: "parkland", baseHW: 7, pts });
    const r = TrackRandom.generateValid(7, (pts) => V.check(d(pts)).ok, 12);
    const tr = V.check(d(r.pts)).tr!, v = V.speedProfile(tr), n = tr.n;
    const C = DC.COL, SPD: unknown[] = [C.spd0, C.spd1, C.spd2, C.spd3, C.spd4];
    expect(SPD, "the plasma ramp, slow → fast").toEqual(["#f0f921", "#fca636", "#e16462", "#b12a90", "#6a00a8"]);
    const bucket = (x: number) => (x < 40 ? 0 : x < 55 ? 1 : x < 70 ? 2 : x < 85 ? 3 : 4);
    let runs = 0;
    for (let k = 0; k < n; k++) if (bucket(v[k]!) !== bucket(v[(k - 1 + n) % n]!)) runs++;
    ok(runs >= 4, "a circuit with slow and fast parts: " + runs + " runs");
    h.cv.setBuilt(tr);
    const spdFills = () => h.rec.fills.filter((f) => SPD.includes(f));
    h.rec.fills.length = 0; h.rec.texts.length = 0;
    h.cv.setHeat(v);
    expect(spdFills().length, "one polygon per run").toBe(runs);
    const used = new Set(spdFills());
    for (let k = 0; k < n; k++) ok(used.has(SPD[bucket(v[k]!)]), "node " + k + "'s colour is painted");
    ok(h.rec.texts.includes("SLOW → FAST"), "the legend");
    h.rec.fills.length = 0; h.rec.texts.length = 0;
    h.cv.setHeat(new Float64Array(n).fill(92));
    expect(spdFills(), "one bucket all the way round: one ring").toEqual([C.spd4]);
    h.rec.fills.length = 0;
    h.cv.setHeat(v.slice(0, n - 1));
    expect(spdFills().length, "speeds for another road are ignored").toBe(0);
    h.rec.fills.length = 0; h.rec.texts.length = 0;
    h.cv.setHeat(null);
    expect(spdFills().length).toBe(0); ok(!h.rec.texts.includes("SLOW → FAST"));
  });

  it("elevation heat uses ordered height colours, numeric extrema and a flat legend; invalid data clears it", () => {
    const h = boot(), n = h.pts.length;
    const py = Float32Array.from({ length: n }, (_, i) => -20 + i * 5);
    const tr: CanvasTrack = { n, px: h.pts.map(p => p[0]), pz: h.pts.map(p => p[1]), py, hw: new Float32Array(n).fill(7), total: 1600 };
    const colours: unknown[] = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];
    h.cv.setBuilt(tr); h.rec.fills.length = 0; h.rec.texts.length = 0;
    h.cv.setHeat(py, "elevation");
    expect(h.rec.fills.filter(c => colours.includes(c)), "low-to-high runs follow node height").toEqual(colours);
    ok(h.rec.texts.includes("LOW -20.0 → HIGH 95.0 m"));
    h.cv.setSelection(3, 8);
    expect(plain(h.cv.selection())).toEqual({ sel: 3, span: 8 });
    h.rec.fills.length = 0; h.rec.texts.length = 0;
    h.cv.setHeat(new Float32Array(n).fill(-5), "elevation");
    expect(h.rec.fills.filter(c => colours.includes(c))).toEqual([colours[2]]);
    ok(h.rec.texts.includes("FLAT · -5.0 m"));
    for (const bad of [py.slice(1), new Float32Array(n).fill(NaN), null]) {
      h.rec.fills.length = 0; h.rec.texts.length = 0; h.cv.setHeat(bad, "elevation");
      expect(h.rec.fills.filter(c => colours.includes(c)).length).toBe(0);
      ok(!h.rec.texts.some(t => /LOW |FLAT ·/.test(t)));
    }
  });

  it("pickOnly: tap selects; drag / insert / long-press / Delete do not edit geometry", () => {
    const h = boot();
    h.cv.setTool("select", null, { pickOnly: true });
    const i = 5;
    const before = plain(h.pts.map((p) => p.slice()));
    const a = h.scr(h.pts[i]!);
    // Tap selects.
    h.fire("pointerdown", a, 1, { pointerType: "mouse" });
    h.fire("pointerup", a, 1, { pointerType: "mouse" });
    expect(h.cv.selection().sel).toBe(i);
    expect(h.ev.picks).toEqual([i]);
    expect(h.ev.changes.length, "tap does not move").toBe(0);
    // Deliberate drag past threshold: still no move in pickOnly.
    h.fire("pointerdown", a, 2, { pointerType: "mouse" });
    h.fire("pointermove", h.off(a, 40, 0), 2, { pointerType: "mouse" });
    h.fire("pointerup", h.off(a, 40, 0), 2, { pointerType: "mouse" });
    expect(h.ev.changes.length, "pickOnly blocks drag").toBe(0);
    expect(plain(h.pts)).toEqual(before);
    // Road hit would insert under select, not in pickOnly.
    const mid = {
      clientX: (h.scr(h.pts[0]!).clientX + h.scr(h.pts[1]!).clientX) / 2,
      clientY: (h.scr(h.pts[0]!).clientY + h.scr(h.pts[1]!).clientY) / 2,
    };
    h.fire("pointerdown", mid, 3, { pointerType: "mouse" });
    h.fire("pointerup", mid, 3, { pointerType: "mouse" });
    expect(h.ev.changes.length, "pickOnly blocks road insert").toBe(0);
    expect(h.pts.length).toBe(before.length);
    // Long-press never opens context.
    h.fire("pointerdown", a, 4, { pointerType: "touch" });
    expect(h.timers.size, "no hold timer when pickOnly").toBe(0);
    h.fire("pointerup", a, 4, { pointerType: "touch" });
    expect(h.ev.contexts.length).toBe(0);
    // Leaving pickOnly restores drag.
    h.cv.setTool("select");
    h.fire("pointerdown", a, 5, { pointerType: "mouse" });
    h.fire("pointermove", h.off(a, 30, 0), 5, { pointerType: "mouse" });
    h.fire("pointerup", h.off(a, 30, 0), 5, { pointerType: "mouse" });
    expect(h.ev.changes.length).toBe(1);
    expect(h.ev.changes[0]!.kind).toBe("move");
  });

  it("TrackShape.spanIndices / inSpan: forward walk inclusive; one point when ends match", () => {
    expect(plain(S.spanIndices(2, 5, 10))).toEqual([2, 3, 4, 5]);
    expect(plain(S.spanIndices(8, 1, 10)), "wraps past the start").toEqual([8, 9, 0, 1]);
    expect(plain(S.spanIndices(3, 3, 10))).toEqual([3]);
    expect(plain(S.spanIndices(-1, 4, 10))).toEqual([]);
    expect(S.inSpan(4, 2, 5, 10)).toBe(true);
    expect(S.inSpan(6, 2, 5, 10)).toBe(false);
    expect(S.inSpan(0, 8, 1, 10)).toBe(true);
  });

  it("span group move: drag a member translates every point on the selected span by the same delta", () => {
    const h = boot();
    h.cv.setSelection(3, 6);
    const before = plain(h.pts);
    // Press a mid-span handle (already in the group) and drag past the mouse threshold.
    const a = h.scr(h.pts[4]!);
    h.fire("pointerdown", a, 1, { pointerType: "mouse" });
    h.fire("pointermove", h.off(a, 40, 0), 1, { pointerType: "mouse" });
    h.fire("pointerup", h.off(a, 40, 0), 1, { pointerType: "mouse" });
    expect(h.ev.changes.length).toBe(1);
    expect(h.ev.changes[0]!.kind).toBe("move-span");
    const after = plain(h.ev.changes[0]!.pts);
    const dx = after[4]![0] - before[4]![0], dz = after[4]![1] - before[4]![1];
    ok(Math.abs(dx) > 1 || Math.abs(dz) > 1, "the dragged handle moved");
    for (const i of [3, 4, 5, 6]) {
      ok(Math.abs(after[i]![0] - (before[i]![0] + dx)) < 1e-9, "point " + i + " x");
      ok(Math.abs(after[i]![1] - (before[i]![1] + dz)) < 1e-9, "point " + i + " z");
    }
    expect(after[0], "outside the span stays put").toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    // Keyboard nudge moves the whole span.
    h.cv.setPoints(before);
    h.cv.setSelection(3, 6);
    h.ev.changes.length = 0;
    dispatch(h.canvas, { type: "keydown", key: "ArrowRight", shiftKey: true });
    expect(h.ev.changes[0]!.kind).toBe("nudge-span");
    const nudged = plain(h.ev.changes[0]!.pts);
    for (const i of [3, 4, 5, 6]) expect(nudged[i]).toEqual([before[i]![0] + 10, before[i]![1]]);
    expect(nudged[1]).toEqual(before[1]);
  });

  it("shift-click a second handle keeps the anchor and reports the pick with shiftKey", () => {
    const h = boot();
    h.cv.setSelection(2, -1);
    const a = h.scr(h.pts[7]!);
    h.fire("pointerdown", a, 1, { pointerType: "mouse", shiftKey: true });
    // Anchor must stay 2 through the press (so the designer can set span=7 on pick).
    expect(plain(h.cv.selection())).toEqual({ sel: 2, span: -1 });
    h.fire("pointerup", a, 1, { pointerType: "mouse", shiftKey: true });
    expect(h.ev.picks).toEqual([7]);
    expect(plain(h.cv.selection()), "canvas leaves span to the screen's onPick").toEqual({ sel: 2, span: -1 });
  });

  it("thumb(): one fitted outline in the asked colour and the start tick; nothing for a missing road", () => {
    const tr = V.check({ name: "T", seed: 7, theme: "parkland", baseHW: 7, pts: TrackRandom.generate(7, { targetL: 3800 }).pts }).tr!;
    const c = document.createElement("canvas");
    c.width = 160; c.height = 110;
    const strokes: unknown[] = [], moves: [number, number][] = [];
    setContext(c, new Proxy({} as Record<string | symbol, unknown>, {
      get: (t, k) => (k === "stroke" ? () => strokes.push(t.strokeStyle) : k === "moveTo" || k === "lineTo" ? (x: number, y: number) => moves.push([x, y]) : k in t ? t[k] : () => {}),
      set: (t, k, val) => { t[k] = val; return true; },
    }));
    expect(DC.thumb(c, tr, { color: "#abcdef", width: 2 })).toBe(true);
    expect(strokes, "the outline, then the start tick").toEqual(["#abcdef", DC.COL.start]);
    ok(moves.every(([x, y]) => x >= 0 && x <= 160 && y >= 0 && y <= 110), "fitted inside the card");
    expect(DC.thumb(c, null)).toBe(false);
    strokes.length = 0;
    DC.thumb(c, tr, { start: false });
    expect(strokes, "no tick when asked").toEqual([DC.COL.centre]);
  });

  it("live scenery keeps map range picking and outline switching non-destructive", () => {
    const h = boot({ rangeSelect: () => true }), d = design({ pts: h.pts });
    h.cv.setBuilt(V.check(d).tr);
    h.cv.setScenery(d, true);
    expect(h.canvas.dataset.mapView).toBe("scenery");
    const a = h.scr(h.pts[3]!), b = h.scr(h.pts[8]!);
    h.fire("pointerdown", a, 1, { pointerType: "mouse" }); h.fire("pointermove", b); h.fire("pointerup", b);
    expect(plain(h.cv.selection())).toEqual({ sel: 3, span: 8 });
    h.cv.setScenery(d, false);
    expect(h.canvas.dataset.mapView).toBe("outline");
    expect(plain(h.cv.selection())).toEqual({ sel: 3, span: 8 });
    expect(h.ev.changes.length).toBe(0);
  });

  it("controls(): a selected span is walked once per redraw, not once per handle (bug-hunt 2 P10)", () => {
    walks.n = 0;
    const h = boot();
    const n = h.pts.length;
    h.cv.setSelection(3, 20);
    ok(walks.n <= 2 && walks.n < n, "span walks per redraw " + walks.n + " for " + n + " handles");
    h.rec.arcs.length = 0; h.cv.setSelection(3, 20);
    ok(h.rec.arcs.filter(r => r === 7).length >= 18, "span members still draw as selected");
  });

  it("destroy removes every input subscription and is idempotent", () => {
    const h = boot();
    const removed: string[] = [];
    const remove = h.canvas.removeEventListener.bind(h.canvas);
    h.canvas.removeEventListener = ((type: string, fn: EventListener) => { removed.push(type); remove(type, fn); }) as typeof h.canvas.removeEventListener;
    h.cv.destroy(); h.cv.destroy();
    expect(removed.sort()).toEqual(["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "keydown", "wheel", "dblclick", "pointerleave"].sort());
    const before = JSON.stringify(h.ev);
    dispatch(h.canvas, { type: "keydown", key: "ArrowUp" });
    expect(JSON.stringify(h.ev)).toBe(before);
  });

  it("HEIGHT heat stays visible at whole-lap zoom: a 6 px colour ribbon and handles that never bury the road", () => {
    const n = 240, pts: Pt[] = [];
    for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; pts.push([Math.round(900 * Math.cos(t) * 4) / 4, Math.round(600 * Math.sin(t) * 4) / 4]); }
    const h = boot({}, pts);
    const py = Float32Array.from({ length: n }, (_, i) => Math.round(8 * Math.sin(i / n * 6.28) * 4) / 4);
    const tr: CanvasTrack = { n, px: pts.map(p => p[0]), pz: pts.map(p => p[1]), py, hw: new Float32Array(n).fill(7), total: 5000 };
    h.cv.setBuilt(tr);
    h.rec.strokes.length = 0; h.rec.arcs.length = 0;
    h.cv.setHeat(py, "elevation");
    const colours: unknown[] = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];
    const ribbon = h.rec.strokes.filter((s) => colours.includes(s.style) && (s.width as number) >= 6);
    ok(new Set(ribbon.map((s) => s.style)).size >= 4, "thin road gets a ≥6 px ribbon in the height colours");
    const gap = 2 * Math.PI * 750 * h.cv.view().scale / n;
    ok(h.rec.arcs.length && h.rec.arcs.every((r) => r < 4.5 && r <= gap * 0.5), "idle handle dots are no wider than the point spacing");
  });
});

// ── track-designer-dom.test.mjs: the standalone DesignerCanvas tests ────────
/** bootScreen's canvas (track-designer-dom.test.mjs:26): a no-op 2D context over 640×400. */
function screenCanvas() {
  const { canvas } = boxCanvas({ left: 0, top: 0, right: 640, bottom: 400, width: 640, height: 400 });
  setContext(canvas, new Proxy({}, { get: (_t, k) => (k === "measureText" ? (s: unknown) => ({ width: String(s).length * 6 }) : () => {}), set: () => true }));
  return canvas;
}
/** A DesignerCanvas over a 1.6 km loop, with a recording 2D context. track-designer-dom.test.mjs:653 */
function bootCanvas() {
  const canvas = screenCanvas();
  const fills: unknown[] = [];
  setContext(canvas, new Proxy({} as Record<string | symbol, unknown>, { get: (t, k) => (k === "fill" ? () => fills.push(t.fillStyle) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }));
  const ev = { changes: [] as { pts: Pt[]; kind: string }[], picks: [] as number[], deletes: [] as number[], limits: [] as string[] };
  let cv: DesignerCanvas.DesignerCanvasApi | null = null;
  cv = DC.create(canvas, {
    onChange: (pts, kind) => { ev.changes.push({ pts, kind }); cv!.setPoints(pts); },
    onPick: (i) => ev.picks.push(i), onDelete: (i) => ev.deletes.push(i), onSelect: () => {}, onLimit: (w) => ev.limits.push(w),
  });
  const pts: Pt[] = [];
  for (let i = 0; i < 24; i++) { const t = i / 24 * Math.PI * 2; pts.push([Math.round(300 * Math.cos(t) * 4) / 4, Math.round(200 * Math.sin(t) * 4) / 4]); }
  cv.setPoints(pts);
  const c = cv;
  const scr = (p: readonly number[]) => { const v = c.view(); return { clientX: (p[0]! - v.cx) * v.scale + v.w / 2, clientY: (p[1]! - v.cz) * v.scale + v.h / 2 }; };
  const fire = (type: string, at: At, id = 1, extra?: object) => dispatch(canvas, Object.assign({ type, pointerId: id }, at, extra));
  const tap = (at: At, id = 1) => { fire("pointerdown", at, id); fire("pointerup", at, id); };
  return { canvas, cv: c, ev, pts, scr, fire, tap, fills };
}

describe("DesignerCanvas (f1-game tests/unit/track-designer-dom.test.mjs)", () => {
  it("DesignerCanvas: fit() frames the loop; an arrow nudge comes back as a lattice-aligned edit", () => {
    const canvas = screenCanvas();
    const changes: ({ pts: Pt[]; kind: string } | { begin: true })[] = [];
    const cv = DC.create(canvas, { onChange: (pts, kind) => changes.push({ pts, kind }), onBegin: () => changes.push({ begin: true }) });
    const pts: Pt[] = [[0, 0], [100, 0], [100.125, 60.3], [0, 60]];
    cv.setPoints(pts);
    const v = cv.view();
    expect(v.w).toBe(640); expect(v.h).toBe(400);
    ok(Math.abs(v.cx - 50) < 1 && Math.abs(v.cz - 30) < 1, "centred on the loop: " + JSON.stringify(v));
    ok(v.scale > 3 && v.scale < 6, "scaled to fit 100 m into 640 px with margin: " + v.scale);
    cv.setSelection(2, -1);
    dispatch(canvas, { type: "keydown", key: "ArrowLeft", shiftKey: true });
    expect(changes.length).toBe(2);
    expect(plain(changes[0])).toEqual({ begin: true });
    const c1 = changes[1] as { pts: Pt[]; kind: string };
    expect(c1.kind, "a keyboard nudge (the designer folds a run of them into one UNDO)").toBe("nudge");
    expect(plain(c1.pts[2]), "10 m left, snapped to the 0.25 m lattice").toEqual([90.25, 60.25]);
    expect(pts[2], "the array it was handed is untouched").toEqual([100.125, 60.3]);
    cv.setBuilt(null); cv.setIssues([]); cv.render(); cv.zoom(2);
    ok(cv.view().scale > v.scale);
  });

  it("DesignerCanvas: lostpointercapture abandons a drag (no phantom pinch after a hidden dialog)", () => {
    const h = bootCanvas();
    h.fire("pointerdown", h.scr(h.pts[2]!), 1);
    h.fire("lostpointercapture", {}, 1);              // the dialog hid mid-drag: no pointerup ever comes
    const a = h.scr(h.pts[5]!);
    h.fire("pointerdown", a, 2);
    h.fire("pointermove", { clientX: a.clientX + 30, clientY: a.clientY }, 2);
    h.fire("pointerup", { clientX: a.clientX + 30, clientY: a.clientY }, 2);
    expect(h.ev.changes.length, "the next touch is a drag, not the second finger of a pinch").toBe(1);
    expect(h.ev.changes[0]!.kind).toBe("move");
    // reset() (the designer calls it on open / close) clears a stuck pointer too.
    h.fire("pointerdown", h.scr(h.pts[7]!), 3);
    h.cv.reset();
    h.tap(h.scr(h.pts[9]!), 4);
    expect(h.ev.picks).toEqual([9]);
  });

  it("DesignerCanvas: double-tap deletes only under SELECT and only the handle both taps picked", () => {
    const h = bootCanvas();
    const at = h.scr(h.pts[6]!);
    h.cv.setTool("corner");
    h.tap(at); h.tap(at); h.fire("dblclick", at);
    expect(h.ev.deletes, "a stamp tool's double-tap is two stamps, never a delete").toEqual([]);
    h.cv.setTool("select");
    h.tap(at); h.tap(at); h.fire("dblclick", at);
    expect(h.ev.deletes, "two picks of one handle under SELECT").toEqual([6]);
    // Two quick taps on the ROAD: the first inserts a point, the second lands on it.
    const mid = h.scr([(h.pts[5]![0] + h.pts[6]![0]) / 2, (h.pts[5]![1] + h.pts[6]![1]) / 2]);
    h.tap(mid); h.tap(mid); h.fire("dblclick", mid);
    expect(h.ev.changes.filter((c) => c.kind === "insert").length).toBe(1);
    expect(h.ev.deletes, "the inserted point is not deleted by the same double-tap").toEqual([6]);
  });

  it("DesignerCanvas: a tap on the road at the point cap inserts nothing and says so (bug-hunt H10)", () => {
    const h = bootCanvas();
    // 200 points in four tight clusters, so the long edges between them are far from every handle.
    const max = CustomTracks.LIMITS.ptsMax, ring: Pt[] = [], corners: Pt[] = [[-1000, -700], [1000, -700], [1000, 700], [-1000, 700]];
    for (const c of corners) for (let i = 0; i < max / 4; i++) ring.push([c[0] + i * 0.25, c[1]]);
    h.cv.setPoints(ring); h.cv.fit();
    const edge = [(ring[49]![0] + ring[50]![0]) / 2, (ring[49]![1] + ring[50]![1]) / 2];
    h.tap(h.scr(edge));
    expect(h.ev.changes.filter((c) => c.kind === "insert").length, "the 201st point is refused (validate and the registry both red it)").toBe(0);
    expect(h.ev.limits, "the screen is told, so it can say why").toEqual(["points"]);
    h.cv.setPoints(ring.slice(0, max - 1)); h.cv.fit();
    h.tap(h.scr(edge));
    expect(h.ev.changes.filter((c) => c.kind === "insert").length, "one under the cap still inserts").toBe(1);
    // SKIPPED: the designer.js source-regex assertion (track-designer-dom.test.mjs:719) pins
    // designer.js's onLimit wording; it belongs with the designer.ts port.
  });

  it("DesignerCanvas: a drag stops at the storage bounds; a preview landing mid-drag keeps the road stale", () => {
    const h = bootCanvas();
    const tr: CanvasTrack = { n: h.pts.length, px: h.pts.map((p) => p[0]), pz: h.pts.map((p) => p[1]), hw: h.pts.map(() => 7), total: 1600 };
    h.cv.setBuilt(tr);
    const a = h.scr(h.pts[3]!);
    // Select first, then press-drag (select-without-move: first press may still
    // arm a mouse drag past DRAG_MOUSE once the threshold is crossed).
    h.fire("pointerdown", a);
    h.fire("pointermove", { clientX: a.clientX + 40, clientY: a.clientY });
    h.fills.length = 0;
    h.cv.setBuilt(tr);                                 // the 80 ms preview of the PREVIOUS edit
    ok(h.fills.includes(DC.COL.roadStale) && !h.fills.includes(DC.COL.road), "still drawn stale: " + h.fills.join(","));
    h.fire("pointerup", { clientX: a.clientX + 40, clientY: a.clientY });
    h.cv.zoom(1e-6);                                   // MIN_SCALE: the canvas spans tens of km
    const b0 = h.scr(h.ev.changes[0]!.pts[3]!);
    h.fire("pointerdown", b0);
    h.fire("pointermove", { clientX: 1e6, clientY: -1e6 });
    h.fire("pointerup", { clientX: 1e6, clientY: -1e6 });
    const p = h.ev.changes[h.ev.changes.length - 1]!.pts[3];
    expect(plain(p), "clamped to ±10 km, so the design stays saveable").toEqual([CustomTracks.LIMITS.coord, -CustomTracks.LIMITS.coord]);
  });

  it("DesignerCanvas: select-without-move: tap keeps coords; jitter below threshold keeps coords; drag on selected moves", () => {
    const h = bootCanvas();
    expect(DC.DRAG_MOUSE).toBe(6);
    expect(DC.DRAG_TOUCH).toBe(10);
    expect(DC.HIT_TOUCH).toBe(44);
    const i = 4;
    const before = plain(h.pts[i]);
    const at = h.scr(h.pts[i]!);
    // Tap: select only, no onChange.
    h.tap(at);
    expect(h.ev.picks, "tap picks the node").toEqual([i]);
    expect(h.ev.changes.length, "tap does not move").toBe(0);
    expect(h.cv.selection().sel, "canvas selection follows the tap").toBe(i);
    expect(plain(h.pts[i]), "coordinates unchanged after tap").toEqual(before);
    // Below-threshold jitter while selected (mouse DRAG_MOUSE = 6).
    h.fire("pointerdown", at, 2, { pointerType: "mouse" });
    h.fire("pointermove", { clientX: at.clientX + 4, clientY: at.clientY + 3 }, 2, { pointerType: "mouse" });
    h.fire("pointerup", { clientX: at.clientX + 4, clientY: at.clientY + 3 }, 2, { pointerType: "mouse" });
    expect(h.ev.changes.length, "below-threshold jitter does not move").toBe(0);
    // Already selected + drag above threshold → move.
    h.fire("pointerdown", at, 3, { pointerType: "mouse" });
    h.fire("pointermove", { clientX: at.clientX + 40, clientY: at.clientY }, 3, { pointerType: "mouse" });
    h.fire("pointerup", { clientX: at.clientX + 40, clientY: at.clientY }, 3, { pointerType: "mouse" });
    expect(h.ev.changes.length, "deliberate drag moves").toBe(1);
    expect(h.ev.changes[0]!.kind).toBe("move");
    expect(plain(h.ev.changes[0]!.pts[i]), "coordinates changed").not.toEqual(before);
  });

  it("DesignerCanvas: empty-space drag pans without moving nodes; touch tap does not move", () => {
    const h = bootCanvas();
    const i = 8;
    const before = plain(h.pts.map((p) => p.slice()));
    const v0 = h.cv.view();
    // Empty space far from every handle.
    const empty = { clientX: 8, clientY: 8 };
    h.fire("pointerdown", empty, 1, { pointerType: "mouse" });
    h.fire("pointermove", { clientX: 48, clientY: 28 }, 1, { pointerType: "mouse" });
    h.fire("pointerup", { clientX: 48, clientY: 28 }, 1, { pointerType: "mouse" });
    expect(h.ev.changes.length, "pan never edits points").toBe(0);
    expect(plain(h.pts)).toEqual(before);
    const v1 = h.cv.view();
    ok(Math.abs(v1.cx - v0.cx) > 0.01 || Math.abs(v1.cz - v0.cz) > 0.01, "view panned");
    // Touch tap on a handle: select only (needs hold or prior select to drag).
    const at = h.scr(h.pts[i]!);
    h.fire("pointerdown", at, 2, { pointerType: "touch" });
    h.fire("pointermove", { clientX: at.clientX + 8, clientY: at.clientY + 6 }, 2, { pointerType: "touch" }); // < DRAG_TOUCH
    h.fire("pointerup", { clientX: at.clientX + 8, clientY: at.clientY + 6 }, 2, { pointerType: "touch" });
    expect(h.ev.changes.length, "touch jitter below threshold does not move").toBe(0);
    expect(h.ev.picks.at(-1)).toBe(i);
  });
});

// ════════════════════════════ DesignerProfile ════════════════════════════
const PW = 640, PH = 72;
interface Arc { x: number; y: number; r: number }

/** designer-profile.test.mjs:15 boot(). */
function bootProfile(heights?: number[] | null, hooks: ProfileHooks = {}) {
  const { canvas, box } = boxCanvas({ left: 0, top: 0, right: PW, bottom: PH, width: PW, height: PH });
  const rec = { arcs: [] as Arc[], texts: [] as string[] };
  setContext(canvas, new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => {
      if (k === "arc") return (x: number, y: number, r: number) => rec.arcs.push({ x, y, r });
      if (k === "fillText") return (s: unknown) => rec.texts.push(String(s));
      if (k === "clearRect") return () => { rec.arcs.length = 0; rec.texts.length = 0; };
      return k in t ? t[k] : () => {};
    },
    set: (t, k, v) => { t[k] = v; return true; },
  }));
  const d = design();
  const v = V.check(d);
  const tr = v.tr!;
  const n = d.pts.length;
  let list = Array.isArray(heights) ? heights.slice() : new Array<number>(n).fill(0);
  while (list.length < n) list.push(0);
  list = list.slice(0, n);
  const ev = { changes: [] as { i: number; h: number; live: boolean; all: number[] | null }[], selects: [] as { i: number; j: number }[] };
  let pr: DesignerProfile.DesignerProfileApi | null = null;
  pr = DP.create(canvas, {
    ...hooks,
    onChange: (i, h, live, all) => {
      ev.changes.push({ i, h, live, all: all ? all.slice() : null });
      if (!live) {
        list = Array.isArray(all) ? all.slice() : list.slice();
        if (!Array.isArray(all)) list[i] = h;
        pr!.setHeights(list);
      }
    },
    onSelect: (i, j) => ev.selects.push({ i, j }),
  });
  pr.setBuilt(tr, null, d.pts);
  pr.setHeights(list);
  // Visible grip arcs: r ≥ 7 (mouse); ignore larger touch halos.
  const grips = () => rec.arcs.filter((a) => a.r >= 7 && a.r <= 20);
  const fire = (type: string, at: { x: number; y: number }, id = 1, extra?: object) => dispatch(canvas, Object.assign({ type, pointerId: id, clientX: at.x, clientY: at.y }, extra));
  const key = (k: string, extra?: object) => dispatch(canvas, Object.assign({ type: "keydown", key: k }, extra));
  return { canvas, box, pr: pr as DesignerProfile.DesignerProfileApi, tr, d, ev, rec, grips, fire, key, list: () => list, n };
}
const commits = (ev: { changes: { live: boolean; i: number; h: number; all: number[] | null }[] }) => ev.changes.filter((c) => !c.live);

describe("DesignerProfile (f1-game tests/unit/designer-profile.test.mjs)", () => {
  it("profile picks the entire column and maps zoomed touch coordinates correctly", () => {
    const h = bootProfile();
    Object.defineProperty(h.canvas, "clientWidth", { value: PW });
    Object.defineProperty(h.canvas, "clientHeight", { value: PH });
    h.box.rect = { left: 10, top: 20, width: PW * 1.25, height: PH * 1.25 };
    h.pr.resize();
    const g = h.grips()[4]!;
    h.fire("pointerdown", { x: 10 + g.x * 1.25, y: 21 }, 1, { pointerType: "touch" });
    h.fire("pointerup", { x: 10 + g.x * 1.25, y: 21 }, 1, { pointerType: "touch" });
    expect(h.pr.selected(), "selection follows horizontal position even away from the grip").toBe(4);
    expect(commits(h.ev).length).toBe(0);
  });

  it("range dragging selects points without editing heights; zoom and pan stay view-only", () => {
    const h = bootProfile(null, { rangeSelect: () => true });
    const gs = h.grips(), a = gs[2]!, b = gs[7]!;
    h.fire("pointerdown", { x: a.x, y: 2 }, 1, { pointerType: "mouse" });
    h.fire("pointermove", { x: b.x, y: 55 });
    h.fire("pointerup", { x: b.x, y: 55 });
    expect(plain(h.pr.selection())).toEqual({ sel: 2, span: 7 });
    expect(h.ev.changes.length, "a range gesture never becomes a height drag").toBe(0);
    h.pr.zoom(4);
    expect(h.pr.view().span).toBe(0.25);
    h.pr.pan(10);
    expect(h.pr.view().start).toBe(0.75);
    h.pr.fit();
    expect(plain(h.pr.view())).toEqual({ start: 0, span: 1 });
    expect(h.ev.changes.length).toBe(0);
  });

  it("armed range end preserves the profile's existing anchor", () => {
    const h = bootProfile(null, { extendSelection: () => true });
    const g = h.grips()[8]!;
    h.pr.select(3);
    h.fire("pointerdown", { x: g.x, y: g.y });
    h.fire("pointerup", { x: g.x, y: g.y });
    expect(plain(h.pr.selection())).toEqual({ sel: 3, span: 8 });
    expect(h.ev.changes.length).toBe(0);
  });

  it("one grip per control point; touch hit radius is ≥44 px", () => {
    const h = bootProfile();
    expect(h.canvas.tabIndex).toBe(0);
    expect(h.canvas.getAttribute("role")).toBe(null);
    ok(h.grips().length >= h.n, "a grip arc per control point");
    expect(DP.HIT_TOUCH).toBe(44);
    ok(DP.HIT_TOUCH >= 44);
  });

  it("dragging a grip up sets the node height and commits ONCE on release", () => {
    const h = bootProfile();
    h.pr.render();
    const gs = h.grips();
    ok(gs.length >= 1, "grips drawn");
    // Hit the first grip by its recorded centre.
    const g = gs[0]!;
    h.fire("pointerdown", { x: g.x, y: g.y }, 1, { pointerType: "mouse" });
    ok(h.ev.selects.length >= 1, "press selects a node");
    const i = h.pr.selected();
    ok(i >= 0);
    for (let dy = 10; dy <= 200; dy += 20) h.fire("pointermove", { x: g.x, y: g.y - dy });
    ok(h.ev.changes.some((c) => c.live), "live changes while dragging");
    expect(commits(h.ev).length, "nothing committed mid-drag").toBe(0);
    h.fire("pointerup", { x: g.x, y: g.y - 200 });
    expect(commits(h.ev).length, "one commit on release").toBe(1);
    expect(commits(h.ev)[0]!.i).toBe(i);
    ok(commits(h.ev)[0]!.h > 0, "drag up raises height: " + commits(h.ev)[0]!.h);
  });

  it("select-without-move: tap keeps height; below-threshold jitter keeps height; drag on selected moves", () => {
    const hs = new Array<number>(16).fill(0); hs[2] = 4;
    const h = bootProfile(hs);
    h.pr.render();
    const g = h.grips()[2] || h.grips()[0]!;
    ok(g, "grip drawn");
    const h0 = h.list()[h.pr.selected() >= 0 ? h.pr.selected() : 2];
    // Tap: select only.
    h.fire("pointerdown", { x: g.x, y: g.y }, 1, { pointerType: "mouse" });
    const i = h.pr.selected();
    ok(i >= 0);
    h.fire("pointerup", { x: g.x, y: g.y }, 1, { pointerType: "mouse" });
    expect(commits(h.ev).length, "tap does not commit a height change").toBe(0);
    expect(h.list()[i], "tap keeps the node's height").toBe(4);
    // Below-threshold vertical jitter (mouse DRAG_MOUSE = 6).
    h.fire("pointerdown", { x: g.x, y: g.y }, 2, { pointerType: "mouse" });
    h.fire("pointermove", { x: g.x + 20, y: g.y - 4 }, 2, { pointerType: "mouse" }); // horizontal ignored; |dy|<6
    h.fire("pointerup", { x: g.x + 20, y: g.y - 4 }, 2, { pointerType: "mouse" });
    expect(commits(h.ev).length, "below-threshold jitter does not move height").toBe(0);
    expect(h.list()[i]).toBe(4);
    // Already selected + drag above threshold → height changes.
    h.fire("pointerdown", { x: g.x, y: g.y }, 3, { pointerType: "mouse" });
    expect(h.pr.selected(), "still selected").toBe(i);
    h.fire("pointermove", { x: g.x + 40, y: g.y - 80 }, 3, { pointerType: "mouse" }); // vertical only
    h.fire("pointerup", { x: g.x + 40, y: g.y - 80 }, 3, { pointerType: "mouse" });
    expect(commits(h.ev).length, "deliberate vertical drag commits").toBe(1);
    ok(commits(h.ev)[0]!.h !== 4, "height changed from " + h0);
    expect(DP.DRAG_MOUSE).toBe(6);
    expect(DP.DRAG_TOUCH).toBe(10);
  });

  it("keyboard: [ ] pick, Up/Down height, Delete flattens, Escape clears", () => {
    const hs = new Array<number>(16).fill(0); hs[3] = 4;
    const h = bootProfile(hs);
    h.pr.select(3);
    expect(h.canvas.dataset.arrows).toBe("own");
    h.key("ArrowUp");
    expect(commits(h.ev).at(-1)!.h).toBe(5);
    h.key("ArrowDown", { shiftKey: true });
    expect(commits(h.ev).at(-1)!.h).toBe(0);
    h.pr.setHeights(h.list().map((_, i) => (i === 3 ? 4 : 0)));
    h.pr.select(3);
    h.key("Delete");
    expect(commits(h.ev).at(-1)!.h).toBe(0);
    h.pr.select(2);
    h.key("Escape");
    expect(h.pr.selected()).toBe(-1);
    expect(h.canvas.dataset.arrows).toBe("pass");
  });

  it("accessible name names the selected point height", () => {
    const n = design().pts.length;
    const hs = new Array<number>(n).fill(0); hs[1] = 3;
    const h = bootProfile(hs);
    expect(h.canvas.getAttribute("aria-label")).toMatch(new RegExp(n + " control points"));
    h.pr.select(1);
    h.pr.render();
    expect(h.canvas.getAttribute("aria-label")).toMatch(new RegExp("Point 2 of " + n + ": \\+3 m"));
  });

  it("flat elevation: one height label when max and min round equal (no colliding dual 0 m)", () => {
    const h = bootProfile();
    h.pr.render();
    const heightLabels = h.rec.texts.filter((t) => / m$/.test(t) && !/PT /.test(t));
    expect(heightLabels.length, "one coalesced label: " + heightLabels.join(",")).toBe(1);
    expect(heightLabels[0]).toBe("0 m");
  });

  it("span elev: selection API + Up/Down offset every grip in the group by the same delta", () => {
    const n = design().pts.length;
    const hs = new Array<number>(n).fill(0);
    for (let i = 2; i <= 5; i++) hs[i] = i; // relative hills inside the span
    const h = bootProfile(hs);
    h.pr.select(2, 5);
    expect(plain(h.pr.selection())).toEqual({ sel: 2, span: 5 });
    expect(plain(h.ev.selects.at(-1))).toEqual({ i: 2, j: 5 });
    h.ev.changes.length = 0;
    h.key("ArrowUp");
    expect(commits(h.ev).length).toBe(1);
    const all = plain(commits(h.ev)[0]!.all)!;
    ok(Array.isArray(all) && all.length === n, "commit carries the full heights[]");
    for (let i = 2; i <= 5; i++) expect(all[i], "point " + i + " keeps relative height").toBe(hs[i]! + 1);
    expect(all[0], "outside the span stays put").toBe(0);
    expect(all[1]).toBe(0);
    // Delete flattens the whole span.
    h.ev.changes.length = 0;
    h.key("Delete");
    const flat = plain(commits(h.ev).at(-1)!.all)!;
    for (let i = 2; i <= 5; i++) expect(flat[i], "span flattened").toBe(0);
  });

  for (const sign of [1, -1]) {
    const bound = sign * 60, outward = sign > 0 ? "ArrowUp" : "ArrowDown";
    it("span keyboard offsets preserve relative hills at " + bound + " m", () => {
      const hs = new Array<number>(design().pts.length).fill(0);
      hs[2] = sign * 58; hs[3] = sign * 59;
      const h = bootProfile(hs);
      h.pr.select(2, 3);
      h.key(outward, { shiftKey: true });
      expect(commits(h.ev).length).toBe(1);
      expect(plain(h.list()).slice(2, 4), "the whole group stops at its first boundary").toEqual([sign * 59, bound]);
      expect(h.list()[1], "outside the span stays put").toBe(0);
      h.key(outward);
      expect(commits(h.ev).length, "a blocked offset does not commit or flatten the group").toBe(1);
      expect(plain(h.list()).slice(2, 4)).toEqual([sign * 59, bound]);
      h.key(sign > 0 ? "ArrowDown" : "ArrowUp");
      expect(plain(h.list()).slice(2, 4), "the group can move away from the boundary").toEqual(hs.slice(2, 4));
      h.pr.select(2);
      h.key(outward, { shiftKey: true });
      expect(h.list()[2], "a single node still reaches its own boundary").toBe(bound);
    });

    it("span drag preview and release preserve relative hills at " + bound + " m", () => {
      const hs = new Array<number>(design().pts.length).fill(0);
      hs[2] = sign * 58; hs[3] = sign * 59;
      const h = bootProfile(hs);
      h.pr.select(2, 3);
      // Select the grip by column: selected grip halos add extra recorded arcs.
      const g = h.grips().find((p) => p.r === 9)!;
      ok(g, "selected anchor grip drawn");
      const to = { x: g.x, y: g.y - sign * 2000 };
      h.fire("pointerdown", g, 1, { pointerType: "mouse" });
      h.fire("pointermove", to);
      expect(commits(h.ev).length, "preview does not commit").toBe(0);
      ok(h.ev.changes.some((c) => c.live), "drag emits a live preview");
      for (const c of h.ev.changes) {
        expect(plain(c.all)!.slice(2, 4), "live group stops together").toEqual([sign * 59, bound]);
        expect(c.h, "live anchor reports the bounded offset").toBe(sign * 59);
      }
      h.fire("pointerup", to);
      expect(commits(h.ev).length, "one commit on release").toBe(1);
      expect(plain(h.list()).slice(2, 4)).toEqual([sign * 59, bound]);
      expect(h.list()[1], "outside the span stays put").toBe(0);
      const before = h.ev.changes.length;
      h.fire("pointerdown", g, 2, { pointerType: "mouse" });
      h.fire("pointermove", to, 2);
      h.fire("pointerup", to, 2);
      expect(h.ev.changes.length, "dragging beyond the bound emits no change").toBe(before);
      expect(plain(h.list()).slice(2, 4)).toEqual([sign * 59, bound]);
    });
  }

  it("destroy removes every input subscription and is idempotent", () => {
    const h = bootProfile();
    const removed: string[] = [];
    const remove = h.canvas.removeEventListener.bind(h.canvas);
    h.canvas.removeEventListener = ((type: string, fn: EventListener) => { removed.push(type); remove(type, fn); }) as typeof h.canvas.removeEventListener;
    h.pr.destroy(); h.pr.destroy();
    expect(removed.sort()).toEqual(["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "keydown"].sort());
    const before = JSON.stringify(h.ev);
    dispatch(h.canvas, { type: "keydown", key: "ArrowUp" });
    expect(JSON.stringify(h.ev)).toBe(before);
  });

  for (const dy of [-8, 8]) {
    it("held elevation grip applies live delta once: " + dy, () => {
      const h = bootProfile();
      const before = h.grips()[0]!;
      const span = Math.max(8, Math.max(...h.tr.py) - Math.min(...h.tr.py));
      h.fire("pointerdown", before, 1, { pointerType: "mouse" });
      h.fire("pointermove", { x: before.x, y: before.y + dy });
      const change = h.ev.changes.find((c) => c.live)!;
      ok(change);
      const selected = h.rec.arcs.find((a) => a.r === 9)!;
      const expected = before.y - change.h * (PH - 6) / span;
      ok(Math.abs(selected.y - expected) < 0.05, `${selected.y} should follow live profile ${expected}`);
      expect(commits(h.ev).length).toBe(0);
      h.fire("pointerup", { x: before.x, y: before.y + dy });
      expect(commits(h.ev)[0]!.h).toBe(change.h);
    });
  }

  it("dense polygon: idle grips shrink to the point spacing instead of a solid band of circles", () => {
    const h = bootProfile();
    const tr = h.tr, n = 300, pts: Pt[] = [];
    for (let i = 0; i < n; i++) { const k = Math.floor(i / n * tr.n); pts.push([tr.px[k]!, tr.pz[k]!]); }
    h.pr.setBuilt(tr, null, pts);
    h.pr.setHeights(new Array(n).fill(0).map((_, i) => Math.round(5 * Math.sin(i / 9) * 4) / 4));
    h.pr.render();
    const gap = PW / n;
    const arcs = h.rec.arcs.filter((a) => a.r < 20);
    ok(arcs.length >= n, "every control point is still drawn");
    ok(arcs.every((a) => a.r <= gap * 0.5 + 1e-6 || a.r <= 1.5), "no idle grip is wider than ~half its spacing (was 7 px: overlapping band)");
  });
});

// ════════════════════════════ DesignerFollowup ════════════════════════════
describe("DesignerFollowup (f1-game tests/unit/designer-props.test.mjs)", () => {
  it("mixed recipes give exact immutable proposals and refuse kind/total limits atomically", () => {
    const P = TrackDesignerProps;
    const R = DesignerFollowup.recipe, state = { design: design(), sel: 2, span: 6 } as RecipeState;
    const before = JSON.stringify(state), corner = R(state, "corner"), hedge = R(state, "hedge");
    expect(corner.ok).toBe(true); expect(plain(corner.added!.map(p => p.kind))).toEqual(["marshal", "camera"]);
    expect(hedge.added!.length).toBe(3); expect(new Set(hedge.added!.map(p => p.s)).size).toBe(3);
    expect(JSON.stringify(state)).toBe(before);
    for (const kind of ["marshal", "camera", "hedge"] as const) {
      const full = { ...state, design: design({ props: Array.from({ length: P.CAPS[kind] }, (_, i) => ({ kind, s: i / 10, side: 1, gap: 20 })) }) } as RecipeState;
      const snap = JSON.stringify(full); expect(R(full, kind === "hedge" ? "hedge" : "corner").ok).toBe(false); expect(JSON.stringify(full)).toBe(snap);
    }
    const full: DesignerProp[] = []; for (const kind of P.KINDS) for (let i = 0; i < P.CAPS[kind] && full.length < P.TOTAL; i++) full.push({ kind, s: i / 10, side: 1, gap: 20 } as DesignerProp);
    expect(R({ ...state, design: design({ props: full }) } as RecipeState, "corner").ok).toBe(false);
    expect(R({ ...state, sel: -1 }, "corner").ok).toBe(false);
    expect(R({ ...state, span: -1 }, "hedge").ok).toBe(false);
  });
});

// ═══════════ Panels: build-and-refresh smoke tests (not from f1-game) ═══════════
// f1-game covers these four panels only through the whole TrackDesigner screen
// (track-designer-dom.test.mjs), which belongs with the designer.ts port.
const kit = () => {
  const clicks: string[] = [];
  const btn: BtnFn = (label, cls, onClick) => {
    const b = el("button", cls, label); b.type = "button";
    b.addEventListener("click", (ev) => { clicks.push(label); onClick(ev); });
    return b;
  };
  const group: GroupFn = (label) => DesignerWorkspace.group(el, label);
  return { el, btn, group, clicks };
};
const buttons = (root: Element, text?: string) => [...root.querySelectorAll("button")].filter((b) => text == null || b.textContent === text);

describe("designer panels on happy-dom (smoke)", () => {
  it("DesignerWorkspace.group: FOLDS labels become open/closed <details>, others a <div>", () => {
    const road = DesignerWorkspace.group(el, "ROAD"), turns = DesignerWorkspace.group(el, "TURNS"), sel = DesignerWorkspace.group(el, "SELECT POINTS");
    expect(road.tagName).toBe("DETAILS"); expect((road as HTMLDetailsElement).open).toBe(true);
    expect(turns.tagName).toBe("DETAILS"); expect((turns as HTMLDetailsElement).open).toBe(false);
    expect(road.dataset.role).toBe("inspector-section");
    expect(sel.tagName).toBe("DIV"); expect(sel._label.textContent).toBe("SELECT POINTS");
    expect(road.firstElementChild).toBe(road._label);
  });

  it("DesignerWorkspace.create: file menu, checks summary, help, step numbers and scroll memory", () => {
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { fn(0); return 0; });
    const { btn } = kit(), root = el("div"), foot = el("div", "td-foot"), files = el("div"); root.append(foot, files);
    const modes = el("div"); for (let i = 0; i < 3; i++) modes.appendChild(el("button"));
    const ui: WorkspaceUi = { checksGroup: el("div"), msg: el("div"), modeGroup: el("div"), modes, rail: el("div"), shape: el("details") };
    let tests = 0;
    const ws = DesignerWorkspace.create({ root, ui, files, el, btn, onTest: () => { tests++; }, onHelp: () => {} });
    const menu = foot.querySelector("[data-role=file-menu]") as HTMLDetailsElement;
    expect(menu.contains(files)).toBe(true);
    expect([...modes.children].map((b) => (b as HTMLElement).dataset.step)).toEqual(["1", "2", "3"]);
    const checks = buttons(foot, "CHECKS · WAITING")[0]!;
    expect(checks.disabled).toBe(true);
    ws.review({ red: 2, amber: 1 });
    expect(checks.textContent).toBe("CHECKS · 2 TO FIX"); expect(checks.dataset.level).toBe("red");
    ws.review({ red: 0, amber: 0 });
    expect(checks.textContent).toBe("CHECKS · READY TO RACE");
    checks.click(); expect(tests).toBe(1);
    menu.open = true;
    const esc = dispatch(menu, { type: "keydown", key: "Escape" });
    expect(menu.open).toBe(false); expect(esc.defaultPrevented).toBe(true);
    ui.rail.scrollTop = 120; ws.remember(); ws.navigate("library"); ws.navigate("design:edit");
    ws.refresh("edit", "corner");
    expect(ui.shape.open).toBe(true);
    expect(buttons(ui.modeGroup, "HELP")[0]!.getAttribute("aria-label")).toBe("Help with edit");
  });

  it("DesignerSelection: refresh summarises the span; buttons route to the hooks", () => {
    const { el: e, btn, group } = kit(), calls: unknown[][] = [];
    const panel = DesignerSelection.create({ el: e, btn, group, onSelect: (...a) => calls.push(["select", ...a]), onMode: (id) => calls.push(["mode", id]), onCycle: (d) => calls.push(["cycle", d]), onFocus: () => calls.push(["focus"]), onView: (id) => calls.push(["view", id]) });
    panel.refresh({ design: { pts: ellipse() }, sel: 2, span: 5, mode: "edit", selectionMode: "range" });
    expect(panel.root.hidden).toBe(false);
    expect(panel.root.querySelector("[role=status]")!.textContent).toBe("4 points selected · #3 → #6");
    buttons(panel.root, "SELECT ALL")[0]!.click(); buttons(panel.root, "NEXT")[0]!.click(); buttons(panel.root, "RANGE")[0]!.click();
    expect(calls).toEqual([["select", 0, 35], ["cycle", 1], ["mode", "range"]]);
    const point = panel.root.querySelector("input[aria-label='Selected point number']") as HTMLInputElement;
    point.value = "7"; point.dispatchEvent(new Event("change"));
    expect(calls.at(-1)).toEqual(["select", 6, -1]);
    panel.refresh({ design: { pts: ellipse() }, sel: -1, span: -1, mode: "test", selectionMode: "point" });
    expect(panel.root.hidden).toBe(true);
  });

  it("DesignerBridges: add at the selected point, then edit and remove through onChange", () => {
    const { el: e, btn, group } = kit(), changes: { d: BridgeDesign; msg: string }[] = [];
    const panel = DesignerBridges.create({ el: e, btn, group, onChange: (d, msg) => changes.push({ d, msg }) });
    const d0: BridgeDesign = design();
    panel.refresh({ design: d0, sel: 3 });
    const add = buttons(panel.root, "ADD BRIDGE AT POINT")[0]!;
    expect(add.disabled).toBe(false);
    add.click();
    expect(changes.length).toBe(1); expect(changes[0]!.msg).toBe("Bridge added");
    expect(changes[0]!.d.bridges).toEqual([{ s: TrackDesignerProps.pointFrac(d0.pts, 3), halfM: 160, rise: 8 }]);
    expect(d0.bridges, "the design it was handed is untouched").toBe(undefined);
    panel.refresh({ design: changes[0]!.d, sel: 3 });
    expect(panel.root.querySelectorAll("[data-role=bridge-list] li").length).toBe(1);
    buttons(panel.root, "REMOVE")[0]!.click();
    expect(changes[1]!.msg).toBe("Bridge removed"); expect(changes[1]!.d.bridges).toEqual([]);
  });

  it("DesignerScenery: theme search, prop chips and placement preferences", () => {
    const { el: e, btn, group } = kit(), calls: unknown[][] = [];
    const rec = (name: string) => (...a: unknown[]) => { calls.push([name, ...a]); };
    const panel = DesignerScenery.create({ el: e, btn, group, onTheme: rec("theme"), onLook: rec("look"), onPreset: rec("preset"), onKind: rec("kind"), onPlace: rec("place"), onRemove: rec("remove"), onRemoveAt: rec("removeAt"), onSelect: rec("select"), onEditAt: rec("editAt"), onCopyAt: rec("copyAt"), onRecipe: () => true });
    const kind: PropKind = "stand";
    panel.refresh({ design: design(), sel: 2, span: -1, propKind: kind });
    const count = panel.root.querySelector("[data-role=theme-results]")!;
    expect(count.textContent).toBe(TrackThemes.ORDER.length + " of " + TrackThemes.ORDER.length + " themes");
    const search = panel.root.querySelector("input[type=search]") as HTMLInputElement;
    search.value = "zzzz-no-such-theme"; search.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("No themes found. Try another search or clear filters.");
    expect(DesignerScenery.matches("parkland", "all", "")).toBe(true);
    expect(DesignerScenery.matches("parkland", "desert", "")).toBe(false);
    expect(buttons(panel.root, "PLACE AT POINT 3").length).toBe(1);
    expect(panel.placement("stand")).toEqual({ side: 1, gap: TrackDesignerProps.DEFAULT_GAP.stand, mode: "point", count: 1 });
    buttons(panel.root, "BOTH")[0]!.click();
    expect(panel.placement("stand").side).toBe(0); expect(panel.placement("gantry").side).toBe(1);
    expect(buttons(panel.root, "PLACE 2 OBJECTS").length).toBe(1);
    const props = [{ kind: "stand", s: 0.25, side: 1, gap: 30 }] as DesignerProp[];
    panel.refresh({ design: design({ props }), sel: 2, span: -1, propKind: kind });
    expect(panel.root.querySelectorAll("[data-role=placed-props] li").length).toBe(1);
    buttons(panel.root.querySelector("[data-role=placed-props]")!, "REMOVE")[0]!.click();
    expect(calls.at(-1)).toEqual(["removeAt", 0]);
  });

  it("DesignerFollowup panels: recipe preview/apply, repair preview/apply, Spa memory cards", () => {
    const { el: e, btn } = kit();
    let state: RecipeState = { design: design(), sel: 2, span: 6 } as RecipeState;
    const applied: DesignerProp[][] = [];
    const recipes = DesignerFollowup.recipePanel({ el: e, btn, getState: () => state, onApply: (p) => { applied.push(p); return true; } });
    buttons(recipes.root, "PREVIEW HEDGE SECTION")[0]!.click();
    expect(recipes.root.querySelectorAll("li").length).toBe(3);
    buttons(recipes.root, "APPLY RECIPE")[0]!.click();
    expect(applied.length).toBe(1); expect(applied[0]!.length).toBe(3);
    buttons(recipes.root, "PREVIEW MARSHAL + CAMERA")[0]!.click();
    state = { ...state, sel: 3 };
    buttons(recipes.root, "APPLY RECIPE")[0]!.click();
    expect(applied.length, "a changed selection re-previews instead of applying").toBe(1);

    let current = design();
    const fixes: { d: Design; codes: string[]; msg: string }[] = [];
    const repair = DesignerFollowup.repairPanel<Design>({ el: e, btn, getDesign: () => current, check: (d) => V.check(d), onApply: (d, codes, msg) => fixes.push({ d, codes, msg }) });
    expect(repair.root.hidden).toBe(true);
    expect(repair.preview(design({ baseHW: 8 }), ["width"], "Wider")).toBe(true);
    expect(repair.root.hidden).toBe(false);
    ok(/^CURRENT · (PASS|BLOCKED) · \d+ red · \d+ amber · \d+ m$/.test(repair.root.children[1]!.textContent!), repair.root.children[1]!.textContent!);
    buttons(repair.root, "APPLY REPAIR")[0]!.click();
    expect(fixes.length).toBe(1); expect(fixes[0]!.d.baseHW).toBe(8); expect(fixes[0]!.codes).toEqual(["width"]);
    repair.preview(design({ baseHW: 8 }), ["width"], "Wider");
    current = design({ baseHW: 6 });
    buttons(repair.root, "APPLY REPAIR")[0]!.click();
    expect(fixes.length, "a changed design refuses the stale repair").toBe(1);

    const noop = new Proxy({}, { get: () => () => {}, set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noop as unknown as CanvasRenderingContext2D);
    const learning = DesignerFollowup.learningPanel({ el: e, btn });
    buttons(learning.root, "SPA CORNER MEMORY")[0]!.click();
    expect(learning.root.querySelectorAll(".td-card").length).toBe(3);
    expect(learning.root.querySelector(".td-card .td-hint")!.textContent).toMatch(/^T1 · (LEFT|RIGHT|DIRECTION UNAVAILABLE)$/);
  });
});
