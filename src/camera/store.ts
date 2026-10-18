/**
 * The settings store the camera modules read and write: the subset of f1-game's
 * `GameStore.store` (js/core/store.js) they touch.
 *
 * - JSON lane `get(k, d)` / `set(k, v)` (store.js:51-107): CamTune's override
 *   packs (js/camera/offsets.js:154-158, :163-169), CamFeel's flags
 *   (js/camera/feel.js:44-60), CamComfort's FX notches (cam-comfort.js:73-85).
 * - Raw string lane `raw` / `rawSet` / `rawDel` (store.js:206-235): CockpitOpts
 *   (cockpit-opts.js:85-140) and CamComfort's preference (cam-comfort.js:50-58).
 * - `rev` / `rawRev` (store.js:34): CamComfort.active memoises on them.
 *
 * Keys are spelled with or without the prefix, as in f1-game (store.js:297-298
 * `shortKey`/`fullKey`); the store keeps them under `a26.` (AGENTS.md: f1-game
 * owns `apex26.` on the same origin).
 *
 * TODO(lane-shell): there is no shared app store on main yet (the garage's
 * src/garage/store.ts is on lane-data/garage). `createLocalCamStore` is the
 * fallback; any store satisfying `CamStore` can be injected instead.
 */
import { SettingsDefaults } from "../data/settings-defaults";

export const PREFIX = "a26.";

export interface CamStore {
  get(k: string, d: unknown): unknown;
  set(k: string, v: unknown): boolean | void;
  raw(k: string): string | null;
  rawSet(k: string, v: unknown): boolean | void;
  rawDel?(k: string): boolean | void;
  readonly rev?: number;
  readonly rawRev?: number;
}

/** The parts of `Storage` used here. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function shortKey(k: string): string { return k.indexOf(PREFIX) === 0 ? k.slice(PREFIX.length) : k; }
function fullKey(k: string): string { return PREFIX + shortKey(k); }

/**
 * A store over `storage` (default: the page's localStorage, guarded). A failed
 * write is kept for the session, as store.js does (:119-167, :218-227).
 * Misses fall back to SettingsDefaults (store.js:44-50 `_def`, :206-217).
 */
export function createLocalCamStore(storage?: StorageLike | null): CamStore & { rev: number; rawRev: number; rawDel(k: string): boolean } {
  const st = (): StorageLike | null => {
    if (storage !== undefined) return storage;
    try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
  };
  const mem = new Map<string, string | null>();
  const read = (key: string): string | null => {
    if (mem.has(key)) return mem.get(key) ?? null;
    try { return st()?.getItem(key) ?? null; } catch { return null; }
  };
  const write = (key: string, v: string | null): boolean => {
    try {
      const s = st();
      if (!s) throw new Error("storage unavailable");
      if (v === null) s.removeItem(key); else s.setItem(key, v);
      mem.delete(key);
      return true;
    } catch { mem.set(key, v); return false; }
  };
  const def = (k: string): unknown => (SettingsDefaults.has(shortKey(k)) ? SettingsDefaults.get(shortKey(k)) : undefined);
  const store = {
    rev: 0,
    rawRev: 0,
    get(k: string, d: unknown): unknown {
      const raw = read(fullKey(k));
      if (raw !== null) {
        try {
          const v: unknown = JSON.parse(raw);
          if (!(typeof v === "number" && !Number.isFinite(v))) return v;
        } catch { /* corrupt: served as a miss (store.js:51-85) */ }
      }
      const dv = def(k);
      return dv !== undefined ? dv : d;
    },
    set(k: string, v: unknown): boolean {
      store.rev++;
      return write(fullKey(k), v === undefined ? null : JSON.stringify(v));
    },
    raw(k: string): string | null {
      const v = read(fullKey(k));
      if (v !== null) return v;
      const dv = def(k);
      return dv === undefined ? null : String(dv);
    },
    rawSet(k: string, v: unknown): boolean {
      store.rawRev++;
      return write(fullKey(k), String(v));
    },
    rawDel(k: string): boolean {
      store.rawRev++;
      return write(fullKey(k), null);
    },
  };
  return store;
}
