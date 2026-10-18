/**
 * DesignerScenery: the track designer's scenery inspector (theme discovery,
 * atmosphere, trackside objects). Ported verbatim from f1-game
 * js/editor/scenery-panel.js (DesignerScenery IIFE, :1-313). Theme discovery and
 * placement preferences stay UI-only; edits go through the designer's undo/draft
 * pipeline and the existing look/props codec. DOM APIs are used only inside create(),
 * so the module imports in Node.
 *
 * Differs from f1-game:
 * - TrackThemes, TrackDesignerProps and DesignerFollowup are imports
 *   (scenery-panel.js:26, :35, :246).
 * - The `_refresh` expando on the ROADSIDE GAP row (scenery-panel.js:153) is typed
 *   through an intersection cast.
 * - create() also accepts (and ignores) `stepper`, which designer.js:1147 passes.
 * - `!` non-null assertions and `as` casts (over `children`, dataset strings and
 *   string-keyed tables) are type-only; no runtime change.
 */
import * as DesignerFollowup from "./followup-tools";
import type { RecipeState } from "./followup-tools";
import * as TrackDesignerProps from "./props";
import type { DesignerProp, PropKind } from "./props";
import type { Pt } from "./shape";
import * as TrackThemes from "./track-themes";
import type { ThemeLook } from "./track-themes";
import type { BtnFn, ElFn, GroupFn, TdGroup } from "./workspace";

/** Theme filter chips → the theme ids they show (all: every theme). scenery-panel.js:6 */
export const CATEGORIES: Readonly<Record<string, readonly string[] | null>> = Object.freeze({
  all: null,
  nature: ["parkland", "alpine", "autumn", "tuscany", "savanna", "ardennes", "winter", "jungle", "lakeside", "moorland", "vineyard", "blossom", "volcanic", "fjord", "redwood"],
  coast: ["harbour", "marina", "coast", "twilight", "lakeside", "shipyard", "island", "volcanic", "fjord"],
  mountain: ["alpine", "winter", "canyon", "volcanic", "fjord", "redwood"],
  city: ["harbour", "marina", "tilke", "airfield", "metropolis", "shipyard", "stadium"],
  desert: ["oasis", "desertnight", "canyon", "saltflat", "badlands"],
  night: ["desertnight", "marina", "twilight", "stadium"],
});
/** One atmosphere preset: its label and the look it sets. */
export interface ScenePreset { label: string; time: ThemeLook["time"]; trees: ThemeLook["trees"]; crowd: ThemeLook["crowd"] }
/** Atmosphere presets. scenery-panel.js:15 */
export const PRESETS: Readonly<Record<string, Readonly<ScenePreset>>> = Object.freeze({
  default: { label: "THEME DEFAULT", time: "auto", trees: "normal", crowd: "normal" },
  golden: { label: "GOLDEN HOUR", time: "dusk", trees: "many", crowd: "few" },
  race: { label: "RACE NIGHT", time: "night", trees: "normal", crowd: "packed" },
  practice: { label: "QUIET PRACTICE", time: "day", trees: "few", crowd: "few" },
  festival: { label: "SUNSET FESTIVAL", time: "dusk", trees: "many", crowd: "packed" },
  forest: { label: "FOREST ESCAPE", time: "day", trees: "many", crowd: "few" },
});
const LOOK_ROWS = [["time", "TIME OF DAY"], ["trees", "TREES"], ["crowd", "CROWD"]] as const;
// Match the live prop renderer's clearance floors (gap is from road edge).
/** Does theme `id` pass the category chip and every search word? scenery-panel.js:25 */
export function matches(id: string, category: string, query: unknown): boolean {
  const ids = CATEGORIES[category] || null, p = TrackThemes.get(id);
  const words = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = (p.label + " " + p.blurb).toLowerCase();
  return (!ids || ids.includes(id)) && words.every((w) => text.includes(w));
}

