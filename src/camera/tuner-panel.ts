/* Apex 26 — the CAMERA TUNER pause-menu panel: a chip per player camera mode plus a slider per knob from CamTune.defs(), comfort knobs, a global baseline scope, presets, copy-from / apply-to-all, and JSON / APXC1 import.
 *
 * Ported verbatim from f1-game js/camera/tuner-panel.js:1-523 (CamTunerEditor.create)
 * plus the panel's static shell DOM, which f1-game keeps in index.html:3332-3366
 * (#camtune … #ct-close) and which `mountCamTuner` builds here with the same
 * ids and classes. The lazy loader (js/camera/cam-tuner-boot.js) is the
 * shell's: a dynamic import() of this module replaces it.
 *
 * The `G` context becomes `CamTunerDeps`:
 *   CamModes.CAM_MODES, G.camMode, G.setCamMode → deps.modes / camMode / setCamMode
 *       TODO(lane-shell): js/camera/mode-switch.js is not ported yet.
 *   G.snapGameCam (when G.player && G.track)     → deps.applyLive
 *   G.track.id || store trackId, Teams[G.teamIdx] → deps.trackId / deps.teamId
 *   __apex.jump / snapCam + G.loadTrack           → deps.previewCorner (the row hides without it)
 *   els.pmsettings, #pm-panel-display, G.paused   → looked up by id in the document; deps.paused
 *   ApexClipboard.write                           → deps.clipboard (default navigator.clipboard)
 *   CamComfort / G.gfx                            → src/camera/cam-comfort.ts, deps.gfx
 */
import { log } from "../data/log";
import * as CamComfort from "./cam-comfort";
import type { ComfortFxSink } from "./cam-comfort";
import type { CamTune, Scope, TuneDef } from "./offsets";
import type { CamStore } from "./store";
import "../styles";   // fixes the @layer order before camera.css joins `components`
import "./camera.css";

export interface CamModeEntry { readonly id: string; readonly label: string }

export interface CornerPreview { readonly id: string; readonly frac: number; readonly speed: number }

export interface CamTunerDeps {
  readonly camTune: CamTune;
  readonly modes: readonly CamModeEntry[];
  camMode(): number;
  setCamMode(index: number): void;
  readonly store?: CamStore | null;
  readonly gfx?: ComfortFxSink | null;
  readonly trackId?: () => string | null | undefined;
  readonly teamId?: () => string | null | undefined;
  readonly applyLive?: () => void;
  readonly previewCorner?: ((p: CornerPreview) => void) | null;
  readonly paused?: () => boolean;
  readonly clipboard?: (text: string) => Promise<boolean>;
  /** The SETTINGS button that opens the panel (f1-game #pm-camtune). */
  readonly openButton?: HTMLElement | null;
}

export interface CamTunerMount {
  buildCamTunePanel(): void;
  refreshCamTunePanel(): void;
  openCamTuner(): void;
  closeCamTuner(showPauseMenu?: boolean): void;
  isOpen(): boolean;
  /** The #camtune root this mount built. */
  readonly root: HTMLElement;
  unmount(): void;
}

type PanelScope = "mode" | "global" | Scope;

const CT_PREVIEWS: Readonly<Record<string, CornerPreview>> = {
  monza: { id: "monza", frac: 0.055, speed: 55 },
  spa: { id: "spa", frac: 0.34, speed: 62 },
  monaco: { id: "monaco", frac: 0.78, speed: 42 },
};

function defaultClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) return navigator.clipboard.writeText(text).then(() => true, () => false);
  } catch { /* no clipboard */ }
  return Promise.resolve(false);
}

