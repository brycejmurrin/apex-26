/**
 * SceneryKits: the scenery kits the props BUILD calls, injected.
 *
 * In f1-game, js/track/scenery/build-props.js reads each kit as a global
 * (`TrackModels`, `TrackGraph`, `SceneryGuards`, `SceneryNature`, …) at build
 * time. Here `buildSteps(track, core, kits)` receives them, one member per
 * global, each typed by exactly the members build-props calls (cited). The
 * engine (TrackGeom, TrackMesh, TrackSpace, …) comes separately as
 * `SceneryCore` (core.ts).
 *
 * Optional members are the ones build-props guards with `typeof X !==
 * "undefined"` (SceneryThemes, LandmarkKit, CircuitKit, SceneryPits,
 * LightTune, GLX, window.TrackScenery); the rest it calls unconditionally.
 * TODO(scenery integration): build a `SceneryKits` from the TS kit ports
 * (`import * as SceneryNature from "./nature"` …) once they land.
 */
import type {
  CircuitKit, LandmarkKit, RVec3, Basis, SceneryApi, SceneryBuffer, SceneryFn, SceneryTheme,
} from "../../contracts/scenery";
import type { MeshCore } from "./core";
import type * as Data from "./data";
import type {
  BuildCtx, CityOut, GfxBackend, GraphApi, GuardsApi, IdentityOut, LampSpec, ModelsApi, ModelsCtx,
  NatureOut, PropsTrack, RawEmitters, StageBuffer, StructuresOut,
} from "./ctx";
import type { NodeGrid } from "./core";

/** Geometry after `sealGeometry` (accumulators swapped for typed arrays). TODO(scenery models port): type it. */
export type SealedGeometry = unknown;

/** f1-game js/track/scenery/models.js:782 (`TrackModels`), the members build-props calls. */
export interface TrackModelsKit {
  /** models.js:52. */
  scratch(verts?: number): StageBuffer;
  /** models.js:196. */
  create(ctx: ModelsCtx): ModelsApi;
  /** models.js:68. */
  sealGeometry(geo: StageBuffer): SealedGeometry;
  /** models.js:663: `drape`/`drapeRun` composed from the FINAL scenery api. */
  drapeKit(api: Omit<SceneryApi, "drape" | "drapeRun">): Pick<SceneryApi, "drape" | "drapeRun">;
}

/** f1-game js/track/scenery/graph.js:478 (`TrackGraph`). */
export interface TrackGraphKit {
  /** graph.js:52. */
  create(ctx: { readonly raw: RawEmitters }): GraphApi;
}

/** f1-game js/track/scenery/themes.js (`SceneryThemes`). */
export interface SceneryThemesKit {
  resolve(name: string, overrides: unknown, context: { readonly night: boolean; readonly weather: string }): SceneryTheme;
}

/** The primitives LandmarkKit.create receives (build-props.js:694-702). */
export interface LandmarkPrimitives {
  box(stage: SceneryBuffer, c: RVec3, size: RVec3, color: RVec3, basis?: Basis): boolean;
  prism(stage: SceneryBuffer, c: RVec3, size: RVec3, color: RVec3, basis?: Basis): boolean;
  cylinder(stage: SceneryBuffer, c: RVec3, radius: number, height: number, color: RVec3, seg?: number, basis?: Basis): boolean;
  frustum(stage: SceneryBuffer, c: RVec3, rB: number, rT: number, h: number, color: RVec3, seg?: number, basis?: Basis): boolean;
}

/** f1-game js/track/scenery/landmark-kit.js:28 (`LandmarkKit.create`). */
export interface LandmarkKitKit {
  create(primitives: LandmarkPrimitives): LandmarkKit;
}

/** The dependencies CircuitKit.create receives (build-props.js:708-715). */
export interface CircuitKitDeps {
  readonly models: ModelsApi;
  readonly landmarks: LandmarkKit;
  readonly theme: SceneryTheme;
  readonly frameAt: SceneryApi["frameAt"];
  readonly groundHeight: SceneryApi["groundYAt"];
  readonly hash: SceneryApi["hash"];
  readonly pitBuilt: boolean;
}

/** f1-game js/track/scenery/circuit-kit.js:64 (`CircuitKit.create`). */
export interface CircuitKitKit {
  create(deps: CircuitKitDeps): CircuitKit;
}

