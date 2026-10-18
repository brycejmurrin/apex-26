/**
 * DesignerProfile: the track designer's elevation strip under the main canvas.
 * Ported verbatim from f1-game js/editor/profile.js (DesignerProfile IIFE, :1-402).
 *
 * Draws the ENGINE-built height profile and one grip per control point (per-node
 * heights[]). Drag a grip up/down to set that node's height (0.25 m lattice,
 * ±CustomTracks.LIMITS.rise); a selected SPAN offsets every grip in the group by the
 * same delta. Touch hits ≥44 css px. Keyboard: [ ] pick, Up/Down height (Shift ×5),
 * Delete / Enter flatten the node (or span), Escape clears selection. Touches no store
 * and no engine. DOM APIs are used only inside create(), so the module imports in Node.
 *
 * Differs from f1-game:
 * - TrackShape, CustomTracks, ElevPresets and DesignerCanvas are imports, so the
 *   `typeof` guards take the loaded branch: lim() is CustomTracks.LIMITS
 *   (profile.js:20), clampH is ElevPresets.clampH (:21-25; the local fallback is
 *   gone), COL is DesignerCanvas.COL (:32; the `|| "#…"` fallbacks at each use are
 *   kept), and hill() always takes its ElevPresets branch (:399).
 * - `hooks = hooks || {}` (profile.js:31) binds a new const `hooks` from `hooksIn`.
 * - A range drag (`{ id, range, anchor }`, profile.js:152) is typed as the full
 *   ProfileDrag through a cast; its absent fields read undefined as in f1-game.
 * - paintLive reads `drag` through a local alias `d` (profile.js:129-138). Same object.
 * - setBumps takes `..._args: unknown[]` so callers that pass a list type-check.
 * - `!` non-null assertions and `as` casts are type-only; no runtime change.
 */
import * as CustomTracks from "./custom-tracks";
import * as DesignerCanvas from "./canvas";
import * as ElevPresets from "./elev-presets";
import * as TrackShape from "./shape";
import type { RPt } from "./shape";

const S = TrackShape;
const PAD = 3;
const MIN_SPAN = 8;
// Select-without-move: below these thresholds a press only selects (height unchanged).
/** Vertical drag threshold, mouse (css px). profile.js:15 */
export const DRAG_MOUSE = 6;
/** …and under a finger. profile.js:15 */
export const DRAG_TOUCH = 10;
/** Short hold before an unselected touch press may drag. profile.js:15 */
export const TOUCH_ARM_MS = 140;
/** Keyboard height steps (m). profile.js:16 */
export const KEY = Object.freeze({ rise: 1, riseBig: 5 });
/** Pick radius (css px), mouse. profile.js:17 */
export const HIT_PX = 28;
/** …and under a finger (≥44 px). profile.js:17 */
export const HIT_TOUCH = 44;
const GRIP_R = 7, GRIP_R_TOUCH = 12;
const LABEL_FONT = "11px system-ui, sans-serif";
const lim = () => CustomTracks.LIMITS;
const clampH = (h: unknown) => ElevPresets.clampH(h);
const fmtRise = (r: number) => (r < 0 ? "−" : "+") + String(Math.abs(r));
const fmtKm = (m: number) => (m / 1000).toFixed(2) + " km";

/** The built lap subset the strip reads. */
export interface ProfileTrack { n: number; py: ArrayLike<number>; total: number }
/** A validator issue as setIssues filters it. */
export interface ProfileIssue { s?: unknown; code?: unknown; level?: unknown; [k: string]: unknown }
/** Mount hooks. profile.js:29 */
export interface ProfileHooks {
  onChange?: ((i: number, height: number, live: boolean, heights?: number[]) => void) | undefined;
  onSelect?: ((sel: number, span: number) => void) | undefined;
  rangeSelect?: (() => unknown) | undefined;
  extendSelection?: (() => unknown) | undefined;
}
interface Frame { lo: number; span: number; min?: number; max?: number }
interface ProfileDrag {
  id: number; range?: boolean; anchor?: number;
  i: number; y0: number; h0: number; cur: number; moved: boolean; mpp: number; frame: Frame;
  wasSel: boolean; t0: number; touch: boolean; group: number[]; origins: number[];
}

