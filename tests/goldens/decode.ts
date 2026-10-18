// Read a golden written by tools/oracle/lib.mjs `encode`: plain JSON, except
// -0, NaN and ±Infinity, which travel as {"$n": "..."} so Object.is holds.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECIAL: Record<string, number> = { "-0": -0, NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity };

export function decode(text: string): unknown {
  return JSON.parse(text, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      const n = (v as { $n?: unknown }).$n;
      if (keys.length === 1 && typeof n === "string" && n in SPECIAL) return SPECIAL[n];
    }
    return v;
  });
}

export function readGolden<T>(name: string): T {
  const raw = fs.readFileSync(path.join(HERE, name));
  return decode((name.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8")) as T;
}

/**
 * First path where `got` and `want` differ under Object.is (numbers), strict
 * equality (other primitives) or shape; null when identical. `undefined` and
 * `null` count as equal: the goldens write a missing field as null.
 */
export function firstDiff(got: unknown, want: unknown, at = ""): string | null {
  if (got === undefined) got = null;
  if (want === undefined) want = null;
  if (typeof want === "number" || typeof got === "number") {
    return Object.is(got, want) ? null : `${at || "(root)"}: got ${String(got)} want ${String(want)}`;
  }
  if (want === null || got === null || typeof want !== "object" || typeof got !== "object") {
    return got === want ? null : `${at || "(root)"}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
  }
  if (Array.isArray(want) !== Array.isArray(got)) return `${at}: array vs object`;
  const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
  for (const k of keys) {
    const d = firstDiff((got as Record<string, unknown>)[k], (want as Record<string, unknown>)[k], at ? `${at}.${k}` : k);
    if (d) return d;
  }
  return null;
}
