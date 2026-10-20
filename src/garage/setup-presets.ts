/**
 * Named, bounded mechanical sheets. Applying never changes parts or paint.
 *
 * Port of f1-game js/garage/setup-presets.js:1-161, verbatim: cleanTune :6-16,
 * cleanContext :17-26, contextDiff :27-39, normalize :40-53, list/editable/write
 * :54-65, save :66-75, remove :76-81, diff :82-86, preview :87-94, apply :95-105,
 * mount :106-157.
 *
 * f1-game reads the global SetupTune (over the global GameStore.store) for the
 * fitted sheet while every library call takes `store` explicitly; here the
 * SetupTune is injected once: `createSetupPresets(tune)`. The id `sequence`
 * counter lives in that instance instead of the f1-game IIFE.
 */
import { SetupTune, type SetupTuneApi, type Tune, type TuneField } from "./setup-tune";
import type { GarageStoreLike } from "./store";

export const PREFIX = "setupPresets.";
export const MAX = 12;

/** A preset's bounded provenance (cleanContext). */
export interface PresetContext {
  v: 1;
  physics: string | null;
  track: string | null;
  parts: Record<string, string | null>;
  note: string;
}

export interface PresetRow {
  id: string;
  name: string;
  tune: Tune;
  trackId: string | null;
  at: number;
  /** Present only on presets saved with a context; null when the stored one was unreadable. */
  context?: PresetContext | null;
}

export interface PresetLibrary {
  v: 1;
  items: PresetRow[];
}

/** A library write's verdict; `durable` is absent on a refusal made before any write. */
export interface PresetResult {
  ok: boolean;
  durable?: boolean;
  reason: string | null;
  row?: PresetRow;
}

export interface PresetChange {
  field: TuneField;
  label: string;
  before: number;
  after: number;
  unit: string;
}

export interface PresetPreview {
  id: string;
  tune: Tune;
  current: Tune;
  context: PresetContext | null | undefined;
  at: number;
  contextChanges: string[];
  changes: PresetChange[];
  setupRevision: string | number | null;
  libraryRevision: string | number | null;
}

export interface PresetMountOptions {
  teamId: string;
  store: GarageStoreLike;
  trackId?: string | null;
  /** The current provenance (physics revision, circuit, fitted parts). */
  context?: () => object;
  refresh?: () => void;
}

export interface PresetMount {
  section: HTMLElement;
  render(id?: string): void;
}

const key = (team: string): string => PREFIX + team;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

function text(v: unknown, n: number): string | null {
  return typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, n) : null;
}

