/**
 * Load f1-game's js/perf IIFEs in a Node VM with stub globals (Log, GameStore,
 * localStorage, performance, window), so the port can be compared against the
 * real source. Reads f1-game only when present: gate callers on `hasF1Perf`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { F1_ROOT } from "../data/f1-vm";

export const hasF1Perf = existsSync(path.join(F1_ROOT, "js/perf/governor.js"));

export interface VmOpts {
  /** apex26.* keys GameStore.store.raw / localStorage.getItem see. */
  store?: Map<string, string>;
  /** performance.now() / Date.now() inside the VM. */
  now?: () => number;
  build?: number | string;
  extra?: Record<string, unknown>;
}

/** Evaluate js/perf `files` in one context and return the binding `name` (a top-level const). */
export function f1Perf<T>(files: string[], name: string, opts: VmOpts = {}): T {
  const store = opts.store ?? new Map<string, string>();
  const now = opts.now ?? (() => 0);
  const raw = {
    raw: (k: string) => store.get(k) ?? null,
    rawSet: (k: string, v: string) => { store.set(k, String(v)); },
    rawDel: (k: string) => { store.delete(k); },
    get: (_k: string, d: unknown) => d,
    set: () => {},
  };
  const noop = (): void => {};
  const ctx = createContext({
    Math, JSON, Number, String, Array, Object, Float64Array, Infinity, NaN, parseInt, isFinite, Promise, Set,
    console,
    Log: { info: noop, warn: noop, error: noop, debug: noop },
    GameStore: { store: raw },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } },
    performance: { now },
    Date: { now },
    window: { __APEX_BUILD: opts.build ?? 1 },
    ...opts.extra,
  });
  for (const f of files) runInContext(readFileSync(path.join(F1_ROOT, f), "utf8"), ctx, { filename: f });
  return runInContext(name, ctx) as T;
}
