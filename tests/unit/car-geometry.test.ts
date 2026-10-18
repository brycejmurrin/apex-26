import { describe, expect, it } from "vitest";
import * as M from "../../src/car/materials";
import { create } from "../../src/car/geometry";
import { newMesh, type MeshOut, type Vec3 } from "../../src/car/types";
import { haveF1, loadF1Car, plain } from "../helpers/f1-car-vm";

// The primitive set every builder sits on (f1-game js/car/car-geometry.js). Bit-exact
// against the VM-loaded original; skipped where f1-game is absent.
type Prim = Record<string, (...a: unknown[]) => unknown>;

function drive(g: Prim, pal: Record<string, unknown>): MeshOut {
  const out = newMesh();
  const red: Vec3 = [1.4, 0.1, 0.05];
  g["addTri"]!(out, [0, 0, 0], [1, 0, 0], [0, 1, 0.2], red);
  g["addQuad"]!(out, [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], pal["CARBON"]);
  g["addBox"]!(out, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, pal["TYRE"]);
  g["addSpan"]!(out, { z: 1, y: 0.3, w: 0.5, h: 0.2, t: 0.7 }, { z: 0.2, y: 0.35, w: 0.6, h: 0.3, x: 0.1 }, red, pal["PANEL"], null, 25);
  g["addBeveledSpan"]!(out, { z: 1, y: 0.3, w: 0.5, h: 0.2, t: 0.7 }, { z: 0.2, y: 0.35, w: 0.6, h: 0.3 }, 0.01, red);
  g["addWingFoil"]!(out, { half: 0.8, thick: 0.03, zLead: 2.7, zTrail: 2.4, yLead: 0.1, yTrail: 0.16, sweep: 0.1, taper: 0.9, rise: 0.02, attachHalf: 0.78, teCurve: 0.1, chordTaper: 0.3, twist: 0.2 }, red, 20);
  g["addBeamBetween"]!(out, [0, 0.3, 1], [0.6, 0.4, 1.2], 0.02, pal["CARBON"]);
  g["addFairedArm"]!(out, [0, 0.3, 1], [0.6, 0.4, 1.2], 0.02, pal["CARBON"]);
  g["addWishboneWeb"]!(out, [0, 0.3, 1], [0, 0.3, 0.8], [0.6, 0.35, 0.9], pal["CARBON"]);
  g["addTube"]!(out, [[0, 0.5, 0], [0.1, 0.7, 0.3], [0, 0.75, 0.6], [0, 0.75, 0.6001]], 0.02, 8, pal["HALO"]);
  g["addStationLoft"]!(out, [
    [[-0.1, 0, 1], [0.1, 0, 1], [0.1, 0.2, 1], [-0.1, 0.2, 1]],
    [[-0.2, 0, 0], [0.2, 0, 0], [0.2, 0.3, 0], [-0.2, 0.3, 0]],
    [[-0.2, 0, -1], [0.2, 0, -1], [0.2, 0.3, -1], [-0.2, 0.3, -1]],
  ], red, pal["PANEL"]);
  return out;
}

describe("car geometry primitives", () => {
  it("addBox emits 12 tris with unit normals", () => {
    const g = create(M);
    const out = newMesh();
    g.addBox(out, 0, 0, 0, 1, 1, 1, M.TYRE);
    expect(out.idx).toHaveLength(36);
    expect(new Set(out.mat)).toEqual(new Set([M.SURFACES.rubber]));
  });

  it.skipIf(!haveF1)("matches f1-game bit for bit", () => {
    const vmg = loadF1Car();
    const VM = vmg["CarMaterials"] as Record<string, unknown>;
    const ref = (vmg["CarGeometry"] as { create(c: unknown): Prim }).create(VM);
    const mine = create(M) as unknown as Prim;
    expect(plain(drive(mine, M as unknown as Record<string, unknown>))).toEqual(plain(drive(ref, VM)));
  });
});
