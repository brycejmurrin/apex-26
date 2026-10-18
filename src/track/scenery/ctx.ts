/**
 * BuildCtx: the shared scenery BUILD context, and the track/def shapes the
 * props pass reads and writes.
 *
 * f1-game js/track/scenery/build-props.js:1337-1361 assembles `ctx` (output
 * buffers, guarded emitters, guard/grounding/boundary core, placement helpers,
 * the prop registry), then each kit extends it in turn with
 * `Object.assign(ctx, Kit.create(ctx))` (:1362-1365): SceneryNature,
 * SceneryStructures, SceneryCity, SceneryIdentity. A later kit therefore sees
 * the members the earlier ones added, which is why the kit members are
 * `Partial` here. Members a circuit closure also sees reuse the
 * `SceneryApi` member types; the rest are typed from their build-props.js
 * definitions (cited). Kit-only outputs build-props never calls are `unknown`:
 * each kit port owns their shape.
 * TODO(scenery integration): replace the loose kit outputs with each kit's
 * own `<Kit>Api` once those ports land.
 */
import type {
  Basis, MatName, RVec3, SceneryApi, SceneryBuffer, SceneryDef, SceneryOpts, SceneryTrack,
} from "../../contracts/scenery";
import type { Vec3 } from "../../contracts/track";
import type { BuildTrack, GeomCore, MeshCore, SurfaceProfile } from "./core";
import type { FurnitureRow, KitRow } from "./data";

/** A growable accumulator as build-props reads it: models.js makeAccum exposes storage as `_data`. */
export interface DataAccum {
  readonly length: number;
  push(...values: number[]): void;
  readonly _data?: ArrayLike<number>;
}

/**
 * A buffer the guarded emitters write into: `out`, `glassBuf`, `waterBuf`, or
 * a graph stage. The underscore flags are the graph's dry-run / replay
 * protocol (f1-game js/track/scenery/graph.js `instance`), read and written by
 * the guarded emitters (build-props.js:472-551) and `instance` (:570-581).
 */
export interface StageBuffer extends SceneryBuffer {
  /** Tri-state guard verdicts to replay (1 pass, 0 culled, 2 invalid). */
  _replayVerdicts?: ArrayLike<number> | null;
  /** Verdicts being recorded by a dry run. */
  _recVerdicts?: number[] | null;
  _vIdx?: number;
  _dryRun?: boolean;
  _absorbOnly?: boolean;
  _pitRejected?: boolean;
  _preferInstance?: boolean;
}

/** The raw (unguarded) TrackGeom emitters. build-props.js:13 `RAW`. */
export interface RawEmitters {
  readonly addBox: GeomCore["addBox"];
  readonly addCyl: GeomCore["addCyl"];
  readonly addCone: GeomCore["addCone"];
  readonly addFrustum: GeomCore["addFrustum"];
  readonly addPrism: GeomCore["addPrism"];
  readonly addPyramid: GeomCore["addPyramid"];
  readonly addMountain: GeomCore["addMountain"];
  /**
   * Never set: build-props.js:575 reads `RAW.roundNormals`, which the RAW
   * literal (:13) does not carry, so the graph receives `undefined` there.
   */
  readonly roundNormals?: GeomCore["roundNormals"];
}

/** The six guarded (or raw-but-flag-aware) emitters handed to the graph. build-props.js:552-563. */
export interface GraphEmitters {
  readonly addBox: SceneryApi["addBox"];
  readonly addCyl: SceneryApi["addCyl"];
  readonly addCone: SceneryApi["addCone"];
  readonly addFrustum: SceneryApi["addFrustum"];
  readonly addPrism: SceneryApi["addPrism"];
  readonly addPyramid: SceneryApi["addPyramid"];
  readonly roundNormals?: GeomCore["roundNormals"] | undefined;
}

