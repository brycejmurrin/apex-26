import { describe, expect, it } from "vitest";
import * as GuardsPort from "../../../src/track/scenery/guards";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

// The guards run on every circuit; a spread of street, permanent, night and
// pit-heavy layouts.
const CIRCUITS = ["monza", "monaco", "vegas", "spa", "bahrain", "singapore", "zandvoort", "suzuka"];

describe.skipIf(!haveF1)("SceneryGuards port vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;

  it.each(CIRCUITS)("%s builds identically with the port swapped in", (id) => {
    const base = f1!.build(id);
    const swapped = f1!.build(id, { SceneryGuards: GuardsPort });
    expect(diffDigests(base, swapped)).toEqual([]);
  }, 300_000);

  it("negative control: a wider road margin is detected (monza)", () => {
    const base = f1!.build("monza");
    const bumped = f1!.build("monza", {
      SceneryGuards: {
        create: (ctx: GuardsPort.GuardsCtx) => {
          const g = GuardsPort.create(ctx);
          return { ...g, onTrack: (x: number, z: number, m: number, pm?: number) => g.onTrack(x, z, m + 0.5, pm) };
        },
      },
    });
    expect(diffDigests(base, bumped).length).toBeGreaterThan(0);
  }, 300_000);
});
