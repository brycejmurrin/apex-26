/**
 * WATCH & DRIVE: fetching and caching. The raw OpenF1 bodies of one race, the
 * compact script LRU in localStorage, and the real positions in IndexedDB.
 *
 * Ported verbatim from f1-game js/data/real-race-tab.js:
 *   constants            :6-28
 *   fetchRaw             :465-482
 *   forgetRaw            :484-495
 *   traceDb              :497-520   (one memoised connection per cache instance)
 *   traceGet             :521-544
 *   tracePut             :545-571
 *   fetchTraces          :619-661
 *   cached, lru*, pruneScripts, remember   :663-696
 *
 * apex-26 names: localStorage keys `a26.realrace.v1.<sessionKey>` and
 * `a26.realrace.lru`; IndexedDB `a26.replay` (f1-game owns `apex26.*` on the same
 * origin). F1API (a global there) is `deps.api`; the transport's cache prefix is
 * CACHE_PREFIX from ../transport ("a26.api.").
 */
import type { F1Api, Key } from "../api";
import { CACHE_PREFIX, type CacheStorage } from "../transport";
import {
  OPENF1, SCRIPT_V, TRACE_HZ, TRACE_PAD_S, TRACE_V, packTrace, traceCoverage, traceEnd, traceFits, usableTrace,
  type OpenF1Driver, type OpenF1Lap, type OpenF1Overtake, type OpenF1Pit, type OpenF1Position, type OpenF1RaceControl,
  type OpenF1Result, type OpenF1Session, type OpenF1Stint, type OpenF1TeamRadio, type OpenF1Weather,
  type RaceScript, type RawRace, type Traces,
} from "./script";

export const TTL = 7 * 24 * 60 * 60 * 1000;   // a finished race never changes; the same TTL api.js gives a historic session
export const CACHE_KEY = "a26.realrace.v1.";   // one compact script per session key (the raw laps body is 480 KB and never cached)
// A script is ~45 KB; one per watched session with no eviction filled the 5 MB origin quota
// after ~115 sessions and starved every save. Keep the newest few (an LRU index, newest first).
export const CACHE_LRU = "a26.realrace.lru";
export const CACHE_MAX = 8;
export const RAW_PATHS: readonly string[] = ["/sessions?", "/drivers?", "/laps?", "/stints?", "/pit?", "/overtakes?", "/race_control?", "/weather?", "/session_result?", "/position?", "/team_radio?"];
export const TRACE_DB = "a26.replay", TRACE_STORE = "traces";
export const TRACE_MAX = 8;              // races kept (~1.5 MB each); the newest-first order lives in the store under TRACE_LRU
export const TRACE_LRU = "__lru";
const TRACE_OPEN_MS = 4000;       // a blocked/never-settling open() degrades to "no cache"

/** The F1Api members this module reads (f1-game: F1API.request/meetings/forget/locationData). */
export type RealRaceApi = Pick<F1Api, "request" | "meetings" | "locationData"> & Partial<Pick<F1Api, "forget">>;

/** The IndexedDB subset traceDb uses (tests hand-build one). */
export interface TraceIdbFactory { open(name: string, version?: number): IDBOpenDBRequest }

export interface RealRaceCacheDeps {
  api: RealRaceApi;
  /** undefined: the page's localStorage; null: no script cache. */
  storage?: CacheStorage | null;
  /** undefined: the page's indexedDB; null: no positions cache. */
  indexedDB?: TraceIdbFactory | null;
}

export interface FetchTracesOptions { refresh?: boolean }

export interface RealRaceCache {
  fetchRaw(sessionKey: Key, fresh?: boolean): Promise<RawRace>;
  forgetRaw(sessionKey: Key): void;
  cached(sessionKey: Key): RaceScript | null;
  remember(script: RaceScript): void;
  traceGet(sessionKey: Key | null, script?: RaceScript | null): Promise<Traces | null>;
  tracePut(traces: Traces): Promise<boolean>;
  fetchTraces(script: RaceScript, onProgress?: ((done: number, total: number, traces: Traces) => void) | null,
              previous?: Traces | null, options?: FetchTracesOptions | null): Promise<Traces>;
}

