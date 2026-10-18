/**
 * Parity for the 52 codemodded circuit scenery closures (src/circuits/scenery/):
 * each circuit built in f1-game's engine with its `TrackScenery[id]` closure
 * swapped for the TS module must be bit-identical to f1-game's own build.
 * Runs a representative subset by default; F1_SWEEP=1 runs all 52 (~4 min).
 */
import { describe, expect, it } from "vitest";
import { SCENERY } from "../../../src/circuits/scenery";
import type { SceneryApi } from "../../../src/contracts/scenery";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

const SUBSET = ["monza", "monaco", "silverstone", "shanghai", "miami", "spa"];
const IDS = process.env["F1_SWEEP"] ? Object.keys(SCENERY) : SUBSET;

describe.skipIf(!haveF1)("circuit scenery closures vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;

  it("covers every f1-game circuit", () => {
    const ref = f1!.global<Record<string, unknown>>("TrackScenery");
    expect(Object.keys(SCENERY).sort()).toEqual(Object.keys(ref).sort());
  });

  it("a dropped closure is detected (negative control)", () => {
    const ref = f1!.global<Record<string, unknown>>("TrackScenery");
    const base = f1!.build("monza");
    expect(diffDigests(base, f1!.build("monza", { TrackScenery: { ...ref, monza: () => {} } }))).toContain("propsGeo");
  }, 120_000);

  it.each(IDS)("%s builds bit-identical", async (id) => {
    const load = SCENERY[id];
    if (!load) throw new Error(`no closure for ${id}`);
    const closure = (await load()).default;
    const { geom, space, pit } = f1!.core;
    const ref = f1!.global<Record<string, unknown>>("TrackScenery");
    const base = f1!.build(id);
    const swapped = f1!.build(id, {
      TrackScenery: { ...ref, [id]: (api: SceneryApi) => closure(api, { geom, space, pit }) },
    });
    expect(diffDigests(base, swapped)).toEqual([]);
  }, 120_000);
});
