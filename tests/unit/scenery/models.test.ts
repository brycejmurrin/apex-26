import { describe, expect, it } from "vitest";
import * as Models from "../../../src/track/scenery/models";
import { createF1Vm, diffDigests, digest, haveF1 } from "./f1vm";

// Circuits that between them reach every TrackModels path: modelGroup,
// overheadSpan (soffit, startLights), waterSurface, groundPatch,
// groundedSegments, drape and drapeRun. scratch/sealGeometry/validateGeometry
// run on every build (build-props.js:235-237, tracks.js:324-345).
const CIRCUITS = ["monza", "monaco", "bahrain", "abudhabi", "paul_ricard", "catalunya", "cota", "miami", "vegas"];

describe.skipIf(!haveF1)("TrackModels port vs f1-game", () => {
  const f1 = haveF1 ? createF1Vm() : null;
  const port = haveF1 ? { ...Models, create: (ctx: Models.ModelsCtx) => Models.create(ctx, f1!.core) } : null;

  it("exports the same names", () => {
    const ref = f1!.global<Record<string, unknown>>("TrackModels");
    expect(Object.keys(Models).sort()).toEqual(Object.keys(ref).sort());
  });

  it("validateGeometry agrees on good and broken geometry", () => {
    const ref = f1!.global<{ validateGeometry(g: unknown): unknown }>("TrackModels");
    const cases: unknown[] = [
      null, {}, { pos: [0, 0, 0], idx: [0] }, { pos: [0, 0], idx: [] }, { pos: [0, NaN, 0], idx: [] },
      { pos: new Float32Array(9), nrm: [0, 1], idx: [0, 1, 2] }, { pos: [0, 0, 0], col: [1, 1, Infinity], idx: [0] },
      { pos: [0, 0, 0], idx: [1] }, { pos: [0, 0, 0], idx: [0.5] }, { pos: [0, 0, 0], idx: "x" },
    ];
    for (const g of cases) expect(digest(Models.validateGeometry(g as never))).toBe(digest(ref.validateGeometry(g)));
  });

  it.each(CIRCUITS)("%s builds identically", (id) => {
    const base = f1!.build(id);
    const swapped = f1!.build(id, { TrackModels: port });
    expect(diffDigests(base, swapped)).toEqual([]);
  }, 300_000);

  it("detects a deliberate change (negative control)", () => {
    const base = f1!.build("monaco");
    const bumped = { ...port!, create: (ctx: Models.ModelsCtx) => {
      const m = Models.create(ctx, f1!.core);
      return { ...m, overheadSpan: (spec?: Models.OverheadSpec | null) =>
        m.overheadSpan(spec ? { ...spec, thickness: (spec.thickness ?? 0.9) + 1e-9 } : spec) };
    } };
    expect(diffDigests(base, f1!.build("monaco", { TrackModels: bumped }))).not.toEqual([]);
  }, 60_000);
});
