// Load f1-game's js/fx/*.js IIFEs in a Node VM with a seeded Math.random and stub
// globals (LightTune, PerfGov, Log), so a test can drive them side by side with the
// src/fx port on the same random stream. Reads f1-game only when present: gate callers
// on `hasF1Fx` (CI has no checkout).
//
// The VM copies are test-only rewrites of the source: each IIFE's `return {` gains a
// `_pool` accessor over its private arrays so the pools compare element by element.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext, type Context } from "node:vm";

export const F1_ROOT = process.env["F1_GAME"] ?? "/home/f1-game";
export const hasF1Fx = existsSync(path.join(F1_ROOT, "js/fx/particles.js"));

/** mulberry32: a tiny seeded [0, 1) stream. Two instances with one seed are one sequence. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL_HOOK: Record<string, [string, string]> = {
  "js/fx/particles.js": [
    "return { init, clear,",
    "return { _pool: () => ({ n: _n, px: _px, py: _py, pz: _pz, vx: _vx, vy: _vy, vz: _vz, age: _age, life: _life, sz: _sz, grw: _grw, cr: _cr, cg: _cg, cb: _cb, a0: _a0, drg: _drg, grv: _grv, add: _add, flN: _flN, fl: _fl, rainN: _rainN, rox: _rox, roy: _roy, roz: _roz }), init, clear,",
  ],
  "js/fx/droplets.js": [
    "return { tick, clear,",
    "return { _pool: () => ({ n: _n, acc: _acc, x: _x, y: _y, r: _r, age: _age, life: _life, vx: _vx, vy: _vy, a: _a }), tick, clear,",
  ],
};

export interface F1FxGlobals {
  random?: () => number;
  LightTune?: unknown;
  PerfGov?: unknown;
  [k: string]: unknown;
}

/** Evaluate `files` (paths under f1-game) in one context; read back the top-level consts. */
export function loadF1Fx(files: readonly string[], globals: F1FxGlobals = {}): Context {
  const { random, ...rest } = globals;
  const noop = (): void => {};
  const ctx = createContext({
    Float32Array, Float64Array, Uint8Array, Array, Object, WeakMap, JSON, Number,
    Math: random ? Object.assign(Object.create(Math) as object, { random }) : Math,
    Log: { info: noop, warn: noop, error: noop, debug: noop },
    ...rest,
  });
  // js/physics/consts.js assigns window.PhysicsConsts: the context is its own window.
  if (!("window" in rest)) (ctx as Record<string, unknown>)["window"] = ctx;
  for (const f of files) {
    let src = readFileSync(path.join(F1_ROOT, f), "utf8");
    const hook = POOL_HOOK[f];
    if (hook) {
      if (!src.includes(hook[0])) throw new Error(`${f}: pool hook anchor moved`);
      src = src.replace(hook[0], hook[1]);
    }
    runInContext(src, ctx, { filename: f });
  }
  return ctx;
}

export function f1Get<T>(ctx: Context, expr: string): T {
  return runInContext(expr, ctx) as T;
}

/** Element-wise Object.is over two array-likes; returns the first mismatch or null. */
export function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>, n = Math.max(a.length, b.length)): string | null {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < n; i++) if (!Object.is(a[i], b[i])) return `[${i}] ${a[i]} vs ${b[i]}`;
  return null;
}
