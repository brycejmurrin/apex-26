import { describe, expect, it } from "vitest";
import type { LandmarkKit } from "../../../src/contracts/scenery";
import * as LandmarkKitPort from "../../../src/track/scenery/landmark-kit";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

// Compile-time: the port's API is the contract's LandmarkKit.
const _contract: (p: LandmarkKitPort.LandmarkPrimitives) => LandmarkKit = LandmarkKitPort.create;
void _contract;

// LandmarkKit runs only where a scenery theme resolves and a circuit (or
// CircuitKit) calls a form: abudhabi calls landmarkKit.roof directly; the rest
// reach tower (lattice / stepped / drum), canopy and roof through CircuitKit.
const CIRCUITS = ["abudhabi", "singapore", "spa", "miami", "hungaroring", "suzuka", "bahrain"];

describe.skipIf(!haveF1)("LandmarkKit port vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;

  it.each(CIRCUITS)("%s builds identically with the port swapped in", (id) => {
    const base = f1!.build(id);
    const swapped = f1!.build(id, { LandmarkKit: LandmarkKitPort });
    expect(diffDigests(base, swapped)).toEqual([]);
  }, 300_000);

  it("negative control: a taller race-control tower is detected (singapore)", () => {
    const base = f1!.build("singapore");
    const bumped = f1!.build("singapore", {
      LandmarkKit: {
        create: (p: LandmarkKitPort.LandmarkPrimitives) => {
          const kit = LandmarkKitPort.create(p);
          const tower: LandmarkKit["tower"] = (stage, spec) => {
            const size = spec["size"] as readonly number[];
            return kit.tower(stage, { ...spec, size: [size[0]!, size[1]! * 1.01, size[2]!] });
          };
          return { ...kit, tower };
        },
      },
    });
    expect(diffDigests(base, bumped).length).toBeGreaterThan(0);
  }, 300_000);
});
