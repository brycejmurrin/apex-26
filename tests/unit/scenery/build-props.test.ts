/**
 * TrackBuildProps parity: the TS port of f1-game js/track/scenery/build-props.js,
 * driven by f1-game's own engine (SceneryCore) and kits (SceneryKits, taken
 * from the VM's globals), must build every circuit identically: every track
 * field (barL/barR, posts, props registry, lampPosts, modelInstances,
 * diagnostics, …) and every uploaded mesh.
 *
 * Tracks.build (f1-game js/track/tracks.js:340-344) calls
 * `TrackBuildProps.buildSteps(track)` and then `featherAfterOpen(track)`; the
 * override below swaps all three for the port.
 *
 * F1_SWEEP=1 runs all 52 circuits instead of the six below.
 */
import { describe, expect, it } from "vitest";
import * as Port from "../../../src/track/scenery/build-props";
import type { SceneryKits } from "../../../src/track/scenery/kits";
import type { PropsTrack } from "../../../src/track/scenery/ctx";
import { createF1Vm, diffDigests, haveF1, type F1Vm } from "./f1vm";

const CIRCUITS = ["monza", "monaco", "vegas", "spa", "singapore", "suzuka"];

function kitsOf(f1: F1Vm): SceneryKits {
  const opt = (name: string): unknown => f1.sandbox[name] ?? null;
  const kits = {
    TrackModels: f1.global("TrackModels"),
    TrackGraph: f1.global("TrackGraph"),
    SceneryThemes: opt("SceneryThemes"),
    LandmarkKit: opt("LandmarkKit"),
    CircuitKit: opt("CircuitKit"),
    SceneryGuards: f1.global("SceneryGuards"),
    SceneryNature: f1.global("SceneryNature"),
    SceneryStructures: f1.global("SceneryStructures"),
    SceneryCity: f1.global("SceneryCity"),
    SceneryIdentity: f1.global("SceneryIdentity"),
    SceneryVenue: f1.global("SceneryVenue"),
    SceneryPits: opt("SceneryPits"),
    TrackSceneryData: f1.global("TrackSceneryData"),
    TrackScenery: opt("TrackScenery"),
    Tracks: f1.global("Tracks"),
    LightTune: opt("LightTune"),
    GLX: opt("GLX"),
  };
  // VM objects from another realm: typed by the kit interfaces they implement.
  return kits as unknown as SceneryKits;
}

function portOverride(f1: F1Vm, kits: SceneryKits): Record<string, unknown> {
  return {
    TrackBuildProps: {
      ...Port,
      build: (t: PropsTrack) => Port.build(t, f1.core, kits),
      buildSteps: (t: PropsTrack) => Port.buildSteps(t, f1.core, kits),
    },
  };
}

describe.skipIf(!haveF1)("TrackBuildProps port vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const sweep = !!process.env["F1_SWEEP"];
  const ids = sweep && f1
    ? f1.global<{ LIST: readonly { id: string }[] }>("Tracks").LIST.map((d) => d.id)
    : CIRCUITS;

  it.each(ids)("%s builds identically with the port", (id) => {
    const kits = kitsOf(f1!);
    // Warm-up: f1-game's FIRST build of some circuits in a VM differs from
    // later ones in pre-props fields (redbull: roadGeo, terrainGeo, _terrGrid,
    // mesh#0-2, f1-game vs f1-game), so compare against a second build.
    f1!.build(id);
    const base = f1!.build(id);
    const swapped = f1!.build(id, portOverride(f1!, kits));
    expect(diffDigests(base, swapped)).toEqual([]);
  }, 300_000);

  it("featherBarrierEnds matches f1-game on a synthetic cliff set", () => {
    const ref = f1!.global<typeof Port>("TrackBuildProps");
    const mk = () => {
      const hw = new Float32Array(40).fill(6);
      const bar = new Float32Array(40).map((_, k) => 6 + (k % 9 < 3 ? 1 : k % 9 < 6 ? 9 : 4));
      return { hw, bar };
    };
    for (const [cliff, nodes] of [[null, null], [1, 3], [2.5, 7]] as const) {
      const a = mk(), b = mk();
      const protect = (k: number) => k % 11 === 0;
      ref.featherBarrierEnds(a.bar, a.hw, cliff, nodes, protect);
      Port.featherBarrierEnds(b.bar, b.hw, cliff, nodes, protect);
      expect(Array.from(b.bar)).toEqual(Array.from(a.bar));
    }
  });

  it("detects a deliberate change (negative control, monza)", () => {
    const kits = kitsOf(f1!);
    const base = f1!.build("monza");
    // One ulp on the blue of every RAW box the props pass emits: the props mesh must differ.
    const geom = f1!.core.geom;
    const core = {
      ...f1!.core,
      geom: { ...geom, addBox: ((o, c, sz, col, basis) => geom.addBox(o, c, sz, [col[0], col[1], col[2] + Number.EPSILON], basis)) as typeof geom.addBox },
    };
    const bumped = f1!.build("monza", {
      TrackBuildProps: { ...Port, buildSteps: (t: PropsTrack) => Port.buildSteps(t, core, kits) },
    });
    expect(diffDigests(base, bumped)).toContain("propsGeo");
  }, 300_000);
});
