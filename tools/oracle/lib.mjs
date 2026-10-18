// Shared helpers for the f1-game oracle dumpers (tools/oracle/*.mjs).
//
// The dumpers load f1-game's REAL sources from a read-only checkout (default
// ../f1-game, override with F1_GAME=/path) and write reference output into
// tests/goldens/. apex-26's tests never need f1-game: they read the goldens.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const F1 = path.resolve(process.env.F1_GAME || path.join(ROOT, "..", "f1-game"));

export function f1Sha() {
  try { return execFileSync("git", ["-C", F1, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

/** A bare VM with the given f1-game files evaluated in order (top-level const → var, as game-vm.cjs does). */
export function loadF1(files, globals = {}) {
  const ctx = vm.createContext({ Math, JSON, Object, Array, Number, isNaN, isFinite, console, Float32Array, Float64Array, Map, Set, WeakMap, Infinity, NaN, ...globals });
  ctx.window = ctx;
  ctx.Log = { info() {}, warn() {}, debug() {}, error() {}, enabled: () => false, DEBUG: 0 };
  for (const f of files) {
    const src = fs.readFileSync(path.join(F1, f), "utf8").replace(/^const\b/gm, "var");
    vm.runInContext(src, ctx, { filename: path.join(F1, f) });
  }
  return ctx;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * JSON with exact doubles. JSON.stringify already prints the shortest
 * round-trip form of every finite double; -0, NaN and ±Infinity become
 * {"$n": "..."} so `Object.is` survives the trip (tests/goldens/decode.ts).
 */
export function encode(value) {
  return JSON.stringify(value, function (k, v) {
    const raw = this[k];
    if (typeof raw === "number") {
      if (Object.is(raw, -0)) return { $n: "-0" };
      if (Number.isNaN(raw)) return { $n: "NaN" };
      if (raw === Infinity) return { $n: "Infinity" };
      if (raw === -Infinity) return { $n: "-Infinity" };
    }
    return v;
  });
}

export function writeGolden(name, value) {
  const out = path.join(ROOT, "tests", "goldens", name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encode(value) + "\n");
  console.log(`wrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}