/** A model placement for `instance` (graph.js:213-217 validates o/r/u/t). */
export interface GraphPlace {
  readonly o: RVec3;
  readonly r: RVec3;
  readonly u: RVec3;
  readonly t: RVec3;
  readonly s?: RVec3;
}

/** The recorder a graph model's build callback receives (graph.js `model`). */
export interface GraphRecorder {
  box(c: RVec3, sz: RVec3, col: RVec3, basis?: Basis): unknown;
  /** TODO(scenery graph port): the other recorder ops. */
  readonly [op: string]: unknown;
}

/** `instance` meta (graph.js:213): kind/k/side for the registry, plus `whole`. */
export type GraphMeta = { readonly kind?: string; readonly k?: number; readonly side?: number } & SceneryOpts;

/** `instance(key, place, build, meta, opts?)` options. build-props.js:564-569. */
export interface InstanceOpts {
  readonly buf?: StageBuffer;
  readonly unguarded?: boolean;
  readonly roundNormals?: boolean;
}

/** TrackGraph.create(...) result, the members build-props calls. f1-game js/track/scenery/graph.js:475. */
export interface GraphApi {
  instance(key: string, place: GraphPlace, build: (rec: GraphRecorder) => unknown, meta: GraphMeta,
    emit: GraphEmitters, out: StageBuffer): number;
  /** graph.js:304. */
  meshModel(key: string, mesh: import("./core").BakedMesh, mat: number | null): { readonly verts: number; readonly tris: number };
  /** graph.js:334. */
  meshPlace(key: string, x: number, y: number, z: number, yaw: number, scale: number, tint: RVec3 | null): void;
  readonly [member: string]: unknown;
}

/** The pit record (f1-game js/track/core/pit.js) as build-props and the guards read it. */
export interface PitInfo {
  readonly painted?: boolean;
  readonly keep: ArrayLike<number>;
  readonly side: number;
  readonly hasBays?: boolean;
  readonly [field: string]: unknown;
}

/** A post footprint. build-props.js:606-612 (`track.posts`). */
export interface PostRecord {
  readonly s: number;
  readonly side: number;
  readonly lat: number;
  readonly halfX: number;
  readonly halfS: number;
}

/** A named placement in the prop registry. build-props.js:332-347 (`note`). */
export interface PropRecord {
  kind: string;
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  measured?: boolean;
  parts?: number;
  fill?: number;
  _m?: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };
  [extra: string]: unknown;
}

/** A linear-feature span record. build-props.js:363-369 (`noteSpan`). */
export interface SpanRecord {
  kind: string;
  s0: number;
  s1: number;
  side: number;
  gap: number;
  [extra: string]: unknown;
}

/** `track.props`. build-props.js:441-442. */
export interface PropsRegistry {
  readonly list: PropRecord[];
  readonly spans: SpanRecord[];
  readonly cap: number;
  count: number;
  spanCount: number;
  dropped: number;
}

/** Mutable model diagnostics (`track.modelDiagnostics`). build-props.js:307-312. */
export interface BuildDiagnostics {
  readonly emitted: unknown[];
  readonly suppressed: unknown[];
  readonly invalid: unknown[];
  readonly unsafe: unknown[];
  readonly suppressedCounts: { [kind: string]: number };
  readonly supersededByPit: { [kind: string]: number };
}

/** A lamp record on `track.lampPosts`. build-props.js:1872-1884 (`lampRec`) and :2140. */
export interface LampRecord {
  k: number;
  side: number;
  x: number;
  y: number;
  z: number;
  kind: string;
  custom?: boolean;
  mast?: boolean;
  pit?: boolean;
  entry?: boolean;
  always?: boolean;
  aim?: [number, number, number];
  aimAt?: [number, number, number];
  energy?: number;
  radius?: number;
}

