// The renderer core (PLAN T1.7): `RenderSeam` on one three.js WebGPURenderer, WebGL2
// fallback through the boot policy (./boot.ts).
//
// Structure follows f1-game's TLX backend (js/render/three/tlx.js): one scene, one
// lit material for every track mesh (tlx.js `materialFor`), static meshes with
// their matrices frozen, the sky as a background node rather than a scene mesh
// (tsl-sky.js), a sun shadow map placed by shadow-pass.js's box rule (./shadow.ts),
// and the post chain of tsl-post.js (./post.ts). f1-game's WebGL2 bottleneck is
// per-object JS cost (docs/notes/PERF-HUNT-4-2026-10-14.md,
// PERF-HUNT-TLX-2026-10-17.md), so a track slot is ONE mesh, never split per prop.
import {
  DirectionalLight,
  HemisphereLight,
  LinearSRGBColorSpace,
  Mesh,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  Vector3,
  type Object3D,
  type WebGPURenderer,
} from "three/webgpu";
import type {
  BackendName,
  CameraPose,
  CarHandle,
  FrameLighting,
  MeshData,
  MeshHandle,
  RenderInitOptions,
  RenderSeam,
  TrackMeshKey,
} from "../contracts/render";
import type { Vec3 } from "../contracts/track";
import { browserEnv, createRenderer } from "./boot";
import { buildGeometry } from "./geometry";
import { LIGHT_SCALE, makeFogNode, makeFrameUniforms, makeSkyNode, makeTrackMaterial } from "./lit";
import { makePost, type PostChain } from "./post";
import { SHADOW_RANGE, shadowAnchor } from "./shadow";

/** Slots that cast into the sun map. Glass, water and decals only receive (tlx-shadow.js casters). */
const CASTERS: ReadonlySet<TrackMeshKey> = new Set<TrackMeshKey>(["terrain", "props", "gate"]);

/** Sun map size: tlx-shadow.js:65 (desktop 2048, software GL 512, phones 1024). */
export function sunMapSize(isMobile: boolean, softwareGL: boolean): number {
  return isMobile ? 1024 : softwareGL ? 512 : 2048;
}

/** Distance from the shadow box centre to the light, metres. */
const SUN_DIST = 400;

export interface RenderStats {
  /** Draw calls of the last `renderFrame()`, every pass (shadow, scene, bloom, composite). */
  drawCalls: number;
  triangles: number;
  /** Scene objects (track meshes + cars). */
  objects: number;
}

export interface TrackRendererOptions {
  /** Phone sizing for the sun map (tlx-shadow.js:65). */
  isMobile?: boolean;
  /** SwiftShader / llvmpipe: the 512 sun map. */
  softwareGL?: boolean;
  bloom?: boolean;
}

interface Slot {
  handle: MeshHandle;
  mesh: Mesh;
}

class Car implements CarHandle {
  constructor(readonly model: Object3D) {
    model.rotation.order = "YXZ";
  }
  setPose(x: number, y: number, z: number, yaw: number, pitch: number, roll: number): void {
    this.model.position.set(x, y, z);
    this.model.rotation.set(pitch, yaw, roll);
  }
  setVisible(visible: boolean): void {
    this.model.visible = visible;
  }
}

export class TrackRenderer implements RenderSeam {
  backend: BackendName | null = null;
  renderer: WebGPURenderer | null = null;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(60, 1, 0.5, 6000);
  readonly frame = makeFrameUniforms();
  readonly sun = new DirectionalLight(0xffffff, LIGHT_SCALE);
  readonly hemi = new HemisphereLight(0xffffff, 0xffffff, LIGHT_SCALE);
  readonly stats: RenderStats = { drawCalls: 0, triangles: 0, objects: 0 };
  private readonly material = makeTrackMaterial();
  private readonly slots = new Map<TrackMeshKey, Slot>();
  private readonly cars = new Set<Car>();
  private post: PostChain | null = null;
  private heading: number | null = null;
  private readonly opts: TrackRendererOptions;

