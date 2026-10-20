/* Apex 26 — CockpitOpts: player-facing options for the first-person view. WHEEL, SEAT, INTERIOR and HALO dress the cockpit view (all inside the same F1 car); TURN CHASING is how far the cockpit aim leaves the nose for a point 30 m down the road (0..1). Its own file, like GameMetrics, so the SETTINGS controls inject without growing index.html.
 *
 * Ported verbatim from f1-game js/camera/cockpit-opts.js:1-306 (CockpitOpts).
 * The IIFE singleton becomes `createCockpitOpts(deps)`:
 *   GameStore.store (raw lane) → deps.store            cockpit-opts.js:85-140
 *   location.search            → deps.search           cockpit-opts.js:64-70, :96-99, :116-119
 * and `initUI` (cockpit-opts.js:206-298) becomes `mountCockpitOpts(el, deps)`.
 * Keys keep f1-game's raw-lane names with `a26.` for `apex26.` (AGENTS.md).
 * Deviation: `onWheel` returns an unsubscribe, so a mounted panel can unmount.
 */
import { log } from "../data/log";
import { buildSettingRow, paintSettingRow, wireSettingRow } from "./setting-row";
import type { CamStore } from "./store";
import "../styles";   // fixes the @layer order before camera.css joins `components`
import "./camera.css";

export const KEY = "a26.cockpitHalo";
export const KEY_TC = "a26.cockpitTurnChase";         // legacy "1" / "0"
export const KEY_LEAD = "a26.cockpitTurnChaseLead";   // 0..1, the live value
// The shipped amount and the legacy ON amount differ: a stored
// "1" from the old switch keeps the 0.35 it meant, an untouched install gets 0.4.
export const LEAD_DEFAULT = 0.4;
const LEGACY_ON_LEAD = 0.35;
const LEAD_MAX = 1;

export type ChoiceName = "wheel" | "body" | "seat" | "interior";
export interface Choice { readonly key: string; readonly url: string; readonly values: readonly string[]; readonly labels: Readonly<Record<string, string>> }

// COCKPIT CHOICES: wheel, seat, interior and halo options, all inside the same
// F1 car; each stored raw under its own a26.* key and read once (URL overrides
// for shots: ?ckwheel= ?ckseat= ?ckint= ?halo=).
//   WHEEL     the steering wheel (car-mesh.js getCockpitWheel). A wheel with no
//             screen cannot carry gear and speed, so the HUD shows them instead
//             (mode-switch.js keeps body.cockpit-cam off for it).
//   SEAT      where the driver sits: eye offsets from STANDARD, car-local metres
//             (fwd, up). The wheel mount moves with the seat, so the rim keeps its
//             distance from the eye (the cockpit near plane is 0.30 m).
//   INTERIOR  the trim car-mesh.js builds inside the tub (getCockpitCabin).
//   HALO      OFF / SLIM / STANDARD / THICK / FAIRED: the hoop's tube (car3d.js, halo size).
export const CHOICES: Readonly<Record<ChoiceName, Choice>> = Object.freeze({
  wheel:    { key: "a26.cockpitWheel", url: "ckwheel", values: ["f1", "gt", "butterfly", "yoke", "endurance", "retro", "round", "none"],
              labels: { f1: "F1 2026", gt: "GT RIM", butterfly: "BUTTERFLY", yoke: "OPEN YOKE", endurance: "ENDURANCE", retro: "2000s", round: "CLASSIC", none: "NONE" } },
  body:     { key: "a26.cockpitBody", url: "ckbody", values: ["standard", "sculpted", "wide", "tapered", "stepped"],
              labels: { standard: "STANDARD", sculpted: "SCULPTED", wide: "WIDE", tapered: "TAPERED", stepped: "STEPPED" } },
  seat:     { key: "a26.cockpitSeat", url: "ckseat", values: ["std", "low", "high", "fwd"],
              labels: { std: "STANDARD", low: "LOW", high: "HIGH", fwd: "FORWARD" } },
  interior: { key: "a26.cockpitInterior", url: "ckint", values: ["carbon", "team", "suede", "ribbed", "classic"],
              labels: { carbon: "CARBON", team: "TEAM", suede: "SUEDE", ribbed: "RIBBED", classic: "CLASSIC" } },
});
export const KEY_WHEEL = CHOICES.wheel.key, WHEELS = CHOICES.wheel.values;
const SCREEN_WHEELS: Readonly<Record<string, true>> = { f1: true, gt: true, butterfly: true, yoke: true, endurance: true, retro: true };
// STANDARD's eye is vantage.js COCKPIT_EYE_FWD / COCKPIT_EYE_UP; a seat moves it.
const EYE_F = -0.20, EYE_U = 0.82;
const SEATS: Readonly<Record<string, readonly [number, number]>> = { std: [0, 0], low: [0, -0.06], high: [0, 0.08], fwd: [0.12, -0.02] };
// The wheel mount at STANDARD: hub (y, z) and scale, car-local, per wheel.
const MOUNTS: Readonly<Record<string, readonly [number, number, number]>> = { f1: [0.70, 0.26, 0.80], gt: [0.70, 0.26, 0.80], butterfly: [0.70, 0.26, 0.80], yoke: [0.70, 0.26, 0.80], endurance: [0.70, 0.26, 0.80], retro: [0.70, 0.26, 0.80], round: [0.73, 0.28, 0.92], none: [0.70, 0.26, 0.80] };
// Halo, stored "0" / "slim" / "1" / "thick" ("1" and "0" are the old ON/OFF switch).
export const HALO_VALUES: readonly string[] = Object.freeze(["0", "slim", "1", "thick", "fairing"]);
export const HALO_LABELS: Readonly<Record<string, string>> = { "0": "OFF", slim: "SLIM", "1": "STANDARD", thick: "THICK", fairing: "FAIRED" };

