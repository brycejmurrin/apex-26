/**
 * The storage the editor keeps its circuits in: the subset of f1-game's
 * `GameStore.store` (js/core/store.js) that js/editor/ calls. Keys are given
 * unprefixed (`customTracks`); `localStore()` stores them under `a26.`
 * (AGENTS.md: f1-game owns `apex26.` on the same origin). Values are JSON.
 */

/** f1-game store.write's verdict: `durable` false when the write did not reach storage. */
export interface WriteResult {
  ok: boolean;
  durable: boolean;
}

export interface EditorStore {
  get<T>(key: string, dflt: T): T;
  set(key: string, value: unknown): void;
  write(key: string, value: unknown): WriteResult;
  rawDel(key: string): void;
}

export const PREFIX = "a26.";

/** A store over a Storage (localStorage by default); every access is guarded. */
export function localStore(storage?: Storage | null): EditorStore {
  const st = (): Storage | null => {
    if (storage !== undefined) return storage;
    try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
  };
  const write = (key: string, value: unknown): WriteResult => {
    const s = st();
    if (!s) return { ok: false, durable: false };
    try { s.setItem(PREFIX + key, JSON.stringify(value)); return { ok: true, durable: true }; }
    catch { return { ok: false, durable: false }; }
  };
  return {
    get<T>(key: string, dflt: T): T {
      const s = st();
      if (!s) return dflt;
      try {
        const raw = s.getItem(PREFIX + key);
        return raw == null ? dflt : (JSON.parse(raw) as T);
      } catch { return dflt; }
    },
    set(key: string, value: unknown) { write(key, value); },
    write,
    rawDel(key: string) { const s = st(); try { if (s) s.removeItem(PREFIX + key); } catch { /* storage blocked */ } },
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
