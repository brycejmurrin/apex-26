// The distant field: every rival past FieldLod tier 2 (NO_DECAL_M, ~120 m in reference-
// lens metres, ±10 % hysteresis) draws ONE shared neutral-grey low-poly body instead
// of its own team body, so the field never pays a Car3D.build per seat at range; the
// team colours stay on the planted wheels. Ported from f1-game js/car/car-draw.js:
// 222-236 (sharedRivalBodyMesh) and the tier switch at js/game.js:7931. Here the shared
// body is one InstancedMesh: one draw for the whole far field.
import { InstancedMesh, type Material, type Matrix4 } from "three/webgpu";
import { build, type PartTiers } from "./car3d";
import { FieldLod, type LodCar } from "./field-lod";
import { getFactorySetup, getVisualTiers } from "./parts";
import { LIST as TEAMS } from "./teams";
import { createCarMaterial } from "./material";
import { meshToGeometry } from "./three";
import type { MeshOut, Vec3 } from "./types";

/** car-draw.js:231: neutral grey; the livery lives on the wheels at this range. */
export const SHARED_BODY_GREY: Vec3 = [0.72, 0.72, 0.72];

/** The first team's factory visual tiers (car-draw.js:229-230). */
export function sharedBodyParts(): PartTiers {
  const team = TEAMS[0]!;
  return getVisualTiers(getFactorySetup(team), team) as PartTiers;
}

/** Car3D.build of the shared far body (car-draw.js:231-234): the field/silhouette
 *  cover, no driver, no wheels, flat shading, the first team's factory parts. */
export function sharedBodyMesh(parts: PartTiers = sharedBodyParts()): MeshOut {
  return build(SHARED_BODY_GREY, SHARED_BODY_GREY, {
    field: true, silhouette: true, noDriver: true, noWheels: true, livery: {}, smooth: false, parts,
  });
}

/** Should this rival draw the shared far body? f1-game game.js:7931:
 *  `FieldLod.on && !c.isPlayer && _lod >= 2`. Updates `car._lodTier` (hysteresis). */
export function usesSharedBody(dist2: number, fovY: number | undefined, car: LodCar, isPlayer: boolean): boolean {
  if (isPlayer) return false;
  const tier = FieldLod.tier(dist2, fovY, car);
  return FieldLod.on && tier >= 2;
}

export interface FieldBodies {
  /** One draw for every far rival; `count` is the number posed this frame. */
  mesh: InstancedMesh;
  /** Pose the far rivals (car-space → world matrices); extra slots are hidden. */
  setCars(matrices: readonly Matrix4[]): void;
  dispose(): void;
}

/** The shared far body as an InstancedMesh with room for `capacity` rivals. */
export function createFieldBodies(capacity: number, opts: { parts?: PartTiers; material?: Material } = {}): FieldBodies {
  const material = opts.material ?? createCarMaterial();
  const mesh = new InstancedMesh(meshToGeometry(sharedBodyMesh(opts.parts)), material, capacity);
  mesh.name = "field-bodies";
  mesh.count = 0;
  mesh.frustumCulled = false;   // instances span the track; the bounding sphere is per-geometry
  return {
    mesh,
    setCars(matrices) {
      const n = Math.min(matrices.length, capacity);
      for (let i = 0; i < n; i++) mesh.setMatrixAt(i, matrices[i]!);
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      mesh.geometry.dispose();
      mesh.dispose();
      if (!opts.material) material.dispose();
    },
  };
}