function defaultStorage(): CacheStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
function defaultIdb(): TraceIdbFactory | null {
  try { return typeof indexedDB === "undefined" || !indexedDB ? null : indexedDB; } catch { return null; }
}
const arr = <T>(v: readonly T[] | null | undefined): readonly T[] => (Array.isArray(v) ? v : []);

export function createRealRaceCache(deps: RealRaceCacheDeps): RealRaceCache {
  const api = deps.api;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const idb = deps.indexedDB === undefined ? defaultIdb() : deps.indexedDB;

  // ── Fetching: one script per session, through F1API's queue and rate window ──
  function fetchRaw(sessionKey: Key, fresh?: boolean): Promise<RawRace> {
    const q = <T>(path: string, opts?: { cache?: boolean }): Promise<T> => api.request<T>(OPENF1 + path + "session_key=" + encodeURIComponent(sessionKey), TTL, fresh ? Object.assign({}, opts, { cache: false }) : opts);
    return Promise.all([
      q<OpenF1Session[]>("/sessions?"), q<OpenF1Driver[]>("/drivers?"), q<OpenF1Lap[]>("/laps?", { cache: false }), q<OpenF1Stint[]>("/stints?"), q<OpenF1Pit[]>("/pit?"), q<OpenF1Overtake[]>("/overtakes?"),
      q<OpenF1RaceControl[]>("/race_control?"), q<OpenF1Weather[]>("/weather?"), q<OpenF1Result[]>("/session_result?"), q<OpenF1Position[]>("/position?"), q<OpenF1TeamRadio[]>("/team_radio?"),
    ]).then((r) => {
      const session: OpenF1Session = arr(r[0])[0] || { session_key: sessionKey };
      const raw: RawRace = { session, drivers: r[1], laps: r[2], stints: r[3], pits: r[4], overtakes: r[5], raceControl: r[6], weather: r[7], result: r[8], positions: r[9], teamRadio: r[10] };
      // The weekend's NAME lives on the meeting, not the session (F1API.meetings is the picker's cached list).
      if (session.meeting_key == null || !session.year) return raw;
      return api.meetings(session.year).then((ms) => {
        const m = ms.find((x) => x.meetingKey === session.meeting_key);
        if (m && m.name) session.meeting_name = m.name;
        return raw;
      }, () => raw);
    });
  }

  /** Drop the cached bodies of a race that was not complete, so the next open
   *  refetches them: api.js caches each for seven days, which would otherwise
   *  freeze an unfinished classification for a week. */
  function forgetRaw(sessionKey: Key): void {
    try {
      for (const path of RAW_PATHS) {
        const url = OPENF1 + path + "session_key=" + encodeURIComponent(sessionKey);
        if (api.forget) api.forget(url);   // memory too: a body over 256K never reaches localStorage
        else if (storage) storage.removeItem(CACHE_PREFIX + url);
      }
    } catch { /* no storage: nothing was cached */ }
  }

  // ── The real positions: one /location pull per car, kept in IndexedDB ──
  // ONE connection per page, memoised (the js/core/store.js mirrorOpen pattern): a get or put
  // each opened its own and never closed it, and a version bump would block on every one.
  let traceDbP: Promise<IDBDatabase | null> | null = null;
  function traceDb(): Promise<IDBDatabase | null> {
    if (traceDbP) return traceDbP;
    traceDbP = new Promise<IDBDatabase | null>((res) => {
      let settled = false, timer: ReturnType<typeof setTimeout> | null = null, r: IDBOpenDBRequest | null = null;
      const finish = (db: IDBDatabase | null): void => {
        if (settled) { if (db) { try { db.close(); } catch { /* late open after a block or timeout: nothing owns it */ } } return; }
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (db) db.onversionchange = db.onclose = () => { try { db.close(); } catch { /* already closed */ } traceDbP = null; };
        res(db || null);
      };
      try { if (!idb) { finish(null); return; } r = idb.open(TRACE_DB, 1); }
      catch { finish(null); return; }
      const rq = r;
      rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains(TRACE_STORE)) db.createObjectStore(TRACE_STORE); };
      rq.onsuccess = () => finish(rq.result);
      rq.onerror = rq.onblocked = () => finish(null);
      if (typeof setTimeout === "function") timer = setTimeout(() => finish(null), TRACE_OPEN_MS);
    }).then((db) => { if (!db) traceDbP = null; return db; });   // never memoise a failure
    return traceDbP;
  }
  function traceGet(sessionKey: Key | null, script?: RaceScript | null): Promise<Traces | null> {
    return traceDb().then((db) => new Promise<Traces | null>((res) => {
      if (!db) { res(null); return; }
      try {
        const key = String(sessionKey), tx = db.transaction(TRACE_STORE, "readwrite"), st = tx.objectStore(TRACE_STORE);
        let hit: Traces | null = null;
        const rq = st.get(key);
        rq.onsuccess = () => {
          const v = rq.result as Traces | null | undefined;
          if (!(v && v.v === TRACE_V && v.complete && v.cars && (!script || traceFits(v, script)))) return;
          hit = v;
          let order: IDBRequest;
          try { order = st.get(TRACE_LRU); } catch { res(null); return; }
          order.onsuccess = () => {
            try { const prev = Array.isArray(order.result) ? (order.result as unknown[]).map(String) : [];
              st.put([key].concat(prev.filter((k) => k !== key)).slice(0, TRACE_MAX), TRACE_LRU); }
            catch { try { tx.abort(); } catch { /* already finished */ } res(null); }
          };
        };
        tx.oncomplete = () => res(hit);
        tx.onerror = tx.onabort = () => res(null);
      } catch { res(null); }
    }));
  }
  /** Store one race's positions and keep only the newest TRACE_MAX races (the photo-studio
   *  LIMIT pattern: the read, the prune and the put share one readwrite transaction). */
  function tracePut(traces: Traces): Promise<boolean> {
    return traceDb().then((db) => new Promise<boolean>((res) => {
      if (!db) { res(false); return; }
      try {
        const key = String(traces.sessionKey);
        const t = db.transaction(TRACE_STORE, "readwrite"), st = t.objectStore(TRACE_STORE);
        const rq = st.get(TRACE_LRU);
        rq.onsuccess = () => {
          try {
            const prev = Array.isArray(rq.result) ? (rq.result as unknown[]).map(String) : [];
            const order = [key].concat(prev.filter((k) => k !== key)).slice(0, TRACE_MAX);
            for (const k of prev) if (order.indexOf(k) < 0) st.delete(k);
            if (typeof st.getAllKeys === "function") {   // races stored before the order existed
              const all = st.getAllKeys();
              all.onsuccess = () => { for (const k of all.result || []) if (k !== TRACE_LRU && order.indexOf(String(k)) < 0) st.delete(k); };
            }
            st.put(traces, key);
            st.put(order, TRACE_LRU);
          } catch { try { t.abort(); } catch { /* already finished */ } }
        };
        t.oncomplete = () => res(true);
        t.onerror = t.onabort = () => res(false);   // quota: the next visit fetches again
      } catch { res(false); }
    }));
  }

  /** The field's positions for a script: cached, else fetched car by car (onProgress(done, total)).
   *  options.refresh skips IndexedDB and the in-memory recording and downloads every car again. */
  function fetchTraces(script: RaceScript, onProgress?: ((done: number, total: number, traces: Traces) => void) | null,
                       previous?: Traces | null, options?: FetchTracesOptions | null): Promise<Traces> {
    const refresh = !!(options && options.refresh);
    if (!script || !script.t0 || !script.drivers) return Promise.reject(new Error("no timestamps in the script"));
    return (refresh ? Promise.resolve(null) : traceGet(script.sessionKey, script)).then((hit) => {
      if (hit) return hit;
      const t0 = script.t0!;
      const end = traceEnd(script);
      const startISO = new Date(t0 - TRACE_PAD_S * 1000).toISOString(), endISO = new Date(t0 + (end + TRACE_PAD_S) * 1000).toISOString();
      const failed: number[] = [];
      const traces: Traces & { failed: number[]; complete: boolean } = { v: TRACE_V, sessionKey: script.sessionKey, t0, hz: TRACE_HZ,
        coverage: traceCoverage(script), complete: script.complete === true, cars: {}, failed };
      if (!refresh && previous && traceFits(previous, script)) {
        for (const k in previous.cars || {}) if (!(previous.failed || []).includes(+k) && previous.cars[k]!.length >= 6) traces.cars[k] = previous.cars[k]!;
      }
      for (const d of script.drivers) if (traces.cars[d.num] && !usableTrace(traces.cars[d.num], d)) delete traces.cars[d.num];
      let done = 0;
      const total = script.drivers.length;
      return Promise.all(script.drivers.map((d) => (d.dns
        ? Promise.resolve().then(() => { traces.cars[d.num] = new Float32Array(0); })
        : Object.prototype.hasOwnProperty.call(traces.cars, d.num)
        // This layer owns coverage-aware caching. A raw HTTP cache entry may
        // predate the completed timing even when its URL/window is identical.
        ? Promise.resolve() : api.locationData(script.sessionKey!, d.num, startISO, endISO, { cache: false })
          .then((rows) => { const car = packTrace(rows, t0); traces.cars[d.num] = car; if (!usableTrace(car, d)) { failed.push(d.num); } }, () => { failed.push(d.num); traces.cars[d.num] = new Float32Array(0); }))
        .then(() => { done++; if (onProgress) onProgress(done, total, traces); })))
        // A failed request is not "no positions": a hub closed mid-load (F1API.cancelAll) or a dropped
        // connection. Such a set is NEVER cached (it would read as loaded, and every WATCH replay nothing).
        .then(() => {
          const participating = script.drivers.filter((d) => !d.dns);
          // RealReplay needs >100 samples to fit a reference car to the circuit.
          // Sparse fulfilled responses must remain retryable just like errors.
          if (!participating.some((d) => traces.cars[d.num] && traces.cars[d.num]!.length > 300)) {
            for (const d of participating) if (!failed.includes(d.num)) failed.push(d.num);
          }
          // A partial refresh must not replace a recording the player can already watch.
          if (refresh && failed.length) throw new Error("the positions refresh did not load every car");
          traces.complete = traces.complete && failed.length === 0;
          if (!participating.length || participating.every((d) => failed.includes(d.num))) throw new Error("the positions did not load");
          return traces.complete ? tracePut(traces).then(() => traces) : traces;
        });
    });
  }

  function cached(sessionKey: Key): RaceScript | null {
    try {
      const raw = storage ? storage.getItem(CACHE_KEY + sessionKey) : null;
      const s = raw ? JSON.parse(raw) as Partial<RaceScript> | null : null;
      const ok = s && s.v === SCRIPT_V && s.complete === true && (s.laps ?? 0) > 0 && Array.isArray(s.drivers) ? s as RaceScript : null;
      if (ok) lruWrite(lruFront(sessionKey));
      return ok;
    } catch { return null; }
  }
  function lruRead(): string[] {
    try { const a: unknown = JSON.parse((storage && storage.getItem(CACHE_LRU)) || "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
  }
  function lruFront(sessionKey: Key | null): string[] {
    const k = String(sessionKey);
    return [k].concat(lruRead().filter((x) => x !== k)).slice(0, CACHE_MAX);
  }
  function lruWrite(order: string[]): void { try { if (storage) storage.setItem(CACHE_LRU, JSON.stringify(order)); } catch { /* quota: the order is advisory */ } }
  /** Drop every cached script not in `keep` — indexed ones and any written before the index existed. */
  function pruneScripts(keep: string[]): void {
    try {
      if (!storage) return;
      const drop = new Set(lruRead().filter((k) => keep.indexOf(k) < 0).map((k) => CACHE_KEY + k));
      const n = typeof storage.length === "number" && typeof storage.key === "function" ? storage.length : 0;
      for (let i = 0; i < n; i++) {
        const k = storage.key(i);
        if (k && k.indexOf(CACHE_KEY) === 0 && keep.indexOf(k.slice(CACHE_KEY.length)) < 0) drop.add(k);
      }
      for (const k of drop) storage.removeItem(k);
    } catch { /* no storage */ }
  }
  function remember(script: RaceScript): void {
    const order = lruFront(script.sessionKey);
    pruneScripts(order);   // before the write, so the room it frees is there for it
    try {
      if (!storage) return;
      storage.setItem(CACHE_KEY + script.sessionKey, JSON.stringify(script)); lruWrite(order);
    } catch { /* quota: the next open refetches */ }
  }

  return { fetchRaw, forgetRaw, cached, remember, traceGet, tracePut, fetchTraces };
}
