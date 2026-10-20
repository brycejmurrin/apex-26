// The garage scene on three.js (src/garage/scene/three.ts): the same room the
// recording facade sees, as three objects under one Group. Node only: no
// renderer, so this checks the scene graph, not pixels.
import { describe, expect, it } from "vitest";
import { Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import { createGarageScene, buildStatic } from "../../../src/garage/scene/scene";
import { createThreeGarageGfx, geometryOf, texGeometryOf, toMeshData } from "../../../src/garage/scene/three";
import { buildDress } from "../../../src/garage/scene/dress";
import { SIDES } from "../../../src/garage/scene/scene";
import { LIV, liveryStub, recordingCanvas, TEAM } from "./scene-vm";

describe("three adapter", () => {
  it("converts accumulators to typed geometry, bit for bit", () => {
    const bay = buildStatic(LIV, { props: "lite" });
    const d = toMeshData(bay);
    expect(d.pos).toEqual(new Float32Array(bay.pos));
    expect(d.idx).toBeInstanceOf(Uint16Array);
    const g = geometryOf(bay);
    expect(g.getAttribute("position").count).toBe(bay.pos.length / 3);
    expect(Array.from(g.getAttribute("mat").array as Float32Array)).toEqual(bay.mat);
    expect(g.index!.count).toBe(12318);
    const t = texGeometryOf(buildDress(SIDES).back);
    expect(t.getAttribute("uv").itemSize).toBe(2);
  });

  it("draws the room as pooled meshes under one group, frame by frame", () => {
    const gfx = createThreeGarageGfx();
    const cv = recordingCanvas();
    const scene = createGarageScene({ log: { info() {}, warn() {} }, now: () => 0, parts: null,
      createCanvas: cv.createCanvas as never, livery: liveryStub([]) as never });
    scene.init(gfx);
    const car = gfx.createMesh(buildStatic(LIV, {}));
    gfx.beginFrame();
    scene.draw(TEAM, LIV, [0, 1.6, 0], null, 0, null, car, { door: 0.5, z: 1 }, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1]));
    const first = gfx.drawn();
    expect(first).toBeGreaterThan(20);
    const meshes = gfx.root.children.filter((c): c is Mesh => c instanceof Mesh);
    const visible = meshes.filter((m) => m.visible);
    expect(visible.length).toBe(first);
    // Draw order survives as renderOrder; decals are textured, LEDs unlit, the rest lit.
    expect(new Set(visible.map((m) => m.renderOrder)).size).toBe(first);
    expect(visible.some((m) => m.material instanceof MeshStandardNodeMaterial)).toBe(true);
    expect(visible.some((m) => m.material instanceof MeshBasicNodeMaterial && (m.material as MeshBasicNodeMaterial).map)).toBe(true);
    // The mirrored car carries the reflection's matrix (Y negated) and depth bias.
    const mirrored = visible.find((m) => m.matrix.elements[5] === -1 && m.matrix.elements[14] === 2)!;
    expect((mirrored.material as MeshStandardNodeMaterial).polygonOffset).toBe(true);
    // A second frame reuses the pool: no new objects.
    const n = gfx.root.children.length;
    gfx.beginFrame();
    scene.draw(TEAM, LIV, [0, 1.6, 0], null, 0, null, car, { door: 0.5, z: 1 });
    expect(gfx.root.children.length).toBe(n);
    gfx.beginFrame();
    expect(gfx.drawn()).toBe(0);
    expect(gfx.root.children.every((c) => !c.visible)).toBe(true);
    scene.release();
    gfx.freeMesh(car);
    // f1-game's release() (scene.js:1381-1406) frees neither the crew's three
    // meshes (the mechanic is pooled twice) nor the mirror-fade quad: kept verbatim.
    expect(gfx.root.children.map((c) => (c as Mesh).geometry.getAttribute("position").count)).toEqual([312, 312, 264, 176, 4]);
    gfx.dispose();
  });
});
