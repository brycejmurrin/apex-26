// T1.2: buildTrack produces the full set of CPU mesh buffers in Node, and they are well formed.
import { describe, expect, it } from "vitest";
import { buildTrack, defById, LIST, validateGeometry } from "../../src/track/core/tracks";
import { fromRaw } from "../../src/track/core/def";
import { CIRCUITS } from "../../src/circuits/index";

describe("track core port", () => {
  it("LIST mirrors the curated circuit order", () => {
    expect(LIST.map((d) => d.id)).toEqual(CIRCUITS.map((c) => c.id));
  });

  it("buildTrack('monza') returns valid mesh buffers", () => {
    const t = buildTrack(defById("monza")!);
    const geo = t.geo!;
    for (const k of ["floor", "road", "terrain", "gate", "startline"] as const) {
      const g = geo[k];
      expect(validateGeometry(g).ok, k).toBe(true);
      expect(g.idx.length, k).toBeGreaterThan(0);
    }
    expect(t.geometryDiagnostics!.every((d) => d.ok)).toBe(true);
  });

  it("points materialise lazily and once", () => {
    const d = fromRaw(CIRCUITS.find((c) => c.id === "spa")!);
    const a = d.points;
    expect(d.points).toBe(a);
  });
});
