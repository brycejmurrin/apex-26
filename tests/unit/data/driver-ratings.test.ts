import { describe, expect, it } from "vitest";
import * as DR from "../../../src/data/driver-ratings";
import { LIST } from "../../../src/data/teams";
import { f1Global, hasF1 } from "./f1-vm";
import { parity } from "./parity";

describe("driver ratings (spot values from f1-game js/data/driver-ratings.js)", () => {
  it("reads authored rows", () => {
    expect(DR.get("VER")).toEqual({ pace: 96, craft: 96, awareness: 92, consistency: 94, experience: 92, aggression: 30, optimism: 24 });
    expect(DR.overall(DR.get("VER"))).toBe(95);
    expect(DR.overall(DR.get("FER2"))).toBe(84);
    expect(DR.get("FER2", 4)).toEqual(DR.get("FER2", 0));   // HIRES do not depend on the caller's tier
    expect(DR.get("FER2").aggression).toBe(0);
    expect(DR.overall(null)).toBe(0);
  });

  it("falls back to the tier anchor and the code hash", () => {
    expect(DR.fromTier(2, "XYZ")).toEqual({ pace: 75, craft: 73, awareness: 73, consistency: 84, experience: 61, aggression: -8, optimism: -14 });
    expect(DR.fromTier(undefined, "")).toEqual({ pace: 90, craft: 94, awareness: 89, consistency: 91, experience: 71, aggression: -9, optimism: -9 });
    expect(DR.hash32("VER")).toBe(3305799586);
    const c = DR.get("constructor", 2);
    expect(Number.isFinite(c.pace)).toBe(true);
    expect(c).toEqual(DR.fromTier(2, "constructor"));
  });

  it("applies only finite numeric deltas, clamped per axis kind", () => {
    expect(DR.get("HAM", 0, { pace: 20, craft: "5", awareness: Infinity, aggression: -10 }))
      .toEqual({ pace: 100, craft: 95, awareness: 88, consistency: 88, experience: 100, aggression: -30, optimism: -24 });
  });

  it("skill, style01 and buildPace", () => {
    expect(DR.skill(DR.get("NOR"), 0.9)).toBe(0.9702148);
    expect(DR.skill(DR.get("STR"), 0.1)).toBe(0.9650133599999999);
    expect(DR.style01(-45)).toBe(-1);
    expect(DR.style01(undefined)).toBe(0);
    expect(DR.buildPace({ mods: { speed: 1.1, accel: 0 } }, { mods: { speed: 1, cornering: 2 } })).toBe((1.1 / 1 + 1 / 1 + 1 / 2 + 1 / 1) / 4);
  });

  it("rates every 2026 grid driver from an authored row, style columns zero-mean", () => {
    for (const t of LIST) for (const d of t.drivers) expect(Object.hasOwn(DR.BASE, d.code)).toBe(true);
    const rows = Object.values(DR.BASE);
    expect(rows.reduce((s, r) => s + (r[5] ?? 0), 0)).toBe(0);
    expect(rows.reduce((s, r) => s + (r[6] ?? 0), 0)).toBe(0);
  });
});

interface RefDR {
  AXES: string[]; STYLE_AXES: string[]; STYLE_SCALE: number; SKILL_BASE: number; SKILL_SPAN: number; SKILL_JITTER: number;
  BASE: Record<string, number[]>; HIRES: Record<string, number[]>;
  get(code: string, tier?: unknown, deltas?: unknown): Record<string, number>;
  fromTier(tier: unknown, code: unknown): Record<string, number>;
  overall(r: unknown): number;
  skill(r: unknown, roll: number): number;
  style01(v: unknown): number;
  buildPace(a: unknown, b: unknown): number;
  hash32(s: string): number;
}

describe.skipIf(!hasF1)("driver ratings vs f1-game in a VM", () => {
  const ref = (hasF1 ? f1Global(["js/data/driver-ratings.js"], "DriverRatings") : null) as RefDR;
  const known = [...Object.keys(DR.BASE), ...Object.keys(DR.HIRES)];
  const unknown = ["", "XYZ", "YOU", "ABC", "constructor", "__proto__", "toString", "ÜBR", "Q", "LONGCODE", "a26"];
  for (let i = 0; i < 200; i++) unknown.push(String.fromCharCode(65 + (i % 26), 65 + ((i * 7) % 26), 65 + ((i * 13) % 26)) + i);
  const tiers = [undefined, null, 0, 1, 2, 3, 4, 5, -1, 2.7, NaN];

  it("has the same tables", () => {
    expect([...DR.AXES]).toEqual([...ref.AXES]);
    expect([...DR.STYLE_AXES]).toEqual([...ref.STYLE_AXES]);
    expect([DR.STYLE_SCALE, DR.SKILL_BASE, DR.SKILL_SPAN, DR.SKILL_JITTER]).toEqual([ref.STYLE_SCALE, ref.SKILL_BASE, ref.SKILL_SPAN, ref.SKILL_JITTER]);
    expect(Object.keys(DR.BASE)).toEqual(Object.keys(ref.BASE));
    for (const k of Object.keys(ref.BASE)) expect([...DR.BASE[k]!]).toEqual([...ref.BASE[k]!]);
    expect(Object.keys(DR.HIRES)).toEqual(Object.keys(ref.HIRES));
    for (const k of Object.keys(ref.HIRES)) expect([...DR.HIRES[k]!]).toEqual([...ref.HIRES[k]!]);
  });

  it("get/fromTier/overall match for every code and tier", () => {
    for (const code of [...known, ...unknown]) {
      for (const tier of tiers) {
        const a = DR.get(code, tier as number | null | undefined);
        const b = ref.get(code, tier);
        expect({ ...a }).toEqual({ ...b });
        expect(DR.overall(a)).toBe(ref.overall(b));
        expect({ ...DR.fromTier(tier as number | null | undefined, code) }).toEqual({ ...ref.fromTier(tier, code) });
      }
      expect(DR.hash32(code)).toBe(ref.hash32(code));
    }
  });

  it("deltas match", () => {
    const sets = [
      { pace: 3, craft: -2.5 }, { pace: "5", experience: Infinity, awareness: NaN },
      { consistency: 200, aggression: 7, optimism: -99 }, { bogus: 4 }, {},
    ];
    for (const code of ["VER", "STR", "FER2", "XYZ"]) {
      for (const d of sets) expect({ ...DR.get(code, 2, d) }).toEqual({ ...ref.get(code, 2, d) });
    }
  });

  it("skill is bit-exact for every rated driver and roll", () => {
    for (const code of [...known, ...unknown.slice(0, 20)]) {
      const r = DR.get(code, 3);
      for (const roll of [0, 0.1, 0.25, 0.5, 0.731, 0.9, 0.999999]) expect(Object.is(DR.skill(r, roll), ref.skill(r, roll))).toBe(true);
    }
  });

  it("style01 and buildPace match", () => {
    for (const v of [undefined, null, -45, -30, -7, 0, 12, 30, 31]) expect(DR.style01(v)).toBe(ref.style01(v));
    const a = { mods: { speed: 1.04, accel: 0.97, cornering: 1.01 } };
    const b = { mods: { speed: 1.02, accel: 1.0, braking: 0.99 } };
    expect(Object.is(DR.buildPace(a, b), ref.buildPace(a, b))).toBe(true);
  });
});

