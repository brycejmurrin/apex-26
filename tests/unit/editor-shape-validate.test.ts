// The designer's shape / randomise / validate / insight ports against f1-game's own code
// (tests/goldens/editor-codec.json.gz, tools/oracle/editor-dump.cjs): TrackRandom.generate for
// the five seeds, TrackValidate.check on every sanitised design, and generateValid reproducing
// each theme design's loop and ok flag. TrackMaps is absent, as in the dump's VM. revive / plain
// / tryIt are copied from tests/unit/editor-goldens.test.ts.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as TrackRandom from "../../src/editor/randomise";
import * as TrackValidate from "../../src/editor/validate";

type Json = unknown;
interface DesignRow { label: string; input: { theme: string; pts: Json }; generateValidOk?: boolean; sanitized: Json; validate?: Json }
interface Golden {
  header: { clock: number };
  randomGenerate: { seed: number; generate: Json }[];
  designs: DesignRow[];
}

/** The dump encodes -0 / NaN as {$n: "..."}. */
const revive = (_k: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "$n" in v ? Number((v as { $n: string }).$n) : v;
const G = JSON.parse(gunzipSync(readFileSync(new URL("../goldens/editor-codec.json.gz", import.meta.url))).toString(), revive) as Golden;

/** tools/oracle/editor-dump.cjs plain(): functions/undefined dropped, typed arrays as arrays, array holes as null. */
function plain(v: unknown, seen = new Set<object>()): unknown {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
  if (v === null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  if (seen.has(v)) return { $cycle: true };
  seen.add(v);
  let out: unknown;
  if (Array.isArray(v)) out = v.map((e) => { const p = plain(e, seen); return p === undefined ? null : p; });
  else { const o: Record<string, unknown> = {}; for (const k of Object.keys(v)) { const p = plain((v as Record<string, unknown>)[k], seen); if (p !== undefined) o[k] = p; } out = o; }
  seen.delete(v);
  return out;
}
const tryIt = (fn: () => unknown) => { try { return plain(fn()); } catch (e) { return { $error: String((e as Error).message ?? e) }; } };

beforeAll(() => { vi.spyOn(Date, "now").mockReturnValue(G.header.clock); TrackValidate.setTrackMaps(null); });
afterAll(() => { vi.restoreAllMocks(); });

describe("TrackRandom.generate", () => {
  it("has the five seeds", () => { expect(G.randomGenerate.length).toBe(5); });
  it.each(G.randomGenerate.map((r) => [r.seed, r] as const))("seed %d", (seed, r) => {
    expect(tryIt(() => TrackRandom.generate(seed))).toEqual(r.generate);
  });
});

describe("TrackValidate.check", () => {
  it("covers all 40 designs", () => { expect(G.designs.filter((d) => d.validate !== undefined).length).toBe(40); });
  it.each(G.designs.filter((d) => d.validate !== undefined).map((d) => [d.label, d] as const))("%s", (_l, d) => {
    expect(tryIt(() => TrackValidate.check(d.sanitized))).toEqual(d.validate);
  }, 30_000);
});

describe("TrackRandom.generateValid (theme designs)", () => {
  const themed = G.designs.filter((d) => d.generateValidOk !== undefined);
  it("has a row per theme", () => { expect(themed.length).toBeGreaterThan(0); });
  it.each(themed.map((d) => [d.label, d] as const))("%s", (_l, d) => {
    const theme = d.input.theme;
    const g = TrackRandom.generateValid(7, (pts) => TrackValidate.check({ theme, baseHW: 7, seed: 7, pts }).red === 0, 12);
    expect(plain(g.pts)).toEqual(d.input.pts);
    expect(g.ok).toBe(d.generateValidOk);
  }, 60_000);
});
