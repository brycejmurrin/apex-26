import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOM, LIST, POINTS, TIER_V, Teams, isReal, liveryEnumOk, sanitizeCustom,
} from "../../src/car/teams";
import type { LiveryEnumDeps, Team } from "../../src/car/teams";
import { haveF1, inF1, loadF1, plain } from "./car-f1-vm";

describe("teams: the 2026 grid", () => {
  it("has 11 teams with unique ids and shorts", () => {
    expect(LIST).toHaveLength(11);
    expect(new Set(LIST.map((t) => t.id)).size).toBe(11);
    expect(new Set(LIST.map((t) => t.short)).size).toBe(11);
  });

  it("seats 22 drivers, two per team, with unique numbers and codes", () => {
    const drivers = LIST.flatMap((t) => t.drivers);
    for (const t of LIST) expect(t.drivers, t.id).toHaveLength(2);
    expect(drivers).toHaveLength(22);
    expect(new Set(drivers.map((d) => d.num)).size).toBe(22);
    expect(new Set(drivers.map((d) => d.code)).size).toBe(22);
    for (const d of drivers) {
      expect(d.code).toMatch(/^[A-Z]{3}$/);
      expect(Number.isInteger(d.num) && d.num >= 0 && d.num <= 99).toBe(true);
    }
    expect(drivers.find((d) => d.num === 1)?.code).toBe("NOR");
  });

  it("keeps colours in 0..1 and tiers on the TIER_V ladder", () => {
    for (const t of [...LIST, DEFAULT_CUSTOM]) {
      for (const c of [t.color, t.color2]) {
        expect(c, t.id).toHaveLength(3);
        for (const x of c) expect(x >= 0 && x <= 1, t.id).toBe(true);
      }
      expect(TIER_V[t.tier], t.id).toBeTypeOf("number");
    }
  });

  it("scores the top ten, no fastest-lap point", () => {
    expect([...POINTS]).toEqual([25, 18, 15, 12, 10, 8, 6, 4, 2, 1]);
    expect(TIER_V).toHaveLength(5);
    for (let i = 1; i < TIER_V.length; i++) expect(TIER_V[i]! < TIER_V[i - 1]!).toBe(true);
  });

  it("freezes the Teams record with f1-game's seven members", () => {
    expect(Object.isFrozen(Teams)).toBe(true);
    expect(Object.keys(Teams)).toEqual(["LIST", "POINTS", "TIER_V", "DEFAULT_CUSTOM", "isReal", "sanitizeCustom", "liveryEnumOk"]);
    expect(Teams.LIST).toBe(LIST);
  });

  it("isReal excludes the MY TEAM and LEGENDS entries", () => {
    expect(LIST.every(isReal)).toBe(true);
    expect(isReal(DEFAULT_CUSTOM)).toBe(false);
    expect(isReal({ legends: true })).toBe(false);
    expect(isReal(null)).toBe(false);
    expect(isReal(undefined)).toBe(false);
  });

  it("sanitizeCustom repairs bad fields and keeps good ones", () => {
    const t = sanitizeCustom({
      name: "  Evil‮ Team\u0007 Name That Is Far Too Long  ", short: "abcdef", tier: 9,
      color: [2, -1, 0.5], color2: "red", stats: { speed: 150, accel: -3 },
      livery: { finShape: "constructor", spineLogo: "cap", fin: [0.1, 0.2, 0.3] },
      drivers: [{ name: "A", code: "abcd", num: 123.6 }, 7, { num: -4 }, { name: "Z" }],
    });
    expect(t.name).toBe("Evil Team Name That Is");
    expect(t.short).toBe("ABCD");
    expect(t.tier).toBe(2);
    expect(t.color).toEqual([1, 0, 0.5]);
    expect(t.color2).toEqual(DEFAULT_CUSTOM.color2);
    expect(t.stats).toEqual({ speed: 100, accel: 0, cornering: 83, braking: 81 });
    expect(t.livery).toEqual({ spineLogo: "cap", fin: [0.1, 0.2, 0.3] });
    expect(t.drivers).toEqual([{ name: "A", code: "ABC", num: 99 }, { name: "Your Name", code: "YOU", num: 0 }]);
    expect(sanitizeCustom(undefined)).toEqual({ ...DEFAULT_CUSTOM });
  });

  it("liveryEnumOk honours the id tables only when they are given", () => {
    expect(liveryEnumOk("finShape", "anything")).toBe(true);
    expect(liveryEnumOk("finShape", "toString")).toBe(false);
    expect(liveryEnumOk("finShape", 3)).toBe(false);
    const deps: LiveryEnumDeps = { Car3D: { FIN_SHAPE_IDS: ["standard", "none"] } };
    expect(liveryEnumOk("finShape", "none", deps)).toBe(true);
    expect(liveryEnumOk("finShape", "swept", deps)).toBe(false);
    expect(liveryEnumOk("finish", "swept", deps)).toBe(true); // no FINISH_SURFACE: unchecked
  });
});

// ---- Round trip against f1-game, loaded in a VM. Skipped where it is absent. ----

const ENUM_DEPS: LiveryEnumDeps = {
  Car3D: { FIN_SHAPE_IDS: ["standard", "swept", "stub", "stepped", "none"], FINISH_SURFACE: { satin: 1, chrome: 2, matte: 3 } },
  LiveryTex: { NUM_FONT_IDS: ["default", "stencil", "script"] },
};
const DEP_VARIANTS: [string, LiveryEnumDeps | undefined][] = [
  ["no deps", undefined],
  ["full deps", ENUM_DEPS],
  ["Car3D without tables", { Car3D: {} }],
  ["LiveryTex only", { LiveryTex: ENUM_DEPS.LiveryTex! }],
];