/** index.html:3332-3366: the shell DOM, built rather than static. */
function buildShell(doc: Document): HTMLElement {
  const root = doc.createElement("div");
  root.id = "camtune"; root.setAttribute("role", "region"); root.setAttribute("aria-label", "Camera tuner");
  root.dataset["escClose"] = "ct-close"; root.hidden = true;
  const inner = doc.createElement("div"); inner.id = "camtune-inner"; inner.className = "sheet";
  // #ct-rail mirrors #lt-rail in the lighting tuner: the wide-and-short RAIL
  // layout is a two-column grid whose child-PLACEMENT rules need something to
  // place. It is `display: contents` at every other size.
  const rail = doc.createElement("div"); rail.id = "ct-rail";
  const head = doc.createElement("div"); head.id = "ct-head";
  const h2 = doc.createElement("h2"); h2.textContent = "CAMERA TUNER"; head.appendChild(h2);
  const profile = doc.createElement("div"); profile.id = "ct-profile";
  const modes = doc.createElement("div"); modes.id = "ct-modes"; modes.className = "lt-tabs balanced-row";
  modes.setAttribute("role", "tablist"); modes.setAttribute("aria-label", "Camera modes");
  const helpLab = doc.createElement("label"); helpLab.className = "lt-help-toggle";
  const helpOn = doc.createElement("input"); helpOn.id = "ct-help-on"; helpOn.type = "checkbox";
  helpLab.appendChild(helpOn); helpLab.appendChild(doc.createTextNode(" Show explanations"));
  rail.append(head, profile, modes, helpLab);
  const rows = doc.createElement("div"); rows.id = "ct-rows"; rows.className = "pane"; rows.setAttribute("role", "tabpanel");
  const previews = doc.createElement("div"); previews.id = "ct-previews"; previews.className = "balanced-row";
  previews.setAttribute("aria-label", "Corner preview shots");
  for (const [id, label, title] of [
    ["monza", "MONZA T1", "Jump to Monza T1 for a live framing check"],
    ["spa", "SPA EAU ROUGE", "Jump to Spa Eau Rouge for a live framing check"],
    ["monaco", "MONACO CHICANE", "Jump to Monaco chicane for a live framing check"],
  ] as const) {
    const b = doc.createElement("button"); b.type = "button"; b.id = "ct-prev-" + id; b.title = title; b.textContent = label;
    previews.appendChild(b);
  }
  const json = doc.createElement("textarea"); json.id = "ct-json"; json.readOnly = true; json.hidden = true;
  json.setAttribute("aria-label", "Exported camera tuning values");
  const foot = doc.createElement("div"); foot.className = "sheet-foot balanced-row";
  for (const [id, label, title, cls] of [
    ["ct-reset", "RESET CAM", "Reset framing offsets for the camera mode currently being edited. Other modes are untouched.", ""],
    ["ct-reset-all", "RESET ALL", "Reset every camera mode to shipped defaults.", ""],
    ["ct-copy", "COPY VALUES", "", ""],
    ["ct-close", "DONE", "", "bigbtn"],
  ] as const) {
    const b = doc.createElement("button"); b.id = id; b.textContent = label;
    if (title) b.title = title;
    if (cls) b.className = cls;
    foot.appendChild(b);
  }
  inner.append(rail, rows, previews, json, foot);
  root.appendChild(inner);
  return root;
}

