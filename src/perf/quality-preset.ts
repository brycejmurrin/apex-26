/**
 * GfxQuality: the GRAPHICS quality PRESETS (LOW / MEDIUM / HIGH / ULTRA) —
 * their tier floor on the PerfGov shedding ladder, the mobile boot tier they
 * persist (a26.gfxHigh), the a26.gfxPreset key and the GRAPHICS control.
 * Ported from f1-game js/perf/quality-preset.js:1-190. The IIFE (which
 * self-inited on DOMContentLoaded and found #pm-gfx by id) became
 * `createGfxQuality(deps)` plus `mount(el, deps)`: the shell hands over the
 * button element and every former global (PerfGov, GameStore, LightStore,
 * GameAudio, GLX.isMobile, location.reload) arrives in `deps`.
 *
 * The RENDERER picker (f1-game js/perf/renderer-picker.js) is NOT ported:
 * apex-26 boots one three.js WebGPURenderer chosen by src/render/policy.ts.
 * See src/perf/README-port.md.
 *
 * WHAT THE SHELL CALLS: `mount(buttonEl, { gov: perfGov, isMobile })` on the
 * settings screen (or `createGfxQuality(deps).init()` without a control);
 * the render lane reads the boot tier `a26.gfxHigh` at renderer init.
 */
import { localRawStore, perfLog, type RawStore } from "./env";
import type { PerfGov } from "./governor";
import type { RowValues, SettingRowApi } from "./setting-row";

// userTier is a FLOOR on the COST shedding ladder in ./governor.ts:
//   0 nothing pinned off · 1 env probe · 2 +lamp shadow/dry SSR · 3 +car shadow/wet SSR
// Look-defining post (bloom / SSAO / god rays / contact / lamp volumetrics)
// reads PerfGov.autoTier() instead — GRAPHICS: LOW must not mute the lighting
// tuner; the governor and crash-sentinel floor can still shed that stack when
// the device proves it cannot afford it.
// ULTRA and HIGH share tier 0 deliberately: both mean "let the governor
// decide". They differ only in the MOBILE boot tier, which is fixed at renderer
// init and cannot be a live knob. A separate AUTO stop would be
// indistinguishable from ULTRA and is omitted rather than shipped as a lie.
export interface GfxPreset {
  readonly id: "low" | "medium" | "high" | "ultra";
  readonly label: string;
  readonly tier: number;
  readonly mobileHigh: boolean;
}
export const PRESETS: readonly GfxPreset[] = Object.freeze([
  { id: "low",    label: "LOW",    tier: 4, mobileHigh: false },
  { id: "medium", label: "MEDIUM", tier: 2, mobileHigh: false },
  { id: "high",   label: "HIGH",   tier: 0, mobileHigh: false },
  { id: "ultra",  label: "ULTRA",  tier: 0, mobileHigh: true  },
]);
const RELOAD_DELAY_MS = 260;
export const GFX_PRESET_KEY = "a26.gfxPreset";
export const GFX_HIGH_KEY = "a26.gfxHigh";

export interface GfxQualityDeps {
  gov?: Pick<PerfGov, "setUserTier" | "sentinelArm"> | null;
  store?: RawStore;
  /** Device class (f1-game GLX.isMobile), NOT the mobile memory tier. */
  isMobile?: boolean;
  /** A race is running (f1-game document.body.dataset.race === "1"). */
  inRace?: () => boolean;
  /** Reload the page (default location.reload()). */
  reload?: () => void;
  /** Re-run the lighting apply (f1-game LightStore.reapply). TODO(lane-render). */
  reapplyLighting?: () => void;
  /** UI click sound (f1-game GameAudio.uiSelect). TODO(lane-audio). */
  uiSelect?: () => void;
  settingRow?: SettingRowApi | null;
}

export interface GfxQuality {
  readonly PRESETS: readonly GfxPreset[];
  init(): void;
  set(id: string, opts?: { noReload?: boolean }): boolean;
  cycle(): boolean;
  current(): GfxPreset["id"];
  label(): string;
  defaultId(isMobile: boolean): GfxPreset["id"];
  /** Mount the GRAPHICS control on `el` (a button, or a row host via deps.settingRow). */
  mountControl(el: HTMLElement | null): void;
}

function presetById(id: string | null | undefined): GfxPreset | null { return PRESETS.find((p) => p.id === id) || null; }

function bodyInRace(): boolean {
  try {
    return typeof document !== "undefined" && !!document.body && document.body.dataset["race"] === "1";
  } catch { return false; }
}

