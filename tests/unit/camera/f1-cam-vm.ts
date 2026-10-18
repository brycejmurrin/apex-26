/** Load f1-game's js/camera IIFE modules in a Node VM with the ambient globals
 *  they read (GameStore, M4, Log, Teams…), for bit-exact parity checks.
 *  Reads f1-game only when present: gate callers on `hasCam`. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { F1_ROOT } from "../data/f1-vm";

export const hasCam = existsSync(path.join(F1_ROOT, "js/camera/offsets.js"));

/** f1-game js/core/mat4.js:5 `M4.clamp`, the only M4 member these modules read. */
export const M4 = { clamp: (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v) };
export const LOG = { info(): void {}, warn(): void {}, debug(): void {}, error(): void {}, enabled: (): boolean => false };

/** Evaluate `files` (paths under js/camera/) in one context seeded with `globals`; return the binding `name`. */
export function f1Cam<T = Record<string, unknown>>(files: string[], name: string, globals: Record<string, unknown> = {}): T {
  const ctx = createContext({ M4, Log: LOG, ...globals });
  for (const f of files) {
    const rel = "js/camera/" + f;
    runInContext(readFileSync(path.join(F1_ROOT, rel), "utf8"), ctx, { filename: rel });
  }
  // Top-level `const` globals are not properties of the context object; read the binding.
  return runInContext(name, ctx) as T;
}

/** A Map-backed store with f1-game's GameStore.store surface (JSON + raw lanes). */
export function mapStore(init: Record<string, unknown> = {}) {
  const disk = new Map<string, unknown>(Object.entries(init));
  return {
    disk,
    get: (k: string, d: unknown): unknown => (disk.has(k) ? disk.get(k) : d),
    set: (k: string, v: unknown): boolean => { disk.set(k, v); return true; },
    raw: (k: string): string | null => (disk.has(k) ? (disk.get(k) as string) : null),
    rawSet: (k: string, v: unknown): boolean => { disk.set(k, String(v)); return true; },
  };
}