/** Build the CAMERA TUNER in `el` and wire it to `deps` (tuner-panel.js:9-520 `create`). */
export function mountCamTuner(el: HTMLElement, deps: CamTunerDeps): CamTunerMount {
  log.info("CamTunerPanel.create");
  const doc = el.ownerDocument;
  const root = buildShell(doc);
  el.appendChild(root);
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    (root.querySelector("#" + id) as T | null) ?? (doc.getElementById(id) as T | null);
  const need = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const e = $<T>(id);
    if (!e) throw new Error("camera tuner: missing #" + id);
    return e;
  };
  const CamTune = deps.camTune;
  const CAM_MODES = deps.modes;
  const DEFS = CamTune.defs();
  const COMFORT = CamTune.comfortDefs();
  const FX = CamComfort.FX_DEFS;
  const store = deps.store ?? null;
  const clipboard = deps.clipboard ?? defaultClipboard;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };
  let built = false, toolsBuilt = false, importBuilt = false;
  let scopeBtns: Partial<Record<PanelScope, HTMLButtonElement>> = {};

  // Scope: per-mode, global baseline, or current track/car overrides.
  let _scope: PanelScope = "mode";   // "mode" | "global" | "track" | "car"
  const cur = (): CamModeEntry => CAM_MODES[deps.camMode()] || CAM_MODES[0] || { id: "chase", label: "CHASE" };
  function curMode(): string { return cur().id; }
  function curLabel(): string { return cur().label; }
  function syncContext(): void {
    const trackId = (deps.trackId && deps.trackId()) || (store ? store.get("trackId", null) : null);
    const team = deps.teamId ? deps.teamId() : null;
    CamTune.setContext(trackId, team);
  }
  function framingValue(d: TuneDef, mode: string): number {
    if (_scope === "global") return CamTune.getGlobal(d.id);
    if (_scope === "track" || _scope === "car") return CamTune.getScoped(_scope, mode, d.id);
    return CamTune.getModeOnly(mode, d.id);
  }
  function setFraming(d: TuneDef, mode: string, value: number): boolean {
    if (_scope === "global") return CamTune.setGlobal(d.id, value);
    if (_scope === "track" || _scope === "car") return CamTune.setScoped(_scope, mode, d.id, value);
    return CamTune.set(mode, d.id, value);
  }
  function comfortValue(d: TuneDef): number {
    return _scope === "track" || _scope === "car"
      ? CamTune.comfortGetScoped(_scope, d.id) : CamTune.comfortGetGlobal(d.id);
  }
  function setComfort(d: TuneDef, value: number): boolean {
    return _scope === "track" || _scope === "car"
      ? CamTune.comfortSetScoped(_scope, d.id, value) : CamTune.comfortSet(d.id, value);
  }
  function fmtCt(d: TuneDef, v: number): string {
    const dec = (String(d.step).split(".")[1] || "").length;
    const s = Math.abs(v).toFixed(Math.min(dec, 2));
    const sign = (v > 0 && d.min < 0) ? "+" : v < 0 ? "−" : "";
    return sign + s + d.unit;
  }
  function knobApplies(d: TuneDef, mode: string): boolean {
    if (_scope === "global") return true;   // global baseline shows every knob
    return !d.modes || d.modes.indexOf(mode) !== -1;
  }
  function applyLive(): void {
    if (deps.applyLive) deps.applyLive();
  }
  function previewCorner(key: string): void {
    const p = CT_PREVIEWS[key];
    // The jump is the dev API's, which the shipped page does not load: without
    // it a jump would swap the circuit under a live race and then throw.
    // openCamTuner hides the row.
    if (!p || !deps.previewCorner) return;
    deps.previewCorner(p);
    applyLive();
  }
  function selectCamMode(index: number, focus: boolean): void {
    deps.setCamMode(index);
    _scope = "mode";
    applyLive();
    refreshCamTunePanel();
    const m = CAM_MODES[index];
    if (focus && m) $("ct-tab-" + m.id)?.focus();
  }
  function camTabKey(index: number, e: KeyboardEvent): void {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % CAM_MODES.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + CAM_MODES.length) % CAM_MODES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = CAM_MODES.length - 1;
    if (next == null) return;
    e.preventDefault(); e.stopPropagation();
    selectCamMode(next, true);
  }

  function sliderItem(d: TuneDef, rowId: string, valId: string, inId: string, onInput: (inp: HTMLInputElement, b: HTMLElement) => void): HTMLElement {
    const item = doc.createElement("div");
    item.className = "adv-item";
    item.id = rowId;
    const lab = doc.createElement("label"); lab.className = "tune-row";
    const span = doc.createElement("span"); span.className = "tune-label";
    span.textContent = d.label + " ";
    const b = doc.createElement("b"); b.id = valId;
    span.appendChild(b);
    const inp = doc.createElement("input");
    inp.type = "range"; inp.min = String(d.min); inp.max = String(d.max); inp.step = String(d.step);
    inp.id = inId;
    inp.setAttribute("aria-label", d.label);
    inp.oninput = () => onInput(inp, b);
    lab.appendChild(span); lab.appendChild(inp);
    item.appendChild(lab);
    if (d.help) { const p = doc.createElement("p"); p.className = "adv-help"; p.textContent = d.help; item.appendChild(p); }
    return item;
  }

  function buildTools(host: HTMLElement): void {
    if (toolsBuilt) return;
    toolsBuilt = true;

    // Scope: THIS CAM vs ALL CAMS (global baseline).
    const scope = doc.createElement("div");
    scope.className = "lt-preview-row";
    scope.id = "ct-scope";
    const scopeLbl = doc.createElement("span");
    scopeLbl.className = "lt-preview-lbl";
    scopeLbl.textContent = "SCOPE";
    scope.appendChild(scopeLbl);
    const btns: Partial<Record<PanelScope, HTMLButtonElement>> = {};
    for (const [id, label] of [["mode", "THIS CAM"], ["global", "ALL CAMS"], ["track", "THIS TRACK"], ["car", "THIS CAR"]] as const) {
      const b = doc.createElement("button");
      b.type = "button"; b.className = "opt-btn lt-preview-btn";
      b.dataset["scope"] = id;
      b.setAttribute("aria-pressed", id === _scope ? "true" : "false");
      b.textContent = label;
      b.onclick = () => { _scope = id; refreshCamTunePanel(); };
      scope.appendChild(b);
      btns[id] = b;
    }
    host.appendChild(scope);
    scopeBtns = btns;
    const scopeHelp = doc.createElement("p");
    scopeHelp.className = "adv-help";
    scopeHelp.textContent = "THIS CAM edits one mode. ALL CAMS writes the baseline. THIS CAR overrides it; THIS TRACK wins over both for the selected camera and comfort knobs.";
    host.appendChild(scopeHelp);

    // Presets
    const presets = doc.createElement("div");
    presets.className = "lt-preview-row";
    presets.id = "ct-presets";
    const pLbl = doc.createElement("span");
    pLbl.className = "lt-preview-lbl";
    pLbl.textContent = "PRESET";
    presets.appendChild(pLbl);
    const table = CamTune.presets();
    for (const id of Object.keys(table)) {
      const b = doc.createElement("button");
      b.type = "button"; b.className = "opt-btn lt-preview-btn"; b.id = "ct-preset-" + id;
      b.textContent = table[id]?.label ?? id;
      b.title = table[id]?.help || "";
      b.onclick = () => {
        CamTune.applyPreset(id);
        CamTune.persist();
        CamTune.persist("track");
        CamTune.persist("car");
        applyLive();
        refreshCamTunePanel();
      };
      presets.appendChild(b);
    }
    host.appendChild(presets);

    // Copy from / apply to all
    const copy = doc.createElement("div");
    copy.className = "lt-preview-row";
    copy.id = "ct-copyrow";
    const cLbl = doc.createElement("span");
    cLbl.className = "lt-preview-lbl";
    cLbl.textContent = "COPY";
    copy.appendChild(cLbl);
    const sel = doc.createElement("select");
    sel.id = "ct-copy-from";
    sel.setAttribute("aria-label", "Copy framing from camera");
    for (const c of CAM_MODES) {
      const o = doc.createElement("option");
      o.value = c.id; o.textContent = c.label;
      sel.appendChild(o);
    }
    copy.appendChild(sel);
    const fromBtn = doc.createElement("button");
    fromBtn.type = "button"; fromBtn.className = "opt-btn lt-preview-btn"; fromBtn.id = "ct-copy-from-btn";
    fromBtn.textContent = "FROM → HERE";
    fromBtn.title = "Copy the selected camera's per-mode edits onto the camera you are editing.";
    fromBtn.onclick = () => {
      const src = sel.value, dst = curMode();
      if (src === dst) return;
      CamTune.copyFrom(src, dst);
      CamTune.persist("modes");
      applyLive();
      refreshCamTunePanel();
    };
    copy.appendChild(fromBtn);
    const allBtn = doc.createElement("button");
    allBtn.type = "button"; allBtn.className = "opt-btn lt-preview-btn"; allBtn.id = "ct-copy-all-btn";
    allBtn.textContent = "HERE → ALL";
    allBtn.title = "Copy this camera's per-mode edits onto every other camera. Click twice to confirm.";
    let armed = false, armT: ReturnType<typeof setTimeout> | undefined;
    allBtn.onclick = () => {
      if (!armed) {
        armed = true;
        allBtn.classList.add("on");
        allBtn.textContent = "COPY TO ALL?";
        if (armT !== undefined) { clearTimeout(armT); timers.delete(armT); }
        armT = later(() => { armed = false; allBtn.classList.remove("on"); allBtn.textContent = "HERE → ALL"; }, 20000);
        return;
      }
      if (armT !== undefined) { clearTimeout(armT); timers.delete(armT); }
      armed = false; allBtn.classList.remove("on");
      const n = CamTune.applyToAllModes(curMode());
      CamTune.persist("modes");
      applyLive();
      refreshCamTunePanel();
      allBtn.textContent = "COPIED " + n + " ✓";
      later(() => { allBtn.textContent = "HERE → ALL"; }, 1800);
    };
    copy.appendChild(allBtn);
    host.appendChild(copy);

    // Comfort block
    const comfortHead = doc.createElement("div");
    comfortHead.id = "ct-comfort-head";
    comfortHead.className = "lt-preview-lbl";
    comfortHead.textContent = "COMFORT";
    comfortHead.style.marginTop = "0.6em";
    host.appendChild(comfortHead);
    const comfortHelp = doc.createElement("p");
    comfortHelp.className = "adv-help";
    comfortHelp.textContent = "Independent of MOTION: REDUCED. Reduced motion still zeroes shake, buzz and lean; these knobs scale the same effects when motion is on, and FOV bias always applies.";
    host.appendChild(comfortHelp);
    for (const d of COMFORT) {
      host.appendChild(sliderItem(d, "ct-comfort-row-" + d.id, "ct-cv-" + d.id, "ct-cin-" + d.id, (inp, b) => {
        setComfort(d, parseFloat(inp.value));
        if (_scope === "track" || _scope === "car") CamTune.persist(_scope);
        else CamTune.persist("comfort");
        b.textContent = fmtCt(d, comfortValue(d));
        applyLive();
      }));
    }
    for (const d of FX) {
      host.appendChild(sliderItem(d, "ct-fx-row-" + d.id, "ct-fxv-" + d.id, "ct-fxin-" + d.id, (inp, b) => {
        CamComfort.fxSet(store, d.id, parseFloat(inp.value));
        b.textContent = fmtCt(d, CamComfort.fxGet(store, d.id));
        CamComfort.applyFx({ gfx: deps.gfx ?? null, store }, store);
      }));
    }
  }

  function buildCamTunePanel(): void {
    const host = need("ct-rows"), modes = $("ct-modes");
    if (!built) {
      built = true;
      host.dataset["built"] = "1";
      if (modes) {
        modes.textContent = "";
        CAM_MODES.forEach((c, i) => {
          const b = doc.createElement("button");
          b.type = "button"; b.className = "lt-tab"; b.dataset["mode"] = c.id;
          b.id = "ct-tab-" + c.id;
          b.textContent = c.label; b.setAttribute("role", "tab");
          b.setAttribute("aria-controls", "ct-rows");
          b.onclick = () => selectCamMode(i, false);
          b.onkeydown = (e) => camTabKey(i, e);
          modes.appendChild(b);
        });
      }
      buildTools(host);
      for (const d of DEFS) {
        // ct-row-*: toggled per mode in refreshCamTunePanel
        host.appendChild(sliderItem(d, "ct-row-" + d.id, "ct-v-" + d.id, "ct-in-" + d.id, (inp, b) => {
          if (_scope === "mode") CamTune.set(curMode(), d.id, parseFloat(inp.value));
          else setFraming(d, curMode(), parseFloat(inp.value));
          if (_scope === "track" || _scope === "car") CamTune.persist(_scope);
          else CamTune.persist(_scope === "global" ? "global" : "modes");
          const v = framingValue(d, curMode());
          b.textContent = fmtCt(d, v);
          updateCtProfileLabel();
          applyLive();
        }));
      }
    }
    // Import lives next to COPY — inject once so shellNodes stays flat.
    const actions = $("ct-copy")?.parentElement;
    if (actions && !importBuilt) {
      importBuilt = true;
      const imp = doc.createElement("button");
      imp.id = "ct-import";
      imp.type = "button";
      imp.textContent = "IMPORT";
      imp.title = "Paste JSON, a window.CameraEdits snippet, or an APXC1 share code into the box, then click IMPORT.";
      const close = $("ct-close");
      actions.insertBefore(imp, close && close.parentNode === actions ? close : null);
      imp.onclick = () => {
        const ta = need<HTMLTextAreaElement>("ct-json");
        ta.hidden = false;
        ta.readOnly = false;
        ta.placeholder = "Paste JSON, CameraEdits = {...}, or APXC1.… then IMPORT";
        const raw = (ta.value || "").trim();
        if (!raw) { ta.focus(); return; }
        const r = CamTune.importText(raw);
        if (!r.ok) {
          imp.textContent = "BAD PASTE";
          later(() => { imp.textContent = "IMPORT"; }, 1800);
          return;
        }
        CamTune.persist();
        CamTune.persist("track");
        CamTune.persist("car");
        applyLive();
        refreshCamTunePanel();
        imp.textContent = "IMPORTED ✓";
        later(() => { imp.textContent = "IMPORT"; }, 1800);
      };
    }
    const ta = $<HTMLTextAreaElement>("ct-json");
    if (ta) { ta.readOnly = false; ta.setAttribute("aria-label", "Camera tuning export / import"); }
    need("camtune-inner").classList.toggle("lt-show-help", need<HTMLInputElement>("ct-help-on").checked);
    refreshCamTunePanel();
  }
  function updateCtProfileLabel(): void {
    const host = $("ct-profile"); if (!host) return;
    if (_scope === "global") {
      const n = CamTune.countGlobal();
      host.textContent = "ALL CAMERAS" + (n ? "  (" + n + " baseline)" : "  (no baseline)");
    } else if (_scope === "track" || _scope === "car") {
      const ctx = CamTune.context(), key = ctx[_scope] || "unavailable";
      const n = CamTune.countScoped(_scope, curMode());
      host.textContent = (_scope === "track" ? "TRACK " : "CAR ") + String(key).toUpperCase()
        + (n ? "  (" + n + " overrides)" : "  (no overrides)");
    } else {
      const n = CamTune.count(curMode());
      host.textContent = curLabel() + (n ? "  (" + n + " tuned)" : "  (default framing)");
    }
    const modes = $("ct-modes");
    if (modes) for (const b of Array.from(modes.children) as HTMLElement[]) {
      const mode = b.dataset["mode"] ?? "";
      const on = _scope === "mode" && mode === curMode();
      b.classList.toggle("active", on);
      b.classList.toggle("tuned", CamTune.count(mode) > 0);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      if (on) {
        if (typeof b.scrollIntoView === "function") b.scrollIntoView({ block: "nearest", inline: "center" });
        $("ct-rows")?.setAttribute("aria-labelledby", b.id);
      }
    }
    const sm = scopeBtns;
    if (sm.mode) {
      const on = _scope === "mode";
      sm.mode.classList.toggle("on", on);
      sm.mode.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (sm.global) {
      const on = _scope === "global";
      sm.global.classList.toggle("on", on);
      sm.global.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  function refreshCamTunePanel(): void {
    if (!built) return;
    syncContext();
    const mode = curMode();
    for (const d of DEFS) {
      const inp = $<HTMLInputElement>("ct-in-" + d.id), b = $("ct-v-" + d.id), row = $("ct-row-" + d.id);
      const v = framingValue(d, mode);
      if (inp) inp.value = String(v);
      if (b) b.textContent = fmtCt(d, v);
      if (row) row.style.display = knobApplies(d, mode) ? "" : "none";
    }
    for (const d of COMFORT) {
      const inp = $<HTMLInputElement>("ct-cin-" + d.id), b = $("ct-cv-" + d.id);
      const v = comfortValue(d);
      if (inp) inp.value = String(v);
      if (b) b.textContent = fmtCt(d, v);
    }
    for (const d of FX) {
      const inp = $<HTMLInputElement>("ct-fxin-" + d.id), b = $("ct-fxv-" + d.id);
      const v = CamComfort.fxGet(store, d.id);
      if (inp) inp.value = String(v);
      if (b) b.textContent = fmtCt(d, v);
    }
    const sel = $<HTMLSelectElement>("ct-copy-from");
    if (sel && !sel.dataset["locked"]) {
      // Default the picker to chase when editing something else, else the previous mode.
      if (Array.from(sel.options).some((o) => o.value === "chase") && mode !== "chase") sel.value = "chase";
    }
    updateCtProfileLabel();
  }
  function isOpen(): boolean { return !root.hidden; }
  function pausePages(hidden: boolean): void {
    const pm = doc.getElementById("pmsettings");
    if (pm) pm.hidden = hidden;
    // Nested under DISPLAY -> ADVANCED VISUALS: hide that page too, or its own
    // .hidden survives underneath and reappears the moment pmsettings does.
    const displayPage = doc.getElementById("pm-panel-display");
    if (displayPage) displayPage.hidden = hidden;
  }
  function openCamTuner(): void {
    log.info("CamTunerPanel.open");
    syncContext();
    buildCamTunePanel();
    CamComfort.applyFx({ gfx: deps.gfx ?? null, store }, store);
    root.hidden = false;
    { const row = $("ct-previews"); if (row) row.hidden = !deps.previewCorner; }   // dev-API jumps only
    need("ct-json").hidden = true;
    doc.body.classList.add("lt-open");   // hide race HUD + touch controls underneath
    pausePages(true);                     // unobstructed live preview (opened from settings)
    applyLive();
  }
  function closeCamTuner(showPauseMenu?: boolean): void {
    log.info("CamTunerPanel.close");
    root.hidden = true;
    doc.body.classList.remove("lt-open");
    if (showPauseMenu && deps.paused && deps.paused()) pausePages(false);   // back to the settings menu's DISPLAY page
  }
  if (deps.openButton) deps.openButton.onclick = openCamTuner;
  need("ct-close").onclick = () => closeCamTuner(true);
  need("ct-reset").onclick = () => {
    if (_scope === "global") CamTune.resetGlobal();
    else if (_scope === "track" || _scope === "car") CamTune.resetScoped(_scope, curMode());
    else CamTune.reset(curMode());
    CamTune.persist(); applyLive(); refreshCamTunePanel();
  };
  need("ct-reset-all").onclick = () => {
    CamTune.resetAll(); CamTune.persist(); CamTune.persist("track"); CamTune.persist("car");
    applyLive(); refreshCamTunePanel(); need("ct-json").hidden = true;
  };
  need<HTMLInputElement>("ct-help-on").onchange = () => {
    need("camtune-inner").classList.toggle("lt-show-help", need<HTMLInputElement>("ct-help-on").checked);
  };
  need("ct-prev-monza").onclick = () => previewCorner("monza");
  need("ct-prev-spa").onclick = () => previewCorner("spa");
  need("ct-prev-monaco").onclick = () => previewCorner("monaco");
  need("ct-copy").onclick = () => {
    const btn = need("ct-copy");
    const pack = CamTune.exportPack();
    const hasModes = pack.modes && Object.keys(pack.modes).length;
    const hasGlobal = pack.global && Object.keys(pack.global).length;
    const hasComfort = pack.comfort && Object.keys(pack.comfort).length;
    const hasTracks = pack.tracks && Object.keys(pack.tracks).length;
    const hasCars = pack.cars && Object.keys(pack.cars).length;
    if (!hasModes && !hasGlobal && !hasComfort && !hasTracks && !hasCars) {
      btn.textContent = "NOTHING TUNED";
      later(() => { btn.textContent = "COPY VALUES"; }, 1800);
      return;
    }
    // Dual export: readable CameraEdits snippet (modes) + pack JSON + share code.
    const lines: string[] = [];
    if (hasModes && pack.modes) {
      const S = pack.modes;
      const keys = Object.keys(S);
      const mode = curMode();
      const entry = (k: string): string => '  "' + k + '": ' + JSON.stringify(S[k], null, 2).replace(/\n/g, "\n  ");
      lines.push("window.CameraEdits = {");
      if (keys.includes(mode)) {
        lines.push("  // THIS MODE — " + curLabel().toUpperCase() +
          "  (" + Object.keys(S[mode] ?? {}).length + " tuned)");
        lines.push(entry(mode) + (keys.length > 1 ? "," : ""));
      } else {
        lines.push("  // THIS MODE — nothing tuned here yet");
      }
      const rest = keys.filter((k) => k !== mode);
      if (rest.length) {
        lines.push("  // EVERY OTHER TUNED MODE — " + rest.length +
          (rest.length === 1 ? " mode" : " modes"));
        rest.forEach((k, i) => lines.push(entry(k) + (i < rest.length - 1 ? "," : "")));
      }
      lines.push("};");
      lines.push("");
    }
    lines.push("// Pack (JSON) — paste into IMPORT, or use the share code below");
    lines.push(JSON.stringify(pack));
    lines.push("");
    lines.push("// Share code");
    lines.push(CamTune.encodeShare(pack));
    const json = lines.join("\n");
    const ta = need<HTMLTextAreaElement>("ct-json");
    ta.readOnly = false;
    ta.value = json; ta.hidden = false;
    ta.focus(); ta.setSelectionRange(0, json.length);
    const flash = (good: boolean): void => {
      btn.textContent = good ? "COPIED ✓" : "SELECT & COPY ↑";
      later(() => { btn.textContent = "COPY VALUES"; }, 1800);
    };
    void clipboard(json).then(flash);
  };
  return {
    buildCamTunePanel, refreshCamTunePanel, openCamTuner, closeCamTuner, isOpen, root,
    unmount() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (deps.openButton && deps.openButton.onclick === openCamTuner) deps.openButton.onclick = null;
      if (!root.hidden) closeCamTuner(false);
      root.remove();
    },
  };
}
