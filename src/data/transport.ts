/**
 * Serialized API transport: cache, rate limits, timeouts, retries and
 * cancellation. Ported from f1-game js/data/api-transport.js:1-433.
 *
 * Provider limits, checked 2026-10-18:
 * - OpenF1 free tier: 3 requests/s and 30/min (https://openf1.org/).
 * - Jolpica: 4 requests/s burst, 500/hour sustained
 *   (https://github.com/jolpica/jolpica-f1/blob/main/docs/rate_limits.md).
 *
 * Changes from f1-game: the cache prefix is `a26.api.` (AGENTS.md: f1-game
 * owns `apex26.` on the same origin); `fetch` and storage are injectable so
 * tests run on recorded fixtures; errors are a typed `ApiError`.
 */
import { log } from "./log";

/** An HTTP / timeout / cancellation failure (api-transport.js:242-256, 287-291). */
export class ApiError extends Error {
  status: number | undefined;
  retryAfterMs = 0;
  /** True when cancelAll() dropped the request (the shape js/data/export.js recognises). */
  cancelled = false;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface RequestOptions {
  /** false: never read or write the cache (live delta polls). */
  cache?: boolean;
}

/** The storage subset the cache uses (localStorage-shaped). */
export interface CacheStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Minimal fetch Response shape (so tests can hand-build one). */
export interface FetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null } | undefined;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchFn = (url: string, init?: { signal: AbortSignal }) => Promise<FetchResponse>;

export interface TransportDeps {
  fetch?: FetchFn;
  /** null: no persistent cache (memory LRU only for oversize bodies). */
  storage?: CacheStorage | null;
}

export interface Transport {
  request<T = unknown>(url: string, ttl: number, options?: RequestOptions): Promise<T>;
  cancelAll(): number;
  cacheEntryT(raw: unknown): number | null;
  staleMark(): number;
  staleSince(mark: number): number | null;
  forget(url: string): void;
}

interface CacheEntry { t: number; data: unknown }
interface Lane { queue: Promise<unknown>; lastNetAt: number }

export const CACHE_PREFIX = "a26.api.";

