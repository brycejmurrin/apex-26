/**
 * DesignerSelection: the shared point / range selection controls for the map and the
 * elevation profile. Ported verbatim from f1-game js/editor/selection-panel.js
 * (DesignerSelection IIFE, :1-68). DOM APIs are used only inside create(), so the
 * module imports in Node.
 *
 * Differs from f1-game:
 * - TrackShape is an import (selection-panel.js:51).
 * - `as HTMLElement` casts over `children` are type-only; no runtime change.
 */
import * as TrackShape from "./shape";
import type { BtnFn, ElFn, GroupFn } from "./workspace";

/** The designer state refresh() reads. */
export interface SelectionState {
  design: { pts: readonly unknown[] };
  sel: number; span: number; mode: string; selectionMode: string;
}
/** create()'s inputs. selection-panel.js:4 */
export interface SelectionDeps {
  el: ElFn; btn: BtnFn; group: GroupFn;
  onSelect: (sel: number, span: number) => unknown;
  onMode: (id: string) => unknown;
  onCycle: (dir: number) => unknown;
  onFocus: (ev: MouseEvent) => unknown;
  onView: (id: string) => unknown;
}

/** Build the SELECT POINTS group (and its PROFILE VIEW row). selection-panel.js:4 */
export function create({ el, btn, group, onSelect, onMode, onCycle, onFocus, onView }: SelectionDeps) {
  const root = group("SELECT POINTS"); root.dataset.role = "selection";
  let state: SelectionState | null = null;
  const modes = el("div", "td-chips"); modes.setAttribute("aria-label", "Point selection tool");
  for (const [id, text] of [["point", "POINT"], ["range", "RANGE"]] as const) {
    const b = btn(text, "sel-chip", () => onMode(id)); b.dataset.selectionMode = id; modes.appendChild(b);
  }
  const summary = el("div", "td-hint"); summary.setAttribute("role", "status");
  const row = el("div", "td-chips"); row.dataset.role = "point-picker";
  const prev = btn("PREV", "sel-chip", () => onCycle(-1)); prev.setAttribute("aria-label", "Select previous control point");
  const point = el("input", "td-input"); point.type = "number"; point.min = "1"; point.step = "1";
  point.placeholder = "Point #"; point.setAttribute("aria-label", "Selected point number");
  const next = btn("NEXT", "sel-chip", () => onCycle(1)); next.setAttribute("aria-label", "Select next control point");
  const pickPoint = () => {
    if (state && point.value.trim() && Number.isInteger(+point.value)) onSelect(+point.value - 1, -1);
    if (state) { refresh(state); point.value = state.sel < 0 ? "" : String(state.sel + 1); }
  };
  point.addEventListener("change", pickPoint);
  point.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); pickPoint(); } });
  row.append(prev, point, next);
  const endRow = el("label", "td-chips"); endRow.dataset.role = "range-end";
  endRow.appendChild(el("span", "td-hint", "THROUGH POINT"));
  const end = el("input", "td-input"); end.type = "number"; end.min = "1"; end.step = "1";
  end.placeholder = "End #"; end.setAttribute("aria-label", "Range end point number");
  const pickEnd = () => {
    if (state && end.value.trim() && Number.isInteger(+end.value)) onSelect(state.sel < 0 ? 0 : state.sel, +end.value - 1);
    if (state) { refresh(state); end.value = state.span < 0 ? "" : String(state.span + 1); }
  };
  end.addEventListener("change", pickEnd);
  end.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); pickEnd(); } });
  endRow.appendChild(end);
  const actions = el("div", "td-chips");
  const all = btn("SELECT ALL", "sel-chip", () => state && onSelect(0, state.design.pts.length - 1));
  const clear = btn("CLEAR", "sel-chip", () => onSelect(-1, -1)); clear.setAttribute("aria-label", "Clear point selection");
  const focus = btn("FOCUS", "sel-chip", onFocus); focus.setAttribute("aria-label", "Focus selected points on the map and profile");
  actions.append(all, clear, focus);
  const hint = el("div", "td-hint");
  const view = group("PROFILE VIEW"); view.dataset.role = "profile-view";
  const viewButtons = el("div", "td-chips");
  for (const [id, label] of [["in", "ZOOM IN"], ["out", "ZOOM OUT"], ["fit", "FULL LAP"], ["left", "EARLIER"], ["right", "LATER"]] as const) {
    const b = btn(label, "sel-chip", () => onView(id)); b.dataset.profileView = id;
    b.setAttribute("aria-label", "Elevation profile " + label.toLowerCase()); viewButtons.appendChild(b);
  }
  view.appendChild(viewButtons);
  root.append(modes, summary, row, endRow, actions, hint, view);
  function refresh(s: SelectionState) {
    state = s;
    const n = s.design.pts.length, count = s.sel < 0 ? 0 : TrackShape.spanIndices(s.sel, s.span, n).length;
    root.hidden = s.mode !== "edit" && s.mode !== "elevation";
    for (const c of modes.children) { const b = c as HTMLElement; const on = b.dataset.selectionMode === s.selectionMode; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); }
    summary.textContent = count ? count + (count === 1 ? " point selected · #" + (s.sel + 1) : " points selected · #" + (s.sel + 1) + " → #" + (s.span + 1)) : "Choose a point on either view, or enter its number.";
    point.max = end.max = String(n);
    if (document.activeElement !== point) point.value = s.sel < 0 ? "" : String(s.sel + 1);
    if (document.activeElement !== end) end.value = s.span < 0 ? "" : String(s.span + 1);
    endRow.hidden = s.selectionMode !== "range" && s.span < 0;
    prev.disabled = next.disabled = all.disabled = !n;
    clear.disabled = focus.disabled = !count;
    hint.textContent = s.selectionMode === "range" ? "Drag between points, or tap a start and an end, on either view. The range follows driving order; an earlier end crosses the start line." : "Tap a point without moving it. Shift-click another point for a range. Use FOCUS to separate crowded points.";
    view.hidden = s.mode !== "elevation";
  }
  return { root, refresh };
}
/** The api create() returns. */
export type DesignerSelectionApi = ReturnType<typeof create>;