export function createGfxQuality(deps: GfxQualityDeps = {}): GfxQuality {
  const st = deps.store ?? localRawStore();
  let curId: string = "high";
  let isMobile = false;
  let btn: HTMLElement | null = null;
  // The mounted GRAPHICS setting row; a harness without SettingRow keeps the
  // one-button cycle, so the canary's stubs still drive it
  let row: HTMLElement | null = null;

  // PRESETS[2] is HIGH.
  function current(): GfxPreset { return presetById(curId) || (PRESETS[2] as GfxPreset); }

  // The shipped default matches each device's picture without this control:
  // desktop runs the full stack (HIGH); a phone the memory-safe STANDARD tier
  // unless it has opted into a26.gfxHigh (the legacy mobile-only toggle,
  // authoritative as ULTRA). A fresh phone stays MEDIUM: HIGH removes the tier-2
  // floor and enables the env probe plus lamp shadows/SSR before the governor
  // has measured the device
  function defaultId(mobile: boolean): GfxPreset["id"] {
    if (!mobile) return "high";
    const legacy = st.raw(GFX_HIGH_KEY) === "1";
    return legacy ? "ultra" : "medium";
  }

  // The preset's live half: the tier floor is the only part that can change
  // without a reload — context AA, target formats and atlas sizes are decided at
  // renderer init (see syncBootTier)
  function applyLive(): void {
    const p = current();
    if (deps.gov) deps.gov.setUserTier(p.tier);
  }

  // The boot-time half: the mobile memory tier. Returns true only when the bit
  // actually CHANGED — a switch that leaves it alone (LOW <-> MEDIUM, HIGH on
  // desktop) must not cost the player a page load
  function syncBootTier(): boolean {
    if (!isMobile) return false;
    const want = current().mobileHigh;
    const have = st.raw(GFX_HIGH_KEY) === "1";
    if (want === have) return false;
    st.rawSet(GFX_HIGH_KEY, want ? "1" : "0");
    return true;
  }

  function label(): string { return `GRAPHICS: ${current().label}`; }

  // `note` is appended to the CURRENT preset's label (" — RELOADING…" while a
  // tier change reloads; " — FULLY APPLIES AFTER A RELOAD" mid-race)
  function gfxValues(note: string): RowValues {
    return PRESETS.map((p) => [p.id, p.label + (note && p.id === curId ? note : "")] as const);
  }

  function paintGfx(note?: string): void {
    if (row && deps.settingRow) { deps.settingRow.paint(row, curId, gfxValues(note || "")); return; }
    if (btn) btn.textContent = label() + (note || "");
  }

  function uiSelect(): void {
    try { deps.uiSelect?.(); } catch { /* audio not up yet */ }
  }

  function inRace(): boolean {
    try { return (deps.inRace ?? bodyInRace)(); } catch { return false; }
  }

  function reloadSoon(): void {
    try { deps.gov?.sentinelArm(false); } catch { /* no governor in a harness */ }
    setTimeout(() => {
      try { (deps.reload ?? (() => location.reload()))(); } catch { /* file:// / test host */ }
    }, RELOAD_DELAY_MS);
  }

  function set(id: string, opts: { noReload?: boolean } = {}): boolean {
    const p = presetById(id);
    if (!p) return false;
    const prev = presetById(curId);
    curId = p.id;
    perfLog.info("game", `GfxQuality.set ${curId}`);
    st.rawSet(GFX_PRESET_KEY, curId);
    applyLive();
    // The lighting store's conditional shipped layer (the ULTRA-night per-chunk
    // rung) resolves through the CURRENT preset, so a flip must re-run the
    // lighting apply to engage live
    try { deps.reapplyLighting?.(); } catch { /* pre-boot: the first apply() resolves it */ }
    // MSAA is decided once when the render targets are made: ULTRA 4×, anything
    // else 2×/1×. Crossing that boundary on a DESKTOP therefore needs the same
    // reload the mobile boot tier takes
    const needsReload = syncBootTier() || (!isMobile && !!prev && prev.mobileHigh !== p.mobileHigh);
    paintGfx(needsReload ? " — RELOADING…" : "");
    if (needsReload && !opts.noReload) {
      // In a race the preset is already live; the boot-tier half waits for the
      // next natural reload instead of ending the race here
      if (inRace()) { paintGfx(" — FULLY APPLIES AFTER A RELOAD"); return true; }
      reloadSoon();
    }
    return true;
  }

  function cycle(): boolean {
    const i = PRESETS.findIndex((p) => p.id === curId);
    return set((PRESETS[(i + 1) % PRESETS.length] as GfxPreset).id);
  }

  function mountControl(el: HTMLElement | null): void {
    if (!el) return;   // shell without the button: the tier floor still applied
    btn = el;
    const host = el.parentNode;
    const SR = deps.settingRow;
    if (SR && host && !row) {
      const built = SR.build(el.id || "pm-gfx", "GRAPHICS", gfxValues(""));
      built.row.title = el.title || "";
      host.replaceChild(built.row, el);
      row = built.row;
      SR.wire(row, { values: gfxValues(""), read: () => curId, write: (v) => { set(v); uiSelect(); } });
      paintGfx("");
      return;
    }
    el.hidden = false;
    el.textContent = label();
    el.onclick = () => { cycle(); uiSelect(); };
  }

  function init(): void {
    perfLog.info("game", "GfxQuality.init");
    // The device class, NOT the mobile memory tier — the tier is already
    // downstream of a26.gfxHigh, so reading it would make the control's default
    // depend on its own last setting
    isMobile = !!deps.isMobile;
    curId = st.raw(GFX_PRESET_KEY) || defaultId(isMobile);
    if (!presetById(curId)) curId = defaultId(isMobile);
    // RECONCILE THE BOOT TIER WITH THE PRESET. `a26.gfxHigh` is read at BOOT by
    // the renderer, post and the audio engine, and was written ONLY by set() —
    // so any path that lands a gfxPreset without set() (a settings-file import)
    // left the two disagreeing, and a phone whose UI said MEDIUM booted on the
    // DESKTOP tier with nothing ever re-syncing it. Stable, not circular:
    // defaultId reads gfxHigh only for the legacy ULTRA opt-in, and ULTRA is the
    // one preset with mobileHigh true, so it writes back the value it read.
    // Takes effect on the next load, when those boot reads happen
    syncBootTier();
    applyLive();
  }

  return {
    PRESETS, init, set, cycle, label, defaultId, mountControl,
    current: () => current().id,
  };
}

/** Create, init and mount the GRAPHICS control on `el` (f1-game init() + mountControl()). */
export function mount(el: HTMLElement | null, deps: GfxQualityDeps = {}): GfxQuality {
  const q = createGfxQuality(deps);
  q.init();
  q.mountControl(el);
  return q;
}
