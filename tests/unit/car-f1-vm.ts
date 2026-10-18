// Shared harness for the car-lane round trips: loads f1-game's classic scripts
// into a Node VM, the way the game's own <script> tags would, and reads their
// top-level `const` globals back out of the script scope.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CANDIDATES = [process.env["F1_GAME"], path.resolve(ROOT, "../f1-game"), "/home/user/f1-game"];

/** The f1-game checkout, or null where it is absent (CI). */
export const F1: string | null =
  CANDIDATES.find((p): p is string => !!p && fs.existsSync(path.join(p, "js/data/teams.js"))) ?? null;
export const haveF1 = F1 !== null;

const noop = (): void => {};

/** A Map-backed localStorage (the scripts under test never touch it; it is there
 *  so a script that did would not throw on a missing global). */
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  };
}

/** A fresh context with the f1-game scripts `files` (relative to the checkout) run in order. */
export function loadF1(files: readonly string[], globals: Record<string, unknown> = {}): vm.Context {
  if (!F1) throw new Error("f1-game checkout not found");
  const ctx = vm.createContext({
    Log: { info: noop, warn: noop, error: noop, debug: noop },
    localStorage: memStorage(),
    ...globals,
  });
  for (const f of files) {
    const file = path.join(F1, f);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
  }
  return ctx;
}

/** Evaluate `expr` in the context (script scope sees top-level `const`s). */
export function inF1<T>(ctx: vm.Context, expr: string): T {
  return vm.runInContext(expr, ctx) as T;
}

/** A JSON copy: drops the VM realm's prototypes so toEqual compares values only. */
export function plain<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
