// Guarded Web Storage access for the XR modules: every read and write survives a
// blocked or missing storage (private mode, sandboxed iframes, Node). The try/catch
// helpers of f1-game js/xr/apex-xr.js:26-37 and js/xr/xr-opts.js:30-40, with the
// storage passed in rather than read from globals.
//
// Keys are `a26.`-prefixed (AGENTS.md §Code rules); f1-game owns `apex26.` on the
// same origin, so its VR prefs are never read or written here.

/** The parts of `Storage` used here. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** A storage getter: called on every access so a late-blocked storage is caught. */
export type StorageSource = () => StorageLike | null | undefined;

export const KEY_XR = "a26.xr";
export const KEY_XR_BACKEND = "a26.xrBackend";
export const KEY_XR_INPUT = "a26.xrInput";
export const KEY_XR_CAPS = "a26.xrCaps";
/** sessionStorage: "webgl2" after a failed WebGPU XR attempt (apex-xr.js:11). */
export const SS_XR_FALLBACK = "a26.xrFallback";
/** "1" while a backend-switch reload should auto-enter VR (xr-boot.js:10). */
export const KEY_XR_PENDING = "a26.xrEnterPending";
/** The `?gl=` value the ENTER VR reload replaced (xr-boot.js:13, see ./boot.ts). */
export const KEY_XR_PREV_PIN = "a26.xrPrevPin";

export function localStore(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function sessionStore(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function sGet(src: StorageSource, key: string): string | null {
  try {
    const s = src();
    return s ? s.getItem(key) : null;
  } catch {
    return null;
  }
}

export function sSet(src: StorageSource, key: string, value: string): boolean {
  try {
    const s = src();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function sRemove(src: StorageSource, key: string): boolean {
  try {
    const s = src();
    if (!s || !s.removeItem) return false;
    s.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
