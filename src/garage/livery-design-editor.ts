/**
 * Livery editing tools. The caller owns persistence and the live Garage preview.
 *
 * Port of f1-game js/garage/livery-design-editor.js:1-180, verbatim: LABELS
 * :4-8, attach :9-177 (history and sync :10-40, undo / redo / compare :41-46,
 * the pattern rows :47-87, palettes :88-101, design actions :102-115, the
 * surface sections :116-156, the SPINE TOP grouping :157-170), label :178.
 *
 * f1-game reads the car lane's `LiveryDesign` global (js/car/livery-design.js:
 * PATTERNS, SECOND_COLOR, LINE_PATTERNS, LABELS, RANGES, PALETTES, value,
 * history). It is not on main yet, so it is injected:
 * `createLiveryDesignEditor(design)`. TODO(lane-car): pass src/car/livery-design.ts
 * (origin/lane-car/liverytex has it, with these names) once it merges.
 * The one WeakMap of histories per draft is per editor instance.
 */

/** A paint-job draft as the creator holds it: hex colours, pill ids and range strings, by field. */
export type LiveryDraft = Record<string, string>;

/** LiveryDesign.history(draft) (livery-design.js:258-274). */
export interface DraftHistory {
  record(d: LiveryDraft, drag?: boolean): void;
  undo(): LiveryDraft | null;
  redo(): LiveryDraft | null;
  canUndo(): boolean;
  canRedo(): boolean;
  original(): LiveryDraft;
}

/**
 * The slice of f1-game's LiveryDesign (js/car/livery-design.js:278) the editor
 * reads. TODO(lane-car): src/car/livery-design.ts.
 */
export interface LiveryDesignLike {
  readonly PATTERNS: readonly string[];
  readonly SECOND_COLOR: readonly string[];
  readonly LINE_PATTERNS: readonly string[];
  readonly LABELS?: Readonly<Record<string, string>> | undefined;
  /** [min, max, default] per range field. */
  readonly RANGES: Readonly<Record<string, readonly number[]>>;
  readonly PALETTES: readonly { readonly name: string; readonly colors: readonly string[] }[];
  value(liv: LiveryDraft, key: string): number;
  history(initial: LiveryDraft, limit?: number): DraftHistory;
}

/** The sheet's side of the editor (setup-sheet.js buildLiveryCreator :1270-1273). */
export interface LiveryEditorHost {
  /** applyPreview: repaint the swatch and the car; `drag` defers the 3D rebuild. */
  changed(drag?: boolean): void;
  /** flushLivPreview: run a deferred 3D rebuild now. */
  flush(): void;
  /** Paint `value` on the turntable car without touching the draft (COMPARE ORIGINAL). */
  preview(value: LiveryDraft): void;
  /** The sheet's pill-row builder (appends the row to the editor and returns it). */
  pillRow(label: string, key: string, values: readonly string[], dflt: string): HTMLElement;
  readonly spineRow: HTMLElement;
  readonly bodyRow: HTMLElement;
  readonly nameRow: HTMLElement;
  readonly markNote?: HTMLElement | undefined;
  readonly saveRow?: HTMLElement | undefined;
}

export interface AttachedEditor {
  /** Record an edit in the history (a `drag` coalesces with the previous one) and resync. */
  changed(drag?: boolean): void;
}

export interface LiveryDesignEditor {
  attach(root: HTMLElement, draft: LiveryDraft, api: LiveryEditorHost): AttachedEditor;
  label(id: string): string;
}

const LABELS: Readonly<Record<string, string>> = { ribbon: "Ribbon", brokenChevron: "Broken chevrons", contours: "Contour lines",
  honeycomb: "Honeycomb", segments: "Segmented panels", gradient: "Gradient", twoTone: "Two-tone sweep",
  checker: "Checkered flag", diamonds: "Diamond tiles", slashes: "Diagonal slashes",
  pinstripes: "Pinstripes", dots: "Rivet dots", lightning: "Lightning bolts", waves: "Wave bands", sunburst: "Sunburst rays", scallops: "Scallop scales",
  herringbone: "Herringbone weave", circuit: "Circuit traces", shards: "Angular shards", pixelFade: "Pixel fade", speedlines: "Speed lines" };

