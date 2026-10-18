/**
 * FLYBY SHOT EDITOR DOM panel (LAZY_CAM_EDITOR): pick a shot from the pre-race
 * sequence (./flyby-seq.ts), scrub the whole run, edit every pose field live
 * through __apex.flybyCam(), reorder the list and copy it out as
 * window.FlybyShots for tools/gen/bake-flyby.mjs. Shot algebra stays on
 * ./flyby-panel.ts so loadSaved() can run at boot without this file.
 *
 * Ported verbatim from f1-game js/camera/flyby-editor.js:1-666 (`FlybyEditor`),
 * plus the panel's static shell from index.html:3378-3419 (#flyby … #fb-close),
 * which `mountFlybyEditor` builds with the same ids and classes.
 *
 * The `G` context becomes `FlybyEditorDeps`:
 *   G.store                         → deps.store (a26.flybyShots)
 *   FlybySeq.DEFAULT / .bounds      → deps.flyby (a ./flyby-seq.ts instance)
 *   G.track                         → deps.track()
 *   __apex.flybyCam / __apex.view   → deps.devApi() (null until loaded) and
 *       setApiLoader. TODO(lane-shell): the agent surface is not ported.
 *   G.loadingScreen, LoadingScreen.CARD / CARD_KEYS, G.loadingInfo
 *                                   → deps.loadingScreen / cardDefs / cardKeys /
 *       loadingInfo. TODO(lane-shell): js/ui/loading-screen.js is not ported.
 *   G.announcer                     → deps.announcer(). TODO(lane-audio).
 *   G.snapGameCam, G.paused, G.dbgCam → deps.snapGameCam / paused / dbgCam.
 *   FreeCam.enterFrom               → deps.freeCam (the ./free-cam.ts mount).
 *   ApexClipboard.write             → deps.clipboard.
 *   els.pmsettings, #pm-panel-display, #pm-flyby → looked up by id in the document.
 *   btn._fbLabel / btn._fbT expandos → a WeakMap; every timer is cleared on unmount.
 */
import { log } from "../data/log";
import type { FlybyBounds, FlybyShot, FlybyTrack, Vec3 } from "./flyby-seq";
import {
  AT_KINDS, CORNER_NS, DUR, EASES, FIELD, FIELD_IDS, FOV, RANKS, SLOTS,
  addShot, clone, deleteShot, duplicateShot, fieldLabel, loadSavedFrom, metricValue, moveShot,
  normaliseDurs, poseFields, savedForm, switchPoseAt, toBlob, validateShots,
} from "./flyby-panel";
import type { FieldDef, PoseField, PoseSlot, RangeDef } from "./flyby-panel";
import type { FreeCamAction, FreeCamCmd, FreeCamView } from "./free-cam";
import type { CamStore } from "./store";
import "../styles";
import "./camera.css";
import "./photo.css";

/** __apex.flybyCam(u, shots)'s report (js/agent/apex.js). */
export interface FlybyCamResult {
  u: number; shot: string; index: number; eye: number[]; fov: number;
  lift: number; onRoad?: boolean; lat?: number | null; inside?: { kind: string } | null;
}
/** The dev-API members the editor reads. */
export interface FlybyDevApi {
  flybyCam?(u: number, shots: FlybyShot[]): FlybyCamResult | null;
  view?(mode: string): unknown;
}
/** One TRACK CARD geometry knob (LoadingScreen.CARD[k]). */
export interface CardDef extends RangeDef { readonly label: string }
/** The loading screen's card surface (G.loadingScreen). */
export interface CardHost {
  setCard(g: Record<string, number>): Record<string, number> | null | undefined;
  resetCard(): Record<string, number> | null | undefined;
  card(): Record<string, number> | null | undefined;
  hold(info: unknown): void;
  stop(): void;
}
/** The announcer surface (G.announcer). */
export interface AnnouncerHost {
  scriptFor(info: unknown): string[];
  preview(info: unknown): boolean;
  available(): boolean;
  stop(): void;
}

export interface FlybyEditorDeps {
  readonly store: Pick<CamStore, "get" | "set">;
  readonly flyby?: { readonly DEFAULT: readonly FlybyShot[]; bounds?(track: FlybyTrack): FlybyBounds } | null;
  readonly track?: (() => FlybyTrack | null | undefined) | null;
  /** __apex, or null where it is not loaded. TODO(lane-shell). */
  readonly devApi?: (() => FlybyDevApi | null | undefined) | null;
  readonly loadingScreen?: (() => CardHost | null | undefined) | null;
  readonly cardDefs?: (() => Readonly<Record<string, CardDef>>) | null;
  readonly cardKeys?: (() => readonly string[]) | null;
  readonly loadingInfo?: (() => unknown) | null;
  readonly announcer?: (() => AnnouncerHost | null | undefined) | null;
  readonly snapGameCam?: (() => void) | null;
  readonly paused?: (() => boolean) | null;
  readonly dbgCam?: (() => FreeCamView | null | undefined) | null;
  readonly freeCam?: { enterFrom(opts: FreeCamCmd): boolean } | null;
  readonly clipboard?: ((text: string) => Promise<boolean>) | null;
}

