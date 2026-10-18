/* Apex 26 — AUTO COMFORT camera preset. On first boot, when a touch screen
 * is detected and the player has never chosen a comfort
 * preference, turn comfort ON (shake / kerb shiver / onboard buzz off via the
 * existing camComfort() path). A stored choice always wins.
 *
 * Ported verbatim from f1-game js/camera/cam-comfort.js:1-132 (CamComfort).
 * f1-game falls back to the global `GameStore.store` when no store is passed;
 * here the store is always passed (src/camera/store.ts `CamStore`), and a
 * missing one reads as "no store", the same as f1-game without GameStore.
 * `applyFx(G, store)` takes `{ gfx }` for G: TODO(lane-render) bind
 * `setComfortFx(opts)` on the renderer when its FX path exists.
 */
import { log } from "../data/log";
import type { TuneDef } from "./offsets";
import type { CamStore } from "./store";

// Bare string on the raw lane (same pattern as CockpitOpts flags).
export const KEY = "camComfortPref";   // "on" | "off" | unset
export const FX_DEFS: readonly TuneDef[] = Object.freeze([
  Object.freeze({ id: "motionBlur", label: "MOTION BLUR", min: 1, max: 10, step: 1, def: 5, unit: "",
    help: "Motion-blur amount. Notch 1 is OFF. Stored now; renderers may bind the optional comfort-FX hook later." }),
  Object.freeze({ id: "speedLines", label: "SPEED LINES", min: 1, max: 10, step: 1, def: 5, unit: "",
    help: "Speed-line amount. Notch 1 is OFF. Stored now; renderers may bind the optional comfort-FX hook later." }),
]);
const FX_BY_ID = new Map<string, TuneDef>();
for (const d of FX_DEFS) FX_BY_ID.set(d.id, d);

type MaybeStore = CamStore | null | undefined;
/** The navigator / window members the touch and XR probes read. */
export interface NavLike { readonly maxTouchPoints?: number; readonly xr?: unknown }
export interface WinLike { matchMedia?(q: string): { readonly matches: boolean } }
/** The renderer hook: `G.gfx.setComfortFx(opts)` (cam-comfort.js:96-100). */
export interface ComfortFxSink { setComfortFx?(opts: Record<string, number>): void }

const defNav = (): NavLike | null => (typeof navigator !== "undefined" ? navigator : null);
const defWin = (): object | null => (typeof window !== "undefined" ? window : null);

export function detectTouch(nav?: NavLike | null, win?: object | null): boolean {
  const n = nav || defNav();
  const w = win || defWin();
  if (!n) return false;
  if (((n.maxTouchPoints ?? 0) | 0) > 0) return true;
  return !!(w && "ontouchstart" in w);
}

export function detectXr(nav?: NavLike | null): boolean {
  const n = nav || defNav();
  return !!(n && n.xr);
}

/** True when comfort should silence shake / buzz (after boot / user choice).
 *  An explicit SETTINGS › ACCESSIBILITY › REDUCE MOTION: OFF (a26.motion
 *  = "off") is the player asking for full motion, and wins over the touch
 *  auto-pick. Legacy MOTION: ON stored as "on" is treated as AUTO (not OFF). */
// render() asks every frame and raw() is a localStorage read, so the answer is
// memoised on the store's revisions: `rev` (set(), a foreign tab's write, a
// mirror restore) and `rawRev` (rawSet / rawDel — boot(), set(), a settings
// import). A hand edit of localStorage in devtools is the one writer that
// bumps neither; it is seen on the next store write or reload.
let _mS: CamStore | null = null, _mRev = -1, _mRaw = -1, _mVal = false;
export function active(s: MaybeStore): boolean {
  if (!s || typeof s.raw !== "function") return false;
  const memo = typeof s.rev === "number" && typeof s.rawRev === "number";
  if (memo && s === _mS && s.rev === _mRev && s.rawRev === _mRaw) return _mVal;
  const v = !(typeof s.get === "function" && s.get("motion", null) === "off") && s.raw(KEY) === "on";
  if (memo) { _mS = s; _mRev = s.rev ?? -1; _mRaw = s.rawRev ?? -1; _mVal = v; }
  return v;
}

export function choice(s: MaybeStore): string | null {
  if (!s || typeof s.raw !== "function") return null;
  return s.raw(KEY);
}

export function reducedMotion(win?: WinLike | null): boolean {
  const w = win || (defWin() as WinLike | null);
  try { return !!(w && w.matchMedia && w.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  catch { return false; }
}

export function fxGet(s: MaybeStore, id: string): number {
  const d = FX_BY_ID.get(id);
  if (!d || !s || typeof s.get !== "function") return d ? d.def : 1;
  const v = s.get(id, d.def);
  return typeof v === "number" && isFinite(v) ? Math.max(d.min, Math.min(d.max, Math.round(v))) : d.def;
}

export function fxSet(s: MaybeStore, id: string, value: unknown): boolean {
  const d = FX_BY_ID.get(id);
  if (!d || !s || typeof s.set !== "function" || typeof value !== "number" || !isFinite(value)) return false;
  return s.set(id, Math.max(d.min, Math.min(d.max, Math.round(value)))) !== false;
}

export function fxValues(s: MaybeStore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of FX_DEFS) out[d.id] = fxGet(s, d.id);
  return out;
}

/**
 * Renderer integration boundary. Backends intentionally have no FX path yet:
 * they may add setComfortFx(opts) later without changing storage or Settings
 * export. Returning opts keeps the hook observable in unit/dev harnesses.
 */
export function applyFx(G: { readonly gfx?: ComfortFxSink | null; readonly store?: CamStore | null } | null | undefined, store?: MaybeStore): Record<string, number> {
  const opts = fxValues(store || (G && G.store));
  if (G && G.gfx && typeof G.gfx.setComfortFx === "function") G.gfx.setComfortFx(opts);
  return opts;
}

/**
 * First-run auto pick. No-op when the key is already set (player chose, or a
 * previous auto write). Returns the applied value, or null when untouched.
 */
export function boot(s: MaybeStore, nav?: NavLike | null, win?: (WinLike & object) | null): "on" | null {
  if (!s || typeof s.raw !== "function") return null;
  if (reducedMotion(win) && typeof s.get === "function" && typeof s.set === "function") {
    for (const d of FX_DEFS) if (s.get(d.id, null) == null) s.set(d.id, d.min);
  }
  const touch = detectTouch(nav, win);
  // navigator.xr exists in desktop Chrome/Edge with no headset, so the old
  // touch-OR-XR pick silenced shake for every desktop Chromium player, for
  // good (nothing in the UI writes this key). A headset session is already
  // comfort via XrBoot.camComfort; drop that auto value off non-touch boots.
  if (s.raw(KEY) === "on" && !touch && typeof s.rawDel === "function") { s.rawDel(KEY); return null; }
  if (s.raw(KEY) != null) return null;          // already chose / already auto'd
  if (touch) {
    if (typeof s.rawSet === "function") s.rawSet(KEY, "on");
    log.info("CamComfort.boot auto on (touch)");
    return "on";
  }
  return null;
}

export function set(s: MaybeStore, on: unknown): boolean {
  if (!s || typeof s.rawSet !== "function") return false;
  s.rawSet(KEY, on ? "on" : "off");
  return true;
}

export const CamComfort = Object.freeze({
  KEY, FX_DEFS, detectTouch, detectXr, reducedMotion, active, choice, boot, set,
  fxGet, fxSet, fxValues, applyFx,
});