export function createSetupPresets(tune: SetupTuneApi = SetupTune) {
  let sequence = 0;
  function cleanTune(t: unknown): Tune | null {
    if (!t || typeof t !== "object") return null;
    const src = t as Record<string, unknown>;
    const out: Partial<Tune> = {};
    for (const field of tune.FIELDS) {
      const v = src[field];
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      const n = tune.clampField(field, v);
      if (n !== v) return null;
      out[field] = n;
    }
    return out as Tune;
  }
  function cleanContext(raw: unknown): PresetContext | null {
    if (!isObj(raw) || raw["v"] !== 1) return null;
    const parts: Record<string, string | null> = {};
    const rp = raw["parts"];
    if (rp && typeof rp === "object") for (const k of Object.keys(rp).sort().slice(0, 32)) {
      const pv = (rp as Record<string, unknown>)[k];
      if (/^[a-z0-9_-]{1,48}$/i.test(k) && typeof pv === "string") parts[k] = text(pv, 96);
    }
    return { v: 1, physics: text(raw["physics"], 96), track: text(raw["track"], 128), parts,
      note: text(raw["note"], 160) || "" };
  }
  function contextDiff(saved: unknown, current: unknown): string[] {
    const a = cleanContext(saved), b = cleanContext(current);
    if (!a) return ["Saved context unknown (older preset)."];
    const out: string[] = [];
    for (const k of ["physics", "track"] as const) {
      if (!a[k] || !b || !b[k]) out.push(k + ": context unknown");
      else if (a[k] !== b[k]) out.push(k + ": " + a[k] + " → " + b[k]);
    }
    const keys = new Set([...Object.keys(a.parts), ...Object.keys(b && b.parts || {})]);
    if (!keys.size) out.push("Fitted build context unknown.");
    for (const k of keys) if (a.parts[k] !== (b && b.parts[k])) out.push("Part " + k + ": " + (a.parts[k] || "unknown") + " → " + (b && b.parts[k] || "unknown"));
    return out;
  }
  function normalize(raw: unknown): PresetLibrary {
    if (!isObj(raw) || raw["v"] !== 1 || !Array.isArray(raw["items"])) return { v: 1, items: [] };
    const ids = new Set<string>(), items: PresetRow[] = [];
    for (const row of (raw["items"] as unknown[]).slice(0, MAX)) {
      const t = cleanTune(isObj(row) ? row["tune"] : null);
      if (!t || !isObj(row)) continue;
      const id = row["id"], name = row["name"], trackId = row["trackId"], at = row["at"];
      if (typeof id !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(id) || ids.has(id)
          || typeof name !== "string" || !name.trim()) continue;
      ids.add(id);
      items.push({ id, name: name.trim().slice(0, 32), tune: t,
        trackId: typeof trackId === "string" ? trackId.slice(0, 128) : null,
        at: typeof at === "number" && Number.isFinite(at) ? at : 0, ...(Object.hasOwn(row, "context") ? { context: cleanContext(row["context"]) } : {}) });
    }
    return { v: 1, items };
  }
  function list(store: GarageStoreLike, team: string): PresetRow[] { return normalize(store.get(key(team), null)).items; }
  function editable(store: GarageStoreLike, team: string): boolean {
    const raw = store.get(key(team), null);
    return raw == null || (isObj(raw) && raw["v"] === 1 && Array.isArray(raw["items"]) && raw["items"].length <= MAX
      && normalize(raw).items.length === raw["items"].length);
  }
  function write(store: GarageStoreLike, team: string, items: PresetRow[]): PresetResult {
    if (!editable(store, team)) return { ok: false, reason: "incompatible" };
    const value: PresetLibrary = { v: 1, items };
    const result = store.write ? store.write(key(team), value) : { ok: true, durable: store.set(key(team), value) !== false, reason: null };
    return { ok: result.ok !== false, durable: result.durable !== false, reason: result.reason || null };
  }
  function save(store: GarageStoreLike, team: string, name: unknown, t: unknown, trackId?: unknown, context?: unknown): PresetResult {
    const items = list(store, team), clean = cleanTune(t), title = String(name || "").trim().slice(0, 32);
    if (!title || !clean) return { ok: false, reason: "invalid" };
    if (items.length >= MAX) return { ok: false, reason: "full" };
    if (items.some((r) => r.name.toLowerCase() === title.toLowerCase())) return { ok: false, reason: "name" };
    const row: PresetRow = { id: Date.now().toString(36) + "-" + (++sequence).toString(36), name: title, tune: clean,
      trackId: typeof trackId === "string" ? trackId.slice(0, 128) : null, at: Date.now(), ...(context ? { context: cleanContext(context) } : {}) };
    const result = write(store, team, items.concat([row]));
    return Object.assign(result, { row });
  }
  function remove(store: GarageStoreLike, team: string, id: string, expectedRevision?: string | number | null): PresetResult {
    if (expectedRevision != null && store.keyRevision && expectedRevision !== store.keyRevision(key(team))) return { ok: false, reason: "changed" };
    const items = list(store, team);
    if (!items.some((r) => r.id === id)) return { ok: false, reason: "missing" };
    return write(store, team, items.filter((r) => r.id !== id));
  }
  function diff(current: Readonly<Tune>, next: Readonly<Tune>): PresetChange[] {
    return tune.FIELDS.filter((f) => current[f] !== next[f]).map((field) => ({
      field, label: tune.RANGE[field].label, before: current[field], after: next[field], unit: tune.RANGE[field].unit,
    }));
  }
  function preview(store: GarageStoreLike, team: string, id: string, context?: unknown): PresetPreview | null {
    const row = list(store, team).find((r) => r.id === id);
    if (!row) return null;
    const current = tune.get(team);
    return { id, tune: row.tune, current, context: row.context, at: row.at, contextChanges: contextDiff(row.context, context), changes: diff(current, row.tune),
      setupRevision: store.keyRevision ? store.keyRevision("setup." + team) : null,
      libraryRevision: store.keyRevision ? store.keyRevision(key(team)) : null };
  }
  function apply(store: GarageStoreLike, team: string, pending: PresetPreview | null | undefined): PresetResult {
    if (!pending) return { ok: false, reason: "missing" };
    const row = list(store, team).find((r) => r.id === pending.id);
    if (!row) return { ok: false, reason: "missing" };
    if ((store.keyRevision && (pending.setupRevision !== store.keyRevision("setup." + team)
        || pending.libraryRevision !== store.keyRevision(key(team))))
        || diff(tune.get(team), pending.current).length
        || diff(row.tune, pending.tune).length) return { ok: false, reason: "changed" };
    const result = store.write ? store.write("setup." + team, row.tune) : { ok: true, durable: store.set("setup." + team, row.tune) !== false, reason: null };
    return { ok: result.ok !== false, durable: result.durable !== false, reason: result.reason || null };
  }
  function mount(host: HTMLElement, o: PresetMountOptions): PresetMount {
    const section = document.createElement("section"); section.className = "player-tool-panel"; section.setAttribute("aria-label", "Named mechanical setups");
    const title = document.createElement("h3"); title.className = "adv-sec"; title.textContent = "SAVED SETUPS";
    const name = document.createElement("input"); name.type = "text"; name.maxLength = 32; name.placeholder = "Name this mechanical setup"; name.setAttribute("aria-label", "Setup name");
    const pick = document.createElement("select"); pick.setAttribute("aria-label", "Saved mechanical setup");
    const note = document.createElement("p"); note.className = "adv-help player-tool-note"; note.setAttribute("role", "status");
    const provenance = document.createElement("ul"); provenance.setAttribute("aria-label", "Saved setup context");
    const differences = document.createElement("ul"); differences.setAttribute("aria-label", "Proposed setup changes");
    const row = document.createElement("div"); row.className = "player-tool-row";
    function button(label: string, action: () => void): HTMLButtonElement { const b = document.createElement("button"); b.type = "button"; b.className = "sel-chip"; b.textContent = label; b.onclick = action; row.appendChild(b); return b; }
    const intent = document.createElement("input"); intent.type = "text"; intent.maxLength = 160; intent.setAttribute("aria-label", "Setup context note"); intent.placeholder = "Optional note, e.g. dry braking practice";
    const context = (): object => Object.assign({}, o.context ? o.context() : {}, { note: intent.value || "" });
    let pending: PresetPreview | null = null, deleting: { id: string; revision: string | number | null } | null = null;
    const reasons: Record<string, string> = { full: "Twelve setups saved. Delete one before saving another.", name: "That name is already used. Choose a new name.", invalid: "Enter a name for this setup.", incompatible: "This preset library uses an unsupported or damaged format. Export it before replacing anything.", changed: "The setup changed since the preview. Preview it again.", missing: "That saved setup is no longer available." };
    const feedback = (result: PresetResult, success?: string): void => { note.textContent = !result.ok ? ((result.reason != null ? reasons[result.reason] : undefined) || "Could not save this setup.")
      : result.durable === false ? success + " — SESSION ONLY. Keep this session open and use SAVE RETRY." : (success ?? ""); };
    function disarm(): void { pending = null; deleting = null; differences.replaceChildren(); provenance.replaceChildren(); applyButton.textContent = "PREVIEW APPLY"; deleteButton.textContent = "DELETE SETUP"; }
    function render(id?: string): void {
      const items = list(o.store, o.teamId); pick.replaceChildren();
      const empty = document.createElement("option"); empty.value = ""; empty.textContent = "Choose a saved setup"; pick.appendChild(empty);
      for (const item of items) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.name + (item.trackId ? " · " + item.trackId : ""); pick.appendChild(option); }
      pick.value = id || ""; saveButton.disabled = items.length >= MAX; applyButton.disabled = deleteButton.disabled = !pick.value;
    }
    const saveButton = button("SAVE CURRENT SETUP", () => {
      const result = save(o.store, o.teamId, name.value, tune.get(o.teamId), o.trackId, context());
      feedback(result, "Setup saved"); if (result.ok && result.row) { disarm(); render(result.row.id); }
    });
    const applyButton = button("PREVIEW APPLY", () => {
      deleting = null; deleteButton.textContent = "DELETE SETUP";
      if (!pending) {
        pending = preview(o.store, o.teamId, pick.value, context()); differences.replaceChildren(); provenance.replaceChildren();
        if (!pending) { feedback({ ok: false, reason: "missing" }); return; }
        for (const line of ["Saved " + (pending.at ? new Date(pending.at).toLocaleString() : "date unknown"), ...(pending.context && pending.context.note ? [pending.context.note] : []), ...pending.contextChanges]) { const li = document.createElement("li"); li.textContent = line; provenance.appendChild(li); }
        for (const change of pending.changes) { const li = document.createElement("li"); li.textContent = change.label + ": " + change.before + " → " + change.after + change.unit; differences.appendChild(li); }
        note.textContent = pending.changes.length ? "Only these mechanical values will change. Confirm to apply." : "This setup already matches. Confirming makes no other changes.";
        applyButton.textContent = "CONFIRM APPLY";
        // Put the proposed change in view before offering the second press.
        // Scrolling never moves keyboard focus off the same action button.
        const previewBlock = pending.changes.length ? differences : note;
        if (previewBlock.scrollIntoView) previewBlock.scrollIntoView({ block: "start", behavior: "instant" });
        return;
      }
      const result = apply(o.store, o.teamId, pending); feedback(result, "Mechanical setup applied"); disarm(); if (result.ok && o.refresh) o.refresh();
    });
    const deleteButton = button("DELETE SETUP", () => {
      if (!deleting || deleting.id !== pick.value) { pending = null; applyButton.textContent = "PREVIEW APPLY"; differences.replaceChildren(); deleting = { id: pick.value, revision: o.store.keyRevision ? o.store.keyRevision(key(o.teamId)) : null }; deleteButton.textContent = "CONFIRM DELETE"; note.textContent = "Delete this saved preset? Your fitted mechanical setup stays as it is."; return; }
      const result = remove(o.store, o.teamId, deleting.id, deleting.revision); feedback(result, "Saved setup deleted"); disarm(); render();
    });
    pick.onchange = () => { disarm(); applyButton.disabled = deleteButton.disabled = !pick.value; };
    const help = document.createElement("p"); help.className = "adv-help"; help.textContent = "Up to twelve named mechanical setups per team. Circuit labels are reminders; presets never apply automatically or change parts or paint.";
    section.append(title, help, name, intent, pick, differences, provenance, note, row); host.appendChild(section); render();
    return { section, render };
  }
  return Object.freeze({ PREFIX, MAX, normalize, cleanContext, contextDiff, list, save, remove, diff, preview, apply, mount });
}

export type SetupPresetsApi = ReturnType<typeof createSetupPresets>;

/** The page's SetupPresets, over the page's SetupTune. */
export const SetupPresets: SetupPresetsApi = createSetupPresets();
