/**
 * SAVES: the `a26.`-prefixed JSON store the modes persist through, and the
 * one-time import of f1-game's `apex26.*` saves (same origin, AGENTS.md).
 *
 * The store is the core of f1-game js/core/store.js (main @ 2026-10-18):
 * cached reads (:44-84), `write` returning `{ ok, durable, reason }` with the
 * cache kept on a failed disk write (:105-175), `undefined` removing the key
 * (:118-122), non-finite top-level numbers refused as corrupt (:10-16), a
 * corrupt key dropped rather than flagging storage broken (:71-80), and
 * per-key revisions for conflict checks (:204-206). Not ported: the IndexedDB
 * mirror, settings/garage defaults, the raw string lane (owned by the shell).
 *
 * The backing `Storage` is injected, so tests use a Map and the app passes
 * `window.localStorage`.
 */

export const PREFIX = "a26.";
/** f1-game's prefix on the same origin. Read once by `importLegacy`, never written. */
export const LEGACY_PREFIX = "apex26.";
/** Where the one-time import records itself. */
export const IMPORT_KEY = "importedFrom";

/** The subset of the DOM Storage API the store uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export interface WriteResult {
  /** The value is usable this session (always true for a serialisable value). */
  ok: boolean;
  /** The value will survive a reload. */
  durable: boolean;
  reason: string | null;
}

export interface StoreChange {
  key: string;
  durable: boolean;
  reason: string | null;
  local: boolean;
}

/** Parse a stored string; a non-finite top-level number is corrupt (store.js:10-16). */
export function parseStored(raw: string, label?: string): unknown {
  const v: unknown = JSON.parse(raw);
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error("non-finite number" + (label ? " in " + label : ""));
  return v;
}

export class SaveStore {
  private readonly cache = new Map<string, unknown>();
  private readonly keyRev = new Map<string, number>();
  private readonly listeners = new Set<(c: StoreChange) => void>();
  /** Bumped on every write; memo caches key off it. */
  rev = 0;
  /** The first storage failure seen, by error name; null while healthy. */
  broken: string | null = null;

  constructor(private readonly storage: StorageLike | null) {}

  private note(e: unknown): void {
    if (!this.broken) this.broken = (e instanceof Error && e.name) || "Error";
  }

  /** The stored value, or `d` (store.js get, :44-84). */
  get<T>(k: string, d: T): T {
    const key = PREFIX + k;
    let v = this.cache.get(key);
    if (v === undefined && !this.cache.has(key)) {
      let raw: string | null;
      try {
        raw = this.storage ? this.storage.getItem(key) : null;
      } catch (e) {
        this.note(e);
        this.cache.set(key, undefined);
        return d;
      }
      try {
        v = raw === null ? undefined : parseStored(raw, k);
      } catch {
        try { this.storage?.removeItem(key); } catch { /* unavailable */ }
        this.cache.set(key, undefined);
        return d;
      }
      this.cache.set(key, v);
    }
    return v === undefined ? d : v as T;
  }

  /** Write `v` (undefined removes the key). The cache takes it even when the disk refuses (store.js write). */
  write(k: string, v: unknown): WriteResult {
    const key = PREFIX + k;
    let json: string | undefined;
    try { json = v === undefined ? undefined : JSON.stringify(v); } catch (e) {
      this.note(e);
      return { ok: false, durable: false, reason: this.broken || "Error" };
    }
    if (v !== undefined && json === undefined) {
      this.note(new TypeError("value is not JSON-serializable"));
      return { ok: false, durable: false, reason: this.broken || "TypeError" };
    }
    let durable = !!this.storage;
    try {
      if (!this.storage) throw new Error("no storage");
      if (json === undefined) this.storage.removeItem(key);
      else this.storage.setItem(key, json);
    } catch (e) { durable = false; this.note(e); }
    this.cache.set(key, v);
    this.keyRev.set(key, (this.keyRev.get(key) || 0) + 1);
    this.rev++;
    const result: WriteResult = { ok: true, durable, reason: durable ? null : (this.broken || "Error") };
    for (const f of this.listeners) f({ key: k, durable, reason: result.reason, local: true });
    return result;
  }