function sanitizeInputs(): unknown[] {
  const bidi = "‎‏‪‫‬‭‮⁦⁧⁨⁩";
  return [
    undefined, null, 0, "team", [], {}, [DEFAULT_CUSTOM],
    plain(DEFAULT_CUSTOM),
    ...LIST.map((t) => plain(t)),
    { name: `  ${bidi}Bidi\u0000\u001f\u007f\u009f Name  `, short: " x ", engine: "E".repeat(40) },
    { name: "x".repeat(30) + "   ", short: "\u0001\u0002", engine: 5 },
    { name: "   ", short: "ab", tier: 0 }, { tier: 4 }, { tier: 5 }, { tier: -1 }, { tier: 2.5 }, { tier: "2" }, { tier: NaN },
    { color: [0.1, 0.2] }, { color: [0.1, 0.2, NaN] }, { color: [-0.5, 1.5, 0.25, 9] }, { color: [Infinity, 0, 0] }, { color2: "nope" },
    { stats: { speed: 101, accel: -1, cornering: 50.5, braking: "90" } }, { stats: [1, 2, 3] }, { stats: null },
    { drivers: [] }, { drivers: "x" }, { drivers: [null, 1, "a"] },
    { drivers: [{ name: "Ayrton Senna da Silva Junior", code: "sennas", num: 12.5 }] },
    { drivers: [{ num: 150 }, { num: -10 }, { num: 7 }] },
    { drivers: [{ name: 3, code: null, num: "5" }, { name: "B", code: "b", num: Infinity }] },
    { livery: null }, { livery: [] }, { livery: "x" },
    { livery: { finShape: "swept", numFont: "stencil", finish: "satin", spineLogo: "  cap  ", spineSide: "" } },
    { livery: { finShape: "bogus", numFont: "bogus", finish: "gloss", sponsors: "constructor", coverVents: "hasOwnProperty" } },
    { livery: { finish: "chrome", finStyle: "x".repeat(40), cover: [0.5, 2, -1], fin: [1, 2], pod: [1, 2, 3, 4], nose: [NaN, 0, 0], halo: { r: 1 }, tier: 3 } },
    JSON.parse('{"livery":{"__proto__":"x","finShape":"none","wing":[0.1,0.1,0.1]}}') as unknown,
    JSON.parse('{"__proto__":{"name":"proto"},"name":"own"}') as unknown,
  ];
}

describe.skipIf(!haveF1)("teams round trip vs f1-game", () => {
  const ctx = haveF1 ? loadF1(["js/data/teams.js"]) : null;
  type F1Teams = typeof Teams;
  const f1 = (): F1Teams => inF1<{ Teams: F1Teams }>(ctx!, "({ Teams })").Teams;

  it("exports the same members", () => {
    expect(Object.keys(Teams)).toEqual(Object.keys(f1()));
    expect(Object.isFrozen(f1())).toBe(true);
  });

  it("deep-equals every table", () => {
    expect(LIST).toEqual(plain(f1().LIST));
    expect([...POINTS]).toEqual(plain(f1().POINTS));
    expect([...TIER_V]).toEqual(plain(f1().TIER_V));
    expect(DEFAULT_CUSTOM).toEqual(plain(f1().DEFAULT_CUSTOM));
    // Key order too, so a JSON export of either reads the same.
    expect(JSON.stringify(LIST)).toBe(JSON.stringify(f1().LIST));
    expect(JSON.stringify(DEFAULT_CUSTOM)).toBe(JSON.stringify(f1().DEFAULT_CUSTOM));
  });

  it("isReal agrees", () => {
    const xs: unknown[] = [null, undefined, 0, "", {}, { custom: true }, { legends: true }, { custom: false, legends: 0 }, { custom: 1 }, ...LIST, DEFAULT_CUSTOM];
    for (const x of xs) expect(isReal(x as Team), JSON.stringify(x)).toBe(f1().isReal(x as Team));
  });

  it("sanitizeCustom agrees on a spread of inputs", () => {
    for (const x of sanitizeInputs()) {
      const ours = JSON.stringify(sanitizeCustom(x));
      expect(ours, JSON.stringify(x)).toBe(JSON.stringify(f1().sanitizeCustom(x)));
    }
  });

  for (const [label, deps] of DEP_VARIANTS) {
    it(`liveryEnumOk and sanitizeCustom agree with ${label}`, () => {
      const g: Record<string, unknown> = {};
      if (deps?.Car3D) g["Car3D"] = deps.Car3D;
      if (deps?.LiveryTex) g["LiveryTex"] = deps.LiveryTex;
      const c = loadF1(["js/data/teams.js"], g);
      const theirs = inF1<{ Teams: F1Teams }>(c, "({ Teams })").Teams;
      const keys = ["finShape", "numFont", "finish", "spineLogo", "sponsors", "__proto__"];
      const vals: unknown[] = ["standard", "swept", "none", "stencil", "default", "gloss", "satin", "chrome", "bogus",
        "", "constructor", "toString", "__proto__", "valueOf", 1, null, undefined, ["none"]];
      for (const k of keys) for (const v of vals) {
        expect(liveryEnumOk(k, v, deps), `${k}=${String(v)}`).toBe(theirs.liveryEnumOk(k, v));
      }
      for (const x of sanitizeInputs()) {
        expect(JSON.stringify(sanitizeCustom(x, deps)), JSON.stringify(x)).toBe(JSON.stringify(theirs.sanitizeCustom(x)));
      }
    });
  }
});
