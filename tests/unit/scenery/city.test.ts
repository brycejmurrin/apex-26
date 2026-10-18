import { describe, expect, it } from "vitest";
import * as City from "../../../src/track/scenery/city";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

// SceneryCity port vs f1-game js/track/scenery/city.js: swap the kit into
// f1-game's own build (engine held fixed) and compare every digest.
const CIRCUITS = ["monaco", "vegas", "singapore", "baku", "bahrain", "anderstorp", "jeddah", "monza"];

describe.skipIf(!haveF1)("SceneryCity vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const swap = (create: typeof City.create) => ({
    SceneryCity: { ...City, create: (ctx: City.CityCtx) => create(ctx, f1!.core) },
  });

  it.each(CIRCUITS)("%s builds identically with the port", (id) => {
    const base = f1!.build(id);
    expect(diffDigests(base, f1!.build(id, swap(City.create)))).toEqual([]);
  }, 300_000);

  it("a one-ulp change in a cityFront wall colour is detected (vegas)", () => {
    const base = f1!.build("vegas");
    const bumped = f1!.build("vegas", swap((ctx, core) => {
      const api = City.create(ctx, core);
      return {
        ...api,
        cityFront: (s0, s1, side, gap, opts) =>
          api.cityFront(s0, s1, side, gap, { ...opts, palette: [[0.6, 0.62, 0.66 + Number.EPSILON]] }),
      };
    }));
    expect(diffDigests(base, bumped).length).toBeGreaterThan(0);
  }, 300_000);
});
