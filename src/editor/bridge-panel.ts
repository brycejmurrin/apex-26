/**
 * DesignerBridges: the authored road-overpass controls. Ported verbatim from f1-game
 * js/editor/bridge-panel.js (DesignerBridges IIFE, :1-105). Mutations return through
 * the designer's undo/draft path; normal track validation still gates save/race. DOM
 * APIs are used only inside create(), so the module imports in Node.
 *
 * Differs from f1-game:
 * - TrackValidate and TrackDesignerProps are imports (bridge-panel.js:32, :71).
 * - `!` non-null assertions are type-only; no runtime change.
 */
import * as TrackDesignerProps from "./props";
import type { Pt } from "./shape";
import * as TrackValidate from "./validate";
import type { BtnFn, ElFn, GroupFn } from "./workspace";

/** One authored bridge: lap fraction, half span (m), rise (m). */
export interface BridgeRec { s: number; halfM: number; rise: number }
/** The design fields the panel reads (and copies through commit). */
export interface BridgeDesign { pts: Pt[]; bridges?: BridgeRec[] | null; [k: string]: unknown }
/** The designer state refresh() reads. */
export interface BridgeState { design: BridgeDesign; sel?: number | null }
/** create()'s inputs. bridge-panel.js:5 */
export interface BridgeDeps {
  el: ElFn; btn: BtnFn; group: GroupFn;
  onChange: (design: BridgeDesign, msg: string) => unknown;
}

