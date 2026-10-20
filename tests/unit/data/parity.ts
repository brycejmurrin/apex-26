/**
 * Committed parity fixtures: f1-game's reference outputs for the data lane's
 * ports, so CI (which has no f1-game checkout) still checks parity.
 *
 * `parity(name, port, ref)` registers two tests:
 *  - always: the port's record, encoded, deep-equals tests/fixtures/data/parity/<name>.json;
 *  - with A26_WRITE_FIXTURES=1 and f1-game present (F1_GAME, see f1-vm.ts): the
 *    record is recomputed from f1-game in node:vm, checked equal to the port's,
 *    and written over the fixture. Without the env var nothing is ever written.
 *
 * Regenerate at an f1-game re-sync:
 *   A26_WRITE_FIXTURES=1 F1_GAME=/path/to/f1-game npx vitest run tests/unit/data
 *
 * Encoding keeps every value exact: finite doubles are JSON numbers (they
 * round-trip), and -0, NaN, ±Infinity, undefined and typed arrays are tagged,
 * so comparing encoded records is Object.is-exact and keeps undefined-valued keys.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { F1_ROOT, hasF1 } from "./f1-vm";

export const WRITE_FIXTURES = process.env["A26_WRITE_FIXTURES"] === "1";

// cwd, not import.meta.url: under happy-dom the module URL is not a file: URL.
const DIR = resolve(process.cwd(), "tests/fixtures/data/parity");

export type Encoded = null | boolean | number | string | Encoded[] | { [k: string]: Encoded };

/** Tag the values JSON cannot carry exactly. Works on values from another realm (node:vm). */
export function encode(v: unknown, path = "$"): Encoded {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (v === undefined) return { $undef: true };
  if (typeof v === "number") {
    if (Object.is(v, -0)) return { $num: "-0" };
    if (!Number.isFinite(v)) return { $num: String(v) };
    return v;
  }
  if (typeof v === "object") {
    if (ArrayBuffer.isView(v)) {
      const t = Object.prototype.toString.call(v).slice(8, -1);
      return { $typed: t, v: Array.from(v as unknown as ArrayLike<number>, (x, i) => encode(x, `${path}[${i}]`)) };
    }
    if (Array.isArray(v)) return Array.from(v, (x: unknown, i) => encode(x, `${path}[${i}]`));
    // fromEntries, not assignment: a "__proto__" key stays an own key, as JSON.parse makes it.
    return Object.fromEntries(Object.keys(v).map((k) => {
      if (k.startsWith("$")) throw new Error(`${path}: key ${k} collides with the fixture tags`);
      return [k, encode((v as Record<string, unknown>)[k], `${path}.${k}`)];
    }));
  }
  throw new Error(`${path}: cannot encode a ${typeof v}`);
}

/** The first path where two encoded records differ, for a readable failure; null when equal. */
export function firstDiff(a: Encoded, b: Encoded, path = "$"): string | null {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return Object.is(a, b) ? null : `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return `${path}: prototypes differ`;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join("\u0000") !== kb.join("\u0000")) return `${path}: keys [${ka.join(",")}] !== [${kb.join(",")}]`;
  for (const k of ka) {
    const d = firstDiff((a as Record<string, Encoded>)[k]!, (b as Record<string, Encoded>)[k]!, `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

function f1Commit(): string {
  try {
    return execFileSync("git", ["-C", F1_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

interface ParityFile { module: string; f1game: string; note: string; values: Encoded }

export function fixturePath(name: string): string {
  return resolve(DIR, `${name}.json`);
}

/** Register the fixture tests for one module. `port` and `ref` build the same-shaped record. */
export function parity(name: string, port: () => Record<string, unknown>, ref: () => Record<string, unknown>): void {
  describe(`${name}: parity with the committed f1-game reference`, () => {
    it.runIf(WRITE_FIXTURES && hasF1)("regenerates the fixture from f1-game in a VM (A26_WRITE_FIXTURES=1)", () => {
      const theirs = encode(ref()), mine = encode(port());
      expect(firstDiff(mine, theirs), "the port must match f1-game before its outputs are committed").toBe(null);
      expect(mine).toStrictEqual(theirs);
      const file: ParityFile = {
        module: name, f1game: f1Commit(),
        note: "f1-game reference outputs; regenerate with A26_WRITE_FIXTURES=1 F1_GAME=<f1-game> npx vitest run tests/unit/data (see tests/unit/data/parity.ts)",
        values: theirs,
      };
      mkdirSync(DIR, { recursive: true });
      writeFileSync(fixturePath(name), JSON.stringify(file) + "\n");
    });

    it("the port reproduces f1-game's recorded outputs exactly", () => {
      const file = JSON.parse(readFileSync(fixturePath(name), "utf8")) as ParityFile;
      expect(file.module).toBe(name);
      const mine = encode(port());
      expect(firstDiff(mine, file.values)).toBe(null);
      expect(mine).toStrictEqual(file.values);
    });
  });
}