export interface FlybyEditorMount {
  openFlyby(): void;
  closeFlyby(showPauseMenu?: boolean): void;
  isOpen(): boolean;
  setApiLoader(fn: (() => unknown) | null): void;
  loadSaved(): FlybyShot[] | null;
  list(): FlybyShot[];
  /** FlybyEditor.refresh: repaint the chips and rows while open. */
  refresh(): void;
  readonly root: HTMLElement;
  unmount(): void;
}

function defaultClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) return navigator.clipboard.writeText(text).then(() => true, () => false);
  } catch { /* no clipboard */ }
  return Promise.resolve(false);
}

/** index.html:3378-3419: the shell DOM, built rather than static. */
function buildShell(doc: Document): HTMLElement {
  const h = (tag: string, props: Record<string, string> = {}, kids: (Node | string)[] = []): HTMLElement => {
    const n = doc.createElement(tag);
    for (const k in props) {
      if (k === "class") n.className = props[k]!; else n.setAttribute(k, props[k]!);
    }
    for (const c of kids) n.append(c);
    return n;
  };
  const root = h("div", { id: "flyby", role: "region", "aria-label": "Flyby shot editor", "data-esc-close": "fb-close" });
  root.hidden = true;
  const json = h("textarea", { id: "fb-json", readonly: "", "aria-label": "Exported flyby shot list" });
  json.hidden = true;
  root.appendChild(h("div", { id: "flyby-inner", class: "sheet" }, [
    // #fb-rail mirrors #ct-rail: `display: contents` except in the rail layout.
    h("div", { id: "fb-rail" }, [
      h("div", { id: "fb-head" }, [
        h("h2", {}, ["FLYBY SHOT EDITOR"]),
        // The editor's sub-mode: flies from the previewed frame on the flyby lens,
        // sets the selected shot's start or end from the view, and DONE returns here.
        h("button", { id: "fb-freecam", type: "button" }, ["📷 FREE CAMERA"]),
      ]),
      h("div", { id: "fb-profile" }),
      // The one readout that answers "is this shot any good".
      h("div", { id: "fb-status", "aria-live": "polite" }),
      h("label", { class: "tune-row", id: "fb-scrub" }, [
        h("span", { class: "tune-label" }, ["SCRUB ", h("b", { id: "fb-u-val" }, ["0.000"])]),
        h("input", { id: "fb-u", type: "range", min: "0", max: "1000", step: "1", value: "0", "aria-label": "Scrub through the whole flyby" }),
      ]),
      h("div", { id: "fb-shots", class: "lt-tabs balanced-row", role: "tablist", "aria-label": "Flyby shots" }),
      h("div", { id: "fb-ops", class: "balanced-row", "aria-label": "Shot list operations" }, [
        h("button", { type: "button", id: "fb-add", title: "Insert a new shot after the selected one" }, ["ADD"]),
        h("button", { type: "button", id: "fb-dup", title: "Duplicate the selected shot" }, ["DUPE"]),
        h("button", { type: "button", id: "fb-del", title: "Delete the selected shot. The list may never be emptied — the solver falls back to the shipped default when it is handed none." }, ["DEL"]),
        h("button", { type: "button", id: "fb-up", title: "Move the selected shot earlier" }, ["‹ UP"]),
        h("button", { type: "button", id: "fb-down", title: "Move the selected shot later" }, ["DOWN ›"]),
        h("button", { type: "button", id: "fb-norm", title: "Rescale every duration so they sum to 1. Changes no framing — the solver already normalises — but makes the copied numbers mean what they look like." }, ["NORM"]),
      ]),
    ]),
    h("div", { id: "fb-rows", class: "pane", role: "tabpanel" }),
    json,
    h("div", { class: "sheet-foot balanced-row" }, [
      h("button", { id: "fb-reset", title: "Throw away every edit, here and saved, and go back to the shipped DEFAULT shot list." }, ["RESET"]),
      h("button", { id: "fb-copy" }, ["COPY VALUES"]),
      h("button", { id: "fb-close", class: "bigbtn", title: "Close the editor. Every edit is already saved — the next race flies these shots." }, ["DONE"]),
    ]),
  ]));
  return root;
}