/** What SceneryGuards.create receives (build-props.js:458). */
export interface GuardsCtx {
  readonly track: PropsTrack;
  readonly n: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly hw: Float32Array;
  readonly ds: number;
  readonly grid: NodeGrid;
}

/** f1-game js/track/scenery/guards.js:189 (`SceneryGuards`). */
export interface SceneryGuardsKit {
  create(ctx: GuardsCtx): GuardsApi;
}

/** A kit that extends the build ctx: `Object.assign(ctx, Kit.create(ctx))` (build-props.js:1362-1365). */
export interface CtxKit<Out> {
  create(ctx: BuildCtx): Out;
}

/** f1-game js/track/scenery/venue.js:9 (`SceneryVenue.build(ctx, theme, excluded)`). */
export interface SceneryVenueKit {
  build(ctx: BuildCtx, theme: SceneryTheme | null, excluded: (kind: string, k: number, side: number | null) => boolean): void;
}

/** What SceneryPits.build receives (build-props.js:2218-2219). */
export interface PitsBuildCtx {
  readonly track: PropsTrack;
  readonly out: StageBuffer;
  readonly rawBox: RawEmitters["addBox"];
  readonly rawEmit: import("./core").GeomCore["emit"];
  readonly upOf: MeshCore["upOf"];
  readonly bankOffsetAt: MeshCore["bankOffsetAt"];
  curvature(s: number): number;
  readonly night: boolean;
  lensAlbedo(kind: string): RVec3;
  registerLamp(spec: LampSpec | null | undefined): boolean;
}

/** SceneryPits.build result (pits.js:54 and its final return). */
export interface PitsBuilt {
  readonly bays: number;
  readonly wall: boolean;
  readonly lamps?: number;
  readonly [field: string]: unknown;
}

/** f1-game js/track/scenery/pits.js:51 (`SceneryPits.build`). */
export interface SceneryPitsKit {
  build(ctx: PitsBuildCtx): PitsBuilt;
}

/** The TrackSceneryData tables build-props destructures (build-props.js:214-216, :1357). */
export type SceneryDataKit = Pick<typeof Data,
  | "NC" | "DC" | "BLD" | "CROWD_DAY" | "WINTINTS" | "HOUSE_WALLS" | "HOUSE_ROOFS"
  | "MOTORHOME_BODY" | "SIGN_SEG" | "SIGN_DIGIT" | "FURN_DEF" | "THEME_DEF" | "ATM" | "COL"
  | "resolveCityStyle" | "KIT_DEF">;

/** f1-game js/track/tracks.js:723 `Tracks.terrainY` (read by `foundation` and models' `terrainY`). */
export interface TracksKit {
  terrainY(track: PropsTrack, x: number, z: number): number | null;
}

/** f1-game js/lighting/light-tune.js `LightTune.LT.lampDensity` (build-props.js:2085-2087). */
export interface LightTuneKit {
  readonly LT?: { readonly lampDensity?: unknown } | null;
}

export interface SceneryKits {
  readonly TrackModels: TrackModelsKit;
  readonly TrackGraph: TrackGraphKit;
  readonly SceneryThemes?: SceneryThemesKit | null;
  readonly LandmarkKit?: LandmarkKitKit | null;
  readonly CircuitKit?: CircuitKitKit | null;
  readonly SceneryGuards: SceneryGuardsKit;
  readonly SceneryNature: CtxKit<NatureOut>;
  readonly SceneryStructures: CtxKit<StructuresOut>;
  readonly SceneryCity: CtxKit<CityOut>;
  readonly SceneryIdentity: CtxKit<IdentityOut>;
  readonly SceneryVenue: SceneryVenueKit;
  readonly SceneryPits?: SceneryPitsKit | null;
  readonly TrackSceneryData: SceneryDataKit;
  /** `window.TrackScenery`: the circuits' bespoke closures by def id (build-props.js:1972-1973). */
  readonly TrackScenery?: { readonly [id: string]: SceneryFn | undefined } | null;
  readonly Tracks: TracksKit;
  readonly LightTune?: LightTuneKit | null;
  /** The GLX global, the fallback when the track carries no `_gfx` (build-props.js:230). */
  readonly GLX?: GfxBackend | null;
}