/** GarageLiveryDesignEditor over one LiveryDesign (livery-design-editor.js:2-179); null = no design module. */
export function createLiveryDesignEditor(LiveryDesign: LiveryDesignLike | null | undefined): LiveryDesignEditor {
  const sessions = new WeakMap<LiveryDraft, DraftHistory>();
  function attach(root: HTMLElement, draft: LiveryDraft, api: LiveryEditorHost): AttachedEditor {
    const D = LiveryDesign as LiveryDesignLike;
    let h = sessions.get(draft);
    if (!h) { h = D.history(draft); sessions.set(draft, h); }
    const hist = h;
    let restoring = false, comparing = false;
    const bindings: (() => void)[] = [], controls = document.createElement("div"); controls.className = "cs-liv-ed-finish";
    const status = document.createElement("p"); status.className = "cs-opt-desc"; status.setAttribute("role", "status");
    function button(label: string, action: () => void, host: HTMLElement = controls): HTMLButtonElement {
      const b = document.createElement("button"); b.type = "button"; b.className = "cs-liv-ed-none";
      b.textContent = label; b.onclick = action; host.appendChild(b); return b;
    }
    function sync(): void {
      undo.disabled = !hist.canUndo(); redo.disabled = !hist.canRedo();
      compare.textContent = comparing ? "SHOW EDITED" : "COMPARE ORIGINAL";
      compare.setAttribute("aria-pressed", String(comparing));
      for (const input of Array.from(root.querySelectorAll<HTMLInputElement>("input[data-liv-field]"))) {
        const key = input.dataset["livField"] as string;
        input.value = draft[key] || (input.type === "color" ? "#000000" : "");
        if (input.type === "color") input.classList.toggle("cs-liv-off", !draft[key]);
      }
      for (const b of Array.from(root.querySelectorAll<HTMLElement>("[data-cs-pill], [data-cs-finish]"))) {
        const pair = b.dataset["csPill"] ? b.dataset["csPill"].split(":") : ["finish", b.dataset["csFinish"] as string];
        const on = draft[pair[0] as string] === pair[1]; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
      }
      for (const bind of bindings) bind();
    }
    function restore(next: LiveryDraft | null, message: string): void {
      if (!next) return;
      api.flush(); comparing = false; restoring = true;
      for (const key of Object.keys(draft)) if (!Object.hasOwn(next, key)) delete draft[key];
      Object.assign(draft, next); sync(); api.changed(); restoring = false;
      status.textContent = message;
    }
    const undo = button("UNDO", () => restore(hist.undo(), "Previous edit restored."));
    const redo = button("REDO", () => restore(hist.redo(), "Edit restored."));
    const compare = button("COMPARE ORIGINAL", () => {
      api.flush(); comparing = !comparing; api.preview(comparing ? hist.original() : draft); sync();
      status.textContent = comparing ? "Showing the original paint job. Your edits are kept; the next edit returns to your draft." : "Showing your edited paint job.";
    });
    // Extend the existing rows: one selector per field, no parallel design menu.
    const before = api.spineRow.nextSibling;
    function insert<N extends Node>(node: N): N { root.insertBefore(node, before); return node; }
    function row(label: string): HTMLDivElement {
      const r = document.createElement("div"); r.className = "cs-liv-ed-row";
      const text = document.createElement("span"); text.className = "cs-liv-ed-lbl"; text.textContent = label;
      r.appendChild(text); return r;
    }
    const historyRow = row("EDITS"); historyRow.appendChild(controls);
    root.insertBefore(historyRow, api.nameRow); root.insertBefore(status, api.nameRow);
    const patternRows: { row: HTMLElement; when: () => boolean }[] = [];
    for (const [label, key, values, fallback] of [
      ["DESIGN AREA", "patternPlacement", ["crown", "wrap"], "crown"],
      ["WRAP SIDES", "patternSide", ["both", "left", "right"], "both"],
    ] as const) {
      const r = insert(api.pillRow(label, key, values, fallback));
      patternRows.push({ row: r, when: () => key !== "patternSide" || draft["patternPlacement"] === "wrap" });
    }
    const rangeLabels: Readonly<Record<string, string>> = { patternWidth: "DESIGN WIDTH", patternRepeat: "REPEATS", patternOffset: "SIDE OFFSET", patternTaper: "TAIL TAPER", patternOpacity: "OPACITY", patternRotation: "ROTATION", patternStretch: "LENGTH STRETCH", patternWeight: "LINE WEIGHT" };
    for (const [key, limits] of Object.entries(D.RANGES)) {
      const r = document.createElement("label"); r.className = "tune-row";
      const label = document.createElement("span"), text = document.createElement("span"), output = document.createElement("b");
      label.className = "tune-label"; text.textContent = rangeLabels[key] as string; label.append(text, output);
      const input = document.createElement("input");
      input.type = "range"; input.min = String(limits[0]); input.max = String(limits[1]); input.step = String(1);
      input.setAttribute("aria-label", rangeLabels[key] as string); input.dataset["livField"] = key;
      input.oninput = () => { draft[key] = input.value; api.changed(true); };
      input.onchange = () => { api.changed(); api.flush(); };
      r.append(label, input); insert(r);
      patternRows.push({ row: r, when: () => key === "patternWeight" ? D.LINE_PATTERNS.includes(draft["spineLogo"] as string) : key !== "patternRepeat" || !["ribbon", "gradient", "twoTone"].includes(draft["spineLogo"] as string) });
      bindings.push(() => { input.value = String(D.value(draft, key)); output.textContent = input.value + (key === "patternRepeat" ? "" : key === "patternRotation" ? "°" : "%"); });
    }
    bindings.push(() => {
      const enabled = D.PATTERNS.includes(draft["spineLogo"] as string);
      for (const item of patternRows) {
        const off = !enabled || !item.when();
        item.row.setAttribute("aria-disabled", String(off)); item.row.classList.toggle("tune-off", off);
        item.row.title = !enabled ? "Choose an adjustable design in SPINE TOP" : off ? "Not used by the current design or area" : "";
        for (const input of Array.from(item.row.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input"))) input.disabled = off;
      }
    });
    const palettes = row("PALETTE"), paletteButtons = document.createElement("span"); paletteButtons.className = "cs-liv-ed-finish";
    palettes.appendChild(paletteButtons); root.insertBefore(palettes, api.bodyRow);
    for (const p of D.PALETTES) button(p.name.toUpperCase(), () => {
      [draft["c1"], draft["c2"], draft["patternTint"]] = p.colors as [string, string, string]; draft["patternSecond"] = p.colors[1] as string;
      api.changed(); status.textContent = p.name + " applied to primary, accent and design colours. Other authored surface colours are kept.";
    }, paletteButtons);
    Array.from(paletteButtons.children as HTMLCollectionOf<HTMLElement>).forEach((b, i) => {
      const colours = (D.PALETTES[i] as { readonly colors: readonly string[] }).colors, swatch = document.createElement("span");
      swatch.className = "cs-liv-swatch"; swatch.setAttribute("aria-hidden", "true");
      swatch.style.width = "100%"; swatch.style.height = "6px"; swatch.style.flexBasis = "100%";
      swatch.style.background = "linear-gradient(90deg," + colours[0] + " 0 33%," + colours[1] + " 33% 66%," + colours[2] + " 66% 100%)";
      b.style.flexWrap = "wrap"; b.style.gap = "4px"; b.appendChild(swatch);
      b.title = "Apply " + (D.PALETTES[i] as { readonly name: string }).name + " to body primary, accent and adjustable-pattern colours";
    });
    const actionRow = row("DESIGN"), actions = document.createElement("span"); actions.className = "cs-liv-ed-finish"; actionRow.appendChild(actions); insert(actionRow);
    const swap = button("SWAP COLOURS", () => {
      [draft["patternTint"], draft["patternSecond"]] = [draft["patternSecond"] || draft["c1"] as string, draft["patternTint"] || draft["c2"] as string];
      api.changed(); status.textContent = "Design colours swapped. Body colours are unchanged.";
    }, actions);
    const reset = button("RESET SETTINGS", () => {
      for (const [key, limits] of Object.entries(D.RANGES)) draft[key] = String(limits[2]);
      draft["patternPlacement"] = "crown"; draft["patternSide"] = "both";
      api.changed(); status.textContent = "Design size, placement, rotation, stretch, line weight and opacity reset. Colours and selected design are kept. Undo restores your settings.";
    }, actions);
    bindings.push(() => {
      reset.disabled = !D.PATTERNS.includes(draft["spineLogo"] as string);
      swap.disabled = !D.SECOND_COLOR.includes(draft["spineLogo"] as string);
    });
    // Keep each setting and its paint beside the part it changes. Move the
    // original nodes, so their handlers, dependency rules and keyboard state survive.
    const fields = new Map<string, HTMLElement>();
    for (const r of Array.from(root.children as HTMLCollectionOf<HTMLElement>)) {
      for (const c of Array.from(r.querySelectorAll<HTMLElement>("input, button"))) {
        const key = c.dataset["livField"] || (c.dataset["csPill"] || "").split(":")[0] || (c.dataset["csFinish"] ? "finish" : "");
        if (key) fields.set(key, r);
      }
      if (r.classList.contains("cs-liv-ed-sec")) r.remove();
    }
    function section(title: string, description: string, keys: readonly string[], extras: readonly (HTMLElement | null | undefined)[] = []): void {
      const heading = document.createElement("div"); heading.className = "cs-liv-ed-sec";
      heading.setAttribute("role", "heading"); heading.setAttribute("aria-level", "3"); heading.textContent = title;
      heading.title = description; root.appendChild(heading);
      const note = document.createElement("p"); note.className = "cs-opt-desc"; note.textContent = description; root.appendChild(note);
      for (const item of [...keys.map((key) => fields.get(key)), ...extras]) {
        if (!item) continue;
        item.setAttribute("data-liv-section", title); root.appendChild(item);
      }
    }
    section("COLOUR PALETTE", "Changes body primary, accent and adjustable-pattern colours. Other painted surfaces keep their colours.", [], [palettes]);
    section("BODY PAINT & BASE FINISH", "Main body, nose and sidepods. FINISH is the whole-car default; regional INHERIT buttons use it.",
      ["finish", "c1", "c2", "stripe", "noseStripe", "accent", "nose", "pod", "podFinish", "lower", "upper", "bodySplit"]);
    section("ENGINE COVER — SHAPE & PAINT", "The raised cover behind the cockpit. Shape, vents, base colour and finish.",
      ["cover", "coverFinish", "spineHeight", "coverVents"]);
    section("SPINE TOP — ARTWORK & COLOURS", "Artwork along the top of the engine cover. Select one design; only the colour controls it uses are enabled.",
      ["spineLogo", "patternTint", "patternSecond", "spineTint", "saddleTint", "sunTint", "bandTint2"]);
    section("SPINE PATTERN — SIZE & PLACEMENT", "Rotate or stretch adjustable artwork and tune its coverage. LINE WEIGHT applies to stroked designs. CROWN paints the top and tail; WRAP extends onto the selected cover sides.",
      ["patternPlacement", "patternSide", ...Object.keys(D.RANGES)], [actionRow]);
    section("COVER SIDES & TAIL LINK", "Side artwork and its fills. COVER BIND links top and side graphics; FIN HANDOFF controls the transition to the tail.",
      ["spineSide", "sideTint", "plateTint", "coverBind", "finHandoff"]);
    section("WINGS", "Front and rear wing paint. Carbon flaps keep their carbon material; WING FINISH applies to painted wing surfaces.",
      ["wingCarbon", "wing", "rearWing", "wingFinish"]);
    section("TAIL FIN", "The vertical fin behind the engine cover. Choose its shape, paint, graphic and badge.",
      ["finShape", "fin", "finFinish", "finStyle", "finArt", "finBadge"]);
    section("TEAM MARKS & NUMBERS", "Emblem colours, number lettering and sponsor names. These controls affect identity marks across the car.",
      ["logo", "logo2", "logo3", "numFont", "sponsors"], [api.markNote]);
    section("COCKPIT & CAMERA", "Halo, mirror and T-cam: paint, finish and mirror housing colour.", ["halo", "haloFinish", "mirrorTint", "mirrorFinish", "tcam"]);
    section("WHEELS & BRAKES", "Paint-only wheel colours, applied to all four wheels. NONE keeps the BRAKES and TYRES parts' own colours.", ["rimTint", "caliperTint", "sidewallInk"]);
    section("HELMET", "Helmets for both of this team's drivers, like the rest of the paint job. TEAM keeps each driver's own design; the other styles repaint it from HELMET BASE and HELMET ACCENT.", ["helmetStyle", "helmetBase", "helmetAccent"]);
    section("REVIEW & SAVE", "Undo or compare your edits, then name and save this paint job.", [], [historyRow, status, api.nameRow, api.saveRow]);
    // One SPINE TOP selection, divided by purpose rather than a wall of pills.
    const group = api.spineRow.querySelector(".cs-liv-ed-finish") as HTMLElement, choices = Array.from(group.querySelectorAll<HTMLElement>("button"));
    const marks = ["logo", "none", "bigmark", "wordmark", "number"];
    group.replaceChildren();
    for (const [label, accepts] of [
      ["MARKS & IDENTITY", (id: string) => marks.includes(id)],
      ["FIXED GRAPHICS", (id: string) => !marks.includes(id) && !D.PATTERNS.includes(id)],
      ["ADJUSTABLE PATTERNS", (id: string) => D.PATTERNS.includes(id)],
    ] as const) {
      const labelNode = document.createElement("span"); labelNode.className = "cs-liv-ed-sec";
      labelNode.textContent = label; labelNode.style.flexBasis = "100%"; group.appendChild(labelNode);
      for (const b of choices) if (accepts((b.dataset["csPill"] as string).split(":")[1] as string)) group.appendChild(b);
    }
    sync();
    return Object.freeze({
      changed(drag?: boolean) {
        if (comparing) api.preview(draft);
        comparing = false; if (!restoring) hist.record(draft, !!drag); sync();
      },
    });
  }
  return Object.freeze({ attach, label: (id: string): string => LABELS[id] || (LiveryDesign && LiveryDesign.LABELS && LiveryDesign.LABELS[id]) || id });
}
