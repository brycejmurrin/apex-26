import { describe, expect, it } from "vitest";
import type { CircuitKit } from "../../../src/contracts/scenery";
import type { SceneryCore } from "../../../src/track/scenery/core";
import * as CircuitKitPort from "../../../src/track/scenery/circuit-kit";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

// Compile-time: the port's API satisfies the contract's CircuitKit.
const _contract: (api: CircuitKitPort.CircuitKitApi) => CircuitKit = (api) => api;
void _contract;

// Circuits that call circuitKit.*: spa (structure marshalShelter, lattice
// raceControl, pitBuilding no-op), miami (stepped raceControl), singapore
// (drum raceControl, pedestrianBridge), hungaroring, suzuka (trackSigns),
// silverstone (cameraCrane), bahrain, baku (pedestrianBridge).
const CIRCUITS = ["spa", "miami", "singapore", "hungaroring", "suzuka", "silverstone", "bahrain", "baku"];

describe.skipIf(!haveF1)("CircuitKit port vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const port = (core: SceneryCore = f1!.core) => ({
    create: (deps: CircuitKitPort.CircuitKitCtx) => CircuitKitPort.create(deps, core),
  });

  it.each(CIRCUITS)("%s builds identically with the port swapped in", (id) => {
    const base = f1!.build(id);
    const swapped = f1!.build(id, { CircuitKit: port() });
    expect(diffDigests(base, swapped)).toEqual([]);
  }, 300_000);

  it("negative control: a changed material table is detected (spa marshal shelters)", () => {
    const base = f1!.build("spa");
    const core = f1!.core;
    const geom = { ...core.geom, MAT: { ...core.geom.MAT, CONCRETE: core.geom.MAT.METAL } };
    const bumped = f1!.build("spa", { CircuitKit: port({ ...core, geom }) });
    expect(diffDigests(base, bumped).length).toBeGreaterThan(0);
  }, 300_000);
});
