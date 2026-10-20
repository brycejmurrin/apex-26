/**
 * The garage's persistence: the subset of f1-game's `GameStore.store`
 * (js/core/store.js:29-235) that js/garage/ reads and writes, over an
 * injectable Web Storage.
 *
 * Ported from f1-game js/core/store.js:
 *   parseStored :10-16, cloneDef :27, _def :44-50, get :51-85,
 *   getStored :89-93, set :105-107, write :119-167, keyRevision :193-195,
 *   raw :206-217, rawSet :218-227, rawDel :228-235, shortKey/fullKey :297-298.
 *
 * Keys are given unprefixed (`setup.mercedes`); the store keeps them under
 * `a26.` (AGENTS.md §Code rules: f1-game owns `apex26.` on the same origin).
 *
 * Kept: the parsed-value cache (a garage screen reads the same key many times a
 * frame), `undefined` REMOVES the key, a miss falls back to SettingsDefaults
 * then GarageDefaults (deep-copied) before the call-site default, a corrupt or
 * non-finite stored value is dropped and served as a miss, a failed disk write
 * is still cached (ok:true, durable:false), and per-key revisions.
 * Not ported (shell-lane concerns): the IndexedDB career mirror, quota recovery
 * of disposable caches (setRoomy), foreign-tab `storage` events, listeners,
 * SaveSchemaRegistry notes, retryFailed/failedKeys and the Log lines.
 *
 * TODO(lane-shell): a shared app-wide store may replace this shim; it then only
 * needs to satisfy `GarageStoreLike` below.
 */
import { GarageDefaults } from "../data/garage-defaults";
import { SettingsDefaults } from "../data/settings-defaults";

export const PREFIX = "a26.";

/** The parts of `Storage` used here. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** store.write's verdict (store.js:108-114): `ok` = usable this session, `durable` = survives a reload. */
export interface WriteResult {
  ok: boolean;
  durable: boolean;
  reason: string | null;
}

/**
 * What the garage modules need from a store. f1-game duck-types this
 * (setup-presets.js:217 `store.write ? … : store.set(…)`, :231
 * `store.keyRevision && …`), so the optional members stay optional and a test
 * double may omit them.
 */
export interface GarageStoreLike {
  get(k: string, d: unknown): unknown;
  set(k: string, v: unknown): boolean | void;
  write?(k: string, v: unknown): { ok?: boolean; durable?: boolean; reason?: string | null };
  keyRevision?(k: string): string | number;
}

export interface GarageStore extends GarageStoreLike {
  get(k: string, d: unknown): unknown;
  getStored(k: string): unknown;
  set(k: string, v: unknown): boolean;
  write(k: string, v: unknown): WriteResult;
  keyRevision(k: string): string;
  raw(k: string): string | null;
  rawSet(k: string, v: unknown): boolean;
  rawDel(k: string): boolean;
  /** The error name of the first failed storage access, or null (store.js:36 `broken`). */
  readonly broken: string | null;
  /** Bumped on every write (store.js:34): memo caches key off it. */
  readonly rev: number;
}

// JSON.parse turns an oversized numeric literal ("8"×N, "1e309") into
// Infinity without throwing. That is player-shaped disk data — a hand edit
// or a truncated write — and returning it into Career money / season points
// is the same class of bug as treating a stored string as a promise. Refuse
// non-finite top-level numbers the same way a SyntaxError is refused.
function parseStored(raw: string, label: string): unknown {
  const v: unknown = JSON.parse(raw);
  if (typeof v === "number" && !Number.isFinite(v)) {
    throw new Error("non-finite number" + (label ? " in " + label : ""));
  }
  return v;
}

// A shipped default is shared data: handing out the object itself let a
// caller that edits what get() returned (the garage sheet mutates its parts
// build in place) rewrite the default for every later read and for RESET.
const cloneDef = (v: unknown): unknown => (v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);

function shortKey(k: string): string { return k.indexOf(PREFIX) === 0 ? k.slice(PREFIX.length) : k; }
function fullKey(k: string): string { return PREFIX + shortKey(k); }

function errName(e: unknown): string {
  const name = e && typeof e === "object" && "name" in e ? e.name : undefined;
  return (typeof name === "string" && name) || "Error";
}

/**
 * A store over `storage` (default: the page's localStorage, guarded; `null`
 * means none, so every write is session-only).
 */
