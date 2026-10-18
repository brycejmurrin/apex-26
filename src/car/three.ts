// three.js output for the procedural car: f1-game's {pos,nrm,col,mat,idx} record
// (./car3d.ts) becomes an indexed BufferGeometry with a `mat` surface-id attribute,
// drawn with the one car material (./material.ts). Wheels are instanced: one
// InstancedMesh per layer (front/rear × rotating/fixed), two instances each, posed
// like f1-game js/car/car-draw.js:1355-1380 (local = translate(corner) ∘ rotY(steer)
// ∘ rotX(spin)).
//
// HANDEDNESS. f1-game's car space has +Z forward, +Y up and +X on the DRIVER'S RIGHT,
// a left-handed frame its model matrix reflects back (car-mesh.js carDecalData note).
// three is right-handed, so this module mirrors X (x -> -x, winding reversed): an
// unrotated car faces +Z and its right-hand side is at -X.
import { BufferAttribute, BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, type Material } from "three/webgpu";
import { buildComplete, buildWheelLayers, type BuildOptions } from "./car3d";
import { createCarMaterial, MAT_ATTRIBUTE } from "./material";
import { BRAKE_CALIPER, TYRE_BAND } from "./materials";
import type { MeshOut, Vec3 } from "./types";

/** f1-game car-draw.js:858 wheel corners (car space, +X = driver's right). */
export const WHEEL_CORNERS = Object.freeze([
  Object.freeze({ x: -0.79, y: 0.34, z: 1.7, front: true }),
  Object.freeze({ x: 0.79, y: 0.34, z: 1.7, front: true }),
  Object.freeze({ x: -0.76, y: 0.34, z: -1.6, front: false }),
  Object.freeze({ x: 0.76, y: 0.34, z: -1.6, front: false }),
]);

/** Tyre widths for the front and rear wheel meshes (car-draw.js:1202-1205). */
export const WHEEL_WIDTH = Object.freeze({ front: 0.32, rear: 0.38 });

export interface GeometryOptions {
  /** Mirror f1-game's left-handed car space into three's right-handed one (default true). */
  mirrorX?: boolean;
}

/** f1-game mesh record -> indexed BufferGeometry (position, normal, color, mat). */
export function meshToGeometry(m: MeshOut, opts: GeometryOptions = {}): BufferGeometry {
  const mirror = opts.mirrorX ?? true;
  const n = m.mat.length;
  const pos = new Float32Array(m.pos);
  const nrm = new Float32Array(m.nrm);
  if (mirror) for (let i = 0; i < n * 3; i += 3) { pos[i] = -pos[i]!; nrm[i] = -nrm[i]!; }
  const idx = n > 65535 ? new Uint32Array(m.idx) : new Uint16Array(m.idx);
  if (mirror) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]!; idx[i + 1] = idx[i + 2]!; idx[i + 2] = t; }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("normal", new BufferAttribute(nrm, 3));
  g.setAttribute("color", new BufferAttribute(new Float32Array(m.col), 3));
  g.setAttribute(MAT_ATTRIBUTE, new BufferAttribute(new Float32Array(m.mat), 1));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export interface CarOptions {
  /** Body colour (linear RGB). f1-game default [0.8, 0.05, 0.05]. */
  color?: Vec3;
  /** Accent colour. f1-game default [0.9, 0.9, 0.1]. */
  color2?: Vec3;
  /** Car3D.build options (team, livery, parts tiers, cockpit, measure…). noWheels is forced on. */
  build?: BuildOptions;
  /** Skip the wheels entirely (field bodies that draw their own). */
  noWheels?: boolean;
  /** Shared material; one is created per car otherwise. */
  material?: Material;
}

export interface WheelSet {
  /** Rotating layers (tyre, rim, disc): spin + steer. */
  front: InstancedMesh;
  rear: InstancedMesh;
  /** Fixed layers (caliper, upright): steer only. */
  frontFixed: InstancedMesh;
  rearFixed: InstancedMesh;
}

export interface CarModel {
  group: Group;
  body: Mesh;
  wheels: WheelSet | null;
  /** Pose the wheels: spin angles (rad, f1-game wheelSpinF/R) and front steer (rad, f1-game steerA). */
  setWheelPose(spinF: number, spinR: number, steer: number): void;
  dispose(): void;
}

const _m = new Matrix4();
const _r = new Matrix4();

function corner(i: number) {
  return WHEEL_CORNERS[i]!;
}

function poseWheel(mesh: InstancedMesh, slot: number, x: number, y: number, z: number, steer: number, spin: number): void {
  // car-draw.js:1372-1377 local frame, mirrored: S·Ry(a)·Rx(b)·S = Ry(-a)·Rx(b).
  _m.makeTranslation(-x, y, z);
  _m.multiply(_r.makeRotationY(-steer));
  _m.multiply(_r.makeRotationX(spin));
  mesh.setMatrixAt(slot, _m);
}

function wheelLayer(m: MeshOut, material: Material, name: string): InstancedMesh {
  const im = new InstancedMesh(meshToGeometry(m), material, 2);
  im.name = name;
  return im;
}

/** Build one car: body mesh plus instanced wheels, in a Group at the car origin. */
export function buildCar(opts: CarOptions = {}): CarModel {
  const material = opts.material ?? createCarMaterial();
  const ownMaterial = !opts.material;
  const bodyMesh = buildComplete(opts.color, opts.color2, { ...opts.build, noWheels: true });
  const body = new Mesh(meshToGeometry(bodyMesh), material);
  body.name = "car-body";
  const group = new Group();
  group.name = "car";
  group.add(body);

  let wheels: WheelSet | null = null;
  if (!opts.noWheels) {
    const band = TYRE_BAND[1];
    const caliper = BRAKE_CALIPER[1];
    const f = buildWheelLayers(WHEEL_WIDTH.front, band, caliper, null, false, null, null, null, null);
    const r = buildWheelLayers(WHEEL_WIDTH.rear, band, caliper, null, false, null, null, null, null);
    wheels = {
      front: wheelLayer(f.rotating, material, "wheel-front"),
      rear: wheelLayer(r.rotating, material, "wheel-rear"),
      frontFixed: wheelLayer(f.fixed, material, "wheel-front-fixed"),
      rearFixed: wheelLayer(r.fixed, material, "wheel-rear-fixed"),
    };
    group.add(wheels.front, wheels.rear, wheels.frontFixed, wheels.rearFixed);
  }

  function setWheelPose(spinF: number, spinR: number, steer: number): void {
    if (!wheels) return;
    for (let i = 0; i < 4; i++) {
      const c = corner(i), slot = i & 1;
      const yaw = c.front ? steer : 0;
      poseWheel(c.front ? wheels.front : wheels.rear, slot, c.x, c.y, c.z, yaw, c.front ? spinF : spinR);
      poseWheel(c.front ? wheels.frontFixed : wheels.rearFixed, slot, c.x, c.y, c.z, yaw, 0);
    }
    for (const im of [wheels.front, wheels.rear, wheels.frontFixed, wheels.rearFixed]) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
  }
  setWheelPose(0, 0, 0);

  return {
    group, body, wheels, setWheelPose,
    dispose() {
      body.geometry.dispose();
      if (wheels) for (const im of [wheels.front, wheels.rear, wheels.frontFixed, wheels.rearFixed]) { im.geometry.dispose(); im.dispose(); }
      if (ownMaterial) material.dispose();
    },
  };
}