/** A lamp registration spec (`lampPost`, `registerMastLamp`, SceneryPits' `registerLamp`). build-props.js:1872-1884. */
export type LampSpec = {
  readonly pos?: unknown;
  readonly id?: unknown;
  readonly k?: unknown;
  readonly side?: unknown;
  readonly kind?: unknown;
  readonly entry?: unknown;
  readonly always?: unknown;
  readonly aim?: unknown;
  readonly aimAt?: unknown;
  readonly energy?: unknown;
  readonly radius?: unknown;
} & SceneryOpts;

/** A baked-model placement record (`track.modelInstances[key]`). build-props.js:1851-1852. */
export interface ModelInstanceRecord {
  readonly id: string;
  readonly mat: number | null;
  readonly verts: number;
  readonly tris: number;
  readonly n: number;
  readonly inst: boolean;
  readonly xf: Float32Array;
  readonly tint: Float32Array | null;
}

/** `def.furniture` / FURN_DEF row plus the two tuning keys build-props reads (:1543-1563). */
export interface BuildFurniture extends FurnitureRow {
  readonly vary?: number;
  readonly autumn?: number | false;
}

/** `def.barrier` livery (build-props.js:1382). */
export interface BarrierLivery {
  readonly a: RVec3;
  readonly b: RVec3;
  readonly c: RVec3;
  readonly night: RVec3;
  readonly tyre: RVec3;
}

/** A `def.dressingExclusions` rule as authored (build-props.js:1228-1235). */
export interface DressingExclusion {
  readonly kinds?: readonly string[];
  readonly kind?: string;
  readonly s0?: number | string | null;
  readonly s1?: number | string | null;
  readonly side?: number | string | null;
}

/**
 * The circuit def as the props BUILD reads it (wider than the contract's
 * `SceneryDef`, which is what circuit closures see).
 * TODO(T1.1): CircuitDef from src/circuits/types.ts must stay assignable.
 */
export interface BuildDef extends SceneryDef {
  readonly night?: boolean;
  readonly turns?: readonly number[];
  readonly furniture?: BuildFurniture;
  readonly kit?: KitRow;
  readonly barrier?: BarrierLivery;
  /** TODO(T1.1): CityStyleRaw from data.ts once CircuitDef lands. */
  readonly cityStyle?: import("./data").CityStyleRaw | null;
  readonly ownPitStraight?: boolean;
  readonly dressingExclusions?: readonly DressingExclusion[];
  readonly sceneryTheme?: string;
  readonly sceneryThemeOverrides?: unknown;
  readonly sceneryCoordinates?: string;
  readonly sceneryLapMirror?: boolean;
  readonly bridges?: readonly { readonly s: number }[];
  /** An inline closure (harness probe or a not-yet-split circuit), build-props.js:1972. */
  readonly scenery?: ((api: SceneryApi) => void) | null;
  /** The rest of the def (the engine's TrackSpace helpers read it as a record). */
  readonly [field: string]: unknown;
}

/** The gfx backend bits build-props reads (`track._gfx || GLX`). build-props.js:230-231, :578, :1830. */
export interface GfxBackend {
  readonly mobileTier?: boolean;
  readonly createInstancedBatch?: unknown;
}

/**
 * The built track as the props pass reads and WRITES it. The written members
 * (barL/barR, posts, props, graph, lampPosts, …) are declared present: they
 * exist once buildSteps has run its prologue.
 */
export interface PropsTrack extends BuildTrack {
  readonly def: BuildDef;
  readonly _night?: boolean;
  readonly _weather?: string;
  readonly _gfx?: GfxBackend | null;
  readonly terrainGeo?: { readonly pos: ArrayLike<number>; readonly idx: ArrayLike<number> } | null;
  readonly surface?: SurfaceProfile | null;
  readonly pit?: PitInfo | null;
  barL: Float32Array;
  barR: Float32Array;
  posts: PostRecord[];
  props: PropsRegistry;
  modelDiagnostics: BuildDiagnostics;
  graph: GraphApi;
  lampPosts: LampRecord[];
  hasAlwaysLamps: boolean;
  modelInstances: { [key: string]: ModelInstanceRecord };
  pitBuilt: unknown;
}

