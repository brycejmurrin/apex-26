import { describe, expect, it } from "vitest";
import * as Pits from "../../../src/track/scenery/pits";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

// SceneryPits port vs f1-game js/track/scenery/pits.js: swap the kit into
// f1-game's own build (engine held fixed) and compare every digest.
// silverstone carries the folded architecture roof (`roofProfile`).
const CIRCUITS = ["monza", "monaco", "silverstone", "spa", "bahrain", "singapore", "zandvoort", "suzuka"];

describe.skipIf(!haveF1)("SceneryPits vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const swap = (build: typeof Pits.build) => ({
    SceneryPits: { ...Pits, build: (ctx: Pits.PitsCtx) => build(ctx, f1!.core) },
  });

  it("the VM injects GarageScene through core, so bays are really built", () => {
    expect(f1!.core.garage).not.toBeNull();
    expect(typeof f1!.core.garage!.buildStatic).toBe("function");
  });

  it.each(CIRCUITS)("%s builds identically with the port", (id) => {
    const base = f1!.build(id);
    expect(diffDigests(base, f1!.build(id, swap(Pits.build)))).toEqual([]);
    expect(Pits.bayCacheSize()).toBeGreaterThan(0);
  }, 300_000);

  it("flipping night on the pit kit alone is detected (monza)", () => {
    const base = f1!.build("monza");
    const changed = f1!.build("monza", swap((ctx, core) => Pits.build({ ...ctx, night: !ctx.night }, core)));
    expect(diffDigests(base, changed)).toContain("propsGeo");
  }, 300_000);
});
