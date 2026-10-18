/**
 * SceneryCore: the track-ENGINE functions the scenery kits call.
 *
 * In f1-game these are globals the kits read (`TrackGeom`, `TrackMesh`,
 * `TrackSpace`, `TrackPit`, `TrackSpline`, `TrackSurface`, `M4`, `Assets`).
 * Here they arrive by injection: every kit's `create` takes a `SceneryCore`.
 * The track lane owns the implementations (src/track/core/); the parity tests
 * inject f1-game's own engine from a Node VM, so each kit is checked against
 * f1-game with the engine held fixed.
 * TODO(lane-track): build a `SceneryCore` from src/track/core once it lands.
 *
 * Members are exactly the ones js/track/scenery/*.js reads (grep
 * `Track(Geom|Mesh|Space|Pit|Spline|Surface)\.` plus build-props.js:7-11 and
 * pits.js's destructures); each cites its f1-game definition.
 */
import type { Basis, MatName, RVec3, SceneryBuffer, SceneryOpts } from "../../contracts/scenery";
import type { Vec3 } from "../../contracts/track";

/** A buffer-like target: `out`, a stage, or a plain-array `emptyBuffer()`. */
export type GeomBuffer = SceneryBuffer;

/** f1-game js/track/core/geom.js:2-369 (`TrackGeom`). */
export interface GeomCore {
  readonly MAT: { readonly [M in MatName]: number };
  /** geom.js:29. */
  readonly SWAY_FRAC: number;
  /** geom.js:32: per-vertex material callback for a swaying plant. */
  swayMatAt(id: number, base: RVec3, up: RVec3, y0: number, y1: number): (x: number, y: number, z: number) => number;
  /** geom.js:58. */
  readonly ROUND_K: number;
  /** geom.js:59; `k` omitted = `ROUND_K` (geom.js:61). */
  roundNormals(out: GeomBuffer, v0: number, base: RVec3, up: RVec3, k?: number): void;
  /** geom.js:360. */
  readonly MIN_SEP: number;
  /** geom.js:366. */
  readonly SEP_SLOTS: readonly number[];
  cross(a: RVec3, b: RVec3): Vec3;
  norm(a: RVec3): Vec3;
  vadd(p: RVec3, v: RVec3, s: number): Vec3;
  /** geom.js:163: one planar polygon, faced away from `ref`. */
  emit(out: GeomBuffer, verts: readonly RVec3[], col: RVec3, ref?: RVec3 | null): boolean;
  /** geom.js:323: a baked mesh, uniform scale + yaw. */
  addMesh(out: GeomBuffer, mesh: BakedMesh, opts?: AddMeshOpts): boolean;
  addBox(out: GeomBuffer, c: RVec3, sz: RVec3, col: RVec3, basis?: Basis): boolean;
  addPrism(out: GeomBuffer, c: RVec3, sz: RVec3, col: RVec3, basis?: Basis): boolean;
  addPyramid(out: GeomBuffer, c: RVec3, sz: RVec3, col: RVec3, basis?: Basis): boolean;
  addCone(out: GeomBuffer, c: RVec3, rad: number, h: number, col: RVec3, seg?: number, basis?: Basis): boolean;
  addCyl(out: GeomBuffer, c: RVec3, rad: number, h: number, col: RVec3, seg?: number, basis?: Basis): boolean;
  addFrustum(out: GeomBuffer, c: RVec3, rBase: number, rTop: number, h: number, col: RVec3, seg?: number, basis?: Basis): boolean;
  addMountain(out: GeomBuffer, c: RVec3, baseR: number, h: number, opts?: SceneryOpts): boolean;
}

/** A baked asset mesh (`Assets.modelSync(id)`), f1-game js/render/shared/assets.js. */
export interface BakedMesh {
  readonly pos: ArrayLike<number>;
  readonly idx: ArrayLike<number>;
  readonly nrm?: ArrayLike<number> | null;
  readonly col?: ArrayLike<number> | null;
  readonly mat?: ArrayLike<number> | null;
  readonly [extra: string]: unknown;
}

/** geom.js:323-330 `addMesh` options. */
export interface AddMeshOpts {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly scale?: number;
  readonly rotY?: number;
  readonly tint?: RVec3 | null;
  readonly mat?: number | null;
}

/** The shared node grid. f1-game js/track/core/mesh.js:601 `nodeGrid`. */
export interface NodeGrid {
  readonly maxHw: number;
  query(x: number, z: number, R: number, out: number[], doSort?: boolean): number;
  queryRects(
    x: number, z: number, R: number,
    a: readonly number[], b: readonly number[] | null, out: number[],
  ): number;
}

/** A corner apex. mesh.js:33-36 `findCorners`. */
export interface Corner {
  readonly k: number;
  readonly sign: number;
  readonly lo: number;
  readonly hi: number;
}

/**
 * The built track as the scenery BUILD reads it (wider than the contract's
 * `SceneryTrack`, which is what circuit closures see).
 * TODO(lane-track): the track lane's built-track type must stay assignable.
 */