/** The design fields the inspector reads. */
export interface SceneryDesign { theme?: string; look?: unknown; props?: DesignerProp[] | null; pts: Pt[] }
/** The designer state refresh() reads. */
export interface SceneryState { design: SceneryDesign; sel: number; span: number; propKind: PropKind }
/** A placed object's edit (onEditAt). */
export interface PropEdit { s: number; side?: number; gap?: number }
/** create()'s inputs. scenery-panel.js:31 */
export interface SceneryDeps {
  el: ElFn; btn: BtnFn; group: GroupFn;
  /** designer.js passes its stepper; the panel does not use it. */
  stepper?: unknown;
  onTheme: (id: string) => unknown;
  onLook: (key: string, value: string) => unknown;
  onPreset: (id: string) => unknown;
  onKind: (id: PropKind) => unknown;
  onPlace: (ev: MouseEvent) => unknown;
  onRemove: (ev: MouseEvent) => unknown;
  onRemoveAt: (i: number) => unknown;
  onSelect: (sel: number, span: number) => unknown;
  onEditAt: (i: number, patch: PropEdit) => unknown;
  onCopyAt: (i: number) => unknown;
  onRecipe?: ((props: DesignerProp[]) => unknown) | undefined;
}

/** Build the SCENERY group. scenery-panel.js:31 */
export function create({ el, btn, group, onTheme, onLook, onPreset, onKind, onPlace, onRemove, onRemoveAt, onSelect, onEditAt, onCopyAt, onRecipe }: SceneryDeps) {
  const root = group("SCENERY");
  root.dataset.role = "scenery";
  let category = "all", current: SceneryState | null = null, side = 1, lastProps: string | null = null, section = "themes", placementMode = "point", copies = 3, editing = -1, objectCategory = "all";
  const MIN_GAP = TrackDesignerProps.MIN_GAP;
  const gaps: Record<PropKind, number> = Object.assign({}, TrackDesignerProps.DEFAULT_GAP);
  const summary = el("div", "td-group"); summary.dataset.role = "theme-summary";
  const activeName = el("div", "td-label");
  const lookSummary = el("div", "td-hint"); lookSummary.dataset.role = "look-summary";
  const resetLook = btn("RESET ATMOSPHERE", "sel-chip", () => onPreset("default"));
  resetLook.setAttribute("aria-label", "Reset time of day, trees and crowd to theme defaults");
  const blurb = el("div", "td-hint"); blurb.dataset.role = "theme-blurb";
  blurb.setAttribute("aria-live", "polite");
  summary.append(activeName, lookSummary, resetLook, blurb);
  const searchRow = el("div", "td-chips"); searchRow.dataset.role = "theme-search";
  const search = el("input", "td-input"); search.type = "search";
  search.placeholder = "Find a theme…"; search.setAttribute("aria-label", "Find a scenery theme");
  const clear = btn("CLEAR", "sel-chip", () => {
    search.value = ""; category = "all"; filter(); search.focus();
  });
  clear.setAttribute("aria-label", "Clear theme search and filters");
  searchRow.append(search, clear);
  const filters = el("div", "td-chips"); filters.dataset.role = "theme-filters";
  filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Theme categories");
  for (const id of Object.keys(CATEGORIES)) {
    const b = btn(id === "all" ? "ALL " + TrackThemes.ORDER.length : id.toUpperCase(), "sel-chip", () => { category = id; filter(); });
    b.dataset.category = id; filters.appendChild(b);
  }
  const themes = el("div", "td-chips"); themes.dataset.role = "themes";
  themes.setAttribute("role", "group"); themes.setAttribute("aria-label", "Theme");
  for (const id of TrackThemes.ORDER) {
    const p = TrackThemes.get(id), label = p.label || id.toUpperCase();
    const b = btn("", "sel-chip", () => onTheme(id));
    b.dataset.theme = id; b.title = p.blurb; b.setAttribute("aria-label", label);
    const sw = el("span", "swatch"); sw.setAttribute("aria-hidden", "true"); sw.style.background = TrackThemes.swatchCss(id);
    const name = el("span", "", label); name.dataset.role = "theme-label";
    b.append(sw, name); themes.appendChild(b);
  }
  const count = el("div", "td-hint"); count.dataset.role = "theme-results";
  count.setAttribute("role", "status");
  function pressed(b: HTMLElement, on: boolean) { b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); }
  function filter() {
    let n = 0;
    for (const c of themes.children) { const b = c as HTMLElement; b.hidden = !matches(b.dataset.theme!, category, search.value); if (!b.hidden) n++; }
    for (const b of filters.children as HTMLCollectionOf<HTMLElement>) pressed(b, b.dataset.category === category);
    clear.hidden = category === "all" && !search.value;
    count.textContent = n ? n + " of " + TrackThemes.ORDER.length + " themes" : "No themes found. Try another search or clear filters.";
    themes.hidden = !n;
    themes.scrollTop = 0;
  }
  search.addEventListener("input", filter);
  const themePanel = group("CHOOSE A THEME"); themePanel.append(searchRow, filters, themes, count);
  const nav = el("div", "td-chips"); nav.dataset.role = "scenery-sections";
  nav.setAttribute("role", "tablist"); nav.setAttribute("aria-label", "Scenery sections");
  root.append(summary, nav);

  const atmosphere = group("ATMOSPHERE"); atmosphere.dataset.role = "atmosphere";
  const presets = el("div", "td-chips"); presets.dataset.role = "look-presets";
  for (const [id, p] of Object.entries(PRESETS)) {
    const b = btn(p.label, "sel-chip", () => onPreset(id));
    b.dataset.preset = id; b.title = "Time: " + p.time + " · trees: " + p.trees + " · crowd: " + p.crowd;
    presets.appendChild(b);
  }
  atmosphere.appendChild(presets);
  const lookRows: Record<string, HTMLDivElement> = {};
  for (const [key, label] of LOOK_ROWS) {
    const row = el("div", "td-row"); row.setAttribute("role", "group"); row.setAttribute("aria-label", label);
    row.appendChild(el("span", "", label));
    for (const v of TrackThemes.LOOK[key]) {
      const b = btn(v.toUpperCase(), "sel-chip", () => onLook(key, v)); b.dataset.look = key + ":" + v;
      b.setAttribute("aria-label", label + " " + v); row.appendChild(b);
    }
    lookRows[key] = row; atmosphere.appendChild(row);
  }

  const propsGroup = group("TRACKSIDE PROPS"); propsGroup.dataset.role = "prop-inspector";
  const library = group("1 · CHOOSE AN OBJECT"); library.dataset.role = "object-library";
  const objectFilters = el("div", "td-chips"); objectFilters.dataset.role = "object-filters";
  objectFilters.setAttribute("role", "group"); objectFilters.setAttribute("aria-label", "Object categories");
  const objectSearch = el("input", "td-input"); objectSearch.type = "search";
  objectSearch.placeholder = "Find an object…"; objectSearch.setAttribute("aria-label", "Find a scenery object");
  const objectCount = el("div", "td-hint"); objectCount.setAttribute("role", "status"); objectCount.dataset.role = "object-results";
  function filterObjects() {
    for (const b of objectFilters.children as HTMLCollectionOf<HTMLElement>) pressed(b, b.dataset.objectCategory === objectCategory);
    const query = objectSearch.value.trim().toLowerCase(); let n = 0;
    for (const b of props.children as HTMLCollectionOf<HTMLElement>) {
      const kind = b.dataset.prop as PropKind, text = TrackDesignerProps.LABELS[kind] + " " + TrackDesignerProps.DESCRIPTIONS[kind];
      b.hidden = (objectCategory !== "all" && !TrackDesignerProps.CATEGORIES[objectCategory as keyof typeof TrackDesignerProps.CATEGORIES].includes(kind)) || !text.toLowerCase().includes(query);
      if (!b.hidden) n++;
    }
    objectCount.textContent = n ? n + " objects" : "No objects found. Try another search or category.";
  }
  for (const [id, label] of [["all", "ALL"], ["nature", "NATURE"], ["terrain", "TERRAIN"], ["water", "WATER"], ["venue", "RACE VENUE"]] as const) {
    const b = btn(label, "sel-chip", () => { objectCategory = id; filterObjects(); });
    b.dataset.objectCategory = id; objectFilters.appendChild(b);
  }
  objectSearch.addEventListener("input", filterObjects);
  const props = el("div", "td-chips"); props.dataset.role = "props";
  props.setAttribute("role", "group"); props.setAttribute("aria-label", "Scenery props");
  for (const id of TrackDesignerProps.KINDS) {
    const b = btn(TrackDesignerProps.LABELS[id], "sel-chip", () => onKind(id)); b.dataset.prop = id; b.title = TrackDesignerProps.DESCRIPTIONS[id]; props.appendChild(b);
  }
  const selectedObject = el("div", "td-hint"); selectedObject.dataset.role = "selected-object";
  selectedObject.setAttribute("role", "status");
  library.append(objectSearch, objectFilters, props, objectCount);
  const placementGroup = group("2 · PLACE OBJECTS"); placementGroup.dataset.role = "object-placement";
  const sides = el("div", "td-chips"); sides.dataset.role = "prop-side";
  sides.setAttribute("role", "group"); sides.setAttribute("aria-label", "Track side in driving direction");
  sides.appendChild(el("span", "td-hint", "TRACK SIDE"));
  for (const [value, label] of [[-1, "LEFT"], [1, "RIGHT"], [0, "BOTH"]] as const) {
    const b = btn(label, "sel-chip", () => { side = value; if (current) refresh(current); });
    b.dataset.side = String(value); sides.appendChild(b);
  }
  const gap = el("div", "td-row") as HTMLDivElement & { _refresh: () => void }; gap.dataset.role = "prop-gap";
  function setGap(v: number) {
    const kind = current ? current.propKind : "stand";
    gaps[kind] = Math.max(MIN_GAP[kind], Math.min(120, Math.round(v))); gap._refresh();
  }
  const gapValue = numberInput("Roadside gap in metres", 0, 120, 1, setGap);
  const gapDown = btn("−", "sel-chip", () => setGap(gaps[current!.propKind] - 2));
  const gapUp = btn("+", "sel-chip", () => setGap(gaps[current!.propKind] + 2));
  gapDown.setAttribute("aria-label", "ROADSIDE GAP m down"); gapUp.setAttribute("aria-label", "ROADSIDE GAP m up");
  gap._refresh = () => { const k = current ? current.propKind : "stand"; gapValue.min = String(MIN_GAP[k]); gapValue.value = String(gaps[k]); gapDown.disabled = gaps[k] <= MIN_GAP[k]; gapUp.disabled = gaps[k] >= 120; };
  gap.append(el("span", "td-hint", "ROADSIDE GAP · m"), gapDown, gapValue, gapUp);
  const resetGap = btn("RESET GAP", "sel-chip", () => setGap(TrackDesignerProps.DEFAULT_GAP[current!.propKind]));
  resetGap.setAttribute("aria-label", "Reset roadside gap for selected object"); gap.appendChild(resetGap);
  const hint = el("div", "td-hint"); hint.dataset.role = "props-hint";
  function numberInput(label: string, min: number, max: number, step: number, onApply: (v: number) => unknown) {
    const input = el("input", "td-input"); input.type = "number";
    input.min = String(min); input.max = String(max); input.step = String(step); input.setAttribute("aria-label", label);
    const apply = () => { if (input.value.trim() && Number.isFinite(+input.value)) onApply(+input.value); if (current) refresh(current); };
    input.addEventListener("change", apply);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); apply(); } });
    return input;
  }
  const placement = el("div", "td-chips"); placement.dataset.role = "placement-mode";
  for (const [id, label] of [["point", "AT POINT"], ["range", "ALONG SECTION"]] as const) {
    const b = btn(label, "sel-chip", () => { placementMode = id; if (current) refresh(current); }); b.dataset.placementMode = id; placement.appendChild(b);
  }
  const target = el("div", "td-chips"); target.dataset.role = "scenery-fields";
  function field(parent: HTMLElement, label: string, input: HTMLElement) { const wrap = el("label", ""); wrap.dataset.role = "scenery-field"; wrap.append(el("span", "td-hint", label), input); parent.appendChild(wrap); return wrap; }
  const startPoint = numberInput("Scenery start point number", 1, 200, 1, (v) => { if (Number.isInteger(v) && current) onSelect(v - 1, placementMode === "range" ? current.span : -1); });
  const endPoint = numberInput("Scenery end point number", 1, 200, 1, (v) => { if (Number.isInteger(v) && current) onSelect(Math.max(0, current.sel), v - 1); });
  const quantity = numberInput("Scenery positions along section", 2, 8, 1, (v) => { copies = Math.max(2, Math.min(8, Math.round(v))); });
  field(target, "START POINT", startPoint);
  const endField = field(target, "END POINT", endPoint), countField = field(target, "POSITIONS", quantity);
  const rangeActions = el("div", "td-chips"); rangeActions.dataset.role = "range-actions";
  const swap = btn("SWAP ENDS", "sel-chip", () => { if (current && current.sel >= 0 && current.span >= 0) onSelect(current.span, current.sel); });
  swap.setAttribute("aria-label", "Swap scenery section start and end"); rangeActions.appendChild(swap); target.appendChild(rangeActions);
  const actions = el("div", "td-chips"); actions.dataset.role = "prop-actions";
  const place = btn("PLACE AT POINT", "sel-edit", onPlace);
  place.setAttribute("aria-label", "Place the selected prop at the selected control point");
  const remove = btn("REMOVE LAST", "sel-chip", onRemove);
  remove.setAttribute("aria-label", "Remove the last placed prop of the selected kind");
  actions.append(place, remove);
  const list = el("ul", "td-issues"); list.dataset.role = "placed-props"; list.setAttribute("aria-label", "Placed scenery props");
  const editor = group("EDIT PLACED OBJECT"); editor.dataset.role = "prop-editor"; editor.hidden = true;
  const editFields = el("div", "td-chips"); editFields.dataset.role = "scenery-fields";
  const lap = numberInput("Placed object lap percentage", 0, 100, 0.1, () => {});
  const editGap = numberInput("Placed object roadside gap in metres", 0, 120, 1, () => {});
  const editSide = el("select", "td-input"); editSide.setAttribute("aria-label", "Placed object track side");
  for (const [value, label] of [[-1, "LEFT"], [1, "RIGHT"]] as const) { const opt = el("option", "", label); opt.value = String(value); editSide.appendChild(opt); }
  field(editFields, "LAP %", lap); const editGapField = field(editFields, "GAP m", editGap), editSideField = field(editFields, "SIDE", editSide);
  const editActions = el("div", "td-chips");
  const applyEdit = btn("APPLY", "sel-edit", () => {
    if (editing < 0 || !lap.value.trim() || !editGap.value.trim() || !Number.isFinite(+lap.value) || !Number.isFinite(+editGap.value)) return;
    onEditAt(editing, { s: Math.max(0, Math.min(100, +lap.value)) / 100, side: +editSide.value, gap: +editGap.value }); place.focus();
  });
  const move = btn("MOVE TO POINT", "sel-chip", () => { if (current && current.sel >= 0 && editing >= 0) onEditAt(editing, { s: TrackDesignerProps.pointFrac(current.design.pts, current.sel) }); place.focus(); });
  const copy = btn("COPY TO POINT", "sel-chip", () => { if (current && current.sel >= 0 && editing >= 0) onCopyAt(editing); place.focus(); });
  const cancel = btn("CANCEL", "sel-chip", () => { editing = -1; editor.hidden = true; place.focus(); });
  editActions.append(applyEdit, move, copy, cancel); editor.append(editFields, editActions);
  const placedGroup = group("3 · PLACED OBJECTS"); placedGroup.dataset.role = "object-list";
  const empty = el("div", "td-hint", "No objects placed yet. Choose an object above, then select where to place it.");
  empty.dataset.role = "objects-empty";
  placedGroup.append(empty, editor, list);
  placementGroup.append(selectedObject, placement, target, sides, gap, hint, actions);
  propsGroup.append(library, placementGroup, placedGroup);
  const panels: Record<string, TdGroup> = { themes: themePanel, atmosphere, objects: propsGroup };
  const scrollPositions = new Map<string, number>();
  function showSection(id: string) {
    const rail = root.closest(".td-rail");
    if (rail) scrollPositions.set(section, rail.scrollTop);
    section = panels[id] ? id : "themes";
    blurb.hidden = section !== "themes";
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== section;
    for (const b of nav.children as HTMLCollectionOf<HTMLElement>) { const on = b.dataset.scenerySection === section; pressed(b, on); b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
    const target = section;
    if (rail) rail.scrollTop = scrollPositions.get(target) || 0;
  }
  for (const [id, panel] of Object.entries(panels)) {
    const b = btn(id.toUpperCase(), "sel-chip", () => showSection(id)); b.dataset.scenerySection = id;
    b.id = "td-scenery-tab-" + id; b.setAttribute("role", "tab"); b.setAttribute("aria-controls", "td-scenery-panel-" + id);
    panel.id = "td-scenery-panel-" + id; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", b.id); panel.tabIndex = 0;
    b.addEventListener("keydown", (ev) => {
      const keys = Object.keys(panels), at = keys.indexOf(id);
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) return;
      ev.preventDefault(); const next = ev.key === "Home" ? 0 : ev.key === "End" ? keys.length - 1 : (at + (ev.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length;
      showSection(keys[next]!); (nav.children[next] as HTMLElement).focus();
    });
    nav.appendChild(b); root.appendChild(panel);
  }
  function editObject(i: number) {
    const p = current && (current.design.props || [])[i]; if (!p) return;
    editing = i; editor.hidden = false;
    lap.value = String(Math.round(p.s * 1000000) / 10000); editGap.value = String(p.gap); editGap.min = String(MIN_GAP[p.kind]); editSide.value = String(p.side);
    editGapField.hidden = editSideField.hidden = p.kind === "gantry";
    refreshDestination(); lap.focus();
  }

  function refreshDestination() {
    const p = current && (current.design.props || [])[editing], valid = current && current.sel >= 0 && current.sel < current.design.pts.length;
    move.disabled = !valid; copy.disabled = !valid || !p || !TrackDesignerProps.canPlace(current!.design.props, p.kind);
    for (const [b, verb] of [[move, "MOVE"], [copy, "COPY"]] as const) { b.textContent = valid ? verb + " TO POINT " + (current!.sel + 1) : verb + " · SELECT DESTINATION"; b.setAttribute("aria-label", b.textContent); }
  }
  const recipes = DesignerFollowup.recipePanel({ el, btn, getState: () => current as RecipeState | null, onApply: onRecipe });
  placedGroup.appendChild(recipes.root);
  function refresh(state: SceneryState) {
    current = state; refreshDestination(); recipes.refresh();
    const d = state.design, kind = state.propKind, p = TrackThemes.get(d.theme), look = TrackThemes.lookOf(d);
    activeName.textContent = p.label; blurb.textContent = p.blurb;
    for (const b of themes.children as HTMLCollectionOf<HTMLElement>) pressed(b, b.dataset.theme === d.theme);
    for (const key of Object.keys(lookRows)) for (const b of lookRows[key]!.children as HTMLCollectionOf<HTMLElement>) if (b.dataset.look) pressed(b, b.dataset.look === key + ":" + look[key as keyof ThemeLook]);
    for (const b of presets.children as HTMLCollectionOf<HTMLElement>) pressed(b, LOOK_ROWS.every(([key]) => PRESETS[b.dataset.preset!]![key] === look[key]));
    const c = TrackDesignerProps.counts(d.props);
    lookSummary.textContent = look.time.toUpperCase() + " · TREES " + look.trees.toUpperCase() + " · CROWD " + look.crowd.toUpperCase() + " · " + c.total + "/" + TrackDesignerProps.TOTAL + " OBJECTS";
    selectedObject.textContent = TrackDesignerProps.LABELS[kind] + " · " + TrackDesignerProps.DESCRIPTIONS[kind];
    empty.hidden = c.total > 0;
    rangeActions.hidden = placementMode !== "range"; swap.disabled = state.sel < 0 || state.span < 0 || state.sel === state.span;
    resetGap.hidden = kind === "gantry";
    nav.children[2]!.textContent = "OBJECTS " + c.total + "/" + TrackDesignerProps.TOTAL;
    for (const b of props.children as HTMLCollectionOf<HTMLElement>) {
      const id = b.dataset.prop as PropKind;
      pressed(b, id === kind);
      b.textContent = TrackDesignerProps.LABELS[id] + " " + c[id] + "/" + TrackDesignerProps.CAPS[id];
      // A full kind remains selectable so its placed objects can be removed.
    }
    for (const b of sides.children as HTMLCollectionOf<HTMLElement>) if (b.dataset.side) pressed(b, +b.dataset.side === side);
    sides.hidden = gap.hidden = kind === "gantry"; gap._refresh();
    for (const b of placement.children as HTMLCollectionOf<HTMLElement>) pressed(b, b.dataset.placementMode === placementMode);
    endField.hidden = countField.hidden = placementMode !== "range";
    startPoint.max = endPoint.max = String(d.pts.length);
    startPoint.value = String(Math.max(0, state.sel) + 1); endPoint.value = state.span >= 0 ? String(state.span + 1) : ""; quantity.value = String(copies);
    const point = state.sel >= 0 ? "point " + (state.sel + 1) : "the start line";
    hint.textContent = c.total + "/" + TrackDesignerProps.TOTAL + " placed · " + (kind === "gantry" ? "Over the road at " : "At ") + point + ". " + (state.sel < 0 ? "Select a point on the map to place elsewhere." : "Left/right follows driving direction.");
    place.textContent = state.sel >= 0 ? "PLACE AT POINT " + (state.sel + 1) : "PLACE AT START";
    const range = placementMode === "range", amount = (range ? copies : 1) * (side === 0 && kind !== "gantry" ? 2 : 1);
    place.setAttribute("aria-label", range ? "Place objects along the selected section" : "Place the selected prop at the selected control point");
    const room = Math.min(TrackDesignerProps.TOTAL - c.total, TrackDesignerProps.CAPS[kind] - c[kind]);
    place.disabled = !d.pts.length || amount > room || (range && (state.sel < 0 || state.span < 0 || state.sel === state.span));
    if (range || side === 0) place.textContent = "PLACE " + amount + " OBJECTS";
    hint.textContent += " " + room + " slots left for this kind.";
    if (range) hint.textContent = "Even spacing from start to end in driving order. Earlier end points cross the start line. " + amount + " objects · " + room + " slots left.";
    if (amount > room) hint.textContent += " Reduce positions or choose one side to fit the limit.";
    if (range && state.span < 0) hint.textContent += " Choose an end point first.";
    if (TrackDesignerProps.CATEGORIES.terrain.includes(kind) || TrackDesignerProps.CATEGORIES.water.includes(kind)) hint.textContent += " Landscape objects that overlap the road are hidden. Use an open area or increase the gap. Terrain objects decorate the ground without changing road elevation.";
    remove.disabled = !c[kind];
    const key = JSON.stringify(d.props || []);
    if (key !== lastProps) {
      lastProps = key;
      editing = -1; editor.hidden = true;
      while (list.firstChild) list.removeChild(list.firstChild);
      for (const [i, prop] of (d.props || []).entries()) {
        const li = el("li", "td-issue");
        const where = prop.kind === "gantry" ? "OVER ROAD" : (prop.side < 0 ? "LEFT" : "RIGHT") + " · " + TrackDesignerProps.effectiveGap(prop.kind, prop.gap) + " m" + (prop.gap < MIN_GAP[prop.kind] ? " (stored " + prop.gap + " m)" : "");
        li.appendChild(el("span", "", TrackDesignerProps.LABELS[prop.kind] + " · " + Math.round(prop.s * 100) + "% LAP · " + where));
        const del = btn("REMOVE", "sel-chip", () => {
          onRemoveAt(i);
          const next = list.children[Math.min(i, list.children.length - 1)];
          const focus = next && next.querySelector("button"); (focus || place).focus();
        });
        del.setAttribute("aria-label", "Remove placed " + TrackDesignerProps.LABELS[prop.kind].toLowerCase() + " " + (i + 1));
        const edit = btn("EDIT", "sel-chip", () => editObject(i)); edit.setAttribute("aria-label", "Edit placed " + TrackDesignerProps.LABELS[prop.kind].toLowerCase() + " " + (i + 1));
        li.append(edit, del); list.appendChild(li);
      }
    }
  }
  filter(); filterObjects(); showSection(section);
  return { root, refresh, placement: (kind: PropKind) => ({ side: kind === "gantry" ? 1 : side, gap: gaps[kind], mode: placementMode, count: placementMode === "range" ? copies : 1 }) };
}
/** The api create() returns. */
export type DesignerSceneryApi = ReturnType<typeof create>;
