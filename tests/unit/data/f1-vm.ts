/** Load f1-game's IIFE data modules in a Node VM, with the real js/core
 *  globals they read at eval time (M4 from mat4.js, Hash32 from hash32.js).
 *  Reads f1-game only when present: gate callers on `hasF1`. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";

export const F1_ROOT = process.env["F1_GAME"] ?? "/home/f1-game";
export const hasF1 = existsSync(path.join(F1_ROOT, "js/data/driver-ratings.js"));

const CORE = ["js/core/mat4.js", "js/core/hash32.js"];

/** Evaluate js/core then `files` (paths under f1-game) in one context; return the global `name`. */
export function f1Global(files: string[], name: string): unknown {
  const ctx = createContext({});
  for (const f of [...CORE, ...files]) runInContext(readFileSync(path.join(F1_ROOT, f), "utf8"), ctx, { filename: f });
  // Top-level `const` globals are not properties of the context object; read the binding.
  return runInContext(name, ctx);
}

/** Re-home a VM-realm value into this realm so deep equality sees plain objects. */
export function plain<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
