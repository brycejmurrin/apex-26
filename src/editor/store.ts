/**
 * The storage the editor keeps its circuits in: the subset of f1-game's
 * `GameStore.store` (js/core/store.js) that js/editor/ calls. Keys are given
 * unprefixed (`customTracks`); `localStore()` stores them under `a26.`
 * (AGENTS.md: f1-game owns `apex26.` on the same origin). Values are JSON.
 */

/**
 * f1-game store.write's verdict (js/core/store.js:119): `ok` means the value is
 * usable this session, `durable` that it will survive a reload; `reason` names
 * the failure when it will not.
 */
export interface WriteResult {
  ok: boolean;
  durable: boolean;
  reason?: string | null;
}

export interface EditorStore {
  get<T>(key: string, dflt: T): T;
  set(key: string, value: unknown): void;
  write(key: string, value: unknown): WriteResult;
  rawDel(key: string): void;
}

export const PREFIX = "a26.";

/**
 * A store over a Storage (localStorage by default); every access is guarded.
 * Like f1-game's GameStore (js/core/store.js:95-166) it keeps a write-through
 * session cache: a write the disk refuses (quota, Private Browsing) still
 * answers later get()s with the new value and reports `durable: false`, rather
 * than dropping it and breaking the session as well as the save.
 */
export function localStore(storage?: Storage | null): EditorStore {
  const cache = new Map<string, unknown>();
  const st = (): Storage | null => {
    if (storage !== undefined) return storage;
    try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
  };
  const write = (key: string, value: unknown): WriteResult => {
    let json: string | undefined;
    try { json = value === undefined ? undefined : JSON.stringify(value); }
    catch (e) { return { ok: false, durable: false, reason: (e as Error).name || "Error" }; }
    if (value !== undefined && json === undefined) return { ok: false, durable: false, reason: "TypeError" };
    let durable = true, reason: string | null = null;
    const s = st();
    try {
      if (!s) throw new Error("no storage");
      if (json === undefined) s.removeItem(PREFIX + key); else s.setItem(PREFIX + key, json);
    } catch (e) { durable = false; reason = (e as Error).name || "Error"; }
    // Cache a parsed copy, so a caller mutating its object cannot change what get() returns.
    if (json === undefined) cache.set(key, undefined); else cache.set(key, JSON.parse(json));
    return { ok: true, durable, reason };
  };
  return {
    get<T>(key: string, dflt: T): T {
      if (cache.has(key)) {
        const v = cache.get(key);
        return v === undefined ? dflt : (JSON.parse(JSON.stringify(v)) as T);
      }
      const s = st();
      if (!s) return dflt;
      try {
        const raw = s.getItem(PREFIX + key);
        return raw == null ? dflt : (JSON.parse(raw) as T);
      } catch { return dflt; }
    },
    set(key: string, value: unknown) { write(key, value); },
    write,
    rawDel(key: string) {
      cache.delete(key);
      const s = st();
      try { if (s) s.removeItem(PREFIX + key); } catch { /* storage blocked */ }
    },
  };
}

/** An in-memory store (tests, private windows). Values are deep-copied like a JSON round trip. */
export function memoryStore(): EditorStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    get<T>(key: string, dflt: T): T { return key in data ? (JSON.parse(data[key]!) as T) : dflt; },
    set(key: string, value: unknown) { data[key] = JSON.stringify(value); },
    write(key: string, value: unknown) { data[key] = JSON.stringify(value); return { ok: true, durable: true }; },
    rawDel(key: string) { delete data[key]; },
  };
}