function defaultStorage(): CacheStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function createTransport(OPENF1: string, TTL_HISTORIC: number, deps: TransportDeps = {}): Transport {
  const doFetch: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;

  const CACHE_MAX_CHARS = 256 * 1024;
  const MIN_GAP_MS = 400;
  const MAX_RETRY = 2;         // retries on 429 / 5xx before giving up
  const RETRY_BASE_MS = 10000; // 10 s first retry — OpenF1 rate-limits hard; short
  const RETRY_CAP_MS = 25000;  //   delays only eat more quota, so wait longer
  // Retry-After is honoured AS SENT up to this ceiling. OpenF1 commonly asks
  // for 60 s; past the ceiling the request fails fast instead (stale cache if
  // there is one).
  const RETRY_AFTER_MAX_MS = 90000;
  const FETCH_TIMEOUT_MS = 15000;

  const MINUTE = 60 * 1000;
  const CACHE_SWEEP_MS = 5 * MINUTE;     // a response batch must not rescan storage per item

  // OpenF1's minute budget must not block an unrelated Jolpica request.
  const openF1Lane: Lane = { queue: Promise.resolve(), lastNetAt: 0 };
  const otherLane: Lane = { queue: Promise.resolve(), lastNetAt: 0 };
  // OpenF1's free tier is 30 requests a minute: a sliding window holds it under the cap.
  const OPENF1_PER_MIN = 28;
  const of1Recent: number[] = [];
  let netGen = 0;                                  // bumped by cancelAll()
  const liveControllers = new Set<AbortController>();
  const pendingWaits = new Set<() => void>();
  const inFlight = new Map<string, Promise<unknown>>();
  const failWarnAt = new Map<string, number>();
  const FAIL_WARN_MS = 30 * 1000;
  let lastCacheSweepAt = -Infinity;
  // Bodies over CACHE_MAX_CHARS skip storage; a few are kept here.
  const MEM_MAX = 4;
  const memCache = new Map<string, CacheEntry>();  // insertion order = LRU order
  let staleSeq = 0;
  const staleLog: { seq: number; t: number }[] = [];

  // Cached payloads serialize as {"t":<ms>,"data":…} — t first — so sweeps can
  // read the timestamp with a prefix match. Legacy/corrupt entries fall back to a full parse.
  function cacheEntryT(raw: unknown): number | null {
    if (typeof raw !== "string") return null;
    const m = /^\{"t":(\d+)[,}]/.exec(raw);
    if (m) return +(m[1] as string);
    try {
      const obj: unknown = JSON.parse(raw);
      return isRecord(obj) && typeof obj.t === "number" ? obj.t : null;
    } catch {
      return null;
    }
  }

  function purgeExpiredCache(maxAge: number = TTL_HISTORIC): number {
    let removed = 0;
    if (!storage) return 0;
    try {
      const n = storage.length;
      if (typeof n !== "number") return 0;
      const now = Date.now();
      const doomed: string[] = [];
      for (let i = 0; i < n; i++) {
        const key = storage.key(i);
        if (!key || key.indexOf(CACHE_PREFIX) !== 0) continue;
        const t = cacheEntryT(storage.getItem(key));
        if (t == null || (now - t) > maxAge || t > now) doomed.push(key);   // future-stamped = clock skew
      }
      for (const key of doomed) {
        try { storage.removeItem(key); removed++; } catch { /* ignore */ }
      }
    } catch { /* no storage */ }
    return removed;
  }

  // Quota fallback: windowed telemetry bodies go first, largest first;
  // everything else follows oldest first.
  function purgeOldestCache(count: number): number {
    let removed = 0;
    if (!storage) return 0;
    try {
      const entries: { key: string; t: number; size: number; telem: boolean }[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key || key.indexOf(CACHE_PREFIX) !== 0) continue;
        const raw = storage.getItem(key);
        const t = cacheEntryT(raw);   // null (corrupt) → oldest
        entries.push({
          key, t: t || 0,
          size: typeof raw === "string" ? raw.length : 0,
          telem: /\/(car_data|location)\?/.test(key),
        });
      }
      entries.sort((a, b) => {
        if (a.telem !== b.telem) return a.telem ? -1 : 1;
        if (a.telem) return b.size - a.size;
        return a.t - b.t;
      });
      const n = Math.min(count || 8, entries.length);
      for (let i = 0; i < n; i++) {
        try { storage.removeItem((entries[i] as { key: string }).key); removed++; } catch { /* ignore */ }
      }
    } catch { /* no storage */ }
    return removed;
  }

  function readCache(url: string): CacheEntry | null {
    const mem = memCache.get(url);
    if (mem) { memCache.delete(url); memCache.set(url, mem); return mem; }
    if (!storage) return null;
    try {
      const raw = storage.getItem(CACHE_PREFIX + url);
      if (!raw) return null;
      const obj: unknown = JSON.parse(raw);
      if (isRecord(obj) && typeof obj.t === "number" && Object.prototype.hasOwnProperty.call(obj, "data")) {
        return { t: obj.t, data: obj.data };
      }
    } catch { /* corrupt entry / no storage: ignore */ }
    return null;
  }

  function writeCache(url: string, data: unknown): void {
    const key = CACHE_PREFIX + url;
    const payload = JSON.stringify({ t: Date.now(), data });
    // A multi-MB body would take the origin's whole storage quota from the
    // game's own saves: keep it in memory only, and drop an older disk copy.
    if (payload.length > CACHE_MAX_CHARS) {
      memCache.delete(url);
      memCache.set(url, { t: Date.now(), data });
      while (memCache.size > MEM_MAX) memCache.delete(memCache.keys().next().value as string);
      try { storage?.removeItem(key); } catch { /* no storage */ }
      return;
    }
    memCache.delete(url);
    if (!storage) return;
    const now = Date.now();
    let swept = false;
    if (now - lastCacheSweepAt >= CACHE_SWEEP_MS) {
      purgeExpiredCache();
      lastCacheSweepAt = now;
      swept = true;
    }
    try {
      storage.setItem(key, payload);
      return;
    } catch (e) {
      log.warn("api cache write failed (quota?)", e);
    }
    if (!swept) purgeExpiredCache();
    purgeOldestCache(16);
    try {
      storage.setItem(key, payload);
    } catch (e2) {
      log.warn("api cache write still failing after purge", e2);
    }
  }

  function cancelledError(url: string): ApiError {
    const e = new ApiError("Cancelled request for " + url);
    e.cancelled = true;
    return e;
  }

  function httpError(url: string, res: FetchResponse): ApiError {
    const err = new ApiError("HTTP " + res.status + " for " + url, res.status);
    // Retry-After is not CORS-safelisted: absent unless the provider exposes it.
    const hdr = res.headers?.get ? res.headers.get("retry-after") : null;
    let ra = parseFloat(hdr as string);
    if (!isFinite(ra) && hdr) ra = (Date.parse(hdr) - Date.now()) / 1000;
    if (isFinite(ra) && ra > 0) err.retryAfterMs = Math.round(ra * 1000);
    return err;
  }

  // Own the entire attempt, including reading/parsing the body: fetch()
  // resolves at headers, so timing only that leaves a stalled body holding
  // its provider's queue slot forever.
  function fetchTimed(url: string, consume: (res: FetchResponse, httpErr: ApiError | null) => Promise<unknown>): Promise<unknown> {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (controller) liveControllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | null = null;
    let responseError: ApiError | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ApiError("Request timed out for " + url));
        if (controller) controller.abort();
      }, FETCH_TIMEOUT_MS);
    });
    const cancelled = controller ? new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(cancelledError(url));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    }) : null;
    let network: Promise<unknown>;
    try {
      network = Promise.resolve(doFetch(url, controller ? { signal: controller.signal } : undefined)).then((res) => {
        // Remember failure headers BEFORE awaiting the body: a rejected body
        // must not turn a known 401/403 into an offline error eligible for stale fallback.
        if (!res.ok) responseError = httpError(url, res);
        return consume(res, responseError);
      });
    } catch (e) {
      network = Promise.reject(e);
    }
    // Promise.race is intentional even with AbortController: a broken fetch
    // that ignores abort must still release its provider queue.
    return Promise.race(cancelled ? [network, timeout, cancelled] : [network, timeout]).catch((err: unknown) => {
      const re = responseError as ApiError | null;
      if (!re || (err instanceof ApiError && err.cancelled) || err === re) throw err;
      // Wrap rather than mutate a body implementation's rejection.
      const failure = new ApiError(err instanceof Error && err.message ? err.message : re.message, re.status);
      failure.retryAfterMs = re.retryAfterMs;
      failure.cause = err;
      throw failure;
    }).finally(() => {
      clearTimeout(timer);
      if (controller) {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        liveControllers.delete(controller);
      }
    });
  }

  // Single attempt: status/error handling only. Retries live in request(),
  // where the backoff sleep happens OUTSIDE the provider's queue slot.
  function fetchOnce(url: string, lane: Lane): Promise<unknown> {
    lane.lastNetAt = Date.now();
    // Count actual attempts, never a reservation cancelled during pacing.
    if (lane === openF1Lane) of1Recent.push(lane.lastNetAt);
    return fetchTimed(url, (res, httpErr) => {
      if (!res.ok) {
        return res.text().then((txt) => {
          const err = httpErr as ApiError;
          try {
            const j: unknown = JSON.parse(txt);
            // OpenF1 answers a query with no data yet as HTTP 404
            // {"detail":"No results found."} — an empty answer, not a failure.
            if (res.status === 404 && isRecord(j) && /no results found/i.test(String(j.detail || ""))) return [];
            if (isRecord(j) && (j.detail || j.error)) err.message = String(j.detail || j.error);
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
          }
          throw err;
        });
      }
      return res.json();
    });
  }

  // f1-game's endpointName(), for log lines only (api-transport.js:155-176).
  function endpointName(url: string): string {
    const noQ = String(url || "").split("?")[0] as string;
    if (/driverstandings/i.test(noQ)) return "driverstandings";
    if (/constructorstandings/i.test(noQ)) return "constructorstandings";
    if (/\/last\/results/i.test(noQ)) return "last-results";
    if (/\/meetings/i.test(noQ)) return "meetings";
    if (/\/sessions/i.test(noQ)) return "sessions";
    if (/\/position/i.test(noQ)) return "position";
    if (/\/intervals/i.test(noQ)) return "intervals";
    if (/\/drivers/i.test(noQ)) return "drivers";
    if (/\/laps/i.test(noQ)) return "laps";
    if (/\/car_data/i.test(noQ)) return "car_data";
    if (/\/location/i.test(noQ)) return "location";
    if (/\/stints/i.test(noQ)) return "stints";
    if (/\/pits?(\/|$)/i.test(noQ)) return "pits";
    if (/\/weather/i.test(noQ)) return "weather";
    if (/\d{4}\.json$/i.test(noQ)) return "schedule";
    const last = noQ.split("/").filter(Boolean).pop() || "api";
    return last.replace(/\.json$/i, "").slice(0, 32);
  }

  function warnFetchFail(name: string, kind: string): void {
    const now = Date.now();
    if (now - (failWarnAt.get(name) || 0) < FAIL_WARN_MS) return;
    failWarnAt.set(name, now);
    log.warn("fetch " + name + " fail" + (kind ? " " + kind : ""));
  }

  function waitForRequest(ms: number, url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cancel = (): void => {
        clearTimeout(timer); pendingWaits.delete(cancel);
        reject(cancelledError(url));
      };
      const timer = setTimeout(() => { pendingWaits.delete(cancel); resolve(); }, ms);
      pendingWaits.add(cancel);
    });
  }

  function request<T = unknown>(url: string, ttl: number, options?: RequestOptions): Promise<T> {
    const myGen = netGen;
    const lane = url.indexOf(OPENF1) === 0 ? openF1Lane : otherLane;
    const cache = !options || options.cache !== false;
    const quiet = ttl <= 0 || (options && options.cache === false);
    const name = endpointName(url);
    const hit = cache ? readCache(url) : null;
    // age < 0 is an entry stamped by a clock since stepped back: refetch.
    const age = hit ? Date.now() - hit.t : 0;
    if (ttl > 0 && hit && age >= 0 && age < ttl) return Promise.resolve(hit.data as T);
    // Cache policy and generation are part of the in-flight key (api-transport.js:313-318).
    const flightKey = myGen + "|" + (cache ? "cache|" : "network|") + url;
    const shared = inFlight.get(flightKey);
    if (shared) return shared as Promise<T>;

    // Each attempt claims ONE queue slot and releases it before any backoff sleep.
    function attempt(n: number): Promise<unknown> {
      const slot = lane.queue
        .then(() => {
          if (myGen !== netGen) throw cancelledError(url);
          let wait = lane.lastNetAt + MIN_GAP_MS - Date.now();
          if (lane === openF1Lane) {
            const now = Date.now();
            while (of1Recent.length && now - (of1Recent[0] as number) >= 60000) of1Recent.shift();
            if (of1Recent.length >= OPENF1_PER_MIN) wait = Math.max(wait, (of1Recent[0] as number) + 60000 - now + 50);
          }
          if (wait > 0) return waitForRequest(wait, url);
          return null;
        })
        .then(() => {
          if (myGen !== netGen) throw cancelledError(url);
          return fetchOnce(url, lane);
        });
      lane.queue = slot.then(() => {}, () => {});
      return slot.catch((err: unknown) => {
        if (myGen !== netGen) throw cancelledError(url);
        const status = err instanceof ApiError ? err.status : undefined;
        if (status !== undefined && (status === 429 || (status >= 500 && status < 600)) && n < MAX_RETRY) {
          const ra = (err as ApiError).retryAfterMs || 0;
          if (ra > RETRY_AFTER_MAX_MS) throw err;   // server wants longer than a tab will wait
          const back = ra || Math.min(RETRY_BASE_MS * Math.pow(2, n), RETRY_CAP_MS);
          return waitForRequest(back, url).then(() => attempt(n + 1));
        }
        throw err;
      });
    }

    const job = attempt(0)
      .then((json) => {
        if (myGen !== netGen) throw cancelledError(url);
        if (cache) writeCache(url, json);
        if (!quiet) log.info("fetch " + name + " ok");
        return json;
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.cancelled) throw err;   // no stale fallback, no warning
        // Never paper over live-session auth lockouts with stale cache.
        const msg = err instanceof Error ? err.message : "";
        const status = err instanceof ApiError ? err.status : undefined;
        if (hit && status !== 401 && status !== 403 && msg.indexOf("Live F1 session") === -1 && msg.indexOf("HTTP 401") === -1 && msg.indexOf("HTTP 403") === -1) {
          warnFetchFail(name, "stale");
          staleLog.push({ seq: ++staleSeq, t: hit.t });
          if (staleLog.length > 64) staleLog.shift();
          return hit.data;
        }
        warnFetchFail(name, "");
        throw err;
      });

    inFlight.set(flightKey, job);
    const forgetFlight = (): void => {
      if (inFlight.get(flightKey) === job) inFlight.delete(flightKey);
    };
    job.then(forgetFlight, forgetFlight);
    return job as Promise<T>;
  }

  // Drop every request born before now. Keep attempt timestamps: reopening never resets server quotas.
  function cancelAll(): number {
    netGen++;
    inFlight.clear();
    for (const cancel of [...pendingWaits]) cancel();
    let aborted = 0;
    liveControllers.forEach((c) => {
      try { c.abort(); aborted++; } catch { /* already settled */ }
    });
    liveControllers.clear();
    if (aborted) log.info("api cancelAll aborted " + aborted);
    return aborted;
  }

  // staleMark() before a load, staleSince(mark) after it: the oldest
  // stale-copy time served in between, or null when every answer was fresh.
  function staleMark(): number { return staleSeq; }
  function staleSince(mark: number): number | null {
    let t: number | null = null;
    for (const s of staleLog) {
      if (s.seq > mark && (t === null || s.t < t)) t = s.t;
    }
    return t;
  }

  /** Drop one URL from BOTH caches. */
  function forget(url: string): void {
    memCache.delete(url);
    try { storage?.removeItem(CACHE_PREFIX + url); } catch { /* no storage */ }
  }

  return { request, cancelAll, cacheEntryT, staleMark, staleSince, forget };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
