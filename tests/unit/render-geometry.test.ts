import { describe, expect, it } from "vitest";
import { buildGeometry } from "../../src/render/geometry";

const tri = {
  pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]),
  nrm: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0]),
  col: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  idx: Uint32Array.from([0, 2, 1]),
};

describe("buildGeometry (tlx.js:3634)", () => {
  it("keeps pos/nrm/col by reference and zero-fills absent mat/trk", () => {
    const g = buildGeometry(tri);
    expect(g.getAttribute("position").array).toBe(tri.pos);
    expect(g.getAttribute("normal").array).toBe(tri.nrm);
    expect(g.getAttribute("color").array).toBe(tri.col);
    expect(g.getAttribute("mat").array).toEqual(new Float32Array(3));
    expect(g.getAttribute("trk").array).toEqual(new Float32Array(9));
  });

  it("narrows a small Uint32 index to Uint16, keeps it past 65535 verts", () => {
    expect(buildGeometry(tri).getIndex()!.array).toBeInstanceOf(Uint16Array);
    const big = { ...tri, pos: new Float32Array(70000 * 3), nrm: new Float32Array(70000 * 3), col: new Float32Array(70000 * 3) };
    expect(buildGeometry(big).getIndex()!.array).toBeInstanceOf(Uint32Array);
  });

  it("zero-fills a channel whose length does not match pos (tlx.js:3655)", () => {
    const g = buildGeometry({ ...tri, nrm: new Float32Array(4) });
    expect(g.getAttribute("normal").array).toEqual(new Float32Array(9));
  });

  it("gives an empty mesh one degenerate vertex", () => {
    const g = buildGeometry({ pos: new Float32Array(0), nrm: new Float32Array(0), col: new Float32Array(0), idx: new Uint32Array(0) });
    expect(g.getAttribute("position").count).toBe(1);
    expect(g.getIndex()).toBeNull();
  });
});