export function createGarageStore(storage?: StorageLike | null): GarageStore {
  const st = (): StorageLike | null => {
    if (storage !== undefined) return storage;
    try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
  };
  // localStorage.getItem on a missing storage: f1-game sees a ReferenceError
  // there and treats it as unavailable storage, as here.
  const disk = (): StorageLike => {
    const s = st();
    if (!s) throw Object.assign(new Error("storage unavailable"), { name: "SecurityError" });
    return s;
  };
  const cache = new Map<string, unknown>(); // full-key -> parsed value; kills per-frame getItem + JSON.parse
  const keyRev = new Map<string, number>(); // full-key -> writes observed in this document
  const rawOverrides = new Map<string, string | null>(); // failed raw sets, or null tombstones, usable this session
  let broken: string | null = null;
  let rev = 0;

  function noteBroken(e: unknown): void {
    if (!broken) broken = errName(e);
  }
  function dropCorrupt(key: string): void {
    try { disk().removeItem(key); } catch (err) { noteBroken(err); }
  }
  // `d` is the CALL-SITE default; settings-defaults outranks it when it names
  // this key, so a shipped default lives in one file instead of in whichever
  // module happened to read the key first. Garage keys (parts./livery./setup./
  // team/driver/…) fall through to garage-defaults the same way — a player's
  // stored value still wins; only a miss reads the shipped garage.
  function def(k: string, d: unknown): unknown {
    if (SettingsDefaults.has(k)) return cloneDef(SettingsDefaults.get(k));
    if (GarageDefaults.has(k)) return cloneDef(GarageDefaults.get(k));
    return d;
  }

  const store: GarageStore = {
    get broken() { return broken; },
    get rev() { return rev; },
    get(k, d) {
      const key = PREFIX + k;
      let v = cache.get(key);
      if (v === undefined && !cache.has(key)) {
        let raw: string | null;
        try {
          raw = disk().getItem(key);
        } catch (e) {
          // A read that THROWS is storage being unavailable: the default is the
          // right answer. Remember the miss: with storage BLOCKED every read
          // throws, and a key read per frame re-threw 60 times a second.
          noteBroken(e);
          cache.set(key, undefined);
          return def(k, d);
        }
        try {
          v = raw === null ? undefined : parseStored(raw, k);
        } catch {
          // A CORRUPT VALUE IS ONE KEY, NOT BROKEN STORAGE. Drop that one key
          // and serve the default.
          dropCorrupt(key);
          cache.set(key, undefined);
          return def(k, d);
        }
        cache.set(key, v);
      }
      return v === undefined ? def(k, d) : v;
    },
    // What the PLAYER stored (or set this session), with no shipped default and
    // no call-site fallback: undefined when the key was never written.
    getStored(k) {
      const key = fullKey(k);
      if (!cache.has(key)) store.get(shortKey(k), undefined); // fills the cache through the one read/corrupt-key path
      return cache.get(key);
    },
    set(k, v) {
      return store.write(k, v).durable;
    },
    // `undefined` REMOVES THE KEY. JSON.stringify(undefined) is undefined and
    // setItem coerced it to the string "undefined" — unparseable at the next
    // boot. Removal is what a get() of that key then answered anyway (the
    // default). THE CACHE IS WRITTEN EVEN WHEN THE DISK WRITE FAILS, and that is
    // deliberate: dropping the value would break the SESSION as well as the
    // save; `durable:false` is the record.
    write(k, v) {
      const key = PREFIX + k;
      // STRINGIFY ONCE, BEFORE ANYTHING IS TOUCHED: a value that cannot be
      // serialised is refused whole (no cache, no rev).
      let json: string | undefined;
      try { json = v === undefined ? undefined : JSON.stringify(v); }
      catch (e) {
        noteBroken(e);
        return { ok: false, durable: false, reason: broken || errName(e) };
      }
      // JSON.stringify returns undefined for a top-level function or Symbol.
      // That is different from an explicit undefined (remove): refuse it rather
      // than silently discarding the old save.
      if (v !== undefined && json === undefined) {
        const e = new TypeError("value is not JSON-serializable");
        noteBroken(e);
        return { ok: false, durable: false, reason: broken || e.name };
      }
      let durable = true;
      try {
        if (json === undefined) disk().removeItem(key);
        else disk().setItem(key, json);
      } catch (e) { durable = false; noteBroken(e); }
      rawOverrides.delete(key);
      cache.set(key, v);
      keyRev.set(key, (keyRev.get(key) || 0) + 1);
      rev++;
      return { ok: true, durable, reason: durable ? null : (broken || "Error") };
    },
    keyRevision(k) {
      return "0:" + (keyRev.get(fullKey(k)) || 0);
    },
    // THE RAW STRING LANE: bare "1"/"0" flags under the same prefix, NOT the
    // JSON cache — a raw read hits the disk every call. null means NEVER SET on
    // this lane, so a shipped default is substituted only for a key
    // settings-defaults actually names.
    raw(k) {
      const short = shortKey(k);
      const dflt = (): string | null => {
        const v = SettingsDefaults.has(short) ? SettingsDefaults.get(short) : undefined;
        // TODO(lane-shell): f1-game returns the default as stored (a number or
        // boolean for some keys); the raw lane is typed string here.
        return v === undefined ? null : String(v);
      };
      if (rawOverrides.has(fullKey(k))) { const v = rawOverrides.get(fullKey(k)); return v == null ? dflt() : v; }
      try { const v = disk().getItem(fullKey(k)); return v === null ? dflt() : v; }
      catch (e) { noteBroken(e); return dflt(); }
    },
    rawSet(k, v) {
      const key = fullKey(k);
      cache.delete(key); // a key lives in one lane; if one ever strays, the disk wins
      const s = String(v);
      keyRev.set(key, (keyRev.get(key) || 0) + 1);
      try { disk().setItem(key, s); rawOverrides.delete(key); return true; }
      catch (e) { noteBroken(e); rawOverrides.set(key, s); return false; }
    },
    rawDel(k) {
      const key = fullKey(k);
      cache.delete(key);
      keyRev.set(key, (keyRev.get(key) || 0) + 1);
      try { disk().removeItem(key); rawOverrides.delete(key); return true; }
      catch (e) { noteBroken(e); rawOverrides.set(key, null); return false; }
    },
  };
  return store;
}

/** An in-memory Storage (tests, private windows). */
export function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}
