/**
 * DesignerFollowup: small designer review tools (section recipes, the repair preview,
 * the Spa corner-memory cards). Ported verbatim from f1-game js/editor/followup-tools.js
 * (DesignerFollowup IIFE, :1-95). All writes use the caller's existing commit pipeline;
 * previews and memory cards never change the design. DOM APIs are used only inside the
 * panel builders, so the module imports in Node.
 *
 * Differs from f1-game:
 * - TrackDesignerProps, Tracks, TrackInsight and DesignerCanvas are imports
 *   (followup-tools.js:9, :79-86).
 * - learningPanel passes `def!` where f1-game passes a possibly-undefined Spa def into
 *   Tracks.buildCenterline (followup-tools.js:79); a missing def still throws inside
 *   the same try and shows the same fallback hint.
 * - recipe() reads `state` through a non-null alias `st` after its guard
 *   (followup-tools.js:9-24). Same object.
 * - `!` non-null assertions and `as` casts are type-only; no runtime change.
 */
import * as DesignerCanvas from "./canvas";
import * as TrackInsight from "./insight";
import * as TrackDesignerProps from "./props";
import type { DesignerProp, PropKind } from "./props";
import type { Pt } from "./shape";
import * as Tracks from "../track/core/tracks";
import type { BtnFn, ElFn } from "./workspace";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const key = (v: unknown) => JSON.stringify(v);

/** The design fields a recipe reads. */
export interface RecipeDesign { pts: Pt[]; props?: DesignerProp[] | null; [k: string]: unknown }
/** The designer state a recipe reads. */
export interface RecipeState { design: RecipeDesign; sel: number; span: number; [k: string]: unknown }
/** recipe()'s answer: a complete proposal, or a refusal. */
export type RecipeResult =
  | { ok: true; added: DesignerProp[]; props: DesignerProp[]; base: string; id?: string; reason?: undefined }
  | { ok: false; reason: string; added?: undefined; props?: undefined; base?: undefined; id?: string };

/** Construct a complete proposal or refuse it without changing any list. followup-tools.js:8 */
export function recipe(state: RecipeState | null | undefined, id: string): RecipeResult {
  const P = TrackDesignerProps, d = state && state.design;
  if (!d || !Number.isInteger(state!.sel) || state!.sel < 0 || state!.sel >= d.pts.length) return { ok: false, reason: "Select a destination point first." };
  const st = state!;
  const start = P.pointFrac(d.pts, st.sel);
  let candidates: { kind: PropKind; s: number; side: number; gap: number }[];
  if (id === "corner") candidates = (["marshal", "camera"] as const).map((kind, i) => ({ kind, s: start, side: i ? -1 : 1, gap: P.DEFAULT_GAP[kind] }));
  else if (id === "hedge") {
    if (!Number.isInteger(st.span) || st.span < 0 || st.span >= d.pts.length || st.span === st.sel) return { ok: false, reason: "Select an end point for the hedge section." };
    const end = P.pointFrac(d.pts, st.span), distance = ((end - start) % 1 + 1) % 1;
    if (distance < 1e-6) return { ok: false, reason: "Choose a section with a nonzero length." };
    candidates = [0, 0.5, 1].map((t) => ({ kind: "hedge" as const, s: start + distance * t, side: 1, gap: P.DEFAULT_GAP.hedge }));
  } else return { ok: false, reason: "Unknown recipe." };
  const c = P.counts(d.props);
  if (c.total + candidates.length > P.TOTAL) return { ok: false, reason: "Recipe exceeds the total object limit." };
  for (const p of candidates) { if (++c[p.kind] > P.CAPS[p.kind]) return { ok: false, reason: "Recipe exceeds the " + P.LABELS[p.kind] + " limit." }; }
  const added = P.sanitize(candidates)!, props = (d.props || []).concat(added);
  return { ok: true, added, props, base: key([d, st.sel, st.span]) };
}

/** recipePanel()'s inputs. followup-tools.js:26 */
export interface RecipePanelDeps {
  el: ElFn; btn: BtnFn;
  getState: () => RecipeState | null;
  onApply?: ((props: DesignerProp[]) => unknown) | undefined;
}
/** SECTION RECIPES: preview a recipe, then apply it through onApply. followup-tools.js:26 */
export function recipePanel({ el, btn, getState, onApply }: RecipePanelDeps) {
  const root = el("div", "td-group"); root.dataset.role = "scenery-recipes";
  const text = el("div", "td-hint"), rows = el("ul", "td-issues"), controls = el("div", "td-chips");
  let pending: RecipeResult | null = null;
  const cancel = () => { pending = null; rows.textContent = ""; apply.disabled = true; text.textContent = "Preview a recipe before placing its objects."; };
  const show = (id: string) => {
    pending = recipe(getState(), id); rows.textContent = ""; apply.disabled = !pending.ok;
    text.textContent = pending.ok ? pending.added.length + " objects · " + pending.props.length + "/" + TrackDesignerProps.TOTAL + " after placement" : pending.reason;
    for (const p of pending.added || []) rows.appendChild(el("li", "td-issue", TrackDesignerProps.LABELS[p.kind] + " · lap " + (p.s * 100).toFixed(4) + "% · " + (p.side < 0 ? "LEFT" : "RIGHT") + " · " + TrackDesignerProps.effectiveGap(p.kind, p.gap) + " m"));
    pending.id = id;
  };
  const apply = btn("APPLY RECIPE", "sel-edit", () => {
    if (!pending || !pending.ok) return false;
    const current = recipe(getState(), pending.id!);
    if (!current.ok || current.base !== pending.base) { show(pending.id!); text.textContent = "Selection or design changed. Review the updated preview."; return false; }
    if (onApply && onApply(clone(current.props))) { cancel(); return true; }
    return false;
  });
  controls.append(btn("PREVIEW MARSHAL + CAMERA", "sel-chip", () => show("corner")), btn("PREVIEW HEDGE SECTION", "sel-chip", () => show("hedge")), apply, btn("CANCEL RECIPE", "sel-chip", cancel));
  root.append(el("div", "td-label", "SECTION RECIPES"), controls, text, rows); cancel();
  return { root, refresh() { if (pending && pending.ok) { const s = getState()!; if (key([s.design, s.sel, s.span]) !== pending.base) cancel(); } } };
}