/** Build the ROAD BRIDGES group. bridge-panel.js:5 */
export function create({ el, btn, group, onChange }: BridgeDeps) {
  const root = group("ROAD BRIDGES"); root.dataset.role = "bridges";
  let current: BridgeState | null = null, editing = -1, measuredDesign: BridgeDesign | null = null, lapM = 0;
  const intro = el("div", "td-hint", "Raise a section of road into a supported overpass. Set its span and rise, then open TEST to check slopes and crossing clearance.");
  const fields = el("div", "td-chips");
  function number(label: string, min: number, max: number, step: number, value: number) {
    const wrap = el("label", ""), input = el("input", "td-input");
    input.type = "number"; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    input.setAttribute("aria-label", label); wrap.append(el("span", "td-hint", label), input); fields.appendChild(wrap);
    return input;
  }
  const length = number("Bridge total span · m", 80, 1000, 2, 320);
  const rise = number("Bridge rise · m", 1, 30, 0.25, 8);
  const status = el("div", "td-hint"); status.dataset.role = "bridge-status"; status.setAttribute("role", "status");
  const actions = el("div", "td-chips");
  const add = btn("ADD BRIDGE AT POINT", "sel-edit", () => apply(false)); add.dataset.role = "add-bridge";
  add.disabled = true;
  const save = btn("APPLY CHANGES", "sel-edit", () => apply(true)); save.dataset.role = "apply-bridge";
  const cancel = btn("DONE EDITING", "sel-chip", () => { editing = -1; refresh(current); });
  save.hidden = cancel.hidden = true;
  actions.append(add, save, cancel);
  const list = el("ul", "td-issues"); list.dataset.role = "bridge-list"; list.setAttribute("aria-label", "Authored road bridges");
  root.append(intro, fields, actions, status, list);
  function bridges(): BridgeRec[] { return current && Array.isArray(current.design.bridges) ? current.design.bridges : []; }
  function selected() { return current && Number.isInteger(current.sel) && current.sel! >= 0 && current.sel! < current.design.pts.length; }
  function measure(d: BridgeDesign) {
    let built: ReturnType<typeof TrackValidate.build> = null;
    try { built = TrackValidate.build(d); } catch (_) { /* unfinished loop: polygon fallback */ }
    const total = built && built.tr && built.tr.total;
    if (Number.isFinite(total) && total! > 0) return total!;
    let poly = 0;
    for (let i = 0; i < d.pts.length; i++) {
      const a = d.pts[i]!, b = d.pts[(i + 1) % d.pts.length]!; poly += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return Number.isFinite(poly) ? poly : 0;
  }
  function candidate(s: number): BridgeRec | null {
    if (!length.value.trim() || !rise.value.trim()) { status.textContent = "Enter a span and rise."; return null; }
    const span = +length.value, up = +rise.value;
    if (!Number.isFinite(span) || !Number.isInteger(span) || span < 80 || span > 1000 || span % 2) {
      status.textContent = "Use an even total span from 80 to 1000 metres (whole-metre half spans)."; return null;
    }
    if (!Number.isFinite(up) || up < 1 || up > 30 || !Number.isInteger(up * 4)) {
      status.textContent = "Use a rise from 1 to 30 metres, in quarter-metre steps."; return null;
    }
    if (up > Math.floor(span / 2 / 19.6 * 4) / 4) {
      status.textContent = "Lengthen the span or lower the rise to stay within the bridge's 8% grade budget."; return null;
    }
    if (!(lapM > span)) { status.textContent = "The bridge span must be shorter than the lap. Draw a larger loop first."; return null; }
    return { s, halfM: span / 2, rise: up };
  }
  function overlaps(b: BridgeRec, except: number) {
    return bridges().some((other, i) => {
      if (i === except) return false;
      const delta = Math.abs(((b.s - other.s) % 1 + 1) % 1);
      return Math.min(delta, 1 - delta) * lapM < b.halfM + other.halfM;
    });
  }
  function commit(next: BridgeRec[], msg: string) {
    const d: BridgeDesign = Object.assign({}, current!.design, { bridges: next.map((b) => Object.assign({}, b)) });
    onChange(d, msg);
  }
  function apply(edit: boolean) {
    if (!current) return;
    const items = bridges();
    if (edit ? editing < 0 || !items[editing] : !selected() || items.length >= 24) return;
    const b = candidate(edit ? items[editing]!.s : TrackDesignerProps.pointFrac(current.design.pts, current.sel!));
    if (!b) return;
    if (overlaps(b, edit ? editing : -1)) { status.textContent = "Bridge spans overlap, including across the start line. Choose another point or shorten the span."; return; }
    const next = items.slice();
    if (edit) next[editing] = b; else next.push(b);
    editing = -1; commit(next, edit ? "Bridge updated" : "Bridge added");
  }
  function refresh(state: BridgeState | null | undefined) {
    if (!state) return;
    current = state;
    if (measuredDesign !== state.design) { measuredDesign = state.design; lapM = measure(state.design); }
    const items = bridges(); if (!items[editing]) editing = -1;
    add.disabled = !selected() || items.length >= 24;
    save.hidden = cancel.hidden = editing < 0;
    status.textContent = editing >= 0 ? "Editing bridge " + (editing + 1) + ". Apply changes to keep its current position." :
      items.length + "/24 bridges · " + (items.length >= 24 ? "Remove a bridge before adding another." : selected() ? "Add at point " + (state.sel! + 1) + "." : "Select a control point to add a bridge.");
    while (list.firstChild) list.removeChild(list.firstChild);
    for (let i = 0; i < items.length; i++) {
      const b = items[i]!, row = el("li", "");
      row.appendChild(el("span", "", "Bridge " + (i + 1) + " · " + (b.s * 100).toFixed(1) + "% lap · " + b.halfM * 2 + " m span · " + b.rise + " m rise "));
      const edit = btn("EDIT", "sel-chip", () => {
        editing = i; length.value = String(b.halfM * 2); rise.value = String(b.rise); refresh(current); length.focus();
      });
      edit.setAttribute("aria-label", "Edit road bridge " + (i + 1)); edit.setAttribute("aria-pressed", String(editing === i));
      const remove = btn("REMOVE", "sel-chip", () => {
        const next = bridges().filter((_, at) => at !== i); editing = -1; commit(next, "Bridge removed");
      });
      remove.setAttribute("aria-label", "Remove road bridge " + (i + 1)); row.append(edit, remove); list.appendChild(row);
    }
  }
  return { root, refresh };
}
/** The api create() returns. */
export type DesignerBridgesApi = ReturnType<typeof create>;
