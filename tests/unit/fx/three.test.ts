// src/fx/three.ts: the three.js sink for the particle and skid batches (tlx.js
// drawParticles / drawSkidBatch). Geometry and upload bookkeeping only: no GPU here.
import { describe, expect, it } from "vitest";
import { InterleavedBufferAttribute } from "three/webgpu";
import { createParticles } from "../../../src/fx/particles";
import { createSkidMarks } from "../../../src/fx/skidmarks";
import { FxThree, PARTICLE_STRIDE, SKID_STRIDE } from "../../../src/fx/three";

const meshes = (fx: FxThree) => {
  const [skid, alpha, add] = fx.group.children as unknown as [import("three/webgpu").Mesh, import("three/webgpu").Mesh, import("three/webgpu").Mesh];
  return { skid, alpha, add };
};

describe("FxThree", () => {
  it("lays the particle stream out as fxCorner / position / fxColor / fxSize / fxAlpha and the skid as position / uv", () => {
    const fx = new FxThree();
    const { skid, alpha } = meshes(fx);
    const at = (m: typeof skid, n: string) => m.geometry.getAttribute(n) as InterleavedBufferAttribute;
    expect([["fxCorner", 2, 0], ["position", 3, 2], ["fxColor", 3, 5], ["fxSize", 1, 8], ["fxAlpha", 1, 9]].map(([n]) => {
      const a = at(alpha, n as string); return [n, a.itemSize, a.offset, a.data.stride];
    })).toEqual([["fxCorner", 2, 0, PARTICLE_STRIDE], ["position", 3, 2, PARTICLE_STRIDE], ["fxColor", 3, 5, PARTICLE_STRIDE], ["fxSize", 1, 8, PARTICLE_STRIDE], ["fxAlpha", 1, 9, PARTICLE_STRIDE]]);
    expect([at(skid, "position").offset, at(skid, "uv").offset, at(skid, "uv").data.stride]).toEqual([0, 3, SKID_STRIDE]);
    for (const m of fx.group.children) expect(m.visible).toBe(false);
  });

  it("draws what the pool hands it: a growing stream, the live draw range, re-upload only when dirty", () => {
    const fx = new FxThree();
    const P = createParticles({ random: () => 0.5, tune: () => null, autoShed: () => 0 });
    P.init(fx);
    expect(P.capacity(), "desktop tier").toBe(256);
    for (let i = 0; i < 40; i++) P.tyreSmoke(i, 0, 0, 0, 0, 1, 1);
    P.sparks(0, 0, 0, 0, 1, 10, 3);
    P.update(0.05);
    fx.beginFrame();
    P.draw();
    const { alpha, add } = meshes(fx);
    expect(alpha.visible && add.visible).toBe(true);
    expect(alpha.geometry.drawRange.count).toBe(40 * 6);
    expect(add.geometry.drawRange.count).toBe(3 * 6);
    const buf = (alpha.geometry.getAttribute("position") as InterleavedBufferAttribute).data;
    expect(buf.array.length).toBeGreaterThanOrEqual(40 * 6 * PARTICLE_STRIDE);
    expect(buf.array[2], "first vertex centre x").toBe(0);
    const v0 = buf.version;
    fx.drawParticles(buf.array as Float32Array, 60, false, false);   // a clean re-issue of a different payload uploads
    expect(buf.version).toBe(v0 + 1);
    fx.drawParticles(buf.array as Float32Array, 60, false, false);   // the same payload, clean: no upload
    expect(buf.version).toBe(v0 + 1);
    fx.beginFrame();
    expect(alpha.visible).toBe(false);
  });

  it("the skid trail uploads on rebuild and reuses the buffer when clean", () => {
    const fx = new FxThree();
    const skids = createSkidMarks();
    const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1;
    for (let i = 0; i < 3; i++) skids.stamp(m, true, 1);
    skids.draw(fx);
    const { skid } = meshes(fx);
    const buf = (skid.geometry.getAttribute("position") as InterleavedBufferAttribute).data;
    expect(skid.visible).toBe(true);
    expect(skid.geometry.drawRange.count).toBe(18);
    const v = buf.version;
    skids.draw(fx);
    expect(buf.version, "clean: no re-upload").toBe(v);
    fx.dispose();
  });
});