  constructor(opts: TrackRendererOptions = {}) {
    this.opts = opts;
    this.scene.backgroundNode = makeSkyNode(this.frame);
    this.scene.fogNode = makeFogNode(this.frame);
    const size = sunMapSize(!!opts.isMobile, !!opts.softwareGL);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(size, size);
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_RANGE;
    cam.right = SHADOW_RANGE;
    cam.top = SHADOW_RANGE;
    cam.bottom = -SHADOW_RANGE;
    cam.near = 1;
    cam.far = SUN_DIST * 2;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun, this.sun.target, this.hemi);
    this.setLighting({
      sunDir: [0.4, 0.75, 0.3],
      sunColor: [1.0, 0.98, 0.9],
      fogColor: [0.62, 0.74, 0.88],
      ambientSky: [0.3, 0.32, 0.36],
      ambientGround: [0.2, 0.19, 0.18],
    });
  }

  async init(canvas: HTMLCanvasElement, opts: RenderInitOptions = {}): Promise<BackendName> {
    const env = browserEnv();
    const { renderer, backend } = await createRenderer(canvas, {
      antialias: opts.antialias ?? true,
      env: opts.forceWebGL ? { ...env, search: "?gl=1" } : env,
    });
    renderer.outputColorSpace = LinearSRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    // Count every pass of a frame, not just the last render() call.
    renderer.info.autoReset = false;
    this.renderer = renderer;
    this.backend = backend;
    this.post = makePost(renderer, this.scene, this.camera, this.opts.bloom ?? true);
    return backend;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    if (!this.renderer) return;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
  }

  uploadTrackMesh(key: TrackMeshKey, data: MeshData): MeshHandle {
    const old = this.slots.get(key);
    if (old) this.freeMesh(old.handle);
    const mesh = new Mesh(buildGeometry(data), this.material);
    mesh.name = `track:${key}`;
    mesh.castShadow = CASTERS.has(key);
    mesh.receiveShadow = true;
    // Static: freeze the matrix (tlx.js keeps track meshes at identity).
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    this.scene.add(mesh);
    const handle: MeshHandle = { key, vertexCount: data.pos.length / 3 };
    this.slots.set(key, { handle, mesh });
    return handle;
  }

  freeMesh(handle: MeshHandle): void {
    const slot = this.slots.get(handle.key);
    if (!slot || slot.handle !== handle) return;
    this.scene.remove(slot.mesh);
    slot.mesh.geometry.dispose();
    this.slots.delete(handle.key);
  }

  addCar(model: Object3D): CarHandle {
    const car = new Car(model);
    this.cars.add(car);
    this.scene.add(model);
    return car;
  }

  removeCar(car: CarHandle): void {
    if (!(car instanceof Car) || !this.cars.delete(car)) return;
    this.scene.remove(car.model);
  }

  /** The player car's heading (f1-game `c.head`), which biases the shadow box (shadow-pass.js:276). */
  setHeading(head: number | null): void {
    this.heading = head;
  }

  setCamera(pose: CameraPose): void {
    const c = this.camera;
    c.position.set(pose.eye[0], pose.eye[1], pose.eye[2]);
    if (pose.up) c.up.set(pose.up[0], pose.up[1], pose.up[2]);
    else c.up.set(0, 1, 0);
    c.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    const fov = (pose.fovY * 180) / Math.PI;
    const near = pose.near ?? c.near;
    const far = pose.far ?? c.far;
    if (fov !== c.fov || near !== c.near || far !== c.far) {
      c.fov = fov;
      c.near = near;
      c.far = far;
      c.updateProjectionMatrix();
    }
    c.updateMatrixWorld();
    this.placeShadow([pose.eye[0], pose.eye[1], pose.eye[2]], [pose.target[0], pose.target[1], pose.target[2]]);
  }

  setLighting(light: FrameLighting): void {
    const U = this.frame;
    const d = light.sunDir;
    U.sunDir.value.set(d[0], d[1], d[2]).normalize();
    U.sunColor.value.set(light.sunColor[0], light.sunColor[1], light.sunColor[2]);
    U.fogColor.value.set(light.fogColor[0], light.fogColor[1], light.fogColor[2]);
    U.fogDensity.value = light.fogDensity ?? 0;
    this.sun.color.setRGB(light.sunColor[0], light.sunColor[1], light.sunColor[2], LinearSRGBColorSpace);
    const sky = light.ambientSky ?? [0.3, 0.32, 0.36];
    const ground = light.ambientGround ?? [0.2, 0.19, 0.18];
    this.hemi.color.setRGB(sky[0], sky[1], sky[2], LinearSRGBColorSpace);
    this.hemi.groundColor.setRGB(ground[0], ground[1], ground[2], LinearSRGBColorSpace);
  }

  private readonly _right = new Vector3();
  private readonly _up = new Vector3();
  private readonly _fwd = new Vector3();
  private placeShadow(eye: Vec3, target: Vec3): void {
    const sd = this.frame.sunDir.value;
    // Light basis: forward = -sunDir; right = forward x worldUp; up = right x forward.
    this._fwd.copy(sd).negate();
    this._right.crossVectors(this._fwd, new Vector3(0, 1, 0));
    if (this._right.lengthSq() < 1e-8) this._right.set(1, 0, 0);
    this._right.normalize();
    this._up.crossVectors(this._right, this._fwd).normalize();
    const r = this._right,
      u = this._up;
    const a = shadowAnchor(eye, target, this.heading, [r.x, r.y, r.z], [u.x, u.y, u.z]);
    // Move the centre onto the snapped light-space cell, keeping its depth along the light.
    const [cx, cy, cz] = a.ctr;
    const du = a.lu - (r.x * cx + r.y * cy + r.z * cz);
    const dv = a.lv - (u.x * cx + u.y * cy + u.z * cz);
    const tx = cx + r.x * du + u.x * dv,
      ty = cy + r.y * du + u.y * dv,
      tz = cz + r.z * du + u.z * dv;
    this.sun.target.position.set(tx, ty, tz);
    this.sun.position.set(tx + sd.x * SUN_DIST, ty + sd.y * SUN_DIST, tz + sd.z * SUN_DIST);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  renderFrame(): void {
    const r = this.renderer;
    if (!r || !this.post) return;
    r.info.reset();
    this.post.pipeline.render();
    this.stats.drawCalls = r.info.render.drawCalls;
    this.stats.triangles = r.info.render.triangles;
    this.stats.objects = this.slots.size + this.cars.size;
  }

  dispose(): void {
    for (const slot of [...this.slots.values()]) this.freeMesh(slot.handle);
    for (const car of [...this.cars]) this.removeCar(car);
    this.material.dispose();
    this.post?.dispose();
    this.post = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.backend = null;
  }
}

/** Create and init a renderer on `canvas`: the entry the shell lane wires into main.ts. */
export async function createTrackRenderer(
  canvas: HTMLCanvasElement,
  opts: RenderInitOptions & TrackRendererOptions = {},
): Promise<TrackRenderer> {
  const r = new TrackRenderer(opts);
  await r.init(canvas, opts);
  return r;
}