/** The eye and the wheel mount, car-local metres (cockpit-opts.js:166-176). */
export interface CockpitLayout { readonly eyeF: number; readonly eyeU: number; readonly wheelY: number; readonly wheelZ: number; readonly wheelS: number }

// Presets apply only when explicitly selected; custom combinations remain saved.
export const PRESETS: Readonly<Record<string, Readonly<Record<ChoiceName | "halo", string>>>> = {
  modern: { body:"sculpted",interior:"carbon",wheel:"f1",seat:"std",halo:"fairing" },
  historic: { body:"tapered",interior:"classic",wheel:"round",seat:"std",halo:"0" },
};

const own = <T>(o: Readonly<Record<string, T>>, k: string | null | undefined): T | undefined =>
  k != null && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

function clampLead(raw: unknown): number {
  let n = +(raw as number);
  if (!isFinite(n)) return LEAD_DEFAULT;
  if (n > LEAD_MAX) n = n / 100;
  return Math.max(0, Math.min(LEAD_MAX, n));
}

export function parseLead(raw: string | null | undefined, urlVal: string | null | undefined): number | null {
  if (urlVal != null && urlVal !== "") {
    if (/^(on|true)$/i.test(urlVal)) return LEGACY_ON_LEAD;
    if (/^(off|false)$/i.test(urlVal)) return 0;
    // Bare "1" on the URL is the old ON flag, not 100 %. Use 100 or 0.8 for an amount.
    if (urlVal === "1") return LEGACY_ON_LEAD;
    if (urlVal === "0") return 0;
    return clampLead(urlVal);
  }
  if (raw == null || raw === "") return null;
  return clampLead(raw);
}

export type CockpitListener = (name: ChoiceName | "halo", value: string) => void;

export interface CockpitOptsDeps {
  /** Raw string lane (`raw` / `rawSet`). */
  readonly store: Pick<CamStore, "raw" | "rawSet">;
  /** `location.search` for the URL overrides; default the page's, or "" without one. */
  readonly search?: () => string;
}

export type CockpitOpts = ReturnType<typeof createCockpitOpts>;