/** SceneryGuards.create(...) result. f1-game js/track/scenery/guards.js:186. */
export interface GuardsApi {
  readonly pitKeep: ArrayLike<number> | null;
  readonly pitSide: number;
  /** guards.js:46. */
  inPitFootprint(k: number, lat: number, halfLat: number, outerMargin?: number): boolean;
  /** guards.js:65. */
  onRoadHit(cx: number, cz: number, topY: number, rad: number, arx: number, arz: number,
    afx: number, afz: number, hx: number, hz: number, botY?: number): boolean;
  /** guards.js:129. */
  rejBox(c: RVec3, sz: RVec3, basis?: Basis): boolean;
  /** guards.js:135. */
  rejRad(c: RVec3, rad: number, h: number, basis?: Basis, crown?: boolean): boolean;
  /** guards.js:146. */
  onTrack(x: number, z: number, margin: number, pitMargin?: number): boolean;
  pitRejected(): boolean;
}

/** TrackModels.waterSurface spec. build-props.js:787. */
export interface WaterSurfaceSpec {
  readonly id: unknown;
  readonly center: RVec3;
  readonly size: RVec3;
  readonly color: RVec3;
  readonly required: unknown;
}

/** TrackModels.create(...) result, the members build-props calls. f1-game js/track/scenery/models.js:620-623. */
export interface ModelsApi {
  readonly diagnostics: BuildDiagnostics;
  modelGroup: SceneryApi["modelGroup"];
  overheadSpan: SceneryApi["overheadSpan"];
  waterSurface(spec: WaterSurfaceSpec): boolean;
  groundPatch(spec: SceneryOpts): boolean;
  groundedSegments(spec: SceneryOpts): boolean;
  readonly [member: string]: unknown;
}

/** A centreline frame as `frameAt` returns it (build-props.js:623-632). */
export type BuildFrame = ReturnType<SceneryApi["frameAt"]>;

/** TrackModels.create options (`modelsOpts`, build-props.js:635-695). */
export interface ModelsCtx {
  readonly out: StageBuffer;
  readonly water: StageBuffer;
  readonly diagnostics: BuildDiagnostics;
  readonly n: number;
  readonly track: PropsTrack;
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly hw: Float32Array;
  readonly note: BuildCtxBase["note"];
  readonly rails: unknown;
  readonly upOf: MeshCore["upOf"];
  readonly emitFace: GeomCore["emit"];
  terrainY(x: number, z: number): number | null;
  preflight(bounds: { readonly center: RVec3; readonly size: RVec3; readonly basis?: Basis }): boolean | "pit";
  emitBox(buf: StageBuffer, c: RVec3, size: RVec3, col: RVec3, basis?: Basis): boolean;
  inPit(k: number, side: number, dist: number, halfLat: number): boolean;
  readonly frameAt: SceneryApi["frameAt"];
  supportClear(frame: BuildFrame, spec: {
    readonly supports?: boolean; readonly supportGap?: number | null; readonly supportWidth?: number | null;
    readonly clearance?: number; readonly depth?: number;
  }): boolean;
  readonly groundHeight: SceneryApi["groundYAt"];
  groundPoint(k: number, side: number, dist: number, y: number): Vec3;
  /** Wired after construction (build-props.js:941). */
  recordBarrier?: SceneryApi["recordBarrier"];
}

/** A city-front tone pair (`toneFor`, build-props.js:1655-1660). */
export interface CityTone {
  readonly n: RVec3 | null | undefined;
  readonly d: RVec3 | null | undefined;
}