/** Mount on a <canvas>. hooks: onChange(i, height, live, heights?), onSelect(sel, span). profile.js:30 */
export function create(canvas: HTMLCanvasElement, hooksIn?: ProfileHooks | null) {
  const hooks: ProfileHooks = hooksIn || {};
  const COL: Partial<Record<keyof typeof DesignerCanvas.COL, string>> = DesignerCanvas.COL || {};
  const g = canvas.getContext("2d")!;
  canvas.tabIndex = 0;
  let W = Math.max(1, canvas.width || 300), H = Math.max(1, canvas.height || 72), ratio = 1;
  let tr: ProfileTrack | null = null, speed: ArrayLike<number> | null = null, ticks: number[] = [];   // built lap, speeds, control arcs (m)
  let nodeH: number[] = [];                   // per-node heights (metres)
  let issues: ProfileIssue[] = [], cursor: number | null = null;
  let sel = -1, span = -1, ptype = "mouse", viewStart = 0, viewSpan = 1;
  // Drag arms only after a deliberate vertical threshold (and on touch, a
  // prior selection or short hold). Horizontal motion is ignored.
  let drag: ProfileDrag | null = null;
  let liveH: number[] | null = null;          // heights overlay while dragging
  const groupOf = (a: number, b: number) => S.spanIndices(a, b, ticks.length || nodeH.length);
  const inGroup = (i: number) => S.inSpan(i, sel, span, ticks.length || nodeH.length);
  function tellSelect() { if (hooks.onSelect) hooks.onSelect(sel, span); }

  function heightsShown() {
    if (!tr) return null;
    const h = Float64Array.from(tr.py);
    // Live drag: lift the profile near the control tick by (cur - h0).
    if (drag && drag.moved && ticks[drag.i] != null) {
      const cs = ticks[drag.i]!, half = Math.max(40, (tr.total || 1) / Math.max(8, ticks.length));
      const dy = drag.cur - drag.h0, ds = tr.total / tr.n;
      for (let k = 0; k < tr.n; k++) {
        let d = Math.abs(k * ds - cs); d = Math.min(d, tr.total - d);
        if (d < half) h[k]! += dy * 0.5 * (1 + Math.cos(Math.PI * d / half));
      }
    }
    return h;
  }
  function frameOf(h: Float64Array): Frame {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < h.length; k++) { if (h[k]! < lo) lo = h[k]!; if (h[k]! > hi) hi = h[k]!; }
    const span = Math.max(MIN_SPAN, hi - lo);
    return { lo: (lo + hi) / 2 - span / 2, span, min: lo, max: hi };
  }
  let hs: Float64Array | null = null, fr: Frame | null = null;
  const X = (sM: number) => (tr ? (sM / tr.total - viewStart) / viewSpan * W : 0);
  const Y = (h: number) => H - PAD - (h - fr!.lo) / fr!.span * (H - 2 * PAD);
  const hAt = (sM: number) => { const n = tr!.n; return hs![((Math.round(sM / tr!.total * n) % n) + n) % n]!; };
  function grip(i: number) {
    const sM = ticks[i] != null ? ticks[i]! : 0;
    // heightsShown already includes the live drag displacement.
    return { x: X(sM), y: Y(hAt(sM)) };
  }

  let destroyed = false;
  function resize() {
    if (destroyed) return;
    const bw = canvas.clientWidth, bh = canvas.clientHeight;
    if (bw > 0 && bh > 0) { W = bw; H = bh; }
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    ratio = Math.min(3, Math.max(1, ((canvas as { currentCSSZoom?: number }).currentCSSZoom || 1) * dpr));
    const pw = Math.max(1, Math.round(W * ratio)), ph = Math.max(1, Math.round(H * ratio));
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    render();
  }
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas);

  function local(ev: { clientX: number; clientY: number }) { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) * W / (r.width || W), y: (ev.clientY - r.top) * H / (r.height || H) }; }
  function hit(x: number, y: number) {
    if (!tr || !hs || !ticks.length) return -1;
    let best = -1, bd = Infinity;
    for (let i = 0; i < ticks.length; i++) {
      const p = grip(i), d = Math.abs(p.x - x);
      if (p.x < 0 || p.x > W) continue;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function choose(i: number | null | undefined, j?: number | null) {
    i = Number.isInteger(i) && (i as number) >= 0 && (i as number) < ticks.length ? i as number : -1;
    j = (i >= 0 && Number.isInteger(j) && (j as number) >= 0 && (j as number) < ticks.length && j !== i) ? j as number : -1;
    if (i === sel && j === span) return;
    sel = i; span = j;
    tellSelect();
  }
  // Bound the common offset before applying it so a span keeps its hills.
  function boundedDelta(origins: readonly number[], dh: number) {
    const cap = lim().rise;
    let lo = -Infinity, hi = Infinity;
    for (const h of origins) { lo = Math.max(lo, -cap - h); hi = Math.min(hi, cap - h); }
    return Math.min(hi, Math.max(lo, dh));
  }
  /** Offset one node (or the whole selected span) by (nu − h0) at the anchor. */
  function hand(i: number, h0: number, nu: number) {
    const group = (span >= 0 && span !== sel && inGroup(i)) ? groupOf(sel, span) : [i];
    const origins = group.map((j) => clampH(nodeH[j] || 0));
    const dh = boundedDelta(origins, clampH(nu) - clampH(h0));
    liveH = null;
    if (!dh) return false;
    nodeH = nodeH.slice();
    for (let k = 0; k < group.length; k++) nodeH[group[k]!] = clampH(origins[k]! + dh);
    if (hooks.onChange) hooks.onChange(i, nodeH[i]!, false, nodeH.slice());
    return true;
  }
  function paintLive(anchor: number, cur: number) {
    const d = drag!;
    const group = d.group || [anchor];
    const dh = boundedDelta(d.origins, clampH(cur) - clampH(d.h0));
    const next = clampH(d.h0 + dh);
    if (next === d.cur) return;
    d.cur = next;
    liveH = nodeH.slice();
    for (let k = 0; k < group.length; k++) liveH[group[k]!] = clampH((d.origins[k] || 0) + dh);
    if (hooks.onChange) hooks.onChange(anchor, liveH[anchor]!, true, liveH.slice());
  }

  function onDown(ev: PointerEvent) {
    if (ev.button != null && ev.button > 0) return;
    if (ev.pointerType) ptype = ev.pointerType;
    if (ev.preventDefault) ev.preventDefault();
    try { canvas.focus({ preventScroll: true }); } catch (_) { canvas.focus(); }
    if (drag) return;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic */ }
    const p = local(ev), i = hit(p.x, p.y);
    if (i < 0) return;
    if (hooks.rangeSelect && hooks.rangeSelect()) {
      const anchor = sel >= 0 && span < 0 ? sel : i;
      choose(anchor, i);
      drag = { id: ev.pointerId, range: true, anchor } as ProfileDrag;
      render(); return;
    }
    // Select on press: height stays until a deliberate vertical drag arms.
    // A grip inside the selected span keeps the group (group elev).
    const wasSel = sel === i || inGroup(i);
    const shift = !!(ev.shiftKey || (hooks.extendSelection && hooks.extendSelection()));
    if (shift && sel >= 0 && sel !== i) choose(sel, i);
    else if (!wasSel) choose(i, -1);
    const f = fr || { lo: 0, span: MIN_SPAN };
    const group = (span >= 0 && span !== sel && inGroup(i)) ? groupOf(sel, span) : [i];
    drag = {
      id: ev.pointerId, i, y0: p.y, h0: nodeH[i] || 0, cur: nodeH[i] || 0,
      moved: false, mpp: f.span / Math.max(1, H - 2 * PAD), frame: f,
      wasSel, t0: Date.now(), touch: ptype === "touch",
      group, origins: group.map((j) => clampH(nodeH[j] || 0)),
    };
    render();
  }
  function onMove(ev: PointerEvent) {
    if (ev.pointerType) ptype = ev.pointerType;
    if (!drag || drag.id !== ev.pointerId || !tr) return;
    const p = local(ev);
    if (drag.range) { choose(drag.anchor, hit(p.x, p.y)); render(); return; }
    const dy = p.y - drag.y0;   // vertical only: ignore dx
    if (!drag.moved) {
      const thresh = (drag.touch || ptype === "touch") ? DRAG_TOUCH : DRAG_MOUSE;
      if (Math.abs(dy) <= thresh) return;
      const held = (Date.now() - drag.t0) >= TOUCH_ARM_MS;
      // Mouse: threshold alone. Touch: already selected, or short hold, then threshold.
      if (!(drag.wasSel || ptype === "mouse" || held)) return;
      drag.moved = true;
    }
    const next = clampH(drag.h0 - dy * drag.mpp);
    paintLive(drag.i, next);
    render();
  }
  function onUp(ev: PointerEvent) {
    if (drag && drag.id === ev.pointerId) {
      try { canvas.releasePointerCapture(ev.pointerId); } catch (_) { /* */ }
      const d = drag; drag = null;
      if (d.range) { render(); return; }
      // Tap / below-threshold jitter: selection only, height unchanged.
      if (d.moved) hand(d.i, d.h0, d.cur);
      else liveH = null;
      render();
    }
  }
  function onCancel(ev: PointerEvent) {
    if (drag && drag.id === ev.pointerId) { drag = null; liveH = null; render(); }
  }
  function onKey(ev: KeyboardEvent) {
    const k = ev.key, n = ticks.length;
    if (k === "[" || k === "]" || k === "Tab") {
      if (!n) return;
      ev.preventDefault();
      const dir = (k === "[" || (k === "Tab" && ev.shiftKey)) ? -1 : 1;
      const at = sel < 0 ? (dir > 0 ? -1 : 0) : sel;
      choose(((at + dir) % n + n) % n, -1);
      render();
      return;
    }
    if (sel < 0 || sel >= n) return;
    if (k === "Escape") { ev.preventDefault(); choose(-1, -1); render(); return; }
    if (k === "Delete" || k === "Backspace" || k === "Enter") {
      ev.preventDefault();
      // Flatten the anchor (or every grip in the selected span) to 0.
      if (span >= 0 && span !== sel) {
        const group = groupOf(sel, span);
        nodeH = nodeH.slice();
        for (const j of group) nodeH[j] = 0;
        liveH = null;
        if (hooks.onChange) hooks.onChange(sel, 0, false, nodeH.slice());
      } else {
        hand(sel, nodeH[sel] || 0, 0);
      }
      render();
      return;
    }
    if (k === "ArrowUp" || k === "ArrowDown") {
      const step = (k === "ArrowUp" ? 1 : -1) * (ev.shiftKey ? KEY.riseBig : KEY.rise);
      ev.preventDefault();
      hand(sel, nodeH[sel] || 0, (nodeH[sel] || 0) + step);
      render();
    }
  }
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("lostpointercapture", onCancel);
  canvas.addEventListener("keydown", onKey);

  const KEYS = "[ ] pick a point · Up/Down set height (Shift ×5) · Delete or Enter flattens · Escape clears";
  function label() {
    const n = ticks.length;
    if (sel >= 0 && sel < n) {
      const h = (liveH && liveH[sel] != null) ? liveH[sel]! : (nodeH[sel] || 0);
      const g = (span >= 0 && span !== sel) ? (" Span " + (sel + 1) + "–" + (span + 1) + " (" + groupOf(sel, span).length + " points).") : "";
      return "Elevation profile. Point " + (sel + 1) + " of " + n + ": " + fmtRise(h) + " m" + (tr && ticks[sel] != null ? " at " + fmtKm(ticks[sel]!) : "") + "." + g + " " + KEYS;
    }
    return "Elevation profile. " + n + " control points. Tap anywhere in a point column to select, then drag vertically to set height. RANGE or shift-tap selects a section. " + KEYS;
  }
  function trace() {
    const n = tr!.n;
    g.beginPath();
    for (let k = 0; k <= n; k++) { const x = X(k / n * tr!.total), y = Y(hs![k % n]!); k ? g.lineTo(x, y) : g.moveTo(x, y); }
  }
  function render() {
    if (destroyed) return;
    const arrows = sel >= 0 ? "own" : "pass";
    if (canvas.dataset && canvas.dataset.arrows !== arrows) canvas.dataset.arrows = arrows;
    const name = label();
    if (canvas.getAttribute("aria-label") !== name) canvas.setAttribute("aria-label", name);
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!tr || !tr.py || !(tr.n > 2)) { hs = null; fr = null; return; }
    hs = heightsShown();
    fr = drag && drag.moved ? drag.frame : frameOf(hs!);
    trace(); g.lineTo(W, H); g.lineTo(0, H); g.closePath();
    g.fillStyle = COL.road || "rgba(40,44,52,0.9)"; g.fill();
    trace(); g.strokeStyle = COL.info || "#7eb8ff"; g.lineWidth = 1.5; g.stroke();
    g.strokeStyle = COL.ctrl || "rgba(154,154,168,0.75)"; g.lineWidth = 1;
    for (const t of ticks) { const x = X(t); g.beginPath(); g.moveTo(x, H - 5); g.lineTo(x, H); g.stroke(); }
    g.strokeStyle = COL.start || "#e10600"; g.lineWidth = 2;
    if (viewStart === 0) { g.beginPath(); g.moveTo(1, 0); g.lineTo(1, H); g.stroke(); }
    if (cursor != null && Number.isFinite(cursor)) {
      const x = X(cursor); g.strokeStyle = COL.sel || "#ffd166"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    for (const it of issues) {
      const x = X(it.s as number), y = Y(hAt(it.s as number));
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2);
      g.fillStyle = it.level === "red" ? (COL.red || "#ff4d4d") : (COL.amber || "#ffb020"); g.fill();
    }
    const touch = ptype === "touch";
    // A dense polygon (a built-in circuit has hundreds of points) would paint a
    // solid band of full-size grips over the profile: shrink idle dots to the
    // point spacing; hit targets stay full size (hit() is by x alone).
    const gap = W / viewSpan / Math.max(1, ticks.length), dense = gap < 2 * GRIP_R * (touch ? 1.7 : 1);
    for (let i = 0; i < ticks.length; i++) {
      const p = grip(i), on = i === sel || inGroup(i);
      if (p.x < 0 || p.x > W) continue;
      const full = (on ? GRIP_R + 2 : GRIP_R) * (touch ? GRIP_R_TOUCH / GRIP_R : 1);
      const r = on ? full : Math.max(1.5, Math.min(full, gap * 0.4));
      // Soft hit halo so touch targets read as ≥44 px (selected only when dense).
      if ((touch && !dense) || on) {
        g.beginPath(); g.arc(p.x, p.y, (touch ? HIT_TOUCH : HIT_PX) / 2, 0, Math.PI * 2);
        g.fillStyle = on ? "rgba(225,6,0,0.14)" : "rgba(246,246,249,0.06)"; g.fill();
      }
      if (on) {
        g.beginPath(); g.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
        g.strokeStyle = COL.sel || "#e10600"; g.lineWidth = 2.5; g.stroke();
      }
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fillStyle = on ? (COL.sel || "#e10600") : (COL.handle || "#f6f6f9"); g.fill();
      g.strokeStyle = "#000"; g.lineWidth = 1; g.stroke();
    }
    // heights: the lap's top and bottom (one label when they round equal; a
    // flat circuit used to paint dual colliding "0 m"s). Selected point next.
    g.font = LABEL_FONT; g.fillStyle = COL.text || "#c8c8d0"; g.textAlign = "right";
    const hiM = Math.round(fr.max!) + " m", loM = Math.round(fr.min!) + " m";
    if (hiM === loM) {
      g.textBaseline = "middle";
      g.fillText(hiM, W - 4, H / 2);
    } else {
      g.textBaseline = "top"; g.fillText(hiM, W - 4, 2);
      g.textBaseline = "bottom"; g.fillText(loM, W - 4, H - 2);
    }
    g.textAlign = "left"; g.textBaseline = "top";
    if (sel >= 0 && sel < ticks.length) {
      const h = (liveH && liveH[sel] != null) ? liveH[sel]! : (nodeH[sel] || 0);
      g.fillStyle = COL.chipText || "#f6f6f9";
      const spanTxt = (span >= 0 && span !== sel) ? (" · SPAN " + (sel + 1) + "–" + (span + 1)) : "";
      g.fillText("PT " + (sel + 1) + " · " + fmtRise(h) + " m" + spanTxt, 6, 2);
    }
    g.textAlign = "start";
  }

  function reset() { drag = null; liveH = null; render(); }
  const api = {
    setBuilt(t: ProfileTrack | null | undefined, v?: ArrayLike<number> | null, pts?: readonly RPt[] | null) {
      tr = t && t.n > 2 && t.py ? t : null;
      speed = v && tr && v.length === tr.n ? v : null;
      ticks = [];
      if (tr && Array.isArray(pts) && pts.length >= 2) {
        const L = S.polyLen(pts);
        let c = 0;
        for (let i = 0; i < pts.length && L > 0; i++) {
          ticks.push(c / L * tr.total);
          const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
          c += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
        }
        if (nodeH.length !== pts.length) {
          const next = new Array<number>(pts.length);
          for (let i = 0; i < pts.length; i++) next[i] = i < nodeH.length ? clampH(nodeH[i]) : 0;
          nodeH = next;
          if (sel >= nodeH.length) sel = -1;
          if (span >= nodeH.length) span = -1;
        }
      }
      render();
    },
    /** Per-node heights (metres). Length should match the control loop. */
    setHeights(list: readonly unknown[] | null | undefined) {
      nodeH = Array.isArray(list) ? list.map(clampH) : [];
      if (sel >= nodeH.length) sel = -1;
      if (span >= nodeH.length) span = -1;
      if (drag && drag.i >= nodeH.length) drag = null;
      liveH = null;
      render();
    },
    /** @deprecated cosine hills: ignored; kept so older harnesses do not throw. */
    setBumps(..._args: unknown[]) { /* no-op: elevation is per-node heights */ },
    setCursor(sM: unknown) { cursor = Number.isFinite(sM) ? sM as number : null; render(); },
    setIssues(list: readonly (ProfileIssue | null | undefined)[] | null | undefined) {
      issues = (Array.isArray(list) ? list : []).filter((it): it is ProfileIssue => !!it && Number.isFinite(it.s) && /^(grade|fia-grade|fia-crest|fia-sag)$/.test(it.code as string));
      render();
    },
    selected() { return sel; },
    selection() { return { sel, span }; },
    // Same path as a grip tap: update sel/span and tell the screen (POINT m stepper).
    select(i: number | null | undefined, j?: number | null) { choose(i, j); render(); },
    setSelection(i: number | null | undefined, j?: number | null) { choose(i, j); render(); },
    zoom(factor: number) {
      if (!(factor > 0)) return;
      const center = tr && sel >= 0 && ticks[sel] != null ? ticks[sel]! / tr.total : viewStart + viewSpan / 2;
      viewSpan = Math.min(1, Math.max(1 / 16, viewSpan / factor));
      viewStart = Math.max(0, Math.min(1 - viewSpan, center - viewSpan / 2)); render();
    },
    pan(delta: number) { viewStart = Math.max(0, Math.min(1 - viewSpan, viewStart + delta * viewSpan)); render(); },
    fit() { viewStart = 0; viewSpan = 1; render(); },
    view() { return { start: viewStart, span: viewSpan }; },
    resize, render, reset,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const subs: [string, EventListener][] = [["pointerdown", onDown as EventListener], ["pointermove", onMove as EventListener], ["pointerup", onUp as EventListener], ["pointercancel", onCancel as EventListener], ["lostpointercapture", onCancel as EventListener], ["keydown", onKey as EventListener]];
      for (const [type, fn] of subs) canvas.removeEventListener(type, fn);
      if (ro) ro.disconnect();
      reset();
    },
  };
  resize();
  return api;
}
/** The api create() returns. */
export type DesignerProfileApi = ReturnType<typeof create>;

// hill / ADD kept as no-op shims for older unit harnesses that import them.
/** A legacy cosine-hill record (rise clamped). profile.js:399 */
export const hill = (b?: { rise?: unknown } | null) => ({ s: 0, halfM: 160, rise: ElevPresets.clampH(b && b.rise) });
/** The legacy ADD hill. profile.js:400 */
export const ADD = Object.freeze({ halfM: 160, rise: 6 });