  /** store.set: the durable flag only. */
  set(k: string, v: unknown): boolean { return this.write(k, v).durable; }

  /** Writes observed to `k` in this document; a save compares it to refuse a stale overwrite. */
  keyRevision(k: string): string { return "0:" + (this.keyRev.get(PREFIX + k) || 0); }

  /** A write made by another tab (the `storage` event): drop the cached value and bump the revision. */
  foreign(fullKey: string | null): void {
    if (fullKey === null) { this.cache.clear(); return; }
    if (!fullKey.startsWith(PREFIX)) return;
    this.cache.delete(fullKey);
    this.keyRev.set(fullKey, (this.keyRev.get(fullKey) || 0) + 1);
    const k = fullKey.slice(PREFIX.length);
    for (const f of this.listeners) f({ key: k, durable: true, reason: null, local: false });
  }

  subscribe(f: (c: StoreChange) => void): () => void {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  }
}

// ─── The one-time import from f1-game ──────────────────────────────────────

/**
 * The f1-game keys the modes carry over: the standalone season and its setup
 * (season-cal.js:7-8), the career slots and live pointer (career.js:108-110,
 * :209), My Team (custom-team.js), the player's seat, the grid/race rules the
 * championship reads, and per-circuit pit plans (pit-lane.js:1553).
 */
export const IMPORT_KEYS: readonly string[] = [
  "season", "seasonCfg", "career", "careerSlot", "customTeam", "team", "driver",
  "raceGrid", "champGrid", "reliability", "difficulty", "circuitMastery",
];
export const IMPORT_PREFIXES: readonly string[] = ["career.", "pitPlan."];

const wanted = (k: string): boolean => IMPORT_KEYS.indexOf(k) >= 0 || IMPORT_PREFIXES.some((p) => k.startsWith(p));

export interface ImportReport {
  /** Keys copied this call. */
  copied: string[];
  /** Keys skipped: an `a26.` value already there, or an unreadable legacy value. */
  skipped: string[];
  /** The import already ran on this origin; nothing was read. */
  already: boolean;
}

/**
 * Copy f1-game's mode saves to `a26.` once per origin. Never overwrites an
 * existing `a26.` key, never writes or deletes an `apex26.` key, and copies a
 * value only if it parses. Records itself under `a26.importedFrom`.
 */
export function importLegacy(store: SaveStore, storage: StorageLike | null, now = Date.now()): ImportReport {
  const report: ImportReport = { copied: [], skipped: [], already: false };
  if (store.get<unknown>(IMPORT_KEY, null) != null) { report.already = true; return report; }
  if (!storage) return report;
  const legacy: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const full = storage.key(i);
      if (full && full.startsWith(LEGACY_PREFIX)) legacy.push(full.slice(LEGACY_PREFIX.length));
    }
  } catch { return report; }
  legacy.sort();
  for (const k of legacy) {
    if (!wanted(k)) continue;
    if (store.get<unknown>(k, undefined) !== undefined) { report.skipped.push(k); continue; }
    let v: unknown;
    try {
      const raw = storage.getItem(LEGACY_PREFIX + k);
      if (raw === null) continue;
      v = parseStored(raw, k);
    } catch { report.skipped.push(k); continue; }
    if (store.write(k, v).ok) report.copied.push(k);
  }
  store.write(IMPORT_KEY, { from: LEGACY_PREFIX, at: now, keys: report.copied });
  return report;
}

/** A Map-backed Storage for tests and for a session with storage blocked. */
export class MemoryStorage implements StorageLike {
  private readonly m = new Map<string, string>();
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k) as string : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
}
