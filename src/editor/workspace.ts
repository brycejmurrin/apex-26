/**
 * DesignerWorkspace: the Track Designer workspace: navigation, disclosure groups and
 * review actions. Ported verbatim from f1-game js/editor/workspace.js
 * (DesignerWorkspace IIFE, :1-66). Presentation state stays local; circuit edits still
 * belong to TrackDesigner. DOM APIs are used only inside group() and create(), so the
 * module imports in Node.
 *
 * Also the home of the panel-kit types the designer hands every panel (`el`, `btn`,
 * `group`), so selection-panel, bridge-panel, followup-tools and scenery-panel share one
 * definition.
 *
 * Differs from f1-game:
 * - group() stores the label element on the group as the `_label` expando
 *   (workspace.js:7), typed through TdGroup; the `as` casts are type-only.
 * - `!` non-null assertions are type-only; no runtime change.
 */
import type { el as domEl } from "./dom";

/** The designer's element factory (Dom.el, src/editor/dom.ts). */
export type ElFn = typeof domEl;
/** The designer's button factory (designer.js:190): a type="button" with a click handler. */
export type BtnFn = (label: string, cls: string, onClick: (ev: MouseEvent) => unknown) => HTMLButtonElement;
/** A rail group: a <details> fold or a <div>, with its label element as `_label`. */
export type TdGroup = (HTMLDivElement | HTMLDetailsElement) & { _label: HTMLElement };
/** The designer's group(label) (designer.js:1018: DesignerWorkspace.group bound to el). */
export type GroupFn = (label: string) => TdGroup;

const FOLDS = new Set(["CORNERS", "ROAD", "ELEVATION", "BANKING & KERBS", "TURNS", "SHARE CODE"]);

/** A labelled rail group; the FOLDS labels become <details> folds. workspace.js:5 */
export function group(el: ElFn, label: string): TdGroup {
  const fold = FOLDS.has(label), g = el(fold ? "details" : "div", "td-group") as TdGroup;
  g._label = el(fold ? "summary" : "div", "td-label", label);
  if (fold) { g.dataset.role = "inspector-section"; (g as HTMLDetailsElement).open = !["TURNS", "BANKING & KERBS", "SHARE CODE", "CORNERS"].includes(label); }
  g.appendChild(g._label);
  return g;
}

/** The screen elements create() rearranges. */
export interface WorkspaceUi {
  checksGroup: HTMLElement; msg: HTMLElement; modeGroup: HTMLElement; modes: HTMLElement;
  rail: HTMLElement; shape: HTMLDetailsElement;
}
/** create()'s inputs. workspace.js:13 */
export interface WorkspaceDeps {
  root: HTMLElement; ui: WorkspaceUi; files: HTMLElement; el: ElFn; btn: BtnFn;
  onTest: () => unknown; onHelp: (ev: MouseEvent) => unknown;
}
/** review()'s verdict counts. */
export interface ReviewCounts { red: number; amber: number }

/** Wire the workspace: file menu, checks summary, HELP, step numbers, scroll memory. workspace.js:13 */
export function create({ root, ui, files, el, btn, onTest, onHelp }: WorkspaceDeps) {
  const positions = new Map<string, number>();
  let location = "design:edit", lastTool: string | null = null;
  const foot = root.querySelector<HTMLElement>(".td-foot")!;
  const menu = el("details"); menu.dataset.role = "file-menu";
  const trigger = el("summary", "sel-chip", "SHARE & FILES");
  files.remove(); menu.append(trigger, files);
  const closeMenu = (e: Event & { key?: string }) => {
    if ((e.key === "Escape" || e.type === "cancel") && menu.open && !root.hidden) {
      e.preventDefault(); e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      menu.open = false; trigger.focus();
      return true;
    }
    return false;
  };
  menu.addEventListener("keydown", closeMenu);
  menu.addEventListener("cancel", closeMenu);
  if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("keydown", closeMenu, true);
  files.addEventListener("click", () => { menu.open = false; trigger.focus(); });
  const status = el("div", "td-chips"); status.dataset.role = "workspace-status";
  const checks = btn("CHECKS · WAITING", "sel-chip", () => { onTest(); requestAnimationFrame(() => { ui.checksGroup.scrollIntoView({ block: "nearest" }); ui.checksGroup.focus(); }); });
  checks.dataset.role = "checks-summary";
  checks.disabled = true;
  ui.checksGroup.tabIndex = -1;
  ui.msg.remove(); status.append(checks, ui.msg); foot.append(menu, status);
  const help = btn("HELP", "sel-chip", onHelp); help.dataset.role = "context-help";
  ui.modeGroup.appendChild(help);
  let step = 0;
  for (const b of ui.modes.children) { (b as HTMLElement).dataset.step = String(++step); }
  function remember() { positions.set(location, ui.rail.scrollTop); }
  function navigate(key: string) {
    if (key === location) return;
    location = key;
    ui.rail.scrollTop = positions.get(key) || 0;
    menu.open = false;
  }
  function refresh(mode: string, tool: string) {
    if (tool !== lastTool && tool !== "select" && tool !== "draw") ui.shape.open = true;
    lastTool = tool;
    help.setAttribute("aria-label", "Help with " + mode);
  }
  function review(verdict: ReviewCounts | null | undefined) {
    checks.disabled = !verdict;
    if (!verdict) return;
    checks.dataset.level = verdict.red ? "red" : verdict.amber ? "amber" : "ok";
    checks.textContent = "CHECKS · " + (verdict.red ? verdict.red + " TO FIX" : verdict.amber ? verdict.amber + " WARNINGS" : "READY TO RACE");
    checks.setAttribute("aria-label", "Review design checks: " + verdict.red + " errors, " + verdict.amber + " warnings");
  }
  return { navigate, remember, refresh, review, closeMenu };
}
/** The api create() returns. */
export type DesignerWorkspaceApi = ReturnType<typeof create>;