/** The members SceneryNature.create adds (f1-game js/track/scenery/nature.js:1573-1576). */
export type NatureOut = Pick<SceneryApi,
  | "anchor" | "groundUnder" | "pine" | "tree" | "palm" | "conifer"
  | "cypress" | "stonePine" | "broadleafFall" | "acacia" | "plane"
  | "peak" | "mountain" | "ridge" | "grandstand" | "grandstandEx" | "spectatorHill"
  | "bush" | "hedge" | "forestEdge"> & {
  /** nature.js:927. */
  crowdBank(k: number, side: number, gap: number, len: number, rise: number, depth: number, riserCol: RVec3, lift?: number): void;
  /** nature.js:1442. */
  canopyR(kind: string, h: number): number;
  /** nature.js:1467: the deferred treeline body. */
  forestEdgeNow: SceneryApi["forestEdge"];
  /** nature.js:1465-1466: queued `forestEdge` argument lists. */
  readonly deferredFoliage: Parameters<SceneryApi["forestEdge"]>[];
  readonly treeInFootprint: unknown;
};

/** The members SceneryStructures.create adds (structures.js:1050-1053). */
export type StructuresOut = Pick<SceneryApi,
  | "along" | "wall" | "fence" | "guardrail" | "tyreWall" | "gantry"
  | "marshalPost" | "cameraTower" | "sponsorHoarding" | "signDigit" | "signBoard"
  | "ferrisWheel" | "bleacher" | "scaffoldStand" | "terrace" | "tieredBowl"> & {
  readonly flagQuad: unknown;
};

/** The members SceneryCity.create adds (city.js:924-925). */
export type CityOut = Pick<SceneryApi,
  "building" | "cityFront" | "house" | "motorhome" | "tower" | "billboard"> & {
  readonly neonFacade: unknown;
  readonly streetLamp: unknown;
  /** city.js:428 (`neonTowerBody` args). */
  neonTower(k: number, side: number, dist: number, w: number, h: number, d: number,
    neon: RVec3, kind: string, tone: CityTone, na: number): void;
  /** city.js:685. */
  neonSign(k: number, side: number, dist: number, h: number, neon: RVec3): void;
};

/** The members SceneryIdentity.create adds (identity.js:442-444). */
export type IdentityOut = Pick<SceneryApi,
  | "underpassPortal" | "floodMast" | "floodMastRing" | "ledFacadeBands"
  | "concreteCanyon" | "sailCanopy" | "gridshellCanopy" | "runoffApron"
  | "bankedKerbStrip" | "bowlSeatWall" | "pastelStreetRow" | "broadcastCompound">;

