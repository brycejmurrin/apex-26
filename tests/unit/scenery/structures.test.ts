import { describe, expect, it } from "vitest";
import type { SceneryApi } from "../../../src/contracts/scenery";
import * as Structures from "../../../src/track/scenery/structures";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

// Compile-time: every kit member the scenery api exposes stays assignable to
// its SceneryApi signature (tsc checks this; it never runs).
type ApiPart = Pick<SceneryApi, keyof Structures.StructuresApi & keyof SceneryApi>;
export const apiCheck = (a: Structures.StructuresApi): ApiPart => a;

// Circuits that between them run every structures emitter: barriers and
// gantries everywhere, tieredBowl (monza, imola), terrace (suzuka, fuji),
// scaffoldStand/bleacher (monaco, fuji), signBoard (brands_hatch), the
// ferris wheel (vegas), camera towers and marshal posts (all but monza).
const CIRCUITS = ["monza", "monaco", "vegas", "spa", "suzuka", "brands_hatch", "fuji", "imola"];

/** Every style branch the circuits may not reach, laid on top of a circuit's own scenery. */
const styleSweep = (api: SceneryApi): void => {
  const { K } = api;
  const styles = ["chainlink", "panelled", "hoarding", "palisade", "leaning", "mesh"];
  styles.forEach((st, i) => api.fence(0.02 + i * 0.01, 0.025 + i * 0.01, 1, 14, 3.2, [0.6, 0.62, 0.66], { style: st }));
  ["doubleArmco", "wArmco", "jersey", "cable", "safer", "armco"].forEach((st, i) =>
    api.guardrail(0.1 + i * 0.01, 0.105 + i * 0.01, -1, 12, [0.6, 0.62, 0.66], { style: st }));
  ["tecpro", "airfence", "stack"].forEach((st, i) =>
    api.tyreWall(0.2 + i * 0.01, 0.205 + i * 0.01, 1, 16, [0.6, 0.62, 0.66], { style: st }));
  ["truss", "portal", "scaffold", "cantilever", "box"].forEach((st, i) => api.gantry(0.3 + i * 0.02, 7, [0.6, 0.62, 0.66], { style: st }));
  ["cabin", "container", "kiosk", "bunker", "tent", "tower", "hut"].forEach((st, i) =>
    api.marshalPost(K(0.45 + i * 0.01), i & 1 ? 1 : -1, 20, { style: st }));
  ["monopole", "scaffold", "lattice"].forEach((st, i) => api.cameraTower(K(0.55 + i * 0.01), 1, 25, { style: st }));
  ["banner", "barrierTop", "double", "led", "panel"].forEach((st, i) =>
    api.sponsorHoarding(0.6 + i * 0.01, 0.607 + i * 0.01, -1, 18, { style: st }));
  api.signBoard(K(0.7), 1, 9, "speed", 60);
  api.signBoard(K(0.71), 1, 9, "braking", 3);
  api.signBoard(K(0.72), -1, 9, "corner", 12);
  api.bleacher(0.75, 0.77, 1, 30, { frame: "timber", rows: 9 });
  api.scaffoldStand(0.78, 0.8, -1, 30, { awning: true });
  api.terrace(0.81, 0.83, 1, 40, { cut: true });
  api.tieredBowl(0.84, 0.86, -1, 40, { roof: true });
  api.ferrisWheel(K(0.9), 1, 60, 18);
  api.wall(0.92, 0.95, 1, 10, 2, [0.5, 0.5, 0.5], 0.6, 0.1);
};

describe.skipIf(!haveF1)("SceneryStructures port vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const port = (mutate?: (api: Structures.StructuresApi) => Structures.StructuresApi) => ({
    SceneryStructures: {
      ...Structures,
      create: (ctx: Structures.StructuresCtx) => {
        const api = Structures.create(ctx, f1!.core);
        return mutate ? mutate(api) : api;
      },
    },
  });

  it("builds every circuit identically with the port swapped in", () => {
    for (const id of CIRCUITS) {
      const base = f1!.build(id);
      expect(diffDigests(base, f1!.build(id, port())), id).toEqual([]);
    }
  }, 300_000);

  it("matches on every style branch (style sweep over monza and vegas)", () => {
    const scenery = f1!.global<Record<string, (api: SceneryApi) => void>>("TrackScenery");
    for (const id of ["monza", "vegas"]) {
      const orig = scenery[id]!;
      const TrackScenery = { ...scenery, [id]: (api: SceneryApi) => { orig(api); styleSweep(api); } };
      const base = f1!.build(id, { TrackScenery });
      expect(diffDigests(base, f1!.build(id, { TrackScenery, ...port() })), id).toEqual([]);
      // The sweep really emits: its build differs from the circuit's own.
      if (id === "monza") expect(diffDigests(base, f1!.build(id))).toContain("propsGeo");
    }
  }, 120_000);

  it("negative control: a 1e-9 m wall height change is detected", () => {
    const base = f1!.build("monza");
    const bumped = f1!.build("monza", port((api) => ({
      ...api,
      wall: (s0, s1, side, gap, h, col, thick, alt) => api.wall(s0, s1, side, gap, h + 1e-9, col, thick, alt),
    })));
    expect(diffDigests(base, bumped)).not.toEqual([]);
  }, 60_000);
});
