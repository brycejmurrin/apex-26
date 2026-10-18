import { describe, expect, it } from "vitest";
import type { SceneryCore } from "../../../src/track/scenery/core";
import * as VenuePort from "../../../src/track/scenery/venue";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

// SceneryVenue runs on every circuit (build-props.js:2057).
const CIRCUITS = ["monza", "monaco", "vegas", "spa", "bahrain", "singapore", "zandvoort", "suzuka"];

type Args = Parameters<typeof VenuePort.build>;

describe.skipIf(!haveF1)("SceneryVenue port vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const port = (core: SceneryCore = f1!.core) => ({
    build: (ctx: Args[0], theme: Args[1], excluded: Args[2]) => VenuePort.build(ctx, theme, excluded, core),
  });

  it.each(CIRCUITS)("%s builds identically with the port swapped in", (id) => {
    const base = f1!.build(id);
    const swapped = f1!.build(id, { SceneryVenue: port() });
    expect(diffDigests(base, swapped)).toEqual([]);
  }, 300_000);

  it("negative control: a shifted slot origin is detected (monza)", () => {
    const base = f1!.build("monza");
    const core = f1!.core;
    const space = { ...core.space, sceneryOriginDelta: () => 0.01 };
    const bumped = f1!.build("monza", { SceneryVenue: port({ ...core, space }) });
    expect(diffDigests(base, bumped).length).toBeGreaterThan(0);
  }, 300_000);
});
