/**
 * RenderSeam: the Phase 1 slice of f1-game's renderer facade
 * (js/render/gfx.js:27-200, "THE BACKEND INTERFACE CONTRACT"), re-cut for one
 * three.js WebGPURenderer backend.
 *
 * Kept from f1-game: init/resize lifecycle, uploading a lit mesh from
 * `{ pos, nrm, col, idx }` (js/render/glx/glx.js:1213 `createMesh`, called by
 * js/track/tracks.js:304-331 for every track ribbon), and a per-frame
 * render. Dropped: the begin/draw/present frame protocol, shadow/mirror/env
 * passes and the stride-15 `frame.lights` array. three's scene graph owns
 * draw order, so callers hand over objects and poses, not draw calls.
 */
import type { Object3D } from "three/webgpu";
import type { Vec3 } from "./track";

/** Which backend WebGPURenderer bound after `init()` (src/render/backend.ts). */
export type BackendName = "WebGPU" | "WebGL2";

/**
 * A lit mesh in f1-game's vertex format (glx.js:1213-1236): `pos`/`nrm`/`col`
 * are 3 floats per vertex (`col` linear RGB), `idx` triangle indices. Optional
 * `mat` is the per-vertex `MAT` id (glx.js:1235) and `trk` the road's
 * (s, lateral, half-width) triple per vertex (glx.js:1236), which the road
 * shader uses for analytic markings.
 */
export interface MeshData {
  readonly pos: Float32Array;
  readonly nrm: Float32Array;
  readonly col: Float32Array;
  readonly idx: Uint16Array | Uint32Array;
  readonly mat?: Float32Array;
  readonly trk?: Float32Array;
}

/**
 * Track mesh slots: f1-game's `track.meshes[key]` in js/track/tracks.js
 * (`road` :334 and `terrain` :338 via `buildRibbon`, `floor` :331,
 * `props` :386, `glass` :415, `water` :416, `gate` :417, `startline` :418).
 */
export type TrackMeshKey = "road" | "terrain" | "floor" | "props" | "glass" | "water" | "gate" | "startline";

/** Opaque handle for an uploaded mesh. */
export interface MeshHandle {
  readonly key: TrackMeshKey;
  readonly vertexCount: number;
}

/** A car in the scene. The car lane (PLAN T1.8) builds the `Object3D`. */
export interface CarHandle {
  /**
   * World pose: position, then yaw (f1-game `c.head`, radians about +Y), pitch
   * and roll. Called once per rendered frame with interpolated values.
   */
  setPose(x: number, y: number, z: number, yaw: number, pitch: number, roll: number): void;
  setVisible(visible: boolean): void;
}

/**
 * Camera for the frame. f1-game hands a `viewProj` matrix plus `eye`
 * (gfx.js frame object); three wants a pose, so the seam takes eye/target.
 * `fovY` is the vertical field of view in RADIANS, as f1-game's
 * `lens.fovY` (types/game-ctx.d.ts `lens`).
 */
export interface CameraPose {
  readonly eye: Readonly<Vec3>;
  readonly target: Readonly<Vec3>;
  readonly fovY: number;
  /** Defaults to +Y. */
  readonly up?: Readonly<Vec3>;
  readonly near?: number;
  readonly far?: number;
}

/**
 * Per-frame lighting: the REQUIRED members of f1-game's `frame` object
 * (gfx.js "frame object consumed by begin()": sunDir, sunColor, fogColor)
 * plus the hemisphere ambient. Everything else waits for the lighting wave.
 */
export interface FrameLighting {
  readonly sunDir: Readonly<Vec3>;
  readonly sunColor: Readonly<Vec3>;
  readonly fogColor: Readonly<Vec3>;
  readonly fogDensity?: number;
  readonly ambientSky?: Readonly<Vec3>;
  readonly ambientGround?: Readonly<Vec3>;
}

export interface RenderInitOptions {
  /** Force three's WebGL2 backend (boot policy, PLAN T0.3). */
  readonly forceWebGL?: boolean;
  readonly antialias?: boolean;
}

export interface RenderSeam {
  /**
   * Create the renderer on `canvas` and await `init()`. Resolves with the
   * backend actually bound (three falls back to WebGL2 silently).
   * f1-game: `init(canvas) -> bool` (gfx.js:34).
   */
  init(canvas: HTMLCanvasElement, opts?: RenderInitOptions): Promise<BackendName>;
  /** The bound backend, or null before `init()` resolves. */
  readonly backend: BackendName | null;
  /**
   * Resize the drawing buffer to CSS `width` x `height` at `pixelRatio`
   * (f1-game caps DPR at 2, 1.5 on mobile: gfx.js:37 `resize()`).
   */
  resize(width: number, height: number, pixelRatio: number): void;

  /** Upload (or replace) the track mesh in slot `key`. f1-game `createMesh(data)`. */
  uploadTrackMesh(key: TrackMeshKey, data: MeshData): MeshHandle;
  /** f1-game `freeMesh(mesh)`. */
  freeMesh(handle: MeshHandle): void;

  /** Add a car model to the scene; the renderer owns it until `removeCar`. */
  addCar(model: Object3D): CarHandle;
  removeCar(car: CarHandle): void;

  setCamera(pose: CameraPose): void;
  setLighting(light: FrameLighting): void;

  /** Render one frame with the current camera, lighting and poses. */
  renderFrame(): void;
  /** Release the renderer and every uploaded resource. */
  dispose(): void;
}
