import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CIRCUIT_IDS } from "../../../src/circuits";
import * as Lore from "../../../src/data/circuit-lore";
import * as Flyby from "../../../src/data/flyby-overrides";
import { SettingsDefaults } from "../../../src/data/settings-defaults";
import { countsByDriver, driverColor } from "../../../src/data/tab-utils";
import * as Teams from "../../../src/data/teams";

const F1 = "/home/f1-game/js/data/";
const hasF1 = existsSync(F1 + "teams.js");

/** Evaluate an f1-game IIFE module in a VM and return its named global. */
function f1Global(file: string, name: string): unknown {
  const ctx: Record<string, unknown> = { window: {} };
  runInNewContext(readFileSync(F1 + file, "utf8") + `\n;globalThis.__out = typeof ${name} !== "undefined" ? ${name} : window.${name};`, ctx);
  return ctx.__out;
}

describe("teams", () => {
  it("is the verified 2026 grid", () => {
    expect(Teams.LIST.length).toBe(11);
    expect(Teams.LIST.flatMap((t) => t.drivers).length).toBe(22);
    expect(new Set(Teams.LIST.map((t) => t.short)).size).toBe(11);
    expect(Teams.POINTS).toEqual([25, 18, 15, 12, 10, 8, 6, 4, 2, 1]);
    expect(Teams.isReal(Teams.LIST[0])).toBe(true);
    expect(Teams.isReal(Teams.DEFAULT_CUSTOM)).toBe(false);
  });

  it.skipIf(!hasF1)("matches f1-game's Teams data exactly", () => {
    const ref = JSON.parse(JSON.stringify(f1Global("teams.js", "Teams"))) as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(Teams.LIST))).toEqual(ref.LIST);
    expect([...Teams.TIER_V]).toEqual(ref.TIER_V);
    expect(JSON.parse(JSON.stringify(Teams.DEFAULT_CUSTOM))).toEqual(ref.DEFAULT_CUSTOM);
  });

  it("repairs a hostile custom team field by field", () => {
    const t = Teams.sanitizeCustom({
      id: "x", name: "‮Evil\u0007 Team Name That Is Far Too Long", short: "abcdef", tier: 9,
      color: [2, -1, 0.5], color2: "red", stats: { speed: 150, accel: "x" },
      livery: { finShape: "constructor", spineLogo: "cap", cover: [0.1, 0.2, 0.3], bad: { nested: 1 } },
      drivers: [{ name: "A", code: "abcd", num: 120.4 }, { name: "B" }, { name: "C" }],
    });
    expect(t).toMatchObject({ id: "custom", custom: true, name: "Evil Team Name That Is", short: "ABCD", tier: 2 });
    expect(t.color).toEqual([1, 0, 0.5]);
    expect(t.color2).toEqual(Teams.DEFAULT_CUSTOM.color2);
    expect(t.stats).toEqual({ speed: 100, accel: 82, cornering: 83, braking: 81 });
    expect(t.livery).toEqual({ spineLogo: "cap", cover: [0.1, 0.2, 0.3] });
    expect(t.drivers).toEqual([{ name: "A", code: "ABC", num: 99 }, { name: "B", code: "YOU", num: 99 }]);
  });

  it("checks livery enums against the car lane's id tables", () => {
    expect(Teams.liveryEnumOk("finShape", "anything")).toBe(true);
    const deps = { Car3D: { FIN_SHAPE_IDS: ["none", "stepped"] } };
    expect(Teams.liveryEnumOk("finShape", "anything", deps)).toBe(false);
    expect(Teams.liveryEnumOk("finShape", "stepped", deps)).toBe(true);
    expect(Teams.liveryEnumOk("spineLogo", "toString")).toBe(false);
  });
});

describe("settings defaults", () => {
  it("answers listed keys only", () => {
    expect(SettingsDefaults.get("difficulty")).toBe("hard");
    expect(SettingsDefaults.has("steerRate")).toBe(false);
    expect(SettingsDefaults.has("toString")).toBe(false);
  });
  it.skipIf(!hasF1)("matches f1-game", () => {
    const ref = f1Global("settings-defaults.js", "SettingsDefaults") as { keys(): string[]; get(k: string): unknown };
    expect(SettingsDefaults.keys()).toEqual(ref.keys());
    for (const k of ref.keys()) expect(SettingsDefaults.get(k)).toBe(ref.get(k));
  });
});

describe("circuit lore", () => {
  it("has exactly one entry per circuit id, both ways", () => {
    expect([...Lore.ids()].sort()).toEqual([...CIRCUIT_IDS].sort());
    expect(Lore.forId("spa")?.line).toMatch(/Spa/);
    expect(Lore.forId("constructor")).toBe(null);
  });
  it("follows the writing rules: one sentence, no GP, no ALL-CAPS", () => {
    for (const id of Lore.ids()) {
      for (const s of Object.values(Lore.forId(id)!)) {
        expect(s).toMatch(/[.!?]$/);
        expect(s).not.toMatch(/\bGP\b/);
        expect(s).not.toMatch(/\b[A-Z]{2,}\b/);
      }
    }
  });
});

describe("flyby overrides", () => {
  const defaults = [{ id: "turn-mid", fov: [50, 50] }, { id: "start", fov: [40, 40] }];
  it("layers a circuit patch without mutating sources", () => {
    const out = Flyby.resolve("monaco", defaults);
    expect(out[0]!.fov).toEqual([34, 38]);
    expect(out[1]).toBe(defaults[1]);
    expect(defaults[0]!.fov).toEqual([50, 50]);
    expect(Flyby.resolve("monza", defaults)).toBe(defaults);
    const saved = [{ id: "mine" }];
    expect(Flyby.resolve("monaco", defaults, saved)).toBe(saved);
  });
});

describe("tab utils", () => {
  it("prefers OpenF1's hex colour, then the team, then the fallback", () => {
    const find = (t: string | null | undefined) => (t === "McLaren" ? { color: [1, 0.5, 0] as Teams.Rgb } : null);
    expect(driverColor({ color: "FF0000", team: "McLaren" }, find, null)).toEqual([1, 0, 0]);
    expect(driverColor({ color: "#FF0000", team: "McLaren" }, find, null)).toEqual([1, 0.5, 0]);
    expect(driverColor({ team: "Nope" }, find, "gray")).toBe("gray");
    expect(countsByDriver([{ d: { num: 1 } }, { d: { num: 1 } }, { d: { num: 4 } }])).toEqual({ 1: 2, 4: 1 });
  });
});
