/** tests/fixtures/camera/*.json: f1-game reference outputs the camera parity
 *  tests computed in a VM, committed so CI (no f1-game) still checks the port.
 *  The encoding keeps -0, NaN, ±Infinity and undefined; numbers otherwise
 *  round-trip exactly through JSON (shortest round-trip decimal).
 *  Regenerate: UPDATE_CAM_FIXTURES=1 npx vitest run tests/unit/camera */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

const DIR = join(import.meta.dirname, "../../fixtures/camera");
export const UPDATE = process.env["UPDATE_CAM_FIXTURES"] === "1";

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

function revive(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("$n" in o && Object.keys(o).length === 1) {
      return ({ NaN: NaN, Inf: Infinity, "-Inf": -Infinity, "-0": -0 } as Record<string, number>)[o["$n"] as string];
    }
    if ("$u" in o && Object.keys(o).length === 1) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = revive(x);
    return out;
  }
  return v;
}

/** A plain-data copy (typed arrays → arrays, VM-realm objects → this realm), numbers untouched. */
export function plainData(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  if (Array.isArray(v)) return v.map(plainData);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x !== "function") out[k] = plainData(x);
    return out;
  }
  return v;
}

export function hasFixture(name: string): boolean { return existsSync(join(DIR, name + ".json")); }

export function readFixture(name: string): unknown {
  return revive(JSON.parse(readFileSync(join(DIR, name + ".json"), "utf8")));
}

/** Write when asked to (UPDATE_CAM_FIXTURES=1) or when the fixture is missing. */
export function maybeWriteFixture(name: string, data: unknown): void {
  if (!UPDATE && hasFixture(name)) return;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, name + ".json"), encode(plainData(data)) + "\n");
}

/** Deep equality with Object.is on every number (bit-exact, -0 ≠ 0). */
export function expectBitExact(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof expected === "number" || typeof actual === "number") {
    if (!Object.is(actual, expected)) expect.fail(`${path}: ${String(actual)} !== ${String(expected)}`);
    return;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) expect.fail(`${path}: array vs non-array`);
    if (actual.length !== expected.length) expect.fail(`${path}: length ${actual.length} !== ${expected.length}`);
    for (let i = 0; i < expected.length; i++) expectBitExact(actual[i], expected[i], `${path}[${i}]`);
    return;
  }
  if (expected && typeof expected === "object" && actual && typeof actual === "object") {
    const ka = Object.keys(actual).filter((k) => (actual as Record<string, unknown>)[k] !== undefined).sort();
    const ke = Object.keys(expected).filter((k) => (expected as Record<string, unknown>)[k] !== undefined).sort();
    if (ka.join() !== ke.join()) expect.fail(`${path}: keys [${ka.join()}] !== [${ke.join()}]`);
    for (const k of ke) expectBitExact((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  if (actual !== expected) expect.fail(`${path}: ${String(actual)} !== ${String(expected)}`);
}