// CI has no f1-game: the VM comparisons above on a representative sample,
// against committed reference outputs (tests/fixtures/data/parity/driver-ratings.json).
type DRApi = Pick<RefDR, "get" | "fromTier" | "overall" | "skill" | "style01" | "buildPace" | "hash32">;
type DRTables = Pick<RefDR, "AXES" | "STYLE_AXES" | "STYLE_SCALE" | "SKILL_BASE" | "SKILL_SPAN" | "SKILL_JITTER" | "BASE" | "HIRES">;
function drRecord(api: DRApi, tables: DRTables): Record<string, unknown> {
  const known = [...Object.keys(DR.BASE), ...Object.keys(DR.HIRES)];
  const unknown = ["", "XYZ", "YOU", "ABC", "constructor", "__proto__", "toString", "ÜBR", "Q", "LONGCODE", "a26"];
  for (let i = 0; i < 200; i += 20) unknown.push(String.fromCharCode(65 + (i % 26), 65 + ((i * 7) % 26), 65 + ((i * 13) % 26)) + i);
  const tiers = [undefined, null, 0, 1, 2, 3, 4, 5, -1, 2.7, NaN];
  // Entry lists: bare codes such as "constructor" and "__proto__" must not become object keys
  // ("__proto__" assigns the prototype; an own "constructor" trips toStrictEqual's type check).
  const get: [string, unknown][] = [], overall: [string, number][] = [], fromTier: [string, unknown][] = [], hash: [string, number][] = [];
  for (const code of [...known, ...unknown]) {
    for (const tier of tiers) {
      const k = `${code}|${String(tier)}`, r = api.get(code, tier);
      get.push([k, { ...r }]); overall.push([k, api.overall(r)]);
      // fromTier never reads the authored rows: a few known codes are enough.
      if (!Object.hasOwn(DR.BASE, code) || known.indexOf(code) < 4) fromTier.push([k, { ...api.fromTier(tier, code) }]);
    }
    hash.push([code, api.hash32(code)]);
  }
  const sets = [
    { pace: 3, craft: -2.5 }, { pace: "5", experience: Infinity, awareness: NaN },
    { consistency: 200, aggression: 7, optimism: -99 }, { bogus: 4 }, {},
  ];
  const deltas: unknown[] = [];
  for (const code of ["VER", "STR", "FER2", "XYZ"]) for (const d of sets) deltas.push({ ...api.get(code, 2, d) });
  const skill = [...known, ...unknown.slice(0, 8)].map((code) => {
    const r = api.get(code, 3);
    return [code, [0, 0.1, 0.25, 0.5, 0.731, 0.9, 0.999999].map((roll) => api.skill(r, roll))];
  });
  const a = { mods: { speed: 1.04, accel: 0.97, cornering: 1.01 } };
  const b = { mods: { speed: 1.02, accel: 1.0, braking: 0.99 } };
  return {
    tables: {
      AXES: [...tables.AXES], STYLE_AXES: [...tables.STYLE_AXES],
      scalars: [tables.STYLE_SCALE, tables.SKILL_BASE, tables.SKILL_SPAN, tables.SKILL_JITTER],
      BASE: Object.fromEntries(Object.keys(tables.BASE).map((k) => [k, [...tables.BASE[k]!]])),
      HIRES: Object.fromEntries(Object.keys(tables.HIRES).map((k) => [k, [...tables.HIRES[k]!]])),
      baseOrder: Object.keys(tables.BASE), hiresOrder: Object.keys(tables.HIRES),
    },
    get: Object.fromEntries(get), overall: Object.fromEntries(overall), fromTier: Object.fromEntries(fromTier), hash, deltas, skill,
    style01: [undefined, null, -45, -30, -7, 0, 12, 30, 31].map((v) => api.style01(v)),
    buildPace: api.buildPace(a, b),
  };
}
parity("driver-ratings",
  () => drRecord(DR as unknown as DRApi, DR as unknown as DRTables),
  () => { const ref = f1Global(["js/data/driver-ratings.js"], "DriverRatings") as RefDR; return drRecord(ref, ref); });