/** A verdict as summary() / repairPanel read it (TrackValidate.check's shape). */
export interface RepairVerdict {
  ok?: boolean;
  issues?: readonly { level: string; code: string; msg: string }[] | null;
  tr?: { total?: number } | null;
}
function summary(v: RepairVerdict | null | undefined) {
  const issues = v && v.issues || [], length = v && v.tr && v.tr.total;
  return (v && v.ok ? "PASS" : "BLOCKED") + " · " + issues.filter((i) => i.level === "red").length + " red · " + issues.filter((i) => i.level === "amber").length + " amber · " + (Number.isFinite(length) ? Math.round(length as number) + " m" : "no built lap");
}
/** repairPanel()'s inputs. followup-tools.js:52 */
export interface RepairPanelDeps<D> {
  el: ElFn; btn: BtnFn;
  getDesign: () => D;
  check: (design: D) => RepairVerdict;
  onApply: (design: D, codes: string[], message: string) => unknown;
}
/** REPAIR PREVIEW: both verdicts side by side, applied only on the unchanged design. followup-tools.js:52 */
export function repairPanel<D>({ el, btn, getDesign, check, onApply }: RepairPanelDeps<D>) {
  const root = el("div", "td-group"); root.dataset.role = "repair-preview"; root.hidden = true;
  const before = el("div", "td-hint"), after = el("div", "td-hint"), list = el("ul", "td-issues"), status = el("div", "td-hint"); status.setAttribute("role", "status");
  let pending: { base: string; design: D; codes: string[]; message: string } | null = null;
  const cancel = () => { pending = null; root.hidden = true; };
  const apply = btn("APPLY REPAIR", "sel-edit", () => {
    if (!pending) return false;
    if (key(getDesign()) !== pending.base) { pending = null; apply.disabled = true; status.textContent = "Design changed. Cancel and preview the repair again."; return false; }
    const p = pending; cancel(); onApply(clone(p.design), p.codes, p.message); return true;
  });
  root.append(el("div", "td-label", "REPAIR PREVIEW"), before, after, list, status, apply, btn("CANCEL REPAIR", "sel-chip", cancel));
  return { root, cancel, preview(next: D, codes: readonly string[], message: string) {
    const current = getDesign(), proposal = clone(next); let a: RepairVerdict, b: RepairVerdict;
    try { a = check(clone(current)); b = check(proposal); } catch (_) { cancel(); return false; }
    pending = { base: key(current), design: proposal, codes: codes.slice(), message };
    before.textContent = "CURRENT · " + summary(a); after.textContent = "PROPOSED · " + summary(b); list.textContent = "";
    for (const [label, v] of [["Current", a], ["Proposed", b]] as const) for (const it of v.issues || []) list.appendChild(el("li", "td-issue", label + " · " + it.level + " · " + it.code + " · " + it.msg));
    status.textContent = "Review both verdicts. Applying may leave issues to resolve; UNDO restores the current design.";
    root.hidden = false; apply.disabled = false; apply.focus(); return true;
  } };
}

/** learningPanel()'s inputs. followup-tools.js:73 */
export interface LearningPanelDeps { el: ElFn; btn: BtnFn }
/** SPA CORNER MEMORY: read-only recall cards over Spa's curated apexes. followup-tools.js:73 */
export function learningPanel({ el, btn }: LearningPanelDeps) {
  const root = el("div", "td-group"); root.dataset.role = "corner-memory";
  const content = el("div", "td-chips"), hint = el("div", "td-hint", "Read-only Spa pilot: three curated apexes. Hide the labels and recall each turn's number and direction.");
  const open = btn("SPA CORNER MEMORY", "sel-chip", () => {
    if (content.children.length) { content.hidden = !content.hidden; open.setAttribute("aria-expanded", String(!content.hidden)); return; }
    try {
      const def = Tracks.LIST.find((d) => d.id === "spa"), tr = Tracks.buildCenterline(def!, { line: false });
      for (const card of TrackInsight.memoryCards(tr, def!.turns)) {
        const row = el("div", "td-card"), map = el("canvas"), label = el("div", "td-hint"); map.width = 240; map.height = 160;
        const answer = "T" + card.n + " · " + (card.dir < 0 ? "RIGHT" : card.dir > 0 ? "LEFT" : "DIRECTION UNAVAILABLE"); let revealed = true;
        map.setAttribute("role", "img"); map.setAttribute("aria-label", "Spa map with one highlighted apex");
        const toggle = btn("HIDE LABEL", "sel-chip", () => { revealed = !revealed; label.textContent = revealed ? answer : "Recall this turn"; toggle.textContent = revealed ? "HIDE LABEL" : "REVEAL LABEL"; toggle.setAttribute("aria-expanded", String(revealed)); });
        label.textContent = answer; toggle.setAttribute("aria-expanded", "true"); row.append(map, label, toggle); content.appendChild(row);
        DesignerCanvas.thumb(map, tr, { apex: card.sApex });
      }
      open.setAttribute("aria-expanded", "true");
    } catch (_) { hint.textContent = "Spa memory cards are unavailable. Your design is unchanged."; }
  });
  open.setAttribute("aria-expanded", "false"); root.append(open, hint, content); return { root };
}
