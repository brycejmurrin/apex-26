import { describe, expect, it } from "vitest";
import { Matrix4 } from "three/webgpu";
import { build } from "../../src/car/car3d";
import { createFieldBodies, sharedBodyMesh, sharedBodyParts, SHARED_BODY_GREY, usesSharedBody } from "../../src/car/field-body";
import { FieldLod } from "../../src/car/field-lod";
import type { MeshOut } from "../../src/car/types";
import { haveF1, loadF1Car, plain } from "../helpers/f1-car-vm";

// f1-game js/car/car-draw.js:226 sharedRivalBodyMesh and js/game.js:7931.
describe("shared far-field body", () => {
  it("is far cheaper than a team body and neutral grey", () => {
    const shared = sharedBodyMesh(), full = build(undefined, undefined, { noWheels: true, parts: sharedBodyParts() });
    expect(shared.mat.length).toBeLessThan(full.mat.length * 0.6);
    // Paint is the grey body; only small fixed-colour trim (T-cam pod, status light) differs.
    let paint = 0, grey = 0;
    for (let i = 0; i < shared.mat.length; i++) {
      if (shared.mat[i] !== 20) continue;
      paint++;
      if (shared.col.slice(i * 3, i * 3 + 3).join() === SHARED_BODY_GREY.join()) grey++;
    }
    expect(grey / paint).toBeGreaterThan(0.95);
  });

  it("switches at NO_DECAL_M with ±10 % hysteresis, never for the player", () => {
    FieldLod.setEnabled(true);
    const car = {};
    const at = (m: number) => usesSharedBody(m * m, undefined, car, false);
    expect(at(100)).toBe(false);
    expect(at(125)).toBe(false);          // inside +10 % of 120 m
    expect(at(140)).toBe(true);
    expect(at(115)).toBe(true);           // stays until inside -10 %
    expect(at(100)).toBe(false);
    expect(usesSharedBody(1e6, undefined, {}, true)).toBe(false);
    FieldLod.setEnabled(false);
    expect(usesSharedBody(1e6, undefined, {}, false)).toBe(false);
    FieldLod.setEnabled(true);
  });

  it("poses one InstancedMesh for the far field", () => {
    const f = createFieldBodies(22);
    expect(f.mesh.count).toBe(0);
    f.setCars([new Matrix4().makeTranslation(0, 0, 200), new Matrix4().makeTranslation(3, 0, 210)]);
    expect(f.mesh.count).toBe(2);
    const m = new Matrix4();
    f.mesh.getMatrixAt(1, m);
    expect(m.elements[12]).toBe(3);
    f.dispose();
  });

  it.skipIf(!haveF1)("matches f1-game's shared body build bit for bit", () => {
    const vm = loadF1Car({ extra: ["js/data/teams.js", "js/car/parts.js"], globals: ["Teams", "Parts"] });
    const Car3D = vm["Car3D"] as { build(a: unknown, b: unknown, o: unknown): MeshOut };
    const Teams = vm["Teams"] as { LIST: unknown[] };
    const Parts = vm["Parts"] as { getFactorySetup(t: unknown): unknown; getVisualTiers(s: unknown, t: unknown): unknown };
    const team = Teams.LIST[0];
    const g = [0.72, 0.72, 0.72];
    const ref = Car3D.build(g, g, { field: true, silhouette: true, noDriver: true, noWheels: true, livery: {}, smooth: false,
      parts: Parts.getVisualTiers(Parts.getFactorySetup(team), team) });
    expect(plain(sharedBodyMesh())).toEqual(plain(ref));
  });
});
