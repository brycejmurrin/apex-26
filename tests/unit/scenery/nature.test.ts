import { describe, expect, it } from "vitest";
import * as Nature from "../../../src/track/scenery/nature";
import type { NatureCtx } from "../../../src/track/scenery/nature";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

// Circuits that exercise every nature emitter between them: forestEdge/pine/
// tree (monza, spa, suzuka), palms (bahrain, vegas, singapore), grandstands
// and spectator hills (zandvoort, okayama), ridges/mountains (spa, bahrain),
// lobed crowns and night crowds (singapore, vegas).
const CIRCUITS = ["monza", "monaco", "spa", "bahrain", "singapore", "zandvoort", "suzuka", "vegas", "okayama"];

describe.skipIf(!haveF1)("SceneryNature port vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const swap = (create: (ctx: NatureCtx) => unknown) => ({ SceneryNature: { ...Nature, create } });

  it("builds identically with the port swapped in", () => {
    for (const id of CIRCUITS) {
      const base = f1!.build(id);
      const swapped = f1!.build(id, swap((ctx) => Nature.create(ctx, f1!.core)));
      expect(diffDigests(base, swapped), id).toEqual([]);
    }
  }, 300_000);

  it("negative control: a perturbed canopyR is detected (monza)", () => {
    const base = f1!.build("monza");
    const bumped = f1!.build("monza", swap((ctx) => {
      const api = Nature.create(ctx, f1!.core);
      return { ...api, canopyR: (kind: string, h: number) => api.canopyR(kind, h) + 0.5 };
    }));
    expect(diffDigests(base, bumped).length).toBeGreaterThan(0);
  }, 60_000);
});
