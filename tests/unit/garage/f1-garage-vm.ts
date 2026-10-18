/** Load f1-game's js/garage IIFEs in a Node VM with the globals they read
 *  (GameStore, PhysicsConsts, document, …), for bit-exact comparisons against
 *  the ports. Reads f1-game only when present: gate callers on `hasF1`. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { F1_ROOT, hasF1 } from "../data/f1-vm";

export { F1_ROOT, hasF1, plain } from "../data/f1-vm";
export const hasF1Garage = hasF1 && (() => { try { readFileSync(path.join(F1_ROOT, "js/garage/setup-tune.js")); return true; } catch { return false; } })();

/** Evaluate `files` (paths under f1-game) in one context seeded with `globals`; returns a binding reader. */
export function f1Load(files: string[], globals: Record<string, unknown> = {}): (name: string) => unknown {
  const ctx = createContext({ ...globals });
  (ctx as Record<string, unknown>)["window"] = ctx;
  for (const f of files) runInContext(readFileSync(path.join(F1_ROOT, f), "utf8"), ctx, { filename: f });
  // Top-level `const` globals are not properties of the context object; read the binding.
  return (name) => runInContext(name, ctx);
}

/** The f1-game unit tests' GameStore double (tests/unit/setup-tune.test.mjs:21-29):
 *  a miss answers the shipped value before the call-site default; set(k, undefined) removes. */
export function mapStore(shipped: Record<string, unknown> = {}) {
  const stored = new Map<string, unknown>();
  return {
    stored,
    get: (k: string, d: unknown): unknown => (stored.has(k) ? stored.get(k) : (k in shipped ? shipped[k] : d)),
    set: (k: string, v: unknown): boolean => { if (v === undefined) stored.delete(k); else stored.set(k, v); return true; },
  };
}

/** The player-tools/garage-followups double: structuredClone values, per-key revisions, write(). */
export function revStore() {
  const values = new Map<string, unknown>(), revisions = new Map<string, number>(), changes: string[] = [];
  const store = {
    durable: true,
    get: (k: string, d: unknown): unknown => (values.has(k) ? structuredClone(values.get(k)) : d),
    write(k: string, v: unknown) { values.set(k, structuredClone(v)); revisions.set(k, (revisions.get(k) || 0) + 1); changes.push(k); return { ok: true, durable: this.durable }; },
    set(k: string, v: unknown): boolean { return this.write(k, v).durable; },
    keyRevision: (k: string): string => String(revisions.get(k) || 0),
  };
  return { store, values, changes };
}