export function createCockpitOpts(deps: CockpitOptsDeps) {
  const store = deps.store;
  const search = deps.search ?? ((): string => (typeof location !== "undefined" ? location.search : ""));

  let haloVal: string | null = null;
  let lead: number | null = null;
  const picked: Partial<Record<ChoiceName, string>> = {};
  const listeners: CockpitListener[] = [];

  function urlTurnChase(): string | null {
    try {
      const q = /[?&]turnchase=([^&]*)/i.exec(search());
      return q ? decodeURIComponent(q[1] ?? "") : null;
    } catch { return null; /* no location, or a malformed escape */ }
  }

  function readLead(): number {
    const fromUrl = parseLead(null, urlTurnChase());
    if (fromUrl != null) return fromUrl;
    const stored = parseLead(store.raw(KEY_LEAD), null);
    if (stored != null) return stored;
    const legacy = store.raw(KEY_TC);
    if (legacy === "0") return 0;
    if (legacy === "1") return LEGACY_ON_LEAD;
    return LEAD_DEFAULT;
  }

  function haloSetting(): string {
    if (haloVal === null) {
      let v = store.raw(KEY);
      try {
        const q = /[?&]halo=([a-z0-9]+)/i.exec(search());
        const h = q && q[1];
        if (h) v = /^(1|on|true)$/i.test(h) ? "1" : /^(0|off|false)$/i.test(h) ? "0" : h.toLowerCase();
      } catch { /* no location in a headless VM: the stored value stands */ }
      haloVal = v !== null && HALO_VALUES.includes(v) ? v : "1";
    }
    return haloVal;
  }

  // 0 OFF, 1 SLIM, 2 STANDARD, 3 THICK, 4 FAIRED.
  function haloSize(): number { return HALO_VALUES.indexOf(haloSetting()); }

  function halo(): boolean { return haloSize() > 0; }

  // A boolean (the old switch) or a stored value.
  function setHalo(v: unknown): boolean {
    haloVal = v === true ? "1" : v === false ? "0" : typeof v === "string" && HALO_VALUES.includes(v) ? v : "1";
    store.rawSet(KEY, haloVal);
    for (const fn of listeners) fn("halo", haloVal);
    return halo();
  }

  function choice(name: ChoiceName): string {
    let p = picked[name];
    if (p === undefined) {
      const C = CHOICES[name];
      let v = store.raw(C.key);
      try {
        const q = new RegExp("[?&]" + C.url + "=([a-z0-9]+)", "i").exec(search());
        if (q && q[1]) v = q[1].toLowerCase();
      } catch { /* no location in a headless VM: the stored value stands */ }
      p = picked[name] = v !== null && C.values.includes(v) ? v : (C.values[0] ?? "");
    }
    return p;
  }

  function setChoice(name: ChoiceName, v: unknown): string {
    const C = CHOICES[name];
    const p = picked[name] = typeof v === "string" && C.values.includes(v) ? v : (C.values[0] ?? "");
    store.rawSet(C.key, p);
    for (const fn of listeners) fn(name, p);
    return p;
  }

  function wheel(): string { return choice("wheel"); }
  function setWheel(v: unknown): string { return setChoice("wheel", v); }
  function body(): string { return choice("body"); }
  function setBody(v: unknown): string { return setChoice("body", v); }
  function seat(): string { return choice("seat"); }
  function setSeat(v: unknown): string { return setChoice("seat", v); }
  function interior(): string { return choice("interior"); }
  function setInterior(v: unknown): string { return setChoice("interior", v); }

  // Does this wheel (default: the chosen one) carry the gear/speed LCD?
  function wheelHasScreen(style?: string | null): boolean { return !!own(SCREEN_WHEELS, style || wheel()); }

  // The eye and the wheel mount for a wheel and a seat (default: the chosen ones).
  // Frozen and cached per pair: vantage() and the rig draw read it every frame.
  const _layouts: Record<string, Record<string, CockpitLayout>> = {};   // wheel -> seat -> layout: two lookups, no key string per frame
  function layout(w?: string | null, s?: string | null): CockpitLayout {
    const wk = own(MOUNTS, w) ? (w as string) : wheel(), sk = own(SEATS, s) ? (s as string) : seat();
    const byW = _layouts[wk] || (_layouts[wk] = {});
    let L = byW[sk];
    if (!L) {
      const st = own(SEATS, sk) ?? [0, 0], m = own(MOUNTS, wk) ?? [0.70, 0.26, 0.80];
      L = byW[sk] = Object.freeze({ eyeF: EYE_F + st[0], eyeU: EYE_U + st[1], wheelY: m[0] + st[1], wheelZ: m[1] + st[0], wheelS: m[2] });
    }
    return L;
  }

  // A cockpit-view consumer that must follow a change made mid-race.
  function onWheel(fn: CockpitListener): () => void {
    listeners.push(fn);
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  function turnChaseLead(): number {
    if (lead === null) lead = readLead();
    return lead;
  }

  function setTurnChaseLead(v: unknown): number {
    lead = clampLead(v);
    store.rawSet(KEY_LEAD, String(Math.round(lead * 100) / 100));
    return lead;
  }

  function turnChase(): boolean { return turnChaseLead() > 0; }

  function setTurnChase(on: unknown): number {
    return setTurnChaseLead(on ? LEAD_DEFAULT : 0);
  }

  function preset(): string {
    for(const [id,p] of Object.entries(PRESETS)) if(Object.entries(p).every(([k,v])=>k==='halo'?haloSetting()===v:choice(k as ChoiceName)===v))return id;
    return "custom";
  }
  function setPreset(id: string): string {
    const p=own(PRESETS, id);if(!p)return preset();
    for(const [k,v] of Object.entries(p))if(k==='halo')setHalo(v);else setChoice(k as ChoiceName,v);
    return preset();
  }

  return Object.freeze({
    KEY, KEY_TC, KEY_LEAD, KEY_WHEEL, LEAD_DEFAULT, WHEELS, CHOICES, HALO_VALUES,
    PRESETS, preset, setPreset, halo, haloSize, haloSetting, setHalo, wheel, setWheel, body, setBody, seat, setSeat, interior, setInterior,
    wheelHasScreen, onWheel, layout, turnChase, setTurnChase, turnChaseLead, setTurnChaseLead, parseLead,
  });
}

/** What the mounted SETTINGS › COCKPIT fold needs besides the options. */
export interface CockpitOptsUiDeps {
  readonly opts: CockpitOpts;
  /** CockpitPreview.mount(content) (cockpit-opts.js:297); omit for no preview. */
  readonly preview?: ((content: HTMLElement) => { unmount(): void } | null) | null;
  /** GameAudio.uiSelect (cockpit-opts.js:247). TODO(lane-audio). */
  readonly uiSelect?: (() => void) | null;
}

function paintLead(opts: CockpitOpts, inp: HTMLInputElement | null, out: HTMLElement | null): void {
  const pct = Math.round(opts.turnChaseLead() * 100);
  if (inp) inp.value = String(pct);
  if (out) out.textContent = `${pct}%`;
}

/**
 * SETTINGS › DISPLAY › COCKPIT (cockpit-opts.js:206-298 `initUI`). f1-game
 * finds its host by id (#pm-panel-display); here the caller hands `host`. The
 * fold goes before #pm-visual-tuners when that is a child of `host`.
 */
export function mountCockpitOpts(host: HTMLElement, deps: CockpitOptsUiDeps): { unmount(): void } {
  log.info("CockpitOpts.initUI");
  const { opts } = deps;
  const doc = host.ownerDocument;
  if (doc.getElementById("pm-halo")) return { unmount() { /* already mounted */ } };
  const offs: (() => void)[] = [];

  // A FOLD like METRICS / RENDERER / ADVANCED VISUALS beside it: five rows of
  // cockpit dressing are a page of their own, and a player who never drives
  // from the cockpit should not have to scroll past them. The closed summary
  // carries the wheel, so the fold reads without opening.
  const fold = doc.createElement("details");
  fold.id = "pm-cockpit";
  fold.className = "pm-renderer-sub";
  const sum = doc.createElement("summary");
  sum.className = "adv-more-btn";
  sum.id = "pm-cockpit-sum";
  const paintSum = (): void => { sum.textContent = "COCKPIT · " + (CHOICES.wheel.labels[opts.wheel()] || opts.wheel()); };
  paintSum();
  offs.push(opts.onWheel(paintSum));
  const content = doc.createElement("div");
  content.id = "pm-cockpit-body";
  content.setAttribute("role", "group");
  content.setAttribute("aria-label", "Cockpit");
  fold.appendChild(sum);
  fold.appendChild(content);
  // Just above ADVANCED VISUALS, the one fold here that is static shell DOM —
  // RENDERER is rebuilt at runtime (js/perf/renderer-picker.js), so "after
  // RENDERER" landed wherever the two inits happened to finish.
  const tools = doc.getElementById("pm-visual-tuners");
  if (tools && tools.parentNode === host) host.insertBefore(fold, tools);
  else host.appendChild(fold);
  const place = (el: HTMLElement): void => { content.appendChild(el); };
  // The row titles are hover-only, which a phone never shows: each row also
  // gets the same sentence as a visible help line under it.
  const help = (text: string): void => {
    const p = doc.createElement("p");
    p.className = "adv-help";
    p.textContent = text;
    place(p);
  };

  function row(id: string, label: string, values: readonly string[], lbls: Readonly<Record<string, string>>, title: string, read: () => string, write: (v: string) => unknown): void {
    const r = buildSettingRow(doc, id, label, values.map((v) => [v, lbls[v] ?? v] as const));
    r.row.title = title;
    wireSettingRow(r.row, { read, write: (v) => {
      write(v);
      try { if (deps.uiSelect) deps.uiSelect(); }
      catch { /* audio is optional here */ }
    } });
    place(r.row);
    offs.push(opts.onWheel(() => paintSettingRow(r.row, read())));
    help(title);   // the visible help line under the row (a phone never shows a title)
  }
  row("pm-ckpreset", "PRESET", ["custom","modern","historic"], {custom:"CUSTOM",modern:"MODERN F1",historic:"HISTORIC"},
    "Apply a coordinated cockpit, or mix individual options below. HISTORIC uses leather, gauges, a round wheel and no halo.", opts.preset, opts.setPreset);
  const C = CHOICES;
  row("pm-ckwheel", "WHEEL", C.wheel.values, C.wheel.labels,
    "The steering wheel. CLASSIC and NONE have no screen, so the HUD shows gear and speed.", opts.wheel, opts.setWheel);
  row("pm-ckbody", "BODY", C.body.values, C.body.labels,
    "Cockpit body shape: standard, sculpted, wide, tapered or stepped shoulders.", opts.body, opts.setBody);
  row("pm-ckseat", "SEAT", C.seat.values, C.seat.labels,
    "Where you sit in the car. The wheel moves with the seat.", opts.seat, opts.setSeat);
  row("pm-halo", "HALO", HALO_VALUES, HALO_LABELS,
    "The halo over the cockpit. FAIRED adds a broad carbon roof and curved centre junction.", opts.haloSetting, opts.setHalo);
  row("pm-ckint", "INTERIOR", C.interior.values, C.interior.labels,
    "The cockpit trim: carbon, team padding, suede, ribbed pads, or a 1960s cockpit with an aeroscreen and round gauges.", opts.interior, opts.setInterior);

  const lab = doc.createElement("label");
  lab.className = "tune-row";
  lab.title = "How far the cockpit view glances into the corner ahead. 0% stays locked to the car's nose; 100% aims 30 m down the road.";
  const span = doc.createElement("span");
  span.className = "tune-label";
  span.appendChild(doc.createTextNode("TURN CHASING "));
  const out = doc.createElement("b");
  out.id = "pm-turnchase-v";
  span.appendChild(out);
  const inp = doc.createElement("input");
  inp.type = "range";
  inp.min = "0";
  inp.max = "100";
  inp.step = "5";
  inp.id = "pm-turnchase";
  inp.setAttribute("aria-label", "Turn chasing");
  inp.oninput = () => {
    opts.setTurnChaseLead(parseFloat(inp.value) / 100);
    paintLead(opts, inp, out);
  };
  lab.appendChild(span);
  lab.appendChild(inp);
  place(lab);
  help(lab.title);
  paintLead(opts, inp, out);
  const pv = deps.preview ? deps.preview(content) : null;
  return {
    unmount() {
      if (pv) pv.unmount();
      for (const off of offs) off();
      fold.remove();
    },
  };
}