export interface BuildTrack {
  readonly total: number;
  readonly n: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  readonly tz: Float32Array;
  readonly rx: Float32Array;
  readonly ry: Float32Array;
  readonly rz: Float32Array;
  readonly hw: Float32Array;
  readonly _night?: boolean;
  /** Members written or read per kit; typed by the kit that owns them. */
  [field: string]: unknown;
}

/** f1-game js/track/core/mesh.js:1564-1566 (`TrackMesh`), the members scenery reads. */
export interface MeshCore {
  upOf(track: BuildTrack, k: number): Vec3;
  hash(i: number): number;
  findCorners(track: BuildTrack, thresh: number): Corner[];
  bankOffsetAt(track: BuildTrack, k: number, o: number): number;
  nodeGrid(track: BuildTrack): NodeGrid;
  buildPitLane(track: BuildTrack, out: GeomBuffer): unknown;
  buildPitBoxes(track: BuildTrack, out: GeomBuffer): unknown;
}

/** A circuit def as the engine's space helpers read it (`_sceneryShift`, `reverse`, …). */
export type SpaceDef = { readonly [key: string]: unknown } | null | undefined;

/** f1-game js/track/core/space.js:158-162 (`TrackSpace`), the members scenery reads. */
export interface SpaceCore {
  wrap01(s: number): number;
  sceneryOriginDelta(def: SpaceDef): number;
  sceneryFrac(def: SpaceDef, authoredFrac: number): number;
  sceneryNode(def: SpaceDef, node: number, count: number): number;
  sceneryNodeToAuthored(def: SpaceDef, engineNode: number, count: number): number;
  sceneryRange(def: SpaceDef, s0: number, s1: number): { s0: number; s1: number };
}

/** f1-game js/track/core/pit.js:484 (`TrackPit`), the members scenery reads. */
export interface PitCore {
  /** pit.js:41: pit-board sign atlas layout. TODO(scenery pits port): type the record. */
  readonly SIGN: { readonly [key: string]: unknown };
  /** pit.js:74. */
  readonly EXIT_WALL_W: number;
  /** pit.js:446: the lane's outer edge beyond `hw` at node `k`. */
  outerAt(pit: unknown, k: number): number;
  /** pit.js:455. */
  openBoundary(track: BuildTrack): void;
}

/** A centreline sample. f1-game js/track/core/spline.js:90. */
export interface SplineSample {
  p: Vec3;
  t: Vec3;
  r: Vec3;
  hw: number;
}

/** f1-game js/track/core/spline.js:297 (`TrackSpline`), the members scenery reads. */
export interface SplineCore {
  sample(track: BuildTrack, s: number, out: SplineSample): SplineSample;
  /** Scenery placement only (build-props.js:9); never reaches the driver. */
  curvature(track: BuildTrack, s: number): number;
  project(track: BuildTrack, wx: number, wz: number, hint?: number, wy?: number): {
    s: number; lat: number; k: number; heading: number; dist: number;
  };
}

/** f1-game js/track/core/surface.js:180 (`TrackSurface`). */
export interface SurfaceCore {
  profile(def: SpaceDef, track: BuildTrack): unknown;
  heightAt(surface: unknown, k: number, lateralDistance: number): number;
}

/** f1-game js/core/mat4.js scalar helpers (`M4.lerp`, `M4.clamp`). */
export interface ScalarCore {
  lerp(a: number, b: number, t: number): number;
  clamp(v: number, lo: number, hi: number): number;
}

/**
 * f1-game js/track/tracks.js:775 (`Tracks`), the members scenery reads.
 * structures.js:188 (`fence`) is the one kit that reads the track shell.
 */
export interface TracksCore {
  /** tracks.js:723: rendered-terrain height at world XZ, or null off the terrain mesh. */
  terrainY(track: BuildTrack, x: number, z: number): number | null;
}

/** f1-game `Assets` (js/render/shared/assets.js): baked models by id. */
export interface AssetsCore {
  modelSync(id: string): BakedMesh | null;
}

/** f1-game js/track/tracks.js:775 (`Tracks`), the members scenery reads. */
export interface TracksCore {
  /** tracks.js:723: drawn-terrain height at world XZ, or null off the terrain mesh. */
  terrainY(track: BuildTrack, x: number, z: number): number | null;
}

export interface SceneryCore {
  readonly geom: GeomCore;
  readonly mesh: MeshCore;
  readonly space: SpaceCore;
  readonly pit: PitCore;
  readonly spline: SplineCore;
  readonly surface: SurfaceCore;
  readonly scalar: ScalarCore;
  readonly tracks: TracksCore;
  /** Absent in a build without the asset pack (bakedModel then returns false). */
  readonly assets: AssetsCore | null;
  /**
   * The track shell's terrain lookup. f1-game guards each use with
   * `typeof Tracks !== "undefined"` (nature.js:613, :1314, :1343), so null
   * takes the same fallback.
   */
  readonly tracks: TracksCore | null;
}
