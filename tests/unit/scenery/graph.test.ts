import { afterAll, describe, expect, it } from "vitest";
import * as Graph from "../../../src/track/scenery/graph";
import { createF1Vm, diffDigests, haveF1 } from "./f1vm";

// TrackGraph reads no engine global, so the port's `create(ctx)` drops in as is.
// Every build creates a graph (build-props.js:550) and stores it on
// `track.graph`, whose digest walks each model's lazy canonical mesh too.
const CIRCUITS = ["monza", "monaco", "vegas", "spa", "suzuka", "singapore", "zandvoort", "bahrain"];

describe.skipIf(!haveF1)("TrackGraph port vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const glx = haveF1 ? f1!.global<Record<string, unknown>>("GLX") : {};
  afterAll(() => { delete glx["createInstancedBatch"]; });

  it("exports the same names and constants", () => {
    const ref = f1!.global<Record<string, unknown>>("TrackGraph");
    expect(Object.keys(Graph).sort()).toEqual(Object.keys(ref).sort());
    expect(Graph.NODE_COLOR).toBe(ref["NODE_COLOR"]);
    expect(Graph.SWAY_FRAC).toBe(ref["SWAY_FRAC"]);
  });

  it.each(CIRCUITS)("%s builds identically (fused path)", (id) => {
    const base = f1!.build(id);
    const swapped = f1!.build(id, { TrackGraph: Graph });
    expect(diffDigests(base, swapped)).toEqual([]);
  }, 300_000);

  // With an instancing backend, `_preferInstance` drives the dry-run/verdict,
  // absorb-only and meshModel/meshPlace paths, and tracks.js uploads batches().
  it.each(["monza", "vegas", "singapore"])("%s builds identically (instanced path)", (id) => {
    glx["createInstancedBatch"] = (geo: unknown, matrices: unknown, colors: unknown) => ({ geo, matrices, colors });
    try {
      const base = f1!.build(id);
      const swapped = f1!.build(id, { TrackGraph: Graph });
      expect(diffDigests(base, swapped)).toEqual([]);
    } finally {
      delete glx["createInstancedBatch"];
    }
  }, 300_000);

  it("detects a deliberate change (negative control)", () => {
    const base = f1!.build("monza");
    const bumped: typeof Graph = { ...Graph, create: (ctx) => {
      const g = Graph.create(ctx);
      return { ...g, instance: (key, place, build, meta, emit, out) =>
        g.instance(key + "#", place, build, meta, emit, out) };
    } };
    expect(diffDigests(base, f1!.build("monza", { TrackGraph: bumped }))).toContain("graph");
  }, 60_000);
});
