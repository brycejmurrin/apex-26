import { describe, expect, it } from "vitest";
import * as L from "../../../src/data/legends";
import { f1Global, hasF1, plain } from "./f1-vm";
import { parity } from "./parity";

describe("legends (spot values from f1-game js/data/legends.js)", () => {
  it("derives ratings from the record", () => {
    expect(L.ratings("SEN")).toEqual({ pace: 93, craft: 89, awareness: 92, consistency: 92, experience: 92 });
    expect(L.ratings("fangio")).toEqual({ pace: 99, craft: 99, awareness: 97, consistency: 97, experience: 86 });
    expect(L.ratings("nobody")).toBe(null);
  });

  it("builds the player's team and a rival's", () => {
    const t = L.team("fangio")!;
    expect(t).toMatchObject({ id: "legends", legends: true, legend: "fangio", tier: 0, crest: "mercedes", engine: "Mercedes-Benz W196" });
    expect(t.stats).toEqual({ speed: 99, accel: 99, cornering: 98, braking: 97 });
    expect("name" in t.livery && t.livery["name"] === undefined).toBe(true);
    expect(t.drivers.length).toBe(12);
    expect(t.factory?.suspension).toBe("torsion_bar");
    const r = L.raceTeam("MAN")!;
    expect(r.id).toBe("legend_mansell");
    expect(r.drivers).toEqual([{ name: "Nigel Mansell", code: "MAN", num: 5 }]);
    expect([r.tier, r.crest]).toEqual([3, "williams"]);
    expect(L.raceTeam("nobody")).toBe(null);
    expect(L.LIST.map((l) => `${l.code}:${L.team(l.id)!.tier}`).join(" "))
      .toBe("MSC:1 SEN:1 FAN:0 CLK:1 LAU:3 PRO:2 STE:2 MOS:2 GHL:3 HAK:3 VET:2 MAN:3");
  });

  it("seats, parts and liveries", () => {
    expect(L.seatOf("SEN")).toBe(1);
    expect(L.seatOf("nope")).toBe(-1);
    expect(L.parts("moss")).toEqual({ ...L.PERIOD.front50, brakes: "drilled" });
    expect(L.parts("nope")).toBe(null);
    const lv = L.liveries();
    expect(lv.length).toBe(12);
    expect(lv[0]).toMatchObject({ id: "legend_schumacher", legend: "schumacher", name: "Maranello '04" });
    for (const era of Object.keys(L.PERIOD) as L.EraId[]) expect(L.ERA_YEAR[era]).toBeGreaterThan(1949);
  });
});

interface RefLegends {
  LIST: unknown[]; PERIOD: unknown; ERA_YEAR: unknown;
  ratings(k: string): unknown; ratingsFor(r: unknown): unknown; statsFor(r: unknown): unknown;
  team(k: string): Record<string, unknown> | null; raceTeam(k: string): unknown; parts(k: string): unknown;
  seatOf(k: string): number; liveries(): unknown; byId(k: string): unknown; byCode(k: string): unknown;
}

describe.skipIf(!hasF1)("legends vs f1-game in a VM", () => {
  const ref = (hasF1 ? f1Global(["js/data/legends.js"], "Legends") : null) as RefLegends;
  const keys = [...L.LIST.flatMap((l) => [l.id, l.code]), "nope", "", "constructor"];

  it("has the same data", () => {
    expect(plain(L.LIST)).toEqual(plain(ref.LIST));
    expect(plain(L.PERIOD)).toEqual(plain(ref.PERIOD));
    expect(plain(L.ERA_YEAR)).toEqual(plain(ref.ERA_YEAR));
  });

  it("every function matches for every id and code", () => {
    for (const k of keys) {
      expect(plain(L.ratings(k))).toEqual(plain(ref.ratings(k)));
      expect(plain(L.team(k))).toEqual(plain(ref.team(k)));
      expect(plain(L.raceTeam(k))).toEqual(plain(ref.raceTeam(k)));
      expect(plain(L.parts(k))).toEqual(plain(ref.parts(k)));
      expect(L.seatOf(k)).toBe(ref.seatOf(k));
      expect(plain(L.byId(k))).toEqual(plain(ref.byId(k)));
      expect(plain(L.byCode(k))).toEqual(plain(ref.byCode(k)));
      // The livery keeps f1-game's explicit `name: undefined` key (JSON drops it, so check the key set).
      const a = L.team(k), b = ref.team(k);
      if (a && b) expect(Object.keys(a.livery)).toEqual(Object.keys(b["livery"] as object));
    }
    for (const l of L.LIST) {
      const r = L.ratingsFor(l.record);
      expect(plain(r)).toEqual(plain(ref.ratingsFor(l.record)));
      expect(plain(L.statsFor(r))).toEqual(plain(ref.statsFor(r)));
    }
    expect(plain(L.liveries())).toEqual(plain(ref.liveries()));
  });
});

// CI has no f1-game: the same comparisons against committed reference outputs.
// team() is recorded raw (encode keeps the livery's explicit `name: undefined` key).
function legendsRecord(api: RefLegends): Record<string, unknown> {
  const keys = [...L.LIST.flatMap((l) => [l.id, l.code]), "nope", "", "constructor"];
  // [key, outputs] pairs: an own "constructor" key would trip toStrictEqual's type check.
  const per = keys.map((k) => [k, {
    ratings: plain(api.ratings(k)), team: api.team(k), raceTeam: plain(api.raceTeam(k)), parts: plain(api.parts(k)),
    seatOf: api.seatOf(k), byId: plain(api.byId(k)), byCode: plain(api.byCode(k)),
  }]);
  const derived = L.LIST.map((l) => { const r = api.ratingsFor(l.record); return { ratingsFor: plain(r), statsFor: plain(api.statsFor(r)) }; });
  return { LIST: plain(api.LIST), PERIOD: plain(api.PERIOD), ERA_YEAR: plain(api.ERA_YEAR), per, derived, liveries: plain(api.liveries()) };
}
parity("legends",
  () => legendsRecord(L as unknown as RefLegends),
  () => legendsRecord(f1Global(["js/data/legends.js"], "Legends") as RefLegends));