/** Build the FLYBY SHOT EDITOR in `el` and wire it (flyby-editor.js:15-662 `create`). */
export function mountFlybyEditor(el: HTMLElement, deps: FlybyEditorDeps): FlybyEditorMount {
  log.info("FlybyPanel.create");
  const doc = el.ownerDocument;
  const store = deps.store;
  const clipboard = deps.clipboard || defaultClipboard;
  const root = buildShell(doc);
  el.appendChild(root);
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    (root.querySelector("#" + id) as T | null) ?? (doc.getElementById(id) as T | null);
  const need = <T extends HTMLElement = HTMLElement>(id: string): T => $<T>(id)!;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const track = (): FlybyTrack | null => (deps.track && deps.track()) || null;
  const devApi = (): FlybyDevApi | null => (deps.devApi && deps.devApi()) || null;

  // The edited list. Seeded from the SAVED list, or the shipped DEFAULT, and kept
  // across opens so closing the panel to look at the scene does not lose an
  // afternoon of framing.
  let shots: FlybyShot[] | null = null;
  let sel = 0;
  let u = 0;

  function defaults(): FlybyShot[] {
    return !deps.flyby ? [] : clone(deps.flyby.DEFAULT) as FlybyShot[];
  }

  /* THE EDITS ARE SAVED, AND THAT IS THE POINT OF THE PANEL.
   *
   * Reported: "once I hit DONE in the editor it doesn't actually change the start
   * shots." It did not. DONE only closed the sheet; the list lived in this
   * closure, and the game called FlybySeq.solve(track, progress) with NO third
   * argument, so the pre-race flyby always played the shipped DEFAULT however long
   * the author spent framing it. The preview was honest and everything after it
   * was discarded.
   *
   * The list is now the same kind of thing the lighting tuner's profiles are: a
   * saved edit under a26., written on every change so DONE, ESCAPE and QUIT all
   * keep it, and read back when a run starts. COPY VALUES is still how an edit
   * becomes the SHIPPED default for everyone — this is one player's.
   *
   * NULL MEANS "THE SHIPPED SEQUENCE", never a copy of it: storing the default
   * would pin this player to today's shots and silently ignore every later change
   * to them. RESET therefore needs no special case — it restores the default, the
   * comparison below sees no edit, and the key clears itself. */
  function persist(): void {
    const list = shots || [];
    const pristine = !list.length || JSON.stringify(list) === JSON.stringify(defaults());
    try { store.set("flybyShots", pristine ? null : savedForm(list)); }
    catch (e) { log.warn("flyby shots did not save", e); }
  }

  /** The saved list, or null. Held to shotErrors() and not validateShots(): the
   *  solver normalises by the durations' own total, so a list nobody pressed
   *  NORMALISE on plays exactly as previewed and must not be thrown away.
   *  A COPY: store.get() hands out its cache object, and the panel edits its list
   *  in place — sharing it made the run's flybyShots move under every slider. */
  function loadSaved(): FlybyShot[] | null { return loadSavedFrom(store); }

  function ensure(): FlybyShot[] { if (!shots) shots = loadSaved() || defaults(); return shots; }

  /** Cumulative bounds of shot `i` as fractions of the whole run — the same
   *  arithmetic FlybySeq.solve() does, so a scrub position and a shot chip agree. */
  function span(i: number): { from: number; to: number } {
    const list = ensure();
    let total = 0;
    for (const s of list) total += s.dur || 0;
    if (!(total > 0)) total = 1;
    let acc = 0;
    for (let k = 0; k < i && k < list.length; k++) acc += list[k]!.dur || 0;
    return { from: acc / total, to: (acc + ((list[i] && list[i]!.dur) || 0)) / total };
  }
  function midOf(i: number): number { const s = span(i); return (s.from + s.to) / 2; }

  function cur(): FlybyShot | undefined { const list = ensure(); return list[Math.max(0, Math.min(list.length - 1, sel))]; }
  function poseOf(slot: PoseSlot) { const s = cur(); return s && s[slot.arr] && s[slot.arr][slot.i]; }

  function fmt(d: RangeDef, v: number, field?: string): string {
    if (field === "distR" || field === "yR") {
      try {
        const t = track();
        const b = t && deps.flyby && deps.flyby.bounds ? deps.flyby.bounds(t) : null;
        const metric = metricValue(field, v, b && b.rad);
        if (metric) return metric;
      } catch { /* no built circuit yet: keep the portable authored unit */ }
    }
    const dec = (String(d.step).split(".")[1] || "").length;
    return (+v).toFixed(Math.min(dec, 3)) + (d.unit || "");
  }

  // ---- live preview ---------------------------------------------------------

  /* THE PREVIEW IS THE WHOLE POINT, and it is one call: FlybySeq solves the
     edited list directly, so nothing here has to reimplement a pose.
     __apex IS NULL, NOT UNDEFINED, ON A PLAYER BOOT: devApi() may hand back
     null, or an object without flybyCam. */
  function apiReady(): boolean {
    const a = devApi();
    return !!a && !!a.flybyCam;
  }

  /** The list the PREVIEW flies: a copy, re-taken whenever the edited list's
   *  CONTENTS change. FlybySeq caches plans and corner bindings per shot/list
   *  object, and the sliders edit this panel's list in place — so passing it
   *  directly previewed the first plan forever (a corner shot's x/y/off/corner
   *  did nothing after the first frame). A scrub with no edit reuses the copy. */
  let playKey = "", playList: FlybyShot[] | null = null;
  function playable(): FlybyShot[] {
    const key = JSON.stringify(ensure());
    if (key !== playKey || !playList) { playKey = key; playList = clone(ensure()); }
    return playList;
  }
  function preview(): void {
    if (!apiReady()) { askApi(); status(null, "preview unavailable — loading the dev API…"); return; }
    let r: FlybyCamResult | null = null;
    try { r = devApi()!.flybyCam!(u, playable()); } catch (e) { status(null, "preview failed: " + (e && (e as Error).message)); return; }
    if (!r) { status(null, "no track built yet — start a race, then pause"); return; }
    if (r.index !== sel) { sel = r.index; refreshChips(); refreshRows(); }
    status(r, "");
  }

  /** The one line that tells an author whether the shot is good: which shot, how
   *  high the eye ended up, what lens — and whether the eye is INSIDE something,
   *  which is the defect the whole sequencer exists to prevent and the one thing
   *  a still frame cannot show you. */
  function status(r: FlybyCamResult | null, note: string): void {
    const host = $("fb-status"); if (!host) return;
    if (!r) { host.textContent = note || ""; host.classList.remove("fb-inside"); return; }
    // A shot down the ROAD is judged the way the flyby-shots test judges it: the
    // props' axis-aligned boxes of an angled grandstand cross the straight
    // (Bahrain), so `inside` there is not a defect — being off the road is.
    const offRoad = !!r.onRoad && !(Math.abs(r.lat as number) <= 12);
    const bad = r.onRoad ? offRoad : !!r.inside;
    const verdict = r.onRoad
      ? (offRoad ? "  ·  ON-ROAD SHOT " + (r.lat == null ? "OFF THE TRACK" : Math.abs(r.lat).toFixed(1) + " m OFF THE ROAD") + " — move this eye"
        : "  ·  clear (on road)")
      : r.inside ? "  ·  INSIDE A " + String(r.inside.kind).toUpperCase() + " — move this eye"
        : "  ·  clear";
    // The clearance's rescue, made visible: a shot authored beside a building
    // lifts a metre or two, one authored inside a grandstand lifts twenty.
    const lift = r.lift > 0.05 ? "  ·  lifted " + r.lift.toFixed(1) + " m" : "";
    host.textContent = "u " + r.u.toFixed(3) + "  ·  " + r.shot + " [" + r.index + "]" +
      "  ·  eye " + r.eye.join(", ") + "  ·  fov " + r.fov + lift + verdict;
    host.classList.toggle("fb-inside", bad);
  }

  // ---- rows -----------------------------------------------------------------

  /** Rename a numberRow in place: the label's text node and the input's aria-label. */
  function relabel(id: string, label: string): void {
    const row = $("fb-row-" + id), inp = $("fb-in-" + id);
    const lab = row && row.querySelector(".tune-label");
    if (lab && lab.firstChild && lab.firstChild.nodeType === 3) lab.firstChild.nodeValue = label + " ";
    if (inp) inp.setAttribute("aria-label", label);
  }

  function numberRow(host: HTMLElement, id: string, label: string, d: RangeDef, onInput: (v: number) => void): HTMLElement {
    const item = doc.createElement("div");
    item.className = "adv-item"; item.id = "fb-row-" + id;
    const lab = doc.createElement("label"); lab.className = "tune-row";
    const span = doc.createElement("span"); span.className = "tune-label";
    span.textContent = label + " ";
    const b = doc.createElement("b"); b.id = "fb-v-" + id;
    span.appendChild(b);
    const inp = doc.createElement("input");
    inp.type = "range"; inp.min = String(d.min); inp.max = String(d.max); inp.step = String(d.step);
    inp.id = "fb-in-" + id;
    inp.setAttribute("aria-label", label);
    inp.oninput = () => onInput(parseFloat(inp.value));
    lab.appendChild(span); lab.appendChild(inp);
    item.appendChild(lab);
    host.appendChild(item);
    return item;
  }

  function selectRow(host: HTMLElement, id: string, label: string, values: readonly (string | number)[], onChange: (v: string) => void): HTMLElement {
    const item = doc.createElement("div");
    item.className = "adv-item"; item.id = "fb-row-" + id;
    const lab = doc.createElement("label"); lab.className = "tune-row";
    const span = doc.createElement("span"); span.className = "tune-label";
    span.textContent = label;
    const s = doc.createElement("select");
    s.id = "fb-in-" + id;
    s.setAttribute("aria-label", label);
    for (const v of values) {
      const o = doc.createElement("option");
      o.value = String(v); o.textContent = String(v).toUpperCase();
      s.appendChild(o);
    }
    s.onchange = () => onChange(s.value);
    lab.appendChild(span); lab.appendChild(s);
    item.appendChild(lab);
    host.appendChild(item);
    return item;
  }

  function edited(): void { persist(); refreshChips(); refreshRows(); preview(); }

  // ---- the TRACK CARD and the ANNOUNCER -------------------------------------
  //
  // Both belong to the loading screen, which is the screen these shots are
  // framed for — and neither can be authored anywhere else. The loading screen
  // owns the numbers and the clamping; this file owns the rows. READ THROUGH
  // FUNCTIONS, not captured at mount: an empty table builds an empty group,
  // which looks like "the feature is not there yet" rather than a bug.
  const cardDefs = (): Readonly<Record<string, CardDef>> => (deps.cardDefs && deps.cardDefs()) || {};
  const cardKeys = (): readonly string[] => (deps.cardKeys && deps.cardKeys()) || [];

  /** The loading card, or null where the shell has not handed one over. */
  function cardHost(): CardHost | null {
    const ls = deps.loadingScreen ? deps.loadingScreen() : null;
    return ls && typeof ls.setCard === "function" ? ls : null;
  }
  /** The circuit the card would describe. */
  function cardInfo(): unknown {
    try { return deps.loadingInfo ? deps.loadingInfo() : null; } catch { return null; }
  }

  /** Put the real card on screen, or take it down. `hold` is a phase of its own —
   *  click-through and unscrimmed — so the panel keeps its clicks and the scene
   *  the card is being framed against stays visible behind it. */
  function showCard(on: boolean): void {
    const ls = cardHost(); if (!ls) return;
    if (!on) { ls.stop(); return; }
    const info = cardInfo();
    if (info) { try { ls.hold(info); } catch (e) { log.warn("card preview failed", e); } }
  }

  function buildCardRows(host: HTMLElement): void {
    const ls = cardHost();
    const defs = cardDefs(), keys = cardKeys();
    if (!ls || !keys.length) return;
    const head = doc.createElement("h3");
    head.textContent = "TRACK CARD"; head.className = "fb-group";
    host.appendChild(head);
    for (const k of keys) {
      numberRow(host, "card-" + k, defs[k]!.label, defs[k]!, (v) => {
        // The SLIDER is not the truth — the clamp is. setCard() hands back what
        // actually took, and writing that straight back into the rows is what
        // keeps a dragged thumb from reading 1.8 on a card that stopped at 1.6.
        refreshCard(ls.setCard({ [k]: v }));
      });
      // The lap outline is a raster sized once; repaint on `change`, not `input`.
      const inp = $<HTMLInputElement>("fb-in-card-" + k);
      if (inp) inp.onchange = () => showCard(true);
    }
    const item = doc.createElement("div");
    item.className = "adv-item";
    const btn = doc.createElement("button");
    btn.type = "button"; btn.id = "fb-card-reset";
    btn.textContent = "RESET CARD";
    btn.title = "Put the track card back at its shipped size and position. Leaves the shots alone.";
    btn.onclick = () => { refreshCard(ls.resetCard()); showCard(true); };
    item.appendChild(btn);
    host.appendChild(item);
  }

  /** Write a geometry into the three sliders. */
  function refreshCard(geom: Record<string, number> | null | undefined): void {
    const defs = cardDefs();
    const host = cardHost();
    const g = geom || (host && host.card()) || null;
    if (!g) return;
    for (const k of cardKeys()) if (typeof g[k] === "number") setNum("card-" + k, defs[k]!, g[k]);
  }

  /* THE ANNOUNCER'S SCRIPT, SHOWN AS TEXT. It is DERIVED from the circuit, so
   * the only way to know what a given track gets is to ask — and an author
   * re-framing a 24 s flyby needs to know whether the voice fills it or stops
   * at second nine. */
  function annHost(): AnnouncerHost | null {
    const a = deps.announcer ? deps.announcer() : null;
    return a && typeof a.scriptFor === "function" ? a : null;
  }

  function buildAnnRows(host: HTMLElement): void {
    const a = annHost(); if (!a) return;
    const head = doc.createElement("h3");
    head.textContent = "ANNOUNCER"; head.className = "fb-group";
    host.appendChild(head);
    const item = doc.createElement("div");
    item.className = "adv-item";
    const text = doc.createElement("p");
    text.id = "fb-ann-script"; text.className = "as-note";
    const ops = doc.createElement("div");
    ops.className = "balanced-row";
    const play = doc.createElement("button");
    play.type = "button"; play.id = "fb-ann-play"; play.textContent = "PLAY";
    play.title = "Read the script aloud, at the voice, pitch and rate set in SETTINGS → AUDIO.";
    // RE-RESOLVED IN THE HANDLER, not the `a` captured above: the announcer may
    // be replaced after mount, and a captured inert one would fail silently.
    play.onclick = () => {
      const live = annHost(), info = cardInfo();
      // preview() ignores the player's ANNOUNCER switch — pressing PLAY in an
      // authoring panel IS the consent — but not master SOUND, which means
      // silence. Say which of the two refused rather than doing nothing.
      if (!live || !info || !live.preview(info)) {
        flash(play, live && live.available() ? "SOUND OFF" : "NO VOICES");
      }
    };
    const stop = doc.createElement("button");
    stop.type = "button"; stop.id = "fb-ann-stop"; stop.textContent = "STOP";
    stop.onclick = () => { const live = annHost(); if (live) live.stop(); };
    ops.append(play, stop);
    item.append(text, ops);
    host.appendChild(item);
  }

  /** Re-derive the script for whatever circuit is loaded now. */
  function refreshAnn(): void {
    const a = annHost(), host = $("fb-ann-script");
    if (!a || !host) return;
    const info = cardInfo();
    let lines: string[] = [];
    try { lines = info ? a.scriptFor(info) : []; } catch { lines = []; }
    host.textContent = lines.length ? lines.join(" ") : "No circuit loaded — start a race, then pause.";
  }

  function buildRows(): void {
    const host = need("fb-rows");
    if (host.dataset["built"]) return;
    host.dataset["built"] = "1";

    // ---- the track card ----
    buildCardRows(host);

    // ---- the shot itself ----
    const head = doc.createElement("h3");
    head.textContent = "SHOT"; head.className = "fb-group";
    host.appendChild(head);
    numberRow(host, "dur", "DURATION (share of the run)", DUR, (v) => { cur()!.dur = v; edited(); });
    selectRow(host, "ease", "EASING", EASES, (v) => { cur()!.ease = v; edited(); });
    numberRow(host, "fov0", "FOV FROM", FOV, (v) => { cur()!.fov![0] = v; edited(); });
    numberRow(host, "fov1", "FOV TO", FOV, (v) => { cur()!.fov![1] = v; edited(); });

    // ---- the announcer ----
    buildAnnRows(host);

    // ---- the four poses ----
    for (const slot of SLOTS) {
      const h = doc.createElement("h3");
      h.textContent = slot.label; h.className = "fb-group";
      host.appendChild(h);
      selectRow(host, slot.key + "-at", slot.label + " ANCHOR", AT_KINDS, (v) => {
        const s = cur()!;
        s[slot.arr][slot.i] = switchPoseAt(poseOf(slot), v);
        edited();
      });
      selectRow(host, slot.key + "-n", slot.label + " CORNER", CORNER_NS, (v) => {
        const p = poseOf(slot)!;
        p.n = /^\d+$/.test(v) ? parseInt(v, 10) : v;
        edited();
      });
      selectRow(host, slot.key + "-rank", slot.label + " LANDMARK", RANKS, (v) => {
        poseOf(slot)!.rank = parseInt(v, 10) || 0;
        edited();
      });
      for (const f of FIELD_IDS) {
        numberRow(host, slot.key + "-" + f, slot.label + " " + FIELD[f].label, FIELD[f], (v) => {
          poseOf(slot)![f] = v;
          edited();
        });
      }
    }
  }

  function refreshChips(): void {
    const host = $("fb-shots"); if (!host) return;
    const list = ensure();
    // Rebuilt rather than patched: the chips ARE the list, and add / delete /
    // reorder all change its length.
    host.textContent = "";
    list.forEach((s, i) => {
      const b = doc.createElement("button");
      b.type = "button"; b.className = "lt-tab"; b.id = "fb-tab-" + i;
      // THE NUMBER ONLY. "1. landmark1" is one unbreakable word in a pill that is
      // a rail-width eighth; the id is on the chip's title, in the status line
      // above, and in the SHOT heading of the rows below.
      b.textContent = String(i + 1);
      b.title = (s.id || ("shot " + (i + 1))) + " — " + (s.dur || 0).toFixed(3) + " of the run";
      b.setAttribute("aria-label", "Shot " + (i + 1) + ": " + (s.id || i));
      b.setAttribute("role", "tab");
      b.setAttribute("aria-controls", "fb-rows");
      b.setAttribute("aria-selected", i === sel ? "true" : "false");
      b.classList.toggle("active", i === sel);
      b.tabIndex = i === sel ? 0 : -1;
      b.onclick = () => { sel = i; setU(midOf(i)); refreshChips(); refreshRows(); preview(); };
      b.onkeydown = (e) => chipKey(i, e);
      host.appendChild(b);
    });
    // Keep the shared panel's accessible name aligned with the selected shot.
    // The tabs are rebuilt after add/delete/reorder, so update this relation here
    // instead of leaving it pointing at a removed tab.
    const activeTab = $("fb-tab-" + sel);
    if (activeTab) host.setAttribute("aria-labelledby", activeTab.id);
    else host.removeAttribute("aria-labelledby");
    const prof = $("fb-profile");
    if (prof) {
      let sum = 0;
      for (const s of list) sum += (s.dur || 0);
      prof.textContent = list.length + " shots  ·  durations sum " + sum.toFixed(3) +
        (Math.abs(sum - 1) > 0.01 ? "  (press NORMALISE)" : "");
    }
  }

  function chipKey(i: number, e: KeyboardEvent): void {
    const list = ensure();
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % list.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next == null) return;
    e.preventDefault(); e.stopPropagation();
    sel = next; setU(midOf(next)); refreshChips(); refreshRows(); preview();
    const t = $("fb-tab-" + next); if (t && t.focus) t.focus();
  }

  function show(id: string, on: boolean): void {
    const row = $("fb-row-" + id);
    if (row) row.style.display = on ? "" : "none";
  }
  function setNum(id: string, d: RangeDef | FieldDef, v: number, field?: string): void {
    const inp = $<HTMLInputElement>("fb-in-" + id), b = $("fb-v-" + id);
    if (inp) inp.value = String(v);
    if (b) b.textContent = fmt(d, v, field);
  }

  function refreshRows(): void {
    const host = need("fb-rows");
    if (!host.dataset["built"]) return;
    const s = cur();
    if (!s) return;
    setNum("dur", DUR, s.dur as number);
    setNum("fov0", FOV, s.fov![0]!);
    setNum("fov1", FOV, s.fov![1]!);
    const ease = $<HTMLSelectElement>("fb-in-ease"); if (ease) ease.value = s.ease as string;
    for (const slot of SLOTS) {
      const p = poseOf(slot) || {};
      const at = $<HTMLSelectElement>("fb-in-" + slot.key + "-at"); if (at) at.value = p.at || "start";
      show(slot.key + "-n", p.at === "corner");
      show(slot.key + "-rank", p.at === "landmark");
      const n = $<HTMLSelectElement>("fb-in-" + slot.key + "-n"); if (n) n.value = String(p.n === undefined ? "first" : p.n);
      const rank = $<HTMLSelectElement>("fb-in-" + slot.key + "-rank"); if (rank) rank.value = String(p.rank || 0);
      const fields = poseFields(p);
      for (const f of FIELD_IDS) {
        const on = fields.indexOf(f) !== -1;
        show(slot.key + "-" + f, on);
        if (on && f === "y") relabel(slot.key + "-y", slot.label + " " + fieldLabel(p.at, "y"));
        if (on) setNum(slot.key + "-" + f, FIELD[f], typeof p[f] === "number" ? p[f] : FIELD[f].def, f);
      }
    }
  }

  function setU(v: number): void {
    u = Math.max(0, Math.min(1, v));
    const inp = $<HTMLInputElement>("fb-u"); if (inp) inp.value = String(Math.round(u * 1000));
    const lab = $("fb-u-val"); if (lab) lab.textContent = u.toFixed(3);
  }

  // ---- open / close ---------------------------------------------------------

  function isOpen(): boolean { return !root.hidden; }

  /* The shell's memoised agent-surface loader, handed in after its boot chain:
     this panel reads everything it previews through the dev API, which a Pages
     build does not fetch. Asked ONCE: a refused or failed inject leaves the
     panel degraded with a message, never a retry loop. */
  let _apiLoad: (() => unknown) | null = null, _apiAsked = false;
  function setApiLoader(fn: (() => unknown) | null): void {
    _apiLoad = typeof fn === "function" ? fn : null;
    if (_apiLoad && isOpen()) askApi();
  }
  function askApi(): void {
    if (_apiAsked || !_apiLoad || apiReady()) return;
    _apiAsked = true;
    Promise.resolve(_apiLoad()).then(() => { if (isOpen()) { preview(); refreshRows(); } })
      .catch((e: unknown) => { status(null, "the dev API did not load — preview unavailable"); log.warn("flyby panel: agent surface failed", e); });
  }

  function openFlyby(): void {
    log.info("FlybyPanel.open");
    askApi();
    ensure();
    buildRows();
    sel = Math.max(0, Math.min(ensure().length - 1, sel));
    setU(midOf(sel));
    root.hidden = false;
    need("fb-json").hidden = true;
    doc.body.classList.add("lt-open");    // same dock as the other two tuners
    refreshCard(null);
    refreshAnn();
    showCard(true);
    const pm = doc.getElementById("pmsettings"); if (pm) pm.hidden = true;
    // Nested under DISPLAY -> ADVANCED VISUALS: hide that page too, or its own
    // .hidden survives underneath and reappears the moment pmsettings does.
    const displayPage = doc.getElementById("pm-panel-display");
    if (displayPage) displayPage.hidden = true;
    refreshChips(); refreshRows(); preview();
  }

  function closeFlyby(showPauseMenu?: boolean): void {
    // Resume and QUIT call this blind, the way they call the other two tuners'
    // closers. Releasing the camera below is a real side effect, so a panel that
    // was never open stops here rather than snapping a camera nobody parked.
    if (!isOpen()) return;
    log.info("FlybyPanel.close");
    root.hidden = true;
    doc.body.classList.remove("lt-open");
    // The held card and any half-spoken script go with the panel.
    showCard(false);
    { const a = annHost(); if (a) a.stop(); }
    // The preview parks the camera through dbgCam; leaving it parked would hand
    // the player back a frozen flyby camera instead of their own car.
    // view("chase") is the release: it only needs a track, clears dbgCam
    // outright, and does not change the player's chosen camera MODE.
    const api = devApi();
    if (api && api.view) {
      try { api.view("chase"); } catch { /* no track built — nothing parked */ }
    }
    if (deps.snapGameCam) deps.snapGameCam();   // at the car, not a swoop back from the last previewed frame (no-op without a player)
    if (showPauseMenu && deps.paused && deps.paused()) {
      const pm = doc.getElementById("pmsettings"); if (pm) pm.hidden = false;   // back to the settings menu
      const displayPage = doc.getElementById("pm-panel-display");
      if (displayPage) displayPage.hidden = false;   // ...specifically its DISPLAY page
    }
  }

  // ---- wiring ---------------------------------------------------------------

  /** Say something on the button itself, then put the button BACK. The label is
   *  read from the button rather than passed in. Re-entrant calls keep the
   *  first captured label, not the message. */
  const flashState = new WeakMap<HTMLElement, { label: string; t: ReturnType<typeof setTimeout> | null }>();
  function flash(btn: HTMLElement, msg: string): void {
    let f = flashState.get(btn);
    if (!f) { f = { label: "", t: null }; flashState.set(btn, f); }
    if (!f.label) f.label = btn.textContent || "";
    btn.textContent = msg;
    if (f.t !== null) { clearTimeout(f.t); timers.delete(f.t); }
    const rec = f;
    const t = setTimeout(() => { timers.delete(t); rec.t = null; btn.textContent = rec.label; rec.label = ""; }, 1800);
    f.t = t; timers.add(t);
  }

  /** FREE CAMERA — the editor's sub-mode, as the lighting tuner has one. Flies
   *  from the frame being previewed on the flyby lens; SET SHOT START / END write
   *  the flown view into the selected shot, and DONE comes back here. */
  function setPose(end: 0 | 1, r: { shot: FlybyShot; err: { eye: number; look: number } } | null): string {
    const s = ensure()[sel];
    if (!s || !r || !r.shot) return "";
    s.eye[end] = r.shot.eye[0]!; s.look[end] = r.shot.look[0]!;
    s.fov![end] = Math.min(FOV.max, Math.max(FOV.min, r.shot.fov![0]!));   // the free camera flies 20-110°
    edited();
    return "Shot " + (sel + 1) + (end ? " ends" : " starts") + " here (round trip: eye " + r.err.eye + " m, look " + r.err.look + " m).";
  }
  function freeCam(): void {
    if (!deps.freeCam || !deps.freeCam.enterFrom) return;
    const c = deps.dbgCam ? deps.dbgCam() : null;
    const from: FreeCamCmd = c ? { eye: c.eye.slice() as Vec3, target: c.target.slice() as Vec3, fov: c.fov } : {};
    closeFlyby(false);
    const actions: FreeCamAction[] = [
      { label: "SET SHOT START", title: "Make this view where the selected shot begins", run: (r) => setPose(0, r) },
      { label: "SET SHOT END", title: "Make this view where the selected shot ends", run: (r) => setPose(1, r) },
    ];
    const ok = deps.freeCam.enterFrom(Object.assign(from, { lens: "flyby", back: openFlyby, actions }));
    if (!ok) openFlyby();
  }
  const openBtn = doc.getElementById("pm-flyby");
  if (openBtn) openBtn.onclick = openFlyby;
  need("fb-freecam").onclick = freeCam;
  need("fb-close").onclick = () => closeFlyby(true);
  need<HTMLInputElement>("fb-u").oninput = () => { setU(parseFloat(need<HTMLInputElement>("fb-u").value) / 1000); preview(); };
  need("fb-add").onclick = () => { shots = addShot(ensure(), sel); sel += 1; setU(midOf(sel)); edited(); };
  need("fb-dup").onclick = () => { shots = duplicateShot(ensure(), sel); sel += 1; setU(midOf(sel)); edited(); };
  need("fb-del").onclick = () => {
    const before = ensure().length;
    shots = deleteShot(ensure(), sel);
    if (shots.length === before) { flash(need("fb-del"), "NEED ONE"); return; }
    sel = Math.max(0, Math.min(shots.length - 1, sel)); setU(midOf(sel)); edited();
  };
  need("fb-up").onclick = () => {
    if (sel <= 0) return;
    shots = moveShot(ensure(), sel, -1); sel -= 1; setU(midOf(sel)); edited();
  };
  need("fb-down").onclick = () => {
    if (sel >= ensure().length - 1) return;
    shots = moveShot(ensure(), sel, 1); sel += 1; setU(midOf(sel)); edited();
  };
  need("fb-norm").onclick = () => { shots = normaliseDurs(ensure()); edited(); };
  need("fb-reset").onclick = () => { shots = defaults(); sel = 0; setU(midOf(0)); need("fb-json").hidden = true; edited(); };

  /* COPY VALUES — the injected clipboard owns the gesture-ordering (f1-game
     preferSync: execCommand during the gesture). */
  need("fb-copy").onclick = () => {
    const btn = need("fb-copy");
    const list = ensure();
    const bad = validateShots(list);
    const json = (bad.length ? "// THIS LIST WILL NOT BAKE:\n// " + bad.join("\n// ") + "\n" : "") + toBlob(list);
    const ta = need<HTMLTextAreaElement>("fb-json");
    ta.value = json; ta.hidden = false;
    ta.focus(); if (ta.setSelectionRange) ta.setSelectionRange(0, json.length);
    void clipboard(json).then((ok) => flash(btn,
      bad.length ? "COPIED (INVALID)" : (ok ? "COPIED ✓" : "SELECT & COPY ↑")));
  };

  return {
    openFlyby, closeFlyby, isOpen, setApiLoader, loadSaved, list: () => clone(ensure()),
    refresh: () => { if (isOpen()) { refreshChips(); refreshRows(); } },
    root,
    unmount() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (openBtn && openBtn.onclick === openFlyby) openBtn.onclick = null;
      if (isOpen()) closeFlyby(false);
      root.remove();
    },
  };
}

export type { PoseField };
