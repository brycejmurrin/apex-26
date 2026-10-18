/**
 * End-to-end TS scenery: f1-game's engine builds the track, and EVERYTHING the
 * props pass runs is the port — build-props.ts on createTsKits (models, graph,
 * themes, landmark/circuit kits, guards, nature, structures, identity, venue,
 * city, pits, data) plus the circuit's codemodded closure. Must be
 * bit-identical to f1-game's own build.
 * F1_SWEEP=1 runs all 52 circuits.
 */
import { describe, expect, it } from "vitest";
import * as Port from "../../../src/track/scenery/build-props";
import { createTsKits } from "../../../src/track/scenery/ts-kits";
import type { SceneryKits } from "../../../src/track/scenery/kits";
import type { PropsTrack } from "../../../src/track/scenery/ctx";
import type { SceneryApi } from "../../../src/contracts/scenery";
import { SCENERY } from "../../../src/circuits/scenery";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

const CIRCUITS = ["monza", "monaco", "vegas", "spa", "singapore", "silverstone", "miami", "redbull"];

describe.skipIf(!haveF1)("TS scenery end to end vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const ids = process.env["F1_SWEEP"] ? Object.keys(SCENERY) : CIRCUITS;

  it.each(ids)("%s builds identically on the TS kits and closure", async (id) => {
    const load = SCENERY[id];
    if (!load) throw new Error(`no closure for ${id}`);
    const closure = (await load()).default;
    const core = f1!.core;
    const opt = (name: string): unknown => f1!.sandbox[name] ?? null;
    const kits = createTsKits(
      core,
      {
        Tracks: f1!.global("Tracks"),
        TrackScenery: { [id]: (api: SceneryApi) => closure(api, core) },
        LightTune: opt("LightTune"),
        GLX: opt("GLX"),
      } as unknown as Pick<SceneryKits, "Tracks" | "TrackScenery" | "LightTune" | "GLX">,
    );
    const base = f1!.build(id);
    const swapped = f1!.build(id, {
      TrackBuildProps: {
        ...Port,
        build: (t: PropsTrack) => Port.build(t, core, kits),
        buildSteps: (t: PropsTrack) => Port.buildSteps(t, core, kits),
      },
    });
    expect(diffDigests(base, swapped)).toEqual([]);
  }, 300_000);
});
