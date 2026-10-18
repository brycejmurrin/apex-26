// Replay helpers for tests/fixtures/race/*.json (tools/race-fixtures/gen.cjs).
// Fixtures store f1-game's outputs in an encoding that keeps NaN, ±Infinity, -0
// and undefined; `norm` puts a TypeScript result through the same encoding so
// the two compare with toEqual.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "../../fixtures/race");

function encode(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === "number") {
      if (Number.isNaN(x)) return { $n: "NaN" };
      if (x === Infinity) return { $n: "Inf" };
      if (x === -Infinity) return { $n: "-Inf" };
      if (Object.is(x, -0)) return { $n: "-0" };
    }
    if (x === undefined) return { $u: 1 };
    return x;
  });
}

/** A TS value in fixture encoding. */
export function norm(v: unknown): unknown {
  return JSON.parse(encode(v));
}

/** Decode fixture encoding back to values (for scenario inputs). */
export function revive<T = unknown>(v: unknown): T {
  if (Array.isArray(v)) return v.map((x) => revive(x)) as T;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("$n" in o && Object.keys(o).length === 1) {
      return ({ NaN: NaN, Inf: Infinity, "-Inf": -Infinity, "-0": -0 } as Record<string, number>)[o["$n"] as string] as T;
    }
    if ("$u" in o && Object.keys(o).length === 1) return undefined as T;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      const r = revive(x);
      if (r !== undefined) out[k] = r;
    }
    return out as T;
  }
  return v as T;
}

/** The raw (still encoded) fixture payload. */
export function fixture<T = unknown>(name: string): T {
  const f = JSON.parse(readFileSync(join(DIR, name + ".json"), "utf8")) as { data: T };
  return f.data;
}

/** JSON round trip with Infinity → 1e308, as gen.cjs `clone` snapshots. */
export function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o, (_k, v: unknown) => (v === Infinity ? 1e308 : v))) as T;
}

/** The comparable form of a TS result or an encoded fixture value. */
export function cmp(v: unknown, encoded = false): unknown {
  return revive(encoded ? v : norm(v));
}

/** tools/race-fixtures/vm.cjs `rng` (mulberry32), for scenarios the test replays from the seed. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** gen.cjs `pick`. */
export function pick<T>(r: () => number, a: readonly T[]): T {
  return a[Math.floor(r() * a.length)] as T;
}