/** The ctx literal itself. build-props.js:1336-1361 (+ `registerMastLamp`, :1948). */
export interface BuildCtxBase {
  // output buffers + per-build state
  readonly out: StageBuffer;
  readonly glassBuf: StageBuffer;
  readonly waterBuf: StageBuffer;
  readonly track: PropsTrack;
  readonly def: BuildDef;
  readonly theme: string | undefined;
  readonly pal: SceneryApi["pal"];
  readonly n: number;
  readonly ds: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly hw: Float32Array;
  readonly pyMin: number;
  readonly NIGHT: boolean;
  readonly MAT: { readonly [M in MatName]: number };
  /** Mobile city LOD: shrink a count, never below `floor` (build-props.js:232). */
  lod(nn: number, floor: number): number;
  // guarded emitters + the raw escape hatch
  readonly addBox: SceneryApi["addBox"];
  readonly addCyl: SceneryApi["addCyl"];
  readonly addCone: SceneryApi["addCone"];
  readonly addFrustum: SceneryApi["addFrustum"];
  readonly addPrism: SceneryApi["addPrism"];
  readonly addPyramid: SceneryApi["addPyramid"];
  readonly addMountain: SceneryApi["addMountain"];
  readonly emit: GeomCore["emit"];
  readonly RAW: RawEmitters;
  readonly rejBox: GuardsApi["rejBox"];
  readonly rejRad: GuardsApi["rejRad"];
  readonly graph: GraphApi;
  /** build-props.js:570. Returns primitives that survived the guards. */
  instance(key: string, place: GraphPlace, build: (rec: GraphRecorder) => unknown, meta: GraphMeta, opts?: InstanceOpts): number;
  // guard / grounding / boundary core
  /** build-props.js:590. */
  markBarrier(k: number, side: number, gap: number): void;
  /** build-props.js:595. */
  blockAt(k: number, side: number, innerGap: number, halfM?: number): void;
  /** build-props.js:607. */
  post(k: number, side: number, dist: number, halfX: number, halfM: number): void;
  readonly recordBarrier: SceneryApi["recordBarrier"];
  /** build-props.js:942. */
  indexBarrier(s0: number, s1: number, side: number, gap: number): void;
  /** build-props.js:1142: adjusted trunk distance, or null (drop the tree). */
  clearTreeDist(k: number, side: number, dist: number, crown: number): number | null;
  readonly indexSolid: SceneryApi["indexSolid"];
  /** build-props.js:964. */
  indexSolidAt(k: number, side: number, dist: number, halfW?: number, halfLen?: number): void;
  /** build-props.js:1122. */
  barrierClear(x: number, z: number, r: number): boolean;
  /** build-props.js:1012. */
  massBlocked(c: RVec3, w: number, d: number, b: Basis, shrink?: number): boolean;
  /** build-props.js:1039. */
  massAdd(c: RVec3, w: number, d: number, b: Basis): void;
  /** build-props.js:1049. */
  reserveEmittedSolid(buf: SceneryBuffer, start: number, basis: Basis): boolean;
  readonly bankOffsetAt: MeshCore["bankOffsetAt"];
  readonly seat: SceneryApi["seat"];
  readonly foundation: SceneryApi["foundation"];
  readonly cantilever: SceneryApi["cantilever"];
  readonly groundYAt: SceneryApi["groundYAt"];
  readonly terrainYAt: SceneryApi["terrainYAt"];
  readonly onTrack: SceneryApi["onTrack"];
  readonly frameAt: SceneryApi["frameAt"];
  readonly overheadSpan: SceneryApi["overheadSpan"];
  readonly models: ModelsApi;
  // placement primitives + math helpers
  readonly place: SceneryApi["place"];
  readonly prop: SceneryApi["prop"];
  readonly backdrop: SceneryApi["backdrop"];
  readonly groundPlane: SceneryApi["groundPlane"];
  readonly every: SceneryApi["every"];
  readonly hash: SceneryApi["hash"];
  readonly upOf: MeshCore["upOf"];
  readonly cross: SceneryApi["cross"];
  readonly norm: SceneryApi["norm"];
  readonly lerp: SceneryApi["lerp"];
  readonly vadd: SceneryApi["vadd"];
  // semantic prop registry
  /** build-props.js:332. */
  note(kind: string, c: RVec3, size: RVec3, extra?: { readonly [key: string]: unknown } | null): PropRecord | null;
  /** build-props.js:353. */
  unnote(rec: PropRecord | null | undefined): void;
  /** build-props.js:363. */
  noteSpan(kind: string, s0: number, s1: number, side: number, gap: number, extra?: { readonly [key: string]: unknown } | null): void;
  /** build-props.js:299. */
  noteSuppressed(kind: string, msg: string): void;
  /** build-props.js:1356: the def's (or theme's) kit row entry for `family`. */
  kitOf<T>(family: string, fallback: T): string | T;
  /** Set once the lamp registries exist (build-props.js:1948). */
  registerMastLamp?: (spec: LampSpec | null | undefined) => boolean;
}

/** What a kit's `create(ctx)` receives: the literal plus whatever earlier kits added. */
export type BuildCtx = BuildCtxBase & Partial<NatureOut & StructuresOut & CityOut & IdentityOut>;

/** Re-exported for kit ports that read the closure-facing track. */
export type { SceneryTrack };
