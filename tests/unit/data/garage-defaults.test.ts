import { describe, expect, it } from "vitest";
import { GarageDefaults } from "../../../src/data/garage-defaults";
import { f1Global, hasF1, plain } from "./f1-vm";

describe("garage defaults (spot values from f1-game js/data/garage-defaults.js)", () => {
  it("answers listed keys", () => {
    expect(GarageDefaults.keys().length).toBe(38);
    expect(GarageDefaults.get("team")).toBe(3);
    expect(GarageDefaults.get("driver")).toBe(0);
    expect(GarageDefaults.get("livery.legends")).toBe("default");
    expect(GarageDefaults.meta().build).toBe("17179");
    expect(GarageDefaults.has("parts.legends")).toBe(true);
    expect(GarageDefaults.has("constructor")).toBe(false);
    expect(GarageDefaults.get("constructor")).toBe(undefined);
    expect(GarageDefaults.get("nope")).toBe(undefined);
  });

  it("never hands out the shipped table", () => {
    const p = GarageDefaults.get("parts.alpine") as Record<string, string>;
    p["engine"] = "mine";
    expect((GarageDefaults.get("parts.alpine") as Record<string, string>)["engine"]).toBe("sig_alpine_pu");
    const f = GarageDefaults.file();
    const rows = f.garage["livery.custom.alpine"] as { c1: number[] }[];
    rows[0]!.c1[0] = 9;
    expect((GarageDefaults.file().garage["livery.custom.alpine"] as { c1: number[] }[])[0]!.c1[0]).toBe(0);
    expect(f).toMatchObject({ format: "apex26-garage-v1", count: 38, build: "17179" });
  });
});

interface RefGarage { keys(): string[]; get(k: string): unknown; has(k: string): boolean; meta(): unknown; file(): unknown }

describe.skipIf(!hasF1)("garage defaults vs f1-game in a VM", () => {
  const ref = (hasF1 ? f1Global(["js/data/garage-defaults.js"], "GarageDefaults") : null) as RefGarage;
  it("matches key for key", () => {
    expect(GarageDefaults.keys()).toEqual(plain(ref.keys()));
    for (const k of ref.keys()) {
      expect(GarageDefaults.has(k)).toBe(true);
      expect(plain(GarageDefaults.get(k))).toEqual(plain(ref.get(k)));
    }
    for (const k of ["nope", "parts.custom", "livery."]) expect(GarageDefaults.has(k)).toBe(ref.has(k));
    expect(plain(GarageDefaults.meta())).toEqual(plain(ref.meta()));
    expect(plain(GarageDefaults.file())).toEqual(plain(ref.file()));
  });
});
