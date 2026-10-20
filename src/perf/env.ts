/**
 * Shared seams for src/perf/: the raw string store and the log sink.
 *
 * f1-game's perf modules reach two globals: `GameStore.store` (its raw lane:
 * bare strings, read live, never throws — js/core/store.js) and `Log`
 * (js/core/log.js). apex-26 has neither as a global (AGENTS.md §Code rules), so
 * every perf module takes a `RawStore` and logs through the replaceable sink
 * here. TODO(lane-shell): point `setPerfLog` at the shared logger once
 * src/debug/ has one; the shell's settings store can replace `localRawStore`.
 *
 * Keys are `a26.`-prefixed: f1-game owns `apex26.` on the same origin.
 */

/** f1-game GameStore.store's raw lane (raw / rawSet / rawDel), as used by js/perf/*.js. */
export interface RawStore {
  raw(key: string): string | null;
  rawSet(key: string, value: string): void;
  rawDel(key: string): void;
}

/** A `RawStore` over `localStorage`; every call survives blocked or missing storage. */
export function localRawStore(src: () => Storage | null | undefined = defaultStorage): RawStore {
  return {
    raw(key) {
      try { return src()?.getItem(key) ?? null; } catch { return null; }
    },
    rawSet(key, value) {
      try { src()?.setItem(key, value); } catch { /* blocked storage: session-only */ }
    },
    rawDel(key) {
      try { src()?.removeItem(key); } catch { /* blocked storage */ }
    },
  };
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** An in-memory `RawStore` (tests, a harness with no storage). */
export function memoryRawStore(init: Record<string, string> = {}): RawStore & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    raw: (k) => data.get(k) ?? null,
    rawSet: (k, v) => { data.set(k, v); },
    rawDel: (k) => { data.delete(k); },
  };
}

/** The slice of f1-game's `Log` the perf modules call (ns first, js/core/log.js). */
export interface PerfLog {
  info(ns: string, msg: string): void;
  warn(ns: string, msg: string): void;
  error(ns: string, msg: string, err?: unknown): void;
}

const consoleLog: PerfLog = {
  info: () => { /* f1-game's shipped console level is warn: info stays quiet */ },
  warn: (ns, msg) => console.warn(`[${ns}] ${msg}`),
  error: (ns, msg, err) => console.error(`[${ns}] ${msg}`, err),
};

let sink: PerfLog = consoleLog;

export const perfLog: PerfLog = {
  info: (ns, msg) => sink.info(ns, msg),
  warn: (ns, msg) => sink.warn(ns, msg),
  error: (ns, msg, err) => sink.error(ns, msg, err),
};

/** Replace the sink (tests, the debug overlay). Returns the previous one. */
export function setPerfLog(next: PerfLog): PerfLog {
  const prev = sink;
  sink = next;
  return prev;
}

/** `performance.now()` with f1-game's Date.now() fallback (loop-health.js:40). */
export function nowMs(): number {
  try { return performance.now(); } catch { return Date.now(); }
}
